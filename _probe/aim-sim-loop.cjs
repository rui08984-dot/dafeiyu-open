#!/usr/bin/env node
/**
 * _probe/aim-sim-loop.cjs — aim 闭环「模拟验收」（2026-11-15 六十轮）
 *
 * 为什么要有它：真机验收（`aim-accept.cjs --live`）需要 Minecraft 在前台，而铁律
 * 不许我自己弹游戏窗。于是把**除游戏之外的所有真实组件**都串起来跑一遍：
 *
 *   真 mod-provider（TCP + NDJSON 解析）→ 真 fact-store（ttl/新鲜度）
 *     → 真 computeAim（含 2px 死区）→ 模拟世界（0.15°/px，本机实测标定值）
 *
 * 它能抓的是**逻辑层**的致命问题：不收敛、过冲振荡、死区不生效（准星来回抖）、
 * 事实过期被误判 stale、NDJSON 半包/粘包解析错。
 * 它**不能**替代真机验收 —— 真鼠标、真游戏、真灵敏度只有 MC 能验。
 *
 * 用法：node _probe/aim-sim-loop.cjs
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）
 */
'use strict';

const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE2D = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const { createModProvider } = require(path.join(LIVE2D, 'js', 'core', 'mod-provider.js'));
const { createFactStore } = require(path.join(LIVE2D, 'js', 'core', 'fact-store.js'));
const GL = require(path.join(LIVE2D, 'js', 'core', 'game-loop.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 18123;           // 避开真 Mod 的 8123
const PXPERDEG = 6.67;        // 本机实测 0.15°/px
const DEG_PER_PX = 0.15;
const GAIN = 0.6;             // 故意不用 1.0：1.0 会「一步到位」，测不出振荡

function frame(yaw, pitch, dist) {
    return JSON.stringify({
        t: Date.now(),
        player: { hp: 20, food: 20, x: 0, y: 64, z: 0, yaw: 0, pitch: 0, dim: 'overworld' },
        entities: [{ type: 'zombie', dist: dist == null ? 2.4 : dist, yawDelta: yaw, pitchDelta: pitch || 0 }],
        inv: [],
        tps: 20,
    }) + '\n';
}

(async () => {
    // 用真实的 FactStore（真 ttl/新鲜度/冲突判定都在里面）
    const store = createFactStore();
    const provider = createModProvider({ facts: store, port: PORT, log: () => {} });
    await provider.start();
    await sleep(120);

    const client = net.connect({ host: '127.0.0.1', port: PORT });
    const connected = await new Promise((res) => {
        client.on('connect', () => res(true));
        client.on('error', () => res(false));
        setTimeout(() => res(false), 1200);
    });
    ok('假 Mod 客户端能连上真 mod-provider', connected, 'port=' + PORT);

    // ── 模拟世界：yaw 是「目标相对视线」的角差，鼠标右移(dx>0)会让它变小 ──
    let yaw = 14;      // 起始 14°（> 死区，且 dist<=4.5 让规则该开火）
    let pitch = -4;
    const send = (y, p) => { try { client.write(frame(y, p)); } catch (e) {} };
    send(yaw, pitch);
    await sleep(140);

    const f0 = provider.facts.get('enemy.nearest.yawDelta');
    ok('NDJSON 被正确解析进事实表', !!f0 && !f0.stale && Math.abs(f0.value - yaw) < 0.01, f0 ? ('yaw=' + f0.value) : 'null');
    const d0 = provider.facts.get('enemy.nearest.dist');
    ok('距离事实也进来了（dist<=4.5 → 规则该开火）', !!d0 && d0.value <= 4.5, d0 ? ('dist=' + d0.value) : 'null');

    // ── 闭环：每帧 读事实 → computeAim → 作用到模拟世界 → 回写事实 ──
    const trace = [];
    let steps = 0;
    for (let i = 0; i < 8; i += 1) {
        const aim = GL.computeAim(provider.facts, { pxPerDeg: PXPERDEG, gain: GAIN });
        if (!aim.ok) break;
        trace.push({ yaw: +yaw.toFixed(2), dx: aim.dx });
        if (aim.dx === 0 && Math.abs(yaw) <= 2) break;         // 已收敛
        // 世界响应：鼠标位移换算成角度（与标定一致，方向相反）
        yaw -= aim.dx * DEG_PER_PX;
        pitch -= aim.dy * DEG_PER_PX * 0;                      // 俯仰这轮不测
        steps += 1;
        send(yaw, pitch);
        await sleep(90);                                        // 快于 300ms ttl
    }

    ok('确实转起来了（至少一步非零位移）', trace.some((t) => t.dx !== 0), JSON.stringify(trace.slice(0, 3)));
    ok('最终收敛到 |yaw| ≤ 2°', Math.abs(yaw) <= 2, 'yaw=' + yaw.toFixed(2) + ' steps=' + steps);
    const absSeq = trace.map((t) => Math.abs(t.yaw));
    ok('单调收敛不过冲（|yaw| 不回升）',
        absSeq.every((v, i) => i === 0 || v <= absSeq[i - 1] + 0.01), absSeq.map((v) => v.toFixed(1)).join('→'));

    // 收敛后再喂两帧：死区应该让 dx 恒为 0（否则准星手抖）
    send(yaw, pitch);
    await sleep(120);
    const a1 = GL.computeAim(provider.facts, { pxPerDeg: PXPERDEG, gain: GAIN });
    send(yaw, pitch);
    await sleep(120);
    const a2 = GL.computeAim(provider.facts, { pxPerDeg: PXPERDEG, gain: GAIN });
    ok('收敛后死区生效（连续两帧 dx=0，不抖）', a1.ok && a1.dx === 0 && a2.ok && a2.dx === 0,
        'dx=' + (a1.ok ? a1.dx : '?') + '/' + (a2.ok ? a2.dx : '?'));

    // ── 事实过期：停 400ms 不喂，应判 stale（computeAim 必须拒绝，不能拿旧数据转）──
    await sleep(420);
    const stale = GL.computeAim(provider.facts, { pxPerDeg: PXPERDEG, gain: GAIN });
    ok('停发 >ttl 后判 stale 并拒绝（不拿旧数据发动作）', stale.ok === false, stale.error || 'ok=' + stale.ok);

    // ── 粘包/半包：一次写两帧 + 半帧，解析器不能崩 ──
    try {
        client.write(frame(3, 0) + frame(2, 0).slice(0, 20));
        await sleep(60);
        client.write(frame(2, 0).slice(20));
        await sleep(140);
        const f2 = provider.facts.get('enemy.nearest.yawDelta');
        ok('半包/粘包不漏不崩（最后解析到 2°）', !!f2 && Math.abs(f2.value - 2) < 0.01, f2 ? ('yaw=' + f2.value) : 'null');
    } catch (e) {
        ok('半包/粘包不漏不崩', false, String(e && e.message || e));
    }

    try { client.destroy(); } catch (e) {}
    try { provider.stop(); } catch (e) {}

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过（模拟闭环，不含真游戏）');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('  ✗ 测试自身异常：' + (e && e.stack || e)); process.exit(1); });
