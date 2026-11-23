'use strict';
// tool-result.js —— 工具回执的统一判据（A3，2026-11-21）
//
// 为什么需要：工具的返回值形状五花八门 —— JSON 字符串、对象、字符串、数组、null。
// 判「成没成」的地方各写各的：
//   · tool-executor 原来用 `if (toolResult)` —— `{ok:false}` 是真值，**失败被当成功**；
//   · telemetry 的 toolFailed 也用 `!toolResult`，同样是假绿；
//   · 失败但没有 detail/error 的返回，模型不知道该重试还是换方法。
//
// 这里只做**判据与审计**，不改变任何工具的实际返回值（避免破坏 28 个工具的既有契约）：
//   parse(value)     → 解析成对象（字符串先尝试 JSON）
//   isFailure(value) → 是否失败（ok===false 或 error 且无 ok）
//   detailOf(value)  → 失败原因（detail/error/message/reason）
//   audit(name,value)→ 计数 + 返回 {ok, detail, backfilled}；plugin-manager 出口调用
//
// 三个可观测计数（门禁/doctor 可查）：
//   checked        审计过的工具返回数
//   violations     形状违规（既不是对象也不是可解析 JSON 的字符串）
//   backfilled     失败却没有原因（契约违规：失败必须发声）—— 验收要求 0

const MAX_DETAIL = 500;

/** 解析工具返回值。永远返回对象（不会返回 null/字符串）。 */
function parse(value) {
    // 注意：这里**不编造**失败原因 —— null/空串就是「工具没给原因」，
    // 交给 audit 记成 backfilled（验收要求 0，编一句文案会把问题藏起来）。
    if (value === null || value === undefined) return { ok: false };
    if (typeof value === 'string') {
        const s = value.trim();
        if (!s) return { ok: false };
        // 只对看起来像 JSON 的做解析：普通文本（如 see 的 OCR 结果）不该被当 JSON
        if (s[0] === '{' || s[0] === '[') {
            try {
                const j = JSON.parse(s);
                return (j && typeof j === 'object') ? j : { ok: true, value: j };
            } catch (e) {
                return { ok: true, text: s };
            }
        }
        return { ok: true, text: s };
    }
    if (typeof value === 'object') return value;
    return { ok: true, value };
}

/** 是否失败。判据集中在这里，别在调用点各写一套。 */
function isFailure(value) {
    const v = parse(value);
    if (!v || typeof v !== 'object') return false;
    if (v.ok === false) return true;
    // 有 error 但没有 ok：历史工具（如 file）用这种形状
    if (v.ok === undefined && v.error) return true;
    return false;
}

/** 失败原因。**失败时这个字符串必须非空**（A3 的核心契约）。 */
function detailOf(value) {
    const v = parse(value) || {};
    const raw = v.detail || v.error || v.message || v.reason || v.text || '';
    return String(raw).trim().slice(0, MAX_DETAIL);
}

const stats = {
    checked: 0,
    violations: 0,
    backfilled: 0,
    byTool: Object.create(null),
};

/**
 * 审计一次工具返回（plugin-manager / executeToolCalls 出口调用）。
 * @returns {{name:string, ok:boolean, detail:string, failure:boolean, backfilled:boolean}}
 */
function audit(name, value) {
    const tool = String(name || 'unknown').slice(0, 48);
    const failure = isFailure(value);
    const detail = detailOf(value);
    // 形状违规：非对象、非字符串、非数字/布尔 —— 这些值没法判成败
    const kind = value === null ? 'null' : typeof value;
    const violation = kind === 'undefined' || kind === 'function' || kind === 'symbol';
    const backfilled = failure && !detail;

    stats.checked += 1;
    if (violation) stats.violations += 1;
    if (backfilled) stats.backfilled += 1;
    const rec = stats.byTool[tool] || (stats.byTool[tool] = { checked: 0, failures: 0, backfilled: 0 });
    rec.checked += 1;
    if (failure) rec.failures += 1;
    if (backfilled) rec.backfilled += 1;

    return { name: tool, ok: !failure, detail, failure, backfilled };
}

function snapshot() {
    return {
        checked: stats.checked,
        violations: stats.violations,
        backfilled: stats.backfilled,
        byTool: JSON.parse(JSON.stringify(stats.byTool)),
    };
}

function resetStats() {
    stats.checked = 0;
    stats.violations = 0;
    stats.backfilled = 0;
    stats.byTool = Object.create(null);
}

module.exports = { parse, isFailure, detailOf, audit, snapshot, resetStats };
