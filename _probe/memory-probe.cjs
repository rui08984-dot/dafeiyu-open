#!/usr/bin/env node
/**
 * _probe/memory-probe.cjs — 记忆召回探针（2026-11-15 五十九轮）
 *
 * 为什么建它：调研结论里最扎心的一句是「你们没有回归集，改动全靠手感」。
 * 这个探针从我**自己的真实记录**里自动出题（不造数据），给 recall@1/@3/@5 和延迟基线，
 * 以后每次动召回都能拿它对比 —— 而不是「感觉好像准了一点」。
 *
 * 出题方式（每题都带 ground truth = 源文档）：
 *   · 从 用户记忆.json / 核心用户记忆.txt 取整句 → 用句中**最具区分度的二字词**当查询
 *   · 从 对话历史.jsonl / 记忆库.txt 抽样 → 同上（跳过噪音行）
 *   · 只保留「该词确实出现在源文档里」的题，保证题目可答
 *
 * 用法：
 *   node _probe/memory-probe.cjs            # 跑并把报告写到 _probe/out/
 *   node _probe/memory-probe.cjs --n 80     # 出多少题（默认 60）
 *   node _probe/memory-probe.cjs --json     # 只打印 JSON（给脚本吃）
 *
 * 判定：退出码恒 0（它是测量工具，不是门禁）；报告里带 pass/fail 阈值供人看。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'memory-recall', 'index.js'));
const UF = (() => { try { return require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'user-facts.js')); } catch (e) { return null; } })();

const argN = (() => {
    const i = process.argv.indexOf('--n');
    const v = i >= 0 ? Number(process.argv[i + 1]) : 0;
    return v > 0 ? Math.min(300, v) : 60;
})();
const JSON_ONLY = process.argv.includes('--json');
const PARAPHRASE = process.argv.includes('--paraphrase');
const HYBRID = process.argv.includes('--hybrid');

// ── 改写问法（可选，--paraphrase）────────────────────────────────────────
// 为什么需要：从文档里抽词再找回原文档 = 自匹配，词法召回天然赢，量不出「换个说法还找得到吗」。
// 用她自己那个模型把一句记忆改写成「用户会怎么问」，才是真实场景。
const CACHE_FILE = path.join(__dirname, 'out', 'paraphrase-cache.json');
function loadCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveCache(c) {
    try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), 'utf8'); } catch (e) { /* 缓存失败不影响跑分 */ }
}
function llmCfg() {
    const root = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
    try {
        const prov = JSON.parse(fs.readFileSync(path.join(root, 'llm_providers.json'), 'utf8'));
        const p = (prov.providers || []).find((x) => x.enabled !== false) || (prov.providers || [])[0];
        const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
        const model = (cfg.llm && cfg.llm.model_id) || ((p.models || [])[0] || {}).model_id;
        if (!p || !p.api_key || !p.api_url || !model) return null;
        return { url: String(p.api_url).replace(/\/$/, '') + '/chat/completions', key: p.api_key, model };
    } catch (e) { return null; }
}
function httpJson(url, headers, body, timeoutMs) {
    return new Promise((resolve) => {
        const u = new URL(url);
        const data = Buffer.from(JSON.stringify(body), 'utf8');
        const req = require('http').request({
            host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST', timeout: timeoutMs,
            headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': data.length }, headers),
        }, (res) => {
            let s = '';
            res.on('data', (c) => { s += c; });
            res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(data);
        req.end();
    });
}
async function paraphraseOne(cfg, docText, keyword) {
    const prompt = '把下面这句「我记得的事」改写成**用户会自然问出口的一句话**（不超过 18 字，口语，不要引号，不要「你还记得吗」这种套话，只输出那句话）：\n' + String(docText).slice(0, 120);
    const r = await httpJson(cfg.url, { Authorization: 'Bearer ' + cfg.key, 'User-Agent': 'node', 'Accept-Encoding': 'gzip, deflate' },
        { model: cfg.model, messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 40, stream: false }, 25000);
    const txt = r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
    const clean = String(txt || '').replace(/["'“”‘’\n]/g, '').trim();
    return clean || keyword;
}

// 停用词：出题时不能拿这些当查询
const STOP = new Set('的 了 是 我 你 他 她 在 和 就 都 也 还 有 不 这 那 个 一 啊 吧 呢 吗 把 被 给 让 着 得 地 会 要 能 很 太 好 嗯 哦 呀 嘛 什么 怎么 可以 然后 但是 因为 所以 现在 时候 这样 那样 我们 你们 他们'.split(' '));

function bigramFreq(text) {
    const t = String(text || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
    const m = new Map();
    for (let i = 0; i + 2 <= t.length; i += 1) {
        const g = t.slice(i, i + 2);
        if (STOP.has(g[0]) && STOP.has(g[1])) continue;
        m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
}

/** 从一句话里挑一个「在全集里罕见」的二字词当查询 */
function pickQuery(text, dfMap) {
    const freq = bigramFreq(text);
    let best = null;
    let bestScore = -1;
    for (const [g, tf] of freq) {
        if (STOP.has(g)) continue;
        if (!/[\u4e00-\u9fa5]{2}/.test(g)) continue;    // 只取纯汉字二字词
        const df = dfMap.get(g) || 1;
        // 越罕见、在句子里出现越多，越适合当查询
        const score = tf * (1 / Math.log(1 + df));
        if (score > bestScore) { bestScore = score; best = g; }
    }
    return best;
}

(async () => {
    const p = new P();
    p.context = {
        getPluginFileConfig: () => ({}),
        log: () => {},
        addSystemPromptPatch: () => {},
        removeSystemPromptPatch: () => {},
        getMessages: () => [],
        callLLM: async () => 'ADD',
    };
    await p.onInit();
    p._maxDocs = 4000;
    const t0 = Date.now();
    p._rebuild();
    const buildMs = Date.now() - t0;
    const docs = p._docs || [];

    // 全集 df（给「挑罕见词」用）
    const dfMap = new Map();
    for (const d of docs) {
        const seen = new Set();
        for (const g of bigramFreq(d.text).keys()) {
            if (seen.has(g)) continue;
            seen.add(g);
            dfMap.set(g, (dfMap.get(g) || 0) + 1);
        }
    }

    // 抽样：按来源均匀，避免全被最长的「对话」占满
    const bySrc = new Map();
    for (const d of docs) {
        if (String(d.text || '').trim().length < 6) continue;
        if (!bySrc.has(d.src)) bySrc.set(d.src, []);
        bySrc.get(d.src).push(d);
    }
    const srcOrder = ['用户记忆', '核心', '事实', '记忆库', '日记', '对话'].filter((s) => bySrc.has(s));
    const questions = [];
    let guard = 0;
    while (questions.length < argN && guard < argN * 40) {
        guard += 1;
        for (const src of srcOrder) {
            if (questions.length >= argN) break;
            const arr = bySrc.get(src);
            if (!arr || !arr.length) continue;
            const d = arr[Math.floor(Math.random() * arr.length)];
            if (!d || questions.some((q) => q.docText === d.text)) continue;
            const q = pickQuery(d.text, dfMap);
            if (!q) continue;
            // 题目必须真的出现在源文档里（否则「答对」没有意义）
            if (!String(d.text).includes(q)) continue;
            questions.push({ query: q, src, docText: String(d.text), role: d.role || '' });
        }
    }

    // 可选：生成「改写问法」（并行 4，带缓存）
    if (PARAPHRASE) {
        const cfg = llmCfg();
        if (!cfg) {
            console.error('  ⚠ --paraphrase 需要 llm_providers.json + config.json（读不到，退回只跑原词）');
        } else {
            const cache = loadCache();
            const todo = questions.filter((q) => !cache[q.docText + '|' + q.query]);
            let done = 0;
            const worker = async () => {
                while (todo.length) {
                    const q = todo.pop();
                    const key = q.docText + '|' + q.query;
                    cache[key] = await paraphraseOne(cfg, q.docText, q.query);
                    done += 1;
                    if (!JSON_ONLY && done % 10 === 0) console.error('  改写进度 ' + done + '/' + questions.length);
                    saveCache(cache);
                }
            };
            await Promise.all([worker(), worker(), worker(), worker()]);
            for (const q of questions) q.para = cache[q.docText + '|' + q.query] || q.query;
        }
    }

    // 跑题（同一套索引、同一套打分；两种问法各跑一遍）
    const evaluate = async (getQuery) => {
        const lat = [];
        const results = [];
        for (const item of questions) {
            const query = getQuery(item);
            if (!query) continue;
            const t1 = process.hrtime.bigint();
            // 注意：score 必须是**词法分**（闸是按词法口径校准的）；fused 只用来定顺序，
            // 混进 score 会让闸把所有命中都判成不达标（探针里踩过一次）。
            const hits = HYBRID ? ((await p._searchHybrid(query, 5)) || []).map((h) => ({ doc: h.doc, score: h.score, fused: h.fused })) : (p._search(query, 5, 0) || []);
            const us = Number(process.hrtime.bigint() - t1) / 1000;
            lat.push(us);
            const texts = hits.map((h) => String(h.doc.text));
            const idx = texts.indexOf(item.docText);
            results.push({
                query,
                src: item.src,
                rank: idx >= 0 ? idx + 1 : null,
                top: texts.slice(0, 3).map((t) => t.slice(0, 24)),
                gateHits: (() => { try { return p._gateHits(query, hits, 3).length; } catch (e) { return -1; } })(),
            });
        }
        const n = results.length || 1;
        const rate = (k) => +(results.filter((r) => r.rank && r.rank <= k).length / n).toFixed(3);
        lat.sort((a, b) => a - b);
        const pct = (q) => Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * q))]);
        return {
            questions: results.length,
            recallAt1: rate(1),
            recallAt3: rate(3),
            recallAt5: rate(5),
            miss: results.filter((r) => !r.rank).length,
            gateWouldInject: results.filter((r) => r.gateHits > 0).length,
            p50us: pct(0.5),
            p95us: pct(0.95),
            bySrc: Object.fromEntries(srcOrder.map((s) => {
                const rs = results.filter((r) => r.src === s);
                return [s, { n: rs.length, r3: rs.length ? +(rs.filter((r) => r.rank && r.rank <= 3).length / rs.length).toFixed(3) : null }];
            })),
            results,
        };
    };

    const kw = await evaluate((q) => q.query);
    const para = PARAPHRASE && questions.some((q) => q.para) ? await evaluate((q) => q.para) : null;

    const summary = {
        at: new Date().toISOString(),
        docs: docs.length,
        buildMs,
        keyword: Object.assign({}, kw, { results: undefined }),
        paraphrase: para ? Object.assign({}, para, { results: undefined }) : null,
    };

    if (!JSON_ONLY) {
        const show = (label, s) => {
            if (!s) return;
            console.log('  ' + label + '：recall@1 ' + s.recallAt1 + ' · @3 ' + s.recallAt3 + ' · @5 ' + s.recallAt5
                + ' · 未命中 ' + s.miss + ' · 闸放行 ' + s.gateWouldInject + '/' + s.questions
                + ' · p50 ' + s.p50us + 'µs p95 ' + s.p95us + 'µs');
        };
        console.log('记忆召回探针' + (HYBRID ? '（混合：词法+向量 RRF）' : '（纯词法）'));
        console.log('  索引 ' + summary.docs + ' 条（构建 ' + buildMs + 'ms）· 题数 ' + kw.questions);
        show('原词 ', kw);
        show('改写 ', para);
        console.log('  按来源 recall@3（原词）：' + Object.entries(kw.bySrc).map(([s, v]) => s + ' ' + (v.r3 == null ? '-' : v.r3) + '(' + v.n + ')').join(' · '));
        const bad = kw.results.filter((r) => !r.rank).slice(0, 6);
        if (bad.length) {
            console.log('  原词未命中样例：');
            for (const b of bad) console.log('    「' + b.query + '」 [' + b.src + '] → ' + JSON.stringify(b.top));
        }
        if (para) {
            const bad2 = para.results.filter((r) => !r.rank).slice(0, 6);
            if (bad2.length) {
                console.log('  改写未命中样例：');
                for (const b of bad2) console.log('    「' + b.query + '」 [' + b.src + '] → ' + JSON.stringify(b.top));
            }
        }
    }

    try {
        const dir = path.join(__dirname, 'out');
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, 'memory-probe-' + summary.at.replace(/[:.]/g, '-') + '.json');
        fs.writeFileSync(f, JSON.stringify({ summary, keyword: kw.results, paraphrase: para ? para.results : null }, null, 2), 'utf8');
        if (!JSON_ONLY) console.log('  报告：' + f);
    } catch (e) { console.error('  报告写入失败：' + (e && e.message || e)); }

    if (JSON_ONLY) console.log(JSON.stringify(summary));
    process.exit(0);
})().catch((e) => {
    console.error('探针异常：' + (e && e.stack || e));
    process.exit(1);
});
