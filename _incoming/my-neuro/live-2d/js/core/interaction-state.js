'use strict';
// interaction-state.js — 交互状态机 shadow（D8，2026-11-22）
//
// 提案原文：`reduce(state, event)` 与现有布尔并行、**只记 mismatch**；一周 mismatch
// TOP3 修完再切真源。
//
// 这个文件**只做三件事**：
//   ① 纯函数 reduce(state, event)：把「用户说话 / 她说话 / 思考 / 工具 / 拖动 / 回合」
//      归纳成 6 个布尔（talking / thinking / listening / dragging / idle / waitingUser）；
//   ② shadow 接线：订阅**同一个 eventBus**，事件到了只推进自己的影子状态，再跟现有
//      布尔快照（appState.isPlayingTTS / UI 的 aura 类）比对，**只记不一致的键**；
//   ③ 落盘 data/状态机-shadow.jsonl（最多 500 行滚动）+ stats() 出 TOP 键。
//
// 铁律（D8 验收前提）：**任何情况下都不许写回现有状态**。
//   · 不调用 appState 的任何 setter / clearInterrupted
//   · 不 emit 任何事件
//   · 不改 event 载荷、不改 speechCoordinator / speechBudget
//   · 所有监听器与比对都包在 try/catch 里：shadow 自己坏了不能影响主链
//
// 为什么比对要延迟一拍（setImmediate）：
//   eventBus 是同步派发，监听器按注册顺序跑。shadow 在 app.js 里注册得早，如果当场
//   比对，会读到「同一事件的其他监听器还没更新」的旧值 —— 每个事件都假 mismatch。
//   延迟到当前调用栈结束后再读，拿到的才是这一轮事件全部生效后的现有状态。
//   代价：同一 tick 里连续多个事件只比对最后一次，记录的 event 是最后那个（足够定位）。
//
// 现有布尔从哪来（grep 依据）：
//   talking  ← appState.isPlayingTTS() / body.classList 'state-speaking'
//   thinking ← ui-controller 的 aura 类 'state-thinking' / 'state-acting'（LLM 请求 + 工具）
//   listening← ui-controller 的 aura 类 'state-listening'（ASR 开始/停止）
//   dragging ← modelController.isDragging（Live2D）/ window.__pbDragging（皮套，3s 新鲜度）
//   idle     ← 上面四个全 false（由 shadow 自己派生，避免再猜一个来源）
//   waitingUser **没有**独立可观测来源（现有代码里不存在这个布尔）→ 只算不比对，
//              等切真源时再补 UI。统计里不会出现 waitingUser 的 mismatch。
//
// 开关：data/状态机shadow.json → {"enabled": false}（默认开；改文件 5 秒内生效）
// 调试：window.__interactionShadowStats()  →  { total, mismatch, top: [{ key, count }] }
//      window.__interactionStateShadow    →  { reduce, initialState, feed, flush, stats, ... }

const fs = require('fs');
const path = require('path');
const { recordFile } = require('./records-path.js');

const CFG_FILE = '状态机shadow.json';
const LOG_FILE = '状态机-shadow.jsonl';
const MAX_RECORDS = 500;
const CFG_REFRESH_MS = 5000;

const STATE_KEYS = ['talking', 'thinking', 'listening', 'dragging', 'idle', 'waitingUser'];
const ACTIVITY_KEYS = ['talking', 'thinking', 'listening', 'dragging'];
// 只比对**现有代码能独立观测**的键。waitingUser 没有来源，故意不在这里。
const COMPARE_KEYS = ACTIVITY_KEYS.concat(['idle']);

const EVENT_TYPES = new Set([
    'user.speak', 'tts.start', 'tts.end', 'tool.start', 'tool.end',
    'drag.start', 'drag.end', 'turn.begin', 'turn.end',
]);

// ── 纯逻辑 ───────────────────────────────────────────────────────────────

function asBool(v) { return v === true; }

