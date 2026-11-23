#!/usr/bin/env node
/**
 * _probe/test-forget-tombstones.cjs — 遗忘墓碑（2026-11-22）
 *
 * 现场：用户说「忘掉 X」，她回答「好，忘了」，但下次启动/重建索引后 X 又出现。
 * 根因：memory-recall 的遗忘路径只删 用户记忆.json + 用户事实.json + MemOS，
 * 而 _rebuild() 还会索引 对话历史.jsonl / 记忆库.txt / AI日记.txt / 片段卡 ——
 * 原文仍在，于是又被注入；built-in memos 从 MemOS 检索到的旧条目同理。
 *
 * 本探针盯住的契约：
 *   ① 精确 / 包含匹配，短墓碑（<6 字）只做精确匹配（「猫」不许误杀一大片）；
 *   ② 大小写、空白、中英标点归一化；重复 add 不重复计数；500 上限按 at 丢最旧；
 *   ③ 墓碑文件损坏 → isForgotten=false、不抛、不删坏文件；
 *   ④ 集成：重建能索引到目标内容 → add 墓碑 + reload 后重建不再出现（历史文件不动）；
 *      墓碑文件不存在时与旧版行为一致；
 *   ⑤ 遗忘成功路径的返回值带 tombstoned；built-in memos 注入侧过滤墓碑条目。
 *
 * 数据隔离：PET_DATA_ROOT + mkdtemp（与 test-memory-scaffold-filter.cjs 同一写法），
 * 所有落盘都在临时目录；不联网、不写真实 data / MemOS。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

// ⚠ 顺序：先设 PET_DATA_ROOT，再 require 业务模块（records-path 在加载时解析记录室路径）。
const tmpRoot = iso.setUpTempDataRoot('pet-forget-tombstones-');
const REC = path.join(tmpRoot, 'data');
fs.mkdirSync(REC, { recursive: true });

const T = require(path.join(APP, 'js', 'core', 'forget-tombstones.js'));
const RP = require(path.join(APP, 'js', 'core', 'records-path.js'));
const TOMB_FILE = RP.recordFile('遗忘墓碑.json');
const REAL_REC = path.resolve(APP, '..', 'data');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

/** 清掉墓碑（含坏文件留档）并让内存缓存重读，保证各段互不影响。 */
function resetTomb() {
    try {
        for (const f of fs.readdirSync(REC)) {
            if (f.startsWith('遗忘墓碑.json')) fs.rmSync(path.join(REC, f), { force: true });
        }
    } catch (e) { /* 目录不存在也继续：reload 会按空表处理 */ }
    T.reload();
}

