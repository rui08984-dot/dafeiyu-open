// plugins/community/mind-kernel/lib/plan-store.js —— 线性计划（纯函数，无 IO）
//
// 结构照抄 cetana 的 Intention：cursor = 已越过/已验证的行下标，计划只允许从
// cursor 往后改。已执行前缀不可变，是「重规划不会重放已完成副作用」的唯一保证。
//
// 硬约束：
//   · 线性 ≤8 行（DAG/HTN 已在 ADR-006 否掉）；
//   · cursor ∈ [0, lines.length]，本身就在行边界上；
//   · 每个函数都返回新对象、不改入参；比较并交换（CAS）用 rev。
//
// 这些函数不写盘：调用方拿到新 plan 后自行原子写回。这样 arbiter/单测都没有副作用。
'use strict';

const MAX_LINES = 8;
const LINE_STATUSES = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped']);

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}
function isNonNegInt(v) {
    return isNum(v) && v >= 0 && Number.isInteger(v);
}
function clone(v) {
    return JSON.parse(JSON.stringify(v));
}

function _checkLine(line, at, errors) {
    if (!isObject(line)) {
        errors.push(at + ' 必须是对象');
        return;
    }
    if (typeof line.id !== 'string' || !line.id.trim()) errors.push(at + '.id 必须是非空字符串');
    if (typeof line.title !== 'string' || !line.title.trim()) errors.push(at + '.title 必须是非空字符串');
    if (!LINE_STATUSES.includes(line.status)) {
        errors.push(at + '.status 非法：' + String(line.status) + '（允许 ' + LINE_STATUSES.join('/') + '）');
    }
    if (typeof line.t2 !== 'string' || !line.t2.trim()) {
        errors.push(at + '.t2 必须是非空字符串（每行必须有外部判据）');
    }
    if (!Array.isArray(line.evidence) || !line.evidence.every((e) => typeof e === 'string')) {
        errors.push(at + '.evidence 必须是 string[]');
    }
    if (!isNonNegInt(line.attempts)) errors.push(at + '.attempts 必须是非负整数');
    if (!(line.lastError === null || typeof line.lastError === 'string')) {
        errors.push(at + '.lastError 必须是 string 或 null');
    }
}

/**
 * 校验 plan。返回 {ok, errors[]}。
 * @param {any} plan
 */
function validatePlan(plan) {
    const errors = [];
    if (!isObject(plan)) return { ok: false, errors: ['plan 必须是对象'] };

    if (typeof plan.goalId !== 'string' || !plan.goalId.trim()) errors.push('goalId 必须是非空字符串');
    if (!isNonNegInt(plan.rev)) errors.push('rev 必须是非负整数');
    if (!Array.isArray(plan.lines)) {
        errors.push('lines 必须是数组');
        return { ok: false, errors };
    }
    if (plan.lines.length > MAX_LINES) {
        errors.push('lines 最多 ' + MAX_LINES + ' 行，当前 ' + plan.lines.length + ' 行');
    }
    if (!isNonNegInt(plan.cursor) || plan.cursor < 0 || plan.cursor > plan.lines.length) {
        errors.push('cursor 必须是 [0, lines.length] 内的整数（当前 ' + String(plan.cursor) +
            '，lines=' + plan.lines.length + '）');
    }

    const ids = new Set();
    plan.lines.forEach((line, i) => {
        _checkLine(line, 'lines[' + i + ']', errors);
        if (isObject(line) && typeof line.id === 'string') {
            if (ids.has(line.id)) errors.push('行 id 重复：' + line.id);
            ids.add(line.id);
        }
    });

    return { ok: errors.length === 0, errors };
}

/** 新行补默认值（status=pending / evidence=[] / attempts=0 / lastError=null），再校验。 */
function _normalizeNewLine(line, i, errors) {
    const at = 'newLines[' + i + ']';
    if (!isObject(line)) {
        errors.push(at + ' 必须是对象');
        return null;
    }
    const out = {
        id: line.id,
        title: line.title,
        status: line.status === undefined ? 'pending' : line.status,
        t2: line.t2,
        evidence: line.evidence === undefined ? [] : line.evidence,
        attempts: line.attempts === undefined ? 0 : line.attempts,
        lastError: line.lastError === undefined ? null : line.lastError,
    };
    _checkLine(out, at, errors);
    return out;
}

