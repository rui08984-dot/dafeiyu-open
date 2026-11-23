// js/core/memory-usage.js —— 记忆兑现率（D5，2026-11-22）
//
// 提案原文：注入后判「用上」；90 天 0 命中降权。验收：各来源命中率可查；索引总量稳定。
//
// 这个模块只做**观测**，不改召回打分（本轮）。它回答两个以前答不出的问题：
//   ① 这轮注入了哪些记忆条目（按来源：核心/用户记忆/事实/结论/记忆库/日记/对话）
//   ② 她的回复里**真的引用**了哪几条 —— 用「关键片段命中」而不是 LLM 判断，
//      保证可解释、可复现、零额外调用。
//
// 「用上」的判定为什么保守：
//   · 从注入正文（实际进 prompt 的那段，已截断）里抽 ≥6 字的片段；
//   · 片段至少 60% 的字不是高频虚字，且不含「我觉得/我知道了」这类通用壳；
//   · 回复文本归一化（去标点/空白）后必须**原样包含**某个片段才算命中；
//   · 不做模糊匹配、不做同义判断 —— 宁可漏记，也不虚报命中率。
//
// 轮次绑定（U5，2026-11-22）：pending 记下注入时的 turnId；noteUsed 时若当前轮次
// 非空且与 pending.turnId 不同 → 整批丢弃（reason='stale-turn'，计 staleDropped），
// 避免「上一轮注入、这一轮回复」被算成命中。任一侧 turnId 为空（老调用方/无活动轮）
// 时退回原来的 10 分钟 TTL 口径。
//
// 90 天 0 命中：条目标记 decayed（只降权/标记，**不删**）。删除必须另有明确机制，
// 本模块永远不因为「没人用」删条目；只有索引总量超过 MAX_ENTRIES 时才按容量淘汰。
//
// 落盘：recordFile('记忆兑现.json')（PET_DATA_ROOT 生效），走 json-store 的原子写。
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { recordFile } = require('./records-path.js');
const jsonStore = require('./json-store.js');

/** 来源白名单：与 memory-recall 的 SRC_RANK 七类一一对应（未知来源也允许，单列）。 */
const SOURCES = Object.freeze(['核心', '用户记忆', '事实', '结论', '记忆库', '日记', '对话']);
const DECAY_DAYS = 90;
const DECAY_MS = DECAY_DAYS * 24 * 60 * 60 * 1000;
// 判「已休眠」前至少要被注入过这么多次：只注入一次、恰好没被引用，不能算无用
// （调研：GenAI Agents/MemoryBank 的衰减都要求「多次机会」；见 docs/调研-记忆评估与衰减-2026-11-22.md）
const MIN_INJECTED_FOR_DECAY = 5;
const MIN_FRAGMENT_CHARS = 6;
const MAX_FRAGMENTS = 12;
// 一轮注入的 pending 最多留 10 分钟：LLM 工具循环可能慢，但再晚的回复不该算到
// 上一轮注入头上（宁可漏记，不虚报）。
const PENDING_TTL_MS = 10 * 60 * 1000;
// 索引总量上限：只跟踪「被注入过」的条目，正常远低于这个数；上限是防异常增长，不是清理策略。
const MAX_ENTRIES = 8000;
const FILE_VERSION = 1;

// 高频虚字：片段里虚字占比过高 → 太通用，不能当「引用」证据。
const STOP_CHARS = new Set(('的了是我你他她它们这那有在和就不人都一也都很到说要去会着看好' +
  '自己没吗呢吧啊呀哦嗯把被给对从与而且但所以因为如果可能已经还是什么怎么这么那么' +
  '一个一些一下这个那个哪个哪里谁为何如何').split(''));

// 通用壳：命中这些片段不能说明「想起了具体旧事」（回复里天天有）。
const COMMON_PHRASES = Object.freeze([
  '我知道了', '我觉得', '我觉得这个', '你可以', '我不知道', '谢谢你', '没问题',
  '好的', '好吧', '怎么了', '是不是', '有没有', '这个那个', '什么时候', '为什么',
  '怎么样', '真的吗', '对吧', '然后呢', '就是说', '其实我', '但是我', '因为所以',
  '你可以试试', '我明白了', '原来如此', '这样啊', '好吧好吧',
]);

