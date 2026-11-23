/**
 * hybrid-vectors.js —— 向量侧的记忆检索基础设施（2026-11-15 五十九轮）
 *
 * 为什么要有：词法 bigram 的弱点是「换个说法就找不到」（用户问「我家那只猫叫啥」
 * 而记忆里写的是「布丁是我养的猫」）。调研给的第一步就是**混合召回**：词法 + 向量用 RRF 融合。
 *
 * 设计取舍（都是为了「不引入新服务也能跑」）：
 *   · 嵌入用**已经在跑的**本地 8090（qwen3-embed，Qwen3-Embedding-0.6B），不新建服务
 *   · 向量缓存在磁盘（默认 data/记忆向量.json），内容按文本 hash 增量更新 ——
 *     重建索引时只嵌新增/变化的文档，744 条首次约 10 秒，之后每次几十毫秒
 *   · 8090 不可用 → **静默退回纯词法**（调用方拿到 null 就按词法走），不阻塞对话
 *   · 存成 base64(Float32Array)：3MB 而不是 7MB JSON 浮点数组，解析也快
 *
 * 刻意不做：不装向量库（744 条 × 1024 维 = 3MB，全量扫一遍 cosine 约 1-2ms，
 * 比维护 HNSW 索引便宜得多）、不调 reranker（调研结论：这一档先别做）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const EMBED_HOST = '127.0.0.1';
const EMBED_PORT = 8090;
const EMBED_MODEL = 'qwen3-embed';
const BATCH = 24;

function hashText(t) {
    return crypto.createHash('md5').update(String(t || ''), 'utf8').digest('hex');
}

function postJson(pathname, body, timeoutMs) {
    return new Promise((resolve) => {
        let data;
        try { data = Buffer.from(JSON.stringify(body), 'utf8'); } catch (e) { return resolve(null); }
        const req = http.request({
            host: EMBED_HOST, port: EMBED_PORT, path: pathname, method: 'POST', timeout: timeoutMs || 20000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        }, (res) => {
            let s = '';
            res.on('data', (c) => { s += c; });
            res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
        });
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
        req.on('error', () => resolve(null));
        req.write(data);
        req.end();
    });
}

/** 批量嵌入；失败返回 null（调用方据此退回词法） */
async function embedBatch(texts) {
    const arr = (texts || []).map((t) => String(t || '').slice(0, 1000));
    if (!arr.length) return [];
    const r = await postJson('/v1/embeddings', { input: arr, model: EMBED_MODEL }, 30000);
    const out = r && Array.isArray(r.data) ? r.data.map((d) => d && d.embedding) : null;
    if (!out || out.length !== arr.length || !out[0] || !out[0].length) return null;
    return out;
}

function f32ToB64(arr) {
    const f = Float32Array.from(arr);
    return Buffer.from(f.buffer).toString('base64');
}

function b64ToF32(b64) {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    // 复制一份，保证 buffer 对齐（Buffer 可能来自共享池，byteOffset 不一定 4 对齐）
    const copy = new Uint8Array(buf.length);
    copy.set(buf);
    return new Float32Array(copy.buffer);
}

function loadCache(file) {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!j || j.model !== EMBED_MODEL || typeof j.items !== 'object') return { model: EMBED_MODEL, items: {} };
        return j;
    } catch (e) {
        return { model: EMBED_MODEL, items: {} };
    }
}

function saveCache(file, cache) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // 合并写：并发实例（热重载会同时存在两个）各自只知道自己锚的那些，
        // 直接覆盖会把别人刚嵌好的条目冲掉（实测 744 条最后只剩 564）。
        const old = loadCache(file);
        const merged = { model: cache.model || EMBED_MODEL, items: Object.assign({}, old.items, cache.items || {}) };
        const tmp = file + '.tmp.' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(merged), 'utf8');
        fs.renameSync(tmp, file);
        return true;
    } catch (e) { return false; }
}