/**
 * 只替换 lines[cursor:]，已执行前缀逐字段保持不变。
 * @param {object} plan
 * @param {object[]} newLines 新的剩余步骤
 * @param {{expectedRev: number}} opts CAS
 * @returns {{ok:boolean, plan?:object, reason?:string, currentRev?:number, errors?:string[]}}
 */
function replaceRemaining(plan, newLines, opts) {
    const v = validatePlan(plan);
    if (!v.ok) return { ok: false, reason: 'invalid_plan', errors: v.errors };

    const expectedRev = opts && opts.expectedRev;
    if (!isNonNegInt(expectedRev)) return { ok: false, reason: 'rev_required' };
    if (plan.rev !== expectedRev) return { ok: false, reason: 'rev_mismatch', currentRev: plan.rev };

    if (!Array.isArray(newLines)) {
        return { ok: false, reason: 'invalid_lines', errors: ['newLines 必须是数组'] };
    }
    const capacity = MAX_LINES - plan.cursor;
    if (newLines.length > capacity) {
        return { ok: false, reason: 'plan_too_long', limit: MAX_LINES, maxNewLines: capacity };
    }

    const errors = [];
    const norm = newLines.map((line, i) => _normalizeNewLine(line, i, errors));
    if (errors.length) return { ok: false, reason: 'invalid_lines', errors };

    const prefix = plan.lines.slice(0, plan.cursor).map(clone);
    const prefixIds = new Set(prefix.map((l) => l.id));
    for (const l of norm) {
        if (prefixIds.has(l.id)) errors.push('新行 id 与已执行前缀冲突：' + l.id);
    }
    if (errors.length) return { ok: false, reason: 'invalid_lines', errors };

    const next = {
        goalId: plan.goalId,
        cursor: plan.cursor,
        rev: plan.rev + 1,
        lines: prefix.concat(norm),
    };
    const v2 = validatePlan(next);
    if (!v2.ok) return { ok: false, reason: 'invalid_plan', errors: v2.errors };
    return { ok: true, plan: clone(next) };
}

/**
 * cursor 前移一格。已在末尾则 done=true 且不再改 rev。
 * expectedRev 可选；传了就走 CAS。
 */
function advance(plan, opts) {
    const v = validatePlan(plan);
    if (!v.ok) return { ok: false, reason: 'invalid_plan', errors: v.errors };

    if (opts && opts.expectedRev !== undefined) {
        const expectedRev = opts.expectedRev;
        if (!isNonNegInt(expectedRev)) return { ok: false, reason: 'rev_required' };
        if (plan.rev !== expectedRev) return { ok: false, reason: 'rev_mismatch', currentRev: plan.rev };
    }

    if (plan.cursor >= plan.lines.length) {
        return { ok: true, done: true, plan: clone(plan), unchanged: true };
    }

    const next = {
        goalId: plan.goalId,
        cursor: plan.cursor + 1,
        rev: plan.rev + 1,
        lines: plan.lines.map(clone),
    };
    return { ok: true, done: next.cursor >= next.lines.length, plan: clone(next) };
}

/**
 * 把 cursor 推进到目标位置，并把越过的那段行标成 done（B6，2026-11-23）。
 *
 * 为什么不是「连调 advance() N 次」：那样每格都改一次 rev，中间任何一次写盘失败
 * 都会留下「cursor 走了一半、行状态没跟上」的半截 plan；这里一次构造、一次校验。
 *
 * 规则（全部是安全方向）：
 *   · 目标位置先钳到 [当前 cursor, lines.length]，**永不后退、永不越界**；
 *   · 目标 ≤ 当前 → unchanged（不涨 rev，幂等）；
 *   · 只有 [cursor, target) 的行会被标 done，其余行逐字段不动；
 *   · evidence 追加去重并截到 10 条，避免一次任务几百个工具把 plan 撑爆。
 *
 * @param {object} plan
 * @param {number} targetCursor 期望推进到的位置
 * @param {{expectedRev?:number, evidence?:string}} [opts]
 * @returns {{ok:boolean, plan?:object, from?:number, to?:number, advanced?:number,
 *            done?:boolean, unchanged?:boolean, reason?:string, errors?:string[]}}
 */
