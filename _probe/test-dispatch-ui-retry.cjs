#!/usr/bin/env node
/**
 * _probe/test-dispatch-ui-retry.cjs — B9 派活「重试」判定与接线（2026-11-23）
 *
 * 设计 §4.2：只有 spawn 同步失败（state=failed 且 attempted=false）才允许安全重派；
 * attempted=true 的任务可能已经跑过/还在写盘，重派就是双执行。
 * UI 与 IPC 必须共用同一个判据——本探针盯：
 *   ① canRetry 矩阵（failed/attempted/空正文/未知/取消/运行）
 *   ② buildRetryBody 只带原有参数，不猜 workspace/verify
 *   ③ 控制中心三处接线（main handler / preload / renderer 按钮条件）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const P = require(path.join(APP, 'js', 'core', 'dispatch-retry-policy.js'));

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass += 1; console.log('  ✓ ' + name); }
    else { fail += 1; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
};
const eq = (a, b, name) => ok(a === b, name, JSON.stringify(a) + ' !== ' + JSON.stringify(b));

console.log('test-dispatch-ui-retry');

// ① 判定矩阵
ok(P.canRetry({ state: 'failed', attempted: false, taskText: 'x' }) === true, 'failed + attempted=false 可重试');
ok(P.canRetry({ state: 'failed', attempted: true, taskText: 'x' }) === false, 'failed + attempted=true 不可（防双执行）');
ok(P.canRetry({ state: 'failed', taskText: 'x' }) === false, 'attempted 缺省视为不可（保守）');
ok(P.canRetry({ state: 'failed', attempted: false, taskText: '  ' }) === false, '没有任务正文不可');
ok(P.canRetry({ state: 'done', outcome: 'done_verified', taskText: 'x' }) === false, 'done 不可');
ok(P.canRetry({ state: 'unknown', taskText: 'x' }) === false, 'unknown 不可');
ok(P.canRetry({ state: 'cancelled', taskText: 'x' }) === false, 'cancelled 不可');
ok(P.canRetry({ state: 'running', taskText: 'x' }) === false, 'running 不可');
ok(P.canRetry(null) === false && P.canRetry({}) === false, '空输入不抛且不可');
ok(/attempted=true/.test(P.retryBlockedReason({ state: 'failed', attempted: true, taskText: 'x' })), '禁用原因说明双执行风险');
ok(P.retryBlockedReason({ state: 'failed', attempted: true, taskText: 'x' }).length > 0, '禁用原因非空');

// ② 请求体
const body = P.buildRetryBody(
    { taskText: '跑测试', workspaceAlias: 'pet', verifyCommand: 'npm test', timeoutMs: 120000 },
    { taskId: 'ui-retry-x', requestId: 'ui-retry-x' },
);
eq(body.task, '跑测试', 'body.task=taskText');
eq(body.taskId, 'ui-retry-x', 'body.taskId');
eq(body.requestId, 'ui-retry-x', 'body.requestId');
eq(body.workspace, 'pet', 'body.workspace 透传别名');
eq(body.verify, 'npm test', 'body.verify 透传');
eq(body.timeoutMs, 120000, 'body.timeoutMs 透传');
const bare = P.buildRetryBody({ taskText: 'x' }, { taskId: 'id' });
ok(!('workspace' in bare) && !('verify' in bare) && !('timeoutMs' in bare), '缺省参数不猜（不写空 workspace/verify）');
const id1 = P.makeRetryTaskId(1);
const id2 = P.makeRetryTaskId(1);
ok(/^ui-retry-/.test(id1) && id1 !== id2, '重试 id 前缀正确且不重复');

// ③ 接线
const main = fs.readFileSync(path.join(APP, 'control-main.js'), 'utf8');
ok(/ipcMain\.handle\('control:dispatch-retry'/.test(main), 'control-main 注册 dispatch-retry');
ok(/dispatch-retry-policy\.js/.test(main), 'control-main 复用统一策略模块');
ok(/path: '\/dispatch', method: 'POST'/.test(main), 'control-main 重试走 POST /dispatch');
ok(/setTimeout\(\(\) => done\(\{ ok: true, taskId, accepted: true \}\), 700\)/.test(main), '不阻塞到任务结束（700ms 接受）');
const preload = fs.readFileSync(path.join(APP, 'control-preload.js'), 'utf8');
ok(/dispatchRetry:/.test(preload), 'preload 暴露 dispatchRetry');
const renderer = fs.readFileSync(path.join(APP, 'control-v2-renderer.js'), 'utf8');
ok(/t\.state === 'failed' && t\.attempted === false/.test(renderer), 'renderer 只在安全失败态显示重试');
ok(/重试（未执行过）/.test(renderer), '重试按钮文案说明未执行过');

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + '/' + (pass + fail));
process.exitCode = fail === 0 ? 0 : 1;
