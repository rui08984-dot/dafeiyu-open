#!/usr/bin/env node
/**
 * _probe/test-fact-store.cjs — 事实表 + 多源仲裁单测（2026-11-14 五十三轮）
 *
 * 这块是「多通道状态」的地基：同一条事实有多个来源（mod/api/vision），
 * 各自有年龄和可信度。测的是**仲裁规则**，不是具体某个通道。
 *
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）
 */
'use strict';

const { createFactStore, isConflict } = require('../_incoming/my-neuro/live-2d/js/core/fact-store.js');

let pass = 0;
let fail = 0;
function eq(name, got, want) {
    const a = JSON.stringify(got);
    const b = JSON.stringify(want);
    if (a === b) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + ' —— got ' + a + ' want ' + b);
}
function ok(name, cond, detail) {
    if (cond) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}

// 可注入时钟：T 从 0 开始
let T = 0;
const mk = (policy) => createFactStore(Object.assign({ now: () => T }, policy ? { policy } : {}));

// ── 1. 单来源 ──
{
    T = 1000;
    const fs = mk();
    fs.set('player.hp', 0.8, { source: 'vision', conf: 0.7, ttlMs: 500 });
    const r = fs.get('player.hp');
    eq('单来源 值', r.value, 0.8);
    eq('单来源 来源', r.source, 'vision');
    ok('单来源 不 stale', r.stale === false);
    ok('单来源 不 conflict', r.conflict === false);
}

// ── 2. 两来源：mod 比 vision 置信度高 → 选 mod ──
{
    T = 1000;
    const fs = mk();
    fs.set('player.hp', 0.62, { source: 'mod', conf: 0.99, ttlMs: 500 });
    fs.set('player.hp', 0.60, { source: 'vision', conf: 0.70, ttlMs: 500 });
    const r = fs.get('player.hp');
    eq('两来源 选 mod', r.source, 'mod');
    eq('两来源 值', r.value, 0.62);
    ok('两来源 偏差小 → 不 conflict', r.conflict === false);
}

// ── 3. mod 变旧 → 回落 vision（降级是常态路径）──
{
    T = 1000;
    const fs = mk();
    fs.set('player.hp', 0.62, { source: 'mod', conf: 0.99, ttlMs: 300 });
    fs.set('player.hp', 0.55, { source: 'vision', conf: 0.70, ttlMs: 1000 });
    T = 1500;   // mod 已过 ttl（但没有过 dropAfterTtlRatio×ttl）
    const r = fs.get('player.hp');
    eq('旧 mod 时回落 vision', r.source, 'vision');
    eq('旧 mod 时值', r.value, 0.55);
}

// ── 4. 来源彻底死了（超过 4×ttl）→ 从候选剔除 ──
{
    T = 0;
    const fs = mk();
    fs.set('player.hp', 0.62, { source: 'mod', conf: 0.99, ttlMs: 100 });
    T = 500;    // 5×ttl
    const r = fs.get('player.hp');
    ok('死掉的来源被剔除', r.value === undefined && r.stale === true, JSON.stringify(r));
}

// ── 5. 冲突：两源都新鲜但差太多 ──
{
    T = 1000;
    const fs = mk();
    fs.set('player.hp', 0.90, { source: 'mod', conf: 0.99, ttlMs: 500 });
    fs.set('player.hp', 0.30, { source: 'vision', conf: 0.70, ttlMs: 500 });
    const r = fs.get('player.hp');
    ok('大偏差 → conflict=true', r.conflict === true, JSON.stringify(r.candidates));
    eq('冲突时仍选高分的（mod）', r.source, 'mod');
}

// ── 6. 风险档：不在允许列表的来源被丢弃 ──
{
    T = 1000;
    const fs = mk({ allowSources: ['vision'] });
    eq('禁用的 memory 被拒', fs.set('player.hp', 0.5, { source: 'memory', conf: 1 }), false);
    eq('允许的 vision 写入成功', fs.set('player.hp', 0.6, { source: 'vision', conf: 0.7 }), true);
    eq('只剩 vision', fs.get('player.hp').source, 'vision');
}

// ── 7. 非数值事实（字符串/布尔）按相等判冲突 ──
{
    T = 1000;
    const fs = mk();
    fs.set('scene', 'inventory', { source: 'vision', conf: 0.9, ttlMs: 500 });
    fs.set('scene', 'game', { source: 'mod', conf: 0.99, ttlMs: 500 });
    ok('字符串不一致 → conflict', fs.get('scene').conflict === true);
    ok('isConflict 数值容差', isConflict(0.5, 0.52, 0.12) === false);
    ok('isConflict 字符串', isConflict('a', 'b', 0.12) === true);
}

// ── 8. snapshot / dump / reset ──
{
    T = 1000;
    const fs = mk();
    fs.set('player.hp', 0.7, { source: 'vision', conf: 0.7, ttlMs: 500 });
    fs.set('scene', 'game', { source: 'vision', conf: 0.9, ttlMs: 500 });
    eq('snapshot 扁平', fs.snapshot(), { 'player.hp': 0.7, scene: 'game' });
    ok('dump 带候选', Array.isArray(fs.dump()['player.hp'].candidates));
    fs.reset();
    ok('reset 清空', fs.get('player.hp').value === undefined);
}

// ── 9. 每事实独立 ttl（敌人 50ms / hp 500ms 这种差异要能表达）──
{
    T = 0;
    const fs = mk();
    fs.configure({ 'enemy.cx': { ttlMs: 50 }, 'player.hp': { ttlMs: 500 } });
    fs.set('enemy.cx', 0.5, { source: 'vision', conf: 0.8 });
    fs.set('player.hp', 0.9, { source: 'vision', conf: 0.8 });
    T = 120;
    ok('敌人位置已 stale', fs.get('enemy.cx').stale === true);
    ok('血量还新鲜', fs.get('player.hp').stale === false);
}

console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 事实表仲裁：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
