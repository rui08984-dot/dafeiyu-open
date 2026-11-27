#!/usr/bin/env node
/**
 * _probe/test-components-services.cjs —— 本地服务监管（启动/健康/占用跳过/停止）
 *
 * 用 node 自己当被监管进程（临时端口 + 临时 components 目录），不碰真实服务。
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const services = require(path.join(LIVE, 'js', 'components', 'services.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}
function get(url) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: 1500 }, (res) => { let b = ''; res.on('data', (d) => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    });
}
function portOpen(port) { return services.portOpen(port, '127.0.0.1', 500); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-svc-'));
    const root = path.join(tmp, 'install');
    const cdir = path.join(root, 'components');
    fs.mkdirSync(cdir, { recursive: true });
    const port = await freePort();
    const script = 'require("http").createServer((q,s)=>s.end("ok")).listen(' + port + ',"127.0.0.1")';
    const spec = {
        id: 'demo-svc',
        port,
        cmd: [process.execPath, '-e', script],
        cwd: cdir,
        health: { url: 'http://127.0.0.1:' + port + '/', timeoutMs: 800 },
        startTimeoutMs: 8000,
        autoRestart: false,
    };
    fs.writeFileSync(path.join(cdir, 'services.json'), JSON.stringify({ schema: 1, services: [spec] }, null, 2), 'utf8');

    const r1 = await services.startAll({ root, log: () => {} });
    ok('startAll 返回成功', r1.ok && r1.services === 1);
    await sleep(300);
    const health = await get('http://127.0.0.1:' + port + '/');
    ok('服务健康检查可达', health.status === 200 && health.body === 'ok', `status=${health.status}`);
    const st1 = services.status();
    ok('status 报告 ready', st1.length === 1 && st1[0].ready === true, JSON.stringify(st1));
    ok('端口在监听', await portOpen(port));

    // 再 startAll：端口已占用 → 跳过，不重复启动
    const r2 = await services.startAll({ root, log: () => {} });
    await sleep(200);
    ok('二次 startAll 不重复启动', services.status().length === 1, JSON.stringify(services.status()));

    services.stopAll();
    await sleep(800);
    ok('stopAll 后端口关闭', !(await portOpen(port)));

    // 端口已被别人占用 → 跳过（不抢）
    const busy = net.createServer();
    await new Promise((r) => busy.listen(0, '127.0.0.1', r));
    const busyPort = busy.address().port;
    fs.writeFileSync(path.join(cdir, 'services.json'), JSON.stringify({
        schema: 1,
        services: [Object.assign({}, spec, { id: 'busy-svc', port: busyPort, health: { url: 'http://127.0.0.1:' + busyPort + '/', timeoutMs: 500 } })],
    }, null, 2), 'utf8');
    await services.startAll({ root, log: () => {} });
    await sleep(300);
    ok('端口占用时跳过启动', !services.status().some((s) => s.id === 'busy-svc'), JSON.stringify(services.status()));
    await new Promise((r) => busy.close(r));
    services.stopAll();

    // services.json 缺失 → 0 服务，不报错
    fs.unlinkSync(path.join(cdir, 'services.json'));
    const r3 = await services.startAll({ root, log: () => {} });
    ok('无 services.json 时返回 0 服务', r3.ok && r3.services === 0);
    services.stopAll();

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'}：${pass} 过 / ${fail} 失败`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试自身异常：', e && e.stack || e); process.exit(1); });
