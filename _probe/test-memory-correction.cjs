#!/usr/bin/env node
/**
 * _probe/test-memory-correction.cjs — B1 记忆纠正写穿（2026-11-22）
 *
 * 现场：用户说「不对，是…」，模型调 memory action=correct，MemOS 改对了，
 * 但本地 data/用户记忆.json 没变（memory-recall 注入读本地）→ 旧说法继续出现。
 *
 * 本探针盯住的契约：
 *   ① correct     ：旧正文进墓碑；本地匹配条目改成 new_content；匹配不到就追加
 *   ② supplement  ：不墓碑旧值；追加 new_content（source=correction）
 *   ③ delete/archive：旧正文进墓碑；本地匹配条目删除，未命中的保留
 *   ④ merge       ：旧正文进墓碑；本地匹配条目改成目标正文（响应 target_content）
 *   ⑤ 旧后端响应没有 old_content：不猜、不墓碑，只做能做的（supplement 追加），
 *                   并在文案里报「旧文未知」
 *   ⑥ 本地 json 损坏：json-store 隔离坏文件、不拿空表覆盖；墓碑仍写入；文案报失败
 *   ⑦ MemOS 请求失败：本地与墓碑都不动
 *   ⑧ 所有落盘都在 PET_DATA_ROOT 临时目录（不碰真实 data）
 *
 * 隔离写法：PET_DATA_ROOT + mkdtemp（与 test-forget-tombstones.cjs 一致）。
 * axios.post 在 require tools.js 前 monkey-patch —— 不联网、不向真实 8003 发请求。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

// ⚠ 顺序：先设 PET_DATA_ROOT，再 require 业务模块（records-path 在加载时解析记录室路径）。
const tmpRoot = iso.setUpTempDataRoot('pet-memory-correction-');
const REC = path.join(tmpRoot, 'data');
fs.mkdirSync(REC, { recursive: true });

// mock axios.post：tools.js 与这里 require 到同一个模块实例，改属性即可。
const axios = require(path.join(APP, 'node_modules', 'axios'));
let calls = [];
let nextResponse = null;
axios.post = async function (url, body) {
    calls.push({ url, body });
    if (nextResponse instanceof Error) throw nextResponse;
    return { data: nextResponse };
};

const { MemosTools } = require(path.join(APP, 'plugins', 'built-in', 'memos', 'tools.js'));
const tombstones = require(path.join(APP, 'js', 'core', 'forget-tombstones.js'));
const RP = require(path.join(APP, 'js', 'core', 'records-path.js'));
const USER_MEM = RP.recordFile('用户记忆.json');
const TOMB = RP.recordFile('遗忘墓碑.json');
const REAL_REC = path.resolve(APP, '..', 'data');

const tools = new MemosTools('http://127.0.0.1:8003');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function readLocal() {
    try { return JSON.parse(fs.readFileSync(USER_MEM, 'utf8')); } catch (e) { return null; }
}

function writeLocal(arr) {
    fs.mkdirSync(path.dirname(USER_MEM), { recursive: true });
    fs.writeFileSync(USER_MEM, JSON.stringify(arr, null, 2), 'utf8');
}

/** 清墓碑（含坏文件留档）并重载内存缓存，保证各段互不影响。 */
function resetTomb() {
    try {
        for (const f of fs.readdirSync(REC)) {
            if (f.startsWith('遗忘墓碑.json')) fs.rmSync(path.join(REC, f), { force: true });
        }
    } catch (e) { /* 目录不存在也继续 */ }
    tombstones.reload();
}

function setResponse(resp) {
    nextResponse = resp;
    calls = [];
}

/** 走公开 execute('memory', ...) 路径，同时验证外层 action → correct_action 映射。 */
function correct(params) {
    return tools.execute('memory', Object.assign({ action: 'correct' }, params));
}