function writeHistory() {
    const rows = [
        { role: 'user', content: '我家猫叫布丁' },
        { role: 'assistant', content: '布丁真可爱，几岁了？' },
    ];
    fs.writeFileSync(path.join(REC, '对话历史.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function writeUserMemory(content) {
    fs.writeFileSync(path.join(REC, '用户记忆.json'), JSON.stringify([
        { id: 1, date: '2026年11月20日', content, source: 'explicit' },
    ], null, 2), 'utf8');
}

(async () => {
    console.log('[1] 归一化与匹配：精确 / 包含 / 中英标点 / 大小写');
    resetTomb();
    ok('墓碑文件不存在时 isForgotten 恒 false（旧版行为）', T.isForgotten('我家猫叫布丁') === false);
    ok('add 返回新增条数', T.add(['我家猫叫布丁'], { source: 'forget' }) === 1);
    ok('精确匹配', T.isForgotten('我家猫叫布丁') === true);
    ok('空白/句号/引号归一化后仍精确命中', T.isForgotten('  “我家猫叫布丁”，他说。 ') === true);
    ok('包含匹配（墓碑 ≥6 字）', T.isForgotten('其实我家猫叫布丁，你记住了吗') === true);
    ok('不含墓碑的文本不误杀', T.isForgotten('我家猫叫布') === false);
    ok('add 英文（大小写 + 空格）', T.add(['My Cat Is Pudding']) === 1);
    ok('英文大小写归一化后精确命中', T.isForgotten('mycatispudding') === true);
    ok('英文包含匹配（空格/感叹号归一化）', T.isForgotten('I think my cat is pudding!!') === true);

    console.log('[1b] 短墓碑只做精确匹配（防误杀）');
    resetTomb();
    ok('add 单字「猫」', T.add(['猫']) === 1);
    ok('单字精确命中', T.isForgotten('猫') === true);
    ok('单字不做包含匹配（不误杀「我家猫叫布丁」）', T.isForgotten('我家猫叫布丁') === false);
    ok('add 4 字「猫叫布丁」', T.add(['猫叫布丁']) === 1);
    ok('4 字墓碑精确命中', T.isForgotten('猫叫布丁。') === true);
    ok('4 字墓碑不做包含匹配', T.isForgotten('我家猫叫布丁呀') === false);

    console.log('[1c] 去重与 stats');
    resetTomb();
    ok('批量 add 返回 2', T.add(['布丁是我家的猫', '我喜欢下雨天']) === 2);
    ok('重复 add（仅标点/空白差异）不重复计数', T.add(['布丁是我家的猫', '  布丁是我家的猫。 ']) === 0);
    ok('stats.count 正确', T.stats().count === 2, 'count=' + T.stats().count);
    ok('stats.lastAt 是有效时间戳', T.stats().lastAt > 0, 'lastAt=' + T.stats().lastAt);

    console.log('[2] 上限 500：超了按 at 丢最旧');
    resetTomb();
    for (let i = 0; i < 501; i += 1) {
        T.add(['遗忘压力条目' + String(i).padStart(4, '0')], { at: 1000000 + i });
    }
    ok('count 封顶 500', T.stats().count === 500, 'count=' + T.stats().count);
    ok('最旧一条被丢（at 最小）', T.isForgotten('遗忘压力条目0000') === false);
    ok('次旧一条保留', T.isForgotten('遗忘压力条目0001') === true);
    ok('最新一条保留', T.isForgotten('遗忘压力条目0500') === true);

    console.log('[3] 坏文件：视为空表、不抛、不删除');
    resetTomb();
    fs.writeFileSync(TOMB_FILE, '{ this is not json', 'utf8');
    let threw = false;
    try { T.reload(); } catch (e) { threw = true; }
    ok('reload 不抛', !threw);
    ok('坏文件下 isForgotten=false', T.isForgotten('任何内容') === false);
    ok('坏文件未被删除', fs.existsSync(TOMB_FILE));
    ok('坏文件内容未被改写', fs.readFileSync(TOMB_FILE, 'utf8').includes('this is not json'));
    ok('坏文件之后 add 仍能写入', T.add(['坏文件之后的新墓碑']) === 1);
    ok('新墓碑立即生效', T.isForgotten('坏文件之后的新墓碑') === true);
    const backups = fs.readdirSync(REC).filter((f) => f.startsWith('遗忘墓碑.json.corrupt-'));
    ok('坏文件已留档（改名而非删除）', backups.length >= 1, backups.join(','));

    console.log('[4] 集成：memory-recall 重建索引前后');
    resetTomb();
    writeHistory();
    writeUserMemory('我家猫叫布丁');

    const Recall = require(path.join(APP, 'plugins', 'community', 'memory-recall', 'index.js'));
    const p = new Recall();
    p.context = {
        getPluginFileConfig: () => ({}),
        log: () => {},
        addSystemPromptPatch: () => {},
        removeSystemPromptPatch: () => {},
        getMessages: () => [],
        callLLM: async () => 'ADD',
    };
    await p.onInit();
    p._recordsDir = REC;
    p._hybrid = false;                 // 不嵌向量、不碰真实向量缓存
    p._reinforce = {};                 // 不读真实强化表
    p._reinforceDocs = () => {};       // 不写真实强化表

    p._rebuild();
    const before = p._docs.map((d) => String(d.text));
    ok('无墓碑文件时能索引到目标对话（与旧版一致）', before.some((t) => t.includes('我家猫叫布丁')),
        'docs=' + before.length);
    ok('无墓碑时墓碑计数为 0', p._tombstonedCount === 0);

    ok('遗忘 add 返回 1', T.add(['我家猫叫布丁'], { source: 'forget' }) === 1);
    T.reload();
    p._rebuild();
    const after = p._docs.map((d) => String(d.text));
    ok('墓碑后重建不再索引目标内容', !after.some((t) => t.includes('我家猫叫布丁')));
    ok('过滤条数记录在 _tombstonedCount（对话 + 用户记忆 = 2）', p._tombstonedCount === 2,
        'tombstoned=' + p._tombstonedCount);
    ok('_sourcesText 带上「墓碑 N」', /墓碑\s*2/.test(p._sourcesText()), p._sourcesText());
    ok('只杀命中条目，assistant 同话题回复仍在', after.some((t) => t.includes('布丁真可爱')));
    ok('历史文件未被改写（仍可审计）',
        fs.readFileSync(path.join(REC, '对话历史.jsonl'), 'utf8').includes('我家猫叫布丁'));

    console.log('[4b] 落盘隔离');
    let isolated = true;
    try { iso.assertIsolated(TOMB_FILE); } catch (e) { isolated = false; }
    ok('assertIsolated 通过（墓碑在 PET_DATA_ROOT 下）', isolated, TOMB_FILE);
    ok('墓碑文件实际存在', fs.existsSync(TOMB_FILE));
    ok('记录室不是真实 data', path.resolve(RP.RECORDS_DIR) !== REAL_REC
        && path.resolve(RP.RECORDS_DIR).startsWith(path.resolve(tmpRoot)), RP.RECORDS_DIR);

    console.log('[5] 遗忘路径接线：返回值带 tombstoned，重建不再注入');
    writeUserMemory('我喜欢喝无糖可乐');
    p._deleteFromMemos = async () => ({ ok: true, searched: 0, deleted: 0 });
    const res = await p._forgetUserMemory({ mode: 'match', query: '我喜欢喝无糖可乐' });
    ok('遗忘返回 ok', !!(res && res.ok === true), JSON.stringify({ ok: res && res.ok, error: res && res.error }));
    ok('返回值带 tombstoned', Number(res.tombstoned) >= 1, 'tombstoned=' + res.tombstoned);
    const left = JSON.parse(fs.readFileSync(path.join(REC, '用户记忆.json'), 'utf8'));
    ok('用户记忆已删除', !left.some((x) => String(x.content).includes('无糖可乐')));
    ok('内容已进墓碑', T.isForgotten('我喜欢喝无糖可乐') === true);
    ok('重建后不再索引该内容', !p._docs.some((d) => String(d.text).includes('我喜欢喝无糖可乐')));
    await res.memosPending;

    console.log('[5b] 用户记忆为空时的事实层-only 分支：同样落墓碑');
    fs.writeFileSync(path.join(REC, '用户记忆.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(REC, '用户事实.json'), JSON.stringify({
        version: 1,
        updated_at: Date.now(),
        facts: [{ id: 'f1', fact: '我对花生过敏', source: 'explicit', confidence: 0.95, valid_from: Date.now() }],
    }, null, 2), 'utf8');
    p._deleteFromMemos = async () => ({ ok: true, searched: 0, deleted: 0 });
    const res2 = await p._forgetUserMemory({ mode: 'match', query: '我对花生过敏' });
    ok('事实层-only 遗忘返回 ok', !!(res2 && res2.ok === true), JSON.stringify({ ok: res2 && res2.ok, error: res2 && res2.error }));
    ok('factsRemoved 记录删除条数', Number(res2.factsRemoved) >= 1, 'factsRemoved=' + res2.factsRemoved);
    ok('事实层-only 返回值带 tombstoned', Number(res2.tombstoned) >= 1, 'tombstoned=' + res2.tombstoned);
    ok('事实层-only 内容已进墓碑', T.isForgotten('我对花生过敏') === true);
    await res2.memosPending;
    p._deleteFromMemos = null;

    console.log('[6] built-in memos：MemOS 检索结果按墓碑过滤');
    {
        const MemosPlugin = require(path.join(APP, 'plugins', 'built-in', 'memos', 'index.js'));
        const patches = {};
        const removed = [];
        const logs = [];
        const ctx = {
            addSystemPromptPatch: (id, text) => { patches[id] = text; },
            removeSystemPromptPatch: (id) => { removed.push(id); delete patches[id]; },
            log: (level, msg) => { logs.push(String(msg)); },
            getMessages: () => [],
        };
        const mp = new MemosPlugin({}, ctx);
        const results = [
            { content: '我家猫叫布丁' },
            '我家猫叫布丁，很乖',
            { content: '今天天气不错' },
        ];
        mp.client = {
            enabled: true,
            search: async () => results.slice(),
            formatMemoriesForPrompt: (arr) => arr.map((m) => '- ' + (typeof m === 'string' ? m : m.content)).join('\n'),
        };
        mp._cfg = { auto_inject: true };
        await mp.onUserInput({ text: '我家猫叫啥来着', source: 'text' });
        const patch = patches['memos-recall'] || '';
        ok('墓碑命中的两条被过滤，正常条目仍注入',
            patch.includes('今天天气不错') && !patch.includes('布丁'), patch.slice(0, 80));
        ok('每轮最多 log 一次过滤条数',
            logs.filter((m) => m.includes('遗忘墓碑')).length === 1,
            logs.filter((m) => m.includes('遗忘墓碑')).join(' | '));

        mp.client.search = async () => [{ content: '我家猫叫布丁' }];
        await mp.onUserInput({ text: '猫', source: 'text' });
        ok('全部命中墓碑时照旧移除补丁', removed.includes('memos-recall') && !patches['memos-recall'],
            'removed=' + removed.length);
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    iso.cleanup(tmpRoot);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    iso.cleanup(tmpRoot);
    process.exit(1);
});
