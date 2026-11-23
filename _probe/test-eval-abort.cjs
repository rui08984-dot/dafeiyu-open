// _probe/test-eval-abort.cjs —— 评测 run 超时后取消页面残留脚本（2026-11-20 审计 P1-4）
//
// 复现过的 bug：runner 的 HTTP abort 只断自己这侧，页面里的 async IIFE 还在 sleep/
// 重试/调 act type，可能把标记打进用户窗口。
//
// 做法（真机 8004，不注入任何真实输入）：
//   ① 直接从 runner.mjs 源码抽取真实的 buildEval（纯字符串生成），生成一个
//      「sleep 1.5s 后置哨兵」的 run 脚本；
//   ② 250ms 后按 abort 约定置 __petEvalCtl.aborted / token='__aborted__' /
//      __petEvalDisabled=true；
//   ③ 断言 run 脚本以 EVAL_ABORTED 结束、哨兵从未被置上；
//   ④ 断言 devtools /type 在禁用期返回 409（不注入任何字符）；
//   ⑤ 断言 maintenance（cleanup）脚本仍能正常执行 —— 别把正常收尾也禁掉。
//
// 8004 不通时输出 SKIP 并退出 0（check-all 会把它标成未验证）。
'use strict';

const fs = require('fs');
const path = require('path');

const RUNNER = path.join(__dirname, 'agent-eval', 'runner.mjs');
const LOCK = path.join(__dirname, 'agent-eval', '.tmp', 'runner.lock');
const BASE = 'http://127.0.0.1:8004';

// 本测试会改页面里的 __petEvalCtl / buildEval 状态，绝不能和真实评测并发。
function runnerActive() {
    try {
        const j = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
        if (!j || !j.pid) return false;
        try { process.kill(Number(j.pid), 0); return true; }
        catch (e) { return !!(e && e.code === 'EPERM'); }
    } catch (e) { return false; }
}

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; return; }
    fail++;
    failures.push(name + (detail ? '：' + detail : ''));
}

async function evalPage(js, timeoutMs = 8000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(BASE + '/eval', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ js }), signal: ac.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error('HTTP ' + res.status + '：' + text.slice(0, 300));
        const j = JSON.parse(text);
        if (!j || j.ok !== true) throw new Error('eval failed: ' + text.slice(0, 300));
        return j.value;
    } finally { clearTimeout(timer); }
}

// 从 runner.mjs 抽真实的 buildEval（它不闭包任何外部变量，可独立 eval）。
function extractBuildEval() {
    const src = fs.readFileSync(RUNNER, 'utf8');
    const start = src.indexOf('function buildEval(');
    if (start < 0) throw new Error('runner.mjs 里找不到 buildEval');
    const endMark = '\n})()`;\n}';
    const end = src.indexOf(endMark, start);
    if (end < 0) throw new Error('找不到 buildEval 结尾');
    const fnSrc = src.slice(start, end + endMark.length);
    // eslint-disable-next-line no-new-func
    return new Function(fnSrc + '\nreturn buildEval;')();
}

