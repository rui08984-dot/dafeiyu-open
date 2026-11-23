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

module.exports = { pickTools, DOMAINS, ALWAYS_KEEP, GENERIC_FILL };
