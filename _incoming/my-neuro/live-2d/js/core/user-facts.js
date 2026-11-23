/**
 * user-facts.js —— 用户事实层（含有效期与「新事实压掉旧事实」，2026-11-15 五十九轮）
 *
 * 为什么要有这一层：调研结论里最痛的一条不是「找不到」，而是**找到了两条互相矛盾的旧事，
 * 模型不知道哪条还算数**（换猫名、换工作、搬家这类）。原来的记忆全是 append-only，
 * 「我家猫叫布丁」和「我家猫叫咪咪」会同时被注入，她只能二选一瞎猜。
 *
 * 抄的是 Zep/Graphiti 的双时态思路（valid_at / invalid_at），但**不装图库**：
 * 一个人在单机上，几十条事实，一个 JSON 文件 + 原子写就够。
 *
 * 规则（2026-11-15 实测校准过一次，别改回去）：
 *   · 纯规则只处理**几乎一字不差**（jaccard ≥0.75 或公共前缀 ≥70%）的情况
 *   · 其余（换猫名、搬家、换工作这类「同一件事换了取值」）交给**一次很小的 LLM 裁决**
 *     （memory-recall 的 _adjudicateFact；只在候选重叠时才调用，很稀）。
 *     为什么必须用 LLM：字符层面分不开「猫换名」（jaccard 0.43）和「两件不相干的偏好」（前缀 6 字）。
 *   · 被取代的事实打上 valid_to=now、superseded_by=新 id，**不删除**（历史可查、可回滚）
 *   · 只有 valid_to 为空的事实才是「现在成立」的，才允许自动注入
 *
 * 刻意不做：不建图、不做多跳推理、不在这一层做抽取（抽取属于 memory-evolve 的事）。
 * 已知边界：裁决失败或离线时**保守不压**——宁可两条并存，也不误删用户的事实。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { recordFile } = require('./records-path.js');
const evidence = require('./memory-evidence.js');

const FILE = '用户事实.json';
const SIM_THRESHOLD = 0.55;   // bigram Jaccard
const HEAD_MIN = 4;           // 同模板判定的头部最少字数

function file() {
    return recordFile(FILE);
}

function bigrams(s) {
    const t = String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
    const out = new Set();
    if (t.length === 1) { out.add(t); return out; }
    for (let i = 0; i + 2 <= t.length; i += 1) out.add(t.slice(i, i + 2));
    return out;
}

function jaccard(a, b) {
    const A = bigrams(a);
    const B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter += 1;
    return inter / (A.size + B.size - inter);
}

/** 去掉尾部 N 个字剩下的「头部」：用来识别同模板（"我家猫叫X"） */
function headOf(s, drop) {
    const t = String(s || '').replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '');
    const n = Math.max(0, t.length - (drop || 4));
    return n >= HEAD_MIN ? t.slice(0, n) : '';
}

function load() {
    try {
        const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
        const arr = Array.isArray(j) ? j : (j && Array.isArray(j.facts) ? j.facts : []);
        return arr.filter((f) => f && typeof f.fact === 'string' && f.fact.trim());
    } catch (e) {
        return [];
    }
}

function save(facts) {
    const p = file();
    const tmp = p + '.tmp';
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updated_at: Date.now(), facts }, null, 2), 'utf8');
    fs.renameSync(tmp, p);
}

function commonPrefixLen(a, b) {
    const x = String(a || '');
    const y = String(b || '');
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
    return i;
}

/**
 * 只有「几乎一字不差」才由纯规则判成同一件事：
 *   · jaccard ≥ 0.75，或
 *   · 公共前缀 ≥ 6 且覆盖较长串 70%，或
 *   · **包含型**：短的那句的 bigram 全部出现在长句里且共享 ≥3 个
 *     （「我家猫叫咪咪」vs「我家那只猫叫咪咪」——差了修饰词，还是同一件事）
 * 为什么把阈值卡这么高：实测「我家猫叫咪咪 vs 我家猫叫布丁」的 bigram jaccard 只有 0.43，
 * 而「我记得你不吃香菜 vs 我记得你不吃辣」前缀却有 6 个字 —— 两组在纯字符层面无法区分
 * 「同一件事换了取值」和「两件不同的事」。**语义判断交给一次很小的 LLM 裁决**
 * （见 memory-recall 的 _adjudicateFact，只在候选重叠时调用，很稀）。
 */