(async () => {
    if (runnerActive()) {
        console.log('SKIP 真实评测正在进行（runner.lock 持有者存活）：本测试会改页面评测状态，跳过以免互相干扰');
        process.exit(0);
    }
    try {
        const v = await evalPage('1+1', 3000);
        if (v !== 2) throw new Error('8004 eval 返回异常：' + JSON.stringify(v));
    } catch (e) {
        console.log('SKIP 8004 不通（宿主的 devtools 未启动）：' + String((e && e.message) || e));
        process.exit(0);
    }

    const buildEval = extractBuildEval();
    ok('从 runner.mjs 抽到 buildEval', typeof buildEval === 'function');

    // 最小页面状态：**只补缺失字段，不替换对象** —— 替换会清掉并发评测的
    // run.runId/marker，把别人的夹具窗口/剪贴板标记打回 undefined（本轮踩过）。
    await evalPage(`(function(){
      const R = window.__AGENT_EVAL__ || (window.__AGENT_EVAL__ = {});
      R.run = R.run || {};
      R.tasks = R.tasks || {};
      R.nch = R.nch || {};
      R.waits = R.waits || {};
      R.counts = R.counts || {};
      R.recovery = R.recovery || {};
      if (typeof R.lastCallAt !== 'number') R.lastCallAt = 0;
      if (typeof R.noChangeN !== 'number') R.noChangeN = 0;
      if (typeof R.isMutating !== 'function') R.isMutating = function () { return false; };
      R.liarOff = false; R.nchOff = false;
      window.______e2ePrevCtl = window.__petEvalCtl
        ? { token: window.__petEvalCtl.token, aborted: window.__petEvalCtl.aborted, reason: window.__petEvalCtl.reason }
        : null;
      window.__petEvalCtl = { token: '', aborted: false, reason: null };
      window.__petEvalDisabled = false;
      window.__evalAbortSentinel = undefined;
      return 'ready';
    })()`);

    const runJs = buildEval('abort-test', 'await sleep(1500); window.__evalAbortSentinel = true; return { ok: true };',
        { phase: 'run', token: 'tok-run-1' });
    const runP = evalPage(runJs, 8000).then((x) => ({ ok: true, x }), (e) => ({ ok: false, e: String(e.message || e) }));

    await new Promise((r) => setTimeout(r, 250));
    await evalPage(`(function(){
      const c = window.__petEvalCtl;
      c.aborted = true; c.reason = 'e2e-abort'; c.token = '__aborted__';
      window.__petEvalDisabled = true;
      if (typeof window.__petEvalAbort === 'function') window.__petEvalAbort('e2e-abort');
      return true;
    })()`);

    const rr = await runP;
    ok('run 残留脚本被 EVAL_ABORTED 中止', rr.ok === false && /EVAL_ABORTED/.test(rr.e), rr.ok ? '脚本居然跑完了' : rr.e.slice(0, 160));
    const sentinel = await evalPage('window.__evalAbortSentinel === undefined');
    ok('超时后不再执行后续语句（哨兵未置上）', sentinel === true);

    // devtools 输入闸：禁用期 /type 必须 409（这里不会真的打字）
    const tRes = await fetch(BASE + '/type', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'AB' }),
    });
    ok('禁用期 /type 返回 409', tRes.status === 409, '实际 ' + tRes.status);
    const tj = await tRes.json().catch(() => ({}));
    ok('409 带 eval_disabled', tj && tj.error === 'eval_disabled');

    // cleanup（maintenance）必须还能跑：它会重置 token/aborted/disabled
    const cleanJs = buildEval('abort-test', 'await sleep(60); return { ok: true, maint: true };',
        { phase: 'cleanup', token: 'tok-clean-1', maintenance: true });
    let cleanOk = false;
    try {
        const cv = await evalPage(cleanJs, 5000);
        cleanOk = !!(cv && cv.ok === true && cv.maint === true);
    } catch (e) { cleanOk = false; }
    ok('cleanup 不被误禁（maintenance 可执行）', cleanOk);
    ok('cleanup 后 __petEvalDisabled 复位', (await evalPage('window.__petEvalDisabled === false')) === true);
    ok('cleanup 不会复活旧脚本', (await evalPage('window.__evalAbortSentinel === undefined')) === true);

    // 收尾：只删本测试自己的痕迹，恢复进入前的 ctl，别给真实评测/并发调用留脏状态
    await evalPage(`(function(){
      try {
        const R = window.__AGENT_EVAL__ || {};
        if (R.tasks) delete R.tasks['abort-test'];
        if (R.counts) delete R.counts['abort-test'];
        if (R.recovery) delete R.recovery['abort-test'];
        if (R.nch) delete R.nch['abort-test'];
        if (R.waits) delete R.waits['abort-test'];
        R.liarOff = false; R.nchOff = false;
      } catch (e) {}
      const p = window.______e2ePrevCtl;
      window.__petEvalCtl = p || { token: '', aborted: false, reason: null };
      delete window.______e2ePrevCtl;
      window.__petEvalDisabled = false;
      delete window.__evalAbortSentinel;
      return true;
    })()`).catch(() => {});

    if (fail) {
        console.error('❌ 评测超时取消：FAIL ' + fail + ' / PASS ' + pass);
        for (const f of failures) console.error('   - ' + f);
        process.exit(1);
    }
    console.log('  ✅ 评测超时取消：PASS ' + pass + ' / FAIL 0');
})().catch((e) => {
    console.error('❌ 评测超时取消测试异常：' + ((e && e.stack) || e));
    process.exit(1);
});
