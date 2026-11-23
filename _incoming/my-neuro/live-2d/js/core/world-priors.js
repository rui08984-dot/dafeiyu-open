/**
 * js/core/world-priors.js — 用户纠偏先验（C1 世界可纠错）
 *
 * 为什么要有它：世界状态原来只有启发式（前台进程 + 窗口标题 + 空闲），用户说
 * 「不是，我在开会」时她没有任何通道改正，会一直错下去。这个模块存「用户明确
 * 纠正过的 应用+标题 → 活动」，world-store 判定活动时优先采用，24 小时后自动失效。
 * 唯一例外是 away（人已离开）：先验回答「他在干嘛」，压不过「他不在」这个更硬的事实，
 * 具体判据在 world-store.updateActivity 里。
 *
 * 四条设计决定：
 *
 * 1. **键是「应用 + 标题指纹」，不是具体应用名**
 *    app 小写化、去路径/扩展名；title 去掉「 - Google Chrome」「 - Notepad」这类
 *    应用名尾巴、小写、压空白、取前 40 字。换一个应用/游戏**不需要改这里一行代码**。
 *    尾巴识别只看两条通用信号：① 尾巴与应用名对得上；② 尾巴长得像应用名（标题式、
 *    无中文、无数字）。宁可少剥一点，也不把「第一章 - Part 2」这种内容尾巴吃掉。
 *
 * 2. **先验是「意图」，不是「事实」**
 *    用户说「我在开会」表达的是「这个窗口出现时，按开会理解」。所以先验带 TTL
 *    （默认 24h）：昨天的会议不该定义今天的活动。过期即失效，并且顺手从文件里清掉。
 *
 * 3. **绝不 throw 到主链**
 *    世界感知每秒都在跑，先验只是锦上添花；文件缺失/损坏/读写失败都必须降级成
 *    「没命中」，但不能静默 —— 损坏原因留在 `lastError` / `list().lastError` 里，
 *    `world` 工具的 status 会把它带给模型和人看。
 *
 * 4. **写文件必须原子**
 *    tmp + rename（同目录，同分区才是原子替换）。写到一半断电不会留下半截 JSON，
 *    下一次读不会因为半截文件把整张表当空表。损坏文件在覆盖前先改名备份
 *    （`.corrupt-<时间戳>`），用户数据不能因为「读不懂」就被静默抹掉。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { recordFile } = require('./records-path.js');

const FILE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;   // 先验默认活 24 小时
const DEFAULT_MAX_ENTRIES = 200;              // 先验不是记忆库：只留最近 200 条，防无限膨胀
const TITLE_MAX_CHARS = 40;
const NOTE_MAX_CHARS = 200;

// 活动枚举。**必须与 world-store.js 的 ACTIVITY_LABEL 键一致**（那边是渲染源）。
// 这里独立定义而不是 require world-store，是为了避免循环依赖：
// world-store 会 require 本模块。测试里有一条断言钉住两边一致。
// meeting 只可能来自用户纠正（classifyActivity 没有可靠的通用信号判「开会」）。
const ACTIVITIES = ['working', 'gaming', 'watching', 'meeting', 'idle', 'away', 'unknown'];
const ACTIVITY_SET = new Set(ACTIVITIES);

function errText(e) {
  return String((e && e.message) || e || '未知错误');
}

function hasCJK(s) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(s);
}

/** app 归一：小写、去路径、去 .exe、压空白。pet-core 本来给的是小写进程名，
 *  这里再兜一层是为了「测试/别的平台/手工调用」时键也稳定。 */
function normalizeApp(app) {
  let a = String(app == null ? '' : app).trim().toLowerCase();
  if (!a) return '';
  a = a.replace(/\\/g, '/');
  if (a.indexOf('/') >= 0) a = a.split('/').pop();
  a = a.replace(/\.exe$/i, '');
  return a.replace(/\s+/g, ' ').trim();
}

/** 尾巴和 app 是不是同一个东西（宽松匹配）。
 *  例：app=code，尾巴「Visual Studio Code」→ 命中；app=msedge，尾巴「Microsoft Edge」
 *  去掉空格后是 microsoftedge，包含 msedge → 命中。
 *  为什么不用全等：进程名和窗口尾巴经常一个是缩写、一个带厂商名。 */
