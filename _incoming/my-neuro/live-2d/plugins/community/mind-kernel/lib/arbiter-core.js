// plugins/community/mind-kernel/lib/arbiter-core.js —— 决策内核（纯函数，无 IO / 无副作用）
//
// 输入：now、goals、world、budgetState、breaker
// 输出：{ actions:[{type, goalId, reason}], notes:[] }
//
// 最重要的边界（ADR-011 / 调研 §3）：
//   tick 只产生「状态迁移建议」，绝不产生执行动作。真正的工具调用永远走 dispatch。
//   所以 ACTION_TYPES 是封闭白名单；调用方应按顺序应用 actions，并可自行落 ledger。
//
// 规则顺序固定（先命中先处理，每个 goal 每 tick 最多一个状态迁移）：
//   ① world.activity 为 gaming/watching → 对 active goal 发 pause（活动门）
//   ② expiresAt 过期 → expire
//   ③ 预算耗尽（used ≥ budget，或外部 budgetState 标记）→ budget_exhausted（转 paused，不转 failed）
//   ④ 无 active 且有 queued → priority 降序、createdAt 升序选 1 个 start
//   ⑤ breaker[key].count ≥ 3 → reject（key 由调用方给：tool + args 指纹）
//   ⑥ 安全点：plan.cursor 在行边界且 hasPendingWrite=false 才允许 start/resume
//
// 额外约定（为了不猜产品决策）：
//   · resume 只对显式带 `resumeRequested === true` 的 paused goal 发出；
//     arbiter 不会自动把用户/活动门暂停的目标拉起来。
//   · hasPendingWrite 可放在 world.hasPendingWrite 或顶层 hasPendingWrite。
//   · plan 读 goal.plan（可选）。没有 plan = 尚未执行过，视作 cursor=0 的安全边界。
'use strict';

const ACTION_TYPES = Object.freeze(['pause', 'expire', 'budget_exhausted', 'start', 'resume', 'reject']);
const BLOCKING_ACTIVITY = Object.freeze(['gaming', 'watching']);
// done_unproven 与 done 一样是终态（B1）：终态 = 不再推进，避免重复执行副作用动作。
const TERMINAL_STATUSES = Object.freeze(['done', 'done_unproven', 'failed', 'abandoned']);
const BREAKER_THRESHOLD = 3;

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function _activity(world) {
    const a = world.activity !== undefined ? world.activity : world.state;
    return typeof a === 'string' ? a : 'unknown';
}

function _exhaustedBy(goal, budgetState) {
    const out = [];
    const b = isObject(goal.budget) ? goal.budget : {};
    const u = isObject(goal.used) ? goal.used : {};
    if (isNum(b.maxSteps) && isNum(u.steps) && u.steps >= b.maxSteps) out.push('steps');
    if (isNum(b.maxLlmCalls) && isNum(u.llmCalls) && u.llmCalls >= b.maxLlmCalls) out.push('llmCalls');
    if (isNum(b.maxWallMs) && isNum(u.wallMs) && u.wallMs >= b.maxWallMs) out.push('wallMs');

    if (isObject(budgetState)) {
        if (budgetState.globalExhausted === true) out.push('global');
        const per = isObject(budgetState.goals) ? budgetState.goals[goal.id] : null;
        if (per === true || (isObject(per) && per.exhausted === true)) out.push('external');
    }
    return out;
}

/** 安全点：cursor 在行边界，且没有在飞的写操作。 */
function _safety(goal, hasPendingWrite) {
    if (hasPendingWrite) return { ok: false, why: 'pending_write' };
    const plan = isObject(goal.plan) ? goal.plan : null;
    if (!plan) return { ok: true };   // 还没计划 = 没执行过，cursor 隐含 0，边界安全
    if (!Array.isArray(plan.lines) || !Number.isInteger(plan.cursor)) {
        return { ok: false, why: 'plan_invalid' };
    }
    if (plan.cursor < 0 || plan.cursor > plan.lines.length) {
        return { ok: false, why: 'cursor_out_of_range' };
    }
    const current = plan.lines[plan.cursor];
    if (isObject(current) && current.status === 'running') {
        return { ok: false, why: 'line_running:' + String(current.id) };
    }
    return { ok: true };
}

function _priority(g) {
    return isNum(g.priority) ? g.priority : 0;
}
function _createdAt(g) {
    return isNum(g.createdAt) ? g.createdAt : 0;
}
/** 调度顺序：priority 降序 → createdAt 升序 → id 升序（稳定、可复现）。 */
function _cmp(a, b) {
    const p = _priority(b) - _priority(a);
    if (p) return p;
    const c = _createdAt(a) - _createdAt(b);
    if (c) return c;
    return String(a.id).localeCompare(String(b.id));
}
/** 遍历顺序：createdAt 升序 → id 升序（与优先级无关，保证动作列表稳定）。 */
function _sortStable(goals) {
    return goals.slice().sort((a, b) => {
        const c = _createdAt(a) - _createdAt(b);
        if (c) return c;
        return String(a.id).localeCompare(String(b.id));
    });
}

/**
 * 一次 tick 的决策。纯函数：不改 goals/world/breaker，不读时钟、不写盘。
 * @param {{now:number, goals?:object[], world?:object, budgetState?:object, breaker?:object, hasPendingWrite?:boolean}} input
 * @returns {{actions:Array<{type:string, goalId:string|null|undefined, reason:string}>, notes:string[]}}
 */
