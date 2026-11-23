#!/usr/bin/env node
// _probe/test-insight-merge.cjs —— insights 保守去重合并单测（2026-11-22）
//
// 验的是 lib/insights-store.js 的 mergeOrAppendInsights / isSameInsight：
//   ① 完全重复（含标点/空白差异）→ 合并且 occurrences 1→2→3，id/created_at 不变，证据并集
//   ② 近似改写（同 focal、Dice≥0.9、keywords 重叠）→ 合并
//   ③ 反例必须分开：猫/狗（文本差异）、focal 不同、keywords 不重叠、一方 keywords 为空
//   ④ 新内容 → 纯追加（旧字节不动）
//   ⑤ 坏行/空行存在时合并重写不丢任何行（坏行原样保留）
//   ⑥ 原子写：写完后目录里没有残留 .tmp-*
// 全程只写 mkdtemp，不碰真实 data。
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STORE = require(path.join(
    __dirname, '..', '_incoming', 'my-neuro', 'live-2d',
    'plugins', 'community', 'memory-evolve', 'lib', 'insights-store.js'
));

let pass = 0;
const ok = (name) => { pass += 1; console.log('  ✅ ' + name); };
const dirs = [];
function mk(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
}
function cleanup() {
    for (const d of dirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
}
const I = (dir) => path.join(dir, 'insights.jsonl');
function writeRaw(dir, lines) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(I(dir), lines.join('\n') + '\n', 'utf8');
}
function readText(dir) { return fs.readFileSync(I(dir), 'utf8'); }
function readRows(dir) {
    return readText(dir).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
function tmpLeft(dir) { return fs.readdirSync(dir).filter((n) => n.includes('.tmp-')); }

/** 一条典型 reflect 产出的 insight（字段与 lib/reflect.js 对齐）。 */
function row(over) {
    return Object.assign({
        id: 'ins_old_1',
        created_at: 1700000000000,
        text: '主人喜欢在周末的下午去城市中心的公园散步放松',
        evidence_ids: ['ep:1:100'],
        depth: 2,
        importance: 5,
        keywords: ['散步', '公园'],
        focal_point: '主人',
        confidence: 0.6,
        occurrences: 1,
        status: 'active',
        superseded_by: null,
        model: '',
        prompt_version: 'reflect-v1',
    }, over || {});
}

// ── 1. isSameInsight 纯函数直接断言 ───────────────────────────────────────
{
    const a = row({});
    assert.strictEqual(STORE.isSameInsight(a, row({ id: 'x', text: ' 主人喜欢在周末的下午，去城市中心的公园散步放松。 ' })), true,
        '标点/空白差异 + 同 focal + keywords 重叠 → 同一条');
    assert.strictEqual(STORE.isSameInsight(a, row({
        id: 'x', text: '主人喜欢在周末下午去城市中心的公园散步放松',
    })), true, 'Dice≈0.927 → 同一条');

    const cat = row({ text: '主人养了一只猫', keywords: ['宠物', '陪伴'] });
    const dog = row({ id: 'x', text: '主人养了一只狗', keywords: ['宠物', '陪伴'] });
    assert.strictEqual(STORE.isSameInsight(cat, dog), false, '猫/狗（同 focal、同 keywords）→ 不是同一条');

    assert.strictEqual(STORE.isSameInsight(a, row({ id: 'x', focal_point: '猫' })), false, 'focal 不同 → 不合并');
    assert.strictEqual(STORE.isSameInsight(a, row({ id: 'x', focal_point: '' })), false, 'focal 一方为空 → 不合并');
    assert.strictEqual(STORE.isSameInsight(a, row({ id: 'x', keywords: [] })), false, 'keywords 一方为空 → 不合并');
    assert.strictEqual(STORE.isSameInsight(a, row({ id: 'x', keywords: ['天气', '下雨'] })), false, 'keywords 不重叠 → 不合并');
    assert.strictEqual(STORE.isSameInsight(null, a), false);
    assert.strictEqual(STORE.isSameInsight(a, { text: '' }), false);
    ok('isSameInsight 直接断言（正例 2 / 反例 6）');
}

// ── 2. 完全重复（标点/空白差异）→ occurrences 1→2→3，id/created_at 不变 ──
{
    const d = mk('insight-merge-exact-');
    let r = STORE.mergeOrAppendInsights(d, [row({})], { now: 1000 });
    assert.deepStrictEqual(r, { added: 1, merged: 0, total: 1 }, '首次写入 = 新增 1');

    // 第二批：文本加了空格/中英标点，证据部分重叠、importance 更高
    r = STORE.mergeOrAppendInsights(d, [row({
        id: 'ins_new_1', created_at: 9999999999999,
        text: ' 主人喜欢在周末的下午，去城市中心的公园散步放松。 ',
        evidence_ids: ['ep:1:100', 'ep:2:200'],
        importance: 7,
    })], { now: 2000 });
    assert.deepStrictEqual(r, { added: 0, merged: 1, total: 1 });

    let rows = readRows(d);
    assert.strictEqual(rows.length, 1, '重复不新增行');
    assert.strictEqual(rows[0].id, 'ins_old_1', '保留旧 id');
    assert.strictEqual(rows[0].created_at, 1700000000000, '保留旧 created_at');
    assert.strictEqual(rows[0].occurrences, 2);
    assert.deepStrictEqual(rows[0].evidence_ids, ['ep:1:100', 'ep:2:200'], '证据取并集');
    assert.strictEqual(rows[0].importance, 7, 'importance 取 max');
    assert.strictEqual(rows[0].updated_at, 2000);

    // 第三批：tab + 全角标点 + 新证据
    r = STORE.mergeOrAppendInsights(d, [row({
        id: 'ins_new_2', text: '主人喜欢在周末的下午\t去城市中心的公园散步放松！！',
        evidence_ids: ['ep:3:300'],
    })], { now: 3000 });
    assert.deepStrictEqual(r, { added: 0, merged: 1, total: 1 });

    rows = readRows(d);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, 'ins_old_1');
    assert.strictEqual(rows[0].created_at, 1700000000000);
    assert.strictEqual(rows[0].occurrences, 3);
    assert.deepStrictEqual(rows[0].evidence_ids, ['ep:1:100', 'ep:2:200', 'ep:3:300']);
    assert.strictEqual(rows[0].updated_at, 3000);
    assert.deepStrictEqual(tmpLeft(d), [], '原子写后无残留 tmp');
    ok('完全重复 → occurrences 1→2→3，id/created_at 不变，证据并集，无 tmp 残留');
}

