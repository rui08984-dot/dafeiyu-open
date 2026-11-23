// _probe/test-agent-eval-strict.cjs —— 评测严格档纯函数单测（2026-11-20 审计 P2 #20/#22/#24）
//
// 不连 8004、不碰真实窗口：从 runner.mjs 抽取 #region eval-strict-pure 里的纯函数，
// 用构造的 trace / 调用序列断言三件事：
//   ① trace 读失败 → budget.ok=null（未取证），绝不当 true；
//   ② 预算超 maxSteps → false（负例必须红）；
//   ③ 恢复档位以 runner 观察到的调用序列为准，任务自报的 recover() 骗不过。
'use strict';

const fs = require('fs');
const path = require('path');

const RUNNER = path.join(__dirname, 'agent-eval', 'runner.mjs');

function loadPure() {
    const src = fs.readFileSync(RUNNER, 'utf8');
    const start = src.indexOf('// #region eval-strict-pure');
    const end = src.indexOf('// #endregion eval-strict-pure');
    if (start < 0 || end < 0 || end <= start) throw new Error('runner.mjs 里找不到 eval-strict-pure 区段');
    const body = src.slice(start, end);
    // eslint-disable-next-line no-new-func
    return new Function(body + '\nreturn { judgeBudget, selfReportRecovery, observeRecovery };')();
}

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass += 1; return; }
    fail += 1;
    failures.push(name + (detail ? '：' + detail : ''));
}

function tool(toolName, action, okFlag, extra) {
    return Object.assign({ kind: 'tool', phase: 'run', tool: toolName, action: action, ok: okFlag }, extra || {});
}
function traceOk(events, recovery) {
    return { ok: true, trace: { seq: { events: events }, recovery: recovery || null, counts: { run: 0 } } };
}
const TRACE_FAIL = { ok: false, error: 'timeout 8000ms' };

