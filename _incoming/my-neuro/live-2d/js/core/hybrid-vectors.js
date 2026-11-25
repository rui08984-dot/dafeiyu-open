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

// ── 缓存上限与 LRU（2026-11-25 P1）──────────────────────────────────────
// 现场：记忆向量.json 6.6MB / 1211 条，只增不减（saveCache 只 merge），
// 且 _rebuild 每 90 秒把整批文档重新组装一遍。缓存条目没有任何上限。
// 现在：条目 ≤20000 且文件 ≤8MB；超限按 (lastUsedAt, hits) 升序淘汰最久没用过的。
// meta 单独存 `{hash: [lastUsedAt, hits]}`，保持 items 仍是 hash→base64 字符串
// （老缓存可直接读；meta 缺失按 0 处理 → 优先淘汰，符合「不知道是否被用过」）。
const CACHE_MAX_ITEMS = 20000;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;
// 每次写入前只保留这么多条 meta（防止被淘汰条目的 meta 长期滞留）
const CACHE_META_MAX = CACHE_MAX_ITEMS;

// ── 已淘汰键的进程内墓碑（2026-11-25 审计 P1-3）────────────────────────
// 现场：saveCache 淘汰时只删局部的 items 副本，调用方内存里的 cache.items 仍是全量；
// 下一次 flushUsage 从内存 merge 回来，淘汰项原地复活（实测 5→10），8MB 上限永远回到阈值之上。
// 这里按「缓存文件 + hash」记下已淘汰键，saveCache/flushUsage 合并时跳过；
// 条目再次被真正 embed 时从集合移除。上限 5000：只防同进程旧实例的短期回写，不需要永久记。
// 键带文件名：不同记录室 / 测试用临时文件的同名 hash 互不影响。
const EVICTED_KEYS_MAX = 5000;
const _evictedKeys = new Set();
function evictKey(file, k) { return String(file || '') + '\u0000' + String(k || ''); }
function markEvicted(file, k) {
    if (!k) return;
    const ek = evictKey(file, k);
    _evictedKeys.delete(ek);
    _evictedKeys.add(ek);
    while (_evictedKeys.size > EVICTED_KEYS_MAX) {
        const first = _evictedKeys.values().next().value;
        _evictedKeys.delete(first);
    }
}
function isEvicted(file, k) { return _evictedKeys.has(evictKey(file, k)); }
function unmarkEvicted(file, k) { _evictedKeys.delete(evictKey(file, k)); }

function emptyCache() {
    return { model: EMBED_MODEL, items: {}, meta: {} };
}

function loadCache(file) {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!j || j.model !== EMBED_MODEL || typeof j.items !== 'object') return emptyCache();
        if (!j.meta || typeof j.meta !== 'object') j.meta = {};
        return j;
    } catch (e) {
        return emptyCache();
    }
}

/** 合并两份 meta：同 key 取 lastUsedAt 较大者、hits 较大者（并发实例各自累加，取 max 不虚增）。 */
function mergeMeta(a, b) {
    const out = {};
    for (const src of [a || {}, b || {}]) {
        for (const k of Object.keys(src)) {
            const cur = out[k];
            const v = Array.isArray(src[k]) ? src[k] : [0, 0];
            if (!cur) { out[k] = [Number(v[0]) || 0, Number(v[1]) || 0]; continue; }
            out[k] = [Math.max(cur[0], Number(v[0]) || 0), Math.max(cur[1], Number(v[1]) || 0)];
        }
    }
    return out;
}

/** 估算序列化体积（避免为了算字节反复 stringify 数 MB 的 base64） */
function estimateBytes(model, items, meta) {
    let n = 40 + String(model || '').length;
    for (const k of Object.keys(items)) {
        n += k.length + 4 + String(items[k]).length + 2;
        const m = meta[k];
        if (m) n += k.length + 12;
    }
    return n;
}

