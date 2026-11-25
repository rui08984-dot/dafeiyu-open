'use strict';
/**
 * tool-picker.js —— 工具能力域筛选（2026-11-10 三十七轮；2026-11-16 工具面收敛）
 *
 * 为什么要有：全部工具的 schema 全量塞给 LLM（当前 28 个 ≈14k 字符），选择困难 → 选错/漏选。
 *   意图路由已做了一半（纯 chat 轮全省工具）；这里补另一半：**tool 轮按上下文筛子集**。
 *
 * 设计原则（吃过主链的亏，红线三条）：
 *   ① **默认关闭**：`config.toolFilter.enabled !== true` 时调用方直接跳过，主链行为零变化
 *   ② **永不裁核心**：记忆/核心记忆/用户画像 全场景通用，永远保留
 *   ③ **保底数量**：筛完不足 minKeep（8）→ 用通用组补齐，宁可多给不可漏给
 *
 * 输入上下文（全部可缺，缺了就退化为"通用组"）：
 *   ctx.screenState —— watch-screen 的状态行（'game:植物大战僵尸' / 'video:哔哩哔哩' / ...）
 *   ctx.lastUserText —— 最近一条用户消息（关键词打分）
 */

// 域 → 工具名白名单（小写精确匹配；不在任何域的工具留在"通用组"兜底）
// 2026-11-16 清理：插件收敛后真实工具面只剩 28 个（插件 getTools() 合并去重后的名字）。
// 这里只允许写真实存在的工具名（_probe/check-plugins.mjs 会静态校验），
// 旧名（take_screenshot / click_mouse / press_key / type_text / open_webpage /
// play_random_music / pet_perform / game_control / search_memory / add_schedule …）
// 已随插件删除，全部替换为当前名字。
const DOMAINS = [
    {
        id: 'game',
        stateHint: /^game/,
        textHint: /游戏|打一局|植物|僵尸|我的世界|minecraft|原神|关卡|种|攻击|阳光/,
        // 游戏域：看画面 + 操作 + 启动/批处理 + 游戏知识/技能
        tools: ['game', 'see', 'act', 'app', 'batch', 'knowledge', 'skill'],
    },
    {
        id: 'watch',
        stateHint: /^video/,
        textHint: /看视频|一起看|电影|番剧|B站|bilibili|这个视频|剧情|解说/,
        // 一起看：cowatch 管耳朵，see 管画面，memory/recall/note 保剧情连续性；
        // timeline（C2）= 屏幕时间线，「我刚才看到哪了」要跨小时可查
        tools: ['cowatch', 'see', 'timeline', 'memory', 'recall', 'note', 'web_search'],
    },
    {
        id: 'query',
        textHint: /查|搜索|是什么|为什么|怎么办|攻略|资料|新闻|天气/,
        // 查询域：记忆/画像/导入/网页搜索/文件与剪贴板/写代码查证
        tools: ['memory', 'image', 'import', 'tool_usage', 'recall', 'note', 'profile',
            'web_search', 'knowledge', 'file', 'clipboard', 'code'],
    },
    {
        id: 'perform',
        textHint: /演一个|表演|跳舞|动作|换装|穿|表情|逗她|摸头|唱|音效|放歌|音乐/,
        // 演出域：外观/音效/手势/动作/照顾（music 插件已停用，不再列 music）
        tools: ['appearance', 'play_sound_effect', 'hand_action', 'act', 'pet_care'],
    },
    {
        id: 'life',
        textHint: /日程|提醒|待办|安排|笔记|日记|备忘/,
        // 生活域：日程/日记/晨昏/笔记/照顾，需要时带记忆与文件
        tools: ['schedule', 'diary', 'dawn_dusk', 'note', 'pet_care', 'memory', 'recall', 'file'],
    },
    {
        id: 'dispatch',
        textHint: /派活|交给|让.*(做|写|跑)|执行器|任务|进度|dispatch|DSH/i,
        // 派活域：交给执行器 + 查进度，配套批处理/代码/文件/剪贴板
        tools: ['dispatch_to_dsh', 'check_dispatch', 'batch', 'code', 'file', 'clipboard'],
    },
];

// 永不裁：全场景通用（记忆/画像/笔记 —— 丢了这些她的"人格连续性"会断）
// 2026-11-16 清理：去掉已删除插件的 wait（wait 工具不存在了），只留真实工具名。
// 永不裁：全场景通用（记忆/画像/笔记/世界状态 —— 丢了这些连续性会断）
// 2026-11-21（C1）：world = 世界状态/纠错，任何场景都可能被问「我在干嘛」，永不裁。
// 用精确匹配而不是裸 world：避免将来出现 world_xxx 之类的名字被误放行。
const ALWAYS_KEEP = /memory|note|recall|profile|pet_care|(^|,)\s*world\s*(,|$)/i;