/** 空白状态：没有任何交互。 */
function initialState() {
    return {
        talking: false,
        thinking: false,
        listening: false,
        dragging: false,
        idle: true,
        waitingUser: false,
    };
}

function copyState(state) {
    const s = state && typeof state === 'object' ? state : {};
    return {
        talking: asBool(s.talking),
        thinking: asBool(s.thinking),
        listening: asBool(s.listening),
        dragging: asBool(s.dragging),
        idle: s.idle === undefined ? true : asBool(s.idle),
        waitingUser: asBool(s.waitingUser),
    };
}

/** idle 是派生量，不单独接受外部写入：任何活动都不 idle。 */
function recomputeIdle(s) {
    s.idle = !(s.talking || s.thinking || s.listening || s.dragging);
    return s;
}

/**
 * 纯函数：返回**新状态**，绝不修改入参。
 *
 * 语义约定：
 *   user.speak  用户开口（VAD/ASR 检出人声）→ 倾听，且她若在说就视为已被抢话
 *               （talking=false；真实打断由 260ms 判定接力）
 *   turn.begin  这一轮进入处理 → 停止倾听、开始思考；她若还在说也视为该停了
 *   tts.start   她开始出声 → talking=true，思考结束
 *   tts.end     她说完 → talking=false，思考结束，进入「等用户」窗口
 *   tool.start  工具开始 → thinking=true（工具执行属于思考阶段），清掉等用户
 *   tool.end    工具结束 → thinking **保持 true**（后面还要回 LLM 出话），由 turn.end/tts.start 收
 *   drag.start  开始拖她 → dragging=true，清掉等用户
 *   drag.end    放下 → dragging=false
 *   turn.end    一轮结束（LLM 请求收尾 / 回合取消）→ thinking=false；没在说/听/拖时等用户
 *
 * 为什么 tts.end 也把 thinking 置 false：TTS_START 已经置 false；这里兜住「没走
 * LLM_REQUEST_END 就被打断」的路径（TTS_INTERRUPTED → tts.end）。
 */
function reduce(state, event) {
    const s = copyState(state);
    const type = typeof event === 'string'
        ? event
        : String((event && (event.type || event.event)) || '');

    switch (type) {
        case 'user.speak':
            s.listening = true;
            s.talking = false;
            s.thinking = false;
            s.waitingUser = false;
            break;
        case 'turn.begin':
            s.listening = false;
            s.thinking = true;
            s.talking = false;
            s.waitingUser = false;
            break;
        case 'tts.start':
            s.talking = true;
            s.thinking = false;
            s.waitingUser = false;
            break;
        case 'tts.end':
            s.talking = false;
            s.thinking = false;
            s.waitingUser = !s.listening && !s.dragging;
            break;
        case 'tool.start':
            s.thinking = true;
            s.waitingUser = false;
            break;
        case 'tool.end':
            // 回合通常还没完：工具结果要回给 LLM。保持 thinking，别提前进入 idle。
            s.thinking = true;
            break;
        case 'drag.start':
            s.dragging = true;
            s.waitingUser = false;
            break;
        case 'drag.end':
            s.dragging = false;
            break;
        case 'turn.end':
            s.thinking = false;
            s.waitingUser = !s.talking && !s.listening && !s.dragging;
            break;
        default:
            // 未知事件：状态不变（但 idle 仍按现有布尔重算，防御外部塞了脏状态）
            break;
    }

    return recomputeIdle(s);
}

// ── shadow 运行时 ────────────────────────────────────────────────────────
//
// 刻意不 class：单例即可，且纯逻辑必须能被测试直接 require 调用（不启动监听）。

let _state = initialState();
let _wasEnabled = true;  // 关→开时重置影子状态：关闭期间的旧状态没有参考价值
let _total = 0;          // 本进程喂进来的事件数（开关关闭时不计数）
let _mismatch = 0;       // 本进程写下的 mismatch 行数
let _checks = 0;         // 本进程实际比对次数
let _pending = null;     // { event, state } 同一 tick 合并
let _flushScheduled = false;
let _lastRecord = null;
let _actualProvider = null;