function matchesApp(tail, app) {
  if (!tail || !app) return false;
  const t = String(tail).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (t === app) return true;
  const toks = t.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  const atoks = app.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  // 只认「尾巴最后一个词就是应用名」：'Visual Studio Code' → code、
  // 'Google Chrome' → chrome。任何词命中会误剥 'PR #12 - Code Review'
  // （code 是应用名，但 Code Review 是内容）。
  const lastTok = toks[toks.length - 1];
  if (lastTok && lastTok.length >= 2 && atoks.indexOf(lastTok) >= 0) return true;
  // 紧凑包含只对够长的 app 名启用：「msedge」->「microsoftedge」这种缩写对得上，
  // 而 app=word 不会因为「Password Manager」里含 word 就误剥。
  const tc = t.replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  const ac = app.replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  return ac.length >= 5 && (tc.indexOf(ac) >= 0 || ac.indexOf(tc) >= 0);
}

/** 尾巴看起来像不像应用名（通用约定，不认识任何具体应用）：
 *  标题式大小写、无中文、无数字、最多 4 个词。数字排掉是为了不误剥
 *  「第 1 集 - Part 2」/「报表 - Q3」这类内容尾巴。
 *  seps = 标题里还有几层分隔符：多词尾巴只在「A - B - C」这种多层标题里才当应用名，
 *  否则「PR #12 - Code Review」「Song - Artist」这种内容尾巴会被误剥、把不同页面
 *  合成同一个先验键。宁可少剥，也不制造错误合并。 */
