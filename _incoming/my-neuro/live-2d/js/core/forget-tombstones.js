// js/core/forget-tombstones.js —— 「遗忘墓碑」：用户说「忘掉 X」之后的过滤层。
//
// 背景（2026-11-22 遗忘不生效）：
//   memory-recall 的遗忘路径只删 用户记忆.json + 用户事实.json + MemOS，
//   但 _rebuild() 还会索引 对话历史.jsonl / 记忆库.txt / AI日记.txt / 片段卡，
//   原文仍在 → 下次启动或重建索引，X 又回来了，用户觉得「她说好忘了其实没听」。
//
// 墓碑不是「删除历史」：原始文件一律不动（仍可审计/回滚），只在**装索引**和
// **MemOS 注入**时按墓碑过滤。墓碑文件本身是数据，走 records-path 唯一真源，
// PET_DATA_ROOT 测试隔离对它同样生效。
//
// 匹配规则（刻意保守，防误杀）：
//   · 归一化：trim + lowercase + 去空白/中英标点；
//   · 精确：归一化后 sha256 完全相等；
//   · 包含：墓碑归一化长度 ≥6 且被查文本包含它。
//     短墓碑（「猫」这种）只做精确匹配 —— 否则一句「猫」会把所有提到猫的记忆全杀掉。
//
// 失败语义：本模块的任何 API 都不 throw。读坏/写失败只 console.warn，
// 返回 false / 0 / 空表 —— 遗忘过滤是增强，不能反过来把记忆系统搞崩。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { recordFile } = require('./records-path.js');

const FILE_NAME = '遗忘墓碑.json';
const VERSION = 1;
const MAX_ITEMS = 500;        // 上限：超了按 at 丢最旧
const CONTAINS_MIN_LEN = 6;   // 短于这个长度只做精确匹配
const STAT_THROTTLE_MS = 500; // isForgotten 频繁调用：mtime 检查最多每 500ms 一次

// 空白与常见中英标点（中文引号用码点写，避免编辑器/终端把弯引号折成 ASCII）
const PUNCT_RE = /[\s，。！？、；：\u201c\u201d\u2018\u2019（）()【】\[\]…·~!?.,;:"']/g;

/** 归一化：空值安全，永不 throw */
function normalize(text) {
  try {
    return String(text == null ? '' : text).trim().toLowerCase().replace(PUNCT_RE, '');
  } catch (e) {
    return '';
  }
}

function hashOf(normalized) {
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function filePath() {
  return recordFile(FILE_NAME);
}

function warn(msg) {
  try { console.warn('[forget-tombstones] ' + msg); } catch (e) { /* console 不可用也不抛 */ }
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs || 0; } catch (e) { return 0; }
}

// 内存缓存：isForgotten 不读盘（只在 mtime 变化时重载）。
const state = {
  loaded: false,     // 是否至少加载过一次
  mtimeMs: -1,       // 上次加载时的 mtime（0 = 文件不存在）
  items: [],         // [{hash, text, at, source, norm}]（norm 仅内存用）
  corrupt: false,    // 上次加载是否撞到坏文件（add 前先留档再覆盖）
  lastStatAt: 0,
};

/** 单条磁盘记录 → 内存记录；坏条目返回 null */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text : (raw.text == null ? '' : String(raw.text));
  const norm = normalize(text);
  if (!norm) return null;
  const at = Number(raw.at);
  return {
    hash: (typeof raw.hash === 'string' && raw.hash) ? raw.hash : hashOf(norm),
    text: text.slice(0, 500),
    at: Number.isFinite(at) ? at : 0,
    source: typeof raw.source === 'string' ? raw.source : 'forget',
    norm,
  };
}

/** 从磁盘装载；force=true 强制重读。返回是否装载成功（坏文件也算「装载成功但空表」）。 */
function load(force) {
  const file = filePath();
  const mtime = mtimeOf(file);
  if (!force && state.loaded && mtime === state.mtimeMs) return true;

  state.loaded = true;
  state.mtimeMs = mtime;
  state.corrupt = false;
  state.items = [];

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code !== 'ENOENT') warn('读取失败，按空表处理：' + ((e && e.message) || e));
    return true;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // 坏文件不删（用户可能想手工修）：只当空表，并留给 add 的「先留档再覆盖」逻辑。
    state.corrupt = true;
    warn(FILE_NAME + ' 解析失败，按空表处理（不删除原文件）');
    return true;
  }

  const arr = parsed && Array.isArray(parsed.items) ? parsed.items : [];
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const s = sanitize(it);
    if (!s || seen.has(s.hash)) continue;
    seen.add(s.hash);
    out.push(s);
  }
  // 旧文件可能超上限（被手工改过）：读的时候也按 at 保最新
  state.items = out.length > MAX_ITEMS ? trimOldest(out, MAX_ITEMS) : out;
  return true;
}