// ── 构建锁（2026-11-15）─────────────────────────────────────────────────
// 为什么需要：热重载会同时存在多个插件实例，每个实例看到「缓存不全」就开始嵌 700+ 条，
// 实测连着建了 3 遍、烧了 11 分钟 CPU。锁 + 新鲜度判断让后来者直接复用别人的结果。
function lockPath(cacheFile) { return cacheFile + '.building'; }
function lockFresh(cacheFile, maxAgeMs) {
    try {
        const st = fs.statSync(lockPath(cacheFile));
        return (Date.now() - st.mtimeMs) < (maxAgeMs || 10 * 60 * 1000);
    } catch (e) { return false; }
}
function acquireLock(cacheFile) {
    try {
        fs.writeFileSync(lockPath(cacheFile), String(process.pid) + ' ' + Date.now(), { flag: 'wx' });
        return true;
    } catch (e) {
        // 锁文件已存在：如果已经陈旧（进程崩了），抢过来
        if (!lockFresh(cacheFile, 10 * 60 * 1000)) {
            try { fs.unlinkSync(lockPath(cacheFile)); } catch (e2) {}
            try { fs.writeFileSync(lockPath(cacheFile), String(process.pid) + ' ' + Date.now(), { flag: 'wx' }); return true; } catch (e3) { return false; }
        }
        return false;
    }
}
function releaseLock(cacheFile) {
    try { fs.unlinkSync(lockPath(cacheFile)); } catch (e) { /* 已经被别人删了也无所谓 */ }
}

/**
 * 为一批文档准备向量（增量）。
 * @returns {Promise<{vectors: Float32Array[], dim:number, model:string, embedded:number, reused:number}|null>}
 *          null = 8090 不可用（调用方退回词法）
 */
async function ensureVectors(docs, opts) {
    const o = opts || {};
    const cacheFile = o.cacheFile;
    if (!cacheFile) return null;
    const cache = loadCache(cacheFile);
    const texts = docs.map((d) => String(d.text || ''));
    const keys = texts.map(hashText);

    // 先看缓存够不够
    const missing = [];
    for (let i = 0; i < keys.length; i += 1) {
        if (!cache.items[keys[i]]) missing.push(i);
    }

    let embedded = 0;
    if (missing.length) {
        // 别人正在建 → 直接用「现在能拼出来的那部分」，本轮不重复烧 CPU
        if (!acquireLock(cacheFile)) {
            const partial = [];
            for (const k of keys) {
                const v = cache.items[k] ? b64ToF32(cache.items[k]) : null;
                partial.push(v);
            }
            return partial[0] ? { vectors: partial, dim: partial.find((v) => v && v.length) ? partial.find((v) => v && v.length).length : 0, model: EMBED_MODEL, embedded: 0, reused: keys.length - missing.length } : null;
        }
        try {
            for (let s = 0; s < missing.length; s += BATCH) {
                const slice = missing.slice(s, s + BATCH);
                const vecs = await embedBatch(slice.map((i) => texts[i]));
                if (!vecs) return null;                      // 8090 不可用
                for (let k = 0; k < slice.length; k += 1) {
                    cache.items[keys[slice[k]]] = f32ToB64(vecs[k]);
                    embedded += 1;
                }
                saveCache(cacheFile, cache);                     // 分批落盘：中途被杀也不白干
            }
        } finally {
            releaseLock(cacheFile);
        }
    }
    // 组装
    let dim = 0;
    const vectors = [];
    for (const k of keys) {
        const v = b64ToF32(cache.items[k]);
        if (!dim) dim = v.length;
        vectors.push(v);
    }
    if (!dim) return null;
    return { vectors, dim, model: EMBED_MODEL, embedded, reused: keys.length - embedded };
}

function cosine(a, b) {
    if (!a || !b || !a.length || !b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Reciprocal Rank Fusion：把多路排序融成一个分数。
 * score(d) = Σ w_i / (k + rank_i(d))   —— k 取 60 是 RRF 的常用默认。
 * 为什么用 RRF 而不是把分数归一化后加权：两路分数量纲完全不同（词法 0~80、cosine 0~1），
 * 归一化会被离群值带偏；RRF 只看名次，稳。
 */
function fuseRRF(lists, k) {
    const kk = Number(k) || 60;
    const acc = new Map();
    for (const item of (lists || [])) {
        const ranks = item.ranks || [];       // 数组下标 = doc 索引，值 = 名次(1 起)
        const w = Number(item.weight) || 1;
        for (let i = 0; i < ranks.length; i += 1) {
            const r = ranks[i];
            if (!r) continue;
            acc.set(i, (acc.get(i) || 0) + w / (kk + r));
        }
    }
    return acc;
}

function rankOf(scores) {
    // scores: 数组（越大越好，0 表示不计入）→ 名次数组（1 起，0 = 未入榜）
    const idx = scores.map((s, i) => ({ s, i })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    const ranks = new Array(scores.length).fill(0);
    for (let r = 0; r < idx.length; r += 1) ranks[idx[r].i] = r + 1;
    return ranks;
}

module.exports = { ensureVectors, embedBatch, cosine, fuseRRF, rankOf, hashText, loadCache, saveCache, EMBED_MODEL };
