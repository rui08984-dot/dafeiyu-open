// knowledge-base.js —— 知识库三层引擎（2026-11-09 三十五轮）
//
// 为什么要把攻略从代码里搬出来：
//   原来 SEMANTIC_PROFILES_BUILTIN 和 pvz guide 是硬编码的。问题：
//     · 用户想加游戏/改键位 → 得动代码
//     · 游戏更新了 → 攻略变错，而且错了没人知道
//     · 每条都进 prompt → 52 个工具的上下文已经不小
//     · 她玩过一次发现「这么点没用」→ 下次还是照原样点
//
// 三层（详见 pet-runtime/knowledge/README.md）：
//   ① rules/      稳定规则层：半年不怎么会变的（玩法骨架、UI 布局、安全键位）
//   ② live/       动态 RAG 层：会过期的（新版本改键、当前版本强势），覆盖 rules
//   ③ experience/ 经验层：她自己试出来的（append-only JSONL，带时间戳和证据）
//
// 检索：**不自己造轮子**，全部用成熟组件
//   · 切词/BM25/RRF 融合 → pet-core（Rust，实测核心 59 微秒）
//     中文用 CJK bigram（不需要词典、召回率高），BM25 用 Okapi 原论文参数，
//     融合用 RRF（只用排名，量纲无关，换语料不用重调权重）
//   · 向量 → 已有的 8090 Qwen3-Embedding 0.6B（OpenAI 兼容 /v1/embeddings，1024 维）
//   · 向量缓存 → 本地 JSON 文件（知识条目数量级是几百，不值得上向量数据库）
//
// 关键纪律：
//   · live/ 的东西必须带 updatedAt + confidence，超过 90 天自动降级（weight 打 0.5）
//   · experience/ 只增不改 —— 能删就能骗自己。发现错了再写一条否定的
//   · 注入 prompt 时**不全注入**，按相关度取，总量 ≤800 字符

'use strict';
const fs_ = require('fs');
const path_ = require('path');
const { execFile } = require('child_process');
const jsonStore = require('../../../js/core/json-store.js');

