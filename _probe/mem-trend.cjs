#!/usr/bin/env node
/**
 * _probe/mem-trend.cjs — 渲染进程内存趋势采样（2026-11-15 五十八轮）
 *
 * 为什么：2026-11-14 00:19 渲染进程静默崩溃，Windows 没记事件、当时也没开 crashReporter
 * （历史异常码取不回来）。只能从「有没有内存失控」这条线索反推：
 *   · JS 堆一路涨 = 泄漏（能定位到具体缓冲）
 *   · JS 堆平、RSS 涨 = native 侧（WebGL 纹理 / 解码）
 *   · 两者都平 = 那次崩溃不是内存，得另找（GPU / 竞态 / 驱动）
 *
 * 用法：node _probe/mem-trend.cjs [采样次数] [间隔秒]
 * 输出：每行一个 CSV 点 + 末尾趋势结论（判定 0=平 1=在涨）
 */
'use strict';

const http = require('http');

const ROUNDS = Number(process.argv[2] || 10);
const GAP_MS = Number(process.argv[3] || 30000) * 1000;

function post(port, path, body, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const data = Buffer.from(JSON.stringify(body), 'utf8');
        const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', timeout: timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
            let out = '';
            res.on('data', (c) => { out += c; });
            res.on('end', () => resolve({ ok: res.statusCode === 200, body: out }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: 'timeout' }); });
        req.on('error', (e) => resolve({ ok: false, body: String(e && e.message || e) }));
        req.write(data);
        req.end();
    });
}

function get(port, path, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs }, (res) => {
            let out = '';
            res.on('data', (c) => { out += c; });
            res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { resolve(null); } });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

async function jsHeap() {
    const r = await post(8004, '/eval', { js: '(function(){var m=performance.memory||{};return Math.round((m.usedJSHeapSize||0)/1048576);})()' });
    if (!r.ok) return null;
    try { const j = JSON.parse(r.body); return Number(j.value) || 0; } catch (e) { return null; }
}

async function hostRss() {
    // 主进程侧看不到渲染进程 RSS，靠 /health 的 renderer 判据 + 进程表（由外层 pwsh 采）
    const h = await get(8103, '/health');
    return h && h.renderer ? h.renderer.state : null;
}

(async () => {
    const points = [];
    for (let i = 0; i < ROUNDS; i += 1) {
        const used = await jsHeap();
        const state = await hostRss();
        points.push({ t: new Date().toISOString().slice(11, 19), usedMB: used, renderer: state });
        console.log(points[points.length - 1].t + ',' + (used == null ? '' : used) + ',' + (state || ''));
        if (i < ROUNDS - 1) await new Promise((r) => setTimeout(r, GAP_MS));
    }
    const nums = points.map((p) => p.usedMB).filter((n) => typeof n === 'number' && n > 0);
    if (nums.length < 3) { console.log('数据不足，无法判趋势'); process.exit(0); }
    const first = nums[0];
    const last = nums[nums.length - 1];
    const max = Math.max(...nums);
    const min = Math.min(...nums);
    const growth = last - first;
    console.log('\n首发 ' + first + 'MB · 末发 ' + last + 'MB · 峰值 ' + max + 'MB · 谷值 ' + min + 'MB · 增量 ' + (growth >= 0 ? '+' : '') + growth + 'MB');
    // 判据：末发 - 首发 > 15% 且 > 20MB = 在涨（泄漏）；否则平
    const leaking = growth > 20 && last > first * 1.15;
    console.log(leaking ? '趋势：在涨（疑似泄漏）' : '趋势：平（不是持续性泄漏）');
    process.exit(leaking ? 1 : 0);
})();
