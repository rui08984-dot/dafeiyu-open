'use strict';
// local-tts.js —— 随包 edge-tts 单文件 exe 的生命周期
//
// 只服务「安装版」：resources/tts/dafeiyu-tts.exe 存在才动作。
// 开发树/完整部署走 launch-my-neuro.mjs 拉的 Python 服务（9883 已在线），这里只探测、不抢。
//
// 为什么由宿主拉起而不是快捷方式包一层 cmd：
//   · 桌面快捷方式保持双击 → 直接进桌宠，不闪黑框；
//   · 退出时由宿主 taskkill /T 收掉 PyInstaller 的 bootloader + 子进程，
//     不会留下孤儿进程占 9883（这正是 launcher 那一套踩过的坑）。

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const { bundledTtsPath } = require('../core/first-run');

let child = null;
let lastSpawnAt = 0;

function portOpen(port, host = '127.0.0.1', timeoutMs = 700) {
    return new Promise((resolve) => {
        let done = false;
        const socket = net.connect({ port, host });
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { socket.destroy(); } catch (e) { /* ignore */ }
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

/**
 * 确保随包 TTS 在跑。non-blocking：不等待 exe 真正常驻（PyInstaller 首启 1–3s）。
 * @param {{resourcesPath?:string, port?:number, log?:Function}} [opts]
 */
async function startBundledTts(opts = {}) {
    const exe = bundledTtsPath(opts.resourcesPath || process.resourcesPath);
    if (!exe) return { ok: false, reason: 'not-bundled' };
    const port = Number(opts.port || 9883);
    if (await portOpen(port)) return { ok: true, reason: 'already-running', port };
    if (child && child.pid && !child.killed) return { ok: true, reason: 'spawning', pid: child.pid, port };
    // 1.5s 内重复调用只打一次（activate/多窗）
    if (Date.now() - lastSpawnAt < 1500) return { ok: true, reason: 'debounced', port };
    lastSpawnAt = Date.now();

    try {
        child = spawn(exe, ['--port', String(port)], { windowsHide: true, stdio: 'ignore' });
        child.on('error', (e) => {
            const log = typeof opts.log === 'function' ? opts.log : console.warn;
            log('[tts] 随包语音启动失败: ' + (e && e.message || e));
            child = null;
        });
        child.on('exit', (code, signal) => {
            const log = typeof opts.log === 'function' ? opts.log : console.warn;
            if (code !== 0 && code !== null) log(`[tts] 随包语音退出 code=${code}${signal ? ' signal=' + signal : ''}`);
            child = null;
        });
        return { ok: true, reason: 'spawned', pid: child.pid, port };
    } catch (e) {
        child = null;
        return { ok: false, reason: 'spawn-error', error: String(e && e.message || e) };
    }
}

function stopBundledTts() {
    const running = child;
    child = null;
    if (!running || !running.pid) return { ok: true, reason: 'not-running' };
    try {
        spawnSync('taskkill', ['/PID', String(running.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
        return { ok: true, reason: 'killed', pid: running.pid };
    } catch (e) {
        try { running.kill(); } catch (e2) { /* ignore */ }
        return { ok: false, reason: 'kill-error', error: String(e && e.message || e) };
    }
}

module.exports = { portOpen, startBundledTts, stopBundledTts };