// ── 3. 近似改写（同 focal、Dice≥0.9、keywords 重叠）→ 合并 ────────────────
{
    const d = mk('insight-merge-near-');
    STORE.mergeOrAppendInsights(d, [row({})], { now: 10 });
    const r = STORE.mergeOrAppendInsights(d, [row({
        id: 'ins_new_near',
        text: '主人喜欢在周末下午去城市中心的公园散步放松',   // 去掉「的」，Dice≈0.927
        keywords: ['公园', '散步', '周末'],
        evidence_ids: ['ep:9:900'],
    })], { now: 20 });
    assert.deepStrictEqual(r, { added: 0, merged: 1, total: 1 });
    const rows = readRows(d);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].occurrences, 2);
    assert.deepStrictEqual(rows[0].keywords, ['散步', '公园', '周末'], 'keywords 并集（旧在前，去重，≤5）');
    ok('近似改写（Dice 0.927）→ 合并，keywords 取并集');
}

// ── 4. 反例：必须分开 ────────────────────────────────────────────────────
{
    // 4.1 猫/狗：同 focal、同 keywords，只有文本不同 → 不合并
    const d1 = mk('insight-merge-catdog-');
    const cat = row({ text: '主人养了一只猫', keywords: ['宠物', '陪伴'] });
    const dog = row({ id: 'ins_dog', text: '主人养了一只狗', keywords: ['宠物', '陪伴'] });
    let r = STORE.mergeOrAppendInsights(d1, [cat], { now: 1 });
    assert.strictEqual(r.added, 1);
    r = STORE.mergeOrAppendInsights(d1, [dog], { now: 2 });
    assert.deepStrictEqual(r, { added: 1, merged: 0, total: 1 });
    assert.strictEqual(readRows(d1).length, 2, '猫与狗并存');

    // 4.2 focal 不同、文本几乎相同 → 不合并
    const d2 = mk('insight-merge-focal-');
    STORE.mergeOrAppendInsights(d2, [row({ focal_point: '主人' })], { now: 1 });
    r = STORE.mergeOrAppendInsights(d2, [row({ id: 'ins_f2', focal_point: '猫' })], { now: 2 });
    assert.deepStrictEqual(r, { added: 1, merged: 0, total: 1 });
    assert.strictEqual(readRows(d2).length, 2, 'focal 不同 → 两行');

    // 4.3 文本相同但 keywords 不重叠 → 不合并
    const d3 = mk('insight-merge-kw-');
    STORE.mergeOrAppendInsights(d3, [row({ keywords: ['散步', '公园'] })], { now: 1 });
    r = STORE.mergeOrAppendInsights(d3, [row({ id: 'ins_k2', keywords: ['天气', '下雨'] })], { now: 2 });
    assert.deepStrictEqual(r, { added: 1, merged: 0, total: 1 });
    assert.strictEqual(readRows(d3).length, 2, 'keywords 不重叠 → 两行');

    // 4.4 一方 keywords 为空 → 不合并
    const d4 = mk('insight-merge-kwempty-');
    STORE.mergeOrAppendInsights(d4, [row({ keywords: ['散步'] })], { now: 1 });
    r = STORE.mergeOrAppendInsights(d4, [row({ id: 'ins_k3', keywords: [] })], { now: 2 });
    assert.deepStrictEqual(r, { added: 1, merged: 0, total: 1 });
    assert.strictEqual(readRows(d4).length, 2, 'keywords 一方为空 → 两行');
    ok('反例：猫/狗、focal 不同、keywords 不重叠、keywords 为空 → 均不合并');
}

