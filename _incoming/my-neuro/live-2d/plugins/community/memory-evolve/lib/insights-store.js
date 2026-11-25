// plugins/community/memory-evolve/lib/insights-store.js —— insights / 游标的落盘层
//
// 依据：docs/框架设计-四块落地-2026-11-20.md §5
//   · data/insights.jsonl：一行一条 insight；无重复时只 append，命中保守重复判据时
//     整文件原子重写（occurrences 累加，见 mergeOrAppendInsights）
//   · data/insights-cursor.json：{lastEpisodeLine, lastEpisodeId, lastRunAt, runsToday, day, lastError,
//     reflectRemain, reflectPending}
//     —— 后两个是「反思触发累计」的持久化（2026-11-24 审计 §9.3-③）：重启不再清零。
//   · 游标不前进 ≠ 数据丢失：失败时 lastEpisodeLine 不动，下次重试
//
// 为什么游标按 **episode 行号**：
//   调研 §2.2 指出「今天没有可指向的稳定 id」。episodes.jsonl 是 append-only，
//   物理行号 + 卡片 at 能组成稳定坐标（`ep:<line>:<at>`）；卡片自带的事实再派生
//   `ep:<line>:<at>#f<n>`。这样反思的每条 evidence 都能点回原记录，而不是 LLM 编的编号。
//
// 原子写：
//   · 游标走 json-store.writeJson（tmp + rename）
//   · insights 走 appendFileSync（json-store 注释明确：追加不存在半截覆盖问题，坏行由 readJsonl 跳过）
'use strict';

const fs = require('fs');
const path = require('path');
const jsonStore = require('../../../../js/core/json-store.js');

const INSIGHTS_FILE = 'insights.jsonl';
const CURSOR_FILE = 'insights-cursor.json';
const EPISODES_FILE = 'episodes.jsonl';

function insightsPath(dir) { return path.join(String(dir), INSIGHTS_FILE); }
function cursorPath(dir) { return path.join(String(dir), CURSOR_FILE); }
function episodesPath(dir) { return path.join(String(dir), EPISODES_FILE); }

function clampInt(n, lo, hi, fallback) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, Math.floor(v)));
}

/** 可缺省整数：缺失/非法 → null（区分「没存过」与「存了 0」）。 */
function optionalInt(n, lo, hi) {
    // 注意先挡 null/undefined/空串：Number(null) === 0 会被夹成 1，
    // 旧版游标（没有该字段）就会被误读成「remain=1，马上要反思」。
    if (n === null || n === undefined || n === '') return null;
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    return Math.min(hi, Math.max(lo, Math.floor(v)));
}