(async () => {
    console.log('[1] correct：旧正文进墓碑，本地匹配条目改成新说法');
    resetTomb();
    writeLocal([{ id: 1, date: '2026年11月20日', content: '用户喜欢喝无糖可乐' }]);
    setResponse({
        status: 'success', action: 'corrected', memory_id: 'm1',
        new_content: '用户喜欢喝有糖可乐', old_content: '用户喜欢喝无糖可乐',
    });
    let r = await correct({ memory_id: 'm1', correct_action: 'correct', new_content: '用户喜欢喝有糖可乐' });
    ok('返回「本地已同步」', String(r).includes('本地已同步'), String(r).replace(/\n/g, ' | '));
    ok('请求仍走 /memory/feedback 且字段不变',
        calls.length === 1 && calls[0].url.endsWith('/memory/feedback') &&
        calls[0].body.feedback_type === 'correct' && calls[0].body.correction === '用户喜欢喝有糖可乐',
        JSON.stringify(calls[0] && calls[0].body));
    let arr = readLocal();
    ok('本地条目已改成新说法', Array.isArray(arr) && arr.length === 1 && arr[0].content === '用户喜欢喝有糖可乐',
        JSON.stringify(arr));
    ok('原 id / date 保留', arr && arr[0].id === 1 && arr[0].date === '2026年11月20日');
    ok('旧说法进墓碑', tombstones.isForgotten('用户喜欢喝无糖可乐') === true);
    ok('新说法不进墓碑', tombstones.isForgotten('用户喜欢喝有糖可乐') === false);

    console.log('[2] correct：本地找不到旧说法 → 追加一条新内容');
    resetTomb();
    writeLocal([{ id: 3, date: '2026年11月19日', content: '今天天气不错' }]);
    setResponse({
        status: 'success', action: 'corrected', memory_id: 'm2',
        new_content: '用户养了一只猫叫布丁', old_content: '用户养了一只狗叫旺财',
    });
    r = await correct({ memory_id: 'm2', correct_action: 'correct', new_content: '用户养了一只猫叫布丁' });
    arr = readLocal();
    ok('返回「本地已同步」+ 追加上报', String(r).includes('本地已同步') && String(r).includes('追加'), String(r).replace(/\n/g, ' | '));
    ok('本地原有条目不丢', Array.isArray(arr) && arr.some((x) => x.content === '今天天气不错'));
    ok('追加了 source=correction 的新条目',
        arr.some((x) => x.content === '用户养了一只猫叫布丁' && x.source === 'correction'),
        JSON.stringify(arr));
    ok('新条目 id 不撞已有 id', arr.filter((x) => x.content === '用户养了一只猫叫布丁')[0].id > 3);
    ok('旧说法进墓碑', tombstones.isForgotten('用户养了一只狗叫旺财') === true);

    console.log('[3] supplement：不墓碑旧值，追加新内容');
    resetTomb();
    writeLocal([{ id: 1, date: '2026年11月20日', content: '用户喜欢喝无糖可乐' }]);
    setResponse({
        status: 'success', action: 'supplemented', memory_id: 'm1',
        new_content: '用户喜欢喝无糖可乐\n[补充] 用户还喜欢喝雪碧',
        old_content: '用户喜欢喝无糖可乐',
    });
    r = await correct({ memory_id: 'm1', correct_action: 'supplement', new_content: '用户还喜欢喝雪碧' });
    arr = readLocal();
    ok('返回「本地已同步」', String(r).includes('本地已同步'), String(r).replace(/\n/g, ' | '));
    ok('旧说法没有进墓碑（补充不是否定）', tombstones.isForgotten('用户喜欢喝无糖可乐') === false);
    ok('本地追加了补充内容', arr.some((x) => x.content === '用户还喜欢喝雪碧' && x.source === 'correction'),
        JSON.stringify(arr));
    ok('原条目保持不变', arr.some((x) => x.id === 1 && x.content === '用户喜欢喝无糖可乐'));

    console.log('[4] delete：旧正文进墓碑，本地匹配条目删除');
    resetTomb();
    writeLocal([
        { id: 1, date: '2026年11月20日', content: '用户喜欢喝无糖可乐' },
        { id: 2, date: '2026年11月20日', content: '今天天气不错' },
    ]);
    setResponse({ status: 'success', action: 'deleted', memory_id: 'm1', old_content: '用户喜欢喝无糖可乐' });
    r = await correct({ memory_id: 'm1', correct_action: 'delete' });
    arr = readLocal();
    ok('返回「本地已同步」+ 删除条数', String(r).includes('本地已同步') && String(r).includes('删除本地条目 1 条'),
        String(r).replace(/\n/g, ' | '));
    ok('匹配条目已删', !arr.some((x) => x.content.includes('无糖可乐')));
    ok('未匹配条目不误删', arr.some((x) => x.content === '今天天气不错'));
    ok('旧说法进墓碑', tombstones.isForgotten('用户喜欢喝无糖可乐') === true);

    console.log('[5] archive：旧正文进墓碑，本地匹配条目删除');
    resetTomb();
    writeLocal([{ id: 1, date: '2026年11月20日', content: '用户喜欢喝无糖可乐' }]);
    setResponse({ status: 'success', action: 'archived', memory_id: 'm1', old_content: '用户喜欢喝无糖可乐' });
    r = await correct({ memory_id: 'm1', correct_action: 'archive' });
    arr = readLocal();
    ok('返回「本地已同步」', String(r).includes('本地已同步'), String(r).replace(/\n/g, ' | '));
    ok('本地条目已删', Array.isArray(arr) && arr.length === 0, JSON.stringify(arr));
    ok('旧说法进墓碑', tombstones.isForgotten('用户喜欢喝无糖可乐') === true);

    console.log('[6] merge：旧正文进墓碑，本地匹配条目改成目标正文');
    resetTomb();
    writeLocal([
        { id: 1, date: '2026年11月20日', content: '用户养了一只狗叫旺财' },
        { id: 2, date: '2026年11月20日', content: '今天天气不错' },
    ]);
    setResponse({
        status: 'success', action: 'merged', memory_id: 'm1',
        source_id: 'm1', target_id: 'm2', target_memory_id: 'm2',
        old_content: '用户养了一只狗叫旺财',
        target_content: '用户养了一只狗叫旺财，还有一只猫叫布丁',
        merged_content: '用户养了一只狗叫旺财，还有一只猫叫布丁\n[合并自 m1] 用户养了一只狗叫旺财',
    });
    r = await correct({ memory_id: 'm1', correct_action: 'merge', target_memory_id: 'm2' });
    arr = readLocal();
    ok('返回「本地已同步」', String(r).includes('本地已同步'), String(r).replace(/\n/g, ' | '));
    ok('匹配条目已改成目标正文',
        arr.some((x) => x.id === 1 && x.content === '用户养了一只狗叫旺财，还有一只猫叫布丁'),
        JSON.stringify(arr));
    ok('未匹配条目不受影响', arr.some((x) => x.content === '今天天气不错'));
    ok('被合并掉的旧说法进墓碑', tombstones.isForgotten('用户养了一只狗叫旺财') === true);

    console.log('[6b] merge：响应缺 target_content → 不改写本地、不猜（仍墓碑旧文）');
    resetTomb();
    writeLocal([{ id: 1, date: '2026年11月20日', content: '用户养了一只狗叫旺财' }]);
    setResponse({
        status: 'success', action: 'merged', memory_id: 'm1', target_memory_id: 'm2',
        old_content: '用户养了一只狗叫旺财',
        merged_content: '目标正文不可拆\n[合并自 m1] 用户养了一只狗叫旺财',
    });
    r = await correct({ memory_id: 'm1', correct_action: 'merge', target_memory_id: 'm2' });
    arr = readLocal();
    ok('返回「本地部分同步 / 缺少目标正文」',
        String(r).includes('本地部分同步') && String(r).includes('缺少目标正文'),
        String(r).replace(/\n/g, ' | '));
    ok('本地条目保持原样（不拿 merged_content 硬拆）', arr[0].content === '用户养了一只狗叫旺财');
    ok('旧说法仍进墓碑', tombstones.isForgotten('用户养了一只狗叫旺财') === true);

    console.log('[7] 旧后端没有 old_content：不猜、不墓碑，只做能做的');
    resetTomb();
    writeLocal([{ id: 1, date: '2026年11月20日', content: '用户喜欢喝无糖可乐' }]);
    setResponse({ status: 'success', action: 'corrected', memory_id: 'm1', new_content: '用户喜欢喝有糖可乐' });
    r = await correct({ memory_id: 'm1', correct_action: 'correct', new_content: '用户喜欢喝有糖可乐' });
    arr = readLocal();
    ok('correct 文案含「旧文未知」', String(r).includes('旧文未知'), String(r).replace(/\n/g, ' | '));
    ok('correct 未墓碑（不猜）', tombstones.stats().count === 0, 'count=' + tombstones.stats().count);
    ok('correct 未改本地（不知道旧文）', arr[0].content === '用户喜欢喝无糖可乐');

    resetTomb();
    writeLocal([{ id: 1, date: '2026年11月20日', content: '用户喜欢喝无糖可乐' }]);
    setResponse({ status: 'success', action: 'supplemented', memory_id: 'm1', new_content: '用户还喜欢喝雪碧' });
    r = await correct({ memory_id: 'm1', correct_action: 'supplement', new_content: '用户还喜欢喝雪碧' });
    arr = readLocal();
    ok('supplement 文案含「旧文未知」', String(r).includes('旧文未知'), String(r).replace(/\n/g, ' | '));
    ok('supplement 仍能追加（旧文未知不影响补充）',
        arr.some((x) => x.content === '用户还喜欢喝雪碧' && x.source === 'correction'), JSON.stringify(arr));
    ok('supplement 不墓碑', tombstones.stats().count === 0, 'count=' + tombstones.stats().count);

    console.log('[8] MemOS 请求失败：本地与墓碑都不动');
    resetTomb();
    writeLocal([{ id: 1, date: '2026年11月20日', content: '用户喜欢喝无糖可乐' }]);
    nextResponse = new Error('connect ECONNREFUSED');
    calls = [];
    r = await correct({ memory_id: 'm1', correct_action: 'correct', new_content: '用户喜欢喝有糖可乐' });
    arr = readLocal();
    ok('返回错误文案', String(r).includes('ECONNREFUSED') || String(r).includes('记忆系统服务未启动'),
        String(r).replace(/\n/g, ' | '));
    ok('本地未改', arr[0].content === '用户喜欢喝无糖可乐');
    ok('墓碑未写', tombstones.stats().count === 0, 'count=' + tombstones.stats().count);

    console.log('[9] 本地用户记忆损坏：json-store 隔离、不覆盖，墓碑仍写');
    resetTomb();
    writeLocal([{ id: 1, content: '占位' }]);
    fs.writeFileSync(USER_MEM, '{ this is not json', 'utf8');
    setResponse({
        status: 'success', action: 'corrected', memory_id: 'm1',
        new_content: '用户喜欢喝有糖可乐', old_content: '用户喜欢喝无糖可乐',
    });
    r = await correct({ memory_id: 'm1', correct_action: 'correct', new_content: '用户喜欢喝有糖可乐' });
    const corre = fs.readdirSync(REC).filter((f) => f.startsWith('用户记忆.json.corrupt-'));
    ok('文案报「本地同步失败」', String(r).includes('本地同步失败'), String(r).replace(/\n/g, ' | '));
    ok('坏文件已改名为 .corrupt-*', corre.length === 1, corre.join(','));
    ok('坏文件内容原样保留（可人工抢救）',
        corre.length === 1 && fs.readFileSync(path.join(REC, corre[0]), 'utf8').includes('this is not json'));
    ok('没有用空表覆盖生成新的 用户记忆.json', !fs.existsSync(USER_MEM));
    ok('墓碑仍然写入（旧说法不再注入）', tombstones.isForgotten('用户喜欢喝无糖可乐') === true);

    console.log('[10] 落盘隔离');
    let isolatedTomb = true;
    let isolatedMem = true;
    try { iso.assertIsolated(TOMB); } catch (e) { isolatedTomb = false; }
    try { iso.assertIsolated(USER_MEM); } catch (e) { isolatedMem = false; }
    ok('墓碑文件在 PET_DATA_ROOT 下', isolatedTomb, TOMB);
    ok('用户记忆文件在 PET_DATA_ROOT 下', isolatedMem, USER_MEM);
    ok('记录室不是真实 data',
        path.resolve(RP.RECORDS_DIR) !== REAL_REC && path.resolve(RP.RECORDS_DIR).startsWith(path.resolve(tmpRoot)),
        RP.RECORDS_DIR);

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    iso.cleanup(tmpRoot);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    iso.cleanup(tmpRoot);
    process.exit(1);
});