// 落盘缓存：_lines 保存最近 500 行的字符串，滚动时整文件重写（500 行很小）。
let _loaded = false;
let _lines = [];
let _records = [];

function cfgFile() { return recordFile(CFG_FILE); }
function logFile() { return recordFile(LOG_FILE); }

let _cfgCache = { at: 0, enabled: true };

/** 读开关；文件不存在/坏 JSON → 默认开。5 秒缓存，改文件不用重启。 */
function isEnabled() {
    const now = Date.now();
    if (now - _cfgCache.at < CFG_REFRESH_MS) return _cfgCache.enabled;
    _cfgCache.at = now;
    let enabled = true;
    try {
        const raw = fs.readFileSync(cfgFile(), 'utf8');
        const j = JSON.parse(raw);
        enabled = !(j && j.enabled === false);
    } catch (e) {
        enabled = true;   // 没有配置 = 默认开（shadow 本来就是为了收集数据）
    }
    _cfgCache.enabled = enabled;
    return enabled;
}

/** 强制下次读配置（测试/用户改完文件立即生效）。 */
function reloadConfig() {
    _cfgCache = { at: 0, enabled: true };
    return isEnabled();
}

function ensureLoaded() {
    if (_loaded) return;
    _loaded = true;
    try {
        const raw = fs.readFileSync(logFile(), 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        _lines = lines.slice(-MAX_RECORDS);
        _records = _lines.map((l) => {
            try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(Boolean);
        _lastRecord = _records.length ? _records[_records.length - 1] : null;
        // 盘上超过 500 行（手工追加/旧版本遗留）→ 立刻收敛
        if (lines.length > MAX_RECORDS) rewrite();
    } catch (e) {
        _lines = [];
        _records = [];
    }
}

function rewrite() {
    try {
        const file = logFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, _lines.length ? _lines.join('\n') + '\n' : '', 'utf8');
        fs.renameSync(tmp, file);
    } catch (e) { /* 滚动失败不能影响主链；下一行还会尝试 append */ }
}

function appendRecord(rec) {
    ensureLoaded();
    const line = JSON.stringify(rec);
    try {
        const file = logFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line + '\n', 'utf8');
    } catch (e) {
        // 写不进去就只留内存（stats 仍可查）；绝不影响主链
    }
    _lines.push(line);
    _records.push(rec);
    while (_lines.length > MAX_RECORDS) _lines.shift();
    while (_records.length > MAX_RECORDS) _records.shift();
    if (_lines.length >= MAX_RECORDS) rewrite();
    _lastRecord = rec;
}

/**
 * 现有布尔快照（只读）。渲染进程里四个键都能拿到；Node 单测可注入 provider。
 * @returns {{talking?:boolean, thinking?:boolean, listening?:boolean, dragging?:boolean, idle?:boolean}}
 */
function snapshotActual() {
    if (typeof _actualProvider === 'function') {
        try {
            const v = _actualProvider();
            if (v && typeof v === 'object') return v;
        } catch (e) { /* provider 坏了就走默认 */ }
    }

    const out = {};
    try {
        const { appState } = require('./app-state.js');
        if (appState && typeof appState.isPlayingTTS === 'function') {
            out.talking = !!appState.isPlayingTTS();
        }
    } catch (e) { /* 拿不到 appState 就少比一个键 */ }

    try {
        if (typeof document !== 'undefined' && document.body && document.body.classList) {
            const cl = document.body.classList;
            out.listening = cl.contains('state-listening');
            // state-acting 是工具执行阶段（ui-controller 的 TOOL_CALL_START），
            // 在新状态机里同属 thinking；不并进来会让工具期间误报 thinking mismatch。
            out.thinking = cl.contains('state-thinking') || cl.contains('state-acting');
            const speaking = cl.contains('state-speaking');
            if (typeof out.talking === 'boolean') out.talking = out.talking || speaking;
            else out.talking = speaking;
        }
    } catch (e) { /* 非渲染环境 */ }

    try {
        const g = typeof globalThis !== 'undefined' ? globalThis : global;
        const mc = g && g.modelController;
        if (mc && typeof mc.isDragging === 'boolean') {
            out.dragging = !!mc.isDragging;
        } else if (typeof window !== 'undefined' && window) {
            // 皮套模式：__pbDragging 有 3s 新鲜度（拖太快 pointerup 落在窗外没触发 endDrag）
            const fresh = (Date.now() - (Number(window.__pbDraggingAt) || 0)) < 3000;
            out.dragging = !!(window.__pbDragging && fresh);
        }
    } catch (e) { /* 同上 */ }

    if (ACTIVITY_KEYS.every((k) => typeof out[k] === 'boolean')) {
        out.idle = !(out.talking || out.thinking || out.listening || out.dragging);
    }
    return out;
}

/** 立即执行一次比对（测试/调试用；正常由 setImmediate 自动触发）。 */
function flush() {
    if (!_pending) return null;
    const p = _pending;
    _pending = null;
    if (!isEnabled()) {
        _wasEnabled = false;
        return null;
    }

    const actual = snapshotActual();
    const expected = p.state;
    const keys = [];
    const exp = {};
    const act = {};
    for (const k of COMPARE_KEYS) {
        if (typeof actual[k] !== 'boolean') continue;   // 观测不到的键不参与
        const a = actual[k];
        const e = !!expected[k];
        if (a !== e) {
            keys.push(k);
            exp[k] = e;
            act[k] = a;
        }
    }

    _checks += 1;
    if (!keys.length) return null;

    const rec = {
        at: Date.now(),
        event: String(p.event || ''),
        expected: exp,     // 只记不一致的键
        actual: act,
        keys,
    };
    appendRecord(rec);
    _mismatch += 1;
    return rec;
}

function scheduleFlush() {
    if (_flushScheduled) return;
    _flushScheduled = true;
    const run = () => {
        _flushScheduled = false;
        try { flush(); } catch (e) { /* shadow 比对失败绝不影响主链 */ }
    };
    try {
        if (typeof setImmediate === 'function') setImmediate(run);
        else setTimeout(run, 0);
    } catch (e) {
        _flushScheduled = false;
    }
}

/**
 * 喂一个事件给 shadow。**只推进影子状态**，绝不写回任何现有状态。
 * 事件形如 { type: 'tts.start', ... }；多余字段忽略（避免被载荷影响）。
 * @returns {object} 当前影子状态（副本）
 */
function feed(event) {
    try {
        if (!isEnabled()) {
            _wasEnabled = false;
            return copyState(_state);
        }
        if (!_wasEnabled) {
            _state = initialState();
            _wasEnabled = true;
        }
        const type = typeof event === 'string'
            ? event
            : String((event && (event.type || event.event)) || '');
        _state = reduce(_state, { type });
        _total += 1;
        _pending = { event: type, state: copyState(_state) };
        scheduleFlush();
        return copyState(_state);
    } catch (e) {
        // shadow 坏了就静默；返回旧状态
        return copyState(_state);
    }
}

function stats() {
    ensureLoaded();   // 重启后先调 stats 也要能看到盘上的历史 TOP
    const counts = new Map();
    for (const r of _records) {
        const keys = Array.isArray(r && r.keys) ? r.keys : [];
        for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1);
    }
    const top = Array.from(counts.entries())
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => (b.count - a.count) || String(a.key).localeCompare(String(b.key)))
        .slice(0, 10);
    return {
        enabled: isEnabled(),
        total: _total,
        mismatch: _mismatch,
        mismatch_total: _records.length,   // 滚动文件里累计的 mismatch 行数（跨重启保留）
        checks: _checks,
        top,
        file: logFile(),
        last: _lastRecord ? {
            at: _lastRecord.at,
            event: _lastRecord.event,
            keys: Array.isArray(_lastRecord.keys) ? _lastRecord.keys.slice() : [],
        } : null,
    };
}