/** 本地日期 YYYY-MM-DD（不要用 toISOString：UTC 会把凌晨算到前一天） */
function todayStr(ts) {
    const d = new Date(Number.isFinite(Number(ts)) ? Number(ts) : Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function emptyCursor() {
    return {
        lastEpisodeLine: 0,
        lastEpisodeId: null,
        lastRunAt: 0,
        runsToday: 0,
        day: '',
        lastError: null,
        // 反思触发持久化（2026-11-24 审计 §9.3-③）：这两个字段与片段游标同文件存放，
        // 但语义独立 —— 重启后接着累减，而不是每次 onInit 重置成阈值。
        reflectRemain: null,
        reflectPending: null,
    };
}

/** 读出来的游标可能缺字段/类型不对（手工修过、旧版本）；这里一次性兜平。 */
function normalizeCursor(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    return {
        lastEpisodeLine: clampInt(c.lastEpisodeLine, 0, Number.MAX_SAFE_INTEGER, 0),
        lastEpisodeId: typeof c.lastEpisodeId === 'string' ? c.lastEpisodeId : null,
        lastRunAt: Number.isFinite(Number(c.lastRunAt)) ? Number(c.lastRunAt) : 0,
        runsToday: clampInt(c.runsToday, 0, 1000, 0),
        day: typeof c.day === 'string' ? c.day : '',
        lastError: typeof c.lastError === 'string' ? c.lastError : null,
        // null = 旧版游标没这两个字段（调用方保留自己的默认值，不要把 0 当「已耗尽」）
        reflectRemain: optionalInt(c.reflectRemain, 1, 100000),
        reflectPending: typeof c.reflectPending === 'boolean' ? c.reflectPending : null,
    };
}

function loadCursor(dir) {
    // 游标坏了不能当 0：那会让同一批片段被重新反思、重复 append。
    // json-store 会把坏文件隔离并拒绝写回；这里直接抛错，让调用方发声并停止本轮。
    if (jsonStore.isQuarantined(cursorPath(dir))) {
        throw new Error('游标文件已损坏并被隔离：' + cursorPath(dir));
    }
    return normalizeCursor(jsonStore.readJson(cursorPath(dir), null));
}

function saveCursor(dir, cursor) {
    const c = normalizeCursor(cursor);
    jsonStore.writeJson(cursorPath(dir), Object.assign({}, c, { updated_at: Date.now() }));
    return c;
}

/** 跨天清零：不是「今天」就把 runsToday 归零。返回新对象，不改入参。 */
function rollDay(cursor, today) {
    const c = normalizeCursor(cursor);
    const day = String(today || todayStr(Date.now()));
    if (c.day !== day) {
        c.day = day;
        c.runsToday = 0;
    }
    return c;
}

function canRun(cursor, cap) {
    const c = normalizeCursor(cursor);
    const limit = clampInt(cap, 1, 100, 4);
    return c.runsToday < limit;
}

function loadInsights(dir) {
    return jsonStore.readJsonl(insightsPath(dir), []);
}

/** 最近 N 条仍然有效的结论（stale/superseded 不再作为「已有结论」喂给 LLM）。 */
function loadRecentInsights(dir, limit) {
    const n = clampInt(limit, 1, 50, 5);
    const all = loadInsights(dir).filter((x) => x && typeof x.text === 'string' &&
        x.status !== 'stale' && x.status !== 'superseded');
    return all.slice(-n);
}

/** 追加 insight；返回写入条数。任何一行写失败都抛错，让调用方别推进游标。 */
function appendInsights(dir, rows) {
    if (!Array.isArray(rows) || !rows.length) return 0;
    const p = insightsPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let n = 0;
    for (const row of rows) {
        fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
        n += 1;
    }
    return n;
}

// ── 保守去重合并（2026-11-22）────────────────────────────────────────────
//
// 调研结论：相似度不能单独当合并判据 ——「主人养了一只猫」与「主人养了一只狗」
// 文本相似度就不低，但必须并存。所以只做**确定性合并**，三条同时满足才算同一条：
//   ① 归一化文本（去空白+中英标点、统一小写）完全相等，或 bigram Dice ≥ 0.90；
//   ② 两边 focal_point 都非空且相同（一方为空 → 不合并）；
//   ③ 两边 keywords 都非空且 Jaccard ≥ 0.60（一方为空 → 不合并）。
// 不做 LLM merge/replace/keep_both：那需要额外 LLM 预算，本轮暂缓。
//
// 读盘不走 loadInsights：整文件重写时必须把**坏行原样写回**（readJsonl 会跳过丢行），
// 所以这里按物理行读，好行留 obj+raw、坏行/空行只留 raw。未合并的好行也写回原 raw，
// 只有真正合并过的行才重新序列化 —— 尽量不动别人的字节。
const MERGE_MAX_KEYWORDS = 5;        // 与 lib/reflect.js 的 MAX_KEYWORDS 对齐
const MERGE_MAX_EVIDENCE = 40;
const MERGE_SCAN_LIMIT = 500;        // 候选只看最近 500 条有效 insight，避免大文件每次全比
const MERGE_DICE_MIN = 0.90;
const MERGE_JACCARD_MIN = 0.6;
let _mergeTmpSeq = 0;

/** 归一化：NFKC + 去空白/中英标点符号 + 小写（只用于判重，绝不写回文件）。 */
function normalizeInsightText(s) {
    return String(s == null ? '' : s)
        .normalize('NFKC')
        .replace(/[\s\p{P}\p{S}]+/gu, '')
        .toLowerCase();
}

/** bigram 多重集 Dice；任一侧不足 2 个字符返回 0（完全相等由调用方先判）。 */
function bigramDice(a, b) {
    const ca = Array.from(a);
    const cb = Array.from(b);
    if (ca.length < 2 || cb.length < 2) return 0;
    const counts = new Map();
    for (let i = 0; i < ca.length - 1; i += 1) {
        const g = ca[i] + ca[i + 1];
        counts.set(g, (counts.get(g) || 0) + 1);
    }
    let inter = 0;
    for (let i = 0; i < cb.length - 1; i += 1) {
        const g = cb[i] + cb[i + 1];
        const n = counts.get(g) || 0;
        if (n > 0) { inter += 1; counts.set(g, n - 1); }
    }
    return (2 * inter) / (ca.length - 1 + cb.length - 1);
}

function keywordSet(v) {
    if (!Array.isArray(v)) return new Set();
    const out = new Set();
    for (const k of v) {
        const n = normalizeInsightText(k);
        if (n) out.add(n);
    }
    return out;
}

function setJaccard(aSet, bSet) {
    if (!aSet.size || !bSet.size) return 0;
    let inter = 0;
    for (const x of aSet) if (bSet.has(x)) inter += 1;
    return inter / (aSet.size + bSet.size - inter);
}

/**
 * 两条 insight 是否应视为同一条（保守判据，三条同时满足）。
 * a = 已有记录，b = 新产出。纯函数，单测直接打。
 */
function isSameInsight(a, b) {
    if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return false;
    const ta = typeof a.text === 'string' ? a.text : '';
    const tb = typeof b.text === 'string' ? b.text : '';
    if (!ta.trim() || !tb.trim()) return false;

    const na = normalizeInsightText(ta);
    const nb = normalizeInsightText(tb);
    if (!na || !nb) return false;
    if (na !== nb && bigramDice(na, nb) < MERGE_DICE_MIN) return false;

    const fa = typeof a.focal_point === 'string' ? a.focal_point.trim() : '';
    const fb = typeof b.focal_point === 'string' ? b.focal_point.trim() : '';
    if (!fa || !fb || fa !== fb) return false;

    const ka = keywordSet(a.keywords);
    const kb = keywordSet(b.keywords);
    if (!ka.size || !kb.size) return false;
    return setJaccard(ka, kb) >= MERGE_JACCARD_MIN;
}

function isBlankField(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') return !v.trim();
    if (Array.isArray(v)) return v.length === 0;
    return false;
}

/** 按顺序取并集（旧的在前、新的在后），去重、去空、截上限。 */
function unionStrings(oldVal, newVal, limit) {
    const out = [];
    const seen = new Set();
    const parts = [].concat(Array.isArray(oldVal) ? oldVal : [], Array.isArray(newVal) ? newVal : []);
    for (const v of parts) {
        if (typeof v !== 'string') continue;
        const t = v.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * 合并一条：保留旧 id/created_at；occurrences+1；evidences/keywords 取并集；
 * importance 取 max；其余字段保留旧值（旧值为空才用新值兜）。
 */
function mergeInsightRow(oldRow, newRow, now) {
    const merged = Object.assign({}, oldRow);
    const oldOcc = Number(oldRow.occurrences);
    merged.occurrences = (Number.isFinite(oldOcc) && oldOcc >= 1 ? Math.floor(oldOcc) : 1) + 1;

    const evidenceIds = unionStrings(oldRow.evidence_ids, newRow.evidence_ids, MERGE_MAX_EVIDENCE);
    if (evidenceIds.length) merged.evidence_ids = evidenceIds;

    const oi = Number(oldRow.importance);
    const ni = Number(newRow.importance);
    const a = Number.isFinite(oi) ? oi : null;
    const b = Number.isFinite(ni) ? ni : null;
    if (a != null || b != null) merged.importance = Math.max(a == null ? b : a, b == null ? a : b);

    const keywords = unionStrings(oldRow.keywords, newRow.keywords, MERGE_MAX_KEYWORDS);
    if (keywords.length) merged.keywords = keywords;

    merged.updated_at = now;

    // 其余字段（text/depth/confidence/status/model/...）：旧值非空就保旧值。
    const handled = new Set(['id', 'created_at', 'occurrences', 'evidence_ids', 'importance', 'keywords', 'updated_at']);
    for (const k of Object.keys(newRow)) {
        if (handled.has(k)) continue;
        if (isBlankField(merged[k])) merged[k] = newRow[k];
    }
    return merged;
}

/** 按物理行读：好行 {kind:'good',obj,raw}，坏行/空行 {kind:'raw',raw}；文件不存在 = []。 */
function _readRawRecords(filePath) {
    let text = '';
    try { text = fs.readFileSync(filePath, 'utf8'); } catch (e) {
        if (e && e.code === 'ENOENT') return [];
        throw e;
    }
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();  // 结尾换行不算空行
    return lines.map((line) => {
        if (!line.trim()) return { kind: 'raw', raw: line };
        try {
            const obj = JSON.parse(line);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) return { kind: 'good', obj, raw: line };
        } catch (e) { /* 坏行：原样保留 */ }
        return { kind: 'raw', raw: line };
    });
}

/**
 * 保守合并写盘：重复的累加 occurrences，其余照旧追加。
 *   有合并 → 整文件 tmp+rename 原子重写（坏行/未合并行按原 raw 写回）；
 *   无合并 → 与 appendInsights 一致的纯追加。
 * @param {string} dir
 * @param {object[]} rows 本轮新产出的 insight
 * @param {{now?:number, scanLimit?:number}} [opts]
 * @returns {{added:number, merged:number, total:number}} total = added + merged（本轮处理条数）
 */
function mergeOrAppendInsights(dir, rows, opts) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return { added: 0, merged: 0, total: 0 };
    const options = opts && typeof opts === 'object' ? opts : {};
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const scanLimit = clampInt(options.scanLimit, 1, 100000, MERGE_SCAN_LIMIT);

    const p = insightsPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const records = _readRawRecords(p);

    // 候选：最近 N 条有效记录（stale/superseded 不再吸收新结论 —— 否则新 insight
    // 会被并进一条「已作废」的行里，loadRecentInsights 又看不到，等于丢失）。
    const candidates = [];
    for (let i = records.length - 1; i >= 0 && candidates.length < scanLimit; i -= 1) {
        const rec = records[i];
        if (rec.kind !== 'good') continue;
        if (rec.obj.status === 'stale' || rec.obj.status === 'superseded') continue;
        candidates.push(rec);
    }

    const dirty = new Set();
    const fresh = [];
    let merged = 0;
    for (const row of list) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) { fresh.push(row); continue; }
        let hit = null;
        for (const rec of candidates) {
            if (isSameInsight(rec.obj, row)) { hit = rec; break; }
        }
        if (hit) {
            hit.obj = mergeInsightRow(hit.obj, row, now);
            dirty.add(hit);
            merged += 1;
        } else {
            fresh.push(row);
        }
    }

    if (merged) {
        const out = records.map((rec) => {
            if (rec.kind === 'good' && dirty.has(rec)) return JSON.stringify(rec.obj);
            return rec.raw;
        });
        for (const row of fresh) out.push(JSON.stringify(row));
        const tmp = p + '.tmp-' + process.pid + '-' + Date.now().toString(36) + '-' +
            (_mergeTmpSeq += 1) + '-' + Math.random().toString(36).slice(2, 8);
        try {
            fs.writeFileSync(tmp, out.join('\n') + '\n', 'utf8');
            fs.renameSync(tmp, p);
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
            throw e;
        }
        return { added: fresh.length, merged, total: fresh.length + merged };
    }

    for (const row of fresh) fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
    return { added: fresh.length, merged: 0, total: fresh.length };
}

