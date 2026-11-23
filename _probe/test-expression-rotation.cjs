#!/usr/bin/env node
/**
 * _probe/test-expression-rotation.cjs —— 表情轮换（2026-11-15 六十三轮）
 *
 * 用户反馈「表情还是那几个切来切去」。修法：同一情绪给多个 authored expression 轮换，
 * 连续两次不重复（开心：＞＜ / 兔牙 / 爱心眼；害羞：脸红 / 爱心眼；俏皮：屑屑眼 / 兔牙）。
 * 这个测试保证：池子存在、轮换不连续重复、单表情情绪稳定、未知情绪不乱给。
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const AB = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'avatar', 'petbody', 'actions-bridge.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ① 池子：开心 3 个、害羞 2 个、生气只有 1 个
function poolLen(key) {
    const p = AB.EMOTION_EXPRESSIONS[key];
    return Array.isArray(p) ? p.length : 0;
}
ok('开心有 3 个表情候选', poolLen('开心') === 3);
ok('害羞有 2 个表情候选', poolLen('害羞') === 2);
ok('生气只有 1 个（黑脸）', poolLen('生气') === 1 && AB.EMOTION_EXPRESSIONS['生气'][0] === '黑脸');

// ② 轮换：连续三次不同（池子大小 3）
const seq = [AB.pickExpression('开心'), AB.pickExpression('开心'), AB.pickExpression('开心')];
ok('开心轮换三次各不相同', new Set(seq).size === 3, seq.join(' / '));
const again = AB.pickExpression('开心');
ok('第四次回到池子里（不越界）', seq.includes(again), again);

// ③ 相邻两次绝不重复
let repeated = 0;
let last = null;
for (let i = 0; i < 12; i += 1) {
    const cur = AB.pickExpression('害羞');
    if (last && cur === last) repeated += 1;
    last = cur;
}
ok('害羞轮换 12 次无相邻重复', repeated === 0, 'repeats=' + repeated);

// ④ 单表情情绪稳定
const angry = [AB.pickExpression('生气'), AB.pickExpression('生气'), AB.pickExpression('生气')];
ok('生气始终是黑脸', angry.every((x) => x === '黑脸'));

// ⑤ resolveEmotion 走轮换，且未知情绪返回 null
const r1 = AB.resolveEmotion('开心');
ok('resolveEmotion(开心) 带表情', !!r1 && r1.key === '开心' && !!r1.expression, JSON.stringify(r1));
ok('未知情绪返回 null', AB.resolveEmotion('xyz') === null);
ok('空输入返回 null', AB.resolveEmotion('') === null);

// ⑥ 池子里的名字必须是模型真实存在的 expression（从 model3 读取）
{
    const fs = require('fs');
    const modelPath = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'assets', 'petbody', 'pet.model3.json');
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    const names = new Set(((model.FileReferences && model.FileReferences.Expressions) || []).map((e) => e.Name));
    const used = new Set();
    for (const pool of Object.values(AB.EMOTION_EXPRESSIONS)) for (const n of pool) used.add(n);
    const missing = [...used].filter((n) => !names.has(n));
    ok('所有候选表情都在 model3 里', missing.length === 0, missing.join(',') || 'all ok');
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