// 保底通用组：筛后不足 minKeep 时按序补回（高频通用工具）
// 2026-11-16 清理：原表里的 music / recall_last 等旧名已删，全部换成当前真实名字。
const GENERIC_FILL = [
    'memory', 'web_search', 'recall', 'see',
    'appearance', 'schedule', 'cowatch', 'note',
    'act', 'knowledge', 'file', 'clipboard',
    'world',
];

function _toolName(t) {
    return String((t.function && t.function.name) || t.name || '').toLowerCase();
}

// ══ 会话级工具子集（ADR-014 轨道 2-7，2026-11-24）══════════════════════════
// 为什么不是每轮重选：DeepSeek 的前缀缓存按 tools 段命中。每轮换一次工具列表 =
// 每次都 miss 整段 tools + 后续所有历史。所以「选一次、整个会话保持」，只有**模式变化**
// （闲聊 → 打游戏 → 看视频 → 操控桌面）才重选。
//
// 模式 → 复用域（不新增工具，只从现有 DOMAINS 里挑）：
//   chat    —— 不预设域，靠 ALWAYS_KEEP + 通用组；闲聊轮本身多半被 intent-router 省掉工具
//   game    —— game/see/act/app/batch/knowledge/skill
//   watch   —— cowatch/see/timeline/memory/recall/note/web_search
//   control —— 桌面操控：see/act/app/file/clipboard/code/batch/dispatch/check_dispatch/skill
// 核心永在（比 pickTools 的 ALWAYS_KEEP 更宽）：记忆/画像/笔记/世界状态 + see/act/app
// —— 「看得到、点得到」是所有模式的基础能力，裁掉了就是静默劣化。
const CORE_SESSION = /memory|note|recall|profile|pet_care|(^|,)\s*world\s*(,|$)|^(?:see|act|app)$/i;

const MODE_CONTEXT = Object.freeze({
    chat: { screenState: '', lastUserText: '' },
    game: { screenState: 'game:运行中', lastUserText: '游戏 关卡 打一局' },
    watch: { screenState: 'video:播放中', lastUserText: '看视频 一起看 剧情' },
    control: { screenState: '', lastUserText: '' },
});

// 每个模式的**显式**工具集：不依赖关键词打分，避免「进了游戏还要靠正则命中」。
// 只在 pickForSession 里并入，不改 pickTools 的原行为。
const MODE_EXTRA_TOOLS = Object.freeze({
    chat: [],
    game: ['game', 'batch', 'knowledge', 'skill'],
    watch: ['cowatch', 'timeline', 'web_search'],
    control: ['file', 'clipboard', 'code', 'batch', 'dispatch_to_dsh', 'check_dispatch',
        'dispatch_cancel', 'hand_action', 'skill', 'knowledge'],
});

const MIN_KEEP = 8;

/** 从上下文推断模式：屏幕状态优先，其次控制意图，最后闲聊。 */
function deriveMode(ctx) {
    const c = ctx || {};
    const want = String(c.mode || '').toLowerCase();
    if (MODE_CONTEXT[want]) return want;
    const state = String(c.screenState || '');
    if (/^game/i.test(state)) return 'game';
    if (/^video/i.test(state)) return 'watch';
    if (c.control === true || /操控|桌面|窗口|点击|输入|执行/.test(String(c.lastUserText || ''))) return 'control';
    return 'chat';
}

const _sessions = new Map();   // sessionKey → { mode, names: string[], domains: string[], dropped: number }

/** 测试/热重载用：清空会话缓存。 */
function resetSessions() {
    _sessions.clear();
}

/**
 * 会话级选择：同一 sessionKey + 同一模式 → 直接复用（保证前缀稳定）；
 * 模式变化才重新打分。结果不足 minKeep 时用通用组、再按原顺序补齐。
 *
 * @param {Array} allTools 合并后的工具 schema 数组
 * @param {{sessionKey?:string, mode?:string, screenState?:string, lastUserText?:string, control?:boolean}} ctx
 * @returns {{tools:Array, domains:string[], mode:string, dropped:number, reused:boolean}}
 */
