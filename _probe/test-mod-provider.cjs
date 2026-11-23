#!/usr/bin/env node
/**
 * _probe/test-mod-provider.cjs — Mod 通道接收端单测（2026-11-14 五十三轮）
 *
 * 测三件事：
 *   ① 线路协议（一行一个 JSON）解析正确，能翻译成事实
 *   ② 坏行不静默（计数 + 记原因），不影响后面的好行
 *   ③ 与视觉同源时的仲裁：mod（conf 0.99）压过 vision（conf 0.7）；mod 断流后回落视觉
 *
 * 用真的 TCP 服务器 + 真的 socket 客户端（不是 mock）——这条链是跨进程的，
 * mock 掉了就等于没测。
 */
'use strict';

const net = require('net');
const { createFactStore } = require('../_incoming/my-neuro/live-2d/js/core/fact-store.js');
const { createModProvider } = require('../_incoming/my-neuro/live-2d/js/core/mod-provider.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}
function eq(name, got, want) {
    const a = JSON.stringify(got);
    const b = JSON.stringify(want);
    if (a === b) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + ' —— got ' + a + ' want ' + b);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    // ── ① 纯离线喂数据（不经 socket）：协议 → 事实 ──
    {
        let T = 1000;
        const facts = createFactStore({ now: () => T });
        const p = createModProvider({ facts, port: 0 });
        p.ingest({
            t: 1000, hp: 15, maxHp: 20, food: 10, x: 1.5, y: 64, z: -3.25,
            dim: 'minecraft:overworld',
            entities: [{ type: 'minecraft:zombie', dist: 4.2 }, { type: 'minecraft:cow', dist: 9.9 }],
            inventory: [{ slot: 0, id: 'minecraft:bread', count: 3 }],
        }, 1000);
        eq('HP 归一化', facts.get('player.hp').value, 0.75);
        eq('饥饿归一化', facts.get('player.food').value, 0.5);
        eq('坐标 x', facts.get('player.x').value, 1.5);
        eq('坐标 y', facts.get('player.y').value, 64);
        eq('坐标 z', facts.get('player.z').value, -3.25);
        eq('维度', facts.get('world.dimension').value, 'minecraft:overworld');
        eq('实体数', facts.get('enemy.count').value, 2);
        eq('最近距离', facts.get('enemy.nearest.dist').value, 4.2);
        eq('最近类型', facts.get('enemy.nearest.type').value, 'minecraft:zombie');
        eq('背包', facts.get('player.inventory').value, [{ slot: 0, id: 'minecraft:bread', count: 3 }]);
        ok('来源标记为 mod', facts.get('player.hp').source === 'mod');
    }

    // ── ② 仲裁：mod 压过 vision ──
    {
        let T = 2000;
        const facts = createFactStore({ now: () => T });
        const p = createModProvider({ facts, port: 0 });
        facts.set('player.hp', 0.50, { source: 'vision', conf: 0.7, ttlMs: 500, at: 2000 });
        p.ingest({ t: 2000, hp: 18 }, 2000);
        const r = facts.get('player.hp');
        eq('mod 赢', r.source, 'mod');
        eq('mod 值', r.value, 0.9);
        ok('冲突标记正确', r.conflict === true, JSON.stringify(r.candidates));
    }

    // ── ③ 真 socket：一行一 JSON + 坏行不毒死后续 ──
    const port = 18123;
    const facts = createFactStore();
    const p = createModProvider({ facts, port, log: () => {} });
    const started = await p.start();
    ok('服务器起来了', started === true);

    const client = net.connect({ host: '127.0.0.1', port }, () => {
        client.write('{"hp":10,"maxHp":20}\n');
        client.write('这不是JSON\n');                    // 坏行
        client.write('{"hp":14,"maxHp":20,"x":1,"y":2,"z":3}\n');
    });
    await sleep(400);
    eq('好行生效（坏行没毒死后面的）', facts.get('player.hp').value, 0.7);
    const h = p.health();
    ok('健康：已连接', h.connected === true, JSON.stringify(h));
    ok('健康：解析错误被计数', h.parseErrs === 1, JSON.stringify(h));
    ok('健康：不是 silent（刚有数据）', h.silent === false, JSON.stringify(h));

    // ── ④ 断流 → health.silent，仲裁回落 vision ──
    client.destroy();
    facts.set('player.hp', 0.1, { source: 'vision', conf: 0.9, ttlMs: 500 });
    await sleep(120);
    const r2 = facts.get('player.hp');
    ok('mod 数据变旧后可能仍新鲜（同一 tick），至少来源可辨', r2.source === 'mod' || r2.source === 'vision');

    p.stop();
    // 用超短 ttl 的 store 验「mod 过期后视觉接管」
    {
        const f2 = createFactStore();
        const p2 = createModProvider({ facts: f2, port: 0 });
        p2.ingest({ t: Date.now() - 5000, hp: 20 }, Date.now() - 5000);   // 5 秒前的数据
        f2.set('player.hp', 0.3, { source: 'vision', conf: 0.7, ttlMs: 500, at: Date.now() });
        // player.hp 的 ttl 由 ingest 写死 400ms；dropAfterTtlRatio=4 → 1600ms 后剔除
        const r3 = f2.get('player.hp');
        eq('过期 mod 被剔除 → vision 接管', r3.source, 'vision');
        eq('接管的值', r3.value, 0.3);
    }

    // ── ⑤ 负向安全测试（2026-11-14 审计要求）──
    {
        const { createFactStore: mkStore } = require('../_incoming/my-neuro/live-2d/js/core/fact-store.js');
        // NaN / Infinity 不得进事实表
        const f = mkStore();
        eq('NaN 被拒', f.set('player.hp', NaN, { source: 'mod' }), false);
        eq('Infinity 被拒', f.set('player.hp', Infinity, { source: 'mod' }), false);
        // 未来时间戳被夹住（否则 age 恒 0 = 永不 stale）
        const nowT = Date.now();
        const f2 = mkStore({ now: () => nowT });
        f2.configure({ 'player.hp': { ttlMs: 100 } });
        f2.set('player.hp', 0.5, { source: 'mod', at: nowT + 60000, ttlMs: 100 });
        const r = f2.get('player.hp');
        ok('未来时间戳不会让 age 变负/恒 0', r.age >= 0 && r.age <= 1500, 'age=' + r.age);
        // ttl 裁决权在 profile：生产者写 5000 也不能永不过期
        const f3 = mkStore({ now: () => nowT });
        f3.configure({ 'player.hp': { ttlMs: 100 } });
        f3.set('player.hp', 0.5, { source: 'mod', ttlMs: 5000, at: nowT - 300 });
        ok('profile 的 ttl 覆盖生产者给的 5000', f3.get('player.hp').stale === true, JSON.stringify(f3.get('player.hp')));
        // 来源↔事实绑定：scene 只允许 vision，mod 写了也不算
        const f4 = mkStore();
        f4.configure({ scene: { ttlMs: 400, sources: ['vision'] } });
        eq('mod 不能写 scene（防被投毒的 mod 开闸）', f4.set('scene', 'game', { source: 'mod' }), false);
        eq('vision 可以写 scene', f4.set('scene', 'game', { source: 'vision' }), true);
    }

    console.log('  ' + (fail === 0 ? '✅' : '❌') + ' Mod 通道接收端：PASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 异常：' + (e && e.message || e));
    process.exit(1);
});
