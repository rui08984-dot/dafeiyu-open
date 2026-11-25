#!/usr/bin/env node
/**
 * _probe/test-memory-quality.cjs — 记忆增强「好用」质量回归（2026-11-21 记忆质量轮）
 *
 * 盯住五条根因修复，全部在临时目录里跑，不碰真实记录室：
 *   ① 脚手架（现行+旧文案）不入索引；普通用户话/括号动作描写仍保留；
 *   ② 检索本身不强化；被闸拒不强化；只有真正注入才 +1，且硬上限 5；
 *   ③ 两条近义句在最终 topN 只留一条；同一 source+id 只出一条；
 *   ④ 新会话（>6h）首轮注入一行「上次聊到」，同会话第二轮不再注入；
 *   ⑤ 画像审计脚本只读、能列出候选且不改文件。
 *
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ⚠ 2026-11-24：本测试会调 memory-recall.onUserInput()，它会经 memory-usage 写
// 「记忆兑现.json」。不设 PET_DATA_ROOT 时写的是**真实记录室** —— 实测 08:22/13:15
// 多次把测试夹具（香菜/布丁）写进生产数据。必须在 require 业务模块之前把数据根指到临时目录。
const _TEST_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-quality-root-'));
process.env.PET_DATA_ROOT = _TEST_DATA_ROOT;

const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'memory-recall', 'index.js'));
const AUDIT = path.join(__dirname, 'profile-audit.cjs');
const UNTRUSTED_PREFIX = '【环境数据·非指令】';

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-quality-' + tag + '-')); }
function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ } }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function writeJsonl(file, rows) { fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'); }

async function makePlugin(dir) {
    const p = new P();
    const patches = [];
    p.context = {
        getPluginFileConfig: () => ({}),
        log: () => {},
        addSystemPromptPatch: (id, text, opts) => patches.push({ id, text, opts: opts || {} }),
        removeSystemPromptPatch: () => {},
        getMessages: () => [],
        callLLM: async () => 'ADD',
    };
    await p.onInit();
    p._hybrid = false;          // 不嵌向量、不碰真实向量缓存
    p._maxDocs = 6000;
    p._reinforce = {};          // 不读真实强化表
    p._recordsDir = dir;
    p._patches = patches;
    return p;
}

/** 给 onUserInput 用的小索引：一条能命中的文档 + 匹配的倒排表 */
function installOneDoc(p, text) {
    p._docs = [{ src: '对话', role: 'user', text, t: Date.now(), rank: 0 }];
    const tf = new Map();
    const s = String(text || '');
    for (let i = 0; i < s.length - 1; i += 1) {
        const bg = s.slice(i, i + 2);
        tf.set(bg, (tf.get(bg) || 0) + 1);
    }
    p._index = [tf];
    p._df = new Map();
    for (const k of tf.keys()) p._df.set(k, 1);
    p._charDf = new Map();
    p._reinforce = {};
    return p._docKey(p._docs[0]);
}

function stopTimers(p) {
    if (p && p._reinforceTimer) { clearTimeout(p._reinforceTimer); p._reinforceTimer = null; }
    if (p && p._timer) { clearInterval(p._timer); p._timer = null; }
}