function decide(input) {
    const i = isObject(input) ? input : {};
    if (!isNum(i.now)) {
        throw new TypeError('arbiter.decide: now 必须是有限数字（请显式传入，不要依赖隐式时钟）');
    }
    const now = i.now;
    const goals = Array.isArray(i.goals) ? i.goals.filter(isObject) : [];
    const world = isObject(i.world) ? i.world : {};
    const budgetState = isObject(i.budgetState) ? i.budgetState : {};
    const breaker = isObject(i.breaker) ? i.breaker : {};
    const hasPendingWrite = i.hasPendingWrite === true || world.hasPendingWrite === true;

    const activity = _activity(world);
    const blocking = BLOCKING_ACTIVITY.includes(activity);
    const actions = [];
    const notes = [];
    const sorted = _sortStable(goals);
    const stateHandled = new Set();   // 本 tick 已给出状态迁移建议的 goal

    // ── ① 活动门：gaming / watching 时 active 一律暂停 ──
    if (blocking) {
        let n = 0;
        for (const g of sorted) {
            if (g.status !== 'active') continue;
            actions.push({ type: 'pause', goalId: g.id, reason: 'activity=' + activity });
            stateHandled.add(g.id);
            n += 1;
        }
        if (n) notes.push('activity=' + activity + '：暂停 ' + n + ' 个 active 目标');
    }

    // ── ② 过期 ──
    for (const g of sorted) {
        if (stateHandled.has(g.id)) continue;
        if (TERMINAL_STATUSES.includes(g.status)) continue;
        if (g.expiresAt !== null && isNum(g.expiresAt) && now > g.expiresAt) {
            actions.push({
                type: 'expire',
                goalId: g.id,
                reason: 'expiresAt=' + g.expiresAt + ' < now=' + now,
            });
            stateHandled.add(g.id);
        }
    }

    // ── ③ 预算耗尽：只覆盖 active/queued；paused 已被暂停过，不重复发 ──
    for (const g of sorted) {
        if (stateHandled.has(g.id)) continue;
        if (g.status !== 'active' && g.status !== 'queued') continue;
        const ex = _exhaustedBy(g, budgetState);
        if (ex.length) {
            actions.push({
                type: 'budget_exhausted',
                goalId: g.id,
                reason: 'budget_exhausted:' + ex.join(','),
            });
            stateHandled.add(g.id);
            notes.push('budget:' + g.id + '（' + ex.join(',') + '）→ paused，不转 failed');
        }
    }

    // ── 熔断集合（规则⑤的判定复用；被熔断的 goal 不参与 start/resume） ──
    const breakerEntries = [];
    const breakerBlocked = new Set();
    for (const key of Object.keys(breaker)) {
        const entry = breaker[key];
        const count = isObject(entry) ? entry.count : entry;
        if (!isNum(count) || count < BREAKER_THRESHOLD) continue;
        const goalId = isObject(entry) && typeof entry.goalId === 'string' ? entry.goalId : null;
        breakerEntries.push({ key, count, goalId });
        if (goalId) breakerBlocked.add(goalId);
    }

    // ── ④ 选 1 个 queued start；没有 queued 再看显式 resume 请求 ──
    let candidate = null;
    if (!blocking) {
        const hasActive = sorted.some((g) => g.status === 'active' && !stateHandled.has(g.id));
        if (!hasActive) {
            const queued = sorted
                .filter((g) => g.status === 'queued' && !stateHandled.has(g.id) &&
                    !breakerBlocked.has(g.id) && _exhaustedBy(g, budgetState).length === 0)
                .sort(_cmp);
            if (queued.length) {
                candidate = {
                    type: 'start',
                    goal: queued[0],
                    reason: 'queue:priority=' + _priority(queued[0]),
                };
            } else {
                const resumable = sorted
                    .filter((g) => g.status === 'paused' && !stateHandled.has(g.id) &&
                        g.resumeRequested === true && !breakerBlocked.has(g.id) &&
                        _exhaustedBy(g, budgetState).length === 0)
                    .sort(_cmp);
                if (resumable.length) {
                    candidate = { type: 'resume', goal: resumable[0], reason: 'resume_requested' };
                }
            }
        }
    }

    // ── ⑤ 熔断：达到阈值直接 reject（dispatch 层据此硬拒绝，不只提示模型） ──
    for (const e of breakerEntries) {
        actions.push({
            type: 'reject',
            goalId: e.goalId,
            reason: 'breaker:' + e.key + '（count=' + e.count + '）',
            key: e.key,
        });
    }

    // ── ⑥ 安全点：start/resume 必须落在行边界且无未决写 ──
    if (candidate) {
        const safe = _safety(candidate.goal, hasPendingWrite);
        if (safe.ok) {
            actions.push({
                type: candidate.type,
                goalId: candidate.goal.id,
                reason: candidate.reason,
            });
        } else {
            notes.push('safety:' + candidate.goal.id + ':' + safe.why +
                '（拒绝 ' + candidate.type + '）');
        }
    }

    return { actions, notes };
}

module.exports = {
    decide,
    ACTION_TYPES,
    BLOCKING_ACTIVITY,
    TERMINAL_STATUSES,
    BREAKER_THRESHOLD,
};
