'use strict';
// js/components/services.js —— 本地服务监管（2026-11-27 v0.4.0）
//
// 读 components/services.json（组件管理器物化），随宿主启动/停止：
//   嵌入 8090 → MemOS 8003 → LumenAct 8120 → ASR 1000 → 一起看 1001 → 声纹 8020
// 设计要点：
//   · 端口已占用就跳过（开发树/用户自己开的服务不抢）；
//   · 有 health 的等健康检查通过再算 ready；没有 health 的给 1.5s 预热；
//   · 崩了按 3/10/30/60s 退避重启，最多 5 次；退出时 taskkill /T 收掉整棵树；
//   · 监听 services.json 变化：装完组件不用重启宿主。
// 纯 Node（Electron 主进程里 require），不依赖 Electron API。

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const manager = require('./manager');

const LOG_MAX = 5 * 1024 * 1024;
const MAX_RESTARTS = 5;
const BACKOFF_MS = [3000, 10000, 30000, 60000];

const children = new Map(); // id -> { spec, child, restarts, ready, stopping, timer, logStream }
let polling = null;
let lastServicesMtime = 0;
let started = false;
let currentLog = (m) => console.log(m);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function portOpen(port, host = '127.0.0.1', timeoutMs = 600) {
    return new Promise((resolve) => {
        let done = false;
        const socket = net.connect({ port, host });
        const finish = (ok) => { if (done) return; done = true; try { socket.destroy(); } catch (e) {} resolve(ok); };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

function healthOk(url, timeoutMs = 1500) {
    return new Promise((resolve) => {
        if (!url) return resolve(true);
        let req;
        try {
            req = http.get(url, { timeout: timeoutMs }, (res) => {
                res.resume();
                resolve(res.statusCode >= 200 && res.statusCode < 500);
            });
        } catch (e) { return resolve(false); }
        req.on('error', () => resolve(false));
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(false); });
    });
}

function componentsRoot(root) { return manager.componentsDir(root || manager.installRoot()); }
function servicesFile(root) { return path.join(componentsRoot(root), 'services.json'); }

function loadServices(root) {
    const file = servicesFile(root);
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return []; }
    const list = Array.isArray(doc && doc.services) ? doc.services : [];
    return list.slice().sort((a, b) => (a.order || 100) - (b.order || 100));
}

function openLog(id) {
    const dir = path.join(componentsRoot(), 'logs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    const file = path.join(dir, id + '.log');
    try {
        if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX) {
            try { fs.unlinkSync(file + '.1'); } catch (e) { /* ignore */ }
            try { fs.renameSync(file, file + '.1'); } catch (e) { /* ignore */ }
        }
    } catch (e) { /* ignore */ }
    try { return fs.createWriteStream(file, { flags: 'a' }); } catch (e) { return null; }
}

