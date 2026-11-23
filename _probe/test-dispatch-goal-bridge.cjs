// _probe/test-dispatch-goal-bridge.cjs —— dispatch ↔ mind-kernel 桥接单测
//
// 桥接只有「可选调用 + 全 try/catch」两条纪律，但必须证明：
//   ① 没有 mind-kernel 时派活完全不受影响（返回 null，不抛）；
//   ② 有钩子时参数形状正确（title/doneWhen/kind/source、ok/wallMs/steps）；
//   ③ 钩子自己抛错时也不影响派活。
'use strict';

const path = require('path');
const DispatchPlugin = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'index.js'));

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

const plugin = new DispatchPlugin({ name: 'dispatch' }, { log() {} });

// ① 无钩子
delete globalThis.__mindKernelAddGoal;
delete globalThis.__mindKernelFinishGoal;
eq('无钩子时 _createGoalForTask 返回 null', plugin._createGoalForTask({ task: 'x' }), null);
plugin._finishGoalForTask({ goalId: 'g1', state: 'done' }); // 不应抛
ok('无钩子时 _finishGoalForTask 不抛', true);

// ② 有钩子：参数形状
let addPayload = null;
globalThis.__mindKernelAddGoal = (p) => { addPayload = p; return 'g-test-1'; };
const gid = plugin._createGoalForTask({ task: '整理报告并发邮件' });
eq('有钩子时返回 goalId', gid, 'g-test-1');
ok('add payload 含 title', addPayload && addPayload.title === '整理报告并发邮件', JSON.stringify(addPayload));
ok('add payload 含 doneWhen', addPayload && typeof addPayload.doneWhen === 'string' && addPayload.doneWhen.length > 0);
eq('add payload kind=dsh', addPayload && addPayload.kind, 'dsh');
eq('add payload source=dispatch', addPayload && addPayload.source, 'dispatch');

// ③ 钩子抛错
globalThis.__mindKernelAddGoal = () => { throw new Error('kernel boom'); };
eq('钩子抛错时 _createGoalForTask 返回 null', plugin._createGoalForTask({ task: 'x' }), null);

// ④ finish 参数
let finArgs = null;
globalThis.__mindKernelFinishGoal = (id, r) => { finArgs = { id, r }; return true; };
plugin._finishGoalForTask({ goalId: 'g-9', state: 'done', tookMs: 1234, startedAt: Date.now() - 5000 });
eq('finish 收到 goalId', finArgs && finArgs.id, 'g-9');
eq('finish ok=true（state=done）', finArgs && finArgs.r.ok, true);
eq('finish wallMs 取 tookMs', finArgs && finArgs.r.wallMs, 1234);
eq('finish steps=1', finArgs && finArgs.r.steps, 1);

// failed 映射
finArgs = null;
plugin._finishGoalForTask({ goalId: 'g-10', state: 'failed', error: 'QUOTA', startedAt: Date.now() - 2000 });
eq('failed 时 ok=false', finArgs && finArgs.r.ok, false);
ok('failed 时带 error 文本', finArgs && /QUOTA/.test(String(finArgs.r.error)));

// 无 goalId 不调用
finArgs = null;
plugin._finishGoalForTask({ state: 'done' });
eq('无 goalId 时不调用钩子', finArgs, null);

// 钩子抛错
globalThis.__mindKernelFinishGoal = () => { throw new Error('kernel boom'); };
plugin._finishGoalForTask({ goalId: 'g-11', state: 'done' });
ok('finish 钩子抛错时不炸派活', true);

delete globalThis.__mindKernelAddGoal;
delete globalThis.__mindKernelFinishGoal;

if (failures.length) {
    console.error('❌ dispatch↔mind-kernel 桥接：FAIL ' + fail + ' / PASS ' + pass);
    for (const f of failures) console.error('   - ' + f);
    process.exit(1);
}
console.log('  ✅ dispatch↔mind-kernel 桥接：PASS ' + pass + ' / FAIL 0');
