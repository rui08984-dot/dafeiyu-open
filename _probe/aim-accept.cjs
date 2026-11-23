#!/usr/bin/env node
/**
 * _probe/aim-accept.cjs — aim 闭环验收（2026-11-15 六十轮）
 *
 * 这是 §40.2 里唯一「差一步」的 P0：aim 规则接 Mod 事实后，转完到底有没有对上？
 * 验收要看的不是「发了 move_rel」，而是**转完 yawDelta 是否 →0**。
 *
 * 两段式（因为游戏窗口不能由我来起 —— 铁律：不许自己弹游戏窗）：
 *   ① 纯数学段（永远跑）：computeAim 的符号/量级/增益/stale/缺数据/pitch
 *   ② 闭环段（需要 MC 在前台 + Mod 8123 通）：读 yawDelta → move_rel → 回读 yawDelta → 判定
 *      环境不满足时打印 BLOCKED 并**以退出码 0 结束**（这不是数学失败，是环境没就绪）
 *
 * 用法：
 *   node _probe/aim-accept.cjs            # 默认：只跑数学段（不动鼠标）
 *   node _probe/aim-accept.cjs --live     # 真跑闭环（会发 move_rel；要求 MC 在前台）
 *   node _probe/aim-accept.cjs --tolerance 3   # 闭环判定的容差（度，默认 2）
 *
 * 闭环段通过 8004 /eval 在**她的进程里**跑（FactStore 与 game-loop 都在那儿）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const GL = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'game-loop.js'));

// 安全默认：默认**只跑数学段**。真发 move_rel 会动鼠标，必须显式 --live。
const LIVE = process.argv.includes('--live');
const MATH_ONLY = !LIVE;
const tolIdx = process.argv.indexOf('--tolerance');
const TOL = tolIdx >= 0 ? Number(process.argv[tolIdx + 1]) : 2;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

/** 造一个和 FactStore 同形状的最小 Map（computeAim 只调 .get） */
function mkFacts(pairs) {
    const m = new Map();
    for (const [k, v] of Object.entries(pairs || {})) m.set(k, v);
    return m;
}

function httpPost(port, pathname, body, timeoutMs) {
    return new Promise((resolve) => {
        const data = Buffer.from(JSON.stringify(body), 'utf8');
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', timeout: timeoutMs || 20000,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length } }, (res) => {
            let s = '';
            res.on('data', (c) => { s += c; });
            res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
        });
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
        req.on('error', () => resolve(null));
        req.write(data);
        req.end();
    });
}

function tcpAlive(port) {
    return new Promise((resolve) => {
        const net = require('net');
        const s = new net.Socket();
        let done = false;
        const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(v); };
        s.setTimeout(1200, () => fin(false));
        s.on('connect', () => fin(true));
        s.on('error', () => fin(false));
        s.connect(port, '127.0.0.1');
    });
}