/** 按 at 升序取最新 limit 条（同 at 保留后插入的） */
function trimOldest(items, limit) {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (Number(a.it.at) - Number(b.it.at)) || (a.i - b.i))
    .slice(-limit)
    .map((x) => x.it);
}

/** mtime 变化的自动重载（带节流：isForgotten 不每次都 stat） */
function sync(force) {
  const now = Date.now();
  if (!force && state.loaded && (now - state.lastStatAt) < STAT_THROTTLE_MS) return;
  state.lastStatAt = now;
  load(false);
}

/** 原子写：tmp → rename；返回是否成功 */
function writeTable(items) {
  const file = filePath();
  // tmp 名带 pid：宿主与另一个进程同时 add 时不会互相覆盖临时文件
  const tmp = file + '.tmp-' + process.pid;
  try {
    // 上次读到的是坏文件：先改名留档（不算删除），再写全新的合法表
    if (state.corrupt) {
      try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch (e) { /* 留档失败不阻塞写入 */ }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = {
      version: VERSION,
      updated_at: Date.now(),
      items: items.map((it) => ({ hash: it.hash, text: it.text, at: it.at, source: it.source })),
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    warn('写入失败：' + ((e && e.message) || e));
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { /* 清理失败不影响结果 */ }
    return false;
  }
}

/**
 * 追加墓碑。
 * @param {string[]|string} texts 要遗忘的原文（会归一化）
 * @param {{source?: string, at?: number}} [meta]
 * @returns {number} 实际新增条数（重复/空文本不计）
 */
function add(texts, meta) {
  try {
    sync(true); // 先合并盘上已有的（宿主/别的进程可能刚写过）
    const list = Array.isArray(texts) ? texts : [texts];
    const m = meta && typeof meta === 'object' ? meta : {};
    const atRaw = Number(m.at);
    const at = Number.isFinite(atRaw) && atRaw > 0 ? atRaw : Date.now();
    const source = (typeof m.source === 'string' && m.source) ? m.source : 'forget';

    const items = state.items.slice();
    const seen = new Set(items.map((it) => it.hash));
    let added = 0;
    for (const t of list) {
      const norm = normalize(t);
      if (!norm) continue;
      const hash = hashOf(norm);
      if (seen.has(hash)) continue;
      seen.add(hash);
      items.push({ hash, text: String(t).trim().slice(0, 500), at, source, norm });
      added += 1;
    }
    if (!added) return 0;

    const capped = items.length > MAX_ITEMS ? trimOldest(items, MAX_ITEMS) : items;
    if (!writeTable(capped)) return 0;

    state.items = capped;
    state.corrupt = false;
    state.mtimeMs = mtimeOf(filePath());
    state.lastStatAt = Date.now();
    return added;
  } catch (e) {
    warn('add 失败：' + ((e && e.message) || e));
    return 0;
  }
}

/**
 * 这条文本是否已被遗忘。
 * @param {string} text
 * @returns {boolean}
 */
function isForgotten(text) {
  try {
    const norm = normalize(text);
    if (!norm) return false;
    sync(false);
    if (!state.items.length) return false;
    const hash = hashOf(norm);
    for (const it of state.items) {
      if (it.hash === hash) return true;
      if (it.norm && it.norm.length >= CONTAINS_MIN_LEN && norm.includes(it.norm)) return true;
    }
    return false;
  } catch (e) {
    warn('isForgotten 失败：' + ((e && e.message) || e));
    return false;
  }
}

/**
 * @returns {{count: number, lastAt: number}}
 */
function stats() {
  try {
    sync(true);
    let lastAt = 0;
    for (const it of state.items) {
      const at = Number(it.at) || 0;
      if (at > lastAt) lastAt = at;
    }
    return { count: state.items.length, lastAt };
  } catch (e) {
    warn('stats 失败：' + ((e && e.message) || e));
    return { count: 0, lastAt: 0 };
  }
}

/** 强制重读磁盘（测试用；宿主内 add 已即时更新缓存，一般不需要） */
function reload() {
  try {
    load(true);
    return state.items.length;
  } catch (e) {
    warn('reload 失败：' + ((e && e.message) || e));
    return 0;
  }
}

module.exports = { add, isForgotten, stats, reload, FILE_NAME, MAX_ITEMS, normalize };
