#!/usr/bin/env node
/**
 * _probe/test-mind-kernel.cjs — 认知内核纯逻辑单测（goal-store / plan-store / arbiter-core）
 *
 * 全部用 os.tmpdir() 下的临时目录，绝不碰真实 data；跑完删除。
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.resolve(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const LIB = path.join(APP, 'plugins', 'community', 'mind-kernel', 'lib');
const jsonStore = require(path.join(APP, 'js', 'core', 'json-store.js'));
const { validateGoal, createStore } = require(path.join(LIB, 'goal-store.js'));
const planStore = require(path.join(LIB, 'plan-store.js'));
const { decide, ACTION_TYPES } = require(path.join(LIB, 'arbiter-core.js'));

let pass = 0;
let fail = 0;
function eq(name, got, want) {
    const a = JSON.stringify(got);
    const b = JSON.stringify(want);
    if (a === b) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + ' —— got ' + a + ' want ' + b);
}
function ok(name, cond, detail) {
    if (cond) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}
function hasAction(res, type, goalId) {
    return res.actions.some((a) => a.type === type && (goalId === undefined || a.goalId === goalId));
}
function findAction(res, type) {
    return res.actions.find((a) => a.type === type) || null;
}

function mkGoal(o) {
    return Object.assign({
        id: 'g1',
        parentId: null,
        title: '目标',
        doneWhen: 'T2:file-exists',
        status: 'queued',
        priority: 50,
        createdAt: 1000,
        updatedAt: 1000,
        budget: { maxSteps: 20, maxLlmCalls: 4, maxWallMs: 600000 },
        used: { steps: 0, llmCalls: 0, wallMs: 0 },
        attempts: 0,
        replans: 0,
        lastError: null,
        expiresAt: null,
        rev: 1,
    }, o || {});
}
function mkLine(i, o) {
    return Object.assign({
        id: 'l' + i,
        title: '步骤' + i,
        status: 'pending',
        t2: 'T2:check-' + i,
        evidence: [],
        attempts: 0,
        lastError: null,
    }, o || {});
}
function mkPlan(o) {
    return Object.assign({
        goalId: 'g1',
        cursor: 0,
        rev: 1,
        lines: [mkLine(1), mkLine(2)],
    }, o || {});
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-kernel-test-'));
let fileSeq = 0;
function newStore(nowVal) {
    const file = path.join(tmpRoot, 'goals-' + (++fileSeq) + '.json');
    const t = nowVal === undefined ? 1000 : nowVal;
    return createStore({
        file,
        readJson: jsonStore.readJson,
        writeJson: jsonStore.writeJson,
        now: () => t,
    });
}

try {
    // ── 1. validateGoal：缺字段 / 错状态必须被拒 ──
    {
        eq('合法 goal 通过', validateGoal(mkGoal()), { ok: true, errors: [] });

        const noTitle = Object.assign(mkGoal(), { title: '' });
        const v1 = validateGoal(noTitle);
        eq('缺 title 被拒', v1.ok, false);
        ok('缺 title 有字段级原因', v1.errors.some((e) => e.includes('title')), JSON.stringify(v1.errors));

        const noDoneWhen = Object.assign(mkGoal(), { doneWhen: '' });
        eq('缺 doneWhen 被拒', validateGoal(noDoneWhen).ok, false);

        const badStatus = Object.assign(mkGoal(), { status: 'sleeping' });
        const v2 = validateGoal(badStatus);
        eq('错状态被拒', v2.ok, false);
        ok('错状态原因含 status', v2.errors.some((e) => e.includes('status')), JSON.stringify(v2.errors));

        eq('缺 budget 被拒', validateGoal(Object.assign(mkGoal(), { budget: null })).ok, false);
        eq('负 used 被拒', validateGoal(Object.assign(mkGoal(), { used: { steps: -1, llmCalls: 0, wallMs: 0 } })).ok, false);
        eq('rev 非整数被拒', validateGoal(Object.assign(mkGoal(), { rev: 1.5 })).ok, false);
    }

    // ── 2. load()：重启规则 active → paused 且 rev++，并落盘 ──
    {
        const file = path.join(tmpRoot, 'load.json');
        jsonStore.writeJson(file, {
            schemaVersion: 1,
            goals: [mkGoal({ id: 'g1', status: 'active', rev: 7 })],
        });
        const store = createStore({
            file,
            readJson: jsonStore.readJson,
            writeJson: jsonStore.writeJson,
            now: () => 2000,
        });
        const loaded = store.load();
        eq('load 返回数组', Array.isArray(loaded), true);
        eq('load 数量', loaded.length, 1);
        eq('active→paused', loaded[0].status, 'paused');
        eq('rev++', loaded[0].rev, 8);

        const onDisk = jsonStore.readJson(file, null);
        eq('重启迁移已落盘', onDisk.goals[0].status, 'paused');
        eq('落盘 rev 同步', onDisk.goals[0].rev, 8);

        const again = store.load();
        eq('二次 load 不再 ++', again[0].rev, 8);
    }

    // ── 3. queued 上限 3；新 goal 默认 queued；同一时刻只能 1 个 active ──
    {
        const store = newStore();
        eq('add g1', store.add(mkGoal({ id: 'g1' })).ok, true);
        eq('add g2', store.add(mkGoal({ id: 'g2' })).ok, true);
        eq('add g3', store.add(mkGoal({ id: 'g3' })).ok, true);
        const r4 = store.add(mkGoal({ id: 'g4' }));
        eq('第 4 个被拒', r4.ok, false);
        eq('拒绝原因 queue_full', r4.reason, 'queue_full');
        eq('队列仍是 3', store.list().filter((g) => g.status === 'queued').length, 3);

        const store2 = newStore();
        const forced = store2.add(mkGoal({ id: 'a1', status: 'active' }));
        eq('add 强制 queued（不直通 active）', forced.goal.status, 'queued');
        eq('human 置 active', store2.setStatus('a1', 'active', { actor: 'human' }).ok, true);
        eq('add q1', store2.add(mkGoal({ id: 'q1' })).ok, true);
        const second = store2.setStatus('q1', 'active', { actor: 'arbiter' });
        eq('第二个 active 被拒', second.ok, false);
        eq('第二个 active 原因', second.reason, 'active_limit');
    }

    // ── 4. 保护字段：只有 human / arbiter 能改 status；update 不能绕过 ──
    {
        const store = newStore();
        store.add(mkGoal({ id: 'g1' }));

        eq('llm 改 status 被拒', store.setStatus('g1', 'paused', { actor: 'llm' }),
            { ok: false, reason: 'protected' });
        eq('缺 actor 被拒', store.setStatus('g1', 'paused', {}).reason, 'protected');
        eq('system 改 status 被拒', store.setStatus('g1', 'paused', { actor: 'system' }).reason, 'protected');
        eq('arbiter 允许', store.setStatus('g1', 'paused', { actor: 'arbiter' }).ok, true);

        const g = store.get('g1');
        eq('update 不能改 status', store.update('g1', { status: 'done' }, { expectedRev: g.rev }).reason, 'protected');
        eq('update 不能改 used', store.update('g1', { used: { steps: 99 } }, { expectedRev: g.rev }).reason, 'protected');
        eq('update 不能改 budget', store.update('g1', { budget: { maxSteps: 1 } }, { expectedRev: g.rev }).reason, 'protected');
        eq('update 不能改 rev', store.update('g1', { rev: 999 }, { expectedRev: g.rev }).reason, 'protected');
        eq('非法状态被拒', store.setStatus('g1', 'sleeping', { actor: 'human' }).reason, 'invalid_status');
    }

    // ── 5. 预算：超限返回 budget_exhausted；重规划不返还；没有 reset 后门 ──
    {
        const store = newStore();
        store.add(mkGoal({ id: 'g1', budget: { maxSteps: 2, maxLlmCalls: 4, maxWallMs: 600000 } }));
        store.setStatus('g1', 'active', { actor: 'human' });

        const c1 = store.consume('g1', { steps: 1 });
        eq('消耗 1 步 ok', c1.ok, true);
        eq('used.steps=1', c1.used.steps, 1);

        const c2 = store.consume('g1', { steps: 1 });
        eq('到上限 ok=false', c2.ok, false);
        eq('到上限原因', c2.reason, 'budget_exhausted');
        eq('到上限仍记账', c2.used.steps, 2);
        ok('exhaustedBy 指出 steps', Array.isArray(c2.exhaustedBy) && c2.exhaustedBy.includes('steps'),
            JSON.stringify(c2.exhaustedBy));

        ok('没有 reset/refund 接口',
            typeof store.resetBudget === 'undefined' &&
            typeof store.reset === 'undefined' &&
            typeof store.refund === 'undefined');

        const g = store.get('g1');
        eq('writing replans 可更新', store.update('g1', { replans: g.replans + 1 }, { expectedRev: g.rev }).ok, true);
        eq('重规划后 used 不变', store.get('g1').used.steps, 2);
        const c3 = store.consume('g1', { steps: 0 });
        eq('重规划不返还预算', c3.reason, 'budget_exhausted');

        const c4 = store.consume('g1', { steps: -1 });
        eq('负数增量被拒', c4.reason, 'invalid_delta');
    }

    // ── 6. plan 校验：线性 ≤8、cursor 边界、行唯一、行状态与 t2 ──
    {
        eq('合法 plan', planStore.validatePlan(mkPlan()).ok, true);

        const nine = mkPlan({ lines: Array.from({ length: 9 }, (_, i) => mkLine(i + 1)) });
        const v9 = planStore.validatePlan(nine);
        eq('9 行被拒', v9.ok, false);
        ok('9 行原因提到 8', v9.errors.some((e) => e.includes('8')), JSON.stringify(v9.errors));

        eq('cursor=-1 被拒', planStore.validatePlan(mkPlan({ cursor: -1 })).ok, false);
        eq('cursor 超界被拒', planStore.validatePlan(mkPlan({ cursor: 3 })).ok, false);
        eq('重复行 id 被拒', planStore.validatePlan(mkPlan({ lines: [mkLine(1), mkLine(1)] })).ok, false);
        eq('错行状态被拒', planStore.validatePlan(mkPlan({ lines: [mkLine(1, { status: 'sleeping' })] })).ok, false);
        eq('缺 t2 被拒', planStore.validatePlan(mkPlan({ lines: [mkLine(1, { t2: '' })] })).ok, false);
        eq('evidence 非数组被拒', planStore.validatePlan(mkPlan({ lines: [mkLine(1, { evidence: 'x' })] })).ok, false);
    }

    // ── 7. replaceRemaining：只改 cursor 之后，前缀逐字段不变 ──
    {
        const plan = mkPlan({
            cursor: 2,
            rev: 5,
            lines: [mkLine(1, { status: 'done' }), mkLine(2, { status: 'done' }), mkLine(3), mkLine(4)],
        });
        const prefixBefore = JSON.parse(JSON.stringify(plan.lines.slice(0, 2)));
        const r = planStore.replaceRemaining(plan, [mkLine(8), mkLine(9, { title: '新2' })], { expectedRev: 5 });

        eq('replace ok', r.ok, true);
        eq('总行数不变', r.plan.lines.length, 4);
        eq('已执行前缀不变', r.plan.lines.slice(0, 2), prefixBefore);
        eq('剩余第 1 行被替换', r.plan.lines[2].id, 'l8');
        eq('剩余第 2 行被替换', r.plan.lines[3].title, '新2');
        eq('rev+1', r.plan.rev, 6);
        eq('cursor 不动', r.plan.cursor, 2);
        eq('原 plan 未被修改', plan.lines[2].id, 'l3');
        ok('前缀对象不共享引用', r.plan.lines[0] !== plan.lines[0]);

        const tooLong = planStore.replaceRemaining(
            plan, Array.from({ length: 7 }, (_, i) => mkLine(20 + i)), { expectedRev: 5 });
        eq('超 8 行被拒', tooLong.reason, 'plan_too_long');

        const dup = planStore.replaceRemaining(plan, [mkLine(1)], { expectedRev: 5 });
        eq('与前缀 id 冲突被拒', dup.reason, 'invalid_lines');

        const badLine = planStore.replaceRemaining(plan, [mkLine(8, { t2: '' })], { expectedRev: 5 });
        eq('新行缺 t2 被拒', badLine.reason, 'invalid_lines');

        const noRev = planStore.replaceRemaining(plan, [mkLine(8)], {});
        eq('缺 expectedRev 被拒', noRev.reason, 'rev_required');
    }

    // ── 8. CAS：rev 不匹配一律 rev_mismatch ──
    {
        const store = newStore();
        store.add(mkGoal({ id: 'g1' }));
        const g = store.get('g1');

        const r1 = store.update('g1', { title: '新标题' }, { expectedRev: g.rev + 5 });
        eq('update rev_mismatch', r1.reason, 'rev_mismatch');
        eq('update currentRev', r1.currentRev, g.rev);

        eq('update 缺 rev 被拒', store.update('g1', { title: '新标题' }, {}).reason, 'rev_required');
        const r3 = store.update('g1', { title: '新标题' }, { expectedRev: g.rev });
        eq('update 正确 rev 通过', r3.ok, true);
        eq('update rev 自增', r3.goal.rev, g.rev + 1);
        eq('旧 rev 复用被拒', store.update('g1', { title: '再来' }, { expectedRev: g.rev }).reason, 'rev_mismatch');

        const plan = mkPlan({ rev: 3 });
        eq('replaceRemaining rev_mismatch',
            planStore.replaceRemaining(plan, [mkLine(5)], { expectedRev: 99 }).reason, 'rev_mismatch');
        eq('markLine rev_mismatch',
            planStore.markLine(plan, 'l1', 'done', {}, { expectedRev: 99 }).reason, 'rev_mismatch');
        eq('advance rev_mismatch',
            planStore.advance(plan, { expectedRev: 99 }).reason, 'rev_mismatch');
    }

    // ── 9. markLine / advance：只动指定行，前缀锁定，末尾 done ──
    {
        const plan = mkPlan({ cursor: 1, rev: 1, lines: [mkLine(1, { status: 'done' }), mkLine(2), mkLine(3)] });
        const r = planStore.markLine(plan, 'l2', 'running', { attempts: 1, lastError: 'boom' }, { expectedRev: 1 });
        eq('markLine ok', r.ok, true);
        eq('markLine 状态', r.plan.lines[1].status, 'running');
        eq('markLine attempts', r.plan.lines[1].attempts, 1);
        eq('markLine lastError', r.plan.lines[1].lastError, 'boom');
        eq('markLine 其它行不动', r.plan.lines[2], plan.lines[2]);
        eq('markLine 不改 cursor', r.plan.cursor, 1);

        eq('已执行前缀锁定',
            planStore.markLine(plan, 'l1', 'pending', {}, { expectedRev: 1 }).reason, 'prefix_locked');
        eq('不存在的行',
            planStore.markLine(plan, 'nope', 'done', {}, { expectedRev: 1 }).reason, 'line_not_found');
        eq('markLine 不能改 id',
            planStore.markLine(plan, 'l2', 'done', { id: 'x' }, { expectedRev: 1 }).reason, 'protected');

        const a1 = planStore.advance(plan);
        eq('advance ok', a1.ok, true);
        eq('advance done=false', a1.done, false);
        eq('advance cursor 前移', a1.plan.cursor, 2);

        const atEnd = mkPlan({ cursor: 3, lines: [mkLine(1), mkLine(2), mkLine(3)] });
        const a2 = planStore.advance(atEnd);
        eq('末尾 advance done=true', a2.done, true);
        eq('末尾 cursor 不动', a2.plan.cursor, 3);
    }

    // ── 10. arbiter：六条规则与安全点 ──
    {
        // ① gaming → pause
        const rGaming = decide({
            now: 1000,
            goals: [mkGoal({ id: 'a', status: 'active' })],
            world: { activity: 'gaming' },
            budgetState: {},
            breaker: {},
        });
        ok('gaming → pause', hasAction(rGaming, 'pause', 'a'), JSON.stringify(rGaming.actions));
        ok('gaming note 说明原因', rGaming.notes.some((n) => n.includes('gaming')), JSON.stringify(rGaming.notes));

        // ① watching → pause
        const rWatch = decide({
            now: 1000,
            goals: [mkGoal({ id: 'a', status: 'active' })],
            world: { activity: 'watching' },
            budgetState: {},
            breaker: {},
        });
        ok('watching → pause', hasAction(rWatch, 'pause', 'a'));

        // ④ 无 active + 有 queued → 只 start 1 个，priority 降序、createdAt 升序
        const rStart = decide({
            now: 1000,
            goals: [
                mkGoal({ id: 'low', priority: 10, createdAt: 1 }),
                mkGoal({ id: 'high-new', priority: 90, createdAt: 2 }),
                mkGoal({ id: 'high-old', priority: 90, createdAt: 1 }),
            ],
            world: { activity: 'working' },
            budgetState: {},
            breaker: {},
        });
        const starts = rStart.actions.filter((a) => a.type === 'start');
        eq('只 start 1 个', starts.length, 1);
        eq('start 选高优且更早', starts[0] && starts[0].goalId, 'high-old');

        // ② 过期 → expire（且不叠加 pause）
        const rExpire = decide({
            now: 1000,
            goals: [mkGoal({ id: 'e', status: 'active', expiresAt: 500 })],
            world: { activity: 'working' },
            budgetState: {},
            breaker: {},
        });
        ok('过期 → expire', hasAction(rExpire, 'expire', 'e'));
        ok('过期不再发 pause', !hasAction(rExpire, 'pause', 'e'));

        // ③ 预算耗尽 → budget_exhausted（不是 failed）
        const rBudget = decide({
            now: 1000,
            goals: [mkGoal({ id: 'b', status: 'active', used: { steps: 20, llmCalls: 0, wallMs: 0 } })],
            world: { activity: 'working' },
            budgetState: {},
            breaker: {},
        });
        ok('预算耗尽 → budget_exhausted', hasAction(rBudget, 'budget_exhausted', 'b'));
        ok('预算耗尽不转 failed', !rBudget.actions.some((a) => a.type === 'failed'));

        // ③ 外部 budgetState 也能触发
        const rBudgetExt = decide({
            now: 1000,
            goals: [mkGoal({ id: 'bx', status: 'active' })],
            world: { activity: 'working' },
            budgetState: { goals: { bx: { exhausted: true } } },
            breaker: {},
        });
        ok('外部 budgetState 触发', hasAction(rBudgetExt, 'budget_exhausted', 'bx'));

        // ⑤ breaker ≥3 → reject；2 次不触发
        const rBreaker = decide({
            now: 1000,
            goals: [mkGoal({ id: 'x', status: 'active' })],
            world: { activity: 'working' },
            budgetState: {},
            breaker: { 'tool=click|args=abc': { count: 3, goalId: 'x' } },
        });
        const rej = findAction(rBreaker, 'reject');
        ok('breaker≥3 → reject', !!rej);
        eq('reject 带 goalId', rej && rej.goalId, 'x');
        eq('reject 带 key', rej && rej.key, 'tool=click|args=abc');

        const rBreaker2 = decide({
            now: 1000,
            goals: [mkGoal({ id: 'x', status: 'active' })],
            world: { activity: 'working' },
            budgetState: {},
            breaker: { 'tool=click|args=abc': { count: 2, goalId: 'x' } },
        });
        ok('breaker=2 不 reject', !rBreaker2.actions.some((a) => a.type === 'reject'));

        // ⑥ hasPendingWrite → 不 start
        const rPending = decide({
            now: 1000,
            goals: [mkGoal({ id: 'q' })],
            world: { activity: 'working', hasPendingWrite: true },
            budgetState: {},
            breaker: {},
        });
        ok('pending_write 不 start', !hasAction(rPending, 'start', 'q'));
        ok('pending_write 有 note', rPending.notes.some((n) => n.includes('pending_write')),
            JSON.stringify(rPending.notes));

        // ⑥ 顶层 hasPendingWrite 也认
        const rPending2 = decide({
            now: 1000,
            goals: [mkGoal({ id: 'q' })],
            world: { activity: 'working' },
            budgetState: {},
            breaker: {},
            hasPendingWrite: true,
        });
        ok('顶层 pending_write 不 start', !hasAction(rPending2, 'start', 'q'));

        // ⑥ cursor 指向 running 行 → 不是安全点
        const runningPlan = mkPlan({
            goalId: 'q2',
            cursor: 1,
            lines: [mkLine(1, { status: 'done' }), mkLine(2, { status: 'running' }), mkLine(3)],
        });
        const rRunning = decide({
            now: 1000,
            goals: [mkGoal({ id: 'q2', plan: runningPlan })],
            world: { activity: 'working' },
            budgetState: {},
            breaker: {},
        });
        ok('running 行不 start', !hasAction(rRunning, 'start', 'q2'));
        ok('running 行有 note', rRunning.notes.some((n) => n.includes('line_running')),
            JSON.stringify(rRunning.notes));

        // ⑥ cursor 在边界 → 允许 start
        const boundaryPlan = mkPlan({
            goalId: 'q3',
            cursor: 1,
            lines: [mkLine(1, { status: 'done' }), mkLine(2)],
        });
        const rBoundary = decide({
            now: 1000,
            goals: [mkGoal({ id: 'q3', plan: boundaryPlan })],
            world: { activity: 'working' },
            budgetState: {},
            breaker: {},
        });
        ok('边界可 start', hasAction(rBoundary, 'start', 'q3'));

        // ⑥ resume 只对显式请求生效
        const rResume = decide({
            now: 1000,
            goals: [mkGoal({ id: 'p', status: 'paused', resumeRequested: true })],
            world: { activity: 'working' },
            budgetState: {},
            breaker: {},
        });
        ok('resumeRequested → resume', hasAction(rResume, 'resume', 'p'));

        const rNoResume = decide({
            now: 1000,
            goals: [mkGoal({ id: 'p2', status: 'paused' })],
            world: { activity: 'working' },
            budgetState: {},
            breaker: {},
        });
        ok('未请求不自动 resume', !hasAction(rNoResume, 'resume', 'p2'));

        // gaming 时即使无 active 也不 start queued
        const rGamingQueue = decide({
            now: 1000,
            goals: [mkGoal({ id: 'q4' })],
            world: { activity: 'gaming' },
            budgetState: {},
            breaker: {},
        });
        ok('gaming 不 start queued', !hasAction(rGamingQueue, 'start', 'q4'));

        // ⑩ 输出白名单：全部是状态迁移建议，没有执行动作
        const all = []
            .concat(rGaming.actions, rWatch.actions, rStart.actions, rExpire.actions,
                rBudget.actions, rBreaker.actions, rPending.actions, rRunning.actions,
                rBoundary.actions, rResume.actions);
        ok('actions.type 全在白名单内', all.every((a) => ACTION_TYPES.includes(a.type)),
            JSON.stringify([...new Set(all.map((a) => a.type))]));
        ok('没有执行类动作', all.every((a) => !['execute', 'run', 'call', 'invoke', 'tool_call'].includes(a.type)));

        // 纯函数：不改入参
        const imm = mkGoal({ id: 'imm', status: 'active' });
        const before = JSON.stringify(imm);
        decide({ now: 1000, goals: [imm], world: { activity: 'gaming' }, budgetState: {}, breaker: {} });
        eq('decide 不改输入 goal', JSON.stringify(imm), before);

        // 缺 now 必须抛（不允许隐式时钟）
        let threw = false;
        try { decide({ goals: [] }); } catch (e) { threw = true; }
        ok('缺 now 抛错', threw);
    }

    // ── 11. store.expire：非终态过期才 abandoned ──
    {
        const store = newStore();
        store.add(mkGoal({ id: 'e1', expiresAt: 500 }));
        store.setStatus('e1', 'active', { actor: 'human' });
        const r = store.expire(1000);
        eq('expire 返回 id', r.expired, ['e1']);
        eq('expire 转 abandoned', store.get('e1').status, 'abandoned');
        eq('expire rev++', store.get('e1').rev, 3);

        const store2 = newStore();
        store2.add(mkGoal({ id: 'd1', expiresAt: 500 }));
        store2.setStatus('d1', 'done', { actor: 'human' });
        const r2 = store2.expire(1000);
        eq('终态不被动', r2.expired, []);
        eq('done 仍是 done', store2.get('d1').status, 'done');
    }
} catch (e) {
    fail += 1;
    console.error('  ✗ 测试脚本异常 —— ' + ((e && e.stack) || e));
} finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* 清理失败不掩盖断言 */ }
}

console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 认知内核：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