// 知识库根：沿目录树向上找 pet-runtime/knowledge（不数 '..' 层数 —— 已经踩过两次坑）
function findRoot(start, marker) {
    let dir = start || __dirname;
    for (let i = 0; i < 12; i += 1) {
        const cand = path_.join(dir, ...marker);
        if (fs_.existsSync(cand)) return cand;
        const up = path_.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return null;
}

const ROOT = findRoot(__dirname, ['pet-runtime', 'knowledge']);
// pet-core 二进制：先找 pet-core/Cargo.toml 的父目录（注意 findRoot 返回的是文件路径含 Cargo.toml，
// 要 path.dirname 一次拿到项目根 —— 这里踩过坑：直接 join 会变成 Cargo.toml\target\...）
function findCoreBin() {
    const cargo = findRoot(__dirname, ['pet-core', 'Cargo.toml']);
    if (!cargo) return null;
    const coreDir = path_.dirname(cargo);   // .../pet-core/Cargo.toml → .../pet-core
    const exe = process.platform === 'win32' ? 'pet-core.exe' : 'pet-core';
    const cand = path_.join(coreDir, 'target', 'release', exe);
    return fs_.existsSync(cand) ? cand : null;
}
const CORE_BIN = findCoreBin();
const CACHE_DIR = ROOT ? path_.join(ROOT, '.cache') : null;
const EMBED_CACHE = CACHE_DIR ? path_.join(CACHE_DIR, 'embeddings.json') : null;

const STALE_DAYS = 90;          // 超过 90 天没更新的 live/ 条目自动降级
const PROMPT_BUDGET = 800;      // prompt 段落字符预算
const EMBED_PORT = Number(process.env.PET_EMBED_PORT) || 8090;
const EMBED_MODEL = process.env.PET_EMBED_MODEL || 'Qwen3-Embedding-0.6B-Q8_0.gguf';

// 读写统一走 js/core/json-store.js（原子写 + 损坏隔离），这里不再保留私有实现。
// 说明：知识条目是「人写的 rules/live」和 append-only 的 experience JSONL，
// 坏文件隔离后不会被程序写回，人工修好即可。

/** 游戏名归一化：去掉空格/标点/版本号，方便文件名和模糊匹配 */
function normalizeGame(name) {
    return String(name || '')
        .replace(/[（(].*?[)）]/g, '')
        .replace(/[vV]\d[\d.]*/g, '')
        .replace(/[\s\-_:：·.]+/g, '')
        .trim();
}

function findFile(dir, game) {
    if (!dir || !fs_.existsSync(dir)) return null;
    const want = normalizeGame(game);
    if (!want) return null;
    let files = [];
    try { files = fs_.readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl')); } catch (e) { return null; }
    for (const f of files) {
        const base = normalizeGame(f.replace(/\.jsonl?$/, ''));
        if (base === want) return path_.join(dir, f);
    }
    for (const f of files) {
        const base = normalizeGame(f.replace(/\.jsonl?$/, ''));
        if (base && (want.includes(base) || base.includes(want))) return path_.join(dir, f);
    }
    return null;
}

/** live 条目的时效：fresh(≤30d) / aging(≤90d) / stale(>90d) / unknown */
function freshness(updatedAt) {
    if (!updatedAt) return { level: 'unknown', days: null };
    const t = Date.parse(updatedAt);
    if (!Number.isFinite(t)) return { level: 'unknown', days: null };
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 30) return { level: 'fresh', days };
    if (days <= STALE_DAYS) return { level: 'aging', days };
    return { level: 'stale', days };
}

// ── 向量缓存（知识条目几百条，冷启动一次算完，之后按内容 sha 命中）──────────
let _embedCache = null;
function _loadEmbedCache() {
    if (_embedCache) return _embedCache;
    // 缓存坏了 = 改名隔离 + 返回 null，下次全量重算（缓存丢了不影响功能）
    _embedCache = (EMBED_CACHE && jsonStore.readJson(EMBED_CACHE, null)) || {};
    return _embedCache;
}
function _saveEmbedCache() {
    if (!_embedCache || !CACHE_DIR) return;
    try {
        // pretty:false 保持原来紧凑格式（缓存可能很大，缩进纯属浪费）
        jsonStore.writeJson(EMBED_CACHE, _embedCache, { pretty: false });
    } catch (e) {
        // 缓存写失败/已隔离不影响功能（下次重算），但要留痕
        try { require('../../../js/core/silent-audit.js').audit('knowledge-base:saveEmbedCache', e); } catch (e2) { /* ignore */ }
    }
}

/** 调 8090 嵌入服务（OpenAI 兼容）。失败返回 null（调用方退化成纯 BM25）。 */
function embedTexts(texts) {
    return new Promise((resolve) => {
        if (!Array.isArray(texts) || !texts.length) return resolve([]);
        const body = Buffer.from(JSON.stringify({ input: texts, model: EMBED_MODEL }), 'utf8');
        const req = require('http').request({
            host: '127.0.0.1', port: EMBED_PORT, path: '/v1/embeddings', method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length },
            timeout: 30000,
        }, (res) => {
            let s = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { s += c; });
            res.on('end', () => {
                try {
                    const d = JSON.parse(s);
                    if (!d || !Array.isArray(d.data)) return resolve([]);
                    resolve(d.data.map((x) => x.embedding).filter(Array.isArray));
                } catch (e) { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve([]); });
        req.write(body);
        req.end();
    });
}

/** 给一批文本拿向量（带缓存）。cacheKey 用文本 sha1 的前 16 位。
 *
 * ⚠ 2026-11-10 三十七轮修两个真 bug（知识库灌满之后才暴露）：
 *   ① **30 秒超时导致缓存从来没成功过**：原来一次性把全部 docs 发过去。
 *      实测 8090 是**线性 0.115 秒/条** —— 原神 467 条要 54 秒，必然撞 `timeout: 30000`
 *      → `req.on('timeout')` 返回 `[]` → `got.length !== missing.length` → **不写缓存**
 *      → 下次重试又等 30 秒。实测连查 3 次：30.1 / 31.2 / 30.1 秒，一模一样。
 *   ② 单批太大：改成 **32 条/批**（实测 3.58 秒/批，安全落在 30 秒内），
 *      而且**每批成功就立刻落盘**（渐进式）—— 中途某批失败也不丢已经算好的。
 */
const EMBED_BATCH = 32;

async function embedWithCache(texts) {
    const cache = _loadEmbedCache();
    const keys = texts.map((t) => {
        const h = require('crypto').createHash('sha1').update(String(t)).digest('hex').slice(0, 16);
        return h;
    });
    const missing = [];
    const missingIdx = [];
    for (let i = 0; i < texts.length; i += 1) {
        if (!cache[keys[i]]) { missing.push(texts[i]); missingIdx.push(i); }
    }
    if (missing.length) {
        let okCount = 0;
        let failCount = 0;
        for (let b = 0; b < missing.length; b += EMBED_BATCH) {
            const chunk = missing.slice(b, b + EMBED_BATCH);
            // eslint-disable-next-line no-await-in-loop
            const got = await embedTexts(chunk);
            if (got.length === chunk.length) {
                for (let j = 0; j < chunk.length; j += 1) {
                    cache[keys[missingIdx[b + j]]] = got[j];
                }
                okCount += chunk.length;
                _saveEmbedCache();      // 渐进落盘：这一批算完就先存下
            } else {
                failCount += chunk.length;
            }
        }
        if (failCount) {
            // 不静默：成功多少 / 失败多少要能看见（失败的这批退化成纯 BM25，下次重试）
            console.error('[knowledge-base] 嵌入部分失败：成功 ' + okCount + ' 条，失败 ' + failCount + ' 条');
        }
    }
    return texts.map((t, i) => cache[keys[i]] || null);
}

/**
 * 后台预热向量缓存（不阻塞调用方）。
 * 场景：知识库刚灌满 / 换了机器 / 缓存被删 —— 第一次查攻略时缓存是冷的。
 * 同步算要 30 秒以上，所以本次查询直接用纯 BM25 返回，这里在后台慢慢补。
 * 同一时间只跑一个预热任务，避免并发重复计算（多个查询同时进来时）。
 */
let _warming = false;
function _warmInBackground(texts) {
    if (_warming || !Array.isArray(texts) || !texts.length) return;
    _warming = true;
    Promise.resolve()
        .then(() => embedWithCache(texts))
        .then(() => { console.log('[knowledge-base] 向量预热完成：' + texts.length + ' 条已进缓存'); })
        .catch((e) => { console.error('[knowledge-base] 向量预热失败：', (e && e.message) || e); })
        .finally(() => { _warming = false; });
}

// ── 三层合并成扁平 docs（Rust 检索的输入）─────────────────────────────

/**
 * 读三层，返回结构化的知识 + 扁平 doc 列表。
 * @param {string} gameName
 * @returns {Promise<object>}
 */
async function loadLayers(gameName) {
    const out = {
        found: false, game: String(gameName || ''), source: {},
        rules: [], keys: {}, live: null, experience: [], confidence: 'unknown', typicalActions: [],
    };
    if (!ROOT) { out.error = '找不到知识库目录（pet-runtime/knowledge）'; return out; }

    // ① 稳定规则层（找不到退 generic）
    let rulesPath = findFile(path_.join(ROOT, 'rules'), gameName);
    if (!rulesPath) rulesPath = path_.join(ROOT, 'rules', 'generic-desktop.json');
    const rulesDoc = jsonStore.readJson(rulesPath, null);
    if (rulesDoc) {
        out.found = true;
        out.game = rulesDoc.game || out.game;
        out.rules = Array.isArray(rulesDoc.rules) ? rulesDoc.rules : [];
        out.keys = Object.assign({}, rulesDoc.keys || {});
        out.typicalActions = Array.isArray(rulesDoc.typicalActions) ? rulesDoc.typicalActions : [];
        out.source.rules = path_.basename(rulesPath);
        out.confidence = rulesDoc.confidence || 'unknown';
    }

    // ② 动态 RAG 层（覆盖 keys，追加 rules，标过期）
    const livePath = findFile(path_.join(ROOT, 'live'), gameName);
    if (livePath) {
        const liveDoc = jsonStore.readJson(livePath, null);
        if (liveDoc) {
            const fresh = freshness(liveDoc.updatedAt);
            out.live = {
                version: liveDoc.version || '', source: liveDoc.source || '',
                updatedAt: liveDoc.updatedAt || '', confidence: liveDoc.confidence || 'unknown',
                freshness: fresh.level, ageDays: fresh.days, note: liveDoc.note || '',
            };
            out.source.live = path_.basename(livePath);
            if (liveDoc.overrides && liveDoc.overrides.keys) Object.assign(out.keys, liveDoc.overrides.keys);
            if (Array.isArray(liveDoc.extra)) {
                for (const e of liveDoc.extra) {
                    out.rules.push(Object.assign({}, e, {
                        stale: fresh.level === 'stale', staleDays: fresh.days,
                    }));
                }
            }
            if (fresh.level === 'stale') out.live.confidence = 'low';
        }
    }

    // ③ 经验层
    const expPath = findFile(path_.join(ROOT, 'experience'), gameName);
    if (expPath) {
        out.source.experience = path_.basename(expPath);
        out.experience = jsonStore.readJsonl(expPath).slice(-200);
    }
    return out;
}

/**
 * 把三层拍平成 Rust 检索用的 docs。
 * weight 语义：这个知识有多值得信（过期/低置信度打折）。
 */
function flattenToDocs(kn) {
    const docs = [];
    const game = kn.game || 'generic';

    // 规则：稳定层 1.0；live 追加的按时效打折
    for (const r of kn.rules || []) {
        if (!r || !r.text) continue;
        let w = 1.0;
        if (r.stale) w = 0.5;
        docs.push({
            id: 'rule:' + (r.id || String(docs.length)),
            text: String(r.text),
            searchable: [r.kind || '', String(r.text), game].join(' '),
            embedding: [],
            weight: w,
            meta: { layer: r.stale ? 'live-stale' : 'rules', kind: String(r.kind || ''), game },
        });
    }

    // 典型动作（当作「怎么做」的知识）
    const acts = kn.typicalActions || [];
    if (acts.length) {
        docs.push({
            id: 'actions',
            text: '常用动作：' + acts.join(' / '),
            searchable: acts.join(' ') + ' 动作 怎么做',
            embedding: [],
            weight: 0.9,
            meta: { layer: 'rules', kind: 'actions', game },
        });
    }

    // 键位（当成一条整体，避免每个键一条占满语料）
    const keyEntries = Object.entries(kn.keys || {}).filter(([, v]) => v);
    if (keyEntries.length) {
        const keysText = keyEntries.map(([k, v]) => k + '=' + v).join(' ');
        docs.push({
            id: 'keys',
            text: '键位：' + keysText,
            searchable: keysText + ' 键位 按键 快捷键',
            embedding: [],
            weight: 0.85,
            meta: { layer: 'rules', kind: 'keys', game },
        });
    }

    // 经验：验证通过的 1.0、失败的 0.9（失败的更有教学价值）、未验证的 0.4
    for (let i = 0; i < (kn.experience || []).length; i += 1) {
        const e = kn.experience[i];
        if (!e || !e.action) continue;
        const success = e.kind === 'success' && e.verified !== false;
        const verified = e.verified === true || e.verified === false;
        const w = verified ? (success ? 1.0 : 0.9) : 0.4;
        docs.push({
            id: 'exp:' + i,
            text: (success ? '✓ ' : '✗ ') + String(e.action).slice(0, 80) + (e.note ? ' —— ' + String(e.note).slice(0, 100) : ''),
            searchable: [String(e.action || ''), String(e.note || ''), String(e.evidence || '')].join(' '),
            embedding: [],
            weight: w,
            meta: { layer: 'experience', kind: e.kind || '', ts: String(e.ts || ''), game },
        });
    }
    return docs;
}

/** 调 Rust 核心做检索。失败返回 null（调用方回落到「全返回、不排序」）。 */
function rustSearch(docs, query, queryVec, topK) {
    return new Promise((resolve) => {
        if (!CORE_BIN || !fs_.existsSync(CORE_BIN)) return resolve(null);
        const payload = JSON.stringify({
            cmd: 'knowledge_search',
            docs, query,
            query_vec: queryVec || [],
            top_k: topK || 8,
        });
        const child = execFile(CORE_BIN, [], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout) => {
                if (err) return resolve(null);
                try { resolve(JSON.parse(String(stdout))); } catch (e) { resolve(null); }
            });
        try { child.stdin.end(payload, 'utf8'); } catch (e) { resolve(null); }
    });
}

/**
 * 主入口：给游戏名 + 可选查询，返回排序后的知识。
 *
 * @param {string} gameName
 * @param {object} opts { query, topK, withPrompt }
 *   · query 为空 → 不做检索，按层顺序返回全部规则（用于「初次进游戏」）
 *   · query 非空 → 混合检索（BM25 + 向量 + RRF）
 */
async function getKnowledge(gameName, opts) {
    const o = opts || {};
    const kn = await loadLayers(gameName);
    if (!kn.found && !kn.experience.length) return kn;

    let docs = flattenToDocs(kn);

    // 只有给查询才做检索（没查询就是「全量给骨架」，那是初始 prompt 的场景）
    if (o.query && docs.length) {
        // 先给文档补向量（带缓存；嵌入服务挂了就全空 → Rust 侧纯 BM25）
        //
        // ⚠ 2026-11-10 三十七轮：加 MAX_EMBED 上限。
        //   8090 是线性 0.115 秒/条，467 条全量 = 54 秒，首次体验不可接受（而且旧代码在 30 秒超时后
        //   连缓存都写不进去，等于每次 30 秒）。这里只给前 MAX_EMBED 条补向量：
        //   · 向量在本项目里是**精排信号**，BM25（CJK bigram）本身就是主力 —— 实测
        //     `钻石镐 怎么合成` → `recipe-diamond_pickaxe`、`甘雨 冰 弓` → `char-甘雨` 都能靠 BM25 命中。
        //   · 没补向量的文档 `embedding` 为空，Rust 侧会退化成纯 BM25 排序，不影响召回。
        //   算过的会落盘缓存，所以只有第一次付这个钱。
        const MAX_EMBED = 64;   // 64 × 0.115s ≈ 7.4 秒（一次性）；之后全走缓存
        const texts = docs.map((d) => d.searchable || d.text);
        const head = texts.slice(0, MAX_EMBED);
        // 缓存冷启动不能阻塞这次查询：8090 线性 0.115s/条，64 条 + 查询要 30 秒以上，
        // 用户第一次问攻略会干等半分钟。所以**冷的时候直接用纯 BM25 立刻返回**（283μs），
        // 同时后台慢慢把向量补进缓存 —— 第二次起就有向量精排了。
        // 热的时候（缓存命中 ≥ 八成都）才同步 await，保证精排质量。
        const cachePeek = _loadEmbedCache();
        let missHead = 0;
        for (const t of head) {
            const k = require('crypto').createHash('sha1').update(String(t)).digest('hex').slice(0, 16);
            if (!cachePeek[k]) missHead += 1;
        }
        const cold = missHead > Math.max(4, Math.floor(head.length * 0.2));
        let vecs;
        if (cold) {
            vecs = texts.map(() => null);   // 本次纯 BM25
            _warmInBackground(head);        // 后台预热，不 await
        } else {
            vecs = await embedWithCache(head);
        }
        for (let i = 0; i < docs.length; i += 1) {
            if (i < vecs.length && vecs[i]) docs[i].embedding = vecs[i];
        }
        // 查询向量
        const qv = (await embedWithCache([String(o.query)]))[0];
        const r = await rustSearch(docs, String(o.query), qv || [], o.topK || 8);
        if (r && Array.isArray(r.hits)) {
            kn.retrieved = r.hits.map((h) => ({
                text: h.text, score: Math.round(h.score * 100000) / 100000,
                layer: (h.meta && h.meta.layer) || '',
                bm25Rank: h.rank_bm25, vecRank: h.rank_vec, cosine: Math.round(h.cosine * 1000) / 1000,
            }));
            kn.retrievalTrace = r.trace;
            kn.retrievalTotalUs = r.total_us;
        }
    } else {
        kn.retrieved = docs.map((d) => ({ text: d.text, score: null, layer: (d.meta && d.meta.layer) || '' }));
    }

    if (o.withPrompt !== false) kn.promptText = buildPromptText(kn, o.query);
    return kn;
}

/** 统计某个动作的历史成功率（Beta 后验：mean=(s+1)/(n+2)） */
function getActionReliability(gameName, action) {
    const act = String(action || '').trim().toLowerCase();
    if (!act || !ROOT) return null;
    const expPath = findFile(path_.join(ROOT, 'experience'), gameName);
    const all = expPath ? jsonStore.readJsonl(expPath) : [];
    const rel = all.filter((e) => String(e.action || '').toLowerCase().includes(act));
    const success = rel.filter((e) => e.kind === 'success' && e.verified !== false).length;
    const failure = rel.filter((e) => e.kind === 'failure' || e.verified === false).length;
    const n = success + failure;
    const mean = (success + 1) / (n + 2);
    // 95% CI 半宽（Beta 后验近似）—— 样本少时置信度自动打折，不吹牛
    const alpha = success + 1;
    const beta = failure + 1;
    const ciHalf = 1.96 * Math.sqrt((alpha * beta) / ((alpha + beta) * (alpha + beta) * (alpha + beta + 1)));
    return {
        action: act, success, failure, total: n,
        mean: Math.round(mean * 1000) / 1000,
        ciHalf: Math.round(ciHalf * 1000) / 1000,
        verdict: n < 3 ? 'insufficient' : (mean >= 0.7 ? 'reliable' : (mean <= 0.3 ? 'unreliable' : 'mixed')),
    };
}

// 经验层滚动窗口：超过 2000 行就重写保留最后 1500 行
const EXP_ROLL_MAX = 2000;
const EXP_ROLL_KEEP = 1500;
// 每个经验文件的近似行数（第一次写时从磁盘读一次，之后只 +1 —— 避免每次 append 都全量读）
const _expLineCount = new Map();
function _expLineCountOf(file) {
    let n = _expLineCount.get(file);
    if (n === undefined) {
        try {
            const txt = fs_.readFileSync(file, 'utf8');
            n = txt ? txt.split('\n').filter((l) => l.trim()).length : 0;
        } catch (e) {
            n = 0;
        }
        _expLineCount.set(file, n);
    }
    return n;
}

/** 写一条经验（append-only JSONL） */
function recordExperience(entry) {
    if (!ROOT) return { ok: false, error: '找不到知识库目录' };
    const e = entry || {};
    const game = String(e.game || 'generic-desktop');
    const dir = path_.join(ROOT, 'experience');
    try {
        if (!fs_.existsSync(dir)) fs_.mkdirSync(dir, { recursive: true });
    } catch (err) {
        return { ok: false, error: '建目录失败：' + err.message };
    }
    const safeName = game.replace(/[\\/:*?"<>|]/g, '_');
    const file = path_.join(dir, safeName + '.jsonl');
    const rec = {
        ts: new Date().toISOString(),
        game,
        kind: e.kind === 'failure' ? 'failure' : 'success',
        action: String(e.action || '').slice(0, 200),
        verified: e.verified === true ? true : (e.verified === false ? false : null),
        evidence: String(e.evidence || '').slice(0, 300),
        note: String(e.note || '').slice(0, 300),
    };
    try {
        // ⚠ 2026-11-10 数据完整性修复：原来只追加、永不滚动 —— 打游戏时每个动作一条，
        //   文件无限长（检索每次全量读，越用越慢）。现在写时滚上限：
        //   行数 > 2000 就原子重写，只保留最后 1500 行（老经验不是删库，是滚动出窗口）。
        const before = _expLineCountOf(file);
        fs_.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
        const n = before + 1;
        _expLineCount.set(file, n);
        if (n > EXP_ROLL_MAX) {
            const rows = jsonStore.readJsonl(file);
            const keep = rows.slice(-EXP_ROLL_KEEP);
            jsonStore.writeJsonl(file, keep);
            _expLineCount.set(file, keep.length);
        }
        return { ok: true, file: path_.basename(file), record: rec };
    } catch (err) {
        return { ok: false, error: '写入失败：' + err.message };
    }
}

/** 从动作结果自动落经验。**只有验证过的才记** —— 这是「可靠度由世界盖章」。 */
function recordFromResult(gameName, action, result) {
    if (!result || typeof result !== 'object') return { ok: false, error: 'invalid result' };
    if (result.effect === 'readonly') return { ok: false, skipped: 'readonly' };
    if (result.effect === 'not_sent') return { ok: false, skipped: 'not_sent' };
    const isSuccess = result.verified === true && result.effect === 'confirmed';
    const isFailure = result.effect === 'suspected_noop' || (result.verified === true && result.ok === false);
    // 无法验证的不记 —— 记了就是猜
    if (!isSuccess && !isFailure) return { ok: false, skipped: 'unverifiable' };
    return recordExperience({
        game: gameName,
        kind: isSuccess ? 'success' : 'failure',
        action, verified: true,
        evidence: result.evidence || '',
        note: result.detail || '',
    });
}

/**
 * 生成注入 prompt 的紧凑文本。
 * 有查询 → 用检索结果；无查询 → 按层顺序给骨架。
 */
function buildPromptText(kn, query) {
    const lines = [];
    const g = kn.game || '当前环境';

    // 标题行：带版本和时效
    if (kn.live && kn.live.version) {
        let tag = '（' + kn.live.version + '）';
        if (kn.live.freshness === 'stale') tag += ' ⚠这条已 ' + kn.live.ageDays + ' 天没更新，可能过时';
        else if (kn.live.freshness === 'aging') tag += '（' + kn.live.ageDays + ' 天前更新）';
        lines.push('【' + g + '】' + tag);
    } else {
        lines.push('【' + g + '】');
    }

    const items = kn.retrieved || [];
    if (query && items.length) {
        lines.push('（按「' + String(query).slice(0, 40) + '」检索到 ' + items.length + ' 条最相关）');
        for (const it of items.slice(0, 8)) {
            lines.push('· ' + String(it.text || '').slice(0, 140));
        }
    } else {
        // 无查询：给骨架（规则前 8 条 + 键位 + 动作）
        for (const r of (kn.rules || []).slice(0, 8)) {
            const staleMark = r.stale ? '⚠(可能过时) ' : '';
            lines.push('· ' + staleMark + String(r.text || '').slice(0, 120));
        }
        const keyEntries = Object.entries(kn.keys || {}).filter(([, v]) => v);
        if (keyEntries.length) {
            lines.push('键位：' + keyEntries.slice(0, 10).map(([k, v]) => k + '=' + v).join(' '));
        }
        if (kn.typicalActions && kn.typicalActions.length) {
            lines.push('常用动作：' + kn.typicalActions.slice(0, 6).join(' / '));
        }
        // 经验：最近 3 条
        const recent = (kn.experience || []).slice(-3);
        if (recent.length) {
            lines.push('她自己的经验（最近的）：');
            for (const e of recent) {
                const mark = e.kind === 'success' ? '✓' : '✗';
                lines.push('  ' + mark + ' ' + String(e.ts || '').slice(5, 16) + ' ' +
                    String(e.action || '').slice(0, 60) + (e.note ? ' —— ' + String(e.note).slice(0, 80) : ''));
            }
        }
    }

    let text = lines.join('\n');
    if (text.length > PROMPT_BUDGET) text = text.slice(0, PROMPT_BUDGET) + '\n…（知识库内容超预算已截断）';
    return text;
}

module.exports = {
    getKnowledge,
    getActionReliability,
    recordExperience,
    recordFromResult,
    buildPromptText,
    loadLayers,
    flattenToDocs,
    embedTexts,
    normalizeGame,
    freshness,
    ROOT,
    CORE_BIN,
    STALE_DAYS,
};
