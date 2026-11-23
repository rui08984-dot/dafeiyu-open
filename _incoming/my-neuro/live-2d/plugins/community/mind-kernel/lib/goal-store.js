// plugins/community/mind-kernel/lib/goal-store.js —— 目标栈（纯逻辑，依赖注入）
//
// 为什么这里一行 IO 都不写：
//   goal 状态是认知内核的地基，必须能被单测完整覆盖。模块顶层 require 真实路径
//   （records-path / json-store）会让单测碰真实 data，还会把「插件能不能加载」
//   绑到宿主目录结构上。所以 file/readJson/writeJson/now 全部由调用方注入；
//   本模块只做 schema 校验、状态迁移、预算记账与 CAS。
//
// 三条不可让步的规则（来自 docs/调研-认知内核目标栈-2026-11-20.md）：
//   ① 重启后 active → paused，并 rev++：崩溃恢复时绝不自动续跑未验证的步骤。
//   ② status / used / budget 是保护字段：LLM 只能通过 actor 白名单之外的入口被拒绝。
//   ③ 预算是代码真值，不是提示：used ≥ budget 时 consume() 返回 budget_exhausted；
//      重规划不返还（本模块刻意不提供 reset / refund）。
//
// 文件形状：{ schemaVersion: 1, goals: [...] }
//   load() 也接受裸数组（旧文件/手工修过的文件），返回 goals 数组。
'use strict';

// done_unproven（B1，2026-11-21）：任务结束了，但只有执行器自述、没有外部证据。
// 它是**终态** —— 不能因为「未证实」就让 arbiter 反复推进（那会重复执行副作用动作）。
const STATUSES = Object.freeze(['active', 'queued', 'paused', 'done', 'done_unproven', 'failed', 'abandoned']);
const TERMINAL_STATUSES = Object.freeze(['done', 'done_unproven', 'failed', 'abandoned']);
// 只有这两个 actor 能改保护字段；其它一律 protected（默认拒绝，含 actor 缺失）。
const HOST_ACTORS = Object.freeze(['human', 'arbiter']);
const PROTECTED_FIELDS = Object.freeze(['status', 'used', 'budget']);
const DEFAULT_BUDGET = Object.freeze({ maxSteps: 20, maxLlmCalls: 4, maxWallMs: 600000 });
const QUEUE_LIMIT = 3;
const ACTIVE_LIMIT = 1;
const SCHEMA_VERSION = 1;

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}
function isNonNeg(v) {
    return isNum(v) && v >= 0;
}
function isNonNegInt(v) {
    return isNonNeg(v) && Number.isInteger(v);
}
function clone(v) {
    return JSON.parse(JSON.stringify(v));
}

/**
 * 校验 goal 是否符合固定 schema。返回 {ok, errors[]}，errors 是给人看的字段级原因。
 * @param {any} goal
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateGoal(goal) {
    const errors = [];
    if (!isObject(goal)) return { ok: false, errors: ['goal 必须是对象'] };

    if (typeof goal.id !== 'string' || !goal.id.trim()) errors.push('id 必须是非空字符串');
    if (!(goal.parentId === null || typeof goal.parentId === 'string')) {
        errors.push('parentId 必须是 string 或 null');
    }
    if (typeof goal.title !== 'string' || !goal.title.trim()) errors.push('title 必须是非空字符串');
    if (typeof goal.doneWhen !== 'string' || !goal.doneWhen.trim()) {
        errors.push('doneWhen 必须是非空字符串（没有外部判据的目标不成立）');
    }
    if (!STATUSES.includes(goal.status)) {
        errors.push('status 非法：' + String(goal.status) + '（允许 ' + STATUSES.join('/') + '）');
    }
    if (!isNum(goal.priority)) errors.push('priority 必须是有限数字');
    if (!isNum(goal.createdAt)) errors.push('createdAt 必须是 epoch ms 数字');
    if (!isNum(goal.updatedAt)) errors.push('updatedAt 必须是 epoch ms 数字');

    if (!isObject(goal.budget)) {
        errors.push('budget 必须是对象');
    } else {
        for (const k of ['maxSteps', 'maxLlmCalls', 'maxWallMs']) {
            if (!isNonNeg(goal.budget[k])) errors.push('budget.' + k + ' 必须是非负有限数字');
        }
    }
    if (!isObject(goal.used)) {
        errors.push('used 必须是对象');
    } else {
        for (const k of ['steps', 'llmCalls', 'wallMs']) {
            if (!isNonNeg(goal.used[k])) errors.push('used.' + k + ' 必须是非负有限数字');
        }
    }

    if (!isNonNegInt(goal.attempts)) errors.push('attempts 必须是非负整数');
    if (!isNonNegInt(goal.replans)) errors.push('replans 必须是非负整数');
    if (!(goal.lastError === null || typeof goal.lastError === 'string')) {
        errors.push('lastError 必须是 string 或 null');
    }
    if (!(goal.expiresAt === null || isNum(goal.expiresAt))) {
        errors.push('expiresAt 必须是 epoch ms 数字或 null');
    }
    if (!isNonNegInt(goal.rev)) errors.push('rev 必须是非负整数');

    return { ok: errors.length === 0, errors };
}

/** 判定 goal 的预算是否已耗尽，返回耗尽维度（空数组 = 还有余量）。 */
function exhaustedBy(goal) {
    const out = [];
    const b = isObject(goal && goal.budget) ? goal.budget : {};
    const u = isObject(goal && goal.used) ? goal.used : {};
    if (isNum(b.maxSteps) && isNum(u.steps) && u.steps >= b.maxSteps) out.push('steps');
    if (isNum(b.maxLlmCalls) && isNum(u.llmCalls) && u.llmCalls >= b.maxLlmCalls) out.push('llmCalls');
    if (isNum(b.maxWallMs) && isNum(u.wallMs) && u.wallMs >= b.maxWallMs) out.push('wallMs');
    return out;
}