/** 只给测试：注入现有状态快照（返回部分键即可）。传 null 恢复默认。 */
function setActualProvider(fn) {
    _actualProvider = typeof fn === 'function' ? fn : null;
}

// ── eventBus 接线（只订阅，不 emit）──────────────────────────────────────

let _attached = false;

/**
 * 把现有事件源映射到状态机事件。注意方向是**单向**的：eventBus → shadow。
 * 映射理由：
 *   ASR_START           用户开口（ASR 开录）          → user.speak
 *   ASR_STOP            ASR 停止，等待提交/处理      → turn.begin（宁可早，不要漏）
 *   USER_MESSAGE_RECEIVED / USER_INPUT_START / LLM_REQUEST_START → turn.begin（幂等）
 *   LLM_REQUEST_END     一次 LLM 请求收尾            → turn.end（工具循环会再由 tool.start 拉回）
 *   TTS_START / END / INTERRUPTED                    → tts.start / tts.end / tts.end
 *   TOOL_CALL_START / END                            → tool.start / tool.end
 *   AVATAR_DRAG_START / END（新增的只读通知）         → drag.start / drag.end
 *
 * 没有映射 LLM_RESPONSE：全仓 grep 只有监听、没有 emit（现有 bug，见交付报告），
 * 不能把状态机挂在一个永不发生的事件上。
 */