// 片段长度配额：长片段更稳，但短片段（6 字）才能扛住轻微改写。
// 每个长度取若干「均匀分布」的窗口，避免全挤在句子开头。
const LEN_QUOTA = Object.freeze({ 12: 2, 10: 2, 8: 3, 6: 5 });

const CLAUSE_SPLIT = /[\s，。！？!?；;、,.~～…—\-—()\[\]{}"'“”‘’《》<>|/\\]+/u;

/** 归一化：NFKC + 小写 + 去掉空白/标点/符号。中文匹配不需要词边界。 */
function normalizeText(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function contentCharCount(frag) {
  let n = 0;
  for (const ch of frag) if (!STOP_CHARS.has(ch)) n += 1;
  return n;
}

/** 一个窗口够不够「有信息量」：≥60% 非虚字（6 字窗口至少要 4 个实字），且不含通用壳。 */
function isDistinctive(frag) {
  if (!frag || frag.length < MIN_FRAGMENT_CHARS) return false;
  const need = Math.max(4, Math.ceil(frag.length * 0.6));
  if (contentCharCount(frag) < need) return false;
  for (const phrase of COMMON_PHRASES) {
    // 只挡「整段就是通用壳/以它开头结尾」的窗口；不然「最好的朋友」会被「好的」误杀。
    if (frag === phrase || frag.startsWith(phrase) || frag.endsWith(phrase)) return false;
  }
  return true;
}

/**
 * 从一段记忆正文里抽关键片段（≥6 字）。
 * 纯函数，导出给单测直接验证「不会把通用壳当片段」。
 * @param {string} text
 * @returns {string[]} 最多 MAX_FRAGMENTS 个片段，长的在前
 */
function extractFragments(text) {
  const clauses = String(text == null ? '' : text).split(CLAUSE_SPLIT);
  const seen = new Set();
  const out = [];
  const push = (frag) => {
    const f = String(frag || '');
    if (f.length < MIN_FRAGMENT_CHARS || seen.has(f)) return;
    seen.add(f);
    out.push(f);
  };

  for (const clause of clauses) {
    const norm = normalizeText(clause);
    if (norm.length < MIN_FRAGMENT_CHARS) continue;

    // 英文/数字整词（专名、型号、ID）优先级最高：原样出现基本就是引用。
    for (const token of norm.match(/[a-z0-9]{6,}/g) || []) {
      push(token.slice(0, 24));
    }

    for (const run of norm.match(/[\u4e00-\u9fa5]{6,}/g) || []) {
      for (const len of [12, 10, 8, 6]) {
        if (run.length < len) continue;
        const quota = LEN_QUOTA[len] || 2;
        const windows = [];
        for (let i = 0; i + len <= run.length; i += 1) {
          const frag = run.slice(i, i + len);
          if (isDistinctive(frag)) windows.push(frag);
        }
        if (!windows.length) continue;
        const take = Math.min(quota, windows.length);
        for (let k = 0; k < take; k += 1) {
          // 均匀取样：take=1 取第一个；否则覆盖首/中/尾
          const idx = take === 1 ? 0 : Math.round(k * (windows.length - 1) / (take - 1));
          push(windows[idx]);
        }
      }
    }
  }

  // 长片段在前：匹配时优先用更具体的证据（返回值也按这个顺序给日志看）。
  return out
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_FRAGMENTS);
}

/** 稳定 id：同一来源/角色/时间戳/正文 → 同一 id（跨进程、跨重启都对得上）。 */
function idFor(entry = {}) {
  const src = entry.src || entry.source || '?';
  const role = entry.role || '?';
  const t = Number(entry.t) || 0;
  const norm = normalizeText(entry.text || '');
  return crypto.createHash('sha1')
    .update(src + '|' + role + '|' + t + '|' + norm)
    .digest('hex')
    .slice(0, 16);
}

function emptyBucket() {
  // unused = 「注入 ≥5 次但从没被引用」的条目数（诊断用，**不参与降权**）：
  // 它和 decayed 的区别是「还没休眠」——只是从没被原样引用过。
  return { injected: 0, used: 0, rate: 0, ratePct: 0, decayed: 0, unused: 0, entries: 0 };
}

function finalizeBucket(b) {
  b.rate = b.injected > 0 ? Math.round((b.used / b.injected) * 10000) / 10000 : 0;
  b.ratePct = Math.round(b.rate * 1000) / 10;
  return b;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 90 天 0 命中：从「下次该被用上的机会」起算 —— 口径见下。
 *
 * 2026-11-22 调研修正（docs/调研-记忆评估与衰减-2026-11-22.md）：
 *   原实现锚点是 `firstAt`（**首次注入**）且不要求注入次数，于是
 *   「每天都在被注入、只是没被原样引用」的记忆会在第 91 天被标成无用 ——
 *   一旦把 weightOf 接进召回，就会静默降权**召回自己认为相关**的条目。
 *
 * 现在两条门槛都补上：
 *   ① 锚点 = `lastInjectedAt`（最后一次注入）→ 一直在注入就永远不会被判死；
 *   ② 注入次数 ≥ MIN_INJECTED_FOR_DECAY（5）→ 「只注入过一次、恰好没被引用」不判死。
 * 也就是说 decayed 现在的语义是：**反复注入过（≥5 次）、从未被引用、且已经 90 天没再被注入**。
 * 「反复注入但从未被引用」另给一个 `unused` 诊断计数（不降权），供人工审阅与将来调参。
 */
function isDecayed(entry, now) {
  const injected = Number(entry && entry.injected) || 0;
  if (injected < MIN_INJECTED_FOR_DECAY) return false;
  const used = Number(entry && entry.used) || 0;
  if (used > 0) return false;                                  // 用过就不是「0 命中」
  const anchor = Number(entry.lastInjectedAt) || Number(entry.firstAt) || 0;
  if (!anchor) return false;
  return now - anchor >= DECAY_MS;
}

/** 「反复注入但从没被引用」——只用于诊断，不参与降权。 */
function isUnused(entry) {
  const injected = Number(entry && entry.injected) || 0;
  const used = Number(entry && entry.used) || 0;
  return injected >= MIN_INJECTED_FOR_DECAY && used === 0;
}

function blankEntry(id, src, role) {
  return {
    id,
    src: String(src || '未知'),
    role: String(role || ''),
    preview: '',
    fragments: [],
    injected: 0,
    used: 0,
    firstAt: 0,
    lastInjectedAt: 0,
    lastUsedAt: 0,
    decayed: false,
    batch: '',
    usedBatch: '',
  };
}

function normalizeLoadedEntry(raw, id) {
  if (!raw || typeof raw !== 'object') return null;
  const e = blankEntry(String(raw.id || id || ''), raw.src, raw.role);
  if (!e.id) return null;
  e.preview = String(raw.preview || '');
  e.fragments = Array.isArray(raw.fragments)
    ? raw.fragments.map((f) => String(f || '')).filter((f) => f.length >= MIN_FRAGMENT_CHARS).slice(0, MAX_FRAGMENTS)
    : [];
  e.injected = Math.max(0, Math.floor(num(raw.injected, 0)));
  e.used = Math.max(0, Math.floor(num(raw.used, 0)));
  e.firstAt = Math.max(0, num(raw.firstAt, 0));
  e.lastInjectedAt = Math.max(0, num(raw.lastInjectedAt, 0));
  e.lastUsedAt = Math.max(0, num(raw.lastUsedAt, 0));
  e.decayed = raw.decayed === true;
  e.batch = String(raw.batch || '');
  e.usedBatch = String(raw.usedBatch || '');
  return e;
}

function loadData(file, now) {
  const raw = jsonStore.readJson(file, null);
  if (!raw || typeof raw !== 'object' || !raw.entries || typeof raw.entries !== 'object') {
    return { version: FILE_VERSION, entries: Object.create(null), createdAt: now, updatedAt: 0 };
  }
  const data = {
    version: FILE_VERSION,
    entries: Object.create(null),
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, 0),
  };
  for (const [id, entry] of Object.entries(raw.entries)) {
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
    const e = normalizeLoadedEntry(entry, id);
    if (e) data.entries[e.id] = e;
  }
  return data;
}

/**
 * 建一个独立实例（单测用；生产用模块默认单例）。
 * @param {{file?:string, now?:()=>number, maxEntries?:number, turnIdProvider?:()=>string}} [options]
 *   turnIdProvider：当前对话轮 id 的读取器（默认懒读 turn-context.currentTurnId()）。
 *   单测可注入固定值；读取失败一律当空串（= 无法判断轮次，退回 TTL 口径）。
 */
function createMemoryUsage(options = {}) {
  const file = options.file || recordFile('记忆兑现.json');
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxEntries = Math.max(1, Math.floor(num(options.maxEntries, MAX_ENTRIES)));
  const turnIdProvider = typeof options.turnIdProvider === 'function'
    ? options.turnIdProvider
    : () => {
        try { return String(require('./turn-context.js').currentTurnId() || ''); } catch (e) { return ''; }
      };
  let data = loadData(file, nowFn());
  let pending = null;
  let evicted = 0;
  let seq = 0;
  let lastError = '';
  // U5（2026-11-22）：pending 属于上一轮却拿到这一轮的回复 → 丢弃该批（不结算）。累计计数。
  let staleDropped = 0;

  function currentTurnIdSafe() {
    try { return String(turnIdProvider() || '').slice(0, 64); } catch (e) { return ''; }
  }

  function prune() {
    const entries = Object.values(data.entries);
    if (entries.length <= maxEntries) return;
    // 淘汰顺序：未用过的优先、最久没注入的优先；用过的最后才动。
    entries.sort((a, b) => {
      const ua = Number(a.used) > 0 ? 1 : 0;
      const ub = Number(b.used) > 0 ? 1 : 0;
      if (ua !== ub) return ua - ub;
      return (Number(a.lastInjectedAt) || 0) - (Number(b.lastInjectedAt) || 0);
    });
    const drop = entries.length - maxEntries;
    for (let i = 0; i < drop; i += 1) {
      delete data.entries[entries[i].id];
      evicted += 1;
    }
  }

  function save() {
    try {
      prune();
      data.updatedAt = nowFn();
      jsonStore.writeJson(file, data, { pretty: false });
      lastError = '';
      return true;
    } catch (e) {
      lastError = String((e && e.message) || e);
      return false;
    }
  }

  function entriesFromArgs(args = {}) {
    if (Array.isArray(args.entries)) return args.entries;
    const ids = Array.isArray(args.ids) ? args.ids : [];
    const texts = args.texts;
    return ids.map((id, i) => ({
      id: String(id),
      source: args.source || args.src,
      role: args.role,
      text: Array.isArray(texts)
        ? (texts[i] || '')
        : (texts && typeof texts === 'object' ? (texts[id] || '') : ''),
    }));
  }

  /**
   * 记这一轮注入了哪些记忆条目。
   * @param {{ids?:string[], entries?:Array<{id?:string,source?:string,src?:string,role?:string,text?:string,t?:number}>,
   *          source?:string, role?:string, texts?:string[]|Object<string,string>, at?:number,
   *          turnId?:string}} args
   *   entries 是推荐写法（能带正文片段）；只给 ids 时条目无法匹配（没有正文就没有片段）。
   *   turnId 可选：不传则读 turn-context.currentTurnId()（取不到=空串，退回时间 TTL 口径）。
   */
  function noteInjected(args = {}) {
    const at = num(args.at, nowFn());
    const list = entriesFromArgs(args);
    const batchId = String(args.batchId || ((at.toString(36)) + '-' + (++seq).toString(36)));
    // U5：把「这批注入属于哪一轮」记下来。老调用方不传且没有活动轮次 → ''，行为与以前一致。
    const turnId = (args.turnId !== undefined ? String(args.turnId || '') : currentTurnIdSafe()).slice(0, 64);
    const ids = [];
    let added = 0;

    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const text = String(item.text || '');
      const id = String(item.id || idFor(item));
      if (!id || ids.includes(id)) continue;
      let entry = data.entries[id];
      if (!entry) {
        entry = blankEntry(id, item.source || item.src, item.role);
        data.entries[id] = entry;
        added += 1;
      }
      if (text) {
        const fragments = extractFragments(text);
        if (fragments.length) entry.fragments = fragments;
        entry.preview = normalizeText(text).slice(0, 40);
      }
      if (item.source || item.src) entry.src = String(item.source || item.src);
      if (item.role) entry.role = String(item.role);
      entry.injected = (Number(entry.injected) || 0) + 1;
      if (!entry.firstAt) entry.firstAt = at;
      entry.lastInjectedAt = at;
      entry.batch = batchId;
      ids.push(id);
    }

    if (!ids.length) return { ok: true, ids: [], batchId: null, added: 0, error: null };
    pending = { ids, batchId, at, turnId };
    const ok = save();
    return { ok, ids, batchId, added, error: lastError || null };
  }

  function matchFragment(fragments, normReply) {
    const list = Array.isArray(fragments) ? fragments.slice().sort((a, b) => b.length - a.length) : [];
    for (const frag of list) {
      if (frag && normReply.includes(frag)) return frag;
    }
    return null;
  }

  /**
   * 回复完成后结算：只有回复里原样出现某条目的关键片段才算「用上」。
   * 若 pending 记着轮次 A、当前轮次非空且不是 A → 丢弃该批（reason='stale-turn'），
   * 不拿这一轮的回复去结算上一轮的注入。
   * @param {{ids?:string[], text?:string, at?:number, batchId?:string, keepPending?:boolean}} args
   */
  function noteUsed(args = {}) {
    const at = num(args.at, nowFn());
    const current = pending;
    // U5（2026-11-22）：pending 记着轮次 A，当前已是轮次 B → 这批注入不是这轮回复的上下文，
    // 整批丢弃（不结算）。两边都有值才判，空 turnId（老调用方/无活动轮）退回原 TTL 口径。
    const currentTurn = currentTurnIdSafe();
    if (current && current.turnId && currentTurn && currentTurn !== current.turnId) {
      pending = null;
      staleDropped += 1;
      return { ok: true, checked: 0, matched: [], used: 0, reason: 'stale-turn', staleDropped };
    }
    const explicitIds = Array.isArray(args.ids) && args.ids.length
      ? [...new Set(args.ids.map((id) => String(id)))]
      : null;
    const ids = explicitIds || (current ? current.ids.slice() : []);
    const batchId = String(args.batchId || (current && current.batchId) || '');
    const text = String(args.text == null ? '' : args.text);

    if (!ids.length) return { ok: true, checked: 0, matched: [], used: 0, reason: 'no-ids' };
    if (current && at - Number(current.at || 0) > PENDING_TTL_MS) {
      pending = null;
      return { ok: true, checked: 0, matched: [], used: 0, reason: 'stale-pending' };
    }
    if (!text.trim()) {
      if (args.keepPending !== true) pending = null;
      return { ok: true, checked: ids.length, matched: [], used: 0, reason: 'empty-text' };
    }

    const normReply = normalizeText(text);
    const matched = [];
    for (const id of ids) {
      const entry = data.entries[id];
      if (!entry) continue;
      // 迟到的回复不能算到下一轮注入头上；同一轮重复调用不能重复计数。
      if (batchId && entry.batch && entry.batch !== batchId) continue;
      if (batchId && entry.usedBatch === batchId) continue;
      const fragment = matchFragment(entry.fragments, normReply);
      if (!fragment) continue;
      entry.used = (Number(entry.used) || 0) + 1;
      entry.lastUsedAt = at;
      entry.decayed = false;
      entry.usedBatch = batchId || entry.batch || '';
      matched.push({ id, source: entry.src, fragment });
    }

    if (args.keepPending !== true) pending = null;
    if (matched.length) save();
    return {
      ok: !lastError,
      checked: ids.length,
      matched,
      used: matched.length,
      error: lastError || null,
    };
  }

  /** 各来源命中率（可查）。decayed = 该来源里 90 天 0 命中的条目数。 */
  function stats(args = {}) {
    const at = num(args.at, nowFn());
    // 来源名来自数据文件，用 null 原型避免 __proto__ 之类的键污染全局对象。
    const bySource = Object.create(null);
    for (const source of SOURCES) bySource[source] = emptyBucket();
    const total = emptyBucket();
    let lastInjectedAt = 0;

    for (const entry of Object.values(data.entries)) {
      if (!entry || !entry.id) continue;
      const source = String(entry.src || '未知');
      if (!bySource[source]) bySource[source] = emptyBucket();
      const decayed = isDecayed(entry, at);
      const unused = isUnused(entry);
      for (const bucket of [total, bySource[source]]) {
        bucket.injected += Number(entry.injected) || 0;
        bucket.used += Number(entry.used) || 0;
        bucket.entries += 1;
        if (decayed) bucket.decayed += 1;
        if (unused) bucket.unused += 1;
      }
      if ((Number(entry.lastInjectedAt) || 0) > lastInjectedAt) lastInjectedAt = Number(entry.lastInjectedAt);
    }

    finalizeBucket(total);
    for (const bucket of Object.values(bySource)) finalizeBucket(bucket);

    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch (e) { /* 还没写过 */ }

    return {
      at,
      total,
      bySource,
      // U5：跨轮丢弃的 pending 批次数（观测用：>0 说明有轮次错位，或上一轮异常没结算）
      staleDropped,
      index: {
        entries: Object.keys(data.entries).length,
        maxEntries,
        evicted,
        bytes,
        file,
        version: FILE_VERSION,
      },
      decayDays: DECAY_DAYS,
      lastInjectedAt,
      lastError: lastError || null,
    };
  }

  /** 未来消费方可以拿这个乘召回分数：decayed 条目降权到 0.5（本轮不改打分）。 */
  function weightOf(id, args = {}) {
    const entry = data.entries[String(id || '')];
    if (!entry) return 0;
    return isDecayed(entry, num(args.at, nowFn())) ? 0.5 : 1;
  }

  function reload() {
    data = loadData(file, nowFn());
    pending = null;
    return stats();
  }

  return {
    file,
    noteInjected,
    noteUsed,
    stats,
    weightOf,
    reload,
    isDecayed: (id, args = {}) => {
      const entry = data.entries[String(id || '')];
      return Boolean(entry) && isDecayed(entry, num(args.at, nowFn()));
    },
    pendingIds: () => (pending ? pending.ids.slice() : []),
    pendingBatch: () => (pending ? pending.batchId : ''),
    entry: (id) => {
      const e = data.entries[String(id || '')];
      return e ? JSON.parse(JSON.stringify(e)) : null;
    },
  };
}

