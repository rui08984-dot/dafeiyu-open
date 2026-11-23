#!/usr/bin/env node
// _probe/test-skill-sediment.cjs —— 技能自动沉淀纯逻辑单测（2026-11-10）
// 只读历史行、不写盘、不碰生产状态；验证「24h 内同序列成功 ≥2 次」的判据。
'use strict';
const assert = require('assert');
const path = require('path');
const SK = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'skill-library.js'));

const now = Date.now();
const row = (action, arg, ts, ok = true) => ({ action, arg, ts, ok, verified: true, effect: ok ? 'confirmed' : 'suspected_noop' });

let pass = 0;
const ok = (name) => { pass += 1; console.log('  ✅', name); };

// 1. 同一段两步序列出现 3 次 → 应命中，且建议名来自首步
{
    const seq = [['press_key', 'zz-sediment-a'], ['click_at', '321,123']];
    const rows = [];
    for (let i = 0; i < 3; i += 1) {
        for (const [a, arg] of seq) rows.push(row(a, arg, now - 30000 + i * 1000));
    }
    const hit = SK.detectRepeatedSequenceIn(rows);
    assert.ok(hit, '应命中重复序列');
    assert.strictEqual(hit.steps.length, 2);
    assert.strictEqual(hit.count, 3);
    assert.ok(/press_key/.test(hit.suggestedName));
    ok('三步重复 → 命中（count=3）');
}

// 2. 只出现 1 次 → 不命中
{
    const rows = [
        row('press_key', 'zz-sediment-b', now - 2000),
        row('click_at', '111,222', now - 1000),
    ];
    assert.strictEqual(SK.detectRepeatedSequenceIn(rows), null);
    ok('单次序列 → 不提示');
}

// 3. 中间夹一次失败 → 两段不应该被当成同一段
{
    const rows = [
        row('press_key', 'zz-sediment-c', now - 3000),
        row('click_at', '10,20', now - 2900),
        row('press_key', 'zz-sediment-c', now - 2000, false),   // 失败，断链
        row('click_at', '10,20', now - 1900, false),
        row('press_key', 'zz-sediment-c', now - 1000),
    ];
    assert.strictEqual(SK.detectRepeatedSequenceIn(rows), null);
    ok('失败断链 → 不提示');
}

// 4. 单步反复（<2 步）→ 不提示（单点动作不值得存技能）
{
    const rows = [];
    for (let i = 0; i < 4; i += 1) rows.push(row('press_key', 'zz-sediment-d', now - 4000 + i * 100));
    assert.strictEqual(SK.detectRepeatedSequenceIn(rows), null);
    ok('单步重复 → 不提示');
}

console.log(`\ntest-skill-sediment.cjs：${pass}/4 全过`);
process.exit(0);