/** 读 episodes.jsonl，保留**物理行号**（1-based），坏行跳过。 */
function readEpisodesWithLines(dir) {
    let raw = '';
    try { raw = fs.readFileSync(episodesPath(dir), 'utf8'); } catch (e) {
        // 文件不存在 = 还没压过卡，正常态；其它读错误必须抛给调用方发声，
        // 不能伪装成「没有新片段」——那会让反思永远静默空转。
        if (e && e.code === 'ENOENT') return [];
        throw e;
    }
    const out = [];
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (!t) continue;
        try {
            const card = JSON.parse(t);
            if (card && typeof card.summary === 'string' && card.summary.trim()) {
                out.push({ lineNo: i + 1, card });
            }
        } catch (e) { /* 坏行跳过：和 json-store.readJsonl 的容损单位一致 */ }
    }
    return out;
}

function episodeId(lineNo, card) {
    return 'ep:' + Number(lineNo) + ':' + (Number(card && card.at) || 0);
}

/**
 * 把游标后的 episode 卡切成反思输入条目。
 *   · 每张卡 = 1 条 episode 条目 + 每条 fact = 1 条 fact 条目（证据因此天然可 ≥2）
 *   · 不切半张卡：宁可少处理一张，也不让游标跨过没被读到的 fact
 *   · 最多 maxEntries 条（软上限：第一张卡永远准入，之后按整卡停）
 *
 * @returns {{entries:object[], lastLine:number, lastId:string|null, cardCount:number}}
 */
