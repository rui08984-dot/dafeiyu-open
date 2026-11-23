'use strict';
// turn-context.js —— 轮次上下文（A4，2026-11-21）
//
// 解决的问题：telemetry 里 ASR / LLM / 工具 / TTS 事件各写各的，没有可 join 的轮次 ID。
// 「这一轮她为什么慢、为什么调了这个工具」只能靠时间戳猜；跨阶段统计也只能估。
//
// 约定：
//   · 一轮对话（用户消息 / 主动开口 / 弹幕 / DSH 回复）在**进入 LLM 前** beginTurn()；
//     llm-handler 的 ensureTurn() 是兜底入口 —— 任何走到 LLM 的路径都必然有 turn_id。
//   · 工具执行、TTS 等读 currentTurnId() 挂到 telemetry；没有活动轮次时
//     ensureTurn('direct'/'tool') 造一个 —— 这样「孤儿 tool 事件 = 0」是结构上成立的，
//     而不是靠调用方自觉。
//   · 轮结束时 endTurn() 写一条 cat='turn' 的收尾事件，把「到各阶段的时间偏移」
//     写成数字 metrics（phase_llm_ms / phase_tool_ms ...）。doctor 靠它算 p50/p90。
//
// 为什么不用 AsyncLocalStorage：工具执行跨多个 keep-alive 定时器与插件 Promise，
// ALS 在 Electron 主进程 + 动态 require 的插件里容易丢上下文；单会话单轮模型下
// 「最近一轮」已经够用（同一时刻不会有两条对话轮并行；并行时后开的覆盖前者，
// 宁可少一条精确归因，也不要让上下文凭空消失）。

// 遥测是可选依赖：加载/写盘失败必须吞掉，不能影响对话主链
let _emitTelemetry = null;
try { _emitTelemetry = require('./telemetry.js').emitTelemetry; } catch (e) { _emitTelemetry = null; }

function emit(payload) {
    if (!_emitTelemetry) return;
    try { _emitTelemetry(payload); } catch (e) { /* 遥测失败不影响对话 */ }
}

let seq = 0;
let current = null;   // { id, source, startedAt, phases:[{name, offsetMs}] }
let last = null;      // 最近结束的一轮（供收尾/排障）

function nextId() {
    seq = (seq + 1) % 1000000;
    return 't' + Date.now().toString(36) + '-' + seq.toString(36);
}

/** 开一轮。返回 turnId。 */
function beginTurn(source) {
    const src = String(source || 'chat').slice(0, 24);
    current = { id: nextId(), source: src, startedAt: Date.now(), phases: [] };
    // 轮开始事件：没有它，一个「只有工具、没有输入事件」的轮在 telemetry 里就没有起点
    emit({ cat: 'turn', type: 'turn.begin', title: '一轮开始(' + src + ')', turn_id: current.id, span: 'turn', source: src });
    return current.id;
}

/** 有当前轮就复用，没有就开一个（direct=评测/UI 直调，不是对话轮）。 */
function ensureTurn(source) {
    if (current) return current.id;
    return beginTurn(source || 'direct');
}

function currentTurnId() { return current ? current.id : ''; }
function lastTurnId() { return last ? last.id : ''; }

/**
 * 阶段打点：只记**第一次**到达该阶段的偏移（回答「什么时候到这一步」，
 * 不是「这一步花了多久」）。名字会清洗成字母数字，避免 metrics 键名带怪字符。
 */
function markPhase(name) {
    if (!current) return;
    const n = String(name || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20);
    if (!n) return;
    if (current.phases.some((p) => p.name === n)) return;
    current.phases.push({ name: n, offsetMs: Date.now() - current.startedAt });
}

/** 收轮：写 turn.end 事件（带 total_ms 与各阶段偏移），返回本轮记录。 */
function endTurn(outcome) {
    if (!current) return null;
    const t = current;
    current = null;
    last = t;
    t.totalMs = Date.now() - t.startedAt;
    t.outcome = String(outcome || 'ok').slice(0, 24);
    const metrics = { total_ms: t.totalMs, phases: t.phases.length };
    for (const p of t.phases) metrics['phase_' + p.name + '_ms'] = p.offsetMs;
    emit({
        cat: 'turn',
        type: 'turn.end',
        title: '一轮结束(' + t.source + ')',
        metrics,
        turn_id: t.id,
        span: 'turn',
        source: t.source,
        // D9 场景评测要求「turn.end 有 outcome」：原来只写进内部 t.outcome，
        // 遥测里看不到 —— 事后无法区分正常收轮 / 工具批次 / 用户取消。
        outcome: t.outcome,
    });
    return t;
}

function stats() {
    return {
        current: current ? { id: current.id, source: current.source, startedAt: current.startedAt } : null,
        last: last ? { id: last.id, totalMs: last.totalMs, phases: last.phases.slice(), outcome: last.outcome } : null,
    };
}

module.exports = { beginTurn, ensureTurn, currentTurnId, lastTurnId, markPhase, endTurn, stats };