function main() {
    const { judgeBudget, observeRecovery } = loadPure();

    // ── #22 预算三态 ────────────────────────────────────────────────────────
    ok('未声明预算 → 不适用（不是未取证）', (() => {
        const b = judgeBudget({}, TRACE_FAIL);
        return b.declared === false && b.ok === true;
    })());

    ok('trace 读失败 + 声明 maxSteps → ok=null（未取证，不能判绿）', (() => {
        const b = judgeBudget({ maxSteps: 14 }, TRACE_FAIL);
        return b.declared === true && b.ok === null && b.runToolCalls === null && /未取证/.test(String(b.reason));
    })());

    ok('trace 缺失（无对象）→ ok=null', (() => {
        const b = judgeBudget({ maxSteps: 14 }, null);
        return b.ok === null;
    })());

    ok('maxSteps=14 且 run=14 → 恰好通过', (() => {
        const b = judgeBudget({ maxSteps: 14 }, { ok: true, trace: { counts: { run: 14 } } });
        return b.ok === true && b.runToolCalls === 14;
    })());

    ok('maxSteps=14 且 run=15 → 判红（负例）', (() => {
        const b = judgeBudget({ maxSteps: 14 }, { ok: true, trace: { counts: { run: 15 } } });
        return b.ok === false;
    })());

    ok('trace 正常但没有 run 计数 → 0 次（不是未取证）', (() => {
        const b = judgeBudget({ maxSteps: 14 }, { ok: true, trace: { counts: null } });
        return b.ok === true && b.runToolCalls === 0;
    })());

    // ── #24 retry_in_place：观察序列，不信自报 ──────────────────────────────
    const taskA = { expectedRecovery: 'retry_in_place', expectedReplanCount: 0 };
    const selfSayRetry = { events: [{ kind: 'attempt' }, { kind: 'attempt' }] };

    ok('A：真实两次 type → observed 通过', (() => {
        const seq = [tool('app', 'focus', true), tool('act', 'type', true), tool('game_control', 'edit_text', true),
            tool('app', 'focus', true), tool('act', 'type', true)];
        const r = observeRecovery(taskA, traceOk(seq, selfSayRetry));
        return r.ok === true && r.observed.attempts === 2 && r.observed.replans === 0;
    })());

    ok('A：任务自报 attempts=2 但序列只有一次 type → 判红（自报骗不过）', (() => {
        const seq = [tool('app', 'focus', true), tool('act', 'type', true), tool('game_control', 'edit_text', true)];
        const r = observeRecovery(taskA, traceOk(seq, selfSayRetry));
        return r.ok === false && r.observed.attempts === 1 && r.selfReported.attempts === 2;
    })());

    ok('A：两次 type 但中途重开过窗口 → 不算原地重试', (() => {
        const seq = [tool('act', 'type', true), { kind: 'window_open', phase: 'run', file: 'x' }, tool('act', 'type', true)];
        const r = observeRecovery(taskA, traceOk(seq, selfSayRetry));
        return r.ok === false && r.observed.replans === 1;
    })());

    // ── #24 replan：重开窗是客观证据 ────────────────────────────────────────
    const taskB = { expectedRecovery: 'replan', expectedReplanCount: 1 };
    const selfSayReplan = { events: [{ kind: 'attempt' }, { kind: 'replan' }, { kind: 'attempt' }] };

    ok('B：序列里有 1 次 run 阶段开窗 + 2 次 type → observed 通过', (() => {
        const seq = [tool('act', 'type', true), tool('act', 'click', true),
            { kind: 'window_open', phase: 'run', file: 'b2' }, tool('act', 'type', true)];
        const r = observeRecovery(taskB, traceOk(seq, selfSayReplan));
        return r.ok === true && r.observed.replans === 1 && r.observed.attempts === 2;
    })());

    ok('B：自报 replan 但序列没有开窗 → 判红', (() => {
        const seq = [tool('act', 'type', true), tool('act', 'click', true), tool('act', 'type', true)];
        const r = observeRecovery(taskB, traceOk(seq, selfSayReplan));
        return r.ok === false && r.observed.replans === 0;
    })());

    // ── #24 verify_before_retry：失败动作之后先只读确认 ─────────────────────
    const taskC = { expectedRecovery: 'verify_before_retry' };

    ok('C：失败 click 之后先 file.read、无重试 → observed 通过', (() => {
        const seq = [tool('act', 'type', true),
            tool('act', 'click', false, { timeout: true }),
            tool('file', 'read', true)];
        const r = observeRecovery(taskC, traceOk(seq, { events: [{ kind: 'attempt' }, { kind: 'verify_read' }] }));
        return r.ok === true && r.observed.suspectAt >= 0 && r.observed.verifyAfterSuspect === true;
    })());

    ok('C：失败 click 之后先重试 click（在 file.read 之前）→ 判红', (() => {
        const seq = [tool('act', 'type', true),
            tool('act', 'click', false, { timeout: true }),
            tool('act', 'click', true),
            tool('file', 'read', true)];
        const r = observeRecovery(taskC, traceOk(seq, { events: [{ kind: 'attempt' }, { kind: 'verify_read' }] }));
        return r.ok === false && r.observed.retryBeforeVerify === true;
    })());

    ok('C：输入了两次（原样重试）→ 判红', (() => {
        const seq = [tool('act', 'type', true), tool('act', 'type', true),
            tool('act', 'click', false, { timeout: true }), tool('file', 'read', true)];
        const r = observeRecovery(taskC, traceOk(seq, { events: [{ kind: 'attempt' }, { kind: 'attempt' }] }));
        return r.ok === false && r.observed.attempts === 2;
    })());

    ok('C：typeOnce 的夹具补打（fixture=true）不算第二次尝试', (() => {
        const seq = [tool('act', 'type', true),
            tool('act', 'type', true, { fixture: true }),
            tool('act', 'click', false, { timeout: true }), tool('file', 'read', true)];
        const r = observeRecovery(taskC, traceOk(seq, { events: [{ kind: 'attempt' }] }));
        return r.ok === true && r.observed.attempts === 1 && r.observed.fixtureTypeCalls === 1;
    })());

    // ── #22 恢复判定也必须是三态 ─────────────────────────────────────────────
    ok('恢复任务 trace 读失败 → ok=null（不判绿也不判假红）', (() => {
        const r = observeRecovery(taskA, TRACE_FAIL);
        return r.ok === null && /未取证/.test(r.why);
    })());

    ok('恢复任务 trace 正常但没有 seq → ok=null（旧状态/页面 reload）', (() => {
        const r = observeRecovery(taskA, { ok: true, trace: { recovery: selfSayRetry, counts: {} } });
        return r.ok === null && /没有调用序列/.test(r.why);
    })());

    ok('未知 expectedRecovery → 判红（配置错误，不是未取证）', (() => {
        const r = observeRecovery({ expectedRecovery: 'bogus' }, traceOk([tool('act', 'type', true)]));
        return r.ok === false && /未知/.test(r.why);
    })());

    if (fail) {
        console.error('❌ 评测严格档单测：FAIL ' + fail + ' / PASS ' + pass);
        for (const f of failures) console.error('   - ' + f);
        process.exit(1);
    }
    console.log('PASS ' + pass + ' / FAIL 0（评测严格档：预算三态 / observed 恢复 / 自报不可信）');
}

try {
    main();
} catch (e) {
    console.error('❌ 评测严格档单测异常：' + ((e && e.stack) || e));
    process.exit(1);
}