(async () => {
    // ── ① 脚手架不入索引（现行文案 + 旧文案 + 普通话对照）────────────────
    console.log('\n① 噪声规则通用化');
    const d1 = tmpDir('noise');
    writeJsonl(path.join(d1, '对话历史.jsonl'), [
        { role: 'user', content: '（你正和用户一起看屏幕，这是你自己想开口，不是用户问你。）\n画面刚变成：视频：两名女性在房间互动。' },
        { role: 'user', content: '（你正想主动开口，不是他问你。）你很困（精力 0%）而且已经深夜了。说一句想睡了的话，不超过 14 个字。' },
        { role: 'user', content: '[自动触发] 一句话 20 字以内，硬性要求：不要重复你最近说过的话' },
        { role: 'user', content: '{"ok":true,"tool":"uia","steps":["snapshot"]}' },
        { role: 'user', content: '（笑）今天也太热了' },
        { role: 'user', content: '今天有点累啊，陪我聊会儿吧' },
        { role: 'assistant', content: '（你正和用户一起看屏幕，这是你自己想开口）' },
    ]);
    const p1 = await makePlugin(d1);
    p1._rebuild({ dir: d1, skipExternal: true });
    const texts1 = p1._docs.map((d) => String(d.text));
    ok('现行脚手架「你正和用户一起看屏幕」不入索引', !texts1.some((t) => t.includes('你正和用户一起看屏幕') && t.includes('画面刚变成')));
    ok('现行脚手架「你正想主动开口」不入索引', !texts1.some((t) => t.includes('你正想主动开口')));
    ok('旧文案「[自动触发]」仍被挡', !texts1.some((t) => t.includes('[自动触发]')));
    ok('整段 JSON 工具回执不入索引', !texts1.some((t) => t.startsWith('{"ok"')));
    ok('普通用户话保留', texts1.some((t) => t.includes('陪我聊会儿吧')));
    ok('括号动作描写保留（不误杀「（笑）…」）', texts1.some((t) => t.includes('（笑）今天也太热了')));
    ok('assistant 的括号内容不按脚手架误删', texts1.some((t) => t.startsWith('（你正和用户一起看屏幕') && t.length < 30));
    ok('载入期噪声计数 >0', p1.debugState().quality.noiseDropped >= 4, 'noiseDropped=' + p1.debugState().quality.noiseDropped);
    ok('其中系统脚手架计数 ≥3', p1.debugState().quality.scaffoldDropped >= 3, 'scaffoldDropped=' + p1.debugState().quality.scaffoldDropped);

    // 存量清理：直接喂一条已入索引的脚手架，_installDocs 必须剪掉并计数
    p1._installDocs([{ src: '对话', role: 'user', text: '（你正和用户一起看屏幕，这是你自己想开口，不是用户问你。）' }]);
    ok('_installDocs 兜底剪掉存量脚手架', p1._docs.length === 0, 'docs=' + p1._docs.length);
    ok('存量剪枝计数 =1', p1.debugState().quality.rebuildPruned === 1, 'rebuildPruned=' + p1.debugState().quality.rebuildPruned);
    stopTimers(p1); rmrf(d1);

    // ── ② 强化只在注入后发生 + 硬上限 ───────────────────────────────────
    console.log('\n② 强化时机与上限');
    const d2 = tmpDir('reinf');
    const q = await makePlugin(d2);
    q._minScore = 0.01;
    q._minRel = 0.01;
    q._injectLimit = 1;
    const key = installOneDoc(q, '我不喜欢吃香菜');
    q._search('香菜', 1, 0);
    ok('检索本身不强化（_search 不再 +1）', q._reinforce[key] === undefined, 'count=' + q._reinforce[key]);

    await q.onUserInput({ text: '我不吃香菜' });
    const inj = q._patches.filter((x) => x.id === 'memory-recall-context');
    ok('注入 patch 已写入', inj.length === 1, 'patches=' + q._patches.map((x) => x.id).join(','));
    ok('注入后强化 +1', q._reinforce[key] === 1, 'count=' + q._reinforce[key]);
    ok('debugState.reinforced=1', q.debugState().quality.reinforced === 1);
    stopTimers(q); rmrf(d2);

    const d3 = tmpDir('gate');
    const r = await makePlugin(d3);
    r._minScore = 999;
    r._minRel = 0.9;
    r._injectLimit = 1;
    const key3 = installOneDoc(r, '我不喜欢吃香菜');
    await r.onUserInput({ text: '我不吃香菜' });
    ok('被闸拒时不注入', r._patches.filter((x) => x.id === 'memory-recall-context').length === 0);
    ok('被闸拒不强化', r._reinforce[key3] === undefined, 'count=' + r._reinforce[key3]);
    ok('未注入未强化计数 >0', r.debugState().quality.notInjectedNoReinforce > 0,
        'notInjected=' + r.debugState().quality.notInjectedNoReinforce);
    ok('reinforced 仍为 0', r.debugState().quality.reinforced === 0);
    stopTimers(r); rmrf(d3);

    const d4 = tmpDir('cap');
    const c = await makePlugin(d4);
    c._minScore = 0.01;
    c._minRel = 0.01;
    c._injectLimit = 1;
    const key4 = installOneDoc(c, '我不喜欢吃香菜');
    for (let i = 0; i < 8; i += 1) await c.onUserInput({ text: '我不吃香菜' });
    ok('连续注入 8 次后计数封顶 5', c._reinforce[key4] === P.REINFORCE_CAP, 'count=' + c._reinforce[key4]);
    ok('强化表里不存在 >5 的值', Object.values(c._reinforce).every((v) => v <= P.REINFORCE_CAP));
    ok('注入次数本身照常计数（8）', c.debugState().quality.reinforced === 8, 'reinforced=' + c.debugState().quality.reinforced);
    stopTimers(c); rmrf(d4);

    // ── ③ 近义去重 ───────────────────────────────────────────────────────
    console.log('\n③ 近义去重');
    const p3 = new P();
    const jBridge = P.bigramJaccard('猫的名字叫布丁', '我家猫的名字叫布丁');
    ok('「猫的名字叫布丁 / 我家猫的名字叫布丁」Jaccard ≥0.6', jBridge >= 0.6, 'j=' + jBridge.toFixed(3));
    ok('无关句 Jaccard <0.6', P.bigramJaccard('猫的名字叫布丁', '今天天气不错') < 0.6);
    const folded = p3._dedupeNear([
        { doc: { src: '对话', role: 'user', text: '猫的名字叫布丁' } },
        { doc: { src: '记忆库', role: 'user', text: '我家猫的名字叫布丁' } },
        { doc: { src: '对话', role: 'user', text: '今天天气不错' } },
    ], 10);
    ok('两条近义句只留一条', folded.length === 2, '留 ' + folded.length + ' 条');
    ok('保留分数更高的（先到的）那条', folded[0].doc.text === '猫的名字叫布丁');
    ok('去重折叠计数=1', p3._quality.dedupFolded === 1, 'dedupFolded=' + p3._quality.dedupFolded);
    const sameId = p3._dedupeNear([
        { doc: { src: '结论', id: 'ins-1', text: '用户喜欢猫' } },
        { doc: { src: '结论', id: 'ins-1', text: '用户很喜欢猫咪' } },
    ], 10);
    ok('同一 source+id 只出一条', sameId.length === 1, '留 ' + sameId.length + ' 条');

    // 端到端：注入的 topN 里近义句被折叠
    const d5 = tmpDir('dedup');
    const p5 = await makePlugin(d5);
    p5._minScore = 0.01;
    p5._minRel = 0.01;
    p5._injectLimit = 3;
    p5._docs = [
        { src: '对话', role: 'user', text: '猫的名字叫布丁', t: Date.now(), rank: 0 },
        { src: '记忆库', role: 'user', text: '我家猫的名字叫布丁', t: Date.now(), rank: 0 },
        { src: '对话', role: 'user', text: '今天天气不错', t: Date.now(), rank: 0 },
    ];
    p5._index = p5._docs.map((d) => {
        const tf = new Map();
        for (let i = 0; i < d.text.length - 1; i += 1) tf.set(d.text.slice(i, i + 2), 1);
        return tf;
    });
    p5._df = new Map();
    for (const tf of p5._index) for (const k of tf.keys()) p5._df.set(k, (p5._df.get(k) || 0) + 1);
    p5._charDf = new Map();
    const direct5 = p5._search('猫的名字', 5, 0);
    ok('检索层 topN 已折叠近义句', direct5.filter((h) => String(h.doc.text).includes('叫布丁')).length === 1,
        'hits=' + direct5.map((h) => h.doc.text).join(' / '));
    await p5.onUserInput({ text: '猫的名字' });
    const ctx5 = p5._patches.filter((x) => x.id === 'memory-recall-context');
    ok('注入端到端发生', ctx5.length === 1);
    if (ctx5.length) {
        // 解析 untrusted-data 数据行，数「布丁」那件事到底进了几条（两条是包含关系，不能用 includes 判）
        const dataLine = ctx5[0].text.split('\n').find((l) => l.startsWith(UNTRUSTED_PREFIX)) || '';
        let itemTexts = [];
        try {
            itemTexts = JSON.parse(dataLine.slice(UNTRUSTED_PREFIX.length)).memories.items.map((i) => String(i.text || ''));
        } catch (e) { itemTexts = []; }
        ok('注入内容里「布丁」这件事只有 1 条', itemTexts.filter((t) => t.includes('叫布丁')).length === 1,
            'items=' + JSON.stringify(itemTexts));
        ok('注入端到端折叠计数 ≥1', p5.debugState().quality.dedupFolded >= 1, 'dedupFolded=' + p5.debugState().quality.dedupFolded);
    }
    stopTimers(p5); rmrf(d5);

    // ── ④ 跨会话接续 ─────────────────────────────────────────────────────
    console.log('\n④ 跨会话接续');
    const fakeNow = Date.now();
    const d6 = tmpDir('continuity');
    fs.writeFileSync(path.join(d6, '上次见面.json'), JSON.stringify({ at: fakeNow - 7 * 3600 * 1000 }), 'utf8');
    writeJsonl(path.join(d6, '对话历史.jsonl'), [
        { role: 'user', content: '宝子我明天要面试' },
        { role: 'assistant', content: '那早点睡' },
        { role: 'user', content: '晚安' },
    ]);
    const p6 = await makePlugin(d6);
    p6._docs = [{ src: '对话', role: 'user', text: '占位', t: 0, rank: 0 }];
    p6._index = [new Map()];
    p6._df = new Map();
    p6._charDf = new Map();
    p6._reinforce = {};
    p6._now = () => fakeNow;
    await p6.onUserInput({ text: '我回来了' });
    const cont = p6._patches.filter((x) => x.id === 'memory-recall-continuity');
    ok('新会话首轮注入接续 patch', cont.length === 1, 'patches=' + p6._patches.map((x) => x.id).join(','));
    if (cont.length) {
        const dataLine = cont[0].text.split('\n').find((l) => l.startsWith(UNTRUSTED_PREFIX)) || '';
        ok('接续行走 untrusted-data 封装', dataLine.length > 0 && dataLine.startsWith(UNTRUSTED_PREFIX));
        ok('接续行整行 ≤120 字', dataLine.length <= 120, 'len=' + dataLine.length);
        ok('接续行含「上次聊到」', dataLine.includes('上次聊到'));
        ok('接续行含最后 2 条用户话', dataLine.includes('宝子我明天要面试') && dataLine.includes('晚安'));
        ok('接续是 volatile', cont[0].opts && cont[0].opts.volatile === true);
    }
    ok('continuityInjected=1', p6.debugState().quality.continuityInjected === 1);
    await p6.onUserInput({ text: '我回来了' });
    ok('同会话第二轮不再注入', p6._patches.filter((x) => x.id === 'memory-recall-continuity').length === 1);
    stopTimers(p6); rmrf(d6);

    const d7 = tmpDir('continuity-recent');
    fs.writeFileSync(path.join(d7, '上次见面.json'), JSON.stringify({ at: fakeNow - 1 * 3600 * 1000 }), 'utf8');
    writeJsonl(path.join(d7, '对话历史.jsonl'), [{ role: 'user', content: '晚安' }]);
    const p7 = await makePlugin(d7);
    p7._docs = [{ src: '对话', role: 'user', text: '占位', t: 0, rank: 0 }];
    p7._index = [new Map()];
    p7._df = new Map();
    p7._charDf = new Map();
    p7._now = () => fakeNow;
    await p7.onUserInput({ text: '我回来了' });
    ok('距上次 <6h 不注入接续', p7._patches.filter((x) => x.id === 'memory-recall-continuity').length === 0);
    stopTimers(p7); rmrf(d7);

    const d8 = tmpDir('continuity-scaffold');
    fs.writeFileSync(path.join(d8, '上次见面.json'), JSON.stringify({ at: fakeNow - 9 * 3600 * 1000 }), 'utf8');
    writeJsonl(path.join(d8, '对话历史.jsonl'), [{ role: 'user', content: '晚安' }]);
    const p8 = await makePlugin(d8);
    p8._docs = [{ src: '对话', role: 'user', text: '占位', t: 0, rank: 0 }];
    p8._index = [new Map()];
    p8._df = new Map();
    p8._charDf = new Map();
    p8._now = () => fakeNow;
    await p8.onUserInput({ text: '（你正和用户一起看屏幕，这是你自己想开口，不是用户问你。）' });
    ok('脚手架输入不触发接续', p8._patches.filter((x) => x.id === 'memory-recall-continuity').length === 0);
    stopTimers(p8); rmrf(d8);

    // ── ⑤ 画像审计脚本：只读、能列候选、不改文件 ─────────────────────────
    console.log('\n⑤ 画像审计（只读）');
    const d9 = tmpDir('profile');
    const profileFile = path.join(d9, '用户画像.json');
    fs.writeFileSync(profileFile, JSON.stringify({
        name: '',
        traits: [],
        habits: ['每周六上午去游泳', '本次表示要去自慰，一次性行为'],
        preferences: { likes: [], dislikes: [] },
        facts: ['今天下午三点有会议安排', '老婆的生日是12月5日', '自述确诊中度抑郁', '养了一只仓鼠'],
        relationships: [],
    }, null, 2), 'utf8');
    const hashBefore = sha256(profileFile);
    const statBefore = fs.statSync(profileFile).mtimeMs;
    const run = spawnSync(process.execPath, [AUDIT, '--file', profileFile, '--json'], { encoding: 'utf8' });
    ok('审计脚本退出码 0', run.status === 0, 'status=' + run.status + ' stderr=' + String(run.stderr || '').slice(0, 120));
    let auditJson = null;
    try { auditJson = JSON.parse(run.stdout); } catch (e) { auditJson = null; }
    ok('--json 输出可解析', !!auditJson);
    if (auditJson) {
        ok('识别出至少 3 条一次性候选', auditJson.counts.one_off >= 3, 'one_off=' + auditJson.counts.one_off);
        const allText = auditJson.candidates.map((x) => x.text);
        ok('列出「今天下午三点有会议安排」', allText.includes('今天下午三点有会议安排'));
        ok('列出「自述确诊中度抑郁」', allText.includes('自述确诊中度抑郁'));
        ok('列出「本次表示要去自慰，一次性行为」', allText.includes('本次表示要去自慰，一次性行为'));
        ok('不误报生日', !allText.includes('老婆的生日是12月5日'));
        ok('不误报每周游泳习惯', !allText.includes('每周六上午去游泳'));
        ok('不误报养仓鼠', !allText.includes('养了一只仓鼠'));
        ok('每条候选都有匹配理由', auditJson.candidates.every((x) => Array.isArray(x.reasons) && x.reasons.length > 0));
    }
    ok('审计后文件哈希未变（只读）', sha256(profileFile) === hashBefore);
    ok('审计后 mtime 未变（未写入）', fs.statSync(profileFile).mtimeMs === statBefore);

    const runText = spawnSync(process.execPath, [AUDIT, '--file', profileFile], { encoding: 'utf8' });
    ok('无 --json 时退出码 0', runText.status === 0);
    ok('文本报告声明只读', /只读/.test(String(runText.stdout || '')) && /未写入任何文件/.test(String(runText.stdout || '')));
    rmrf(d9);

    // ── ⑥ debugState 可观测性 ────────────────────────────────────────────
    console.log('\n⑥ debugState 可观测计数');
    const p10 = new P();
    const ds = p10.debugState();
    ok('debugState 暴露质量计数', ds && ds.quality && typeof ds.quality === 'object');
    for (const k of ['noiseDropped', 'scaffoldDropped', 'rebuildPruned', 'dedupFolded', 'gateRejected', 'limitDropped', 'reinforced', 'continuityInjected', 'notInjectedNoReinforce']) {
        ok('计数项存在：' + k, Object.prototype.hasOwnProperty.call(ds.quality, k));
    }
    ok('强化上限常量 =5', ds.reinforceCap === 5 && P.REINFORCE_CAP === 5);

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过' + (fail ? '，失败 ' + fail + ' 条' : ''));
    if (fail) {
        console.error('失败项：\n  - ' + failures.join('\n  - '));
        process.exitCode = 1;
    }
})().catch((e) => {
    console.error('测试自身异常：' + (e && e.stack || e));
    process.exitCode = 1;
});
