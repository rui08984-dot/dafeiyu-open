// js/core/background-llm.js —— 后台任务「能不能花云端钱」的唯一判据（极小、无状态）
//
// 为什么单独一层：
//   2026-11-24 审计 §9.3-① 的直接教训是——后台任务（memory-evolve / user-profile）
//   各自每 5 分钟撞一次 429，谁也不知道别人已经撞过。熔断状态在 llm-health（共享单例），
//   但「这个插件此刻该不该跑」还要叠加用户开关（config.cost.background_llm）。
//   把这层判据收在这里，Agent B 的插件只需 `canRun(this.context)` 一行，不必各自
//   重复读配置 / 猜 reason 字符串。
//
// 约定：
//   · 配置缺省 = 允许（`cost.background_llm !== false`），老配置不用改
//   · 只读，不写状态、不缓存全局变量（daemon 常驻进程里也不会出现第二个真相）
//   · 返回 { ok, reason, retryAt }；reason 直接来自 llm-health（quota_exhausted /
//     day_stop / backoff）或本层的 'disabled'
//
// 2026-11-24 第三轮（P1）：新增**唯一入口** `ensureCanRun(context, {kind})`。
//   教训：`dynamic-persona`（每 3 轮）、`mind-kernel`（计划生成）、`companion-health`、
//   `live-dock` 各自直接调云，谁也没过闸 → 「静默期/预算关」照样花钱。
//   现在所有后台**云端**花费路径都调 ensureCanRun（它内部仍是 canRun，不复制判断逻辑）。
//
// 语义（别混）：
//   · `cost.background_llm=false` → 所有后台云端调用跳过（reason='disabled'）；
//   · 云端 429/退避（llm-health）     → 同样跳过（reason=quota_exhausted/day_stop/backoff）；
//   · `cost.quiet=true` → **只管「不主动开口」**，不是花钱闸：quiet=true 且
//     background_llm=true 时后台任务照常跑（能力页 proactive.quiet 的注记同口径）。
//   · 本地任务不吃这道闸：走 canRunLocal（云端配额暂停不该拦住本地摘要）。
//   · 跳过时调用方必须「不推进游标、不写半截结果」；日志只在状态迁移时打一次。
'use strict';

const { llmHealth } = require('./llm-health.js');

/**
 * 用户是否允许后台调用云端 LLM（config.cost.background_llm，默认 true）。
 * @param {object} context 插件 context（需有 getConfig；单测可传 mock）
 * @returns {boolean}
 */
function isEnabled(context) {
    try {
        const cfg = context && typeof context.getConfig === 'function' ? context.getConfig() : null;
        const cost = cfg && typeof cfg === 'object' ? cfg.cost : null;
        return !(cost && cost.background_llm === false);
    } catch (e) {
        return true;   // 配置读失败按允许处理：不能因为读配置出错把后台记忆整条停掉
    }
}

/**
 * 现在这个后台任务能不能跑：用户开关 + 云端熔断。
 * @param {object} context
 * @param {number} [now] 注入时间便于单测
 * @returns {{ok:boolean, reason:string|null, retryAt:number|null}}
 */
function canRun(context, now) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (!isEnabled(context)) return { ok: false, reason: 'disabled', retryAt: null };
    try {
        const h = llmHealth.canCall(ts);
        if (h && h.ok) return { ok: true, reason: null, retryAt: null };
        return { ok: false, reason: (h && h.reason) || 'paused', retryAt: (h && h.retryAt) || null };
    } catch (e) {
        // 熔断模块自身出问题：宁可放行（后台任务各有解析失败/重试上限兜底），
        // 也不要凭空把所有记忆任务永久停掉。
        return { ok: true, reason: null, retryAt: null };
    }
}

// ── 唯一入口：所有后台云端花费路径都从这里过 ────────────────────────────────
// 日志「状态迁移才喊一次」：进程内按 kind 记住上次结论，从 ok→blocked、blocked→ok、
// 或 blocked 原因变化时才写一行；被连续拦 100 次也只留 1 行（防刷屏）。
const _gateLogState = new Map();   // kind -> 'ok' | 'blocked:<reason>'
const _gateSeen = new Map();       // kind -> 计数（诊断用，方便测试断言「没发请求」前先过闸）