function pickForSession(allTools, ctx) {
    const tools = Array.isArray(allTools) ? allTools : [];
    const c = ctx || {};
    const key = String(c.sessionKey || '__default__');
    const mode = deriveMode(c);
    const cached = _sessions.get(key);

    if (cached && cached.mode === mode) {
        // 复用：按缓存的名字过滤**当前** allTools（热重载后 schema 以新对象为准）。
        const byName = new Map();
        for (const t of tools) {
            const n = _toolName(t);
            if (n && !byName.has(n)) byName.set(n, t);
        }
        const kept = [];
        let missing = 0;
        for (const n of cached.names) {
            const t = byName.get(n);
            if (t) kept.push(t); else missing += 1;
        }
        // 工具面变了（插件卸载/改名）→ 缓存作废，重选一次，避免一直少给
        if (!missing) {
            return {
                tools: kept,
                domains: cached.domains.slice(),
                mode,
                dropped: tools.length - kept.length,
                reused: true,
            };
        }
        _sessions.delete(key);
    }

    const mctx = Object.assign({}, MODE_CONTEXT[mode] || {}, {
        // 显式传来的上下文优先（屏幕状态/用户这句话比模式模板更具体）
        screenState: c.screenState !== undefined && c.screenState !== '' ? c.screenState : (MODE_CONTEXT[mode] || {}).screenState,
        lastUserText: c.lastUserText !== undefined && c.lastUserText !== '' ? c.lastUserText : (MODE_CONTEXT[mode] || {}).lastUserText,
    });
    const picked = pickTools(tools, mctx);

    // 核心工具永在：pickTools 已经保证 ALWAYS_KEEP；这里再补 see/act/app + 本模式显式工具集。
    const modeAllow = new Set((MODE_EXTRA_TOOLS[mode] || []).map((n) => n.toLowerCase()));
    const out = [];
    const have = new Set();
    for (const t of picked.tools) {
        const n = _toolName(t);
        out.push(t);
        if (n) have.add(n);
    }
    const addIfMissing = (t) => {
        const n = _toolName(t);
        if (!n) { out.push(t); return; }
        if (have.has(n)) return;
        // 只补核心或本模式显式工具，不把整张工具面倒回来
        if (!CORE_SESSION.test(n) && !modeAllow.has(n)) return;
        out.push(t);
        have.add(n);
    };
    for (const t of tools) addIfMissing(t);

    // 保底 minKeep：先通用组，再按原顺序补（绝不因筛选把工具面削到不可用）
    if (out.length < MIN_KEEP) {
        const byName = new Map();
        for (const t of tools) {
            const n = _toolName(t);
            if (n && !byName.has(n)) byName.set(n, t);
        }
        for (const n of GENERIC_FILL) {
            if (out.length >= MIN_KEEP) break;
            if (have.has(n) || !byName.has(n)) continue;
            out.push(byName.get(n));
            have.add(n);
        }
        for (const t of tools) {
            if (out.length >= MIN_KEEP) break;
            const n = _toolName(t);
            if (n && have.has(n)) continue;
            out.push(t);
            if (n) have.add(n);
        }
    }

    // 保持 allTools 原顺序（顺序稳定 = 前缀稳定）
    const order = new Map();
    tools.forEach((t, i) => order.set(t, i));
    out.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

    const names = out.map(_toolName).filter(Boolean);
    _sessions.set(key, { mode, names, domains: picked.domains.slice(), dropped: tools.length - out.length });
    return { tools: out, domains: picked.domains.slice(), mode, dropped: tools.length - out.length, reused: false };
}

module.exports = {
    pickTools,
    pickForSession,
    deriveMode,
    resetSessions,
    DOMAINS,
    ALWAYS_KEEP,
    GENERIC_FILL,
    CORE_SESSION,
    MIN_KEEP,
    MODE_CONTEXT,
    MODE_EXTRA_TOOLS,
};

/**
 * @param {Array} allTools 合并后的工具 schema 数组
 * @param {object} ctx { screenState, lastUserText }
 * @returns {{ tools: Array, domains: string[], dropped: number }} 原数组过滤结果（不修改入参）
 */
function pickTools(allTools, ctx) {
    const c = ctx || {};
    const state = String(c.screenState || '');
    const text = String(c.lastUserText || '');
    const scores = new Map();   // domainId → 分
    for (const d of DOMAINS) {
        let s = 0;
        if (d.stateHint && d.stateHint.test(state)) s += 3;
        if (d.textHint && d.textHint.test(text)) s += 2;
        if (s > 0) scores.set(d.id, s);
    }
    // 取分最高的至多 3 个域
    const active = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
    const allow = new Set();
    for (const id of active) {
        const d = DOMAINS.find((x) => x.id === id);
        for (const t of d.tools) allow.add(t.toLowerCase());
    }
    const minKeep = 8;
    const out = [];
    const generic = [];
    for (const t of allTools) {
        const n = _toolName(t);
        if (!n) { out.push(t); continue; }                     // 无名工具不裁（schema 异常别吞）
        if (ALWAYS_KEEP.test(n) || allow.has(n)) out.push(t);
        else if (GENERIC_FILL.includes(n)) generic.push(t);
        // 其余丢弃
    }
    // 保底：不足 minKeep 从 generic 补
    for (const t of generic) {
        if (out.length >= minKeep) break;
        out.push(t);
    }
    return { tools: out, domains: active, dropped: allTools.length - out.length };
}