// ── 5. 新内容 → 纯追加（旧字节不动）────────────────────────────────────
{
    const d = mk('insight-merge-new-');
    STORE.mergeOrAppendInsights(d, [row({})], { now: 1 });
    const before = readText(d);
    const fresh = row({
        id: 'ins_other', text: '主人最近开始每天早起去公园慢跑锻炼身体',
        keywords: ['早起', '锻炼'], focal_point: '主人', evidence_ids: ['ep:5:500'],
    });
    const r = STORE.mergeOrAppendInsights(d, [fresh], { now: 2 });
    assert.deepStrictEqual(r, { added: 1, merged: 0, total: 1 });
    const after = readText(d);
    assert.strictEqual(after, before + JSON.stringify(fresh) + '\n', '无合并 → 旧字节原样 + 追加一行');
    assert.strictEqual(readRows(d).length, 2);
    assert.deepStrictEqual(tmpLeft(d), [], '追加路径也不产生 tmp');
    ok('新内容 → 纯追加（旧字节不变）');
}

// ── 6. 坏行/空行存在时合并重写不丢任何行，坏行原样保留 ──────────────────
{
    const d = mk('insight-merge-badline-');
    const good = row({});
    const otherGoodRaw = JSON.stringify(row({
        id: 'ins_other_good', text: '主人最近开始每天早起去公园慢跑锻炼身体',
        keywords: ['早起', '锻炼'], focal_point: '主人',
    }));
    const badRaw = '{这一行不是合法 JSON';
    writeRaw(d, [JSON.stringify(good), badRaw, '', otherGoodRaw]);  // 含坏行 + 中间空行

    const r = STORE.mergeOrAppendInsights(d, [row({
        id: 'ins_dup', text: '主人喜欢在周末的下午，去城市中心的公园散步放松。',
        evidence_ids: ['ep:7:700'],
    })], { now: 42 });
    assert.deepStrictEqual(r, { added: 0, merged: 1, total: 1 });

    const lines = readText(d).split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    assert.strictEqual(lines.length, 4, '原有 4 行（含 1 空行）都还在');
    const first = JSON.parse(lines[0]);
    assert.strictEqual(first.occurrences, 2, '好行照常合并');
    assert.deepStrictEqual(first.evidence_ids, ['ep:1:100', 'ep:7:700']);
    assert.strictEqual(lines[1], badRaw, '坏行原样保留');
    assert.strictEqual(lines[2], '', '空行原样保留');
    assert.strictEqual(lines[3], otherGoodRaw, '未合并的好行字节不变');
    assert.deepStrictEqual(tmpLeft(d), [], '重写后无残留 tmp');
    ok('坏行/空行/未合并好行 → 合并重写全部原样保留');
}

// ── 7. 证据上限 40、occurrences 缺失按 1 起算 ───────────────────────────
{
    const d = mk('insight-merge-cap-');
    const oldIds = Array.from({ length: 30 }, (_, i) => 'ep:' + (i + 1) + ':1');
    STORE.mergeOrAppendInsights(d, [row({ evidence_ids: oldIds, occurrences: undefined })], { now: 1 });
    assert.strictEqual(readRows(d)[0].occurrences, undefined, '旧值缺失保持缺失（追加路径不改写）');
    const newIds = Array.from({ length: 30 }, (_, i) => 'ep:' + (i + 31) + ':1');
    const r = STORE.mergeOrAppendInsights(d, [row({
        id: 'ins_cap', evidence_ids: newIds.concat(['ep:1:1']),
    })], { now: 2 });
    assert.deepStrictEqual(r, { added: 0, merged: 1, total: 1 });
    const after = readRows(d)[0];
    assert.strictEqual(after.occurrences, 2, '旧 occurrences 缺失 → 1 起算再 +1');
    assert.strictEqual(after.evidence_ids.length, 40, '证据并集上限 40');
    assert.strictEqual(after.evidence_ids[0], 'ep:1:1', '旧的证据在前');
    ok('证据上限 40 / occurrences 缺失按 1 起算');
}

cleanup();
console.log('\ntest-insight-merge.cjs：' + pass + '/' + pass + ' 全过');
process.exit(0);