function attach(bus, Events) {
    if (_attached || !bus || typeof bus.on !== 'function' || !Events) return false;
    _attached = true;
    const bind = (eventName, stateType) => {
        if (!eventName) return;
        try {
            bus.on(eventName, () => { feed({ type: stateType }); });
        } catch (e) { /* 单个订阅失败不影响其它 */ }
    };
    bind(Events.ASR_START, 'user.speak');
    bind(Events.ASR_STOP, 'turn.begin');
    bind(Events.USER_MESSAGE_RECEIVED, 'turn.begin');
    bind(Events.USER_INPUT_START, 'turn.begin');
    bind(Events.LLM_REQUEST_START, 'turn.begin');
    bind(Events.LLM_REQUEST_END, 'turn.end');
    bind(Events.TTS_START, 'tts.start');
    bind(Events.TTS_END, 'tts.end');
    bind(Events.TTS_INTERRUPTED, 'tts.end');
    bind(Events.TOOL_CALL_START, 'tool.start');
    bind(Events.TOOL_CALL_END, 'tool.end');
    bind(Events.AVATAR_DRAG_START, 'drag.start');
    bind(Events.AVATAR_DRAG_END, 'drag.end');
    return true;
}

// 自动接线（app.js require 本文件即生效）。测试环境没有 eventBus 模块时静默跳过。
try {
    const { eventBus } = require('./event-bus.js');
    const { Events } = require('./events.js');
    attach(eventBus, Events);
} catch (e) { /* 非宿主环境 */ }

// 调试/doctor 入口（只读）
try {
    const g = typeof globalThis !== 'undefined' ? globalThis : global;
    if (g) {
        g.__interactionShadowStats = () => stats();
        g.__interactionStateShadow = {
            reduce,
            initialState,
            feed,
            flush,
            stats,
            snapshotActual,
            setActualProvider,
            reloadConfig,
            STATE_KEYS,
            COMPARE_KEYS,
            EVENT_TYPES,
        };
    }
} catch (e) { /* 只读暴露失败不影响主链 */ }

module.exports = {
    initialState,
    reduce,
    feed,
    flush,
    stats,
    snapshotActual,
    setActualProvider,
    reloadConfig,
    attach,
    STATE_KEYS,
    COMPARE_KEYS,
    EVENT_TYPES,
    CFG_FILE,
    LOG_FILE,
    MAX_RECORDS,
};