function shouldSupersede(newText, oldText) {
    if (!newText || !oldText) return false;
    const n = String(newText).trim();
    const o = String(oldText).trim();
    if (!n || !o) return false;
    if (n === o) return true;
    if (jaccard(n, o) >= 0.75) return true;
    const cp = commonPrefixLen(n, o);
    const longest = Math.max(n.length, o.length);
    if (cp >= 6 && cp >= longest * 0.7) return true;
    // 包含型：短串的 bigram 全在长串里
    const A = bigrams(n);
    const B = bigrams(o);
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    if (small.size >= 3) {
        let shared = 0;
        for (const x of small) if (big.has(x)) shared += 1;
        if (shared === small.size) return true;
    }
    return false;
}

/** 是否值得送去 LLM 裁决（完全不沾边的不必浪费一次调用） */
function shouldConsider(newText, oldText) {
    const n = String(newText || '').trim();
    const o = String(oldText || '').trim();
    if (!n || !o) return false;
    if (jaccard(n, o) >= 0.3) return true;
    return commonPrefixLen(n, o) >= 3;
}

/**
 * 写入一条事实。返回 { ok, id, duplicate, superseded: [id...] }
 * duplicate=true 表示和某条**有效**事实几乎一字不差（不重复写）。
 */
function addFact(input) {
    const o = input || {};
    const text = String(o.text || '').trim();
    if (!text) return { ok: false, error: '空事实' };
    if (text.length > 200) return { ok: false, error: '事实太长（>200 字），应该拆成具体条目' };
    const now = Number(o.now) || Date.now();
    const facts = load();
    const superseded = [];
    let duplicate = false;
    // 显式指定要压掉哪些（LLM 裁决后由调用方传入）；不传时走纯规则的「几乎一字不差」
    const forceIds = Array.isArray(o.supersedeIds) ? o.supersedeIds : [];

    for (const f of facts) {
        if (f.valid_to) continue;            // 已经失效的不再参与判定
        if (String(f.fact).trim() === text) { duplicate = true; continue; }
        if (!forceIds.includes(f.id) && !shouldSupersede(text, f.fact)) continue;
        f.valid_to = now;
        f.invalid_reason = '被新事实取代';
        superseded.push(f.id);
    }

    if (duplicate) {
        save(facts);
        return { ok: true, duplicate: true, id: null, superseded };
    }

    const id = 'f' + now.toString(36) + Math.random().toString(36).slice(2, 6);
    facts.push({
        id,
        fact: text,
        valid_from: now,
        valid_to: null,
        supersedes: superseded,
        source: String(o.source || 'manual'),
        confidence: Number.isFinite(Number(o.confidence)) ? Number(o.confidence) : 0.8,
        // 可选字段（2026-11-22）：证据分双时钟的初始状态。旧数据没有它也照常工作
        // （evidenceOf 会用 valid_from 补一个等价默认值），所以这不是 schema 变更。
        evidence: evidence.initialEvidence(now),
    });
    for (const f of facts) {
        if (superseded.includes(f.id)) f.superseded_by = id;
    }
    save(facts);
    return { ok: true, duplicate: false, id, superseded };
}

/**
 * 取一条事实的证据对象（只读规范化，返回新对象）。
 * 旧数据没有 evidence 字段：用 valid_from 当 rAt，让它按正常速度衰老；
 * 没有 valid_from 就是 0（分数函数把 0 当「刚写入」，不当无限老）。
 */
function evidenceOf(fact) {
    const f = fact && typeof fact === 'object' ? fact : {};
    const e = f.evidence && typeof f.evidence === 'object' ? f.evidence : null;
    if (e) {
        return {
            r: Number.isFinite(Number(e.r)) ? Number(e.r) : evidence.DEFAULTS.INITIAL_R,
            rAt: Number.isFinite(Number(e.rAt)) ? Number(e.rAt) : 0,
            d: Number.isFinite(Number(e.d)) ? Number(e.d) : 0,
            dAt: Number.isFinite(Number(e.dAt)) ? Number(e.dAt) : 0,
            protected: e.protected === true,
        };
    }
    return {
        r: evidence.DEFAULTS.INITIAL_R,
        rAt: Number.isFinite(Number(f.valid_from)) ? Number(f.valid_from) : 0,
        d: 0,
        dAt: 0,
        protected: false,
    };
}