function mcForeground() {
    // 用 pet-core 的 fg 命令看前台标题（独立于她的进程，纯只读）
    try {
        const { execFileSync } = require('child_process');
        const exe = path.join(ROOT, 'pet-core', 'target', 'release', process.platform === 'win32' ? 'pet-core.exe' : 'pet-core');
        if (!fs.existsSync(exe)) return { ok: false, error: 'pet-core 不存在' };
        const out = execFileSync(exe, [], { input: '{"cmd":"fg"}', encoding: 'utf8', timeout: 5000, windowsHide: true });
        const d = JSON.parse(out);
        return { ok: !!d.ok, title: String(d.title || ''), hwnd: d.hwnd || 0 };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// ── 纯数学段 ────────────────────────────────────────────────────────────
function runMath() {
    console.log('① 纯数学段（computeAim，不需要游戏）');
    const base = { 'enemy.nearest.yawDelta': { value: 10, stale: false }, 'enemy.nearest.pitchDelta': { value: 0, stale: false } };
    const r1 = GL.computeAim(mkFacts(base), { pxPerDeg: 6.67, gain: 1 });
    ok('10° 偏差 → dx=67（0.15°/px 实测标定）', r1.ok && r1.dx === 67 && r1.dy === 0, JSON.stringify(r1));

    const r2 = GL.computeAim(mkFacts({ 'enemy.nearest.yawDelta': { value: -10, stale: false } }), { pxPerDeg: 6.67 });
    ok('负偏差方向相反（dx=-67）', r2.ok && r2.dx === -67, 'dx=' + r2.dx);

    const r3 = GL.computeAim(mkFacts({ 'enemy.nearest.yawDelta': { value: 10, stale: false } }), { pxPerDeg: 6.67, gain: 0.5 });
    ok('gain 0.5 折半（防过冲）', r3.ok && r3.dx === 33, 'dx=' + r3.dx);

    const r4 = GL.computeAim(mkFacts({ 'enemy.nearest.yawDelta': { value: 10, stale: true } }), {});
    ok('stale 数据 → 明确拒绝（不发假动作）', r4.ok === false && /没有准星偏差/.test(r4.error), r4.error);

    const r5 = GL.computeAim(mkFacts({}), {});
    ok('没有数据 → 明确拒绝', r5.ok === false, r5.error);

    const r6 = GL.computeAim(mkFacts({
        'enemy.nearest.yawDelta': { value: 6, stale: false },
        'enemy.nearest.pitchDelta': { value: -3, stale: false },
    }), { pxPerDeg: 6.67 });
    ok('同时给 dy（俯仰 -3° → -20px）', r6.ok && r6.dx === 40 && r6.dy === -20, JSON.stringify({ dx: r6.dx, dy: r6.dy }));

    const r7 = GL.computeAim(mkFacts({ 'enemy.nearest.yawDelta': { value: 0.2, stale: false } }), { pxPerDeg: 6.67 });
    ok('已对准（0.2°）→ dx=0（2px 死区，不抖）', r7.ok && r7.dx === 0, 'dx=' + r7.dx + ' raw=' + r7.rawDx);
    const r7b = GL.computeAim(mkFacts({ 'enemy.nearest.yawDelta': { value: 0.4, stale: false } }), { pxPerDeg: 6.67 });
    ok('0.4°（≈2.7px）超出死区 → 仍然动', r7b.ok && Math.abs(r7b.dx) >= 2, 'dx=' + r7b.dx);

    const r8 = GL.computeAim(mkFacts({ 'enemy.nearest.yawDelta': { value: 10, stale: false } }), {});
    ok('没配 pxPerDeg 时用实测默认 6.67', r8.ok && r8.dx === 67, 'dx=' + r8.dx);
}

// ── 闭环段 ──────────────────────────────────────────────────────────────
async function runClosedLoop() {
    console.log('② 闭环段（读 yawDelta → move_rel → 回读）');
    const alive = await tcpAlive(8123);
    const fg = mcForeground();
    const isMc = /minecraft/i.test(String(fg.title || ''));
    if (!alive || !isMc) {
        console.log('  ⛔ BLOCKED: 环境没就绪 —— 不是代码失败');
        console.log('     · Mod 通道 8123: ' + (alive ? '通' : '不通'));
        console.log('     · 前台窗口: ' + (fg.title || '(读不到)') + (isMc ? ' ← 是 MC' : ' ← 不是 MC'));
        console.log('     需要：把 Minecraft（Fabric+Mod）开稳在前台，然后重跑本脚本');
        return 'blocked';
    }

    const js = `(async () => {
      const GL = require(${JSON.stringify(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'game-loop.js'))});
      const g = GL.loadProfile ? GL.loadProfile('minecraft') : null;
      const st = GL.facts;
      const read = () => {
        const y = st.get('enemy.nearest.yawDelta');
        const d = st.get('enemy.nearest.dist');
        const o = st.get('enemy.nearest.offAim');
        return { yaw: y && !y.stale ? y.value : null, dist: d && !d.stale ? d.value : null, offAim: o && !o.stale ? o.value : null };
      };
      const before = read();
      if (before.yaw == null) return JSON.stringify({ ok: false, error: '没有新鲜 yawDelta（Mod 通道没数据/已 stale）', before });
      const aim = GL.computeAim(st, { pxPerDeg: (g && g.aim && g.aim.pxPerDeg) || 6.67 });
      if (!aim.ok) return JSON.stringify({ ok: false, error: aim.error, before });
      if (Math.abs(before.yaw) <= ${TOL}) return JSON.stringify({ ok: true, alreadyAligned: true, before, aim, after: before });
      const mv = await GL.goalAction('move_rel', aim.dx + ',' + aim.dy);
      await new Promise((r) => setTimeout(r, 450));
      const after = read();
      return JSON.stringify({ ok: true, before, aim, move: mv && (mv.ok === undefined ? mv : { ok: mv.ok, detail: String(mv.detail || '').slice(0, 80) }), after });
    })()`;

    const tmp = path.join(os.tmpdir(), 'aim-accept-' + process.pid + '.json');
    fs.writeFileSync(tmp, JSON.stringify({ js }), 'utf8');
    const data = fs.readFileSync(tmp, 'utf8');
    try { fs.unlinkSync(tmp); } catch (e) {}
    const payload = Buffer.from(data, 'utf8');
    const res = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: 8004, path: '/eval', method: 'POST', timeout: 30000,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length } }, (r) => {
            let s = '';
            r.on('data', (c) => { s += c; });
            r.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
        });
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
        req.on('error', () => resolve(null));
        req.write(payload);
        req.end();
    });
    if (!res || !res.ok) {
        ok('闭环段能连上她的自检通道', false, JSON.stringify(res).slice(0, 120));
        return 'fail';
    }
    let r = null;
    try { r = JSON.parse(res.value); } catch (e) { r = null; }
    if (!r) { ok('闭环段返回可解析', false, String(res.value).slice(0, 120)); return 'fail'; }
    if (!r.ok) { ok('拿到新鲜 yawDelta', false, r.error || JSON.stringify(r).slice(0, 120)); return 'fail'; }

    console.log('     转前: yaw=' + r.before.yaw + '° dist=' + r.before.dist + ' offAim=' + r.before.offAim);
    console.log('     换算: dx=' + r.aim.dx + 'px dy=' + r.aim.dy + 'px');
    console.log('     转后: yaw=' + (r.after ? r.after.yaw : '?') + '°');
    if (r.alreadyAligned) { ok('本来就已对准（不抖）', true, '|yaw| ≤ ' + TOL + '°'); return 'pass'; }
    const b = Math.abs(Number(r.before.yaw));
    const a = Math.abs(Number(r.after && r.after.yaw));
    ok('转完 |yawDelta| 变小', Number.isFinite(a) && a < b, b.toFixed(2) + '° → ' + a.toFixed(2) + '°');
    ok('转完收敛到容差内（≤' + TOL + '°）', Number.isFinite(a) && a <= TOL, 'after=' + a.toFixed(2) + '°');
    return (Number.isFinite(a) && a < b && a <= TOL) ? 'pass' : 'fail';
}

(async () => {
    console.log('aim 闭环验收（' + new Date().toISOString().slice(0, 19).replace('T', ' ') + '）');
    runMath();
    let verdict = 'math-only';
    if (!MATH_ONLY) verdict = await runClosedLoop();
    console.log('\n数学段 ' + pass + '/' + (pass + fail) + ' 全过 · 闭环段: ' + verdict);
    const mathOk = fail === 0;
    process.exit(mathOk && verdict !== 'fail' ? 0 : 1);
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(1); });