function spawnService(spec) {
    const env = Object.assign({}, process.env, spec.env || {});
    // 服务 stdout/stderr 全部落盘：安装版没有控制台可看
    env.PYTHONUNBUFFERED = '1';
    env.PYTHONIOENCODING = env.PYTHONIOENCODING || 'utf-8';
    // PATH 用「前插」而不是整条替换：保留系统 PATH，组件解释器优先
    if (env.PATH_PREPEND) {
        env.PATH = String(env.PATH_PREPEND) + ';' + String(process.env.PATH || '');
        delete env.PATH_PREPEND;
    }
    const child = spawn(spec.cmd[0], spec.cmd.slice(1), {
        cwd: spec.cwd || undefined,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logStream = openLog(spec.id);
    if (logStream) {
        child.stdout.on('data', (d) => logStream.write(d));
        child.stderr.on('data', (d) => logStream.write(d));
        logStream.on('error', () => { /* 日志写失败不影响服务 */ });
    }
    return { child, logStream };
}

async function startOne(spec, opts = {}) {
    const log = opts.log || currentLog;
    if (!spec || !spec.id || !Array.isArray(spec.cmd) || !spec.cmd.length) return { ok: false, skipped: true, reason: 'bad-spec' };
    if (children.has(spec.id)) {
        const cur = children.get(spec.id);
        if (cur.child && cur.child.exitCode === null) return { ok: true, skipped: true, reason: 'already-started' };
        children.delete(spec.id);
    }
    if (spec.port && await portOpen(spec.port)) {
        log('[components] ' + spec.id + ' 端口 ' + spec.port + ' 已在监听，跳过（不抢别人的服务）');
        return { ok: true, skipped: true, reason: 'port-in-use' };
    }
    log('[components] 启动 ' + spec.id + (spec.port ? ' (:' + spec.port + ')' : '') + ' …');
    let spawned;
    try { spawned = spawnService(spec); } catch (e) {
        log('[components] ' + spec.id + ' 启动失败: ' + (e && e.message || e));
        return { ok: false, error: String(e && e.message || e) };
    }
    const rec = { spec, child: spawned.child, logStream: spawned.logStream, restarts: 0, ready: false, stopping: false, timer: null };
    children.set(spec.id, rec);

    // 健康等待（有 health 才等；没有 health 给 1.5s 预热）
    const deadline = Date.now() + (spec.startTimeoutMs || 45000);
    if (spec.health && spec.health.url) {
        while (Date.now() < deadline && !rec.stopping) {
            if (spawned.child.exitCode !== null) break;
            if (await healthOk(spec.health.url, spec.health.timeoutMs || 1500)) { rec.ready = true; break; }
            await sleep(1000);
        }
    } else {
        await sleep(1500);
        rec.ready = spawned.child.exitCode === null;
    }
    if (rec.ready) log('[components] ' + spec.id + ' ready' + (spec.port ? ' (:' + spec.port + ')' : ''));
    else log('[components] ' + spec.id + ' 未在 ' + Math.round((spec.startTimeoutMs || 45000) / 1000) + 's 内就绪（进程' + (spawned.child.exitCode === null ? '仍在' : '已退出') + '，日志见 components/logs/' + spec.id + '.log）');

    spawned.child.on('exit', (code, signal) => {
        rec.ready = false;
        try { rec.logStream && rec.logStream.end(); } catch (e) { /* ignore */ }
        if (rec.stopping || !started) return;
        log('[components] ' + spec.id + ' 退出 code=' + code + (signal ? ' signal=' + signal : ''));
        if (spec.autoRestart === false) return;
        if (rec.restarts >= MAX_RESTARTS) { log('[components] ' + spec.id + ' 重启次数达上限，放弃'); return; }
        const wait = BACKOFF_MS[Math.min(rec.restarts, BACKOFF_MS.length - 1)];
        rec.restarts += 1;
        rec.timer = setTimeout(() => {
            if (!started) return;
            children.delete(spec.id);
            startOne(spec, { log }).catch((e) => log('[components] ' + spec.id + ' 重启失败: ' + (e && e.message || e)));
        }, wait);
        log('[components] ' + spec.id + ' ' + (wait / 1000) + 's 后重启（第 ' + rec.restarts + ' 次）');
    });
    spawned.child.on('error', (e) => log('[components] ' + spec.id + ' spawn error: ' + (e && e.message || e)));
    return { ok: true, ready: rec.ready, pid: spawned.child.pid };
}

function stopOne(id) {
    const rec = children.get(id);
    if (!rec) return;
    rec.stopping = true;
    if (rec.timer) clearTimeout(rec.timer);
    const pid = rec.child && rec.child.pid;
    if (pid) {
        try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }); } catch (e) { /* ignore */ }
    }
    try { rec.logStream && rec.logStream.end(); } catch (e) { /* ignore */ }
    children.delete(id);
}

async function startAll(opts = {}) {
    currentLog = typeof opts.log === 'function' ? opts.log : currentLog;
    started = true;
    const root = opts.root || manager.installRoot();
    const list = loadServices(root);
    if (!list.length) return { ok: true, services: 0 };
    for (const spec of list) {
        if (!started) break;
        // 顺序启动：前一个就绪再下一个（MemOS 依赖 8090 嵌入）
        await startOne(spec, { log: currentLog });
    }
    watch(root);
    return { ok: true, services: list.length };
}

function stopAll() {
    started = false;
    if (polling) { clearInterval(polling); polling = null; }
    for (const id of Array.from(children.keys())) stopOne(id);
}

function watch(root) {
    if (polling) return;
    const file = servicesFile(root);
    try { lastServicesMtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0; } catch (e) { lastServicesMtime = 0; }
    polling = setInterval(async () => {
        try {
            if (!fs.existsSync(file)) return;
            const m = fs.statSync(file).mtimeMs;
            if (m === lastServicesMtime) return;
            lastServicesMtime = m;
            currentLog('[components] services.json 已更新，启动新增服务…');
            const list = loadServices(root);
            for (const spec of list) {
                if (!started) break;
                if (children.has(spec.id)) continue;
                await startOne(spec, { log: currentLog });
            }
        } catch (e) { /* ignore */ }
    }, 5000);
    if (polling.unref) polling.unref();
}

function status() {
    const out = [];
    for (const [id, rec] of children.entries()) {
        out.push({ id, pid: rec.child && rec.child.pid, ready: rec.ready, restarts: rec.restarts, port: rec.spec.port || null });
    }
    return out;
}

module.exports = { startAll, stopAll, startOne, stopOne, status, loadServices, portOpen, healthOk };
