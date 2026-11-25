// plugins/community/dispatch/index.js
// 把「派活」变成真的能用的工具。
//
// 之前的状态：petbridge 里有 /dispatch，能起一个 DSH headless 会话干活，
// 但**没有任何插件把它暴露给模型** —— 所以她人设里写着「我能派活」，实际调不到工具。
//
// 设计要点：派活是长任务（几十秒到十几分钟），**不能阻塞对话**。
// 所以工具立刻返回一份回执，任务在后台跑，跑完她主动说一句结果。
const __silentAudit = require('../../../js/core/silent-audit.js');
const { Plugin } = require('../../../js/core/plugin-base.js');
// 后台云端花费闸（2026-11-25 契约）：任务回执是主动 sendMessage（一次云调用）。
// quiet 管「说不说」，cost.background_llm=false 管「花不花」。
const backgroundLLM = require('../../../js/core/background-llm.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const _gcApi = require('./game-control');
// ADR-014 轨道 1（2026-11-24）：大结果全文落盘 + 分页续读。
const toolArtifact = require('../../../js/ai/tool-result-artifact.js');
// B1（2026-11-21）：任务结案三态判定（纯函数，单独可测）
const taskLedger = require('./task-ledger.js');
const { runGameAction, rateGate, rateGateGame, SEMANTIC_GENERIC } = _gcApi;
// 计数桥（2026-11-21）：热重载可能只换了本文件、game-control 还是旧模块 ——
// 缺 bumpControlStat 时降级为 no-op，不让「记个数」把真实动作打断。
const bumpControlStat = (key, n) => {
    try {
        if (typeof _gcApi.bumpControlStat === 'function') return _gcApi.bumpControlStat(key, n);
    } catch (e) { /* 计数失败不影响动作 */ }
    return false;
};

// ── 旧工具名（合并工具面后仍需可路由；见 handlesToolName）─────────────
const LEGACY_TOOL_NAMES = new Set(['game_control', 'pet_perform', 'pet_action', 'pet_asset']);

// ── game 工具的输入闸（2026-11-21 审计旁路①）──────────────────────────────
// 背景：`game` 工具 → game-loop 直连 post_keys/mouse，没有 act 链路的 rateGate、
// 桌面串行锁和 verify 契约。对「游戏循环」高频输入是合理的，但模型随手拿它当
// 通用按键通道就是弱闸（无会话、无前台约束、无回读）。
//
// 口径：
//   · 只读动作（status / see / profiles / stop）不需要会话，照常可用；
//   · start 必须显式带目标（profile，可用 window 覆盖目标窗口），不得默认前台；
//   · 输入类动作（press / hold / click / move …）必须有活动会话，且最近一拍
//     fgMatch === true（前台就是会话目标窗口）；未知也拒绝（fail-closed）。
//   · 拒绝一律 not_sent（action_sent:false）并计数，日志由调用方写。
const GAME_READONLY_ACTIONS = new Set(['status', 'see', 'profiles', 'stop']);
const GAME_INPUT_ACTIONS = new Set([
    'press', 'press_key', 'key', 'keys', 'type', 'type_text',
    'hold', 'hold_key', 'click', 'click_at', 'mouse', 'move', 'move_rel',
    'drag', 'scroll', 'input',
]);
const GAME_GATE_STATS = { rejected: 0, byReason: Object.create(null), lastReason: '', lastAt: 0 };

function bumpGameGate(reason) {
    const r = String(reason || '');
    GAME_GATE_STATS.rejected += 1;
    const key = r.split(/[：:；;，,（(]/)[0].slice(0, 48) || 'other';
    GAME_GATE_STATS.byReason[key] = (GAME_GATE_STATS.byReason[key] || 0) + 1;
    GAME_GATE_STATS.lastReason = r;
    GAME_GATE_STATS.lastAt = Date.now();
}

/** 统一的 game 闸拒绝结果（契约形状：not_sent / action_sent:false）。 */
function gameGateRefuse(reason, extra) {
    bumpGameGate(reason);
    const VC = require('./verify-contract.js');
    return VC.notSent(reason, Object.assign({
        error: 'game-gate',
        reason,
        nextIfFailed: '通用按键/点击请用 act（key/click），它带前台校验、回读和 rateGate',
    }, extra || {}));
}

/** 拒绝计数的只读快照（game status / 测试可观测）。 */
function gameGateStats() {
    return {
        rejected: GAME_GATE_STATS.rejected,
        byReason: Object.assign({}, GAME_GATE_STATS.byReason),
        lastReason: GAME_GATE_STATS.lastReason,
        lastAt: GAME_GATE_STATS.lastAt,
    };
}

/**
 * 纯函数：输入动作的「会话 + 前台」双闸。
 * @param {string} action game 工具 action
 * @param {{active?:boolean, fgMatch?:(boolean|null), target?:string}} session
 *        game-loop.sessionSnapshot() 的结果（测试可传 mock）
 * @returns {null|object} null = 放行；否则是 not_sent 结果
 */
function gameInputGate(action, session) {
    const a = String(action || '').toLowerCase();
    if (GAME_READONLY_ACTIONS.has(a)) return null;   // 只读动作：不需要会话
    if (!GAME_INPUT_ACTIONS.has(a)) return null;     // 未知动作交给枚举校验报错
    const s = session || {};
    if (!s.active) {
        return gameGateRefuse(
            'game 工具只用于已启动的游戏会话（当前没有活动会话）；通用按键请用 act key（有前台校验与回读）',
            { error: 'no-active-session' });
    }
    if (s.fgMatch !== true) {
        return gameGateRefuse(
            '游戏目标窗口不在前台（fgMatch=' + (s.fgMatch === false ? 'false' : 'unknown')
            + '），输入会打进别的应用；切回游戏再用，或通用按键请用 act key（有前台校验与回读）',
            { error: 'target-not-foreground', target: String(s.target || ''), fgMatch: false });
    }
    return null;
}

// ── 手脚模板 ────────────────────────────────────────────────────────────
// 派活原本要求她"把任务描述清楚"，但她经常只说得出一句模糊的话
// （"帮我打开那个文件"），DSH 那边就得反复问。
// 这里给一批高频操控的**模板**，她只要填参数，任务描述就足够具体。
const HAND_TEMPLATES = {
    '打开文件': (a) => '打开文件：' + a,
    '打开网页': (a) => '用默认浏览器打开网址：' + a,
    '搜一下':   (a) => '在浏览器里搜索并打开第一个结果：' + a,
    '截图':     () => '截一张全屏图保存到桌面，文件名带时间戳',
    '复制到剪贴板': (a) => '把这段文字写入系统剪贴板：' + a,
    '输入文字': (a) => '在当前焦点窗口里输入这段文字（不要按回车）：' + a,
    '按回车':   () => '在当前焦点窗口按一次回车键',
    '切换窗口': (a) => '把窗口切换到：' + a,
    '最小化全部': () => '显示桌面（Win+D），把所有窗口最小化',
    '音量':     (a) => '把系统音量调到 ' + a,
    '打开应用': (a) => '启动应用：' + a,
    '找文件': (a) => '在这台电脑上搜索文件名包含「' + a + '」的文件，列出完整路径',
};

/**
 * 「手脚」里**能本地毫秒级做完**的动作 → 直接映射到 game_control 的对应动作。
 *
 * 为什么要有这一层（2026-11-13，用户实测报障）：
 *   原来 hand_action 只把动作**改写成一句自然语言**，然后 `_start({task})` 派给后台
 *   执行器（DSH headless）。而那是**编码型 agent**，会话结束时会清理自己拉起的进程。
 *   实测日志：`[手脚] 打开应用 → 启动应用：PCL` → 派给 DSH → PCL 打开后立刻被关掉
 *   → 她自己发现不对劲，又派一次「重新启动 pcl.exe…它刚才启动后立刻被关闭/闪退了」。
 *   三个任务全 done，PCL 却没留住。
 *
 *   这些动作本来就是本机能直接做的（launch_app 用 detached+unref，不会被连带杀；
 *   press_key/type_text/focus_window/volume 走 SendInput，毫秒级返回），
 *   绕一趟后台执行器既慢又会被清理。
 *
 *   ⚠ 没进这张表的（找文件/搜一下/打开网页/打开文件/截图/复制剪贴板）仍走后台 ——
 *   它们要么需要搜索、要么需要外部程序，本地做不了或者说做不稳。
 */
const HAND_LOCAL = {
    '打开应用': (a) => ({ action: 'launch_app', arg: a }),
    '输入文字': (a) => ({ action: 'type_text', arg: a }),
    '按回车': () => ({ action: 'press_key', arg: 'enter' }),
    '切换窗口': (a) => ({ action: 'focus_window', arg: a }),
    '最小化全部': () => ({ action: 'window_op', arg: 'all_min' }),
    '音量': (a) => ({ action: 'volume', arg: a }),
};

// 第二组「手脚」：直接用 Electron 本地做（连 game_control 都不用绕）。
const SHELL_LOCAL_ACTS = new Set(['打开文件', '打开网页', '复制到剪贴板', '截图']);

// ── 派活入口的硬拦截（2026-11-13）──────────────────────────────────────────
// 为什么不是「靠描述劝说」：模型读描述只是概率，改完描述下一次仍可能选错。
// 这里让错的路**根本走不通** —— 收到 GUI 类任务直接拒收并告知该用哪个工具。
//
// 判定顺序很关键：先看有没有「写代码/脚本」这类词（那是合法的代码任务，哪怕里面
// 提到「打开」）；再看是不是「打开/关闭 + 某个东西」；最后看纯 UI 动作。
const CODE_HINTS = /写|改|实现|脚本|代码|重构|修复|测试|编译|生成|分析|整理|翻译|总结|调研|文档/;
const GUI_OPEN = /^(?:帮我)?(?:打开|启动|运行|开一下)\s*([^\s，。,]{1,20})/;
const GUI_CLOSE = /^(?:帮我)?(?:关闭|关掉|退出|结束)\s*([^\s，。,]{1,20})/;
const GUI_ACT = /按一下|点一下|点击|单击|双击|按键|输入文字|打一段|截图/;

/**
 * 判断一个派活任务是不是「该由本地工具做」的 GUI 操作。
 * @returns {{kind:'code'|'gui'|'other', action?:string, target?:string}}
 */
function classifyTask(text) {
    const s = String(text || '').trim();
    if (!s) return { kind: 'other' };
    if (CODE_HINTS.test(s)) return { kind: 'code' };
    let m = s.match(GUI_OPEN);
    if (m) return { kind: 'gui', action: 'launch_app', target: m[1] };
    m = s.match(GUI_CLOSE);
    if (m) return { kind: 'gui', action: 'close', target: m[1] };
    if (GUI_ACT.test(s)) return { kind: 'gui', action: 'ui', target: '' };
    return { kind: 'other' };
}

/**
 * 同步查一个已配置应用当前在不在跑。
 *
 * 为什么放在派活入口（2026-11-13）：用户报障的现象是「打开了又被关掉」，其中一半的
 * 混乱来自**没人知道当前到底是什么状态**（用户以为没开、她以为开了、后台又开一次）。
 * 拦下 GUI 任务的同时把「现在在不在运行」一并告诉模型，它就不会重复开、也能立刻判断
 * 该不该动手。这是把「回头验」提前到「动手前」——比事后验更有用。
 */
function probeAppSync(context, name) {
    try {
        const cfg = context.getPluginFileConfig() || {};
        const apps = Object.assign({
            '植物大战僵尸': 'D:/Games/植物大战僵尸杂交重制版v0.31/植物大战僵尸杂交版发布版0.31.0.Csharp.exe',
            '记事本': 'C:/Windows/System32/notepad.exe',
            '计算器': 'C:/Windows/System32/calc.exe',
        }, cfg.apps || {});
        const names = Object.keys(apps).filter((k) => apps[k]);
        const hit = names.find((n) => n === name) || names.find((n) => n.includes(name) || name.includes(n));
        if (!hit) return { known: false, note: '不在启动白名单（可启动：' + (names.join('、') || '无') + '）' };
        const exe = String(apps[hit]);
        const stem = require('path').basename(exe, '.exe');
        const winPath = exe.replace(/\//g, '\\\\');
        const ps = '(Get-Process | Where-Object { $_.Path -eq "' + winPath + '" -or $_.Name -eq "' + stem + '" -or $_.MainWindowTitle -like "*' + hit + '*" } | Measure-Object).Count';
        const out = require('child_process').execFileSync('pwsh', ['-NoProfile', '-Command', ps], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
        const n = Number(String(out).trim());
        return { known: true, app: hit, running: n > 0, count: n };
    } catch (e) {
        return { known: false, note: '查状态失败：' + String(e && e.message || e).slice(0, 80) };
    }
}

// ══ 大结果分页（ADR-014 轨道 1-6，2026-11-24）════════════════════════════
// see / act snapshot / see windows / app list 的返回是 JSON，其中 elements / windows / apps
// 数组可能一口气几十项（快照 60 项 ≈ 6–15k 字符）。原则：
//   · **小结果原样返回**（不传 offset/limit 且 ≤12k）→ 默认返回形状零变化，历史调用方不受影响；
//   · 大结果或显式分页时才切页：保留全局编号（elements 的 idx/rid 不变，click #编号照旧），
//     返回 page/next/artifactPath，detail 只描述当前页；
//   · 全文落 `data/tool-artifacts/`，模型可以继续 offset 取下一页，或 `file read` 读全文。
const ARTIFACT_THRESHOLD_CHARS = 12000;
const PAGE_DEFAULTS = Object.freeze({ elements: 20, windows: 10, apps: 30 });
// 单页硬上限的历史值（也是缺省值）：config.context.tool_result_max_chars 改小后，
// 「单页 12000」会把刚改小的回执又撑回去，且 cap 再截一遍 → 「可续读」读不全。
// 2026-11-24 第四轮 P2：单页上限改为跟随 config（钳 1000–12000）。
const PAGE_HARD_CAP_DEFAULT = 12000;
const PAGE_HARD_CAP_MIN = 1000;

/**
 * file read 的单页硬上限：读 config.context.tool_result_max_chars（缺省 12000，钳 1000–12000）。
 * @param {object} [hostConfig] 宿主 config（插件里传 this.context.getConfig()；测试直接给对象）
 */
function fileReadPageCap(hostConfig) {
    let v = 0;
    try {
        const c = hostConfig || {};
        const ctxCfg = (c.context && typeof c.context === 'object') ? c.context : {};
        v = Math.floor(Number(ctxCfg.tool_result_max_chars)) || 0;
    } catch (e) { v = 0; }
    if (!Number.isFinite(v) || v <= 0) v = PAGE_HARD_CAP_DEFAULT;
    return Math.max(PAGE_HARD_CAP_MIN, Math.min(PAGE_HARD_CAP_DEFAULT, v));
}


function _intOr(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** 从契约对象里找可分页数组。返回 key 或 null。 */
function _pageArrayKey(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (Array.isArray(obj.elements)) return 'elements';
    if (Array.isArray(obj.windows)) return 'windows';
    if (Array.isArray(obj.apps)) return 'apps';
    return null;
}

function _pageLine(key, item, idx) {
    if (key === 'elements') {
        const n = item && item.idx != null ? item.idx : idx;
        return '#' + n + '[' + String((item && item.type) || '?') + ']'
            + String((item && item.name) || '').slice(0, 24)
            + (item && item.x != null ? '(@' + item.x + ',' + item.y + ')' : '');
    }
    if (key === 'windows') {
        const title = (item && (item.title || item.MainWindowTitle || item.name)) || '';
        const pid = (item && (item.Id || item.pid)) || '';
        return String(title) + '（#' + pid + '）';
    }
    return String(item);
}

function _pageHeader(name, key, total) {
    if (key === 'elements') return '可交互元素 ' + total + ' 个（分页）';
    if (key === 'windows') return '当前可见窗口 ' + total + ' 个（分页）';
    return '可启动的应用 ' + total + ' 个（分页）';
}

/**
 * 把一条 dispatch 结果按页切（纯函数，测试可直接调）。
 * @param {string} name 工具名（see / act / app / file）
 * @param {object} params 调用参数（读 offset / limit）
 * @param {string} raw 原始 JSON 字符串
 * @param {{writeArtifact?:boolean}} [opts]
 * @returns {string} 处理后的 JSON 字符串（不可分页/小结果原样返回）
 */
function paginateToolResult(name, params, raw, opts) {
    if (typeof raw !== 'string' || !raw) return raw;
    const s = raw.trim();
    if (s[0] !== '{' && s[0] !== '[') return raw;
    let obj = null;
    try { obj = JSON.parse(s); } catch (e) { return raw; }
    // SoM 标注图（som_snapshot / see image）的 elements 与 base64 图像绑在一起：
    //   切页会丢编号、落 artifact 还会把屏幕截图写进磁盘（PII）。这类结果一律不分页。
    if (obj && (obj.image || obj.imageIsBase64)) return raw;
    const key = _pageArrayKey(obj);
    if (!key) return raw;

    const p = params || {};
    const arr = obj[key];
    const wantOffset = p.offset !== undefined && p.offset !== null && String(p.offset).trim() !== '';
    const wantLimit = p.limit !== undefined && p.limit !== null && String(p.limit).trim() !== '';
    const offset = Math.min(_intOr(p.offset, 0), Math.max(0, arr.length));
    let pageSize = Math.max(1, Math.min(200, _intOr(p.limit, PAGE_DEFAULTS[key] || 20)));
    // 兼容：小结果、没显式分页 → 原样返回（不新增字段、不改 detail）
    if (!wantOffset && !wantLimit && raw.length <= ARTIFACT_THRESHOLD_CHARS) return raw;

    let artifactPath = null;
    if (raw.length > ARTIFACT_THRESHOLD_CHARS && (!opts || opts.writeArtifact !== false)) {
        const art = toolArtifact.writeArtifact(String(name || 'tool'), raw, { turnId: (opts && opts.turnId) || '' });
        if (art) artifactPath = art.path;
    }
    const header = _pageHeader(name, key, arr.length);
    // P1-3（2026-11-25 风暴压测）：**回执整体（数组 + detail + 元数据）必须留在上限内**。
    //   旧实现只按条数切页：详情文本 + 同一页数组 ≈ 体积翻倍，序列化后轻松 >12k，
    //   发送前再被 tool-result-cap 盲切一刀 → 模型拿到无法 JSON.parse 的半截回执，
    //   next/artifactPath 还可能被切没。这里按实际序列化长度收紧 pageSize 重切，
    //   next.offset 始终 = 这一页真正返回到的位置（续读无丢失段）。
    let payload = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const page = arr.slice(offset, offset + pageSize);
        const nextOffset = offset + page.length < arr.length ? offset + page.length : null;
        const lines = page.map((it, i) => _pageLine(key, it, offset + i + 1));
        let detail = header + '：第 ' + (offset + 1) + '–' + (offset + page.length) + ' 项：\n' + lines.join('\n');
        if (nextOffset != null) {
            detail += '\n…还有 ' + (arr.length - nextOffset) + ' 项；续读传 offset=' + nextOffset
                + ' limit=' + pageSize + '（同 action 再调一次即可）';
        }
        if (artifactPath) detail += '\n完整结果已落盘：' + artifactPath + '（可用 file read + offset 读全文）';

        obj[key] = page;
        obj.page = {
            offset, limit: pageSize, total: arr.length, returned: page.length,
            next_offset: nextOffset,
        };
        obj.next = nextOffset == null ? null : { offset: nextOffset, limit: pageSize };
        if (artifactPath) obj.artifactPath = artifactPath;
        obj.detail = detail;
        payload = JSON.stringify(obj);
        if (payload.length <= ARTIFACT_THRESHOLD_CHARS || page.length <= 1) break;
        const over = payload.length - ARTIFACT_THRESHOLD_CHARS;
        const perItem = Math.max(1, Math.ceil((payload.length - 200) / Math.max(1, page.length)));
        const nextSize = Math.max(1, pageSize - Math.ceil(over / perItem) - 1);
        if (nextSize >= pageSize) break;   // 收敛不了（单条 item 本身就超预算）：保留一条可读回执
        pageSize = nextSize;
    }
    return payload;
}

class DispatchPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        this._port = Number(cfg.control_port) || 8103;
        this._timeoutMs = (Number(cfg.timeout_seconds) || 900) * 1000;
        this._autoReceipt = cfg.auto_receipt !== false;
        this._maxConcurrent = Number(cfg.max_concurrent) || 2;
        // P1（2026-11-23）：验收/返工/取消宽限。开关只影响「插件是否让服务端跑」，
        // 真正的执行在 vts-server + runner（插件不执行任何命令）。
        this._verifyDefaultOn = cfg.verify_default_on !== false;
        this._verifyTimeoutMs = Math.max(5000, Math.min(600000, Number(cfg.verify_timeout_ms) || 60000));
        this._reworkMax = Math.max(0, Math.min(3, Number.isFinite(Number(cfg.rework_max)) ? Number(cfg.rework_max) : 1));
        this._cancelGraceMs = Math.max(300, Math.min(10000, Number(cfg.cancel_grace_ms) || 2000));
        this._tasks = new Map();   // id -> { task, state, startedAt, text, error }
        this._seq = 0;
        // D2 经验路由开关（2026-11-22）：plugin_config.route_experience=false 一键关。
        // 默认开：它只重排「先试哪条通道」，样本 <3 不排序，连续 3 次失败自动回默认。
        try {
            if (typeof _gcApi.setRouteExperienceEnabled === 'function') {
                _gcApi.setRouteExperienceEnabled(cfg.route_experience !== false);
            }
        } catch (e) { /* 开关失败不影响插件加载 */ }
        // E7 预热（2026-11-22 审计）：skill-health 是懒加载的（skill-library 按需 require），
        // 于是 `window.__skillHealthStats` 要等「第一次用到技能」才存在 —— 探针/doctor 早期读不到。
        // 这里主动加载一次（模块加载即 publishStats），零成本让观测入口在启动时就可用。
        try { require('../../../js/core/skill-health.js'); } catch (e) { /* 预热失败不影响插件 */ }
    }

    // ── 派活账本接线（P0 可见+安全 · 2026-11-23）────────────────────────────
    // 唯一真源是 8103 的账本（data/dispatch-tasks/*.json + *.jsonl）；插件里的
    // `_tasks` 只做并发计数/回执缓存，不再是 check_dispatch 的答案来源。
    // 回滚：config.json 的 dispatch.ledger_v2=false → 全部退回旧内存 Map 行为。
    _configPath() {
        if (process.env.MY_NEURO_CONFIG_PATH) return path.resolve(process.env.MY_NEURO_CONFIG_PATH);
        // __dirname = live-2d/plugins/community/dispatch → 上 3 层 = live-2d
        return path.join(__dirname, '..', '..', '..', 'config.json');
    }

    _recordsDir() {
        if (process.env.PET_DATA_ROOT) return path.join(path.resolve(process.env.PET_DATA_ROOT), 'data');
        return path.join(path.dirname(this._configPath()), '..', 'data');
    }

    /** ledger_v2 缺省 true；只有显式 false 才回旧行为（与 vts-server 的 readLedgerV2Enabled 同口径）。 */
    _ledgerV2Enabled() {
        try {
            const cfg = JSON.parse(fs.readFileSync(this._configPath(), 'utf8'));
            const d = cfg && cfg.dispatch;
            return !(d && typeof d === 'object' && d.ledger_v2 === false);
        } catch (e) { return true; }
    }

    /** 读本机 8103 的 .control-token（与 vts-server/控制中心同一份文件）。 */
    _controlToken() {
        try { return String(fs.readFileSync(path.join(this._recordsDir(), '.control-token'), 'utf8')).trim(); }
        catch (e) { return ''; }
    }

    /** 带令牌 GET 8103 账本；返回 {status, json}，任何异常都不抛。 */
    _ledgerGet(pathname) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (v) => { if (settled) return; settled = true; resolve(v); };
            try {
                const token = this._controlToken();
                const req = http.request({
                    host: '127.0.0.1', port: this._port, path: pathname, method: 'GET',
                    headers: token ? { 'X-Pet-Token': token } : {},
                    timeout: 4000,
                }, (res) => {
                    let s = '';
                    res.on('data', (c) => { s += c; });
                    res.on('end', () => {
                        let json = null;
                        try { json = JSON.parse(s); } catch (e) { json = null; }
                        done({ status: res.statusCode, json, text: s.slice(0, 300) });
                    });
                });
                req.on('error', (e) => done({ status: 0, json: null, text: '桌宠没在运行: ' + e.message }));
                req.setTimeout(4000, () => { try { req.destroy(); } catch (e) { /* 已断开 */ } done({ status: 0, json: null, text: 'timeout' }); });
                req.end();
            } catch (e) { done({ status: 0, json: null, text: String((e && e.message) || e) }); }
        });
    }

    // 工具面重塑（2026-11-14）：7 个工具 → 8 个，但**描述从 8056 字符压到约 2500**。
    // 原来 game_control 一个工具 36 个动作 + 2000 字 arg 说明 —— 模型要在 36 个动作里选，
    // 而且 scroll/drag 藏在 `mouse` 的字符串语法里根本想不到。
    // 现在按「用户意图」分四个语义工具：看(see) / 做(act) / 开工具(app) / 打游戏(game)。
    // 内部全部转成 (action, arg, focus) 落进原来那条 runGameAction 路径 —— 一套实现，不分叉。
    getTools() {
        return [
            { type: 'function', function: {
                name: 'appearance',
                description: '控制她的皮套表现。perform=演一段完整节目（打招呼/撒娇/生气/难过/得意/伸懒腰/鼓掌/想事情/点头/晚安/鞠躬/指一指）；action=做单个动作（wave/tilt_head/nod_head/point/bow/clap）；asset=换装或调形态（id + value）。不传 name 会返回可用清单。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['perform', 'action', 'asset'], description: 'perform=演节目，action=做动作，asset=换装/调形态' },
                        name: { type: 'string', description: '（perform/action）节目名或动作名' },
                        id: { type: 'string', description: '（asset）资产 id，如 clothes-skirt / glasses-frame / headwear-pot / form-size' },
                        value: { type: 'string', description: '（asset）开关型 true/false；档位型 big/mid/small' },
                    },
                    required: ['action'],
                },
            } },
            { type: 'function', function: {
                name: 'see',
                description: '看屏幕：tree（默认，可交互元素编号清单）｜image（画了编号的标注图，UIA 扫不到的自绘窗口用）｜text（整窗文字）｜state（游戏画面里的数值）｜windows（开着的窗口，可按 window 过滤）。先看再点：tree 拿编号 → act click #编号。**编号只属于这一份快照**：回执带 snapshot_id/snapshot_age_ms；中间又拍过快照、换了窗口或快照超过 120 秒，旧编号会被 STALE_SNAPSHOT 拒发（绝不静默点到别处），按回执 nextIfFailed 重新 see 即可。window 请尽量传完整标题或 hwnd（短于 4 字的标题必须写全；标题匹配只认精确相等或「前缀+分隔符」，不做任意子串/后缀模糊匹配）。结果太长时会分页：回执里有 next（offset/limit），照它再调一次即可续读，detail 里也会给 artifactPath（全文落盘）。',
                parameters: {
                    type: 'object',
                    properties: {
                        mode: { type: 'string', enum: ['tree', 'image', 'text', 'state', 'windows'], description: '怎么看' },
                        window: { type: 'string', description: '窗口标题的一部分；留空=当前前台窗口。建议用 see windows 回执里的完整标题或 hwnd（短标题必须写全，不匹配任意子串）' },
                        offset: { type: 'integer', description: '（可续读）从第几项开始返回，默认 0；下一次用回执里的 next.offset' },
                        limit: { type: 'integer', description: '（可续读）本页最多几项（tree 默认 20，windows 默认 10）' },
                    },
                    required: [],
                },
            } },
            { type: 'function', function: {
                name: 'act',
                description: '操作电脑：click（target 可以是 #编号、文字:确定、图片:按钮名、或 x,y 屏幕坐标）｜som_click（arg=#SoM编号，点 see image 标注图）｜type（文字）｜key（w/ctrl+s）｜hold（键,秒）｜scroll（down 5）｜drag（x1,y1,x2,y2）｜paste｜set_value（rid|值）｜get_value（rid）｜select_text（rid|文字）｜perform（rid）｜read（rid）｜snapshot（看可交互元素清单，等同 see tree，省一次往返；结果长时同样可传 offset/limit 续读）。**#编号只属于最近一次 see/snapshot 的快照**：回执带 snapshot_id/snapshot_age_ms；跨快照、换了窗口或超龄（默认 120 秒）会被 STALE_SNAPSHOT 拒发（点击一次都不发），按 nextIfFailed 重新 see 再点。传了 pid 当 hwnd 时不会死循环：回执的 identityNote 会指明真正的 hwnd。som_click 用自己的编号空间，同窗 hwnd 可放宽到 300 秒，且是**坐标点击（会动真实鼠标）**；UIA #编号直调不动鼠标。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['click', 'som_click', 'type', 'key', 'hold', 'scroll', 'drag', 'paste', 'set_value', 'get_value', 'select_text', 'perform', 'read', 'snapshot'], description: '要做什么' },
                        target: { type: 'string', description: '目标（含义随 action 变，见工具描述）' },
                        arg: { type: 'string', description: '（som_click）SoM 编号：#N 或数字（see image 标注图上的编号）' },
                        window: { type: 'string', description: '窗口标题的一部分（动作前先聚焦到它；按键/输入类强烈建议带）' },
                        verify: { type: 'boolean', description: '（可选）动作前后对比 UIA 摘要（窗口标题/元素树），把 effect 写回回执；结论不可验证时会如实标注' },
                        confirm_destructive: { type: 'boolean', description: '确认丢弃未保存内容（破坏性按钮如「不保存/放弃」）；不传真会被安全守卫拒绝' },
                        offset: { type: 'integer', description: '（snapshot 可续读）从第几项开始，默认 0；下一次用回执里的 next.offset' },
                        limit: { type: 'integer', description: '（snapshot 可续读）本页最多几项，默认 20' },
                    },
                    required: ['action'],
                },
            } },
            { type: 'function', function: {
                name: 'app',
                description: '管程序窗口。launch=启动（白名单里的：记事本/计算器/PCL/植物大战僵尸…）；focus=切到前台；list=看有哪些可启动的（多时按 offset/limit 分页，回执带 next）。窗口生命周期（2026-11-15 新增）：min/max/restore/close=最小化/最大化/还原/关闭（close 等同点 X，应用可能弹保存框）；move/size=挪到 x,y / 改成 w×h；all_min=一次最小化全部可见窗口（给 name 就只收标题匹配的）。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['launch', 'focus', 'list', 'min', 'max', 'restore', 'close', 'move', 'size', 'all_min'], description: 'launch 默认' },
                        name: { type: 'string', description: '应用名或窗口标题的一部分；窗口操作要填，all_min 留空=全部' },
                        x: { type: 'number', description: '（move）左上角 x，屏幕物理像素' },
                        y: { type: 'number', description: '（move）左上角 y' },
                        w: { type: 'number', description: '（size）宽' },
                        h: { type: 'number', description: '（size）高' },
                        offset: { type: 'integer', description: '（list 可续读）从第几项开始，默认 0' },
                        limit: { type: 'integer', description: '（list 可续读）本页最多几项，默认 30' },
                    },
                    required: ['action'],
                },
            } },
            { type: 'function', function: {
                name: 'file',
                description: '看本地文件（只读，不会改任何东西）：list=列目录（多时按 offset/limit 分页）；read=读文本文件（按**字符**分页：默认第 0–4000 字符，单页上限取 context.tool_result_max_chars（默认 12000，可被配置调小）；回执给 next.offset，大文件还会落 artifactPath）；search=按文件名在目录里递归找（按 offset/limit 分页）。要绝对路径；.ssh/凭据/Cookie 这类敏感目录会被拒。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['list', 'read', 'search'], description: 'list 默认' },
                        path: { type: 'string', description: '绝对路径（目录或文件），如 <project-root>/docs' },
                        keyword: { type: 'string', description: '（search）文件名里包含的关键字' },
                        offset: { type: 'integer', description: '（read/list/search 可续读）起始位置：read 是字符下标，list/search 是条目序号；默认 0' },
                        limit: { type: 'integer', description: '（read/list/search 可续读）本页条数/字符数：read 默认 4000（上限取 context.tool_result_max_chars，默认 12000），list 默认 60，search 默认 30' },
                        max_chars: { type: 'integer', description: '（read，旧参数）等同 limit；保留兼容' },
                    },
                    required: ['action', 'path'],
                },
            } },
            { type: 'function', function: {
                name: 'clipboard',
                description: '剪贴板：read=读当前文字；write=写入文字（写完会回读校验，对不上会明确报失败）。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['read', 'write'], description: 'read 默认' },
                        text: { type: 'string', description: '（write）要写入的文字' },
                    },
                    required: ['action'],
                },
            } },
            { type: 'function', function: {
                name: 'game',
                description: '纯视觉打游戏（她自己看画面、自己按键鼠标）。start=开始自动反应循环（必须显式给 profile，如 minecraft；可用 window 指定目标窗口，不会默认当前前台）；stop=停；status=看跑了多少帧/做了多少动作；see=看一帧的游戏状态（血条/运动目标，不发按键）；profiles=列出可用游戏。⚠ 这个工具只服务于已启动的游戏会话，不提供逐次按键/点击——通用按键请用 act key（有前台校验与回读）。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['start', 'stop', 'status', 'see', 'profiles'], description: '要做什么' },
                        profile: { type: 'string', description: '（start/see）游戏 profile 名，如 minecraft；start 必填' },
                        window: { type: 'string', description: '（start 可选）目标窗口标题的一部分；覆盖 profile 里的 window，不会回落到当前前台' },
                    },
                    required: ['action'],
                },
            } },
            { type: 'function', function: {
                name: 'batch',
                description: '一次提交多步操作（点→打字→回车这种）。整份先校验，任何一步不合法就一步都不执行。多步 GUI 操作优先用它，别一步步试。',
                parameters: {
                    type: 'object',
                    properties: {
                        steps: { type: 'array', description: '步骤数组，每步 {action, arg}', items: { type: 'object', properties: { action: { type: 'string' }, arg: { type: 'string' } } } },
                        window: { type: 'string', description: '目标窗口（会钉给后续所有步骤）' },
                    },
                    required: ['steps'],
                },
            } },
            { type: 'function', function: {
                name: 'knowledge',
                description: '查游戏攻略/规则知识库（内置 + 玩过的积累）。给游戏名可查该游戏的全部知识；再给查询词就按相关度排。',
                parameters: {
                    type: 'object',
                    properties: {
                        game: { type: 'string', description: '游戏名，如「植物大战僵尸」「我的世界」' },
                        query: { type: 'string', description: '（可选）查询词，如「为什么种不上」' },
                    },
                    required: ['game'],
                },
            } },
            { type: 'function', function: {
                name: 'skill',
                description: '她自己的操作记忆。list=看有哪些技能；save=把最近几步存成技能（给 name）；run=跑技能（给 name）；forget=删（给 name）；history=看最近做过什么（用户问「你刚才做了什么」时用）。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['list', 'save', 'run', 'forget', 'history'], description: '要做什么' },
                        name: { type: 'string', description: '（save/run/forget）技能名' },
                        steps: { type: 'integer', description: '（save）把最近几步存进去，默认 5' },
                    },
                    required: ['action'],
                },
            } },
            { type: 'function', function: {
                name: 'dispatch_to_dsh',
                description: '把「写代码/跑命令/查资料」这类**非 GUI** 任务派给后台执行器（有独立上下文，干完把结果发回来）。⚠ 打开程序/点击/输入这类 GUI 操作不要派给它 —— 用 act/app。可选 verify=一条验收命令（如 "node --test"），给了它「完成」才有外部证据；workspace=配置里的工作区别名（不是路径）。',
                parameters: {
                    type: 'object',
                    properties: {
                        task: { type: 'string', description: '要它做的事（越具体越好）' },
                        wait: { type: 'boolean', description: 'true=等它做完再返回（默认 false，后台跑完会通知）' },
                        verify: { type: 'string', description: '（可选）验收命令，一条；退出码 0=通过。例如 node -e "process.exit(0)"' },
                        workspace: { type: 'string', description: '（可选）工作区别名，如 pet；只能是 config.json dispatch.workspaces 里的键，不能填路径' },
                    },
                    required: ['task'],
                },
            } },
            { type: 'function', function: {
                name: 'dispatch_followup',
                description: '接着一个**已经结束**的后台任务继续做（复用它的 DSH 会话与上下文，不用从头交代）。taskId=原任务 id（check_dispatch 能看到）；task=这次要补做的事。父任务还在跑/没有会话 id 时会被拒绝。',
                parameters: {
                    type: 'object',
                    properties: {
                        taskId: { type: 'string', description: '原任务 id（之前派活返回的 id）' },
                        task: { type: 'string', description: '这次要接着做什么（越具体越好）' },
                    },
                    required: ['taskId', 'task'],
                },
            } },
            { type: 'function', function: {
                name: 'dispatch_cancel',
                description: '停掉一个正在跑的后台任务（按 id）。已写下的文件不会回滚；重复取消是幂等的。',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: '任务 id（派活时返回的 id）' },
                    },
                    required: ['id'],
                },
            } },
            { type: 'function', function: {
                name: 'check_dispatch',
                description: '查派出去的任务进度/结果。不传 id 就列出最近的任务。',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: '任务 id（不给就列全部）' },
                    },
                    required: [],
                },
            } },
            { type: 'function', function: {
                name: 'hand_action',
                description: '用户用嘴指挥你动手时的快捷入口（打开应用/输入文字/按回车/切换窗口/最小化全部/音量）。能本地毫秒级做完的会直接做，不会派给后台执行器。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', description: '动作名：打开应用/输入文字/按回车/切换窗口/最小化全部/音量' },
                        argument: { type: 'string', description: '参数（应用名/文字/窗口名/音量档）' },
                    },
                    required: ['action'],
                },
            } },
        ];
    }

    /**
     * see / act / app → game_control 的 (action, arg, focus)。
     * 2026-11-14：这四个语义工具纯粹是「按用户意图重新分组」，底层完全复用
     * runGameAction 的 36 个动作 —— 不新增第二套实现。
     */
    _mapToGameControl(name, p) {
        const a = String(p.action || '').toLowerCase();
        const t = (p.target === undefined || p.target === null) ? '' : String(p.target);
        const win = String(p.window || p.win || '').trim();
        const focus = win || undefined;

        if (name === 'see') {
            const mode = String(p.mode || 'tree').toLowerCase();
            if (mode === 'image' || mode === 'som') return { action: 'som_snapshot', arg: win, focus };
            // shot：抓原图（被遮挡也能抓），和 image（画了编号框的标注图）用途不同
            if (mode === 'shot') return { action: 'wgc_shot', arg: win };
            if (mode === 'text') return { action: 'read_text', arg: win, focus };
            if (mode === 'state') return { action: 'visual_read', arg: 'numbers --auto', focus };
            // 2026-11-21 穿测（真实管线一致性）：这里原来把 arg 写死成 ''，`window` 参数**被吞**——
            //   `see {mode:'windows', window:'记事本'}` 返回全部 20+ 个窗口，而同一操作直连
            //   runGameAction('list_windows','记事本') 只返回 1 个。工具描述里写着「window=窗口标题的一部分」，
            //   模型据此传参却拿不到过滤结果，属于「参数写在 schema 里、实现里漏接」的老坑。
            if (mode === 'windows') return { action: 'list_windows', arg: win };
            return { action: 'snapshot', arg: win, focus };
        }

        if (name === 'app') {
            const nm = String(p.name || '').trim();
            // 2026-11-14 五十三轮（审计）：`app list` 原来返回的是**已开窗口**，
            // 而工具描述说的是「看有哪些可启动的」—— 模型要开程序时拿到一堆窗口名。
            // 现在 list = 可启动白名单（launch_app 空参）；要看开着的窗口用 see mode=windows。
            if (a === 'list') return { action: 'launch_app', arg: '' };
            if (a === 'focus') return { action: 'focus_window', arg: nm };
            if (a === 'launch' || a === '') return { action: 'launch_app', arg: nm };
            // 窗口生命周期（2026-11-15 五十八轮）：拼成 "op|目标|x,y,w,h" 交给 game_control。
            // 为什么用 | 编码而不是加新字段：目标标题里可能有空格，走结构化字段要改整条
            // plan→runGameAction 的传参链；而 focus_window 早就在用 "标题|force" 这个习惯。
            if (['min', 'max', 'restore', 'close', 'move', 'size', 'all_min'].includes(a)) {
                let geo = '';
                if (a === 'move' && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
                    geo = Number(p.x) + ',' + Number(p.y);
                } else if (a === 'size' && Number.isFinite(Number(p.w)) && Number.isFinite(Number(p.h))) {
                    geo = Number(p.w) + ',' + Number(p.h);
                }
                return { action: 'window_op', arg: a + '|' + nm + '|' + geo };
            }
            throw new Error('app：action 只能是 launch / focus / list / min / max / restore / close / move / size / all_min（收到「' + a + '」）');
        }

        // act：target 自路由 —— 模型只说要「点哪个」，走 UIA 还是 OCR 还是坐标是框架的事
        switch (a) {
            case 'som_click': {
                // 点 see(image) 标注图里的编号（视觉编号，和 UIA 编号不是一回事）。
                // 2026-11-21（审计洞 2）：schema 里补了 som_click + arg；arg 优先，
                // 同时兼容旧的 target 写法（技能库/旧提示词里存的是 target）。
                // 以前只读 target → 模型按新 schema 传 arg 会被吞成空串，
                // 报「编号不存在」，看不出是参数名不对。
                const raw = (p.arg !== undefined && p.arg !== null && String(p.arg).trim() !== '') ? p.arg : t;
                const somIdx = String(raw == null ? '' : raw).trim().replace(/^#/, '');
                return { action: 'som_click', arg: somIdx, focus };
            }
            case 'click': {
                const s2 = t.trim();
                // 2026-11-14 五十三轮（审计）：编号不再要求同时给 window。
                // 原来 `click #3` 不带 window 会落到 click_at → 报「格式：x,y」，
                // 模型完全看不出「其实该先 snapshot」。编号就是编号，缺快照由 click_element 说清。
                if (/^#?\d+$/.test(s2)) return { action: 'click_element', arg: s2.replace(/^#/, ''), focus };
                if (/^文字[:：]/.test(s2)) return { action: 'click_text', arg: s2.replace(/^文字[:：]/, ''), focus };
                if (/^图片[:：]/.test(s2)) return { action: 'visual_click', arg: s2.replace(/^图片[:：]/, ''), focus };
                return { action: 'click_at', arg: s2, focus };
            }
            case 'type': return { action: 'type_text', arg: t, focus };
            case 'key': return { action: 'press_key', arg: t, focus };
            case 'hold': return { action: 'hold_key', arg: t, focus };
            case 'scroll': return { action: 'scroll', arg: t, focus };
            case 'drag': return { action: 'drag', arg: t, focus };
            case 'paste': return { action: 'paste', arg: t, focus };
            case 'set_value': return { action: 'set_value', arg: t, focus };
            case 'get_value': return { action: 'get_value', arg: t, focus };
            case 'select_text': return { action: 'select_text', arg: t, focus };
            case 'perform': return { action: 'perform_action', arg: t, focus };
            case 'read': return { action: 'edit_text', arg: t, focus };
            // P0-4（2026-11-21）：act snapshot 复用 see tree 的同一条实现 ——
            // 不复制第二份扫描函数，返回结构完全同构（elements/rid/type/name/x/y）。
            case 'snapshot': return { action: 'snapshot', arg: t || win, focus };
            default:
                throw new Error('act：action 只能是 click/som_click/type/key/hold/scroll/drag/paste/set_value/get_value/select_text/perform/read/snapshot（收到「' + a + '」）');
        }
    }

    /** game：纯视觉游戏循环（L1 感知 + L2 规则 + L0 注入，模型只管启停） */
    async _gameLoop(p) {
        const G = require('../../../js/core/game-loop.js');
        const a = String(p.action || 'status').toLowerCase();
        if (a === 'profiles') return JSON.stringify({ ok: true, profiles: G.listProfiles() }, null, 0);
        if (a === 'status') {
            return JSON.stringify({
                ok: true, ...G.loopStatus(),
                gate: gameGateStats(),   // 拒绝计数（可观测）
            });
        }
        if (a === 'stop') return JSON.stringify({ ok: true, ...G.stopLoop() });

        // ── 输入类动作：会话 + 前台双闸（2026-11-21 审计旁路①）────────────
        // 这些动作本就不在工具枚举里（输入由已启动循环在安全闸下发出）；
        // 但模型/旧技能/动态动作仍可能直接调 —— 必须在分发层拦死，不能变成
        // 绕过 act 的弱闸。
        if (GAME_INPUT_ACTIONS.has(a)) {
            const snap = (typeof G.sessionSnapshot === 'function') ? G.sessionSnapshot() : { active: false };
            const refusal = gameInputGate(a, snap);
            if (refusal) {
                this.context.log('warn', '[game] 拒绝输入动作 ' + a + '：' + refusal.error);
                return JSON.stringify(refusal);
            }
            // 闸过了也没有逐次输入通道：输入只由 start 的循环在 checkSafetyGate 下发。
            const denied = gameGateRefuse(
                'game 工具不提供逐次输入动作（' + a + '）；游戏内输入由 game start 的循环在安全闸下发出，通用按键请用 act key（有前台校验与回读）',
                { error: 'input-not-exposed' });
            this.context.log('warn', '[game] 拒绝输入动作 ' + a + '：' + denied.error);
            return JSON.stringify(denied);
        }

        // ── start / see：必须显式目标，不得默认前台 ────────────────────────
        const rawProfile = String(p.profile || '').trim();
        const rawWindow = String(p.window || p.win || '').trim();
        if (!rawProfile) {
            const reason = a === 'start'
                ? 'game start 需要显式目标（profile，如 minecraft；可用 window 覆盖目标窗口），不会默认当前前台窗口'
                : 'game ' + a + ' 需要显式 profile（如 minecraft）';
            const refusal = gameGateRefuse(reason, {
                error: 'missing-target',
                nextIfFailed: '先 game action=profiles 看可用 profile，再 start {profile:"minecraft"}（window 可选，用于覆盖目标窗口）',
            });
            this.context.log('warn', '[game] 拒绝 ' + a + '：缺显式目标');
            return JSON.stringify(refusal);
        }
        const prof = G.loadProfile(rawProfile);
        if (!prof) {
            const refusal = gameGateRefuse(
                'profile 找不到：' + rawProfile + '（game ' + a + ' 需要显式 profile，不会猜一个）',
                {
                    error: 'profile-not-found', profiles: G.listProfiles(),
                    nextIfFailed: '用 action=profiles 看有哪些，或先按 docs/设计-纯视觉游戏操作框架 建一个 profile',
                });
            this.context.log('warn', '[game] 拒绝 ' + a + '：profile 找不到 ' + rawProfile);
            return JSON.stringify(refusal);
        }
        // 显式 window 覆盖 profile 的目标；不允许「没 window 就落到前台」。
        if (rawWindow) prof.window = rawWindow;
        if (!(prof.window || prof.hwnd)) {
            const refusal = gameGateRefuse(
                'profile 缺少 window/hwnd：game ' + a + ' 必须有明确目标窗口，不会默认当前前台',
                {
                    error: 'missing-window', profile: prof.game || prof._file || rawProfile,
                    nextIfFailed: '在 profile 里补 window（目标窗口标题）或 hwnd，或在 start 时显式传 window',
                });
            this.context.log('warn', '[game] 拒绝 ' + a + '：profile 缺 window/hwnd');
            return JSON.stringify(refusal);
        }
        if (a === 'see') {
            const st = await G.state(prof, { slot: 'see' });
            return JSON.stringify(st);
        }
        if (a === 'start') {
            const r = G.startLoop(prof, { onErr: (e) => this.context.log('warn', '[game] ' + e) });
            if (!r || r.ok !== true) return JSON.stringify(r);
            // 只为如实回报：目标不在前台时循环会暂停（tick 的 checkSafetyGate），
            // 但 start 本身不拒绝 —— 用户可能正在跟她说话，游戏在后台。
            const snap = (typeof G.sessionSnapshot === 'function') ? G.sessionSnapshot() : {};
            return JSON.stringify({
                ...r,
                profile: prof.game || prof._file,
                target: snap.target || String(prof.window || prof.hwnd || ''),
                fps: prof.fps || 20,
                fgMatch: snap.fgMatch === undefined ? null : snap.fgMatch,
                note: snap.fgMatch === false
                    ? '目标窗口当前不在前台：循环会暂停，切回游戏后才发输入'
                    : undefined,
            });
        }
        throw new Error('game：action 只能是 start / stop / status / see / profiles（收到「' + a + '」）');
    }

    /**
     * 旧工具名认领（2026-11-14 五十三轮）。
     *
     * 合并工具面时把 51 个名字压成 27 个，但**历史调用还在**：技能库里存的步骤、
     * 旧对话里记下的「用 game_control」、以及用户自己写过的提示词。
     * pluginManager 只按 getTools() 声明路由 → 那些名字在这一层就断了，
     * 下面 executeTool 里的 `if (name === 'game_control')` 分支**从来没被走到过**。
     * 这个钩子把它们接回来（只是路由，不改语义）。
     */
    handlesToolName(name) {
        return LEGACY_TOOL_NAMES.has(String(name || '').trim());
    }

    // ── 文件原语（2026-11-15 五十九轮）：只读 ────────────────────────────
    // 为什么补：工具面此前只能「打开文件」，或让 code 执行器跑任意 Python ——
    // 日常最常说的「看看这个文件/这个目录里有什么」既没有专用原语、也不可验证。
    // 第一版刻意只读：写/删/移动的风险与收益不对称，先不给。
    /**
     * file read 单页硬上限（第四轮 P2）：读 config.context.tool_result_max_chars。
     * 没有 context / 拿不到 config（旧调用方、单测用 Object.create）→ 缺省 12000。
     */
    _fileReadPageCap() {
        try {
            const cfg = (this.context && typeof this.context.getConfig === 'function')
                ? this.context.getConfig() : null;
            return fileReadPageCap(cfg || null);
        } catch (e) { return PAGE_HARD_CAP_DEFAULT; }
    }

    async _fileTool(p) {
        const fs = require('fs');
        const path = require('path');
        const VC = require('./verify-contract.js');
        const a = String((p && p.action) || 'list').toLowerCase();
        const rawPath = String((p && p.path) || '').trim().replace(/^["']|["']$/g, '');
        if (!rawPath) {
            return JSON.stringify(VC.notSent('file：缺少 path（要绝对路径）', { error: 'missing-path', nextIfFailed: '例如 action=list path=<project-root>/docs' }));
        }
        if (!path.isAbsolute(rawPath)) {
            return JSON.stringify(VC.notSent('file：path 必须是绝对路径（收到「' + rawPath.slice(0, 40) + '」）', { error: 'not-absolute' }));
        }
        const abs = path.resolve(rawPath);
        // 敏感路径一律拒绝：读出去就是泄漏，而她根本不需要这些
        if (/(?:[\\/])(?:\.ssh|\.gnupg|Login Data|Cookies|Web Data|Local State|credentials)(?:[\\/]|$)/i.test(abs)) {
            return JSON.stringify(VC.notSent('file：拒绝访问敏感路径', { error: 'denied-path', path: abs }));
        }
        let st = null;
        try { st = fs.statSync(abs); } catch (e) {
            return JSON.stringify(VC.notSent('路径不存在：' + abs, { error: 'ENOENT', path: abs }));
        }

        if (a === 'list') {
            if (!st.isDirectory()) {
                return JSON.stringify(VC.notSent('这不是目录（是文件）：' + abs + ' → 用 action=read', { error: 'ENOTDIR', path: abs }));
            }
            let entries = [];
            try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) {
                return JSON.stringify(VC.notSent('目录读不了（权限？）：' + abs + ' — ' + (e && e.message || e), { error: 'EACCES', path: abs }));
            }
            const rows = entries.map((d) => {
                let size = null;
                try { if (d.isFile()) size = fs.statSync(path.join(abs, d.name)).size; } catch (e) { /* 单个取不到大小不影响列目录 */ }
                return { name: d.name, type: d.isDirectory() ? 'dir' : (d.isFile() ? 'file' : 'other'), size };
            }).sort((x, y) => ((x.type === 'dir' ? 0 : 1) - (y.type === 'dir' ? 0 : 1)) || x.name.localeCompare(y.name));
            // 分页（ADR-014）：目录可能有几百项，一页最多 200；不传 offset/limit 时默认 60。
            const offset = Math.max(0, Math.floor(Number(p && p.offset) || 0));
            const limit = Math.max(1, Math.min(200, Math.floor(Number(p && p.limit) || 60)));
            const page = rows.slice(offset, offset + limit);
            const nextOffset = offset + page.length < rows.length ? offset + page.length : null;
            const lines = page.map((r) => (r.type === 'dir' ? '[D] ' : '[F] ') + r.name + (r.size != null ? ' (' + r.size + 'B)' : ''));
            let detail = '「' + abs + '」共 ' + rows.length + ' 项（第 ' + (rows.length ? offset + 1 : 0) + '–'
                + (offset + page.length) + ' 项）' + (rows.length > page.length ? '：' : '：') + '\n' + lines.join('\n');
            if (nextOffset != null) detail += '\n…还有 ' + (rows.length - nextOffset) + ' 项；续读传 offset=' + nextOffset + ' limit=' + limit;
            return JSON.stringify(VC.readonly(detail,
                {
                    path: abs, count: rows.length, entries: page,
                    offset, limit, next_offset: nextOffset,
                    next: nextOffset == null ? null : { action: 'list', offset: nextOffset, limit },
                }));
        }

        if (a === 'read') {
            if (st.isDirectory()) {
                return JSON.stringify(VC.notSent('这是目录不是文件：' + abs + ' → 用 action=list', { error: 'EISDIR', path: abs }));
            }
            const MAX_BYTES = 2 * 1024 * 1024;
            if (st.size > MAX_BYTES) {
                return JSON.stringify(VC.notSent('文件太大（' + (st.size / 1048576).toFixed(1) + 'MB > 2MB），不整读：' + abs,
                    { error: 'EFBIG', nextIfFailed: '先用 file search 定位，或让 code 执行器按行读' }));
            }
            let buf = null;
            try { buf = fs.readFileSync(abs); } catch (e) {
                return JSON.stringify(VC.notSent('读取失败：' + (e && e.message || e), { error: 'EREAD', path: abs }));
            }
            if (buf.subarray(0, 4096).includes(0)) {
                return JSON.stringify(VC.notSent('看起来是二进制文件（含 NUL），不返回内容：' + abs, { error: 'EBINARY', path: abs }));
            }
            const text = buf.toString('utf8');
            // 分页语义（ADR-014，2026-11-24）：**按字符**切，offset 是起始字符下标，
            // limit 是这一页最多多少字符（默认 4000）。单页硬上限跟随
            // config.context.tool_result_max_chars（缺省 12000，钳 1000–12000）——
            // 早先写死 12000，配置改小后每页又被 cap 截一刀，「可续读」读不全。
            // 旧参数 max_chars 仍认，等同 limit。
            const pageCap = this._fileReadPageCap();
            const rawLimit = (p && p.limit !== undefined && p.limit !== null && String(p.limit).trim() !== '')
                ? p.limit : (p && p.max_chars);
            let limit = Math.max(200, Math.min(pageCap, Math.floor(Number(rawLimit) || 4000)));
            const offset = Math.max(0, Math.min(text.length, Math.floor(Number(p && p.offset) || 0)));
            // 全文 > 12k 时落 artifact：模型既能继续 offset，也能用 file read 读全文分段。
            let art = null;
            if (text.length > ARTIFACT_THRESHOLD_CHARS) {
                art = toolArtifact.writeArtifact('file', text, { turnId: '' });
            }
            // P1-3（2026-11-25 风暴压测）：**信封也要算进上限**。
            //   旧实现只按正文 limit 切页，JSON 信封（detail 重复一遍正文 + path/total_chars/next/
            //   artifactPath 元数据）会把结果推到 12k 以上，发送前再被 tool-result-cap 盲切一刀 ——
            //   模型拿到无法 JSON.parse 的半截回执，next/artifactPath 还可能被切没。
            //   这里对**序列化后的整页**做预检：超了就按超出量收 limit 重切，直到整页 < cap；
            //   next_offset 始终指向真实未读位置，续读拿得到完整内容。
            let out = '';
            let nextOffset = null;
            let payload = '';
            for (let attempt = 0; attempt < 4; attempt += 1) {
                out = text.slice(offset, offset + limit);
                nextOffset = offset + out.length < text.length ? offset + out.length : null;
                let detail = '「' + path.basename(abs) + '」共 ' + text.length + ' 字符，返回第 '
                    + offset + '–' + (offset + out.length) + ' 字符'
                    + (text.length > out.length ? (nextOffset != null ? '（未读完）' : '（已截断）') : '') + '：\n' + out;
                if (nextOffset != null) {
                    detail += '\n…还有 ' + (text.length - nextOffset) + ' 字符；续读传 offset=' + nextOffset + ' limit=' + limit;
                }
                if (art) detail += '\n完整内容已落盘：' + art.path + '（可用 file read + offset 分段读）';
                payload = JSON.stringify(VC.readonly(detail, {
                    path: abs, total_chars: text.length, offset, limit, returned_chars: out.length,
                    truncated: nextOffset != null,
                    next_offset: nextOffset,
                    next: nextOffset == null ? null : { action: 'read', offset: nextOffset, limit },
                    artifactPath: art ? art.path : undefined,
                }));
                if (payload.length <= pageCap || out.length <= 200) break;
                const over = payload.length - pageCap;
                const nextLimit = Math.max(200, limit - over - 32);
                if (nextLimit >= limit) break;      // 收敛不了（信封本身太大）：不再硬切
                limit = nextLimit;
            }
            return payload;
        }

        if (a === 'search') {
            const kw = String((p && p.keyword) || '').trim().toLowerCase();
            if (!kw) return JSON.stringify(VC.notSent('file search 需要 keyword（按文件名找）', { error: 'missing-keyword' }));
            const hits = [];
            const SKIP = /^(node_modules|\.git|dist|\.next|target|__pycache__|\.venv|venv)$/i;
            const walk = (dir, depth) => {
                if (hits.length >= 50 || depth > 4) return;
                let list = [];
                try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
                for (const d of list) {
                    if (hits.length >= 50) return;
                    const full = path.join(dir, d.name);
                    if (d.isDirectory()) {
                        if (SKIP.test(d.name)) continue;
                        if (d.name.toLowerCase().includes(kw)) hits.push({ path: full, type: 'dir' });
                        walk(full, depth + 1);
                    } else if (d.name.toLowerCase().includes(kw)) {
                        hits.push({ path: full, type: 'file' });
                    }
                }
            };
            walk(abs, 0);
            // 分页（ADR-014）：默认一页 30 条。
            const offset = Math.max(0, Math.floor(Number(p && p.offset) || 0));
            const limit = Math.max(1, Math.min(50, Math.floor(Number(p && p.limit) || 30)));
            const page = hits.slice(offset, offset + limit);
            const nextOffset = offset + page.length < hits.length ? offset + page.length : null;
            return JSON.stringify(VC.readonly(
                '在「' + abs + '」下找到 ' + hits.length + ' 个名字含「' + kw + '」的'
                + (hits.length >= 50 ? '（到上限 50 停止）' : '')
                + (hits.length ? '（第 ' + (offset + 1) + '–' + (offset + page.length) + ' 条）：\n' + page.map((h) => h.path).join('\n') : ''),
                {
                    path: abs, keyword: kw, hits: page, count: hits.length,
                    offset, limit, next_offset: nextOffset,
                    next: nextOffset == null ? null : { action: 'search', offset: nextOffset, limit },
                }));
        }

        return JSON.stringify(VC.notSent('file：action 只能是 list / read / search', { error: 'bad-action' }));
    }

    // ── 剪贴板原语（2026-11-15 五十九轮）────────────────────────────────
    // 为什么补：原来只能「复制到剪贴板」这一个单向动作（HAND_LOCAL），读不回来。
    // 写的时候**回读校验**：写进去和读出来不一致就报 failed，不做假成功。
    async _clipboardTool(p) {
        const VC = require('./verify-contract.js');
        let cb = null;
        try { cb = require('electron').clipboard; } catch (e) { cb = null; }
        if (!cb) return JSON.stringify(VC.notSent('剪贴板不可用（不在 Electron 环境）', { error: 'no-clipboard' }));
        const a = String((p && p.action) || 'read').toLowerCase();
        if (a === 'read') {
            const t = String(cb.readText() || '');
            const cap = 4000;
            return JSON.stringify(VC.readonly(
                '剪贴板共 ' + t.length + ' 字符' + (t.length > cap ? '（返回前 ' + cap + '）' : '') + (t ? '：' + t.slice(0, cap) : '（空）'),
                { total_chars: t.length, text: t.slice(0, cap) }));
        }
        if (a === 'write') {
            const text = String((p && p.text) || '');
            if (!text) return JSON.stringify(VC.notSent('clipboard write 需要 text', { error: 'empty-text' }));
            try { cb.writeText(text); } catch (e) {
                return JSON.stringify(VC.notSent('写剪贴板失败：' + (e && e.message || e), { error: 'write-failed' }));
            }
            const back = String(cb.readText() || '');
            if (back === text) return JSON.stringify(VC.confirmed('已写入剪贴板，回读一致（' + text.length + ' 字符）', { chars: text.length }));
            return JSON.stringify(VC.failed('写进剪贴板了但回读不一致（可能被别的程序改了）', { expected_chars: text.length, got_chars: back.length }));
        }
        return JSON.stringify(VC.notSent('clipboard：action 只能是 read / write', { error: 'bad-action' }));
    }

    async executeTool(name, params) {
        // A3 统一回执（2026-11-21）：dispatch 是**所有动作类工具**的出口。
        // 这里只做一件事：失败却没给 detail 的返回补一句原因并留 `_backfilled` 痕迹
        // （验收要求 backfilled=0）。已合规的返回**原样透传** —— 不重排字段、不换形状，
        // 下游（模型/评测/控制中心）看到的还是同一个 JSON 字符串。
        // ADR-014（2026-11-24）：see/act snapshot/app 的结果在契约修正**之前**分页，
        // 这样 detail 是分页版、ensure 只补失败原因（小结果原样不动）。
        let raw = await this._executeToolRaw(name, params);
        if (name === 'see' || name === 'act' || name === 'app') {
            try { raw = paginateToolResult(name, params, raw); } catch (e) { /* 分页失败不影响原结果 */ }
        }
        return this._ensureResult(name, raw);
    }

    /** A3：把 dispatch 的返回过一遍契约（只在需要补失败原因时才改写）。 */
    _ensureResult(name, raw) {
        try {
            if (typeof raw !== 'string') return raw;
            const s = raw.trim();
            if (!s || (s[0] !== '{' && s[0] !== '[')) return raw;
            const v = JSON.parse(s);
            if (!v || typeof v !== 'object' || Array.isArray(v)) return raw;
            const VC = require('./verify-contract.js');
            const fixed = VC.ensure(v, { name });
            return fixed._backfilled ? JSON.stringify(fixed) : raw;
        } catch (e) { return raw; }
    }

    async _executeToolRaw(name, params) {
        // ── 工具面重塑（2026-11-14）：四个语义工具 + appearance 在这里**转成旧名字**，
        // 落到下面的现有分支；`params = p` 让后续代码不用改。
        let p = params || {};
        if (name === 'appearance') {
            const a = String(p.action || 'perform').toLowerCase();
            // 参数缺了就明确说缺什么（2026-11-14 审计：原来直接下去会得到「皮套不认识这个动作 ''」，
            // 模型看不出是漏参数还是名字写错）
            if (a === 'asset') {
                if (!p.id) {
                    return JSON.stringify({ ok: false, error: 'appearance：action=asset 时要给 id',
                        available: ['clothes-skirt', 'clothes-chest', 'clothes-shoes', 'clothes-tail', 'form-size', 'glasses-frame', 'glasses-monocle', 'headwear-pot', 'gesture-grass', 'gesture-chest', 'gesture-finger'],
                        nextIfFailed: 'id 是装扮/形态的标识；value 是开关（true/false）或档位（big/mid/small）' });
                }
                name = 'pet_asset'; p = { id: p.id, value: p.value };
            } else if (a === 'action') {
                if (!p.name) {
                    return JSON.stringify({ ok: false, error: 'appearance：action=action 时要给 name（动作名）',
                        available_hint: 'wave / tilt_head / nod_head / point / bow / clap',
                        nextIfFailed: '动作名不传传不准时可以先不传 name（只有 perform 支持空=返回节目列表）' });
                }
                name = 'pet_action'; p = { name: p.name };
            } else { name = 'pet_perform'; p = { name: p.name }; }
        } else if (name === 'game') {
            return await this._gameLoop(p);
        } else if (name === 'batch') {
            // batch 的旧参数是 JSON 字符串，这里把结构化 steps 拼回去。
            // 2026-11-21 穿测（真实管线一致性）：schema 写的是 array，但模型（和旧提示词/技能库）
            //   经常把 steps **序列化成字符串**再传 —— 原来 Array.isArray 直接判 false →
            //   steps 被吞成 []，后端只能报「计划为空」，模型看不出是自己传错类型。
            //   这里两种形状都收（数组 / JSON 字符串 / {steps:[...]}），非法形状仍交给后端拒绝。
            let rawSteps = p.steps;
            if (typeof rawSteps === 'string') {
                try { rawSteps = JSON.parse(rawSteps); } catch (e) { /* 交给下面按非法处理 */ }
            }
            if (rawSteps && !Array.isArray(rawSteps) && Array.isArray(rawSteps.steps)) rawSteps = rawSteps.steps;
            const steps = Array.isArray(rawSteps) ? rawSteps : [];
            p = { action: 'batch', arg: JSON.stringify({ steps, focus: p.window || '' }), focus: p.window };
            name = 'game_control';
        } else if (name === 'knowledge') {
            p = { action: 'knowledge', arg: [p.game, p.query].filter(Boolean).join(',') };
            name = 'game_control';
        } else if (name === 'skill') {
            const a = String(p.action || 'list').toLowerCase();
            // 原始参数先存下来（下面会把 p 整个换成 game_control 的形状）
            const rawSteps = p.steps;
            const rawName = String(p.name || '').trim();
            if (a === 'history') {
                // 2026-11-14 五十三轮（审计）：原来先覆盖 p 再读 p.steps → 永远是 undefined → 恒 10 条
                const n = Number(rawSteps);
                p = { action: 'recent_actions', arg: String(Number.isFinite(n) && n > 0 ? Math.min(30, Math.round(n)) : 10) };
            } else {
                if ((a === 'save' || a === 'run' || a === 'forget') && !rawName) {
                    return JSON.stringify({ ok: false, error: 'skill ' + a + ' 需要 name', nextIfFailed: '先用 skill list 看有哪些技能' });
                }
                const parts = [a];
                if (rawName) parts.push(rawName);
                if (a === 'save') {
                    const n = Number(rawSteps);
                    if (Number.isFinite(n) && n > 0) parts.push(String(Math.min(30, Math.round(n))));
                }
                p = { action: 'skill', arg: parts.join(' ').trim() };
            }
            name = 'game_control';
        } else if (name === 'file') {
            return await this._fileTool(p);
        } else if (name === 'clipboard') {
            return await this._clipboardTool(p);
        } else if (name === 'see' || name === 'act' || name === 'app') {
            const wantConfirm = p && p.confirm_destructive === true;
            // P2-9（2026-11-21）：act 的可选 verify —— 动作前后 UIA 摘要对比。
            const wantVerify = name === 'act' && !!(p && p.verify === true);
            // 可观测（2026-11-21 洞 1/4）：schema 之外的键不再静默吞掉。
            // 典型病史：confirm_destructive 早就被这里读，但 act 的 JSON Schema 没声明 →
            // 模型带上也被上游 schema 吃掉 → 守卫永远拒绝。schema 补上后，这条计数用来
            // 抓「模型又传了 schema 里没有的键」的下一次回归。
            if (name === 'act' && p && typeof p === 'object') {
                const ACT_SCHEMA_KEYS = new Set(['action', 'target', 'arg', 'window', 'win', 'verify', 'confirm_destructive', 'offset', 'limit']);
                const unknown = Object.keys(p).filter((k) => !ACT_SCHEMA_KEYS.has(k));
                if (unknown.length) {
                    bumpControlStat('schemaUnknownKeys', unknown.length);
                    this.context.log('warn', '[act] 忽略 schema 之外的参数：' + unknown.join(','));
                }
            }
            p = this._mapToGameControl(name, p);
            // 透传「我确认这是破坏性操作」（§71）：_mapToGameControl 只保留 action/arg/focus，
            // 不在这儿带过去，click_element 的守卫就永远不知道该放行。
            if (wantConfirm) {
                p.confirm_destructive = true;
                bumpControlStat('confirmDestructiveGranted');
                this.context.log('info', '[act] 已确认破坏性操作：' + String(p.action) + ' ' + String(p.arg || '').slice(0, 40));
            }
            if (wantVerify) p.verify = true;
            name = 'game_control';
        }
        params = p;
        if (name === 'dispatch_to_dsh') return this._start(params || {});
        if (name === 'dispatch_followup') return this._followup(params || {});
        if (name === 'dispatch_cancel') return this._cancel(params || {});
        if (name === 'check_dispatch') return this._check(params || {});
        if (name === 'pet_perform' || name === 'pet_action' || name === 'pet_asset') {
            // 皮套直通（她说「笑一个」就笑）：优先渲染进程内直调 petBody（同进程、同步、
            // 语义零丢失——setAssetValue 是修过键名 bug 的正确实现，支持档位 id 直设）；
            // petBody 不在（皮套未加载）才回落 8103 HTTP（vts /asset 是布尔化广播，
            // 档位值会被 !!on 吃掉——只作兜底，不承载档位语义）。
            // 错误信息刻意带可用清单——她下一轮能自己纠正，不用用户再教。
            const body = {};
            if (name === 'pet_perform') body.name = String((params && params.name) || '').trim();
            if (name === 'pet_action') body.name = String((params && params.name) || '').trim();
            if (name === 'pet_asset') {
                body.id = String((params && params.id) || '').trim();
                const v = (params && params.value);
                body.value = (v === true || v === 'true') ? true : (v === false || v === 'false') ? false : String(v === undefined ? '' : v);
            }
            const route = name === 'pet_perform' ? '/perform' : name === 'pet_action' ? '/action' : '/asset';
            this.context.log('info', '[皮套] ' + route + ' ' + JSON.stringify(body).slice(0, 60));
            const pb = (typeof window !== 'undefined') ? window.petBody : null;
            try {
                if (pb) {
                    if (name === 'pet_perform') {
                        const scenes = pb.listScenes ? pb.listScenes() : [];
                        if (!body.name) {
                            return JSON.stringify({ ok: true, list: scenes, detail: '可用节目：' + scenes.join('/') });
                        }
                        if (scenes.length && !scenes.includes(body.name)) {
                            return JSON.stringify({ ok: false, error: '没有这个节目：' + body.name, hint: '可用节目：' + scenes.join('/') });
                        }
                        const okp = pb.perform(body.name);
                        if (!okp) throw new Error('节目启动失败');
                        return JSON.stringify({ ok: true, detail: '已在演：' + body.name });
                    }
                    if (name === 'pet_action') {
                        const oka = pb.playAction(body.name);
                        if (!oka) throw new Error('皮套不认识这个动作：' + body.name);
                        return JSON.stringify({ ok: true, detail: '已在做：' + body.name });
                    }
                    if (name === 'pet_asset') {
                        const st = pb.setAssetValue(body.id, body.value);
                        const item = st && st[body.id];
                        if (!item) throw new Error('皮套不认识这个装扮/形态：' + body.id);
                        return JSON.stringify({ ok: true, detail: '装扮已更新：' + (item.optionLabel || (item.on ? '开' : '关')) });
                    }
                }
            } catch (e) {
                const err = (e && e.message) || String(e);
                this.context.log('warn', '[皮套] ✗ ' + err.slice(0, 120));
                return JSON.stringify({ ok: false, error: err });
            }
            // 2026-11-14 五十三轮（审计）：皮套没加载（petBody 不在）时只剩 8103 这条 HTTP 通道，
            // 而它只支持开关型。档位值（big/mid/small）**必须当场拒绝**，不能让 8103 把
            // "big" 当成 true 翻一下开关，然后我们回头对用户说「装扮已更新」。
            if (name === 'pet_asset') {
                const v = body.value;
                const boolish = v === true || v === false || v === 'true' || v === 'false' || v === '';
                if (!boolish) {
                    return JSON.stringify({
                        ok: false,
                        error: '皮套还没加载（petBody 不在），8103 兜底通道只能开关不能设档位（收到「' + String(v) + '」）',
                        nextIfFailed: '重启宿主让皮套加载后再设档位；或者只传 true/false 做开关',
                    });
                }
            }
            const r = await this._post8103(route, body, 8000);
            if (r && r.ok) {
                const detail = name === 'pet_asset' ? '装扮已更新' : '已在演：' + (body.name || '');
                this.context.log('info', '[皮套] ✓ ' + detail + '（8103 兜底）');
                return JSON.stringify({ ok: true, detail });
            }            const err = (r && (r.error || r.message)) || '皮套没响应';
            this.context.log('warn', '[皮套] ✗ ' + err.slice(0, 120));
            return JSON.stringify({ ok: false, error: err, hint: name === 'pet_perform' ? '可用节目：打招呼/撒娇/生气/难过/得意/伸懒腰/鼓掌/想事情/点头/晚安/鞠躬/指一指' : undefined });
        }
        if (name === 'hand_action') {
            const act = String((params && params.action) || '').trim();
            const tpl = HAND_TEMPLATES[act];
            if (!tpl) throw new Error('[手脚] 不支持的动作：' + act + '（可用：' + Object.keys(HAND_TEMPLATES).join('、') + '）');
            // 2026-11-21 穿测（真实管线一致性）：schema 里这个参数叫 `argument`，但同插件其余工具
            //   都叫 `arg`/`target`，模型按邻近工具的习惯写 `arg` 时原来会被静默吞掉 →
            //   参数变成空串 → 报「要聚焦的窗口标题呢」这类**看不出是漏参还是参数名不对**的错。
            //   这里做别名归一（argument > arg > target），不改变任何语义。
            const argument = String((params && (params.argument || params.arg || params.target)) || '').trim();
            // 2026-11-13：能在本地毫秒级做完的，直接走 game_control —— 不再派后台执行器。
            // （原来一律 `_start({task})`，导致「打开 PCL」被编码型 agent 开完又清理掉。）
            const local = HAND_LOCAL[act];
            if (local) {
                const spec = local(argument);
                this.context.log('info', '[手脚] ' + act + ' → 本地直通 game_control.' + spec.action + (spec.arg ? ' ' + spec.arg : ''));
                return this.executeTool('game_control', { action: spec.action, arg: spec.arg });
            }
            // 第二组：直接用 Electron 做（不经过 game_control，更不走后台）
            if (SHELL_LOCAL_ACTS.has(act)) {
                this.context.log('info', '[手脚] ' + act + ' → 本地 Electron 直做 ' + String(argument).slice(0, 40));
                const out = await this._localShellAction(act, argument);
                if (out) return out;
            }
            const task = tpl(argument);
            this.context.log('info', '[手脚] ' + act + ' → ' + task.slice(0, 60));
            return this._start({ task });
        }
        if (name === 'game_control') {
            const action = String((params && params.action) || '').trim();
            const arg = String((params && params.arg) || '').trim();
            const focus = String((params && params.focus) || '').trim();
            // 限速（2026-11-09 分场景）：
            //   · 只读动作（list_windows / snapshot / som_snapshot / list_game_profiles）不吃冷却
            //   · semantic（陪玩连招）走宽松闸 600次/分，否则打游戏一秒几次根本动不了
            //   · 其余保持严格闸 300ms/20次，防误触
            //
            // ⚠ 2026-11-09 三十五轮补：`knowledge` 和 `skill` 之前没进 READONLY，
            //   导致连续调 `skill list` / `knowledge` 会被「太快了，歇一下再按（冷却 300ms）」
            //   拦住 —— 只读查询根本不该限流（实测踩到：技能库验收流程第 2 步就被拦）。
            // ⚠ 2026-11-09 三十六轮：wgc_shot 也进 READONLY —— 它只抓图落盘，无桌面副作用，
            //   和 wgc_hash 一样不该吃 300ms 冷却（抓一次本身就要 300-1200ms）。
            //
            // ⚠ 2026-11-10 三十七轮：`visual_click` **不进 READONLY**（刻意）。
            //   它前半段（WGC 抓图 + 模板匹配）确实只读，但后半段会发一次真实鼠标点击。
            //   READONLY 的语义是「完全无桌面副作用 → 跳过限速闸」；把点击动作放进去等于
            //   让「点按钮」绕开所有频次保护 —— 点错窗口/被卡住时会在 1 分钟内连点 600 次。
            //   探测阶段只读 ≠ 动作整体只读。它归到 GAME_ACTIONS（见下），和 click_at 同级。
            // 2026-11-10 审计修：补 recent_actions/edit_text（纯读，连续查询会被 300ms 严格闸拦）；
            //   移除 pvz_state（它现在必然走 notSent/readonly 分支，列进只读集合自相矛盾）。
            // ⚠ 2026-11-10 红队：wgc_shot 会落盘 7MB 文件（磁盘副作用），不能算只读——
            //   否则它完全跳过限速，循环调用可写满磁盘。
            const READONLY = new Set(['list_windows', 'snapshot', 'som_snapshot', 'list_game_profiles', 'knowledge', 'wgc_hash', 'visual_read', 'recent_actions', 'edit_text', 'project_status']);
            // 游戏态动作走宽松闸（2026-11-09 压测发现）：原来只有 semantic 走游戏闸，
            // press_key/hold_key 还是 300ms 严格闸——打游戏按 W 走位会被拦（实测连续 5 次按
            // Shift 有 2 次被拒）。方向键/技能键都属游戏操作，必须放行。
            // 2026-11-10 三十七轮：visual_click 也归这里 —— 它本质是「带视觉定位的 click_at」，
            //   一次调用本身就要 1-2s（WGC ~0.8s + 匹配 ~0.2s），300ms 冷却碰不到，
            //   但严格闸的「20 次/分钟」会卡住游戏里连续点按钮；和 click_at 同档才一致。
            const GAME_ACTIONS = new Set(['semantic', 'press_key', 'hold_key', 'click_at', 'pvz', 'visual_click']);
            // skill 按子命令分档：
            //   list            → 只读，跳过闸门（它会内部读 skills.json）
            //   save / forget   → 只写本地 JSON，无桌面副作用，跳过闸门
            //   run             → 会真的执行动作序列，走游戏闸（和 semantic 同级）
            let skillSub = '';
            if (action === 'skill') {
                skillSub = String(arg || '').trim().split(/\s+/)[0].toLowerCase() || 'list';
            }
            const isReadonlyAction = READONLY.has(action)
                || (action === 'skill' && skillSub !== 'run');
            const gate = isReadonlyAction
                ? null
                : ((GAME_ACTIONS.has(action) || (action === 'skill' && skillSub === 'run')) ? rateGateGame() : rateGate());
            // 2026-11-10 回归审计：契约要求 detail 永远有值（LLM 主要看这个），gate 分支原来只给 error
            if (gate) return JSON.stringify({ ok: false, verified: null, unverified: true, effect: 'not_sent', tier: 'L3', action_sent: false, error: gate, detail: gate, nextIfFailed: '别连按——歇一下再试。批量操作可以用 batch 一次提交（批量只算一次节奏）' });
            this.context.log('info', '[直控] ' + action + ' ' + arg.slice(0, 40) + (focus ? ' @' + focus : ''));
            try {
                // 语义动作表：内置 generic + plugin_config.json 的 game_profiles.<名> 覆盖/新增（换游戏不改代码）
                let profiles = null;
                let extraCfg = null;
                try {
                    const fc = this.context.getPluginFileConfig() || {};
                    const gp = fc.game_profiles;
                    if (gp && typeof gp === 'object') profiles = Object.assign({ generic: SEMANTIC_GENERIC }, gp);
                    // Minecraft RCON 配置（UI 可填）；也认环境变量兜底
                    if (fc.mc_cfg && typeof fc.mc_cfg === 'object') extraCfg = { mc: fc.mc_cfg };
                    // 2026-11-13：`apps`（launch_app 的启动白名单）原来**没被传进去** ——
                    //   extraCfg 只塞了 mc，所以 plugin_config.json 里写的 apps 永远读不到，
                    //   白名单恒为内置的植物大战僵尸/记事本/计算器。用户让「打开 PCL」时
                    //   直接报「不在白名单」，只能退回去派后台执行器（然后 PCL 被清理掉）。
                    if (fc.apps && typeof fc.apps === 'object') {
                        if (!extraCfg) extraCfg = {};
                        extraCfg.apps = fc.apps;
                    }
                } catch (e) { try { __silentAudit.audit('index.js:212', e); } catch (e2) {} }
                // 破坏性动作的显式确认（§71）：只有调用方写明 confirm_destructive:true 才放行
                if (params && params.confirm_destructive === true) {
                    if (!extraCfg) extraCfg = {};
                    extraCfg.confirm_destructive = true;
                }
                // P2-9（2026-11-21）：act verify → 动作前后 UIA 摘要对比（game-control 内实现）
                if (params && params.verify === true) {
                    if (!extraCfg) extraCfg = {};
                    extraCfg.verify = true;
                }
                const r = await runGameAction(action, arg, focus || null, profiles, extraCfg);
                // ── §71 C：action_sent 真的进重试决策（审计说「全库没人消费它」）────────
                // 语义：action_sent=true 且 verified===null = 「动作已经发出去，但我们无法确认结果」。
                // 这时候原样重试 = 同一个副作用做两遍（发两封信/删两次/点两次购买）。
                // 以前只有契约字段、没有任何地方据此影响「下一步建议」，等于白记。
                // 现在：结果里带 retrySafe:false，并把 nextIfFailed 改写成「先只读确认」。
                // 注意：只动 action_sent===true 的这一类；not_sent（没发出去）仍然可以放心重试。
                if (r && typeof r === 'object' && r.action_sent === true && r.verified === null) {
                    const warn = '已发出但无法验证结果：**不要原样重试**（同一副作用会做两遍）。'
                        + '先用只读动作确认（snapshot / read_text / wgc_hash / get_value）。';
                    r.retrySafe = false;
                    r.nextIfFailed = r.nextIfFailed ? warn + ' ' + String(r.nextIfFailed) : warn;
                }
                // ⚠ 2026-11-09 三十五轮修：这里原来写死 `ok: true` —— 把契约里
                //   ok:false（比如「点了但画面没变」）**强行改回成功**。
                //   这是「假成功」的最后一道暗门：即使 game-control 做对了，
                //   index.js 也会把它改回 ok:true，AI 永远看到成功。
                //   现在改成 r.ok 原样透传。
                this.context.log(r.ok === false ? 'warn' : 'info', '[直控] ' + (r.ok === false ? '✗ ' : '✓ ') + String(r.detail || r.error || '').slice(0, 160));
                // 记执行历史（供 skill save 切片）+ **自动累积经验**（2026-11-09 三十五轮）
                //
                // 原来只有 semantic 会落经验（game-control 里手写的一句 recordFromResult）。
                // 但经验库的价值在于「她做过的每件事都在长大」—— 所以收口到这里：
                // 一次动作做完，只要**验证过**（verified === true/false），就记一条。
                //
                // recordFromResult 内部已经过滤了：
                //   · readonly（查询没有「成败」）
                //   · not_sent（没发出去，不算「试过」）
                //   · unverifiable（记了就是猜）
                // 所以这里不用再筛一遍，交给它判断（单一职责）。
                try {
                    const SK = require('./skill-library.js');
                    // 执行历史：查询类跳过（它们是「看一眼」，不是「做一个动作」）
                    if (action !== 'knowledge' && action !== 'skill' && action !== 'list_windows'
                        && action !== 'snapshot' && action !== 'som_snapshot' && action !== 'list_game_profiles') {
                        SK.recordHistory({ action, arg, ok: r.ok, verified: r.verified, effect: r.effect });
                    }
                    // 经验层：只要能验证成败就记（readonly/not_sent/unverifiable 由内部过滤）
                    const KB = require('./knowledge-base.js');
                    // 游戏名：优先用 semantic 识别的，其次用前台窗口标题的第一段，最后 generic
                    let gameName = 'generic-desktop';
                    if (r.semantic && r.semantic.game) gameName = r.semantic.game;
                    else if (focus) gameName = String(focus).split(/[\s\-—]/)[0] || 'generic-desktop';
                    // 动作名：优先用「可读的元素名」而不是编号 —— 编号每轮都变，
                    // 记「click_element 5」对下次毫无用处；记「click_element 首 页」才是知识。
                    const actLabel = (r && r.elementName)
                        ? action + ' "' + String(r.elementName).slice(0, 50) + '"'
                        : action + (arg ? ' ' + String(arg).slice(0, 60) : '');
                    KB.recordFromResult(gameName, actLabel, r);
                    // 技能自动沉淀（2026-11-10）：24h 内同一段动作成功 ≥2 次 → 提示她存成技能。
                    //   只在结果里挂一个 skillHint，不自动建卡（名字/要不要存仍由她决定）。
                    try {
                        const sed = SK.detectRepeatedSequence && SK.detectRepeatedSequence();
                        if (sed) {
                            const chain = sed.steps.map((s) => s.action + (s.arg ? ' ' + s.arg : '')).join(' → ');
                            r.skillHint = '这组动作 24h 内已成功 ' + sed.count + ' 次（' + chain +
                                '）。可以「skill save ' + sed.suggestedName + '」存成技能，下次一句话就能跑';
                            this.context.log('info', '[直控] 技能沉淀建议: ' + r.skillHint);
                        }
                    } catch (e) { try { __silentAudit.audit('index.js:skill-sediment', e); } catch (e2) {} }
                } catch (e) { try { __silentAudit.audit('index.js:history', e); } catch (e2) {} }
                // 2026-11-09：原来只透传 detail/windows，把 elements（snapshot 菜单）
                // 和 image（SoM 标注图）都丢了 —— AI 拿不到编号清单和图，功能等于残废。
                // 2026-11-09 根治「白名单透传」反复踩坑（SoM/mc/pvz 都踩过）：
                // 之前只把列出来的字段透传给 AI，后端算了但不在这份名单里的字段全丢——
                // 表现就是「功能做了但 AI 拿不到」。现在改为**全量透传**：
                // 后端返回什么就给什么，只补一个 imageIsBase64 标记。
                return JSON.stringify(Object.assign({}, r, {
                    ...(r.image ? { imageIsBase64: true } : {}),
                }));
            } catch (e) {
                this.context.log('warn', '[直控] ✗ ' + action + ': ' + (e && e.message || e));
                // 参数不合法 / 抛出异常 → 动作根本没发出去
                //
                // ⚠ 2026-11-09 三十五轮：原来只带 error，**没带 detail**。
                //   契约要求 detail 永远有值（LLM 主要看这个），否则前端/模型看到的是空字符串。
                //   实测踩到：snapshot VALORANT 返回 {ok:false, effect:'not_sent', detail:''} —— 
                //   AI 完全不知道为什么失败。
                const emsg = (e && e.message) || String(e);
                return JSON.stringify({
                    ok: false, verified: null, unverified: true, effect: 'not_sent',
                    tier: 'L3', action_sent: false,
                    // 2026-11-10 四十轮：把 game-control 抛出的稳定否决码带出去
                    //   （1001 焦点丢失 / 1002 落点被遮挡 / 1005 急停或 UAC 安全桌面）
                    ...(e && e.vetoCode ? { vetoCode: e.vetoCode } : {}),
                    detail: action + ' 没能执行：' + emsg,
                    error: emsg,
                    nextIfFailed: '这是参数/前置条件问题，不是动作没生效。按 error 里的提示改正后重试；' +
                        '如果提示「没扫到元素 / 找不到窗口」，先 list_windows 或 snapshot 确认目标还在',
                });
            }
        }
        throw new Error('[dispatch] 不支持的工具: ' + name);
    }

    _running() { return [...this._tasks.values()].filter((t) => t.state === 'running').length; }

    /**
     * ⚠ 2026-11-10 数据完整性修复：`_tasks` 原来只 set 不 delete —— 派活越多 Map 越涨，
     * 长跑几天（几分钟一个任务）就是几千条带 4KB 结果文本的记录常驻内存。
     * 这里做两层兜底：① 超过 200 条先清最旧的**已结束**任务 ② check 查过之后删掉
     * （见 _check；只在 done/failed 时删，running 不删）。
     */
    _pruneTasks() {
        const MAX = 200;
        if (this._tasks.size <= MAX) return;
        const ended = [...this._tasks.values()]
            .filter((t) => t.state === 'done' || t.state === 'failed' || t.state === 'unknown' || t.state === 'cancelled')
            .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
        let need = this._tasks.size - MAX;
        for (const t of ended) {
            if (need <= 0) break;
            this._tasks.delete(t.id);
            need -= 1;
        }
    }

    /**
     * 「手脚」里能直接用 Electron 本地做完的（打开文件/网页、复制、截图）。
     *
     * 为什么单独一组（2026-11-13）：这几个原来都转给后台执行器，但它们是纯本地操作 ——
     * 打开文件是 `shell.openPath`、打开网页是 `shell.openExternal`、复制是 clipboard、
     * 截图是主进程的 take-screenshot（今天刚修好 Rust 那条）。转后台既慢，又会被
     * 「做完清理战场」的 agent 顺手关掉。
     */
    async _localShellAction(act, argument) {
        const { shell, clipboard } = require('electron');
        if (act === '打开文件') {
            if (!argument) return JSON.stringify({ ok: false, error: '要打开哪个文件？给我完整路径' });
            if (!/[\\/]/.test(argument)) {
                return JSON.stringify({ ok: false, error: '「' + argument + '」不是完整路径，打不开', hint: '给我完整路径（如 D:/xxx/yyy.docx），或者先用「找文件」定位' });
            }
            // 2026-11-21 红队审计 P1：shell.openPath 走 Windows 默认关联 —— 打开 .exe/.bat/.ps1
            // 等于**绕过 launch_app 白名单直接起进程**（提示词注入 → 执行的最短路径）。
            // 可执行/脚本类一律拒绝；要启动应用只走 launch_app（白名单 + detached）。
            // 归一：Windows 会忽略结尾的点和空格（x.exe. 仍会执行 x.exe），先剥掉再判；
            // 同时覆盖 NTFS 数据流写法（x.exe:stream）。
            const openTarget = String(argument).trim().replace(/[. ]+$/, '');
            if (/\.(exe|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|wsf|wsh|msi|msp|lnk|reg|hta|pif|cpl|jar)(?::.*)?$/i.test(openTarget)) {
                return JSON.stringify({
                    ok: false,
                    error: '出于安全考虑，不直接用默认程序打开可执行/脚本文件：' + argument,
                    hint: '要启动应用请用「打开应用」（launch_app，只认白名单）；文件只在编辑器/阅读器里打开',
                });
            }
            const err = await shell.openPath(argument);
            return err
                ? JSON.stringify({ ok: false, error: '打不开：' + err, path: argument })
                : JSON.stringify({ ok: true, detail: '已用默认程序打开', path: argument });
        }
        if (act === '打开网页') {
            let url = String(argument || '').trim();
            if (!url) return JSON.stringify({ ok: false, error: '要打开哪个网址？' });
            if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
            await shell.openExternal(url);
            return JSON.stringify({ ok: true, detail: '已在默认浏览器打开', url });
        }
        if (act === '复制到剪贴板') {
            if (!argument) return JSON.stringify({ ok: false, error: '要复制什么？' });
            clipboard.writeText(argument);
            return JSON.stringify({ ok: true, detail: '已复制到剪贴板（' + argument.length + ' 字）' });
        }
        if (act === '截图') {
            const { ipcRenderer } = require('electron');
            const b64 = await ipcRenderer.invoke('take-screenshot');
            if (!b64) return JSON.stringify({ ok: false, error: '截图失败（主进程没返回图）' });
            const path = require('path'), fs = require('fs'), os = require('os');
            const out = path.join(os.homedir(), 'Desktop', '截图-' + Date.now() + '.jpg');
            fs.writeFileSync(out, Buffer.from(String(b64), 'base64'));
            return JSON.stringify({ ok: true, detail: '已截图存到桌面', path: out, bytes: String(b64).length });
        }
        return null;
    }

    /** 8103 直控口 POST（皮套三件套用；短超时——演出都是毫秒级开始） */
    _post8103(route, body, timeoutMs) {
        return new Promise((resolve) => {
            try {
                const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
                const req = http.request({
                    host: '127.0.0.1', port: this._port, path: route, method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
                    timeout: timeoutMs || 6000,
                }, (res) => {
                    let s = '';
                    res.on('data', (c) => { s += c; });
                    res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve({ ok: false, error: s.slice(0, 200) }); } });
                });
                req.on('error', (e) => resolve({ ok: false, error: '桌宠没在运行: ' + e.message }));
                req.setTimeout(timeoutMs || 6000, () => { try { req.destroy(); } catch (e) { try { __silentAudit.audit('index.js:241', e); } catch (e2) {} } resolve({ ok: false, error: 'timeout' }); });
                req.write(data); req.end();
            } catch (e) { resolve({ ok: false, error: e.message }); }
        });
    }

    async _start({ task, cwd, wait, workspace, verify }) {
        const text = String(task || '').trim();
        if (text.length < 4) throw new Error('任务描述太短了，说清楚要我干什么');
        // P1（2026-11-23）：插件只透传 verify/workspace，**不执行**任何命令；
        // workspace 只能是别名（配置键），路径形状当场拒绝 —— 任意 cwd 从入口就堵死。
        const wantVerify = String(verify == null ? '' : verify).trim().slice(0, 2000);
        const wantWorkspace = String(workspace == null ? '' : workspace).trim();
        if (wantVerify && !this._verifyDefaultOn) {
            return JSON.stringify({
                ok: false, error: '验收能力已关闭（plugin_config.verify_default_on=false）',
                use: '让用户把 dispatch 插件的 verify_default_on 打开，或不要传 verify',
            });
        }
        if (wantWorkspace && (/[\\/]/.test(wantWorkspace) || /^[A-Za-z]:/.test(wantWorkspace))) {
            return JSON.stringify({
                ok: false, error: 'workspace 只接受别名，不接受路径（收到「' + wantWorkspace.slice(0, 80) + '」）',
                use: '用 config.json 的 dispatch.workspaces 里配置的键，例如 pet；要加目录让用户改配置',
            });
        }
        // 2026-11-13：GUI 类任务在这里**直接拒收**（不再靠描述劝说模型）。
        // 实测代价：不拦的话「打开 PCL」会被编码型 agent 开完又清理掉，还多派两次。
        const plan = classifyTask(text);
        if (plan.kind === 'gui') {
            const tip = plan.action === 'launch_app'
                ? 'hand_action({"action":"打开应用","argument":"' + plan.target + '"})，或 app({"action":"launch","name":"' + plan.target + '"})'
                : plan.action === 'close'
                    ? 'act({"action":"key","target":"alt+f4","window":"' + plan.target + '"}）让它自己关，或用 act 的 click（target 写「文字:关闭」）点关闭按钮'
                    : 'act 的 key / click / type / read，或 see 看界面';
            // 顺手把「现在到底在不在跑」查清楚告诉它 —— 省得重复开、也省得它以为开了
            const state = plan.target ? probeAppSync(this.context, plan.target) : null;
            this.context.log('info', '[dispatch] 拒收 GUI 任务：' + text.slice(0, 40) + ' → 建议 ' + tip
                + (state && state.known ? '（当前' + (state.running ? '已在运行' : '没在运行') + '）' : ''));
            return JSON.stringify({
                ok: false,
                error: '这次没派：这是 GUI 操作，不该交给后台执行器。',
                why: '后台执行器是编码型 agent，习惯「做完就清理战场」，会把它自己启动的程序一并关掉 —— 实测用派活打开 PCL，PCL 打开后立刻被关（三条任务全 done 但程序没留住）。',
                use: tip,
                currentState: state,
                // 顺手把「这个坑以前踩过」一并告诉它（2026-11-14 接线）：例如 PCL 有两份、
                // D:/mc/pcl.exe 有单实例锁会自己退 —— 这些知识不该只活在我 grep 日志的记忆里。
                knownIssues: (() => {
                    try {
                        if (!plan.target) return undefined;
                        const list = require('./skill-library.js').getPitfalls(plan.target);
                        if (!list.length) return undefined;
                        return list.map((x) => x.key + '：' + x.note + '（踩过 ' + x.count + ' 次）');
                    } catch (e) { return undefined; }
                })(),
            });
        }
        this._pruneTasks();   // 先清旧的已结束任务，别让 Map 无界增长
        if (this._running() >= this._maxConcurrent) {
            return JSON.stringify({ ok: false, error: '已经有 ' + this._running() + ' 个任务在跑，等它们完事再派新的' });
        }
        // ── 自愈刹车（2026-11-13）───────────────────────────────────────────
        // 她发现「任务回报完成但世界不对」时会自动再派一次去修 —— 这个反应是对的
        // （实测 task3 就是她自己发现 PCL 被关后补派的）。但**没有上限**：同一件事
        // 能一直派下去，用户看到的就是「反复的工作」。这里按「任务意图」去重：
        // 10 分钟内同一意图最多派 2 次，第 3 次直接拒，让她停下来把情况告诉用户。
        const intentKey = text.replace(/[\s，。,.！!？?；;：:、…—\-]/g, '').slice(0, 40).toLowerCase();
        const nowMs = Date.now();
        this._recentSends = (this._recentSends || []).filter((r) => nowMs - r.at < 10 * 60 * 1000);
        const sameIntent = this._recentSends.filter((r) => r.key === intentKey);
        if (sameIntent.length >= 2) {
            this.context.log('warn', '[dispatch] 自愈刹车：同一意图已派 ' + sameIntent.length + ' 次，拒绝 ' + text.slice(0, 40));
            return JSON.stringify({
                ok: false,
                error: '同一件事 10 分钟内已经派过 ' + sameIntent.length + ' 次了，先停一下。',
                why: '反复派同一个任务说明前几次都没真正解决 —— 再派一次大概率还是同样的结果，只会让你看到「她一直在忙」。',
                history: sameIntent.map((r) => ({ task: r.text, at: new Date(r.at).toLocaleTimeString('zh-CN') })),
                use: '别再派第三次：把上一次为什么没成告诉用户，或者换做法（GUI 操作改用 hand_action / act 直接做）。',
            });
        }
        this._recentSends.push({ key: intentKey, at: nowMs, text: text.slice(0, 80) });
        const id = 'task' + (++this._seq) + '-' + Date.now().toString(36);
        // P0：taskId 直接用作账本主键；requestId 24h 内唯一（同一次派活不产生第二次执行）。
        const requestId = 'req-' + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
        const row = {
            id, requestId, task: text.slice(0, 200), state: 'running',
            outcome: null, stateReason: null, attempted: false,
            workspace: wantWorkspace || null, verifyCommand: wantVerify || null,
            startedAt: Date.now(), text: '', error: '',
        };
        // 认知内核入口（2026-11-20）：派活自动建 goal；mind-kernel 未启用时静默降级。
        // 只走 global 钩子，不新增工具、不改工具 schema。
        row.goalId = this._createGoalForTask(row);
        this._tasks.set(id, row);
        this.context.log('info', '[dispatch] 派出 ' + id + ': ' + text.slice(0, 60));
        if (wait === true) {
            // 2026-11-14 五十三轮（审计）：schema 里声明了 `wait`，但 _start 从来没读过 ——
            // 模型以为会等，拿到的是「已派出」，然后白跑一轮 check_dispatch。
            // 现在真等，但**有上限**（默认 120s）：后台任务最长能跑 10 分钟，
            // 一个工具调用卡 10 分钟会把上游 LLM 请求拖到超时。
            const capMs = Math.min(120000, Number(this._waitCapMs) || 120000);
            const raced = await Promise.race([
                this._run(id, text, { workspace: wantWorkspace, verify: wantVerify }),
                new Promise((r) => { const t = setTimeout(() => r('__timeout__'), capMs); if (t.unref) t.unref(); }),
            ]);
            if (raced === '__timeout__') {
                return JSON.stringify({
                    ok: true, id, state: 'running',
                    note: '等了 ' + Math.round(capMs / 1000) + ' 秒还没跑完，它还在后台跑；用 check_dispatch 查，跑完我会主动说',
                });
            }
            const done = this._tasks.get(id) || row;
            return JSON.stringify({
                ok: done.state === 'done', id, state: done.state,
                outcome: done.outcome == null ? null : done.outcome,
                stateReason: done.stateReason || null,
                verify: done.verify || null,
                partialWrites: Array.isArray(done.partialWrites) ? done.partialWrites : undefined,
                text: String(done.text || '').slice(0, 2000),
                error: String(done.error || '').slice(0, 400),
                tookMs: done.tookMs || (Date.now() - done.startedAt),
            });
        }
        this._run(id, text, { workspace: wantWorkspace, verify: wantVerify }).catch(() => {});
        return JSON.stringify({ ok: true, id, state: 'running', note: '已经派出去了，在后台跑。你可以继续聊，跑完我会告诉你。' });
    }

    // ── 续聊（followup · 2026-11-23）────────────────────────────────────────
    // 只透传：插件不做会话拼接、不跑 verify —— 服务端 runner 用 --session-id 复用父会话，
    // 失配时由服务端回退「新会话 + 父任务摘要」。这里沿用现有并发闸/自愈刹车/账本口径。
    async _followup({ taskId, task }) {
        const parentId = String(taskId || '').trim();
        const text = String(task || '').trim();
        if (!parentId) {
            return JSON.stringify({ ok: false, error: '要接着哪个任务？把原任务 id 给我（check_dispatch 能看到）' });
        }
        if (text.length < 4) throw new Error('这次要做什么？说清楚一点（太短了）');
        if (!this._ledgerV2Enabled()) {
            return JSON.stringify({ ok: false, id: parentId, error: '续聊不可用：dispatch.ledger_v2=false（没有账本/会话 id）' });
        }
        // 预检：父任务必须存在、已终态、且账本里有 sessionId。失败在派发前就说清楚。
        const pre = await this._ledgerGet('/dispatch/tasks?id=' + encodeURIComponent(parentId));
        if (pre.status === 404) {
            return JSON.stringify({ ok: false, id: parentId, error: '没有这个任务（账本里查不到）' });
        }
        if (!(pre.json && pre.json.ok && pre.json.task)) {
            return JSON.stringify({
                ok: false, id: parentId,
                error: '账本读取失败：' + (pre.status ? ('HTTP ' + pre.status + ' ' + String(pre.text || '').slice(0, 120)) : String(pre.text || '8103 不在线')),
            });
        }
        const parent = pre.json.task;
        if (!['done', 'failed', 'cancelled'].includes(String(parent.state))) {
            return JSON.stringify({
                ok: false, id: parentId, state: parent.state || null,
                error: '父任务还没结束（state=' + String(parent.state || '?') + '），等它完事再续聊',
            });
        }
        if (!parent.sessionId) {
            return JSON.stringify({
                ok: false, id: parentId, state: parent.state,
                error: '父任务没有可复用的会话 id（启动失败/后端没回传 session）',
                use: '重新派一个新任务；下次任务正常结束后再续聊',
            });
        }
        this._pruneTasks();
        if (this._running() >= this._maxConcurrent) {
            return JSON.stringify({ ok: false, error: '已经有 ' + this._running() + ' 个任务在跑，等它们完事再续聊' });
        }
        // 刹车沿用现有口径：同一父任务 10 分钟内最多续聊 2 次（按 parentId 计，不占用新任务意图名额）。
        const nowMs = Date.now();
        this._recentFollowups = (this._recentFollowups || []).filter((r) => nowMs - r.at < 10 * 60 * 1000);
        const sameParent = this._recentFollowups.filter((r) => r.key === parentId);
        if (sameParent.length >= 2) {
            this.context.log('warn', '[dispatch] 续聊刹车：' + parentId + ' 10 分钟内已续 ' + sameParent.length + ' 次');
            return JSON.stringify({
                ok: false, id: parentId,
                error: '同一个任务 10 分钟内已经续聊过 ' + sameParent.length + ' 次了，先停一下。',
                history: sameParent.map((r) => ({ task: r.text, at: new Date(r.at).toLocaleTimeString('zh-CN') })),
                use: '把上一次续聊为什么没成告诉用户，或者直接派一个新任务。',
            });
        }
        this._recentFollowups.push({ key: parentId, at: nowMs, text: text.slice(0, 80) });
        // 预先分配子任务 id 并作为 newTaskId 透传：这样「派完立刻就能 check_dispatch」，
        // 不用等 HTTP 响应才知道真实 id。服务端没收到 newTaskId 时仍会自己生成。
        const childId = 'task' + (++this._seq) + '-' + Date.now().toString(36);
        const row = {
            id: childId, state: 'running', outcome: null,
            parentId, followupParentId: parentId, task: text.slice(0, 200),
            attempted: false, startedAt: nowMs, text: '', error: '',
        };
        // 目标在受理时就建（与 _start 一致），完成时 _finishGoalForTask 收尾。
        row.goalId = this._createGoalForTask(row);
        this._tasks.set(childId, row);
        this.context.log('info', '[dispatch] 续聊 ' + parentId + ' → ' + childId + ': ' + text.slice(0, 60));
        this._runFollowup(childId, parentId, text).catch(() => {});
        return JSON.stringify({
            ok: true, id: childId, state: 'running', parentId,
            note: '已经接着原会话派出去了，在后台跑；跑完我会告诉你（check_dispatch 用这个 id 可查）',
        });
    }

    /** 续聊 HTTP 请求（异步；子任务 id 由插件预分配并作为 newTaskId 透传）。 */
    _runFollowup(childId, parentId, text) {
        return new Promise((resolve) => {
            let settled = false;
            let timedOut = false;
            const done = () => { if (settled) return; settled = true; resolve(); };
            const markPendingUnknown = (reason, why) => {
                const row = this._tasks.get(childId);
                if (!row) return;
                row.state = 'unknown';
                row.outcome = null;
                row.stateReason = reason;
                row.attempted = true;
                row.outcomeWhy = why;
                row.error = row.error || why;
            };
            const body = Buffer.from(JSON.stringify({
                taskId: parentId, task: text, newTaskId: childId, timeoutMs: this._timeoutMs,
            }), 'utf8');
            const req = http.request({
                host: '127.0.0.1', port: this._port, path: '/dispatch/followup', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
            }, (res) => {
                let s = '';
                res.on('data', (c) => { s += c; });
                res.on('end', () => {
                    let data = null;
                    try { data = JSON.parse(s); } catch (e) { data = { ok: false, error: s.slice(0, 300) }; }
                    // 子任务 id 通常就是预分配的 childId（服务端尊重 newTaskId）；万一没尊重也以服务端为准。
                    let realId = String((data && data.taskId) || childId);
                    const prev = this._tasks.get(childId) || {};
                    const row = Object.assign({}, prev, {
                        id: realId,
                        state: (data && data.state) || 'unknown',
                        outcome: data && data.outcome !== undefined ? data.outcome : null,
                        stateReason: (data && data.stateReason) || null,
                        attempted: !!(data && data.attempted),
                        parentId, followupParentId: parentId,
                        sessionReused: !!(data && data.sessionReused),
                        sessionMismatch: !!(data && data.sessionMismatch),
                        task: text.slice(0, 200), startedAt: prev.startedAt || Date.now(),
                        tookMs: (data && data.tookMs) || null,
                        text: String((data && (data.text || data.finalText)) || '').slice(0, 4000),
                        error: String((data && data.error) || '').slice(0, 600),
                        verify: (data && data.verify) || null,
                        partialWrites: data && Array.isArray(data.partialWrites) ? data.partialWrites.slice(0, 200) : undefined,
                    });
                    if (data && data.state === 'running') {
                        // 服务端返回「已派出」但没等结果（当前实现不会）——按 running 记，账本是真源。
                        row.state = 'running';
                    }
                    if (data && data.ok === false && data.attempted === false && data.error) {
                        row.state = 'failed';
                        row.outcome = 'failed';
                        row.stateReason = String(data.error);
                    }
                    row.goalId = row.goalId || this._createGoalForTask(row);
                    this._tasks.set(realId, row);
                    if (realId !== childId) this._tasks.delete(childId);
                    this._finishGoalForTask(row);
                    try {
                        const neutral = row.state === 'unknown' || row.state === 'cancelled';
                        require('./skill-library.js').recordHistory({
                            action: 'dispatch',
                            arg: ('续聊:' + text).slice(0, 120),
                            ok: neutral ? null : (row.outcome !== 'failed'),
                            verified: neutral ? null : (taskLedger.HISTORY_VERIFIED[row.outcome || 'done_unproven'] ?? null),
                            effect: '续聊·' + row.state,
                            taskId: realId,
                            goalId: row.goalId || null,
                            via: 'dsh',
                            costMs: row.tookMs || 0,
                        });
                    } catch (e) { /* 历史写失败不影响续聊 */ }
                    this.context.log('info', '[dispatch] 续聊完成 ' + realId + ' → ' + row.state
                        + (row.sessionMismatch ? '（没接上原会话）' : row.sessionReused ? '（复用原会话）' : ''));
                    this._receipt(realId).catch(() => {});
                    done();
                });
                res.on('aborted', () => {
                    if (settled) return;
                    markPendingUnknown('disconnect', '响应中断，结果未知');
                    this._receipt(childId).catch(() => {});
                    done();
                });
                res.on('error', (e) => {
                    if (settled) return;
                    markPendingUnknown('disconnect', '响应错误，结果未知：' + ((e && e.message) || e));
                    this._receipt(childId).catch(() => {});
                    done();
                });
            });
            req.on('error', (e) => {
                if (settled) return;
                markPendingUnknown('disconnect', '连接中断，结果未知：' + e.message);
                this._receipt(childId).catch(() => {});
                done();
            });
            req.on('close', () => {
                if (settled) return;
                markPendingUnknown(timedOut ? 'timeout' : 'disconnect', timedOut ? '等待响应超时，结果未知' : '连接中断（未收到完整响应），结果未知');
                this._receipt(childId).catch(() => {});
                done();
            });
            req.setTimeout(this._timeoutMs + 5000, () => {
                timedOut = true;
                try { req.destroy(); } catch (e) { /* 已断 */ }
            });
            req.write(body); req.end();
        });
    }

    // ── 认知内核桥（2026-11-20）───────────────────────────────────────────
    // mind-kernel 是宿主插件，启用时在 globalThis 挂两个函数：
    //   __mindKernelAddGoal({title,doneWhen,kind}) -> goalId|null
    //   __mindKernelFinishGoal(goalId,{ok,error,wallMs,steps}) -> bool
    // 这里只做可选桥接：任何异常都不能影响派活本身。
    _createGoalForTask(row) {
        try {
            const fn = globalThis.__mindKernelAddGoal;
            if (typeof fn !== 'function') return null;
            const gid = fn({
                title: String((row && row.task) || '后台任务'),
                doneWhen: '执行器返回 ok 且外部验证通过',
                kind: 'dsh',
                source: 'dispatch',
                // 2026-11-21：给 goal 一个过期点（20 分钟），让 arbiter 的「过期→abandon」可达。
                expiresAt: Date.now() + 20 * 60 * 1000,
            }) || null;
            // 2026-11-21：goal 建好后异步生成多步计划（不 await，失败不影响派活）。
            if (gid) {
                try {
                    const pf = globalThis.__mindKernelPlan;
                    if (typeof pf === 'function') {
                        const p = pf(gid);
                        if (p && typeof p.catch === 'function') p.catch(() => {});
                    }
                } catch (e) { /* 计划生成失败退回单步 plan */ }
            }
            return gid;
        } catch (e) {
            try { __silentAudit.audit('dispatch/index.js:_createGoalForTask', e); } catch (e2) { /* 审计自身失败不阻塞 */ }
            return null;
        }
    }

    _finishGoalForTask(row) {
        try {
            const fn = globalThis.__mindKernelFinishGoal;
            if (typeof fn !== 'function' || !row || !row.goalId) return;
            const tools = Array.isArray(row.tools) ? row.tools : [];
            // B1（2026-11-21）：把三态交给目标账本。缺 outcome 的旧任务保守记 done_unproven
            // —— 「没证据」比「假证实」安全（研讨：自报 done 但零 verified 不能算 verified）。
            // B6（2026-11-23）：unknown/cancelled 透传成同名 outcome（内核会转 paused）。
            const neutral = row.state === 'unknown' || row.state === 'cancelled';
            const outcome = neutral
                ? row.state
                : (row.outcome || (row.state === 'done' ? 'done_unproven' : 'failed'));
            fn(row.goalId, {
                // B6（2026-11-23）：unknown/cancelled 不是失败。传 outcome=state 让内核
                // 把目标转 paused（冻结计划、可再判），而不是留在 active 等 20 分钟过期。
                ok: !neutral && outcome !== 'failed',
                outcome,
                state: neutral ? row.state : undefined,
                error: row.error || row.outcomeWhy || '',
                wallMs: row.tookMs || (Date.now() - (row.startedAt || Date.now())),
                // 2026-11-21：真实工具数（不再恒 1），预算才会真的逼近 maxSteps。
                steps: Math.max(1, tools.length),
            });
            // 失败回执 → 记一次熔断（同意图 10 分钟 3 次由 arbiter 发 reject）。
            // 只记真 failed：用户主动叫停/结果未知不能算「反复失败」，否则会误触发刹车。
            if (row.state === 'failed') {
                const rf = globalThis.__mindKernelRecordFailure;
                if (typeof rf === 'function') {
                    rf({ key: 'dispatch|' + String(row.task || '').slice(0, 40), goalId: row.goalId });
                }
            }
        } catch (e) {
            try { __silentAudit.audit('dispatch/index.js:_finishGoalForTask', e); } catch (e2) { /* 同上 */ }
        }
    }

    _run(id, task, opts) {
        // P1（2026-11-23）：opts 只带 { workspace, verify }（别名 / 一条验收命令）。
        // 插件不执行 verify；只把参数透传给 8103，由 runner + verify 在服务端完成。
        const runOpts = (opts && typeof opts === 'object') ? opts : {};
        // P0（2026-11-23）：账本启用时，终态以 8103 返回的 state/outcome 为准；
        // 断线/超时/半截响应一律 unknown（attempted=true），**不再说 failed** ——
        // 因为 failed 会被当成「没做成、可以再派」，而真实情况可能是它还在写盘。
        // ledger_v2=false 时行为保持旧版（close/error → failed）。
        const ledgerV2 = this._ledgerV2Enabled();
        return new Promise((resolve) => {
            // 2026-11-22 审计：response 被掐断（服务端半截响应 / 超时 destroy 在响应已开始之后）
            //   时，ClientRequest 只发 'close'，不发 'error'，res 也不发 'end' —— 原实现没有
            //   任何收口 → Promise 永不 resolve：账本行永远 running、goal 永不收尾、_tasks 只增
            //   不减（_pruneTasks 只删 done/failed）。这里补一条 close 兜底，并用 settled 防重复。
            let settled = false;
            let timedOut = false;
            const rowRef = this._tasks.get(id);
            const payload = {
                task, timeoutMs: this._timeoutMs,
                taskId: id,
                requestId: (rowRef && rowRef.requestId) || null,
                origin: 'plugin',
                workspace: runOpts.workspace || null,
                verify: runOpts.verify || null,
                verifyTimeoutMs: this._verifyTimeoutMs,
                rework: this._reworkMax,
            };
            const body = Buffer.from(JSON.stringify(payload), 'utf8');
            const req = http.request({
                host: '127.0.0.1', port: this._port, path: '/dispatch', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
            }, (res) => {
                let s = '';
                res.on('data', (c) => { s += c; });
                res.on('end', () => {
                    settled = true;
                    let data = null;
                    try { data = JSON.parse(s); } catch (e) { data = { ok: false, error: s.slice(0, 300) }; }
                    const row = this._tasks.get(id);
                    if (row) {
                        row.attempted = data && data.attempted === true;
                        row.tookMs = (data && data.tookMs) || (Date.now() - row.startedAt);
                        row.text = String((data && (data.text || data.finalText)) || '').slice(0, 4000);
                        row.error = String((data && data.error) || '').slice(0, 600);
                        row.tools = Array.isArray(data && data.tools) ? data.tools.slice(0, 50) : [];
                        if (data && data.verify) row.verify = data.verify;
                        if (data && Array.isArray(data.partialWrites)) row.partialWrites = data.partialWrites.slice(0, 200);
                        if (ledgerV2 && data && (data.state === 'cancelled')) {
                            // P1：取消是状态，不是失败等级 —— outcome=null，回执固定话术。
                            row.state = 'cancelled';
                            row.outcome = null;
                            row.stateReason = 'cancelled';
                            row.cancelMessage = data.message || '已停止；已经写下的文件不会回滚';
                        } else if (ledgerV2 && data && data.ok === false && data.attempted === false && data.error) {
                            // 服务端在「建立执行之前」拒绝（workspace 未知/开关关闭/账本关闭）：
                            // 什么都没跑 → failed + attempted=false，不能冒充 unknown（会让人以为它在跑）。
                            row.state = 'failed';
                            row.outcome = 'failed';
                            row.stateReason = data.error;
                            row.attempted = false;
                            row.outcomeWhy = data.detail || data.error;
                            row.error = String(data.detail || data.error);
                        } else if (ledgerV2 && data && (data.state === 'unknown')) {
                            // 服务端已判 unknown（超时/重启/异常）：outcome 必须为 null
                            row.state = 'unknown';
                            row.outcome = null;
                            row.stateReason = data.stateReason || 'disconnect';
                        } else if (ledgerV2 && data && (data.state === 'done' || data.state === 'failed')) {
                            row.state = data.state;
                            row.outcome = data.outcome !== undefined ? data.outcome : (data.state === 'failed' ? 'failed' : 'done_unproven');
                            row.stateReason = data.stateReason || null;
                            row.outcomeWhy = '账本结案：' + String(row.outcome);
                        } else if (ledgerV2) {
                            // 账本启用但服务端没给可识别的终态（异常响应/半截 JSON/配置不一致）：
                            // 按 unknown 处理 —— 「不知道」比「failed（可再派）」安全。
                            row.state = 'unknown';
                            row.outcome = null;
                            row.stateReason = 'disconnect';
                            row.attempted = true;
                            row.outcomeWhy = '服务端响应没有可识别的终态，结果未知';
                            row.error = row.error || row.outcomeWhy;
                        } else {
                            // 旧路径（ledger_v2=false）：沿用 B1 三态自算
                            const cls = taskLedger.classifyOutcome({
                                ok: !!(data && data.ok),
                                verified: !!(data && data.verified === true),
                                evidence: data && (data.evidence || data.evidenceText),
                                task,
                            });
                            row.outcome = cls.outcome;
                            row.outcomeWhy = cls.why;
                            row.state = cls.outcome === 'failed' ? 'failed' : 'done';
                        }
                    }
                    this.context.log('info', '[dispatch] 完成 ' + id + ' → ' + (row && row.state));
                    // B6（2026-11-23）：unknown/cancelled 也要通知内核（内核会转 paused 并冻结计划），
                    // 否则目标会留在 active 等 20 分钟过期。桥里已区分「未知」与「失败」。
                    this._finishGoalForTask(row);
                    // 执行档案（2026-11-13）：原来只有 game_control / hand_action 的动作进
                    // dispatch-history.jsonl，**派活完全不记** —— 用户问「你刚才派了什么」她
                    // 答不上来，只能去 grep 日志（这次还原三次派活就是这么翻出来的）。
                    try {
                        const unknown = !!(row && row.state === 'unknown');
                        const cancelled = !!(row && row.state === 'cancelled');
                        require('./skill-library.js').recordHistory({
                            action: 'dispatch',
                            arg: String(task || '').slice(0, 120),
                            // unknown/cancelled：既不是成功也不是失败；写 null，别算进成功率
                            ok: (unknown || cancelled) ? null : (row && row.outcome) !== 'failed',
                            verified: (unknown || cancelled) ? null : (taskLedger.HISTORY_VERIFIED[(row && row.outcome) || 'done_unproven'] ?? null),
                            effect: '后台任务·' + String(unknown ? 'unknown' : cancelled ? 'cancelled' : ((row && row.outcome) || '?')),
                            // B1：账本要能 join 回任务/目标/执行器与成本（研讨验收要求）
                            taskId: id,
                            goalId: (row && row.goalId) || null,
                            via: 'dsh',
                            costMs: (row && row.tookMs) || 0,
                        });
                    } catch (e) { /* 历史写失败不能影响派活本身 */ }
                    this._receipt(id).catch(() => {});
                    resolve();
                });
            });
            req.on('error', (e) => {
                if (settled) return;   // end/close 已收口，别重复记一次结案
                settled = true;
                const row = this._tasks.get(id);
                if (row) {
                    if (ledgerV2) {
                        // 连不上/被掐：任务可能已经派出去了 → unknown，不可重派
                        row.state = 'unknown';
                        row.outcome = null;
                        row.stateReason = 'disconnect';
                        row.attempted = true;
                        row.outcomeWhy = '连接中断，结果未知：' + e.message;
                        row.error = row.error || ('连接中断，结果未知：' + e.message);
                    } else {
                        row.state = 'failed';
                        row.outcome = 'failed';
                        row.outcomeWhy = '执行器连接失败：' + e.message;
                        row.error = e.message;
                    }
                }
                if (!(row && row.state === 'unknown')) this._finishGoalForTask(row);
                this._receipt(id).catch(() => {});
                resolve();
            });
            // 'close' 在 end/error 之后也会发（此时 settled=true，直接忽略）；
            // 只有「没收到完整响应就断了」的路径会真正走到这里。
            req.on('close', () => {
                if (settled) return;
                settled = true;
                const row = this._tasks.get(id);
                if (row) {
                    if (ledgerV2) {
                        row.state = 'unknown';
                        row.outcome = null;
                        row.stateReason = timedOut ? 'timeout' : 'disconnect';
                        row.attempted = true;
                        row.outcomeWhy = timedOut ? '等待响应超时，结果未知' : '连接中断（未收到完整响应），结果未知';
                        row.error = row.error || row.outcomeWhy;
                    } else {
                        row.state = 'failed';
                        row.outcome = 'failed';
                        row.outcomeWhy = '连接中断（未收到完整响应）';
                        row.error = row.error || '连接中断（未收到完整响应）';
                    }
                }
                if (!(row && row.state === 'unknown')) this._finishGoalForTask(row);
                this._receipt(id).catch(() => {});
                try { this.context.log('warn', '[dispatch] 连接中断 ' + id + ' → ' + ((row && row.state) || '?')); } catch (e) { /* 日志失败不能挡住结案 */ }
                resolve();
            });
            req.setTimeout(this._timeoutMs + 5000, () => {
                timedOut = true;
                try { req.destroy(); } catch (e) { try { __silentAudit.audit('index.js:291', e); } catch (e2) {} }
            });
            req.write(body); req.end();
        });
    }

    async _receipt(id) {
        if (!this._autoReceipt) return;
        try { if (global.__petQuiet) return; } catch (e) { try { __silentAudit.audit('index.js:298', e); } catch (e2) {} }   // 省钱模式：不主动回执
        // 后台花费闸：回执同样是一次完整 sendMessage。闸关时这条回执不发（与 quiet
        // 同一语义：主动消息可以不发；任务结果仍能在任务列表/账本里查到）。
        if (!backgroundLLM.ensureCanRun(this.context, { kind: 'dispatch-receipt' }).ok) return;
        const row = this._tasks.get(id);
        if (!row) return;
        let line;
        if (row.state === 'cancelled') {
            // P1：取消不是失败 —— 固定话术必须包含「已写文件不会回滚」，不能让她说成「没做成」。
            const n = Array.isArray(row.partialWrites) ? row.partialWrites.length : 0;
            line = '（后台任务 ' + id + ' 已停止；已经写下的文件不会回滚'
                + (n ? '（改动 ' + n + ' 个文件）' : '') + '。）';
        } else if (row.state === 'unknown') {
            // P0：断线/超时/重启 → 结果未知。**不能说成失败**（失败会被理解为可以再派）。
            const why = row.stateReason === 'timeout'
                ? '它跑太久了，我把等待停掉了'
                : row.stateReason === 'restart'
                    ? '桌宠重启过，任务跑到哪一步不知道'
                    : '我和执行器之间的连接断了';
            line = '（后台任务 ' + id + ' 结果未知：' + why + '。已经派出去过，别重复派同一个任务；'
                + '要确认的话我去看一下实际结果。）';
        } else if (row.outcome === 'done_unproven') {
            // B1：自述成功但没有外部证据 —— 回执必须诚实，不能和「已证实」说成一样。
            // P1：如果 verify 本身 broken/timeout，也要说清「验收没判定」，别混成成功。
            const vv = row.verify && row.verify.verdict;
            const body = row.text ? row.text.slice(0, 600) : '（没给结果）';
            line = '（后台任务 ' + id + ' 回报完成了，但'
                + (vv === 'broken' || vv === 'timeout'
                    ? '验收命令没法正常执行，结果没法判定'
                    : '它只是自己说完成了、没有可验证的证据')
                + '，用时 ' + Math.round((row.tookMs || 0) / 1000) + ' 秒。它说的结果：' + body
                + ' 如果要确认，可以让我去看一下实际结果。）';
        } else if (row.state === 'done' && row.outcome === 'done_verified' && row.verify && row.verify.verdict === 'pass') {
            const body = row.text ? row.text.slice(0, 600) : '（没给结果）';
            line = '（后台任务 ' + id + ' 干完了，验收命令通过，用时 '
                + Math.round((row.tookMs || 0) / 1000) + ' 秒。结果：' + body + '）';
        } else if (row.state === 'done') {
            const body = row.text ? row.text.slice(0, 600) : '（没给结果）';
            line = '（后台任务 ' + id + ' 干完了，用时 ' + Math.round((row.tookMs || 0) / 1000) + ' 秒。结果：' + body + '）';
        } else {
            line = '（后台任务 ' + id + ' 失败了：' + (row.error || '未知原因') + '）';
        }
        // 续聊回执（2026-11-23）：必须说清「是接着哪个任务」；没接上原会话时要如实说，
        // 不能让她以为上下文还在（她可能会据此说「我记得那个项目」）。
        if (row.followupParentId) {
            const core = line.replace(/^（/, '').replace(/）$/, '');
            line = '（续聊·接着任务 ' + row.followupParentId + '；' + core
                + (row.sessionMismatch ? '；没接上原会话，这次用新会话+原任务摘要重跑的' : '')
                + '）';
        }
        try {
            // ⚠ sendMessage → voiceChat.sendToLLM(prompt: string)。
            // 传 [{type:'text',text}] 这种数组会被拼成字符串 "[object Object]"，
            // 也就是说「回执」会变成一句无意义的乱码。必须传纯字符串。
            await this.context.sendMessage(line + '\n用一句话把结果转述给用户，别念 json、别列步骤。');
        } catch (e) { try { __silentAudit.audit('index.js:313', e); } catch (e2) {} }
    }

    /**
     * 取消（P1 · §4.5）：插件不杀进程，只把 id 交给 8103；runner 有句柄才杀。
     * 幂等：服务端已 cancelled 时返回 already=true；重复点不会第二次 taskkill。
     */
    async _cancel({ id }) {
        const tid = String(id || '').trim();
        if (!tid) {
            return JSON.stringify({ ok: false, error: '要取消哪个任务？把 id 给我（check_dispatch 能看到）' });
        }
        if (!this._ledgerV2Enabled()) {
            return JSON.stringify({ ok: false, id: tid, error: '取消不可用：dispatch.ledger_v2=false（没有账本/runner 句柄）' });
        }
        const r = await this._post8103('/dispatch/cancel', { taskId: tid, graceMs: this._cancelGraceMs }, 15000);
        if (r && r.ok) {
            const row = this._tasks.get(tid);
            if (row) {
                row.state = 'cancelled';
                row.outcome = null;
                row.stateReason = 'cancelled';
                row.partialWrites = Array.isArray(r.partialWrites) ? r.partialWrites.slice(0, 200) : [];
            }
            this.context.log('info', '[dispatch] 已取消 ' + tid + '（' + (r.cancelTookMs || 0) + 'ms）');
            return JSON.stringify({
                ok: true, id: tid, state: 'cancelled', outcome: null, stateReason: 'cancelled',
                already: r.already === true,
                cancelTookMs: r.cancelTookMs || 0,
                partialWrites: Array.isArray(r.partialWrites) ? r.partialWrites.slice(0, 200) : [],
                message: r.message || '已停止；已经写下的文件不会回滚',
            });
        }
        return JSON.stringify({
            ok: false, id: tid,
            error: (r && r.error) || '取消失败',
            state: (r && r.state) || null,
            detail: (r && r.detail) || null,
            partialWrites: (r && Array.isArray(r.partialWrites)) ? r.partialWrites.slice(0, 200) : undefined,
        });
    }

    async _check({ id }) {
        // P0（2026-11-23）：真源是 8103 账本（GET /dispatch/tasks，必须 X-Pet-Token）。
        // `_tasks` 只保留兼容（并发计数/回执缓存），不再是答案来源。
        // 账本读不到就如实报错，绝不拿进程内缓存冒充「账本里的状态」。
        if (this._ledgerV2Enabled()) {
            if (id) {
                const tid = String(id).trim();
                const r = await this._ledgerGet('/dispatch/tasks?id=' + encodeURIComponent(tid));
                if (r.json && r.json.ok && r.json.task) {
                    const t = r.json.task;
                    const out = JSON.stringify({
                        ok: true, id: t.taskId, state: t.state,
                        outcome: t.outcome == null ? null : t.outcome,
                        stateReason: t.stateReason || null,
                        attempted: t.attempted === true,
                        result: t.state === 'done' ? String(t.text || '').slice(0, 1500) : '',
                        error: t.error || '',
                        tookMs: t.tookMs || 0,
                        text: String(t.text || '').slice(0, 1200),
                        task: String(t.taskText || '').slice(0, 200),
                        // P1：验收四态 + 文件证据 + 取消的已写文件（详情端点才有）
                        verify: t.verify ? {
                            verdict: t.verify.verdict,
                            exitCode: t.verify.exitCode,
                            rounds: Array.isArray(t.verify.rounds) ? t.verify.rounds.length : 0,
                            output: String(t.verify.output || '').slice(0, 600),
                            why: t.verify.why || '',
                        } : null,
                        evidence: t.evidence ? {
                            changed: t.evidence.changed === true,
                            created: (t.evidence.created || []).length,
                            modified: (t.evidence.modified || []).length,
                            deleted: (t.evidence.deleted || []).length,
                            settleMs: t.evidence.settleMs || 0,
                            unavailableReason: t.evidence.unavailableReason || null,
                        } : null,
                        workspace: t.workspaceAlias || null,
                        // 续聊（2026-11-23）：父任务 / 是否复用原会话 / 是否失配回退
                        parentId: t.parentId || null,
                        sessionId: t.sessionId || null,
                        sessionReused: t.sessionReused === true,
                        sessionMismatch: t.sessionMismatch === true,
                        partialWrites: Array.isArray(t.partialWrites) && t.partialWrites.length ? t.partialWrites : undefined,
                        source: 'ledger',
                    });
                    // 兼容回收（running/unknown 不删：unknown 还要给回执/审计看）
                    if (t.state === 'done' || t.state === 'failed' || t.state === 'cancelled') this._tasks.delete(t.taskId);
                    return out;
                }
                if (r.status === 404) {
                    // 账本没有 ≠ 从没派过：请求可能根本没到 8103。此时唯一证据是本进程缓存，
                    // 明确标注 source=plugin-cache，不冒充账本。
                    const local = this._tasks.get(tid);
                    if (local) {
                        return JSON.stringify({
                            ok: true, id: local.id, state: local.state,
                            outcome: local.outcome == null ? null : local.outcome,
                            stateReason: local.stateReason || null,
                            attempted: local.attempted === true,
                            result: '', error: local.error || '',
                            tookMs: local.tookMs || (Date.now() - local.startedAt),
                            text: String(local.text || '').slice(0, 1200),
                            source: 'plugin-cache',
                            note: '账本里没有这条记录（请求可能没到 8103）；以下来自本进程缓存',
                        });
                    }
                    return JSON.stringify({ ok: false, error: '没有这个任务', id: tid, source: 'ledger' });
                }
                if (r.json && r.json.error === 'ledger_disabled') {
                    return JSON.stringify({ ok: false, error: '账本已关闭（dispatch.ledger_v2=false），任务状态只在内存里', source: 'ledger' });
                }
                return JSON.stringify({
                    ok: false, id: tid, source: 'ledger',
                    error: '账本读取失败：' + (r.status ? ('HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 120)) : String(r.text || '8103 不在线')),
                });
            }
            const r = await this._ledgerGet('/dispatch/tasks?limit=20');
            if (r.json && r.json.ok && Array.isArray(r.json.tasks)) {
                const tasks = r.json.tasks.map((t) => ({
                    id: t.taskId,
                    state: t.state,
                    outcome: t.outcome == null ? null : t.outcome,
                    stateReason: t.stateReason || null,
                    attempted: t.attempted === true,
                    task: String(t.taskPreview || '').slice(0, 120),
                    tookMs: t.tookMs || 0,
                }));
                return JSON.stringify({
                    ok: true,
                    running: tasks.filter((t) => t.state === 'running').length,
                    tasks,
                    source: 'ledger',
                    note: '列表只有 120 字预览；要看正文/结果用 check_dispatch 带 id',
                });
            }
            if (r.json && r.json.error === 'ledger_disabled') {
                return JSON.stringify({ ok: false, error: '账本已关闭（dispatch.ledger_v2=false）', source: 'ledger' });
            }
            return JSON.stringify({
                ok: false, source: 'ledger',
                error: '账本读取失败：' + (r.status ? ('HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 120)) : String(r.text || '8103 不在线')),
            });
        }
        // 旧路径（ledger_v2=false 回滚）：保持 2026-11-22 版本行为。
        if (id) {
            const row = this._tasks.get(String(id));
            if (!row) return JSON.stringify({ ok: false, error: '没有这个任务' });
            // 之前这里只回了 id/state/tookMs，**没有结果文本** —— 等于"查了但查不到内容"。
            // 她自己派完活再查，拿到的是一串状态，自然也就转述不出东西。
            const out = JSON.stringify({ ok: true, id: row.id, state: row.state,
                result: row.state === 'done' ? String(row.text || '').slice(0, 1500) : '',
                error: row.error || '',
                tookMs: row.tookMs || (Date.now() - row.startedAt), text: String(row.text || '').slice(0, 1200) });
            // 查过就回收（running 不删：任务还在写 row）。这样 _tasks 不会只增不减。
            if (row.state === 'done' || row.state === 'failed') this._tasks.delete(String(id));
            return out;
        }
        const rows = [...this._tasks.values()].slice(-8).map((t) => ({ id: t.id, state: t.state,
            result: t.state === 'done' ? String(t.text || '').slice(0, 300) : '',
            task: t.task.slice(0, 40), tookMs: t.tookMs || (Date.now() - t.startedAt) }));
        return JSON.stringify({ ok: true, running: this._running(), tasks: rows });
    }
}

// 测试注入口（只给 _probe/test-bypass-policy.cjs 用；运行时代码从不读它）：
// game 输入闸 / 拒绝计数 / 动作分类，纯函数可断言，不需要真游戏会话。
DispatchPlugin.__testHooks = {
    gameInputGate,
    gameGateStats,
    GAME_INPUT_ACTIONS,
    GAME_READONLY_ACTIONS,
};

// ADR-014：分页是纯函数，挂到类上供 _probe/test-tool-continuation.cjs 直接断言
// （不实例化插件、不碰 UIA/窗口，也不需要 Electron）。
DispatchPlugin.paginateToolResult = paginateToolResult;
DispatchPlugin.ARTIFACT_THRESHOLD_CHARS = ARTIFACT_THRESHOLD_CHARS;
DispatchPlugin.PAGE_DEFAULTS = PAGE_DEFAULTS;
// 第四轮 P2：file read 单页上限（纯函数，测试可直接断言 config → 上限映射）
DispatchPlugin.fileReadPageCap = fileReadPageCap;

module.exports = DispatchPlugin;