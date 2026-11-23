#!/usr/bin/env node
/**
 * _probe/test-reflection-tombstones.cjs —— 反思写入侧也吃遗忘墓碑（2026-11-22）
 *
 * 背景：`forget-tombstones` 首版只挡「召回」（memory-recall 重建索引 + MemOS 注入）。
 * 但 memory-evolve 的反思会把片段卡/旧 insight 重新归纳成新 insight 写回 insights.jsonl ——
 * 用户说「忘掉」的内容会从这里**复活**。本测试钉住三条：
 *   ① 一批片段全部命中墓碑 → 不调 LLM、不写 insights，但**游标必须前进**（不能每拍重读）
 *   ② 混合批次 → 调 LLM 的 prompt 里不得出现已忘内容，正常内容仍在
 *   ③ 产出侧还有一道过滤（源码接线断言：写盘前按墓碑剔一次）
 *
 * 纯离线：PET_DATA_ROOT + mkdtemp；LLM 用桩函数捕获 prompt，不联网。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const tmpRoot = iso.setUpTempDataRoot('pet-reflect-tomb-');
const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

const tombstones = require(path.join(APP, 'js', 'core', 'forget-tombstones.js'));
const insightsStore = require(path.join(APP, 'plugins', 'community', 'memory-evolve', 'lib', 'insights-store.js'));
const Evolve = require(path.join(APP, 'plugins', 'community', 'memory-evolve', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}

function makePlugin(dir) {
    const p = Object.create(Evolve.prototype);
    p._insightsDir = dir;
    p._episodeIdleMs = 0;
    p._reflectPending = true;
    p._reflectCap = 5;
    p._reflectMaxEntries = 30;
    p._reflectBusy = false;
    p._reflectCapWarnedDay = '';
    p._reflectCasConflicts = 0;
    p._reflectState = {};
    p.context = { log: () => {} };
    return p;
}
function writeEpisodes(dir, cards) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(insightsStore.episodesPath(dir), cards.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
}

(async () => {
    globalThis.__lastUserInputAt = 0;
    try { delete globalThis.__worldSenseState; } catch (e) { /* ignore */ }
    tombstones.reload();
    try {

    console.log('[1] 全部命中墓碑：不调 LLM、游标前进');
    {
        const dir = path.join(tmpRoot, 'case-all');
        writeEpisodes(dir, [
            // facts 也要含完整墓碑短语：≥6 字墓碑对「包含」生效，短改写（猫叫布丁）按设计只做精确匹配
            { at: 1000, title: '猫', summary: '我家猫叫布丁，是只橘猫', facts: ['我家猫叫布丁', '确认我家猫叫布丁很能吃'] },
        ]);
        const added = tombstones.add(['我家猫叫布丁'], { source: 'test' });
        ok('墓碑已写入', added >= 1, 'added=' + added);

        let llmCalls = 0;
        const p = makePlugin(dir);
        p.context.callLLM = () => { llmCalls += 1; return Promise.resolve('{}'); };
        const r = await p._maybeReflectInner();

        ok('返回 ok 且没有产出 insight', r && r.ok === true && Array.isArray(r.insights) && r.insights.length === 0, JSON.stringify(r && { ok: r.ok, n: r.insights && r.insights.length }));
        ok('没有调用 LLM（全是已忘内容，不该花钱）', llmCalls === 0, 'calls=' + llmCalls);
        ok('墓碑剔除计数 > 0', r && Number(r.tombstoned) >= 1, String(r && r.tombstoned));
        ok('insights.jsonl 没被写入', !fs.existsSync(insightsStore.insightsPath(dir)) || fs.readFileSync(insightsStore.insightsPath(dir), 'utf8').trim() === '', '');
        const cur = insightsStore.loadCursor(dir);
        ok('游标已前进（下个空闲节拍不会重读已忘片段）', Number(cur.lastEpisodeLine) === 1, 'lastEpisodeLine=' + cur.lastEpisodeLine);
    }

    console.log('[2] 混合批次：prompt 里没有已忘内容，正常内容仍在');
    {
        const dir = path.join(tmpRoot, 'case-mixed');
        writeEpisodes(dir, [
            { at: 2000, title: '猫', summary: '我家猫叫布丁，是只橘猫' },
            { at: 2001, title: '做饭', summary: '他最近在学做菜，第一次炒糊了' },
        ]);
        let prompt = '';
        let llmCalls = 0;
        const p = makePlugin(dir);
        p.context.callLLM = (pr) => { llmCalls += 1; prompt = String(pr || ''); return Promise.resolve('{}'); };
        await p._maybeReflectInner();

        ok('调过 LLM（还有正常片段）', llmCalls === 1, 'calls=' + llmCalls);
        ok('prompt 不含已忘内容（布丁）', !prompt.includes('布丁'), prompt.includes('布丁') ? 'still contains' : '');
        ok('prompt 含正常内容（做菜）', prompt.includes('做菜'), '');
    }

    console.log('[3] 接线：写入侧还有一道过滤');
    {
        const src = fs.readFileSync(path.join(APP, 'plugins', 'community', 'memory-evolve', 'index.js'), 'utf8');
        ok('反思入口按墓碑过滤 entries', /_isForgotten\(e && e\.text\)/.test(src), '');
        ok('产出 insights 落盘前按墓碑过滤', /freshInsights/.test(src) && /(appendInsights|mergeOrAppendInsights)\(this\._insightsDir, freshInsights/.test(src), '');
        ok('existingInsights 也过滤', /loadRecentInsights[\s\S]{0,160}_isForgotten/.test(src), '');
    }
} finally {
    try { iso.cleanup(tmpRoot); } catch (e) { /* ignore */ }
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + ((e && e.stack) || e));
    try { iso.cleanup(tmpRoot); } catch (e2) { /* ignore */ }
    process.exit(1);
});