function _logGateTransition(context, kind, verdict) {
    const key = String(kind || 'background');
    const state = verdict.ok ? 'ok' : ('blocked:' + String(verdict.reason || 'paused'));
    const prev = _gateLogState.get(key);
    if (prev === state) return;
    _gateLogState.set(key, state);
    // 首次就是放行：不用喊（每个 kind 启动后都会过一次闸，喊了全是噪声）
    if (prev === undefined && verdict.ok) return;
    let msg;
    if (verdict.ok) {
        msg = `[后台闸] ${key} 恢复：继续后台任务`;
    } else {
        const until = Number(verdict.retryAt) > 0
            ? `，预计 ${new Date(Number(verdict.retryAt)).toLocaleString()} 后可试`
            : '';
        msg = `[后台闸] ${key} 跳过（${verdict.reason || 'paused'}${until}）——不推进游标，恢复后补跑`;
    }
    try {
        if (context && typeof context.log === 'function') context.log('info', msg);
        else require('../api-utils.js').logToTerminal('info', msg);
    } catch (e) { /* 日志失败不影响判定 */ }
}

/**
 * 后台任务「此刻能不能花云端的钱」的**唯一入口**（2026-11-24 第三轮 P1）。
 *
 * 内部只调 canRun（用户开关 + 云端熔断），不复制判断逻辑、不看 cost.quiet。
 * 调用方约定：
 *   ① 返回 ok:false → 不发请求、**不推进游标**、不写半截结果（下次闸放开后补跑）；
 *   ② 不要自己再读 config.cost.background_llm（单一真相源在这里）；
 *   ③ 本地任务（不花云钱）请用 canRunLocal，两套闸互不复用。
 *
 * @param {object} context 插件 context（需有 getConfig；单测可传 mock）
 * @param {{kind?:string}} [options] kind 仅用于日志分桶（如 'dynamic-persona'）
 * @returns {{ok:boolean, reason:string|null, retryAt:number|null, kind:string}}
 */
function ensureCanRun(context, options) {
    const kind = String((options && options.kind) || 'background');
    const verdict = canRun(context);
    const out = { ok: verdict.ok, reason: verdict.reason, retryAt: verdict.retryAt, kind };
    try { _logGateTransition(context, kind, out); } catch (e) { /* 日志不该影响判定 */ }
    try { _gateSeen.set(kind, (_gateSeen.get(kind) || 0) + 1); } catch (e) { /* 同上 */ }
    return out;
}

/**
 * 用户是否允许用本地记忆模型（config.cost.local_memory，默认 true）。
 * 能力页关掉后：本地摘要/抽取直接跳过（reason='local_disabled'），**不回退云端**。
 * @param {object} context
 * @returns {boolean}
 */
function isLocalEnabled(context) {
    try {
        const cfg = context && typeof context.getConfig === 'function' ? context.getConfig() : null;
        const cost = cfg && typeof cfg === 'object' ? cfg.cost : null;
        return !(cost && cost.local_memory === false);
    } catch (e) {
        return true;   // 读配置失败按允许（与 isEnabled 同口径）
    }
}

/**
 * 现在这个**本地**后台任务能不能跑：用户开关（cost.background_llm + cost.local_memory）
 * + 本地 llama.cpp /health。
 *
 * ADR-014 轨道 2：本地任务（片段卡 / MemOS 抽取 / 画像 / 日记）的闸必须独立于云端配额，
 * 否则云端 429 会把本地摘要一起停掉（本地压根不花云端钱）。反过来本地挂了也不该影响
 * 反思等云端任务 —— 两套闸互不复用。
 *
 * @param {object} context
 * @param {number} [now] 注入时间便于单测
 * @returns {Promise<{ok:boolean, reason:string|null, retryAt:number|null}>}
 *          reason: 'disabled'（后台 LLM 总开关关）| 'local_disabled'（能力页关掉本地模型）
 *                  | 'local_down'（本地服务不在/超时）
 */
async function canRunLocal(context, now) {
    if (!isEnabled(context)) return { ok: false, reason: 'disabled', retryAt: null };
    if (!isLocalEnabled(context)) return { ok: false, reason: 'local_disabled', retryAt: null };
    try {
        const localLLM = require('./local-llm.js');
        const ok = await localLLM.isAvailable(now);
        if (ok) return { ok: true, reason: null, retryAt: null };
        return { ok: false, reason: 'local_down', retryAt: null };
    } catch (e) {
        // 本地模块加载/探活异常 = 本地不在（不猜、不放行）：宁可这轮跳过，也不回退云端。
        return { ok: false, reason: 'local_down', retryAt: null };
    }
}

module.exports = {
    isEnabled,
    isLocalEnabled,
    canRun,
    canRunLocal,
    ensureCanRun,
    // 单测后门（生产代码不要用）：清「状态迁移已记」与计数，便于分场景断言日志只喊一次
    __test: {
        resetGateLog() { _gateLogState.clear(); _gateSeen.clear(); },
        gateSeen(kind) { return _gateSeen.get(String(kind)) || 0; },
    },
};