/**
 * 创建 goal store。
 * @param {{file: string, readJson: Function, writeJson: Function, now?: Function}} deps
 *   readJson(file, fallback) / writeJson(file, data, options) 与 js/core/json-store 同签名。
 *   now() 默认 Date.now；单测注入固定时钟。
 */
function createStore(deps) {
    const d = deps || {};
    const file = d.file;
    const readJson = d.readJson;
    const writeJson = d.writeJson;
    if (!file) throw new Error('createStore: 缺少 file（goal 文件路径）');
    if (typeof readJson !== 'function') throw new Error('createStore: 缺少 readJson 依赖');
    if (typeof writeJson !== 'function') throw new Error('createStore: 缺少 writeJson 依赖');
    const clock = typeof d.now === 'function' ? d.now : () => Date.now();

    // 有效 goal；invalid 是读盘时不符合 schema 的原始条目，原样写回，绝不静默丢弃。
    let goals = [];
    let invalid = [];
    let loaded = false;
    let loadErrors = [];

    function _save() {
        writeJson(file, { schemaVersion: SCHEMA_VERSION, goals: goals.concat(invalid) });
    }

    function _ensureLoaded() {
        if (!loaded) load();
    }

    function _find(id) {
        return goals.find((g) => g.id === id) || null;
    }

    /** 读盘条目补基础设施默认值；核心字段（id/title/doneWhen/status）缺失仍判无效。 */
    function _coerceLoaded(raw, t) {
        if (!isObject(raw)) return null;
        const g = Object.assign({}, raw);
        if (g.parentId === undefined) g.parentId = null;
        if (!isNum(g.priority)) g.priority = 50;
        if (!isNum(g.createdAt)) g.createdAt = t;
        if (!isNum(g.updatedAt)) g.updatedAt = g.createdAt;
        g.budget = Object.assign({}, DEFAULT_BUDGET, isObject(g.budget) ? g.budget : {});
        g.used = Object.assign({ steps: 0, llmCalls: 0, wallMs: 0 }, isObject(g.used) ? g.used : {});
        if (!isNonNegInt(g.attempts)) g.attempts = 0;
        if (!isNonNegInt(g.replans)) g.replans = 0;
        if (g.lastError === undefined) g.lastError = null;
        if (g.expiresAt === undefined) g.expiresAt = null;
        if (!isNonNegInt(g.rev)) g.rev = 0;
        return validateGoal(g).ok ? g : null;
    }

    /**
     * 读文件并把所有 active 改成 paused（重启规则），rev++，返回 goals 数组。
     * 有迁移发生时立即原子写回，保证下一次崩溃不会把 paused 又读成 active。
     */
    function load() {
        const raw = readJson(file, null);
        // 结构坏（非数组、也不是 {goals:[]}）但内容非空：当成「一条坏条目」放进 invalid，
        // 原样保留、不参与调度；绝不把它当空数组然后在下次 _save 时覆盖原文件（审计 P2 #15）。
        const arr = Array.isArray(raw)
            ? raw
            : (isObject(raw) && Array.isArray(raw.goals)
                ? raw.goals
                : (raw != null ? [raw] : []));
        const t = clock();
        const next = [];
        const bad = [];
        for (const item of arr) {
            const g = _coerceLoaded(item, t);
            if (g) next.push(g);
            else bad.push(item);
        }
        goals = next;
        invalid = bad;
        loaded = true;
        loadErrors = bad.length
            ? ['文件中有 ' + bad.length + ' 条 goal 不符合 schema，已原样保留（不参与调度）']
            : [];
        if (bad.length) console.warn('[mind-kernel/goal-store] ' + file + '：' + loadErrors[0]);

        const flipped = [];
        for (const g of goals) {
            if (g.status === 'active') {
                g.status = 'paused';
                g.rev += 1;
                g.updatedAt = t;
                flipped.push(g.id);
            }
        }
        if (flipped.length) {
            _save();
            console.warn('[mind-kernel/goal-store] 重启：' + flipped.length +
                ' 个 active 目标转 paused（' + flipped.join(',') + '）');
        }
        return goals.map(clone);
    }

    /**
     * 新增目标。新目标一律 queued（start 只能由 arbiter/human 决定）。
     * 队列上限 3，第 4 个返回 queue_full。
     */
    function add(input) {
        _ensureLoaded();
        if (!isObject(input)) return { ok: false, reason: 'invalid', errors: ['goal 必须是对象'] };
        if (input.status !== undefined && !STATUSES.includes(input.status)) {
            return { ok: false, reason: 'invalid', errors: ['status 非法：' + String(input.status)] };
        }

        const t = clock();
        const g = {
            id: input.id,
            parentId: input.parentId === undefined ? null : input.parentId,
            title: input.title,
            doneWhen: input.doneWhen,
            status: 'queued',   // 显式覆盖：新目标不能直接 active，避免绕过 1 active 不变量
            priority: isNum(input.priority) ? input.priority : 50,
            createdAt: isNum(input.createdAt) ? input.createdAt : t,
            updatedAt: t,
            budget: Object.assign({}, DEFAULT_BUDGET, isObject(input.budget) ? input.budget : {}),
            // 审计 P2 #14：预算真值只能由 consume() 写；add() 不接受外部预支/伪造的 used/attempts/replans。
            used: { steps: 0, llmCalls: 0, wallMs: 0 },
            attempts: 0,
            replans: 0,
            lastError: input.lastError === undefined ? null : input.lastError,
            expiresAt: input.expiresAt === undefined ? null : input.expiresAt,
            rev: 1,
        };
        // 扩展字段（plan/meta）：由 plan-store / dispatch 维护，add 不能静默丢弃。
        // plan 的结构校验由 plan-store.validatePlan 负责（这里不做跨模块依赖）。
        if (isObject(input.plan)) g.plan = clone(input.plan);
        if (isObject(input.meta)) g.meta = clone(input.meta);

        const v = validateGoal(g);
        if (!v.ok) return { ok: false, reason: 'invalid', errors: v.errors };
        if (goals.some((x) => x.id === g.id) ||
            invalid.some((x) => isObject(x) && x.id === g.id)) {
            return { ok: false, reason: 'duplicate_id', id: g.id };
        }
        const queued = goals.filter((x) => x.status === 'queued').length;
        if (queued >= QUEUE_LIMIT) return { ok: false, reason: 'queue_full', limit: QUEUE_LIMIT };

        goals.push(g);
        _save();
        return { ok: true, goal: clone(g) };
    }

    /**
     * 改状态。actor 必须是 human / arbiter；其它（含缺失）返回 protected。
     * active 唯一性在这里兜底：已有 active 时第二个置 active 被拒。
     */
    function setStatus(id, status, opts) {
        _ensureLoaded();
        const actor = opts && opts.actor;
        if (!HOST_ACTORS.includes(actor)) return { ok: false, reason: 'protected' };
        if (!STATUSES.includes(status)) return { ok: false, reason: 'invalid_status', status };
        const g = _find(id);
        if (!g) return { ok: false, reason: 'not_found', id };
        if (g.status === status) return { ok: true, goal: clone(g), unchanged: true };

        // 终态保护（2026-11-20 审计 P1）：done/failed/abandoned 一旦落定不可再迁出。
        // 原先「二次 finish 传 ok:false」能把 done 改成 failed，污染目标栈与 ledger；
        // 唯一例外是 human 显式 reopen（arbiter/LLM 无此权力）。
        if (TERMINAL_STATUSES.includes(g.status)) {
            const reopen = !!(opts && opts.reopen === true && actor === 'human');
            if (!reopen) return { ok: false, reason: 'terminal', status: g.status };
        }

        if (status === 'active') {
            const other = goals.find((x) => x !== g && x.status === 'active');
            if (other) return { ok: false, reason: 'active_limit', activeGoalId: other.id };
        }

        g.status = status;
        g.rev += 1;
        g.updatedAt = clock();
        _save();
        return { ok: true, goal: clone(g) };
    }

    /**
     * 预算记账：used 累加（只增不减）。任一维度 used ≥ budget 时返回
     * {ok:false, reason:'budget_exhausted'}，但本次消耗仍然记账 —— 否则
     * 「刚好用完」的 goal 会永远停在 19/20，arbiter 的 used≥budget 规则永远不触发。
     * 刻意不提供 reset / refund：重规划不返还预算。
     */
    function consume(id, delta) {
        _ensureLoaded();
        const dv = isObject(delta) ? delta : {};
        const steps = dv.steps === undefined ? 0 : dv.steps;
        const llmCalls = dv.llmCalls === undefined ? 0 : dv.llmCalls;
        const wallMs = dv.wallMs === undefined ? 0 : dv.wallMs;
        if (![steps, llmCalls, wallMs].every(isNonNeg)) {
            return { ok: false, reason: 'invalid_delta', errors: ['steps/llmCalls/wallMs 必须是非负有限数字'] };
        }
        const g = _find(id);
        if (!g) return { ok: false, reason: 'not_found', id };
        if (TERMINAL_STATUSES.includes(g.status)) {
            return { ok: false, reason: 'goal_closed', status: g.status };
        }

        g.used.steps += steps;
        g.used.llmCalls += llmCalls;
        g.used.wallMs += wallMs;
        g.rev += 1;
        g.updatedAt = clock();
        _save();

        const ex = exhaustedBy(g);
        const base = { goal: clone(g), used: clone(g.used), budget: clone(g.budget) };
        if (ex.length) return Object.assign({ ok: false, reason: 'budget_exhausted', exhaustedBy: ex }, base);
        return Object.assign({ ok: true, remaining: _remaining(g) }, base);
    }

    function _remaining(g) {
        const b = g.budget || {};
        const u = g.used || {};
        return {
            steps: isNum(b.maxSteps) && isNum(u.steps) ? Math.max(0, b.maxSteps - u.steps) : null,
            llmCalls: isNum(b.maxLlmCalls) && isNum(u.llmCalls) ? Math.max(0, b.maxLlmCalls - u.llmCalls) : null,
            wallMs: isNum(b.maxWallMs) && isNum(u.wallMs) ? Math.max(0, b.maxWallMs - u.wallMs) : null,
        };
    }

    /**
     * CAS 更新非保护字段。expectedRev 必填；不匹配返回 {reason:'rev_mismatch', currentRev}。
     * status/used/budget 即使传了也拒绝（改这些请走 setStatus / consume），
     * 避免 update() 成为绕过保护字段的后门。
     */
    function update(id, patch, opts) {
        _ensureLoaded();
        const expectedRev = opts && opts.expectedRev;
        const g = _find(id);
        if (!g) return { ok: false, reason: 'not_found', id };
        if (!isNonNegInt(expectedRev)) return { ok: false, reason: 'rev_required' };
        if (g.rev !== expectedRev) return { ok: false, reason: 'rev_mismatch', currentRev: g.rev };
        if (!isObject(patch)) return { ok: false, reason: 'invalid', errors: ['patch 必须是对象'] };

        const forbidden = Object.keys(patch).filter((k) =>
            PROTECTED_FIELDS.includes(k) || k === 'rev' || k === 'id' || k === 'createdAt');
        if (forbidden.length) return { ok: false, reason: 'protected', fields: forbidden };

        const next = Object.assign({}, g, patch);
        next.updatedAt = clock();
        next.rev = g.rev + 1;
        const v = validateGoal(next);
        if (!v.ok) return { ok: false, reason: 'invalid', errors: v.errors };

        goals[goals.indexOf(g)] = next;
        _save();
        return { ok: true, goal: clone(next) };
    }

    /**
     * 过期扫描：expiresAt != null && now > expiresAt 的非终态 goal → abandoned。
     * done/failed/abandoned 不再改写（终态优先）。
     */
    function expire(nowArg) {
        _ensureLoaded();
        const t = isNum(nowArg) ? nowArg : clock();
        const expired = [];
        for (const g of goals) {
            if (TERMINAL_STATUSES.includes(g.status)) continue;
            if (g.expiresAt !== null && isNum(g.expiresAt) && t > g.expiresAt) {
                g.status = 'abandoned';
                g.rev += 1;
                g.updatedAt = t;
                expired.push(g.id);
            }
        }
        if (expired.length) _save();
        return { ok: true, expired };
    }

    function get(id) {
        _ensureLoaded();
        const g = _find(id);
        return g ? clone(g) : null;
    }

    function list() {
        _ensureLoaded();
        return goals.map(clone);
    }

    function loadErrorsOfLastLoad() {
        return loadErrors.slice();
    }

    return {
        load,
        add,
        setStatus,
        consume,
        update,
        expire,
        get,
        list,
        loadErrors: loadErrorsOfLastLoad,
    };
}

module.exports = {
    validateGoal,
    createStore,
    exhaustedBy,
    STATUSES,
    TERMINAL_STATUSES,
    HOST_ACTORS,
    PROTECTED_FIELDS,
    DEFAULT_BUDGET,
    QUEUE_LIMIT,
    ACTIVE_LIMIT,
    SCHEMA_VERSION,
};
