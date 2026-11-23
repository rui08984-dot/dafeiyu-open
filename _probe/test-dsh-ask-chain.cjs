// _probe/test-dsh-ask-chain.cjs —— DSH 人工应答链单测（P0-1 / P1-2 / P1-7 缺口）
//
// 覆盖审计指出的「新增 DSH 应答链 0 单测」：
//   ① 否定句 → 拒绝类标签（不允许/不继续/不要继续/do not approve/not approve/别/勿/stop）；
//   ② 没有拒绝类标签 → custom 原文（绝不猜正选项）；
//   ③ 反向包含回归：「允许」不能因为存在「不允许」选项就被映射成「不允许」；
//   ④ 挂起等待器：超时返回 / busy 返回 / 人工回答消费 / 指定 id 取消；
//   ⑤ 8103 Origin 白名单与 ACAO 回显（不再 `*`）。
//
// 只 require 纯函数模块，不起 HTTP / 不连 8103。
'use strict';

const path = require('path');
const map = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'petbridge', 'dsh-answer-map.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; return; }
    fail++;
    failures.push(name + (detail ? '：' + detail : ''));
}
function eq(name, actual, expected) {
    ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}
const j = (v) => JSON.stringify(v);
function questions(labels, extra) {
    return [{ id: 'q1', question: '是否允许执行该操作？', options: labels.map((l) => ({ label: l })), ...(extra || {}) }];
}
function ans(text, labels) {
    return map.answersFromText(text, questions(labels));
}

// ── ① 否定句 → 拒绝类 ───────────────────────────────────────────────────────
const NEG_CASES = [
    ['不允许', ['允许', '拒绝'], '拒绝'],
    ['不继续', ['继续', '停止'], '停止'],
    ['不要继续', ['继续', '取消'], '取消'],
    ['do not approve', ['Approve', 'Reject'], 'Reject'],
    ['not approve', ['Approve', 'Reject'], 'Reject'],
    ["don't do it", ['Allow', 'Deny'], 'Deny'],
    ['拒绝吧', ['允许', '拒绝'], '拒绝'],
    ['先别动', ['继续', '停止'], '停止'],
    ['勿执行', ['允许', '拒绝'], '拒绝'],
    ['stop', ['continue', 'stop'], 'stop'],
    ['cancel', ['confirm', 'cancel'], 'cancel'],
];
for (const [text, labels, expect] of NEG_CASES) {
    const a = ans(text, labels);
    eq('否定「' + text + '」→ ' + expect, j(a[0].selected), j([expect]));
    ok('否定「' + text + '」不落 custom', a[0].custom === undefined);
}

// 「不允许」包含「允许」—— 旧实现在「只有允许一个选项」时会选中允许（P0 原样）。
const onlyAllow = ans('不允许', ['允许']);
eq('否定 + 唯一正选项 → selected 为空', j(onlyAllow[0].selected), '[]');
eq('否定 + 唯一正选项 → custom 原文', onlyAllow[0].custom, '不允许');

// 否定优先于精确/包含：选项里同时有「不允许」和「拒绝」时必须选「拒绝」。
const negVsNeg = ans('不允许', ['不允许', '拒绝']);
eq('否定时优先选明确的拒绝类', j(negVsNeg[0].selected), j(['拒绝']));

// ── ② 无拒绝标签 → custom 原文 ─────────────────────────────────────────────
const noDeny = ans('不允许', ['继续保持', '新建窗口']);
eq('无拒绝标签 → selected 为空', j(noDeny[0].selected), '[]');
eq('无拒绝标签 → custom 保留原文', noDeny[0].custom, '不允许');

// ── ③ 反向包含回归 ─────────────────────────────────────────────────────────
const reverse = ans('允许', ['允许', '不允许']);
eq('「允许」不被反向包含到「不允许」', j(reverse[0].selected), j(['允许']));

// ── ④ 正常口语兜底 ─────────────────────────────────────────────────────────
eq('取消吧 → 取消', j(ans('取消吧', ['继续', '取消'])[0].selected), j(['取消']));
eq('那就继续 → 继续执行（垫词+前缀兜底）', j(ans('那就继续', ['继续执行', '停止'])[0].selected), j(['继续执行']));
eq('允许（推荐）→ 选中该选项（原样返回 label）', j(ans('允许', ['允许（推荐）', '拒绝'])[0].selected), j(['允许（推荐）']));
eq('多选逐段匹配', j(map.answersFromText('允许、拒绝', [{ id: 'q1', question: 'x', options: [{ label: '允许' }, { label: '拒绝' }], multiSelect: true }])[0].selected), j(['允许', '拒绝']));