/**
 * 合并写 + 上限淘汰 + 原子写（tmp+rename）。无变化直接返回 skipped（不写盘）。
 * @param {{maxItems?:number,maxBytes?:number,evict?:boolean,keepKeys?:string[]}} [opts]
 * @returns {{ok:boolean,skipped:boolean,items:number,bytes:number,evicted:number}}
 */
function saveCache(file, cache, opts) {
    const o = opts || {};
    const maxItems = Number(o.maxItems) || CACHE_MAX_ITEMS;
    const maxBytes = Number(o.maxBytes) || CACHE_MAX_BYTES;
    const doEvict = o.evict !== false;
    try {
        const old = loadCache(file);
        const memItems = (cache && cache.items) || {};
        const items = Object.assign({}, old.items);
        for (const k of Object.keys(memItems)) {
            if (isEvicted(file, k)) {
                // 已淘汰的键不随内存副本复活；只有磁盘上确实又有了（别的实例重新嵌过）才解除墓碑。
                if (old.items[k]) unmarkEvicted(file, k);
                else continue;
            }
            items[k] = memItems[k];
        }
        const meta = mergeMeta(old.meta, cache && cache.meta);
        // meta 只跟 items 同生命周期：条目没了，usage 也删
        for (const k of Object.keys(meta)) {
            if (!items[k]) delete meta[k];
        }

        let evicted = 0;
        if (doEvict) {
            const keep = new Set((o.keepKeys || []).filter(Boolean));
            let count = Object.keys(items).length;
            let bytes = estimateBytes((cache && cache.model) || EMBED_MODEL, items, meta);
            if (count > maxItems || bytes > maxBytes) {
                // 淘汰顺序：不在当前文档集里的优先；再按 (lastUsedAt, hits) 升序；最后按 hash 稳定排序。
                // 当前文档集的条目（keepKeys）排最后：避免「刚索引的文档立刻被淘汰 → 下次重新嵌入」的抖动。
                const rank = (k) => {
                    const m = meta[k] || [0, 0];
                    return [Number(m[0]) || 0, Number(m[1]) || 0];
                };
                const victims = Object.keys(items)
                    .map((k) => ({ k, inKeep: keep.has(k), r: rank(k) }))
                    .sort((a, b) => (a.inKeep ? 1 : 0) - (b.inKeep ? 1 : 0)
                        || a.r[0] - b.r[0]
                        || a.r[1] - b.r[1]
                        || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
                for (const v of victims) {
                    if (count <= maxItems && bytes <= maxBytes) break;
                    const size = v.k.length + 4 + String(items[v.k] || '').length + 2 + (meta[v.k] ? v.k.length + 12 : 0);
                    delete items[v.k];
                    delete meta[v.k];
                    // 记墓碑 + 从调用方内存副本里一并删掉：同进程的下一次 flushUsage 不会再 merge 回来。
                    markEvicted(file, v.k);
                    if (cache && cache.items && Object.prototype.hasOwnProperty.call(cache.items, v.k)) delete cache.items[v.k];
                    if (cache && cache.meta && Object.prototype.hasOwnProperty.call(cache.meta, v.k)) delete cache.meta[v.k];
                    count -= 1;
                    bytes -= size;
                    evicted += 1;
                }
                // 最终复核一次（估算与真实序列化可能有 ±个位数误差）
                bytes = estimateBytes((cache && cache.model) || EMBED_MODEL, items, meta);
            }
        }

        const oldCount = Object.keys(old.items).length;
        // 用合并后的 items 判变化：被墓碑挡掉的内存副本不该让每次 flush 都误以为「有新增」。
        const newKeys = Object.keys(items).filter((k) => old.items[k] !== items[k]);
        const metaDirty = !!(cache && cache.dirty);
        const needsWrite = newKeys.length > 0 || metaDirty || evicted > 0;
        const model = (cache && cache.model) || EMBED_MODEL;
        if (!needsWrite) {
            return { ok: true, skipped: true, items: oldCount, bytes: 0, evicted: 0 };
        }

        const merged = { model, items, meta };
        const text = JSON.stringify(merged);
        const tmp = file + '.tmp.' + process.pid + '-' + Date.now().toString(36);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, file);
        if (cache) cache.dirty = false;
        return { ok: true, skipped: false, items: Object.keys(items).length, bytes: Buffer.byteLength(text), evicted };
    } catch (e) { return { ok: false, skipped: false, items: 0, bytes: 0, evicted: 0 }; }
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
    // 单测注入缝（生产只走 embedBatch）：opts.embed 可以替换嵌入函数，
    // 用来验证「只嵌新增/变更文档」，不依赖 8090 真实服务。
    const embed = typeof o.embed === 'function' ? o.embed : embedBatch;

    // 先看缓存够不够（按内容 hash 增量：只有新增/变更文档会被嵌入）
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
            return partial[0] ? {
                vectors: partial,
                dim: partial.find((v) => v && v.length) ? partial.find((v) => v && v.length).length : 0,
                model: EMBED_MODEL, embedded: 0, reused: keys.length - missing.length,
                keys, cache, evicted: 0, incremental: true
            } : null;
        }
        try {
            for (let s = 0; s < missing.length; s += BATCH) {
                const slice = missing.slice(s, s + BATCH);
                const vecs = await embed(slice.map((i) => texts[i]));
                if (!vecs) return null;                      // 8090 不可用
                for (let k = 0; k < slice.length; k += 1) {
                    const key = keys[slice[k]];
                    cache.items[key] = f32ToB64(vecs[k]);
                    unmarkEvicted(cacheFile, key);      // 真正重新嵌入 → 允许回来（P1-3）
                    embedded += 1;
                }
                // 分批落盘：中途被杀也不白干。中间批不做淘汰（避免每 24 条就排序 6MB 缓存），
                // 淘汰只在最后的收口写盘做一次。
                saveCache(cacheFile, cache, { evict: false });
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
    // 收口写盘：合并 + 上限淘汰 + 原子写；无变化（含只有 usage 变化）也会跳过写盘。
    // keepKeys = 当前文档集：淘汰时这些条目排最后，避免「刚嵌好就被淘汰」的抖动。
    const saved = saveCache(cacheFile, cache, { evict: true, keepKeys: keys });
    if (!dim) return null;
    return {
        vectors, dim, model: EMBED_MODEL, embedded, reused: keys.length - embedded,
        keys, cache, evicted: Number(saved && saved.evicted) || 0,
        incremental: embedded < keys.length
    };
}

/**
 * 记录「这些文档被检索命中过」→ 更新 lastUsedAt/hits（LRU 的唯一输入）。
 * 只改内存里的 cache；真正落盘由 saveCache/flushUsage 在收口时做。
 * @returns {number} 更新条数
 */
function noteHits(built, indices) {
    if (!built || !built.cache || !Array.isArray(built.keys)) return 0;
    const cache = built.cache;
    if (!cache.meta || typeof cache.meta !== 'object') cache.meta = {};
    let n = 0;
    for (const i of (indices || [])) {
        const k = built.keys[i];
        if (!k) continue;
        const cur = cache.meta[k] || [0, 0];
        cache.meta[k] = [Date.now(), (Number(cur[1]) || 0) + 1];
        n += 1;
    }
    if (n) cache.dirty = true;
    return n;
}

/** 把内存里的 usage 变化落盘（带合并/淘汰）；没有变化时 saveCache 自己跳过。 */
function flushUsage(cacheFile, cache, opts) {
    if (!cacheFile || !cache) return { ok: true, skipped: true, items: 0, bytes: 0, evicted: 0 };
    return saveCache(cacheFile, cache, Object.assign({ evict: true }, opts || {}));
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

module.exports = {
    ensureVectors, embedBatch, cosine, fuseRRF, rankOf, hashText,
    loadCache, saveCache, noteHits, flushUsage,
    EMBED_MODEL, CACHE_MAX_ITEMS, CACHE_MAX_BYTES, EVICTED_KEYS_MAX,
    // 只读观测（测试用）：墓碑集合大小，确认有上限、不会无限增长
    _evictedCount: () => _evictedKeys.size,
};
