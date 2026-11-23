#!/usr/bin/env node
/**
 * _probe/test-task-ledger.cjs — 任务账本三态（B1，2026-11-21）
 *
 * 要防的回归：
 *   ① 执行器自述 ok 就记 done（原实现 `row.state = data.ok ? 'done' : 'failed'`）
 *   ② `{ok:false}` 的失败反被记成成功；或「失败」与「没证据」混成一个状态
 *   ③ 纯查询任务被强行标「未证实」（把真实风险淹掉）
 *   ④ done_unproven 不是终态 → arbiter 反复推进 → 副作用动作重复执行
 *   ⑤ 账本字段写了没人用（taskId/goalId/via/costMs 只是摆设）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const TL = require(path.join(APP, 'plugins', 'community', 'dispatch', 'task-ledger.js'));
const GS = require(path.join(APP, 'plugins', 'community', 'mind-kernel', 'lib', 'goal-store.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const cls = (o) => TL.classifyOutcome(o).outcome;

// ① 三态判定
ok('执行器报失败 → failed', cls({ ok: false }) === 'failed');
ok('ok + verified=true → done_verified', cls({ ok: true, verified: true }) === 'done_verified');
ok('ok + evidence → done_verified', cls({ ok: true, evidence: '文件已存在，sha 匹配' }) === 'done_verified');
ok('ok + 纯查询 → done_verified（白名单豁免）', cls({ ok: true, task: '查一下明天的天气' }) === 'done_verified',
    cls({ ok: true, task: '查一下明天的天气' }));
ok('ok + 普通写任务 → done_unproven', cls({ ok: true, task: '把这三个文件改成 UTF-8 编码' }) === 'done_unproven');
ok('查询动词 + 破坏动词 → 不豁免（查看并删除）', cls({ ok: true, task: '查看并删除 C 盘的临时文件' }) === 'done_unproven');
ok('英文 read/search 豁免', cls({ ok: true, task: 'read the log and tell me the errors' }) === 'done_verified');
ok('英文 read+deploy 不豁免', cls({ ok: true, task: 'read config then deploy the service' }) === 'done_unproven');
ok('空任务不豁免', cls({ ok: true, task: '' }) === 'done_unproven');
ok('失败原因是人话（带 evidence 片段）', /失败/.test(TL.classifyOutcome({ ok: false, evidence: 'exit 1' }).why));
ok('未证实原因说清「没有外部证据」', /没有外部证据/.test(TL.classifyOutcome({ ok: true, task: '安装依赖' }).why));

// ② 映射表
ok('GOAL_STATUS：三态各对应账本状态',
    TL.GOAL_STATUS.done_verified === 'done' && TL.GOAL_STATUS.done_unproven === 'done_unproven' && TL.GOAL_STATUS.failed === 'failed');
ok('HISTORY_VERIFIED：verified 三值（true/null/false）',
    TL.HISTORY_VERIFIED.done_verified === true && TL.HISTORY_VERIFIED.done_unproven === null && TL.HISTORY_VERIFIED.failed === false);

// ③ goal-store：done_unproven 合法且是终态
const mem = {};
const store = GS.createStore({
    file: 'mem.json',
    readJson: (f, fb) => (mem[f] !== undefined ? JSON.parse(JSON.stringify(mem[f])) : fb),
    writeJson: (f, d) => { mem[f] = JSON.parse(JSON.stringify(d)); },
    now: () => 1000,
});
const goal = {
    id: 'g1', parentId: null, title: '测试目标', doneWhen: '外部可判定',
    status: 'active', priority: 1, createdAt: 1000, updatedAt: 1000,
    budget: { maxSteps: 20, maxLlmCalls: 4, maxWallMs: 600000 },
    used: { steps: 0, llmCalls: 0, wallMs: 0 },
    attempts: 0, replans: 0, lastError: null, expiresAt: null, rev: 0,
};
const addRes = store.add(goal);
ok('add 合法 goal', addRes && addRes.ok === true, addRes && (addRes.reason || (addRes.errors || []).join(',')));
const st1 = store.setStatus('g1', 'done_unproven', { actor: 'arbiter', reason: 'ledger-done_unproven' });
ok('setStatus 接受 done_unproven', st1 && st1.ok === true, JSON.stringify(st1));
ok('done_unproven 在终态列表里', GS.TERMINAL_STATUSES.includes('done_unproven'));
const st2 = store.setStatus('g1', 'failed', { actor: 'arbiter' });
ok('终态保护：done_unproven 不能被翻成 failed', st2 && st2.ok === false, JSON.stringify(st2));
ok('状态仍是 done_unproven', store.get('g1') && store.get('g1').status === 'done_unproven');

// ④ 接线静态断言（防「三态只在单测里活着，生产没人调」）
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8'); } catch (e) { return ''; } };
const mk = read('plugins/community/mind-kernel/index.js');
ok('finishGoal 支持 outcome→status 映射', /OUTCOME_TO_STATUS/.test(mk) && /done_unproven/.test(mk));
ok('finishGoal 的 ledger 记 outcome', /outcome: outcome \|\| null/.test(mk));
const dp = read('plugins/community/dispatch/index.js');
ok('dispatch 结案用 classifyOutcome', /taskLedger\.classifyOutcome\(/.test(dp));
ok('dispatch 失败路径也置 outcome', /row\.outcome = 'failed'/.test(dp));
ok('执行档案带 taskId/goalId/via/costMs',
    /taskId: id/.test(dp) && /goalId:/.test(dp) && /via: 'dsh'/.test(dp) && /costMs:/.test(dp));
ok('回执对未证实单独说话', /done_unproven/.test(dp) && /没有可验证的证据/.test(dp));
const sl = read('plugins/community/dispatch/skill-library.js');
ok('recordHistory 写 join 字段', /rec\.taskId/.test(sl) && /rec\.goalId/.test(sl) && /rec\.via/.test(sl) && /rec\.costMs/.test(sl));
const arb = read('plugins/community/mind-kernel/lib/arbiter-core.js');
ok('arbiter 把 done_unproven 当终态', /done_unproven/.test(arb));

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
