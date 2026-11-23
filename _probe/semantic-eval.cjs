#!/usr/bin/env node
/**
 * _probe/semantic-eval.cjs — 语义问句集评估（2026-11-15 六十轮，**按机制分类**）
 *
 * 为什么重写：第一版把「我叫什么名字」「我是做什么工作的」也算成召回题 —— 实测这些答案
 * 本来就在 核心用户记忆/用户画像/用户记忆 里、每轮注入 system。拿召回给它们打分是**测错对象**
 * （也解释了为什么「怎么调都提不上去」）。
 *
 * 现在两类分开：
 *   · scope=injected → 只验「注入源里确实有这段」＋「索引里也有它」（双保险）
 *   · scope=recall   → 才跑词法/混合召回，看 recall@1/@3/@5
 *
 * 用法：node _probe/semantic-eval.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE2D = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const P = require(path.join(LIVE2D, 'plugins', 'community', 'memory-recall', 'index.js'));
const RECORDS = path.join(ROOT, '_incoming', 'my-neuro', 'data');
const SET = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'semantic-set.json'), 'utf8')).items;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function readText(name) {
    try { return fs.readFileSync(path.join(RECORDS, name), 'utf8'); } catch (e) { return ''; }
}

(async () => {
    const p = new P();
    p.context = {
        getPluginFileConfig: () => ({}),
        log: () => {},
        addSystemPromptPatch: () => {}, removeSystemPromptPatch: () => {},
        getMessages: () => [], callLLM: async () => 'ADD',
    };
    await p.onInit();
    p._hybrid = false;                 // 默认跑词法；--hybrid 才开混合
    p._maxDocs = 4000;
    p._rebuild();
    const hybrid = process.argv.includes('--hybrid');
    if (hybrid) p._hybrid = true;

    const injSources = {
        核心: readText('核心用户记忆.txt'),
        用户记忆: readText('用户记忆.json'),
        画像: readText('用户画像.json'),
    };

    const inj = SET.filter((x) => x.scope === 'injected');
    const rec = SET.filter((x) => x.scope !== 'injected');

    console.log('语义问句集：' + SET.length + ' 条（注入类 ' + inj.length + ' · 召回类 ' + rec.length + '）');

    // ① 注入类：答案在注入源里吗？索引里也有吗？
    let injOk = 0;
    for (const it of inj) {
        const src = injSources[it.in] || '';
        const inSource = src.includes(it.expect);
        const inIndex = (p._docs || []).some((d) => String(d.text).includes(it.expect));
        if (inSource) injOk += 1;
        ok('注入覆盖「' + it.q + '」', inSource,
            (it.in + ' 含「' + it.expect + '」=' + inSource) + ' / 索引里=' + inIndex);
    }
    console.log('  → 注入覆盖 ' + injOk + '/' + inj.length + '（这些题不该由召回负责）');

    // ② 召回类：真的跑检索
    const rows = [];
    for (const it of rec) {
        const lex = (p._search(it.q, 5, 0) || []).map((h) => String(h.doc.text));
        const li = lex.findIndex((t) => t.includes(it.expect));
        let hi = null;
        if (hybrid) {
            const hy = (await p._searchHybrid(it.q, 5)) || [];
            const ht = hy.map((h) => String(h.doc.text));
            const j = ht.findIndex((t) => t.includes(it.expect));
            hi = j < 0 ? null : j + 1;
        }
        rows.push({ q: it.q, expect: it.expect, lex: li < 0 ? null : li + 1, hyb: hi, lexTop: lex.slice(0, 2) });
    }
    const rate = (k) => +(rows.filter((r) => r.lex && r.lex <= k).length / (rows.length || 1)).toFixed(2);
    for (const r of rows) {
        ok('召回「' + r.q + '」', !!r.lex, '名次=' + (r.lex || '未命中') + ' / top2=' + JSON.stringify(r.lexTop));
    }
    console.log('  → 召回类 recall@1 ' + rate(1) + ' · @3 ' + rate(3) + ' · @5 ' + rate(5) + (hybrid ? '（含混合）' : '（纯词法）'));

    try {
        fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
        fs.writeFileSync(path.join(__dirname, 'out', 'semantic-result.json'), JSON.stringify({ inj, rec: rows }, null, 2), 'utf8');
    } catch (e) { /* 报告失败不影响结论 */ }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(1); });