/**
 * 记一次证据事件（confirm / deny / ignore / newFact），原子写回。
 * factIdOrFact：事实 id 优先；也接受 fact 文本（精确匹配）或事实对象。
 * 找不到返回 { ok:false, reason:'not_found' } —— 绝不顺手新建事实。
 */
function noteEvidence(factIdOrFact, type, opts) {
    const o = opts || {};
    const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
    const isObj = factIdOrFact && typeof factIdOrFact === 'object';
    const asId = isObj ? String(factIdOrFact.id || '') : String(factIdOrFact || '');
    const asText = isObj ? String(factIdOrFact.fact || '') : String(factIdOrFact || '');
    if (!asId && !asText) return { ok: false, reason: 'not_found' };

    const facts = load();
    let idx = -1;
    if (asId) idx = facts.findIndex((f) => f && String(f.id) === asId);
    if (idx < 0 && asText) idx = facts.findIndex((f) => f && String(f.fact).trim() === asText.trim());
    // 字符串入参：id 查不到时，同一串也允许按 fact 文本精确匹配
    if (idx < 0 && asId) idx = facts.findIndex((f) => f && String(f.fact).trim() === asId.trim());
    if (idx < 0) return { ok: false, reason: 'not_found' };

    const f = facts[idx];
    const next = evidence.applyEvent(evidenceOf(f), { type, at: now });
    facts[idx] = { ...f, evidence: next };
    save(facts);                      // 与 addFact 共用原子写（tmp + rename）
    const s = evidence.score(next, now);
    return { ok: true, id: f.id, fact: f.fact, type, evidence: next, score: s, tier: evidence.tier(s) };
}

/** 现在成立的事实（valid_to 为空）。返回项**追加**只读 evidenceScore，原有字段不变。 */
function activeFacts() {
    const now = Date.now();
    return load()
        .filter((f) => !f.valid_to)
        .map((f) => ({ ...f, evidenceScore: evidence.score(evidenceOf(f), now) }));
}

/**
 * 按 bigram 相似度检索事实。includeExpired=true 时把失效的也带出来，
 * 并明确标 expired + 有效期 —— 「布丁」应该能被查到，但必须看得出它已经不是现在的答案。
 */
function searchFacts(query, opts) {
    const o = opts || {};
    const limit = Math.max(1, Math.min(20, Number(o.limit) || 5));
    const q = String(query || '').trim();
    // 单字查询（「猫」）在 bigram 层面永远是 0 命中 —— 用一个包含判定兜底，
    // 否则「以前那只猫叫什么」这种最自然的问法什么也查不到。
    const qSingle = q.replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '');
    const isSingle = qSingle.length === 1;
    const all = load();
    const rows = [];
    for (const f of all) {
        if (f.valid_to && !o.includeExpired) continue;
        let sim = q ? jaccard(q, f.fact) : 1;
        if (q && sim <= 0 && isSingle && String(f.fact).includes(qSingle)) sim = 0.5;
        // 完全无关的事实（相似度 0）在「带出历史」模式下也只在有查询时过滤
        if (q && sim <= 0) continue;
        rows.push({
            id: f.id,
            fact: f.fact,
            sim: +sim.toFixed(3),
            valid_from: f.valid_from || null,
            valid_to: f.valid_to || null,
            expired: !!f.valid_to,
            superseded_by: f.superseded_by || null,
        });
    }
    rows.sort((a, b) => (Number(a.expired) - Number(b.expired)) || b.sim - a.sim);
    return rows.slice(0, limit);
}

module.exports = {
    addFact, activeFacts, searchFacts, load, file,
    // 证据分（2026-11-22）：可选字段，读侧永远有默认值，旧数据无需迁移
    evidenceOf, noteEvidence,
    // 纯函数导出给测试
    _jaccard: jaccard, _shouldSupersede: shouldSupersede, _shouldConsider: shouldConsider,
    _headOf: headOf, _commonPrefixLen: commonPrefixLen,
};
