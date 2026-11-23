#!/usr/bin/env node
/**
 * _probe/test-dispatch-followup-policy.cjs —— 「继续聊」闸门/文案/接线回归（2026-11-23）
 *
 * 病根：派活详情以前只在 running/stale 时给取消、失败时给重试；续聊端点
 * POST 8103 /dispatch/followup 已就绪，但 UI 没有任何入口。这里锁住四件事：
 *   ① 闸门与后端 followupDispatchTask 同源：终态(done/failed/cancelled)+sessionId 才允许；
 *      running/cancelling/unknown 一律拦住（unknown 可能还在跑，续聊会双执行）；
 *   ② 失配/回退的文案必须是「没接上原会话，已带上下文重开」，不能只报成功；
 *   ③ 请求体只带 {taskId, task, newTaskId}，空正文/超长在本地就拒绝；
 *   ④ 接线没断：control-main IPC（8s 窗口、不 destroy）、preload 桥、renderer 调用、
 *      control-v2.html 先加载同一份策略。
 *
 * 只读文件 + 用 electron 桩加载 control-main；不联网、不写真实记录室。
 *
 * 用法：node _probe/test-dispatch-followup-policy.cjs
 * 退出码：0 = PASS，1 = FAIL
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const P = require(path.join(APP, 'js', 'core', 'dispatch-followup-policy.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}

console.log('派活「继续聊」策略回归');
console.log('');

// ── ① 闸门 ────────────────────────────────────────────────────────────────
console.log('闸门（与 8103 followupDispatchTask 对齐）');
ok('done + sessionId → 允许', P.isFollowupEligible({ state: 'done', sessionId: 'sess-1' }));
ok('failed + sessionId → 允许', P.isFollowupEligible({ state: 'failed', sessionId: 'sess-1' }));
ok('cancelled + sessionId → 允许（后端也把 cancelled 当终态）',
    P.isFollowupEligible({ state: 'cancelled', sessionId: 'sess-1' }));
ok('done_unproven 是 outcome，state=done → 允许',
    P.isFollowupEligible({ state: 'done', outcome: 'done_unproven', sessionId: 'sess-1' }));
ok('done 无 sessionId → 拒绝', !P.isFollowupEligible({ state: 'done', sessionId: '' }));
ok('done 无 sessionId 的原因提到会话', /会话 id/.test(P.followupBlockedReason({ state: 'done' })),
    P.followupBlockedReason({ state: 'done' }));
ok('running → 拒绝', !P.isFollowupEligible({ state: 'running', sessionId: 'sess-1' }));
ok('running 的原因提到还在跑', /还在跑/.test(P.followupBlockedReason({ state: 'running', sessionId: 's' })));
ok('cancelling → 拒绝', !P.isFollowupEligible({ state: 'cancelling', sessionId: 'sess-1' }));
ok('unknown → 拒绝', !P.isFollowupEligible({ state: 'unknown', sessionId: 'sess-1' }));
ok('unknown 的原因提到结果未知', /结果未知/.test(P.followupBlockedReason({ state: 'unknown', sessionId: 's' })));
ok('空任务 → 拒绝', !P.isFollowupEligible(null) && !P.isFollowupEligible({}));
ok('终态白名单只有三个', P.TERMINAL_STATES.join(',') === 'done,failed,cancelled', P.TERMINAL_STATES.join(','));
// 与后端唯一真源对比：账本 TERMINAL_STATES 改了而这里没跟 → 立刻红
const ledgerSrc = read('petbridge/dispatch-ledger.mjs');
const backendTerm = (() => {
    const m = /TERMINAL_STATES = Object\.freeze\(\[([^\]]+)\]\)/.exec(ledgerSrc);
    return m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
})();
ok('终态白名单与 dispatch-ledger 同源',
    backendTerm.length === 3 && P.TERMINAL_STATES.join(',') === backendTerm.join(','),
    'UI=' + P.TERMINAL_STATES.join(',') + ' 后端=' + backendTerm.join(','));

// ── ② 请求体 ──────────────────────────────────────────────────────────────
console.log('');
console.log('请求体');
const built = P.buildFollowupRequest('task-1', '  接着修测试  ', 'ui-followup-x');
ok('合法请求裁剪正文', built.ok && built.body.task === '接着修测试', JSON.stringify(built.body));
ok('只带三个键', built.ok && Object.keys(built.body).sort().join(',') === 'newTaskId,task,taskId',
    built.ok ? Object.keys(built.body).join(',') : 'not ok');
ok('空正文 → empty_task', P.buildFollowupRequest('t', '   ', 'n').error === 'empty_task');
ok('缺父 id → missing_task_id', P.buildFollowupRequest('', 'x', 'n').error === 'missing_task_id');
ok('超 20000 字 → task_too_long', P.buildFollowupRequest('t', 'x'.repeat(20001), 'n').error === 'task_too_long');
const genId = P.makeFollowupTaskId(1750000000000, 0.123456);
ok('生成的子任务 id 带 ui-followup 前缀且可作文件名',
    /^ui-followup-[a-z0-9]+-[a-z0-9]{1,4}$/.test(genId), genId);
ok('默认生成的 id 也不同', P.makeFollowupTaskId() !== P.makeFollowupTaskId());

// ── ③ 回执文案（失配必须明说）────────────────────────────────────────────
console.log('');
console.log('回执文案');
const reused = P.describeFollowupOutcome({ state: 'done', sessionReused: true });
ok('接上会话 → 已续聊（会话接上了）', reused.level === 'ok' && reused.message.includes('会话接上了'), reused.message);
const mismatch = P.describeFollowupOutcome({ state: 'done', sessionMismatch: true });
ok('sessionMismatch → 没接上原会话，已带上下文重开',
    mismatch.level === 'warn' && mismatch.message.includes('没接上原会话，已带上下文重开'), mismatch.message);
const fallback = P.describeFollowupOutcome({ state: 'done', fallback: true });
ok('fallback → 同一句失配文案', fallback.message.includes('没接上原会话，已带上下文重开'), fallback.message);
const fbFailed = P.describeFollowupOutcome({ state: 'failed', fallback: true, error: 'verify 失败' });
ok('回退后仍失败 → 先说没接上，再说失败', fbFailed.level === 'error'
    && fbFailed.message.includes('没接上原会话，已带上下文重开')
    && fbFailed.message.includes('verify 失败'), fbFailed.message);
const spawnFailed = P.describeFollowupOutcome({ state: 'failed', attempted: false, error: 'spawn ENOENT' });
ok('启动失败 → 续聊没启动', spawnFailed.level === 'error' && spawnFailed.message.includes('续聊没启动'), spawnFailed.message);
const unknown = P.describeFollowupOutcome({ state: 'unknown' });
ok('unknown → 结果未知/别重复', unknown.level === 'warn' && /结果未知/.test(unknown.message), unknown.message);
const noSessionBack = P.describeFollowupOutcome({ state: 'done' });
ok('完成但没回传 session → 如实说没确认', noSessionBack.message.includes('没能确认接上原会话'), noSessionBack.message);
const pending = P.describeFollowupPending('ui-followup-abc');
ok('8s 未结束 → 已派出 + 子任务 id', pending.level === 'ok'
    && pending.message.includes('已派出续聊') && pending.message.includes('ui-followup-abc'), pending.message);

// ── ④ 接线（静态 + electron 桩）───────────────────────────────────────────
console.log('');
console.log('接线');
const mainSrc = read('control-main.js');
const preloadSrc = read('control-preload.js');
const rendererSrc = read('control-v2-renderer.js');
const htmlSrc = read('control-v2.html');
ok('control-main 注册 control:dispatch-followup',
    mainSrc.includes("ipcMain.handle('control:dispatch-followup'"));
ok('control-main POST /dispatch/followup', mainSrc.includes("path: '/dispatch/followup'"));
ok('control-main 带 X-Pet-Token', /readOrCreatePetControlToken\(\)[\s\S]{0,1200}X-Pet-Token/.test(mainSrc)
    || /X-Pet-Token[\s\S]{0,1200}readOrCreatePetControlToken/.test(mainSrc));
const followupBlock = (() => {
    const start = mainSrc.indexOf("ipcMain.handle('control:dispatch-followup'");
    if (start < 0) return '';
    const end = mainSrc.indexOf('app.whenReady()', start);
    return mainSrc.slice(start, end > 0 ? end : mainSrc.length);
})();
ok('IPC 8s 窗口', /setTimeout\([\s\S]{0,120}8000\)/.test(followupBlock), 'setTimeout(...8000)');
ok('IPC 不 destroy 连接（destroy 会被服务端判 unknown）', !/req\.destroy|req\.abort/.test(followupBlock));
ok('IPC 用同一份策略闸门', followupBlock.includes("require('./js/core/dispatch-followup-policy.js')")
    && followupBlock.includes('followupBlockedReason'));
const vtsSrc = read('petbridge/vts-server.mjs');
ok('后端 followup 准入同两个条件（终态 + sessionId）',
    /isTerminalState\(parent\.state\)/.test(vtsSrc) && /parent\.sessionId/.test(vtsSrc));
ok('preload 暴露 dispatchFollowup', preloadSrc.includes('dispatchFollowup:'));
ok('renderer 调用 api.dispatchFollowup', rendererSrc.includes('api.dispatchFollowup('));
ok('renderer 用 followupBlockedReason 决定按钮', rendererSrc.includes('P.followupBlockedReason(t)'));
ok('renderer 用 describeFollowupOutcome / Pending', rendererSrc.includes('P.describeFollowupOutcome(')
    && rendererSrc.includes('P.describeFollowupPending('));
ok('control-v2.html 在 renderer 前加载策略脚本',
    htmlSrc.indexOf('js/core/dispatch-followup-policy.js') > -1
    && htmlSrc.indexOf('js/core/dispatch-followup-policy.js') < htmlSrc.indexOf('control-v2-renderer.js'));

// electron 桩：只验「闸门在 IPC 里真的生效」（不触发 HTTP）
function loadControlMainWithHandlers() {
    const handlers = new Map();
    const fakeElectron = {
        app: {
            commandLine: { getSwitchValue: () => '', appendSwitch: () => {} },
            on: () => {},
            quit: () => {},
            whenReady: () => ({ then: () => {} }),
            requestSingleInstanceLock: () => true,
            setPath: () => {},
        },
        BrowserWindow: class { static getAllWindows() { return []; } },
        ipcMain: { handle: (name, fn) => { handlers.set(name, fn); } },
        shell: {},
        net: {},
        dialog: {},
        screen: { getAllDisplays: () => [] },
    };
    const origLoad = Module._load;
    Module._load = function (request) {
        if (request === 'electron') return fakeElectron;
        return origLoad.apply(this, arguments);
    };
    try {
        require(path.join(APP, 'control-main.js'));
        return handlers;
    } finally {
        Module._load = origLoad;
    }
}

let handlers = null;
let loadError = null;
try { handlers = loadControlMainWithHandlers(); } catch (e) { loadError = e; }
if (ok('control-main 可被桩加载', !!handlers, loadError ? String(loadError.message) : '')) {
    const handler = handlers.get('control:dispatch-followup');
    ok('桩里拿到 followup handler', typeof handler === 'function');
    if (typeof handler === 'function') {
        (async () => {
            const running = await handler({}, { taskId: 'task-1', task: 'x', parent: { state: 'running', sessionId: 's' } });
            ok('IPC 拒绝 running（本地闸门）', running.ok === false && running.blocked === true, JSON.stringify(running));
            ok('IPC 拒绝 running 时说明原因', /还在跑/.test(String(running.error)), String(running.error));
            const noSess = await handler({}, { taskId: 'task-1', task: 'x', parent: { state: 'done', sessionId: '' } });
            ok('IPC 拒绝无 sessionId', noSess.ok === false && /会话 id/.test(String(noSess.error)), String(noSess.error));
            const empty = await handler({}, { taskId: 'task-1', task: '   ', parent: { state: 'done', sessionId: 's' } });
            ok('IPC 拒绝空正文并给提示', empty.ok === false && empty.error === 'empty_task'
                && /接着做什么/.test(String(empty.hint)), JSON.stringify(empty));
            finish();
        })().catch((e) => { ok('异步断言未抛错', false, String(e && e.stack || e)); finish(); });
    } else {
        finish();
    }
} else {
    finish();
}

function finish() {
    console.log('');
    console.log(`结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
}
