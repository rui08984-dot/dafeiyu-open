#!/usr/bin/env node
/**
 * _probe/test-vector-cache-lru.cjs —— 向量缓存上限 / LRU / 原子写 / 增量索引（2026-11-25 P1）
 *
 * 现场（审计 记忆链 P1）：
 *   · 记忆向量.json 6.6MB / 1211 条，saveCache 只 merge → 只增不减；
 *   · _rebuild 每 90 秒把 1500+ 条全文重新分词（396ms），即使内容没变；
 *   · 记忆强化.json 666 keys 无上限、无 TTL。
 *
 * 本测试全部离线：临时目录 + 注入 embed 函数（不碰 8090，不碰真实记录室）。
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const TMP = iso.setUpTempDataRoot('pet-vector-lru-');
const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const hv = require(path.join(LIVE, 'js', 'core', 'hybrid-vectors.js'));
const Recall = require(path.join(LIVE, 'plugins', 'community', 'memory-recall', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function tmpFile(name) {
    const dir = fs.mkdtempSync(path.join(TMP, 'case-'));
    return { dir, file: path.join(dir, name || '记忆向量.json') };
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function leftoverTmp(dir) {
    return fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
}

function baseEntries(n, stamp) {
    const items = {};
    const meta = {};
    for (let i = 0; i < n; i += 1) {
        const k = 'k' + i;
        items[k] = 'A'.repeat(20);
        meta[k] = [stamp + i, 1];
    }
    return { model: hv.EMBED_MODEL, items, meta };
}

(async () => {
    // ── ① 原子写 + 无变化跳过 + 合并 ──────────────────────────────────────
    {
        const { dir, file } = tmpFile();
        const cache = baseEntries(3, 1000);
        const r1 = hv.saveCache(file, cache);
        ok('首次写入 ok 且未跳过', r1.ok === true && r1.skipped === false, JSON.stringify(r1));
        ok('写后无 .tmp 残留', leftoverTmp(dir).length === 0, leftoverTmp(dir).join(','));
        const saved = readJson(file);
        ok('文件结构含 model/items/meta', saved.model === hv.EMBED_MODEL
            && Object.keys(saved.items).length === 3 && Object.keys(saved.meta).length === 3);
        ok('原子写后 JSON 可完整解析', saved.items.k0 === 'A'.repeat(20));

        const r2 = hv.saveCache(file, cache);
        ok('无变化时跳过写盘', r2.ok === true && r2.skipped === true, JSON.stringify(r2));

        const add = { model: hv.EMBED_MODEL, items: { extra: 'B'.repeat(20) }, meta: { extra: [5000, 1] } };
        const r3 = hv.saveCache(file, add);
        const merged = readJson(file);
        ok('merge 不冲掉并发实例已写入的条目', Object.keys(merged.items).length === 4 && merged.items.extra,
            Object.keys(merged.items).join(','));
        ok('写入后 meta 合并保留', Object.keys(merged.meta).length === 4);
        ok('有新增条目时不跳过', r3.skipped === false);
    }

    // ── ② 条目上限：按 (lastUsedAt, hits) 淘汰最旧 ────────────────────────
    {
        const { file } = tmpFile();
        const stamp = 1000000;
        const cache = baseEntries(6, stamp);
        // k0 最旧 … k5 最新；把 k1 的 hits 抬高，让「同 lastUsedAt」时按 hits 留存
        cache.meta.k0 = [stamp, 9];
        const r = hv.saveCache(file, cache, { maxItems: 3 });
        const saved = readJson(file);
        const kept = Object.keys(saved.items).sort();
        ok('超过 maxItems 触发淘汰', r.evicted === 3, 'evicted=' + r.evicted);
        ok('保留 lastUsedAt 最大的 3 条', kept.join(',') === 'k3,k4,k5', kept.join(','));
        ok('最旧条目被淘汰', !saved.items.k0 && !saved.items.k1 && !saved.items.k2);
        ok('被淘汰条目的 meta 一并删除', Object.keys(saved.meta).sort().join(',') === 'k3,k4,k5',
            Object.keys(saved.meta).sort().join(','));
        ok('剩余条数 ≤ maxItems', kept.length <= 3, String(kept.length));

        // 同 lastUsedAt：hits 高者留
        const { file: f2 } = tmpFile();
        const c2 = {
            model: hv.EMBED_MODEL,
            items: { low: 'x', high: 'x', mid: 'x' },
            meta: { low: [777, 0], high: [777, 9], mid: [777, 3] },
        };
        hv.saveCache(f2, c2, { maxItems: 2 });
        const s2 = readJson(f2);
        ok('同 lastUsedAt 按 hits 保留高频条目', s2.items.high && s2.items.mid && !s2.items.low,
            Object.keys(s2.items).join(','));
    }

    // ── ③ keepKeys：当前文档集最后才淘汰（避免刚嵌好就被踢）────────────────
    {
        const { file } = tmpFile();
        const cache = baseEntries(5, 2000);
        hv.saveCache(file, cache, { maxItems: 2, keepKeys: ['k0', 'k1'] });
        const saved = readJson(file);
        ok('keepKeys 里的旧条目优先保留', saved.items.k0 && saved.items.k1, Object.keys(saved.items).join(','));
        ok('非 keepKeys 的较新条目被淘汰', !saved.items.k2 && !saved.items.k3 && !saved.items.k4);
    }

    // ── ④ 体积上限：超过 maxBytes 也会淘汰 ────────────────────────────────
    {
        const { file } = tmpFile();
        const cache = { model: hv.EMBED_MODEL, items: {}, meta: {} };
        for (let i = 0; i < 20; i += 1) {
            cache.items['b' + i] = 'X'.repeat(500);
            cache.meta['b' + i] = [3000 + i, 1];
        }
        const r = hv.saveCache(file, cache, { maxBytes: 4000 });
        const saved = readJson(file);
        ok('超过 maxBytes 触发淘汰', r.evicted > 0, 'evicted=' + r.evicted);
        ok('淘汰后条目数显著下降', Object.keys(saved.items).length < 20, String(Object.keys(saved.items).length));
        ok('淘汰后文件体积接近上限（< 6000B）', fs.statSync(file).size < 6000, fs.statSync(file).size + 'B');
        ok('最新条目保留（b19 最后写）', Boolean(saved.items.b19));
    }

    // ── ⑤ usage 记录（lastUsedAt/hits）与 flush ──────────────────────────
    {
        const { file } = tmpFile();
        const embed = async (texts) => texts.map(() => [0.1, 0.2, 0.3]);
        const docs = [{ text: 'a' }, { text: 'b' }];
        const built = await hv.ensureVectors(docs, { cacheFile: file, embed });
        const keys = docs.map((d) => hv.hashText(d.text));
        ok('首次构建嵌入了全部文档', built.embedded === 2, JSON.stringify({ e: built.embedded, r: built.reused }));
        ok('构建结果带 keys/cache（供 usage 记录）', Array.isArray(built.keys) && built.keys.length === 2 && Boolean(built.cache));
        const marked = hv.noteHits(built, [0, 0, 1]);
        ok('noteHits 返回更新条数', marked === 3, String(marked));
        ok('hits 累加正确（a 命中 2 次）', built.cache.meta[keys[0]][1] === 2, JSON.stringify(built.cache.meta[keys[0]]));
        ok('lastUsedAt 是毫秒时间戳', built.cache.meta[keys[0]][0] > 1e12);
        const flushed = hv.flushUsage(file, built.cache);
        ok('flushUsage 落盘成功', flushed.ok && flushed.skipped === false, JSON.stringify(flushed));
        const saved = readJson(file);
        ok('usage 持久化到 meta', saved.meta[keys[0]][1] === 2 && saved.meta[keys[1]][1] === 1);
        const again = hv.flushUsage(file, built.cache);
        ok('无新 usage 时 flush 跳过写盘', again.skipped === true, JSON.stringify(again));
    }

    // ── ⑥ 增量索引：只嵌新增/变更文档（按内容 hash）─────────────────────────
    {
        const { file } = tmpFile();
        let calls = 0;
        const embeddedTexts = [];
        const embed = async (texts) => {
            calls += 1;
            embeddedTexts.push(...texts);
            return texts.map(() => [1, 0, 0]);
        };
        const docs1 = [{ text: 'a' }, { text: 'b' }];
        const b1 = await hv.ensureVectors(docs1, { cacheFile: file, embed });
        ok('首次：嵌入 2 条、调用 1 次', b1.embedded === 2 && calls === 1, JSON.stringify({ e: b1.embedded, calls }));
        const b2 = await hv.ensureVectors(docs1, { cacheFile: file, embed });
        ok('第二次：全部复用、不再调嵌入', b2.embedded === 0 && b2.reused === 2 && calls === 1,
            JSON.stringify({ e: b2.embedded, r: b2.reused, calls }));
        const docs2 = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
        const b3 = await hv.ensureVectors(docs2, { cacheFile: file, embed });
        ok('新增 1 条只嵌 1 条', b3.embedded === 1 && calls === 2, JSON.stringify({ e: b3.embedded, calls }));
        ok('只把新增内容送给嵌入', embeddedTexts[embeddedTexts.length - 1] === 'c', JSON.stringify(embeddedTexts));
        ok('增量构建标记 incremental=true', b3.incremental === true);
        const docs3 = [{ text: 'a' }, { text: 'B（改过）' }, { text: 'c' }];
        const b4 = await hv.ensureVectors(docs3, { cacheFile: file, embed });
        ok('内容变更按 hash 重新嵌（1 条）', b4.embedded === 1 && calls === 3, JSON.stringify({ e: b4.embedded, calls }));
    }

    // ── ⑦ memory-recall：版本未变直接 return / stats ───────────────────────
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'recall-'));
        fs.writeFileSync(path.join(dir, '对话历史.jsonl'), '', 'utf8');
        const p = new Recall();
        const logs = [];
        p.context = {
            getPluginFileConfig: () => ({ hybrid_enabled: false }),
            log: (lv, m) => logs.push(lv + ':' + String(m)),
            addSystemPromptPatch: () => {}, removeSystemPromptPatch: () => {},
            getMessages: () => [], callLLM: async () => 'ADD', on: () => {}, off: () => {},
        };
        await p.onInit();
        p._recordsDir = dir;
        iso.assertIsolated(p._recordsDir);
        p._hybrid = false;
        p._docs = [{ text: 'a', src: '对话', role: 'user', t: 1 }];
        p._docsVersion = 'v1';
        const realEnsure = hv.ensureVectors;
        let ensureCalls = 0;
        hv.ensureVectors = async (docs, opts) => {
            ensureCalls += 1;
            return {
                vectors: docs.map(() => new Float32Array([1, 0])), dim: 2,
                embedded: 0, reused: docs.length, keys: docs.map((d) => hv.hashText(d.text)),
                cache: { model: hv.EMBED_MODEL, items: {}, meta: {} }, evicted: 1, incremental: true,
            };
        };
        try {
            p._hybrid = true;
            await p._ensureVecIndex();
            ok('向量索引首次构建调用 ensureVectors', ensureCalls === 1, String(ensureCalls));
            ok('构建结果绑定文档版本', p._vec.version === 'v1', String(p._vec.version));
            await p._ensureVecIndex();
            ok('版本未变时不重复构建', ensureCalls === 1, String(ensureCalls));
            p._docsVersion = 'v2';
            await p._ensureVecIndex();
            ok('版本变化后重新构建', ensureCalls === 2, String(ensureCalls));
        } finally {
            hv.ensureVectors = realEnsure;
        }
        const st = p.stats();
        const shape = ['docs', 'vectors', 'hits', 'evicted', 'lastRebuildMs', 'incremental'];
        ok('stats() 字段齐全', shape.every((k) => k in st), JSON.stringify(st));
        ok('stats.hits 记录缓存复用条数', st.hits >= 1, String(st.hits));
        ok('stats.evicted 记录淘汰条数', st.evicted >= 1, String(st.evicted));
        ok('inspect() 是 stats() 的别名', JSON.stringify(p.inspect()) === JSON.stringify(st));
        ok('debugState 暴露 vectorCache', Boolean(p.debugState().vectorCache && 'docs' in p.debugState().vectorCache));
    }

    // ── ⑧ 增量 rebuild：内容没变不重装索引 ─────────────────────────────────
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'rebuild-'));
        fs.writeFileSync(path.join(dir, '对话历史.jsonl'),
            JSON.stringify({ role: 'user', content: '今天去看了电影' }) + '\n'
            + JSON.stringify({ role: 'assistant', content: '好看吗' }) + '\n', 'utf8');
        const p = new Recall();
        p.context = {
            getPluginFileConfig: () => ({ hybrid_enabled: false }),
            log: () => {}, addSystemPromptPatch: () => {}, removeSystemPromptPatch: () => {},
            getMessages: () => [], callLLM: async () => 'ADD', on: () => {}, off: () => {},
        };
        await p.onInit();
        p._recordsDir = dir;
        p._hybrid = false;
        p._rebuild({ dir });
        const firstDocs = p._docs;
        const firstVersion = p._docsVersion;
        const firstBuiltAt = p._builtAt;
        ok('首次 rebuild 建立索引版本', typeof firstVersion === 'string' && firstVersion.length === 32, firstVersion);
        ok('首次 rebuild 耗时已记录', p._lastRebuildMs >= 0, String(p._lastRebuildMs));
        await new Promise((r) => setTimeout(r, 5));
        p._rebuild({ dir });
        ok('内容未变：直接 return，不重装索引', p._docs === firstDocs && p._builtAt === firstBuiltAt);
        ok('内容未变：版本指纹不变', p._docsVersion === firstVersion);
        fs.appendFileSync(path.join(dir, '对话历史.jsonl'),
            JSON.stringify({ role: 'user', content: '顺便吃了火锅' }) + '\n', 'utf8');
        p._rebuild({ dir });
        ok('新增一行后重建（索引对象换了）', p._docs !== firstDocs && p._docs.length === firstDocs.length + 1,
            p._docs.length + ' → ' + firstDocs.length);
        ok('新增后版本指纹变化', p._docsVersion !== firstVersion);
    }

    // ── ⑨ 索引去重：记忆库 ↔ 对话历史（归一化文本相同才跳）─────────────────
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'dedup-'));
        const same = '我今天下班去吃了碗牛肉面';
        fs.writeFileSync(path.join(dir, '对话历史.jsonl'),
            JSON.stringify({ role: 'user', content: same }) + '\n'
            + JSON.stringify({ role: 'assistant', content: '好吃吗？' }) + '\n', 'utf8');
        // 记忆库：同一条（带说话人前缀 + 标点差异）；另一条不同的
        fs.writeFileSync(path.join(dir, '记忆库.txt'),
            '【用户】: ' + same + '。\n【用户】: 周末想去爬山\n', 'utf8');
        const p = new Recall();
        const logs = [];
        p.context = {
            getPluginFileConfig: () => ({ hybrid_enabled: false }),
            log: (lv, m) => logs.push(String(m)),
            addSystemPromptPatch: () => {}, removeSystemPromptPatch: () => {},
            getMessages: () => [], callLLM: async () => 'ADD', on: () => {}, off: () => {},
        };
        await p.onInit();
        p._recordsDir = dir;
        p._hybrid = false;
        p._rebuild({ dir });
        const lib = p._docs.filter((d) => d.src === '记忆库');
        ok('与对话历史重复的 记忆库 条目被跳过', lib.every((d) => d.text !== same), lib.map((d) => d.text).join('|'));
        ok('归一化覆盖标点差异（同一句被跳）', !lib.some((d) => d.text.includes('牛肉面')));
        ok('不同内容的 记忆库 条目保留', lib.some((d) => d.text.includes('爬山')), lib.map((d) => d.text).join('|'));
        ok('去重计数写入 _dedupDropped', p._dedupDropped === 1, String(p._dedupDropped));
        ok('日志有一行「跳过重复 N 条」', logs.some((m) => /跳过与对话历史重复/.test(m) && /1 条/.test(m)),
            logs.filter((m) => /去重/.test(m)).join(' | '));
        ok('debugState 暴露 dedupDropped', p.debugState().dedupDropped === 1);
    }

    // ── ⑩ 记忆强化表：2000 key 上限 + 90 天 TTL + 原子写 ───────────────────
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'reinforce-'));
        const p = new Recall();
        const logs = [];
        p.context = {
            getPluginFileConfig: () => ({ hybrid_enabled: false }),
            log: (lv, m) => logs.push(String(m)),
            addSystemPromptPatch: () => {}, removeSystemPromptPatch: () => {},
            getMessages: () => [], callLLM: async () => 'ADD', on: () => {}, off: () => {},
        };
        await p.onInit();
        p._recordsDir = dir;
        iso.assertIsolated(path.join(dir, '记忆强化.json'));
        const now = Date.now();
        p._reinforce = {};
        for (let i = 0; i < 2005; i += 1) {
            p._reinforce['k' + i] = { c: 1, lastAt: now - (2005 - i) * 1000 };
        }
        // 污染计数 + 过期条目
        p._reinforce.k2004.c = 58;
        p._reinforce['expired'] = { c: 2, lastAt: now - 91 * 86400000 };
        p._saveReinforce();
        const saved = readJson(path.join(dir, '记忆强化.json'));
        const keys = Object.keys(saved);
        ok('强化表 key 上限 2000', keys.length === 2000, String(keys.length));
        ok('最旧 key 被淘汰', !keys.includes('k0') && !keys.includes('k4'), keys.slice(0, 3).join(','));
        ok('最新 key 保留', keys.includes('k2004'));
        ok('90 天 TTL 删掉过期条目', !keys.includes('expired'));
        ok('计数夹到 REINFORCE_CAP=5', saved.k2004.c === 5, JSON.stringify(saved.k2004));
        ok('新格式为 {c,lastAt}', keys.every((k) => saved[k] && typeof saved[k] === 'object' && 'c' in saved[k] && 'lastAt' in saved[k]));
        ok('原子写：无 .tmp 残留且 JSON 可解析', leftoverTmp(dir).length === 0 && keys.length > 0);
        ok('收敛日志有一行', logs.some((m) => /强化表收敛/.test(m)), logs.filter((m) => /强化/.test(m)).join(' | '));

        // 旧格式（纯数字）兼容
        const dir2 = fs.mkdtempSync(path.join(TMP, 'reinforce-old-'));
        fs.writeFileSync(path.join(dir2, '记忆强化.json'), JSON.stringify({ 'old|key': 3 }), 'utf8');
        const p2 = new Recall();
        p2.context = { getPluginFileConfig: () => ({}), log: () => {}, addSystemPromptPatch: () => {}, removeSystemPromptPatch: () => {}, getMessages: () => [], callLLM: async () => '', on: () => {}, off: () => {} };
        await p2.onInit();
        p2._recordsDir = dir2;
        p2._reinforce = null;
        p2._loadReinforce();
        ok('旧格式纯数字可读（计数=3）', p2._reinforceCount('old|key') === 3, String(p2._reinforceCount('old|key')));
        ok('旧格式载入时补 lastAt', p2._reinforce['old|key'].lastAt > 0);
    }

    // ── ⑪ P1-3：淘汰墓碑（flushUsage 不复活 / 重新 embed 允许回来 / 上限持续生效）──
    {
        const mk = (n) => {
            const items = {};
            const meta = {};
            for (let i = 0; i < n; i += 1) {
                items['v' + i] = 'X'.repeat(120);
                meta['v' + i] = [4000 + i, 1];
            }
            return { model: hv.EMBED_MODEL, items, meta };
        };
        const { file } = tmpFile();
        const mem = mk(10);
        const staleCopy = mk(10);                      // 另一个实例手里淘汰前的全量内存副本
        const r1 = hv.saveCache(file, mem, { maxItems: 5 });
        const n1 = Object.keys(readJson(file).items).length;
        ok('小上限触发淘汰（10 → 5）', r1.evicted === 5 && n1 === 5, JSON.stringify({ ev: r1.evicted, n: n1 }));

        const r2 = hv.flushUsage(file, staleCopy, { maxItems: 5 });
        const saved2 = readJson(file);
        ok('flushUsage 不把已淘汰条目复活', Object.keys(saved2.items).length === 5,
            Object.keys(saved2.items).join(','));
        ok('被淘汰的 key 没有写回磁盘', !saved2.items.v0 && !saved2.items.v1 && !saved2.items.v4,
            Object.keys(saved2.items).join(','));
        ok('淘汰后同进程的内存副本也被清掉（cache.items 不再全量）',
            !mem.items.v0 && !mem.items.v1 && !mem.items.v4, Object.keys(mem.items).join(','));
        ok('usage flush 不因此报错', r2.ok === true, JSON.stringify(r2));

        // 体积上限：反复 flush 后仍守住上限（审计原症状 = 淘汰→复活→再淘汰的抖动）
        const { file: f4 } = tmpFile();
        const big = { model: hv.EMBED_MODEL, items: {}, meta: {} };
        for (let i = 0; i < 40; i += 1) {
            big.items['w' + i] = 'Y'.repeat(300);
            big.meta['w' + i] = [5000 + i, 1];
        }
        const fullCopy = { model: hv.EMBED_MODEL, items: { ...big.items }, meta: { ...big.meta } };
        hv.saveCache(f4, big, { maxBytes: 4000 });
        const nA = Object.keys(readJson(f4).items).length;
        const sizes = [];
        for (let round = 0; round < 3; round += 1) {
            fullCopy.dirty = true;
            hv.flushUsage(f4, fullCopy, { maxBytes: 4000 });
            sizes.push(fs.statSync(f4).size);
        }
        ok('8MB 式体积上限持续生效（反复 flush 不反弹）',
            Math.max(...sizes) < 6000 && Object.keys(readJson(f4).items).length === nA,
            'sizes=' + sizes.join(',') + ' items=' + nA);
        ok('墓碑集合有上限（不无限增长）',
            typeof hv._evictedCount === 'function' && hv._evictedCount() <= hv.EVICTED_KEYS_MAX,
            'evictedKeys=' + (hv._evictedCount && hv._evictedCount()));

        // 条目再次被真正 embed → 允许回来
        const { file: f5 } = tmpFile();
        const embed = async (texts) => texts.map(() => [0.5, 0.5]);
        const docs = [{ text: 'x1' }, { text: 'x2' }, { text: 'x3' }];
        const b1 = await hv.ensureVectors(docs, { cacheFile: f5, embed });
        const r3 = hv.saveCache(f5, b1.cache, { maxItems: 2 });
        const onDisk = readJson(f5).items;
        const goneKey = docs.map((d) => hv.hashText(d.text)).find((k) => !onDisk[k]);
        ok('ensureVectors 收口后仍可被淘汰（1 条）', r3.evicted === 1 && !!goneKey, JSON.stringify({ ev: r3.evicted }));
        const b2 = await hv.ensureVectors(docs, { cacheFile: f5, embed });
        ok('重新 embed 后已淘汰条目回到磁盘', !!readJson(f5).items[goneKey],
            Object.keys(readJson(f5).items).length + ' 条');
        ok('重新 embed 只嵌那一条', b2.embedded === 1, 'embedded=' + b2.embedded);
    }

    iso.cleanup(TMP);
    console.log(`\nPASS ${pass} / FAIL ${fail}`);
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('测试异常：' + (e && e.stack || e));
    try { iso.cleanup(TMP); } catch (e2) { /* ignore */ }
    process.exit(1);
});