// ── ⑤ 挂起等待器：超时 / busy / 回答 / 取消 ────────────────────────────────
// broker 的超时 timer 是 unref 的（生产上不该阻止进程退出），单测里用 keepalive
// 把事件循环撑住，否则 await 一个 unref timer 会直接静默退出（0 输出）。
const keepAlive = setInterval(() => {}, 1000);
(async () => {
    // 超时：40ms 后返回 timedOut，且不再 busy。
    {
        const b = map.createAskBroker({ timeoutMs: 40 });
        const req = b.ask(questions(['允许', '拒绝']));
        ok('ask 后处于 busy', b.busy() === true);
        const t0 = Date.now();
        const r = await req.promise;
        const dt = Date.now() - t0;
        eq('超时 → timedOut=true', r.timedOut, true);
        eq('超时 → answers 为空', j(r.answers), '[]');
        ok('超时耗时在预算内（' + dt + 'ms）', dt >= 30 && dt < 500);
        eq('超时后 busy 释放', b.busy(), false);
    }

    // busy：第一个挂起未完成时，第二个立即 busy，不覆盖第一个。
    {
        const b = map.createAskBroker({ timeoutMs: 5000 });
        const first = b.ask(questions(['允许', '拒绝']));
        const second = b.ask(questions(['允许', '拒绝']));
        const r2 = await second.promise;
        eq('第二个请求 busy=true', r2.busy, true);
        eq('第二个请求 id=0', second.id, 0);
        const r1 = b.reply('不允许');
        eq('busy 不覆盖第一个：回答仍消费', r1.consumed, true);
        eq('第一个请求拿到拒绝', j((await first.promise).answers[0].selected), j(['拒绝']));
        b.cancel(first.id);
    }

    // 人工回答消费 + 二次 reply 不消费。
    {
        const b = map.createAskBroker({ timeoutMs: 5000 });
        const req = b.ask(questions(['允许', '拒绝']));
        const r = b.reply('不允许');
        eq('reply consumed=true', r.consumed, true);
        eq('reply 映射为拒绝', j(r.answers[0].selected), j(['拒绝']));
        eq('重复 reply consumed=false', b.reply('允许').consumed, false);
        eq('reply 后等待器已释放', b.busy(), false);
        await req.promise; // 已 settle，不应再改结果
    }

    // 指定 id 取消：错的 id 不能误杀，正确 id 返回 clientClosed。
    {
        const b = map.createAskBroker({ timeoutMs: 5000 });
        const req = b.ask(questions(['允许', '拒绝']));
        eq('cancel(错误 id) 返回 false', b.cancel(req.id + 1), false);
        ok('错误 id 不释放等待器', b.busy() === true);
        eq('cancel(正确 id) 返回 true', b.cancel(req.id), true);
        const r = await req.promise;
        eq('取消返回 clientClosed', r.clientClosed, true);
        eq('取消后 busy 释放', b.busy(), false);
    }

    // /state 形状：current() 只暴露 id/question。
    {
        const b = map.createAskBroker({ timeoutMs: 5000 });
        eq('无挂起时 current=null', b.current(), null);
        const req = b.ask(questions(['允许', '拒绝']));
        const cur = b.current();
        ok('current 带 at/questions', cur && cur.at > 0 && Array.isArray(cur.questions));
        eq('current 不泄露 options', cur.questions[0].options === undefined, true);
        b.reply('拒绝');
        await req.promise;
    }

    // ── ⑥ Origin 白名单 / ACAO ──────────────────────────────────────────────
    ok('无 Origin（curl/Node/渲染层）放行', map.originAllowed(undefined) === true);
    ok('空 Origin 放行', map.originAllowed('') === true);
    ok('http://127.0.0.1:5173 放行', map.originAllowed('http://127.0.0.1:5173') === true);
    ok('http://localhost:3000 放行', map.originAllowed('http://localhost:3000') === true);
    ok('http://[::1]:8080 放行', map.originAllowed('http://[::1]:8080') === true);
    ok('file:// 放行', map.originAllowed('file:///D:/x/index.html') === true);
    ok('null 不放行', map.originAllowed('null') === false);
    ok('https://evil.com 拒绝', map.originAllowed('https://evil.com') === false);
    ok('http://127.0.0.1.evil.com 拒绝', map.originAllowed('http://127.0.0.1.evil.com') === false);
    ok('data: 源拒绝', map.originAllowed('data:text/html,x') === false);

    const corsBad = map.corsFor('https://evil.com');
    eq('非白名单 allowed=false', corsBad.allowed, false);
    ok('非白名单不发 ACAO', corsBad.headers['Access-Control-Allow-Origin'] === undefined);
    ok('ACAO 永不发 *', corsBad.headers['Access-Control-Allow-Origin'] !== '*');
    const corsOk = map.corsFor('http://127.0.0.1:5173');
    eq('白名单 allowed=true', corsOk.allowed, true);
    eq('ACAO 回显具体 origin', corsOk.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:5173');
    ok('Vary: Origin 存在', /origin/i.test(String(corsOk.headers.Vary || '')));

    clearInterval(keepAlive);
    if (fail) {
        console.error('❌ DSH 应答链：FAIL ' + fail + ' / PASS ' + pass);
        for (const f of failures) console.error('   - ' + f);
        process.exit(1);
    }
    console.log('  ✅ DSH 应答链：PASS ' + pass + ' / FAIL 0');
})().catch((e) => {
    clearInterval(keepAlive);
    console.error('❌ DSH 应答链测试异常：' + ((e && e.stack) || e));
    process.exit(1);
});