// 生产单例：memory-recall 注入时写、llm-handler 回复后结算。
const defaultUsage = createMemoryUsage();

module.exports = {
  SOURCES,
  DECAY_DAYS,
  MIN_FRAGMENT_CHARS,
  MAX_FRAGMENTS,
  MAX_ENTRIES,
  PENDING_TTL_MS,
  normalizeText,
  extractFragments,
  idFor,
  isDecayed,
  isUnused,
  MIN_INJECTED_FOR_DECAY,
  createMemoryUsage,
  file: defaultUsage.file,
  noteInjected: (...args) => defaultUsage.noteInjected(...args),
  noteUsed: (...args) => defaultUsage.noteUsed(...args),
  stats: (...args) => defaultUsage.stats(...args),
  weightOf: (...args) => defaultUsage.weightOf(...args),
  reload: (...args) => defaultUsage.reload(...args),
  pendingIds: (...args) => defaultUsage.pendingIds(...args),
  entry: (...args) => defaultUsage.entry(...args),
  _default: defaultUsage,
};

// 人读入口：node js/core/memory-usage.js → 打印各来源注入/命中/命中率/decayed。
// 生产进程 require 本模块时 require.main !== module，不会触发。
if (require.main === module) {
  console.log(JSON.stringify(defaultUsage.stats(), null, 2));
}
