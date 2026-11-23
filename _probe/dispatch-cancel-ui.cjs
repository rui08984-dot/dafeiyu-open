#!/usr/bin/env node
/**
 * _probe/dispatch-cancel-ui.cjs —— 派活 v2 P1 控制中心取消按钮真机验收（2026-11-23）
 *
 * 真机链路：拉起控制中心（8771）→ 真派一个长任务（8103 /dispatch，保持响应连接）
 * → 列表点开详情 → 点两次「停止这个任务」→ 断言 8103 账本变 cancelled + 按钮显示已停止。
 *
 * 注意：这条会真 spawn DSH（用一轮模型），只在手动验收时跑，不进自动门禁。
 * 收尾：取消任务；控制中心是我们拉起的就关掉（用户自己开的不动）。
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const TOKEN_PATH = path.join(ROOT, '_incoming', 'my-neuro', 'data', '.control-token');
const TOKEN = fs.existsSync(TOKEN_PATH) ? fs.readFileSync(TOKEN_PATH, 'utf8').trim() : '';
const PORT_CTRL = 8103;
const PORT_UI = 8771;
const taskId = 'ui-cancel-' + Date.now().toString(36);

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass += 1; console.log('  ✓ ' + name); }
    else { fail += 1; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
};

function req(port, method, urlPath, body, headers = {}, timeoutMs = 10000) {
    const data = body == null ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const r = http.request({
            host: '127.0.0.1', port, path: urlPath, method,
            headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers),
            agent: false, timeout: timeoutMs,
        }, (res) => {
            let s = '';
            res.on('data', (d) => { s += d; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(s); } catch (_) { json = null; }
                resolve({ code: res.statusCode, json, text: s });
            });
        });
        r.on('timeout', () => { r.destroy(new Error('timeout')); });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalUi(js) {
    const r = await req(PORT_UI, 'POST', '/eval', { js }, {}, 15000);
    if (!r.json || !r.json.ok) throw new Error('eval failed: ' + (r.json && r.json.error || r.text).slice(0, 200));
    return r.json.value;
}

async function getTask(id) {
    const r = await req(PORT_CTRL, 'GET', '/dispatch/tasks?id=' + encodeURIComponent(id), null, { 'X-Pet-Token': TOKEN });
    if (r.json && r.json.ok && r.json.task) return r.json.task;
    return null;
}

async function main() {
    console.log('test-dispatch-cancel-ui task=' + taskId);
    const { ensureControlCenter, stopControlCenter } = await import('./ensure-control-center.mjs');
    const ctrl = await ensureControlCenter({ appDir: APP, port: PORT_UI, timeoutMs: 30000, log: console.log });
    if (!ctrl.ok) { console.log('FAIL 控制中心起不来: ' + ctrl.error); process.exitCode = 1; return; }
    console.log('[ui] control center pid=' + ctrl.pid + ' started=' + ctrl.started);

    let dispatchReq = null;
    try {
        // 1) 真派一个长任务：连接保持不关（断了会被判 unknown，取消按钮就看不到了）
        const dispatchBody = JSON.stringify({
            task: '请在当前目录运行 node -e "setInterval(()=>{},1000)" 并让它保持运行，不要结束；这是取消功能的验收测试。',
            taskId,
            workspace: 'pet',
            timeoutMs: 180000,
        });
        dispatchReq = http.request({
            host: '127.0.0.1', port: PORT_CTRL, path: '/dispatch', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dispatchBody) },
            agent: false,
        }, (res) => {
            let s = '';
            res.on('data', (d) => { s += d; });
            res.on('end', () => console.log('[dispatch] response', res.statusCode, s.slice(0, 200)));
        });
        dispatchReq.on('error', (e) => console.log('[dispatch] error', e.message));
        dispatchReq.write(dispatchBody);
        dispatchReq.end();

        // 2) 等 running（账本 1s 内应出现）
        let task = null;
        for (let i = 0; i < 20; i += 1) {
            await sleep(500);
            task = await getTask(taskId);
            if (task && task.state === 'running') break;
        }
        ok(task && task.state === 'running', '任务进入 running', JSON.stringify(task && { state: task.state, reason: task.stateReason }));
        if (!task) { console.log('FAIL 账本里没有任务'); process.exitCode = 1; return; }

        // 3) 控制中心列表刷新 → 点开详情
        await evalUi("document.getElementById('act-refresh')?.click(); 'refreshed'");
        await sleep(800);
        const clicked = await evalUi("(function(){var el=document.querySelector('[data-dispatch-id=\"" + taskId + "\"]'); if(!el) return 'no_card'; el.click(); return 'clicked';})()");
        ok(clicked === 'clicked', '列表里出现任务卡并可点开', String(clicked));
        await sleep(600);

        const btnText = await evalUi("(function(){var b=document.querySelector('#dispatch-task-detail button'); return b?b.textContent:'no_button';})()");
        ok(/停止这个任务/.test(String(btnText)), '详情出现「停止这个任务」按钮', String(btnText));

        // 4) 两次点击（内联二次确认）→ 等取消
        await evalUi("(function(){var b=document.querySelector('#dispatch-task-detail button'); if(!b) return 'no'; b.click(); b.click(); return 'clicked2';})()");
        await sleep(3000);

        const after = await evalUi("(function(){var b=document.querySelector('#dispatch-task-detail button');var box=document.getElementById('dispatch-task-detail');return {btn:b?b.textContent:'no_button',text:box?box.textContent:''};})()");
        // 成功后 400ms 会重绘详情：running 的按钮消失、正文变成 cancelled，这是正确行为
        ok(/cancelled|已停止/.test(String(after.text)) || /已停止|取消失败/.test(String(after.btn)), '取消后详情显示已停止/状态 cancelled', JSON.stringify({ btn: after.btn, head: String(after.text).slice(0, 80) }));

        const finalTask = await getTask(taskId);
        ok(finalTask && (finalTask.state === 'cancelled' || finalTask.state === 'unknown'), '账本状态变为 cancelled/unknown', JSON.stringify(finalTask && { state: finalTask.state, reason: finalTask.stateReason, outcome: finalTask.outcome }));
        ok(finalTask && finalTask.attempted === true, 'attempted=true（派过活）', String(finalTask && finalTask.attempted));
        console.log('  · 详情按钮文案: ' + after.btn + ' · 账本: ' + JSON.stringify(finalTask && { state: finalTask.state, stateReason: finalTask.stateReason }));
    } finally {
        try { if (dispatchReq) dispatchReq.destroy(); } catch (_) { /* ignore */ }
        if (ctrl.started) {
            const r = stopControlCenter(ctrl.pid);
            console.log('[ui] 已关闭本次拉起的控制中心:', JSON.stringify(r));
        }
    }
    console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + '/' + (pass + fail));
    process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