function looksLikeAppTail(tail, seps) {
  const t = String(tail == null ? '' : tail).trim();
  if (!t || t.length > 32) return false;
  if (hasCJK(t)) return false;
  if (/\d/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return false;
  if (words.length > 1 && Number(seps) < 2) return false;
  return words.every((w) => /^[A-Z][A-Za-z0-9._+&'()\-]*$/.test(w));
}

/** title 归一：剥应用名尾巴 → 小写 → 取前 40 字。
 *  只剥「空白 + 分隔符 + 空白」形式（- – — |），避免把 "re-do" 这种词拆开。 */
function normalizeTitle(title, app) {
  let t = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i += 1) {
    const seps = (t.match(/\s+[-–—|]\s+/g) || []).length;
    const m = t.match(/^(.*)\s+[-–—|]\s+(.+)$/);   // 贪婪第一组 = 最后一个分隔符
    if (!m) break;
    const head = m[1].trim();
    const tail = m[2].trim();
    if (!head || !tail) break;
    if (!matchesApp(tail, app) && !looksLikeAppTail(tail, seps)) break;
    t = head;
  }
  return t.toLowerCase().slice(0, TITLE_MAX_CHARS);
}

/** 先验键。app/title 都空 → ''（调用方据此「不用先验」）。
 *  用 `::` 连接而不是嵌套结构：JSON 文件的键必须可读，且 app 里的 `::` 概率可忽略。 */
function keyOf(input) {
  const o = input || {};
  const app = normalizeApp(o.app);
  const title = normalizeTitle(o.title, app);
  if (!app && !title) return '';
  return app + '::' + title;
}

function clipNote(note) {
  const s = String(note == null ? '' : note).replace(/\s+/g, ' ').trim();
  return s.slice(0, NOTE_MAX_CHARS);
}

function emptyDoc() {
  return { version: FILE_VERSION, updatedAt: 0, priors: {} };
}

/** 文件里的一条记录 → 内存条目；不合法返回 null（坏条目只丢自己，不拖垮整表）。 */
function sanitizeEntry(raw, fallbackTtlMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const activity = String(raw.activity == null ? '' : raw.activity).trim().toLowerCase();
  if (!ACTIVITY_SET.has(activity)) return null;
  const updatedAt = Number(raw.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  const ttl = Number(raw.ttlMs);
  return {
    activity,
    note: clipNote(raw.note),
    source: 'user',
    conf: 100,
    updatedAt,
    ttlMs: ttl > 0 ? ttl : fallbackTtlMs,
  };
}

/**
 * 建一个先验实例。
 *
 * opts:
 *   file     覆盖存储路径（测试用；默认 recordFile('world-priors.json')）
 *   ttlMs    默认有效期（默认 24h）
 *   now      注入时钟（测试用）
 *   maxEntries 表容量上限（默认 200）
 */
function createWorldPriors(opts) {
  const o = opts || {};
  const nowFn = typeof o.now === 'function' ? o.now : () => Date.now();
  const defaultTtlMs = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : DEFAULT_TTL_MS;
  const maxEntries = Number(o.maxEntries) > 0 ? Number(o.maxEntries) : DEFAULT_MAX_ENTRIES;
  const file = o.file ? path.resolve(String(o.file)) : recordFile('world-priors.json');

  // mtime/size 缓存：世界感知每秒 lookup 一次，不能每秒读一次盘。
  const cache = {
    doc: emptyDoc(),
    mtime: -1,
    size: -1,
    loaded: false,
    missing: true,
    corrupt: false,
    ioError: false,
    lastError: '',
    backup: '',
  };

  function ttlOf(entry) {
    const t = Number(entry && entry.ttlMs);
    return t > 0 ? t : defaultTtlMs;
  }
  function ageOf(entry, t) {
    return Math.max(0, t - Number((entry && entry.updatedAt) || 0));
  }
  // 「到点」即失效（>=）：TTL 是承诺的有效期，边界上不该再多信一秒。
  function isExpired(entry, t) {
    return ageOf(entry, t) >= ttlOf(entry);
  }

  /** 读表（带 mtime/size 缓存）。**永不 throw**。
   *  读失败时保留上一次好数据（宁可继续用旧先验，也不因为一次 IO 抖动全丢）。 */
  function read(force) {
    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        cache.doc = emptyDoc();
        cache.loaded = true;
        cache.missing = true;
        cache.corrupt = false;
        cache.ioError = false;
        cache.lastError = '';
        cache.mtime = -1;
        cache.size = -1;
        return cache;
      }
      cache.ioError = true;
      cache.lastError = '读先验文件失败（' + errText(e) + '）：' + file;
      return cache;
    }
    if (!force && cache.loaded && st.mtimeMs === cache.mtime && st.size === cache.size) return cache;

    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      cache.mtime = st.mtimeMs;
      cache.size = st.size;
      cache.loaded = true;
      cache.ioError = true;
      cache.lastError = '读先验文件失败（' + errText(e) + '）：' + file;
      return cache;
    }
    cache.missing = false;
    cache.mtime = st.mtimeMs;
    cache.size = st.size;
    cache.loaded = true;
    cache.ioError = false;

    // 空文件 = 还没写过（首次运行/刚清空），不是损坏。
    if (!raw.trim()) {
      cache.doc = emptyDoc();
      cache.corrupt = false;
      cache.lastError = '';
      return cache;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      cache.doc = emptyDoc();
      cache.corrupt = true;
      cache.lastError = '先验文件不是合法 JSON，已按空表处理（原文件保留待修）：' + file + '（' + errText(e) + '）';
      return cache;
    }

    const priors = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed.priors : null;
    if (!priors || typeof priors !== 'object' || Array.isArray(priors)) {
      cache.doc = emptyDoc();
      cache.corrupt = true;
      cache.lastError = '先验文件结构不对（缺 priors 对象），已按空表处理：' + file;
      return cache;
    }

    const clean = {};
    let dropped = 0;
    for (const [key, value] of Object.entries(priors)) {
      const entry = sanitizeEntry(value, defaultTtlMs);
      if (entry) clean[key] = entry;
      else dropped += 1;
    }
    cache.doc = {
      version: FILE_VERSION,
      updatedAt: Number(parsed.updatedAt) || 0,
      priors: clean,
    };
    cache.corrupt = false;
    cache.lastError = dropped ? ('先验文件有 ' + dropped + ' 条无效记录，已忽略（其余正常）：' + file) : '';
    return cache;
  }

  /** 原子写表。失败返回 {ok:false, detail}，不 throw。
   *  损坏文件先改名备份再写 —— 覆盖残骸等于永久丢用户数据。 */
  function writeDoc(doc) {
    // 上一次读是 IO 错误（不是「文件不存在」）：内存里的表可能不是最新的，
    // 这时写回等于用旧表覆盖可能完好的文件 —— 宁可不保存并报原因。
    if (cache.ioError) {
      return {
        ok: false,
        detail: '上一次读取先验失败（' + (cache.lastError || '原因未知') + '），本次不写入以免覆盖原文件',
      };
    }
    if (cache.corrupt) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bad = file + '.corrupt-' + stamp;
      try {
        fs.renameSync(file, bad);
        cache.backup = bad;
      } catch (e) {
        if (!(e && e.code === 'ENOENT')) {
          const detail = '先验文件损坏且备份失败（' + errText(e) + '），本次不写入以免覆盖残骸：' + file;
          cache.lastError = detail;
          return { ok: false, detail };
        }
      }
    }

    const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* 清不掉也不掩盖原错误 */ }
      const detail = '写先验文件失败（' + errText(e) + '）：' + file;
      cache.lastError = detail;
      return { ok: false, detail };
    }

    let st = null;
    try { st = fs.statSync(file); } catch (e) { st = null; }
    cache.doc = doc;
    cache.loaded = true;
    cache.missing = false;
    cache.corrupt = false;
    cache.ioError = false;
    cache.lastError = '';
    cache.mtime = st ? st.mtimeMs : -1;
    cache.size = st ? st.size : -1;
    return { ok: true };
  }

  /**
   * 查先验。命中且未过期 → {activity, conf:100, why:'user-prior', ageMs}；否则 null。
   * 过期条目在查询时顺手删掉并落盘（不把「过期了但还在文件里」留给下一次读）。
   * 注意：conf 是**百分比口径**（100=用户明确指定）。world-store 内部的 conf 是 0..1，
   * 采用时自行归一。
   */
  function lookup(input, now) {
    const t = Number.isFinite(Number(now)) ? Number(now) : nowFn();
    const key = keyOf(input);
    if (!key) return null;
    read(false);
    const entry = cache.doc.priors[key];
    if (!entry) return null;
    if (isExpired(entry, t)) {
      const next = {
        version: FILE_VERSION,
        updatedAt: t,
        priors: Object.assign({}, cache.doc.priors),
      };
      delete next.priors[key];
      const w = writeDoc(next);   // best-effort：写不进去也不影响「已过期=不采用」的结论
      if (!w.ok) {
        // 写盘失败（被占用/权限）时**内存里也先当它没了**：世界感知每秒 lookup 一次，
        // 不这样做就会每秒重试一次失败的原子写（一天 8 万次无效 IO），而结论本来就是
        // 「过期不采用」。文件里的残留在下次成功写入或 prune 时自然清掉。
        const mem = Object.assign({}, cache.doc);
        mem.priors = Object.assign({}, cache.doc.priors);
        delete mem.priors[key];
        cache.doc = mem;
      }
      return null;
    }
    return { activity: entry.activity, conf: 100, why: 'user-prior', ageMs: ageOf(entry, t) };
  }

  /**
   * 写入/覆盖一条先验。activity 非法 → {ok:false, detail}（人话原因）。
   * 成功 → {ok:true, key, entry}；写盘失败 → {ok:false, detail}（不假装保存成功）。
   */
  function upsert(input) {
    const p = input || {};
    const activity = String(p.activity == null ? '' : p.activity).trim().toLowerCase();
    if (!ACTIVITY_SET.has(activity)) {
      return { ok: false, detail: '不认识的 activity「' + activity + '」，可用：' + ACTIVITIES.join(' / ') };
    }
    const key = keyOf(p);
    if (!key) {
      return { ok: false, detail: 'app 和 title 都为空：没有可匹配的窗口，先验无处生效' };
    }

    read(false);
    const t = nowFn();
    const entry = {
      activity,
      note: clipNote(p.note),
      source: 'user',
      conf: 100,
      updatedAt: t,
      ttlMs: Number(p.ttlMs) > 0 ? Number(p.ttlMs) : defaultTtlMs,
    };

    const next = {
      version: FILE_VERSION,
      updatedAt: t,
      priors: Object.assign({}, cache.doc.priors),
    };
    next.priors[key] = entry;

    // 容量上限：按 updatedAt 丢最旧的（先验是短期纠偏，不是长期档案）
    const keys = Object.keys(next.priors);
    if (keys.length > maxEntries) {
      keys.sort((a, b) => Number(next.priors[a].updatedAt) - Number(next.priors[b].updatedAt));
      for (const k of keys.slice(0, keys.length - maxEntries)) delete next.priors[k];
    }

    const w = writeDoc(next);
    if (!w.ok) return { ok: false, detail: w.detail, key };
    return { ok: true, key, entry };
  }

  /** 清理过期条目。返回 {ok, removed, left, detail?}。 */
  function prune(now) {
    const t = Number.isFinite(Number(now)) ? Number(now) : nowFn();
    read(false);
    const next = {
      version: FILE_VERSION,
      updatedAt: t,
      priors: Object.assign({}, cache.doc.priors),
    };
    let removed = 0;
    for (const key of Object.keys(next.priors)) {
      if (isExpired(next.priors[key], t)) {
        delete next.priors[key];
        removed += 1;
      }
    }
    if (!removed) {
      return { ok: true, removed: 0, left: Object.keys(cache.doc.priors).length, lastError: cache.lastError };
    }
    const w = writeDoc(next);
    if (!w.ok) {
      return { ok: false, removed, left: Object.keys(cache.doc.priors).length, detail: w.detail };
    }
    return { ok: true, removed, left: Object.keys(cache.doc.priors).length, lastError: cache.lastError };
  }

  /** 未过期的先验列表（按最近更新排前面）。
   *  返回对象而不是裸数组：损坏原因必须能一起带出去（不能静默当没配过）。
   *  {ok, file, priors:[{key,activity,note,source,conf,updatedAt,ttlMs,ageMs}], lastError, corrupt} */
  function list(now) {
    const t = Number.isFinite(Number(now)) ? Number(now) : nowFn();
    read(false);
    const priors = [];
    for (const [key, entry] of Object.entries(cache.doc.priors)) {
      if (isExpired(entry, t)) continue;
      priors.push({
        key,
        activity: entry.activity,
        note: entry.note,
        source: entry.source,
        conf: entry.conf,
        updatedAt: entry.updatedAt,
        ttlMs: ttlOf(entry),
        ageMs: ageOf(entry, t),
      });
    }
    priors.sort((a, b) => b.updatedAt - a.updatedAt);
    return { ok: true, file, priors, lastError: cache.lastError, corrupt: cache.corrupt };
  }

  return {
    file,
    lookup,
    upsert,
    prune,
    list,
    /** 最近一次读/写的问题（'' = 正常）。给 status/诊断用。 */
    get lastError() { return cache.lastError; },
    /** 损坏文件被改名备份到哪（没备份过 = ''） */
    get backup() { return cache.backup; },
    /** 方便测试/诊断：强制重读文件 */
    reload() { read(true); return list(); },
  };
}

// ── 默认实例（world-store 不传 opts.priors 时用的就是它）──────────────────
// 懒创建：这样 PET_DATA_ROOT 在 require 之后再设置也能生效（测试常见顺序）。
let _default = null;
function defaultPriors() {
  if (!_default) _default = createWorldPriors();
  return _default;
}

module.exports = {
  createWorldPriors,
  keyOf,
  normalizeApp,
  normalizeTitle,
  ACTIVITIES,
  DEFAULT_TTL_MS,
  FILE_VERSION,
  // 默认实例的便捷入口（world-store 的默认接线）
  lookup: (input, now) => defaultPriors().lookup(input, now),
  upsert: (input) => defaultPriors().upsert(input),
  prune: (now) => defaultPriors().prune(now),
  list: (now) => defaultPriors().list(now),
  get lastError() { return defaultPriors().lastError; },
  get file() { return defaultPriors().file; },
};
