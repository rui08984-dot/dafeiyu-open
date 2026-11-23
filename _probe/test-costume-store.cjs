#!/usr/bin/env node
/**
 * _probe/test-costume-store.cjs —— B7「换装双写」证伪测试
 *
 * 真 bug：`pet.assets.v1` 有两个写入者。
 *   · asset-toggles（window.petAssets）写 {version, updatedAt, preset, values}
 *   · ui-controller 旧 saveAssetState 写 {version, at, values}（没有 preset）
 * 走后者换装会把 preset 覆盖掉，重启后预设高亮变「自定义」。
 *
 * 修法：ui-controller 优先调用 window.petAssets.saveAssetsState（唯一写入者）；
 * 兜底走 core/costume-store.js —— 读旧记录 → 补齐 preset → 单次 setItem →
 * 回读逐字校验 → 失败把旧原文写回（或删除）。
 *
 * 覆盖：
 *   A. schema/规范化/preset 识别
 *   B. 正常写 + preset 保留
 *   C. 失败注入：setItem 抛 / 写坏后抛 / 静默不写 → 旧记录原样回滚
 *   D. ui-controller 接线（优先权威写入者；不再自己拼 {at} 记录）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const STORE = path.join(LIVE, 'js', 'core', 'costume-store.js');
const UI_CONTROLLER = path.join(LIVE, 'js', 'ui', 'ui-controller.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name); return true; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
function eq(name, actual, expected) {
    return ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

const S = require(STORE);

function memoryStorage(initial = null) {
    const map = new Map();
    if (initial != null) map.set(S.ASSETS_STORAGE_KEY, initial);
    return {
        map,
        setCalls: 0,
        setItem(key, value) { this.setCalls += 1; map.set(key, String(value)); },
        getItem(key) { return map.has(key) ? map.get(key) : null; },
        removeItem(key) { map.delete(key); },
    };
}

const ASSETS = [
    { id: 'clothes-skirt', param: 'Clothes2', kind: 'toggle', default: 1 },
    { id: 'clothes-shoes', param: 'Shoes', kind: 'toggle', default: 1 },
    { id: 'clothes-tail', param: 'Tail', kind: 'toggle', default: 1 },
    { id: 'form-size', param: 'FormSize', kind: 'cycle', default: 0, options: [{ id: 'big', label: '大', value: 0 }, { id: 'mid', label: '中', value: 0.4 }, { id: 'small', label: '小', value: 1 }] },
];
const PRESETS = [
    { id: 'maid', label: '女仆装', assets: {} },
    { id: 'home', label: '居家', assets: { 'clothes-skirt': true, 'clothes-shoes': true, 'clothes-tail': false } },
    { id: 'slack', label: '摸鱼', assets: { 'form-size': 'mid' } },
];

console.log('\n[A] 规范化 / preset 识别');
{
    const values = S.normalizeValues({ a: 0.5, b: true, c: false, d: 'x', e: NaN, f: -2, g: 3 });
    eq('布尔 true → 1', values.b, 1);
    eq('布尔 false → 0', values.c, 0);
    eq('字符串丢弃', Object.prototype.hasOwnProperty.call(values, 'd'), false);
    eq('NaN 丢弃', Object.prototype.hasOwnProperty.call(values, 'e'), false);
    eq('负数夹到 0', values.f, 0);
    eq('>1 夹到 1', values.g, 1);
    eq('全非法 → null', S.normalizeValues({ x: 'nope' }), null);

    const homeValues = { 'clothes-skirt': 1, 'clothes-shoes': 1, 'clothes-tail': 0, 'form-size': 0 };
    eq('识别居家预设', S.detectPresetId(homeValues, PRESETS, ASSETS), 'home');
    eq('识别摸鱼（cycle 档位）', S.detectPresetId({
        'clothes-skirt': 1, 'clothes-shoes': 1, 'clothes-tail': 1, 'form-size': 0.4,
    }, PRESETS, ASSETS), 'slack');
    eq('自定义 → 空串', S.detectPresetId({ ...homeValues, 'clothes-skirt': 0.5 }, PRESETS, ASSETS), '');

    const parsed = S.parseRecord(JSON.stringify({ version: 1, updatedAt: 7, preset: 'home', values: { a: 1 } }));
    eq('解析正常记录', parsed.preset, 'home');
    eq('解析 updatedAt', parsed.updatedAt, 7);
    eq('错版本 → null', S.parseRecord(JSON.stringify({ version: 2, values: { a: 1 } })), null);
    eq('坏 JSON → null', S.parseRecord('{oops'), null);
}

console.log('\n[B] 正常写：schema 与 preset 保留');
{
    const storage = memoryStorage();
    const result = S.writeAssetsState(storage, { values: { 'clothes-skirt': 1 }, now: 12345 });
    eq('写入成功', result.saved, true);
    eq('只写一次 setItem（单次原子写）', storage.setCalls, 1);
    const record = JSON.parse(storage.getItem(S.ASSETS_STORAGE_KEY));
    eq('schema version=1', record.version, 1);
    eq('字段名是 updatedAt（与 asset-toggles 一致）', record.updatedAt, 12345);
    eq('没有旧字段 at', Object.prototype.hasOwnProperty.call(record, 'at'), false);
    eq('preset 字段存在', record.preset, '');

    // 已有 preset → 不带 presets/assets 的写入要保留它
    const prevRaw = JSON.stringify({ version: 1, updatedAt: 1, preset: 'home', values: { 'clothes-skirt': 0 } });
    const storage2 = memoryStorage(prevRaw);
    const r2 = S.writeAssetsState(storage2, { values: { 'clothes-skirt': 1 }, now: 2 });
    eq('无 preset 输入时保留旧 preset', r2.record.preset, 'home');

    // 带 presets/assets → 按值重算 preset
    const storage3 = memoryStorage(prevRaw);
    const r3 = S.writeAssetsState(storage3, {
        values: { 'clothes-skirt': 1, 'clothes-shoes': 1, 'clothes-tail': 0, 'form-size': 0 },
        presets: PRESETS,
        assets: ASSETS,
        now: 3,
    });
    eq('按当前值识别出居家', r3.record.preset, 'home');

    // 显式 preset 优先
    const r4 = S.writeAssetsState(memoryStorage(), { values: { a: 1 }, preset: 'slack' });
    eq('显式 preset 优先', r4.record.preset, 'slack');

    // 非法值：先校验，不写
    const storage5 = memoryStorage();
    const r5 = S.writeAssetsState(storage5, { values: { a: 'bad' } });
    eq('非法 values 拒绝写', r5.saved, false);
    eq('非法 values 原因', r5.reason, 'invalid-values');
    eq('非法 values 不碰 storage', storage5.setCalls, 0);

    // storage 不可用
    const r6 = S.writeAssetsState(null, { values: { a: 1 } });
    eq('storage 不可用：明确返回', r6.reason, 'storage-unavailable');
}

console.log('\n[C] 失败注入：第二处失败 → 第一处回滚');
{
    const prevRaw = JSON.stringify({ version: 1, updatedAt: 1, preset: 'home', values: { a: 1 } });

    // ① setItem 直接抛
    const storage1 = memoryStorage(prevRaw);
    storage1.setItem = function () { this.setCalls += 1; throw new Error('quota exceeded'); };
    const r1 = S.writeAssetsState(storage1, { values: { a: 0 } });
    eq('写抛错：saved=false', r1.saved, false);
    eq('写抛错：reason=write-failed', r1.reason, 'write-failed');
    eq('写抛错：rolledBack=true', r1.rolledBack, true);
    eq('写抛错：旧记录原样', storage1.getItem(S.ASSETS_STORAGE_KEY), prevRaw);

    // ② setItem 写坏一半再抛（模拟非原子后端；回滚那次写入正常）
    const storage2 = memoryStorage(prevRaw);
    const realSet = storage2.setItem.bind(storage2);
    let badWrites = 0;
    storage2.setItem = function (key, value) {
        this.setCalls += 1;
        badWrites += 1;
        if (badWrites === 1) {
            realSet(key, String(value).slice(0, 20));   // 半截
            throw new Error('disk full');
        }
        realSet(key, value);                            // 回滚写入
    };
    const r2 = S.writeAssetsState(storage2, { values: { a: 0 } });
    eq('半截写：saved=false', r2.saved, false);
    eq('半截写：rolledBack=true', r2.rolledBack, true);
    eq('半截写：旧记录原样恢复', storage2.getItem(S.ASSETS_STORAGE_KEY), prevRaw);

    // ③ setItem 静默不写 → 回读校验失败
    const storage3 = memoryStorage(prevRaw);
    storage3.setItem = function () { this.setCalls += 1; /* 黑洞 */ };
    const r3 = S.writeAssetsState(storage3, { values: { a: 0 } });
    eq('静默不写：saved=false', r3.saved, false);
    eq('静默不写：reason=verify-failed', r3.reason, 'verify-failed');
    eq('静默不写：rolledBack=true', r3.rolledBack, true);
    eq('静默不写：旧记录原样', storage3.getItem(S.ASSETS_STORAGE_KEY), prevRaw);

    // ④ 原本没有记录 + 失败 → 不能留下半成品 key
    const storage4 = memoryStorage();
    storage4.setItem = function () { this.setCalls += 1; throw new Error('nope'); };
    const r4 = S.writeAssetsState(storage4, { values: { a: 1 } });
    eq('无旧记录：saved=false', r4.saved, false);
    eq('无旧记录：不留 key', storage4.getItem(S.ASSETS_STORAGE_KEY), null);

    // ⑤ 回滚本身失败（旧记录也已被破坏）要如实报告
    const storage5 = memoryStorage(prevRaw);
    storage5.setItem = function (key) {
        this.setCalls += 1;
        this.map.set(key, 'GARBAGE');   // 每次写都留下坏数据并抛错
        throw new Error('always');
    };
    const r5 = S.writeAssetsState(storage5, { values: { a: 1 } });
    eq('回滚失败：rolledBack=false（不假称已回滚）', r5.rolledBack, false);
}

console.log('\n[D] ui-controller 接线（静态）');
{
    const src = fs.readFileSync(UI_CONTROLLER, 'utf8');
    ok('优先调用 window.petAssets.saveAssetsState', /canonical\.saveAssetsState\(renderer\)/.test(src));
    ok('兜底走 costumeStore.writeAssetsState', /costumeStore\.writeAssetsState\(localStorage/.test(src));
    ok('恢复也优先权威模块', /canonical\.restoreSavedAssets\(renderer\)/.test(src));
    ok('兜底读用 costumeStore.readAssetsState', /costumeStore\.readAssetsState\(localStorage\)/.test(src));
    ok('不再直接写 JSON.stringify(snap) 到 localStorage', !/localStorage\.setItem\(ASSET_KEY/.test(src));
    ok('不再拼 {at: Date.now()} 的私有 schema', !/at:\s*Date\.now\(\)/.test(src));
}

console.log('\n================ 结果 ================');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