function buildEntries(cards, fromLine, maxEntries) {
    const start = clampInt(fromLine, 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = clampInt(maxEntries, 1, 200, 30);
    const entries = [];
    let lastLine = start;
    let lastId = null;
    let cardCount = 0;

    for (const row of (Array.isArray(cards) ? cards : [])) {
        if (!row || !row.card || !Number.isFinite(Number(row.lineNo))) continue;
        const lineNo = Number(row.lineNo);
        if (lineNo <= start) continue;
        const card = row.card;
        const baseId = episodeId(lineNo, card);
        const facts = Array.isArray(card.facts)
            ? card.facts.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3)
            : [];
        const head = [card.title ? String(card.title) : '', String(card.summary || '')]
            .filter(Boolean).join('：');
        const batch = [{ id: baseId, text: head, kind: 'episode', depth: 0, episodeLine: lineNo, episodeId: baseId }];
        facts.forEach((f, i) => {
            batch.push({ id: baseId + '#f' + (i + 1), text: f, kind: 'fact', depth: 0, episodeLine: lineNo, episodeId: baseId });
        });
        // 第一张卡无条件准入；之后整卡进，避免游标跨过没读到的 fact
        if (entries.length && entries.length + batch.length > limit) break;
        entries.push(...batch);
        lastLine = lineNo;
        lastId = baseId;
        cardCount += 1;
        if (entries.length >= limit) break;
    }

    return { entries, lastLine, lastId, cardCount };
}

module.exports = {
    insightsPath,
    cursorPath,
    episodesPath,
    todayStr,
    emptyCursor,
    normalizeCursor,
    loadCursor,
    saveCursor,
    rollDay,
    canRun,
    loadInsights,
    loadRecentInsights,
    appendInsights,
    isSameInsight,
    mergeOrAppendInsights,
    readEpisodesWithLines,
    buildEntries,
    episodeId,
    INSIGHTS_FILE,
    CURSOR_FILE,
    EPISODES_FILE,
};