function advanceTo(plan, targetCursor, opts) {
    const v = validatePlan(plan);
    if (!v.ok) return { ok: false, reason: 'invalid_plan', errors: v.errors };

    if (opts && opts.expectedRev !== undefined) {
        const expectedRev = opts.expectedRev;
        if (!isNonNegInt(expectedRev)) return { ok: false, reason: 'rev_required' };
        if (plan.rev !== expectedRev) return { ok: false, reason: 'rev_mismatch', currentRev: plan.rev };
    }

    const from = plan.cursor;
    const want = isNum(targetCursor) ? Math.floor(targetCursor) : from;
    // 只前进：负数/回退目标都等价于「不动」；超界钳到末尾。
    const to = Math.max(from, Math.min(plan.lines.length, want));
    if (to === from) {
        return { ok: true, plan: clone(plan), from, to, advanced: 0, done: from >= plan.lines.length, unchanged: true };
    }

    const evidence = opts && typeof opts.evidence === 'string' && opts.evidence.trim()
        ? opts.evidence.trim().slice(0, 80)
        : '';
    const lines = plan.lines.map((line, i) => {
        const out = clone(line);
        if (i >= from && i < to) {
            out.status = 'done';
            const ev = Array.isArray(out.evidence) ? out.evidence.slice() : [];
            if (evidence && !ev.includes(evidence)) ev.push(evidence);
            out.evidence = ev.slice(-10);
        }
        return out;
    });
    const next = { goalId: plan.goalId, cursor: to, rev: plan.rev + 1, lines };
    const v2 = validatePlan(next);
    if (!v2.ok) return { ok: false, reason: 'invalid_plan', errors: v2.errors };
    return { ok: true, plan: clone(next), from, to, advanced: to - from, done: to >= next.lines.length };
}

/**
 * 改指定行的状态（可选 patch 只作用于该行）。前缀（index < cursor）锁定，
 * 防止重规划/模型把已执行的步骤改回去。CAS 用 expectedRev。
 */
function markLine(plan, lineId, status, patch, opts) {
    const v = validatePlan(plan);
    if (!v.ok) return { ok: false, reason: 'invalid_plan', errors: v.errors };

    const expectedRev = opts && opts.expectedRev;
    if (!isNonNegInt(expectedRev)) return { ok: false, reason: 'rev_required' };
    if (plan.rev !== expectedRev) return { ok: false, reason: 'rev_mismatch', currentRev: plan.rev };

    if (!LINE_STATUSES.includes(status)) return { ok: false, reason: 'invalid_status', status };
    const idx = plan.lines.findIndex((l) => l.id === lineId);
    if (idx < 0) return { ok: false, reason: 'line_not_found', lineId };
    if (idx < plan.cursor) return { ok: false, reason: 'prefix_locked', lineId };

    const p = isObject(patch) ? patch : {};
    const forbidden = Object.keys(p).filter((k) =>
        k === 'id' || k === 'status' || k === 'rev' || k === 'goalId' || k === 'cursor');
    if (forbidden.length) return { ok: false, reason: 'protected', fields: forbidden };

    const lines = plan.lines.map(clone);
    lines[idx] = Object.assign(lines[idx], p, { status });
    const next = {
        goalId: plan.goalId,
        cursor: plan.cursor,
        rev: plan.rev + 1,
        lines,
    };
    const v2 = validatePlan(next);
    if (!v2.ok) return { ok: false, reason: 'invalid_plan', errors: v2.errors };
    return { ok: true, plan: clone(next), line: clone(lines[idx]) };
}

module.exports = {
    validatePlan,
    replaceRemaining,
    advance,
    advanceTo,
    markLine,
    MAX_LINES,
    LINE_STATUSES,
};
