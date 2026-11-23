#!/usr/bin/env node
'use strict';
/**
 * _probe/stress-pure.cjs —— 纯函数模糊/压力探针（只读，不注册进门禁）
 *
 * 覆盖：
 *   1 untrusted-data  换行/引号/孤立代理项/NaN/Infinity/BigInt/循环引用 → 前缀+合法 JSON 或空串
 *   2 secret-mask     随机嵌套配置 → 不泄露明文、mask(restore(mask)) 幂等、*** 不落盘
 *   3 world-store     随机世界快照 → 不抛、token 硬上限、空闲/活动边界、历史不膨胀
 *   4 site-category   随机 host → 8 类之一、无 path/query、幂等
 *   5 memory-recall   isScaffolding / bigramJaccard / _dedupeNear
 *   6 rss-brief/score scoreItem 有限且 [0,1]、确定性、cluster/selectDiverse
 *   7 rss-brief       _sanitizeCard 形状收敛
 *   8 perf            applyFACS 有限且落在画像声明范围；claim 单 owner/无死锁
 *   9 tts             playResult 字段契约；viseme 索引不越界
 *  10 性能            每项 5k 次耗时 p50/max，>2s 标红
 *
 * 运行：node <project-root>/_probe/stress-pure.cjs
 * 种子固定（SEED），失败可复现；每项打印前 3 个最小失败输入（截断 500 字）。
 * 只读：不写任何文件、不联网、不碰 8004/8103、不跑 check-all。
 */

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');

const ROOT = '<project-root>';
const NEURO = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const SEED = 0x5EED2026;

// ── 可复现随机 ──────────────────────────────────────────────────────────
function mulberry32(a) {
  let x = a >>> 0;
  return function () {
    x |= 0; x = (x + 0x6D2B79F5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashName(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function int(rnd, min, max) { return min + Math.floor(rnd() * (max - min + 1)); }
function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }
function chance(rnd, p) { return rnd() < p; }

const NASTY = [
  'a', 'Z', '0', ' ', '"', "'", '{', '}', '[', ']', ':', ',', '\\',
  '\n', '\r', '\r\n', '\t', '\u0000', '\u0007', '\u001f', '\u007f',
  '😀', '👩‍👩‍👧', '\uD800', '\uDC00', '\uD800\uD800', '中', '文', '𝄞',
  '\u2028', '\u2029', '<', '>', '&', '/', '\u00a0', '%', '$', '${x}', '`',
];
function evilString(rnd, maxLen) {
  const n = int(rnd, 0, maxLen);
  let s = '';
  for (let i = 0; i < n; i++) {
    if (chance(rnd, 0.6)) s += pick(rnd, NASTY);
    else s += String.fromCharCode(32 + Math.floor(rnd() * 95));
  }
  return s;
}
function cjkTitle(rnd, n) {
  const pool = '人工智能模型发布新闻今天天气猫咪名字记忆世界视频游戏测试数据边界';
  let s = '';
  for (let i = 0; i < (n || int(rnd, 3, 10)); i++) s += pool[int(rnd, 0, pool.length - 1)];
  return s;
}

function preview(value, limit) {
  const cap = limit || 500;
  let text;
  try {
    text = JSON.stringify(value, (k, v) => {
      if (typeof v === 'bigint') return String(v) + 'n';
      if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
      return v;
    });
  } catch (e) {
    text = '<circular/unserializable>';
  }
  if (text === undefined) {
    try { text = String(value); } catch (e2) { text = '<unprintable>'; }
  }
  if (typeof text !== 'string') text = String(text);
  return text.length > cap ? text.slice(0, cap) + '…' : text;
}
function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    const aa = Array.isArray(a);
    const ba = Array.isArray(b);
    if (aa !== ba) return false;
    if (aa) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
      return true;
    }
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
    for (const k of ka) if (!jsonEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}
function shapeOf(n) {
  if (Array.isArray(n)) return { t: 'a', v: n.map(shapeOf) };
  if (n && typeof n === 'object') {
    const o = {};
    for (const k of Object.keys(n).sort()) o[k] = shapeOf(n[k]);
    return { t: 'o', v: o };
  }
  return { t: typeof n };
}
function collectStrings(n, out) {
  if (typeof n === 'string') out.push(n);
  else if (Array.isArray(n)) { for (const v of n) collectStrings(v, out); }
  else if (n && typeof n === 'object') { for (const v of Object.values(n)) collectStrings(v, out); }
}
function collectDiffs(a, b, p, out) {
  p = p || '$';
  if (a === b) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aa = Array.isArray(a); const ba = Array.isArray(b);
    if (aa === ba) {
      if (aa) {
        if (a.length === b.length) {
          for (let i = 0; i < a.length; i++) collectDiffs(a[i], b[i], p + '[' + i + ']', out);
          return;
        }
      } else {
        const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
        if (ka.join('|') === kb.join('|')) {
          for (const k of ka) collectDiffs(a[k], b[k], p + '.' + k, out);
          return;
        }
      }
    }
  }
  out.push([p, a, b]);
}

// ── 套件运行器 ──────────────────────────────────────────────────────────
const results = [];
const NOTES = {
  applyFACSOutOfUnit: 0,
  emptyOwnerClaims: 0,
  secretNullRoundTrip: 0,
  claimInfiniteDuration: 0,
};

function suite(name, n, gen, check) {
  const rnd = mulberry32((SEED ^ hashName(name)) >>> 0);
  const times = new Float64Array(n);
  const examples = [];
  const reasons = new Map();
  let fails = 0;
  const wall0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    let input;
    try { input = gen(rnd, i); } catch (e) { input = { __genError: String(e && e.message) }; }
    const t0 = process.hrtime.bigint();
    let verdict;
    try {
      verdict = check(input, rnd, i);
    } catch (e) {
      verdict = 'THROW ' + (e && e.stack ? e.stack.split('\n')[0] : String(e));
    }
    times[i] = Number(process.hrtime.bigint() - t0) / 1e6;
    if (verdict !== true) {
      fails += 1;
      const reason = String(verdict);
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
      if (examples.length < 3) examples.push({ why: reason, input: preview(input, 500) });
    }
  }
  const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;
  times.sort();
  const p50 = times[Math.floor(n * 0.5)] || 0;
  const p95 = times[Math.floor(n * 0.95)] || 0;
  const max = times[n - 1] || 0;
  results.push({ name, n, wallMs, p50, p95, max, fails, examples, reasons });
  process.stderr.write('.');
  return results[results.length - 1];
}

// ═══════════════════════════════════════════════════════════════════════
// 1. untrusted-data
// ═══════════════════════════════════════════════════════════════════════
const U = require(path.join(NEURO, 'js/core/untrusted-data.js'));

function genUTScalar(rnd) {
  const r = rnd();
  if (r < 0.42) return evilString(rnd, 80);
  if (r < 0.58) return (rnd() * 2 - 1) * 1e9;
  if (r < 0.68) return pick(rnd, [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, 1e308, -1e308, 0]);
  if (r < 0.76) return chance(rnd, 0.5);
  if (r < 0.83) return null;
  if (r < 0.89) return undefined;
  if (r < 0.92) return 10n ** BigInt(int(rnd, 0, 6));
  if (r < 0.96) return '\uD800' + evilString(rnd, 10) + '\uDC00';
  return evilString(rnd, 3000);
}
function genUTValue(rnd, depth) {
  if (depth > 5 || rnd() < 0.36) return genUTScalar(rnd);
  if (rnd() < 0.55) {
    const a = [];
    const n = int(rnd, 0, 4);
    for (let i = 0; i < n; i++) a.push(genUTValue(rnd, depth + 1));
    return a;
  }
  const o = {};
  const n = int(rnd, 1, 4);
  for (let i = 0; i < n; i++) {
    const k = pick(rnd, ['a', 'title', 'b', 'x', '嵌套', 'k"q', '__proto__', 'constructor', 'v', '']) + i;
    Object.defineProperty(o, k, {
      value: genUTValue(rnd, depth + 1), enumerable: true, configurable: true, writable: true,
    });
  }
  return o;
}
function genUT(rnd) {
  if (chance(rnd, 0.004)) {
    const o = { a: 1, b: 'x' };
    o.self = o;
    return { fn: 'wrapUntrusted', kind: 'world', payload: o, maxChars: 200 };
  }
  const fn = chance(rnd, 0.1) ? 'wrapPayload' : 'wrapUntrusted';
  const kind = pick(rnd, [
    'window', 'screen', 'danmaku', 'world', 'memories', '  window  ', '', '   ',
    'a"b', 'x'.repeat(int(rnd, 1, 40)), '__proto__', '中文',
  ]);
  const payload = genUTValue(rnd, 0);
  const maxChars = pick(rnd, [0, 1, 5, 10, 20, 40, 80, 200, 500, 1200, -5, NaN, '100', 'abc', undefined]);
  return { fn, kind, payload, maxChars };
}
suite('untrusted-data', 5000, genUT, (inp) => {
  const { fn, kind, payload, maxChars } = inp;
  const out = fn === 'wrapPayload'
    ? U.wrapPayload(payload, maxChars)
    : U.wrapUntrusted(kind, payload, maxChars);
  const k = kind == null ? '' : String(kind).trim();
  if (fn === 'wrapUntrusted' && !k) return out === '' ? true : 'nonempty for empty kind';
  if (payload === undefined || payload === null) return out === '' ? true : 'nonempty for nullish payload';
  if (out === '') return true; // 循环引用/BigInt/预算过小：文档约定返回空串
  if (!out.startsWith(U.UNTRUSTED_PREFIX)) return 'missing prefix';
  if (/[\r\n]/.test(out)) return 'literal CR/LF in line';
  let parsed;
  try { parsed = JSON.parse(out.slice(U.UNTRUSTED_PREFIX.length)); }
  catch (e) { return 'invalid JSON: ' + e.message; }
  const n = Number(maxChars);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (limit > 0 && out.length > limit) return 'over budget ' + out.length + '>' + limit;
  if (fn === 'wrapUntrusted') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'body not object';
    if (!Object.prototype.hasOwnProperty.call(parsed, k)) return 'kind key lost';
  }
  const full = fn === 'wrapPayload' ? U.wrapPayload(payload, 0) : U.wrapUntrusted(kind, payload, 0);
  if (full && (!limit || full.length <= limit)) {
    if (out !== full) return 'budget sufficient but output narrowed';
    let round;
    try { round = JSON.parse(JSON.stringify(payload)); } catch (e) { round = undefined; }
    if (round !== undefined) {
      const expected = fn === 'wrapPayload' ? round : { [k]: round };
      if (!jsonEqual(parsed, expected)) return 'structure mismatch when full fits';
    }
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════════════
// 2. secret-mask
// ═══════════════════════════════════════════════════════════════════════
const S = require(path.join(NEURO, 'js/core/secret-mask.js'));

const SECRET_KEY_POOL = [
  'api_key', 'apiKey', 'apikey', 'api-key', 'secret', 'token', 'password', 'passwd',
  'cookie', 'authorization', 'credential', 'API_KEY', 'my_token', 'refresh_token',
];
const NORMAL_KEY_POOL = [
  'name', 'url', 'enabled', 'max_tokens', 'ptt_key', 'secret_santa', 'tokens', 'nested',
  'fields', 'value', 'title', 'type', 'items', 'count', 'base_url', 'model', 'enabled_flag',
];
function isSecretKeyLike(key) {
  try { return S.isSecretKey(key); } catch (e) { return false; }
}
function genSecretLeaf(rnd, key, markers) {
  const r = rnd();
  if (r < 0.55) {
    if (isSecretKeyLike(key)) {
      let s = 'sk-' + Array.from({ length: 12 }, () => 'abcdef0123456789'[int(rnd, 0, 15)]).join('');
      if (chance(rnd, 0.1)) s += '"\\\n😀';
      markers.push(s);
      return s;
    }
    return evilString(rnd, 20);
  }
  if (r < 0.7) return int(rnd, 0, 100000);
  if (r < 0.8) return chance(rnd, 0.5);
  if (r < 0.9) return null;
  return evilString(rnd, 6);
}
function genSecretNode(rnd, depth, markers, keyHint) {
  const r = rnd();
  if (depth > 3 || r < 0.32) return genSecretLeaf(rnd, keyHint, markers);
  if (r < 0.5) {
    const arr = [];
    const n = int(rnd, 0, 3);
    for (let i = 0; i < n; i++) arr.push(genSecretNode(rnd, depth + 1, markers, keyHint));
    return arr;
  }
  const obj = {};
  const n = int(rnd, 1, 5);
  const usedKeys = new Set();
  for (let i = 0; i < n; i++) {
    let k;
    let guard = 0;
    do {
      const secretKey = chance(rnd, 0.4);
      k = secretKey ? pick(rnd, SECRET_KEY_POOL) : pick(rnd, NORMAL_KEY_POOL);
      guard += 1;
    } while (usedKeys.has(k) && guard < 50);
    if (usedKeys.has(k)) continue; // 键池耗尽（最多 5 个键，实际不会）
    usedKeys.add(k);
    if (chance(rnd, 0.12)) {
      const node = { title: 'T', type: 'string' };
      if (chance(rnd, 0.8)) node.value = genSecretLeaf(rnd, k, markers);
      obj[k] = node;
    } else {
      obj[k] = genSecretNode(rnd, depth + 1, markers, k);
    }
  }
  return obj;
}
suite('secret-mask:random', 5000, (rnd) => {
  const markers = [];
  const root = chance(rnd, 0.05)
    ? pick(rnd, [null, undefined, 0, 'x', [], [1, 2]])
    : genSecretNode(rnd, 0, markers, null);
  return { root, markers };
}, (inp) => {
  const { root, markers } = inp;
  const before = preview(root, 1000000);
  const m = S.maskSecrets(root);
  const after = preview(root, 1000000);
  if (before !== after) return 'input mutated';
  const maskedStrings = [];
  collectStrings(m.value, maskedStrings);
  for (const mk of markers) {
    if (maskedStrings.some((s) => s.includes(mk))) return 'plaintext secret leaked: ' + mk;
    const maskedForm = S.maskSecretText(mk);
    if (!maskedStrings.includes(maskedForm)) return 'secret not masked as ' + maskedForm;
  }
  if (!Array.isArray(m.maskedKeys)) return 'maskedKeys not array';
  if (new Set(m.maskedKeys).size !== m.maskedKeys.length) return 'maskedKeys not unique';
  if (markers.length && m.maskedKeys.length === 0) return 'maskedKeys empty with secrets';
  if (!jsonEqual(shapeOf(root), shapeOf(m.value))) return 'mask changed shape';
  const restored = S.restoreSecrets(m.value, root);
  const m2 = S.maskSecrets(restored);
  if (preview(m2.value, 1000000) !== preview(m.value, 1000000)) {
    const diffs = [];
    collectDiffs(m.value, m2.value, '$', diffs);
    if (diffs.length && diffs.every(([, a, b]) => a === null && b === '')) {
      NOTES.secretNullRoundTrip += 1;
    } else if (!diffs.length) {
      NOTES.secretOrderOnly = (NOTES.secretOrderOnly || 0) + 1;
      if (!NOTES.secretOrderSample) {
        NOTES.secretOrderSample = 'm1=' + preview(m.value, 300) + ' m2=' + preview(m2.value, 300);
      }
    } else {
      NOTES.secretOther = (NOTES.secretOther || 0) + 1;
      if (!NOTES.secretOtherSample) {
        NOTES.secretOtherSample = 'diffs=' + preview(diffs, 300) + ' orig=' + preview(root, 300);
      }
    }
    return 'mask(restore(mask)) not idempotent';
  }
  if (!jsonEqual(m2.maskedKeys, m.maskedKeys)) return 'maskedKeys differ on re-mask';
  const restoredStrings = [];
  collectStrings(restored, restoredStrings);
  for (const mk of markers) if (!restoredStrings.includes(mk)) return 'restore lost secret';
  return true;
});
const SECRET_CONTRACT = [
  () => { const r = S.maskSecrets({ api_key: 'sk-1234567890' }); return r.value.api_key === '***7890' && r.maskedKeys.join(',') === 'api_key'; },
  () => S.restoreSecrets({ api_key: '***7890' }, { api_key: 'sk-1234567890' }).api_key === 'sk-1234567890',
  () => !('new_secret' in S.restoreSecrets({ new_secret: '***abcd' }, {})),
  () => S.maskSecretText('abcdefgh') === '***' && S.maskSecretText('abcdefghi') === '***fghi',
  () => S.isBlankOrMask('***') && S.isBlankOrMask('') && S.isBlankOrMask('******') && !S.isBlankOrMask('abc'),
  () => {
    const m = S.maskSecrets({ nested: { token: 'tok-abcdefghij' }, token: ['secret-value-123456'] });
    const j = JSON.stringify(m.value);
    return !j.includes('tok-abcdefghij') && !j.includes('secret-value-123456');
  },
  () => S.maskSecrets({ fields: { api_key: 'sk-abcdefghij' } }).value.fields.api_key === '***ghij',
  () => S.maskSecrets({ token: { title: 'T', type: 'string', value: 'sk-abcdefghij' } }).value.token.value === '***ghij',
];
suite('secret-mask:contract', SECRET_CONTRACT.length, (rnd, i) => i, (i) => (
  SECRET_CONTRACT[i]() === true ? true : 'contract case ' + i + ' failed'
));

// ═══════════════════════════════════════════════════════════════════════
// 3. world-store
// ═══════════════════════════════════════════════════════════════════════
const W = require(path.join(NEURO, 'js/core/world-store.js'));
const clock = { t: 1000000 };
const worldStore = W.createWorldStore({ now: () => clock.t });
let worldPrev = null;

function genWorldSnap(rnd) {
  clock.t += int(rnd, 0, 1200) + (chance(rnd, 0.08) ? int(rnd, 0, 120000) : 0);
  const t = clock.t;
  const s = {};
  if (chance(rnd, 0.88)) {
    s.fg = {
      ok: chance(rnd, 0.92),
      app: chance(rnd, 0.5) ? evilString(rnd, 14) : pick(rnd, ['chrome', 'Code', 'mpv', '游戏.exe', '']),
      title: chance(rnd, 0.08) ? evilString(rnd, 2000) : evilString(rnd, 90),
      fullscreen: chance(rnd, 0.35),
    };
  }
  if (chance(rnd, 0.92)) {
    s.idleMs = pick(rnd, [0, 999, 29000, 29999, 30000, 30001, 299000, 299999, 300000, Math.floor(rnd() * 1e7), -5, NaN, Infinity]);
  }
  if (chance(rnd, 0.72)) {
    s.media = {
      ok: chance(rnd, 0.8),
      status: pick(rnd, ['playing', 'paused', 'stopped', 'none', '', 'PLAYING', evilString(rnd, 12)]),
      title: chance(rnd, 0.06) ? evilString(rnd, 1500) : evilString(rnd, 80),
      app: evilString(rnd, 12),
    };
  }
  if (chance(rnd, 0.3)) {
    s.clip = {
      hash: chance(rnd, 0.85) ? ('h' + int(rnd, 0, 999999)) : '',
      chars: pick(rnd, [0, 10, 1e9, -5, NaN, Infinity, '123']),
    };
  }
  if (chance(rnd, 0.3)) {
    s.browser = {
      ok: chance(rnd, 0.8),
      host: pick(rnd, ['bilibili.com', 'www.youtube.com', 'EXAMPLE.COM:443/x?q=1', '新闻网站.cn', evilString(rnd, 20), '']),
      incognito: chance(rnd, 0.25),
      at: pick(rnd, [t, t - 1000, t - 600000, t + 600000, 0, NaN, Infinity]),
    };
  }
  if (chance(rnd, 0.25)) {
    s.notifications = {
      count: pick(rnd, [0, 1, 3, 1e9, -1, NaN, '5', Infinity]),
      apps: Array.from({ length: int(rnd, 0, 6) }, () => evilString(rnd, 8)),
      latest_title: chance(rnd, 0.1) ? evilString(rnd, 1200) : evilString(rnd, 40),
    };
  }
  if (chance(rnd, 0.1)) s.errors = Array.from({ length: int(rnd, 0, 3) }, () => evilString(rnd, 40));
  if (chance(rnd, 0.5)) {
    s.hints = {
      gaming: chance(rnd, 0.2),
      screenState: pick(rnd, ['game', 'video', 'other', '', undefined]),
    };
  }
  return s;
}
suite('world-store:apply+render', 5000, genWorldSnap, (snap) => {
  const cur = worldStore.apply(snap);
  if (!cur || typeof cur !== 'object') return 'apply returned non-object';
  const line = worldStore.renderWorldLine(worldPrev, cur);
  worldPrev = cur;
  if (!line || typeof line.text !== 'string') return 'render text not string';
  if (!Number.isFinite(line.tokens) || line.tokens < 0) return 'tokens not finite';
  if (line.tokens > W.DEFAULTS.hardMaxTokens) return 'tokens over hard limit ' + line.tokens;
  if (W.estimateTokens(line.text) !== line.tokens) return 'token estimate mismatch';
  if (!Array.isArray(line.fields)) return 'fields not array';
  if (typeof line.truncated !== 'boolean') return 'truncated not bool';
  const hist = worldStore.recentChanges(Infinity);
  if (hist.length > W.DEFAULTS.historyMax) return 'history grew ' + hist.length;
  for (const h of hist) {
    if (!Number.isFinite(h.at) || typeof h.field !== 'string') return 'bad history entry';
  }
  if (!(cur.activity in W.ACTIVITY_LABEL)) return 'activity not in label table: ' + cur.activity;
  const strFields = ['app', 'title', 'media', 'mediaStatus', 'mediaTitle', 'clip', 'privacy', 'category'];
  for (const f of strFields) if (typeof cur[f] !== 'string') return f + ' not string';
  if (cur.idleSec !== null && !Number.isFinite(cur.idleSec)) return 'idleSec not finite/null';
  if (cur.category && !Object.prototype.hasOwnProperty.call(W.ACTIVITY_LABEL, cur.category)) {
    // category 与 activity 共用不了表，单独用 site-category 的标签表校验
    const sc = require(path.join(NEURO, 'js/core/site-category.js'));
    if (!Object.prototype.hasOwnProperty.call(sc.CATEGORY_LABELS, cur.category)) return 'bad category';
  }
  const n = cur.notifications;
  if (!n || typeof n !== 'object') return 'notifications missing';
  if (!Number.isFinite(n.count) || n.count < 0) return 'notification count invalid';
  if (!Array.isArray(n.apps)) return 'notification apps not array';
  if (typeof n.latest_title !== 'string') return 'notification title not string';
  if (!cur.stale || typeof cur.stale !== 'object') return 'stale missing';
  return true;
});

function classifyRef(i) {
  const idleSec = Number(i.idleSec) || 0;
  const hints = i.hints || {};
  const playing = String(i.mediaStatus || '') === 'playing';
  const norm = (x) => String(x == null ? '' : x).toLowerCase().replace(/\s+/g, ' ').trim();
  const same = (a, b) => {
    const x = norm(a); const y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.length < 4 || y.length < 4) return false;
    return x.includes(y) || y.includes(x);
  };
  if (idleSec >= 300) return 'away';
  if (hints.gaming === true) return 'gaming';
  if (i.fullscreen === true && playing) return 'watching';
  if (playing && same(i.mediaTitle, i.fgTitle)) return 'watching';
  if (hints.screenState === 'game') return 'gaming';
  if (hints.screenState === 'video') return 'watching';
  if (idleSec >= 30) return 'idle';
  if (i.fgApp) return 'working';
  return 'unknown';
}
suite('world-store:classify-boundary', 5000, (rnd) => ({
  idleSec: pick(rnd, [0, 1, 29, 30, 31, 299, 300, 301, Math.floor(rnd() * 400), rnd() * 400, -5, NaN]),
  gaming: chance(rnd, 0.12),
  fullscreen: chance(rnd, 0.3),
  mediaStatus: pick(rnd, ['playing', 'paused', 'none', 'PLAYING', '', 'playing ']),
  mediaTitle: chance(rnd, 0.5) ? (chance(rnd, 0.5) ? '同一个视频标题ABC' : cjkTitle(rnd, 8)) : '',
  fgTitle: chance(rnd, 0.5) ? (chance(rnd, 0.5) ? '同一个视频标题ABC' : cjkTitle(rnd, 8)) : '',
  fgApp: chance(rnd, 0.6) ? 'app' : '',
  hints: { game: chance(rnd, 0.1), gaming: chance(rnd, 0.1), screenState: pick(rnd, ['game', 'video', 'other', '', undefined]) },
}), (inp) => {
  const got = W.classifyActivity(inp);
  const ref = classifyRef(inp);
  if (got.state !== ref) return 'state ' + got.state + ' != ' + ref;
  if (!Number.isFinite(got.conf) || got.conf < 0 || got.conf > 1) return 'conf out of range';
  if (typeof got.why !== 'string') return 'why not string';
  const human = W.humanIdle(inp.idleSec);
  if (typeof human !== 'string' || !human) return 'bad humanIdle';
  if (inp.idleSec === 30 && human !== '~30s') return 'idle 30 label ' + human;
  if (inp.idleSec === 29 && human !== '刚动过') return 'idle 29 label ' + human;
  if (inp.idleSec === 60 && human !== '1m') return 'idle 60 label ' + human;
  return true;
});

// ═══════════════════════════════════════════════════════════════════════
// 4. site-category
// ═══════════════════════════════════════════════════════════════════════
const C = require(path.join(NEURO, 'js/core/site-category.js'));
const KNOWN_HOSTS = [];
for (const [cat, hosts] of C.SUFFIX_RULES) for (const h of hosts) KNOWN_HOSTS.push([h, cat]);
const SITE_CONTRACT = [];
for (const [h, cat] of KNOWN_HOSTS) {
  SITE_CONTRACT.push([h, cat]);
  SITE_CONTRACT.push(['sub.' + h, cat]);
}
SITE_CONTRACT.push(
  ['postman.com', 'other'],
  ['store.example.com', 'shop'],
  ['news.example.com', 'news'],
  ['evilbilibili.com', 'other'],
  ['bilibili.com.evil.com', 'other'],
  ['notbilibili.com', 'other'],
  ['', 'other'],
  [null, 'other'],
  ['http://', 'other'],
  ['a', 'other'],
  ['.com', 'other'],
);
suite('site-category:contract', SITE_CONTRACT.length, (rnd, i) => SITE_CONTRACT[i], (c) => (
  C.categoryOf(c[0]) === c[1] ? true : 'categoryOf(' + preview(c[0], 80) + ')=' + C.categoryOf(c[0]) + ' expected ' + c[1]
));

const SITE_LABELS = ['www', 'mail', 'news', 'blog', 'store', 'video', 'social', 'docs', 'git',
  'api', 'cdn', 'static', 'm', 'x', 'a', 'b', 'shop', 'porn', 'sex', 'tv', 'wiki', 'dev',
  'postman', 'evilbilibili', 'example', '中文', 'exa_mple', '-bad-'];
const SITE_TLDS = ['com', 'cn', 'io', 'co.uk', 'net', 'org', 'tv', 'app', 'dev', 'com.cn'];
function genHost(rnd) {
  const r = rnd();
  if (r < 0.2) {
    const [host] = pick(rnd, KNOWN_HOSTS);
    let h = chance(rnd, 0.4) ? 'www.' + host : host;
    if (chance(rnd, 0.3)) h = h.toUpperCase();
    if (chance(rnd, 0.3)) h += ':' + int(rnd, 1, 65535);
    if (chance(rnd, 0.2)) h += '/path?q=' + evilString(rnd, 5);
    return h;
  }
  if (r < 0.5) {
    const labels = [];
    const n = int(rnd, 1, 4);
    for (let i = 0; i < n; i++) labels.push(pick(rnd, SITE_LABELS));
    labels.push(pick(rnd, SITE_TLDS));
    return labels.join('.');
  }
  if (r < 0.65) return evilString(rnd, 40) + '.' + pick(rnd, SITE_TLDS);
  if (r < 0.75) return ('a'.repeat(int(rnd, 240, 300))) + '.com';
  if (r < 0.88) {
    return pick(rnd, ['https://', 'http://', 'HTTPS://', 'ftp://']) +
      (chance(rnd, 0.2) ? 'user:pw@' : '') +
      pick(rnd, ['bilibili.com', 'example.com', '例え.jp', '127.0.0.1', '[::1]']) +
      (chance(rnd, 0.3) ? ':' + int(rnd, 1, 65535) : '') +
      '/a/b?q=1&utm_source=x#frag';
  }
  return pick(rnd, ['', null, undefined, 0, 123, true, '...', '.com', 'a..b', 'a.b.', 'EX.COM:8080',
    '[::1]:80', 'bilibili.com:abc', 'bilibili.com.', 'bilibili..com', '😀.com', 'new\nline.com']);
}
suite('site-category:random', 5000, genHost, (host) => {
  const cat = C.categoryOf(host);
  if (!C.CATEGORIES.includes(cat)) return 'not a declared category: ' + cat;
  if (C.CATEGORIES.length !== 8) return 'CATEGORIES length changed';
  if (C.categoryOf(host) !== cat) return 'not idempotent';
  const norm = C.normalizeHost(host);
  if (norm && /[\/?#]/.test(norm)) return 'path/query leaked into host: ' + norm;
  if (cat !== 'other' && !norm) return 'non-other without normalized host';
  if (C.categoryOf(norm) !== cat) return 'normalization changes category';
  return true;
});

// ═══════════════════════════════════════════════════════════════════════
// 5. memory-recall
// ═══════════════════════════════════════════════════════════════════════
const M = require(path.join(NEURO, 'plugins/community/memory-recall/index.js'));
const SCAFFOLD_KNOWN = [
  ['{"ok":true}', 'user', true],
  ['{"tool":"x"}', 'user', true],
  ['[1,2,3]', 'user', true],
  ['{bad json', 'user', false],
  ['```js\nx\n```', 'user', true],
  ['（你正在旁边看屏幕）', 'user', true],
  ['（笑）今天好热', 'user', false],
  ['（你正想说什么）', 'assistant', false],
  ['（系统提示：不要重复）', 'user', true],
  ['普通的句子', 'user', false],
  ['', 'user', false],
];
suite('memory:isScaffolding', 5000, (rnd) => {
  if (chance(rnd, 0.35)) {
    const k = pick(rnd, SCAFFOLD_KNOWN);
    return { text: k[0], role: k[1], expected: k[2] };
  }
  return {
    text: (chance(rnd, 0.4) ? pick(rnd, ['（', '(', '{', '[', '```', '']) : '') + evilString(rnd, 60),
    role: pick(rnd, ['user', 'assistant', 'system', '?', '', undefined, null]),
  };
}, (inp) => {
  const got = M.isScaffolding(inp.text, inp.role);
  if (typeof got !== 'boolean') return 'not boolean';
  if ('expected' in inp && got !== inp.expected) return 'expected ' + inp.expected + ' got ' + got;
  return true;
});

function refNorm(s) { return String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, ''); }
function refBigrams(s) {
  const n = refNorm(s);
  const set = new Set();
  if (!n) return set;
  if (n.length < 2) { set.add(n); return set; }
  for (let i = 0; i < n.length - 1; i++) set.add(n.slice(i, i + 2));
  return set;
}
function refJaccard(a, b) {
  const A = refBigrams(a); const B = refBigrams(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}
suite('memory:bigramJaccard', 5000, (rnd) => ({
  a: chance(rnd, 0.1) ? pick(rnd, [null, undefined, 0, false, '']) : evilString(rnd, 60),
  b: chance(rnd, 0.1) ? pick(rnd, [null, undefined, 0, false, '']) : (chance(rnd, 0.3) ? cjkTitle(rnd, 12) : evilString(rnd, 60)),
  same: chance(rnd, 0.2),
}), (inp) => {
  const a = inp.same ? inp.a : inp.a;
  const b = inp.same ? inp.a : inp.b;
  const got = M.bigramJaccard(a, b);
  if (!Number.isFinite(got) || got < 0 || got > 1) return 'out of [0,1]: ' + got;
  const ref = refJaccard(a, b);
  if (Math.abs(got - ref) > 1e-12) return 'mismatch ref ' + ref + ' got ' + got;
  const back = M.bigramJaccard(b, a);
  if (Math.abs(got - back) > 1e-12) return 'asymmetric';
  if (Math.abs(M.bigramJaccard(a, a) - 1) > 1e-12) return 'self not 1';
  return true;
});

suite('memory:_dedupeNear', 5000, (rnd) => {
  const hits = [];
  const n = int(rnd, 0, 8);
  for (let i = 0; i < n; i++) {
    if (chance(rnd, 0.05)) { hits.push(null); continue; }
    hits.push({
      score: rnd(),
      doc: {
        src: pick(rnd, ['对话', '事实', '结论', '?']),
        id: chance(rnd, 0.7) ? 'id' + int(rnd, 0, 5) : undefined,
        text: chance(rnd, 0.15) ? '' : (chance(rnd, 0.4) ? evilString(rnd, 30) : cjkTitle(rnd, 14)),
      },
    });
  }
  return { hits, limit: pick(rnd, [0, 1, 2, 3, 5, 10]) };
}, (inp) => {
  const ctx1 = { _quality: { dedupFolded: 0 } };
  const out1 = M.prototype._dedupeNear.call(ctx1, inp.hits, inp.limit);
  if (!Array.isArray(out1)) return 'not array';
  if (out1.length > inp.hits.length) return 'grew';
  if (inp.limit > 0 && out1.length > inp.limit) return 'exceeded limit';
  const ids = new Set();
  for (const h of out1) {
    if (!inp.hits.includes(h)) return 'invented hit';
    const d = h.doc;
    const idKey = d.id ? String(d.src || '?') + '|' + String(d.id) : '';
    if (idKey) {
      if (ids.has(idKey)) return 'duplicate id in output';
      ids.add(idKey);
    }
  }
  if (!Number.isFinite(ctx1._quality.dedupFolded) || ctx1._quality.dedupFolded < 0) return 'bad folded counter';
  if (ctx1._quality.dedupFolded > inp.hits.length) return 'folded counter too high';
  const ctx2 = { _quality: { dedupFolded: 0 } };
  const out2 = M.prototype._dedupeNear.call(ctx2, inp.hits, inp.limit);
  if (out1.length !== out2.length || out1.some((h, i) => h !== out2[i])) return 'nondeterministic';
  return true;
});

// ═══════════════════════════════════════════════════════════════════════
// 6. rss-brief/lib/score.js
// ═══════════════════════════════════════════════════════════════════════
const SC = require(path.join(NEURO, 'plugins/community/rss-brief/lib/score.js'));
const INTERESTS = ['ai', '模型', '猫', 'gpt', '新闻', '.*(', '[', 'c++', '😀', 'a'.repeat(50), ''];
function genScoreItem(rnd) {
  const item = {};
  if (chance(rnd, 0.9)) item.title = chance(rnd, 0.5) ? cjkTitle(rnd, 20) : evilString(rnd, 120);
  if (chance(rnd, 0.7)) item.summary = evilString(rnd, 200);
  if (chance(rnd, 0.8)) {
    item.published_at = pick(rnd, [
      Date.now() - int(rnd, 0, 200) * 3600000,
      new Date(Date.now() - int(rnd, 0, 200) * 3600000).toISOString(),
      Date.now() + int(rnd, 0, 5) * 3600000,
      0, -1e12, NaN, Infinity, 'garbage', '', null,
      new Date(Date.now() - int(rnd, 0, 100) * 3600000),
    ]);
  }
  if (chance(rnd, 0.5)) item.fetched_at = pick(rnd, [Date.now(), Date.now() - 3600000, '2026-11-21', NaN, null]);
  const opts = {
    now: pick(rnd, [Date.now(), Date.now() - int(rnd, 0, 100) * 3600000, '2026-11-21T00:00:00Z', new Date(), null]),
    interests: chance(rnd, 0.8) ? Array.from({ length: int(rnd, 0, 6) }, () => pick(rnd, INTERESTS)) : pick(rnd, [null, [], 'x']),
    sourceTrust: pick(rnd, [rnd(), 0, 1, -1, 2, NaN, '0.7', null]),
    recentTitles: chance(rnd, 0.7) ? Array.from({ length: int(rnd, 0, 4) }, () => (chance(rnd, 0.5) ? cjkTitle(rnd, 14) : evilString(rnd, 40))) : [],
  };
  if (chance(rnd, 0.3)) opts.pushedCount = pick(rnd, [0, 1, 10, NaN, -1]);
  if (chance(rnd, 0.3)) opts.clickCount = pick(rnd, [0, 1, NaN, '2']);
  if (chance(rnd, 0.1)) opts.coldStart = chance(rnd, 0.5);
  return { item, opts };
}
suite('rss-score:scoreItem', 5000, genScoreItem, ({ item, opts }) => {
  const r1 = SC.scoreItem(item, opts);
  if (!r1 || typeof r1 !== 'object') return 'non-object';
  for (const k of ['score', 'recency', 'interest', 'sourceTrust', 'novelty']) {
    if (!Number.isFinite(r1[k])) return k + ' not finite: ' + r1[k];
    if (r1[k] < 0 || r1[k] > 1) return k + ' out of [0,1]: ' + r1[k];
  }
  if (!Number.isFinite(r1.ageHours) || r1.ageHours < 0) return 'ageHours invalid';
  if (typeof r1.dup !== 'boolean' || typeof r1.dropped !== 'boolean') return 'flags not boolean';
  if (r1.dropped && r1.score !== 0) return 'dropped but score!=0';
  if (r1.dup && r1.score !== 0) return 'dup but score!=0';
  if (r1.reason !== undefined && typeof r1.reason !== 'string') return 'reason not string';
  if (Number.isFinite(SC.toMs(opts.now))) {
    const r2 = SC.scoreItem(item, opts);
    if (!isDeepStrictEqual(r1, r2)) return 'nondeterministic';
  }
  return true;
});
const SCORE_CONTRACT = [
  () => SC.scoreItem({ title: 'x', published_at: Date.now() - 100 * 3600000 }, { now: Date.now() }).dropped === true,
  () => {
    const r = SC.scoreItem({ title: 'x', published_at: Date.now() + 3600000 }, { now: Date.now() });
    return r.dropped === false && r.ageHours === 0 && r.recency === 1;
  },
  () => SC.scoreItem({ title: 'x', published_at: 'garbage' }, { now: Date.now() }).dropped === false,
  () => SC.scoreItem({ title: 'OpenAI发布GPT-6模型' }, { now: Date.now(), recentTitles: ['OpenAI发布GPT-6模型'] }).dup === true,
  () => SC.scoreItem({ title: 'x' }, { now: Date.now(), sourceTrust: NaN }).sourceTrust === 0.5,
  () => SC.scoreItem({ title: 'x' }, { now: Date.now(), pushedCount: 0 }).coldStart === true,
  () => SC.computeInterest({ title: 'ai 模型 猫 gpt 新闻' }, ['ai', '模型', '猫', 'gpt', '新闻']) === 1,
  () => SC.normalizeUrl('https://Example.com/a/?b=2&a=1&utm_source=x#frag') === 'https://example.com/a?a=1&b=2',
  () => SC.normalizeUrl('//example.com/a/') === 'https://example.com/a',
];
suite('rss-score:contract', SCORE_CONTRACT.length, (rnd, i) => i, (i) => (
  SCORE_CONTRACT[i]() === true ? true : 'contract case ' + i + ' failed'
));

suite('rss-score:cluster+select', 500, (rnd) => {
  const items = [];
  const n = int(rnd, 0, 15);
  const titlePool = [cjkTitle(rnd, 8), cjkTitle(rnd, 8), cjkTitle(rnd, 8), evilString(rnd, 20)];
  for (let i = 0; i < n; i++) {
    const it = {
      id: 'i' + i,
      title: chance(rnd, 0.75) ? pick(rnd, titlePool) : evilString(rnd, 20),
      link: pick(rnd, ['https://a.com/x', 'https://a.com/x/', 'https://A.com/x?utm_source=1', 'https://b.com/y?q=2&a=1', '', evilString(rnd, 15)]),
      score: pick(rnd, [rnd(), NaN, 0, 1, Infinity]),
      published_at: pick(rnd, [Date.now(), Date.now() - 3600000, '2026-11-21', NaN, undefined]),
      feed_id: 'f' + int(rnd, 0, 3),
    };
    if (chance(rnd, 0.2)) it.cluster_key = 'k' + int(rnd, 0, 2);
    items.push(it);
  }
  return { items, count: int(rnd, 0, 10), seed: chance(rnd, 0.3) ? items.slice(0, 2) : [] };
}, ({ items, count, seed }) => {
  const clusters = SC.clusterItems(items);
  let total = 0;
  const keys = new Set();
  for (const c of clusters) {
    if (keys.has(c.key)) return 'duplicate cluster key';
    keys.add(c.key);
    total += c.items.length;
    if (!(c.size >= 1)) return 'cluster size < 1';
    if (!items.includes(c.representative)) return 'representative not a member';
  }
  if (total !== items.length) return 'cluster partition lost items: ' + total + '/' + items.length;
  const clusters2 = SC.clusterItems(items);
  if (clusters.map((c) => c.key).join(',') !== clusters2.map((c) => c.key).join(',')) return 'cluster nondeterministic';
  const picked = SC.selectDiverse(items, count, {});
  if (picked.length > Math.min(count, items.length)) return 'select overflow';
  if (new Set(picked).size !== picked.length) return 'select duplicate';
  const picked2 = SC.selectDiverse(items, count, {});
  if (picked.map((x) => x && x.id).join('|') !== picked2.map((x) => x && x.id).join('|')) return 'select nondeterministic';
  const p3 = SC.selectDiverse(items, count, { selected: seed });
  const used = new Set(seed.map((x) => (x.cluster_key ? 'c:' + x.cluster_key : 'i:' + x.id)));
  for (const x of p3) {
    const key = x.cluster_key ? 'c:' + x.cluster_key : 'i:' + x.id;
    if (used.has(key)) return 'selected seed cluster reused';
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════════════
// 7. rss-brief _sanitizeCard
// ═══════════════════════════════════════════════════════════════════════
const R = require(path.join(NEURO, 'plugins/community/rss-brief/index.js'));
const sanitizeCard = R.prototype._sanitizeCard;
suite('rss-brief:_sanitizeCard', 5000, (rnd) => {
  if (chance(rnd, 0.08)) return pick(rnd, [null, undefined, 123, 'x', [], true]);
  const card = {
    at: pick(rnd, [Date.now(), '2026-11-21', '', null, { x: 1 }, 123, evilString(rnd, 20)]),
    items: Array.from({ length: int(rnd, 0, 12) }, () => {
      if (chance(rnd, 0.08)) return pick(rnd, [null, 0, 'str', [1, 2], true, undefined]);
      const scoreRoll = rnd();
      return {
        title: chance(rnd, 0.1) ? 'T'.repeat(300) : evilString(rnd, 30),
        feed: chance(rnd, 0.1) ? 'F'.repeat(100) : evilString(rnd, 50),
        at: pick(rnd, ['2026-11-21', Date.now(), null, 5, evilString(rnd, 10)]),
        score: scoreRoll < 0.8 ? rnd()
          : scoreRoll < 0.86 ? NaN
            : scoreRoll < 0.92 ? '0.5'
              : scoreRoll < 0.96 ? null
                : scoreRoll < 0.98 ? Infinity : -Infinity,
      };
    }),
    delivered: Array.from({ length: int(rnd, 0, 30) }, () => pick(rnd, [null, undefined, 'id' + int(rnd, 0, 99), 0, false, { a: 1 }, '', '😀'])),
  };
  return card;
}, (card) => {
  const out = sanitizeCard.call({}, card);
  if (!out || typeof out !== 'object') return 'non-object';
  if (typeof out.at !== 'string') return 'at not string';
  if (!Array.isArray(out.items) || out.items.length > 5) return 'items length';
  for (const it of out.items) {
    if (typeof it.title !== 'string' || it.title.length > 120) return 'title bad';
    if (typeof it.feed !== 'string' || it.feed.length > 40) return 'feed bad';
    if (typeof it.at !== 'string') return 'item.at not string';
    if (typeof it.score !== 'number') return 'score not number';
    if (!Number.isFinite(it.score)) return 'non-finite score kept: ' + it.score;
  }
  if (!Array.isArray(out.delivered) || out.delivered.length > 20) return 'delivered length';
  if (out.delivered.some((x) => typeof x !== 'string')) return 'delivered element not string';
  return true;
});

// ═══════════════════════════════════════════════════════════════════════
// 8. pet-runtime perf: applyFACS + claim
// ═══════════════════════════════════════════════════════════════════════
const P = require(path.join(ROOT, 'pet-runtime/desktop/perf/profile.mjs'));
const { PROFILE_SPECS, buildProfile, applyFACS } = P;
const allParams = new Set();
for (const outs of Object.values(PROFILE_SPECS.jellyfish.channels)) {
  for (const o of outs) if (o.param) allParams.add(o.param);
}
const facsProfile = buildProfile(PROFILE_SPECS.jellyfish, { paramIds: allParams });
const FACS_BOUNDS = new Map();
for (const outs of Object.values(facsProfile.channels)) {
  for (const o of outs) {
    if (o.kind !== 'param') continue;
    const [lo, hi] = o.range || (o.absolute ? [0, 1.5] : [-1, 1]);
    const b = FACS_BOUNDS.get(o.id) || [Infinity, -Infinity];
    b[0] = Math.min(b[0], lo); b[1] = Math.max(b[1], hi);
    FACS_BOUNDS.set(o.id, b);
  }
}
const FACS_CHANNELS = Object.keys(PROFILE_SPECS.jellyfish.channels);
const FACS_WEIRD = [NaN, Infinity, -Infinity, '0.5', '', null, true, false, 1e308, -1e308, 'abc'];
function genFacs(rnd) {
  const facs = {};
  for (const ch of FACS_CHANNELS) {
    if (!chance(rnd, 0.65)) continue;
    facs[ch] = chance(rnd, 0.8) ? (rnd() * 2 - 1) : pick(rnd, FACS_WEIRD);
  }
  const baseline = {};
  for (const [id] of FACS_BOUNDS) {
    if (chance(rnd, 0.35)) baseline[id] = chance(rnd, 0.8) ? (rnd() * 3 - 1.5) : pick(rnd, FACS_WEIRD);
  }
  return { facs, baseline };
}
suite('perf:applyFACS', 10000, genFacs, ({ facs, baseline }) => {
  const out = applyFACS(facs, facsProfile, baseline);
  if (!out || typeof out !== 'object') return 'non-object';
  if (!out.params || typeof out.params !== 'object') return 'params missing';
  for (const [id, v] of Object.entries(out.params)) {
    if (!Number.isFinite(v)) return 'non-finite param ' + id + '=' + v;
    const b = FACS_BOUNDS.get(id);
    if (!b) return 'unknown param ' + id;
    if (v < b[0] - 1e-9 || v > b[1] + 1e-9) return 'param ' + id + ' outside declared range [' + b + ']: ' + v;
    if (v < -1 || v > 1) NOTES.applyFACSOutOfUnit += 1;
  }
  if (!Array.isArray(out.expressions)) return 'expressions not array';
  for (const e of out.expressions) {
    if (typeof e.name !== 'string') return 'expression name';
    if (!Number.isFinite(e.weight) || e.weight < 0 || e.weight > 1) return 'expression weight out of range';
  }
  for (let i = 1; i < out.expressions.length; i++) {
    if (out.expressions[i - 1].weight < out.expressions[i].weight) return 'expressions not sorted';
  }
  return true;
});
const exprProfile = buildProfile({
  modelId: 'test', displayName: 'test',
  channels: {
    mouthSmile: [{ expression: 'exp3', gain: 0.8, threshold: 0.2 }],
    mouthFrown: [{ expression: 'exp3', gain: 1.2, threshold: 0.5 }],
  },
}, { expressions: ['exp3'] });
suite('perf:applyFACS-expressions', 5000, (rnd) => ({
  mouthSmile: chance(rnd, 0.8) ? (rnd() * 3 - 1) : pick(rnd, FACS_WEIRD),
  mouthFrown: chance(rnd, 0.8) ? (rnd() * 3 - 1) : pick(rnd, FACS_WEIRD),
}), (facs) => {
  const out = applyFACS(facs, exprProfile, {});
  if (out.expressions.length > 1) return 'more than one expression entry';
  for (const e of out.expressions) {
    if (!Number.isFinite(e.weight) || e.weight < 0 || e.weight > 1) return 'weight out of [0,1]';
  }
  return true;
});

const A = require(path.join(ROOT, 'pet-runtime/desktop/perf/performance-arbiter.mjs'));
const arbClock = { t: 0 };
const claim = A.createPerformanceClaim({ now: () => arbClock.t });
const OWNERS = ['clip', 'v2', 'manual', 'scenes', 'micro', 'weird', '', undefined];
let busyStreak = 0;
suite('perf:claim-sequence', 10000, (rnd) => {
  arbClock.t += int(rnd, 0, 700);
  const r = rnd();
  if (r < 0.55) {
    const meta = {};
    if (chance(rnd, 0.7)) meta.key = 'k' + int(rnd, 0, 5);
    if (chance(rnd, 0.6)) meta.durationMs = pick(rnd, [0, 100, 1000, -50, NaN, Infinity, 1e9]);
    if (chance(rnd, 0.3)) meta.ttlMs = pick(rnd, [0, -1, 50, 5000, NaN, Infinity]);
    if (chance(rnd, 0.2)) meta.token = 't' + int(rnd, 0, 5);
    if (chance(rnd, 0.3)) meta.preempt = true;
    return { op: 'claim', owner: pick(rnd, OWNERS), meta };
  }
  if (r < 0.75) return { op: 'release', owner: pick(rnd, OWNERS), token: chance(rnd, 0.5) ? claim.token : undefined };
  if (r < 0.85) return { op: 'expire' };
  return { op: 'snapshot' };
}, (op) => {
  if (op.op === 'claim') {
    const res = claim.claim(op.owner, op.meta);
    if (!res || typeof res.ok !== 'boolean') return 'bad result';
    const name = String(op.owner || '');
    if (res.ok) {
      busyStreak = 0;
      if (claim.owner !== name) return 'ok but owner mismatch';
      if (name === '') NOTES.emptyOwnerClaims += 1;
      if (res.token === undefined || res.token === null) return 'ok without token';
      // durationMs/ttlMs 未做有限性校验：Infinity 会让 expiresAt=Infinity，永不自动过期
      if (op.meta.durationMs === Infinity) NOTES.claimInfiniteDuration += 1;
      const snap = claim.snapshot();
      if (!Number.isFinite(snap.durationMs) || !Number.isFinite(snap.expiresInMs)) {
        const why = 'non-finite claim duration/expiry (durationMs=' + snap.durationMs + ', expiresInMs=' + snap.expiresInMs + ')';
        claim.reset(); // 清掉永不过期的 holder，避免污染后续序列
        return why;
      }
    } else {
      busyStreak += 1;
      if (busyStreak > 800) return 'possible deadlock: 800 consecutive busy';
      if (res.reason !== 'busy') return 'non-busy failure: ' + res.reason;
      if (!res.holder) return 'busy without holder';
      if (res.holder === name) return 'busy on same owner';
      if (claim.availableFor(op.owner)) return 'busy but availableFor true';
    }
    return true;
  }
  if (op.op === 'release') {
    const before = claim.owner;
    const res = claim.release(op.owner, op.token);
    if (res) {
      if (claim.owner !== null) return 'release ok but owner remains';
      busyStreak = 0;
    } else if (before === String(op.owner || '') && op.token === undefined) {
      if (String(op.owner || '') === '') NOTES.emptyOwnerReleaseStuck = (NOTES.emptyOwnerReleaseStuck || 0) + 1;
      else return 'release failed for current owner without token';
    }
    return true;
  }
  if (op.op === 'expire') {
    const snap = claim.snapshot();
    if (!Number.isFinite(snap.expiresInMs)) {
      // Infinity 过期时间：直接释放，避免把假时钟推进到 Infinity 污染后续序列
      claim.release(snap.owner, snap.token);
    } else if (snap.expiresInMs > 0) {
      arbClock.t = Math.max(arbClock.t, arbClock.t + snap.expiresInMs + 1);
      const after = claim.owner;
      if (after !== null) return 'expired holder still owns';
    } else if (snap.owner) {
      claim.release(snap.owner, snap.token);
    }
    return true;
  }
  const snap = claim.snapshot();
  if (typeof snap.owner !== 'string' && snap.owner !== null) return 'owner type';
  for (const k of ['forMs', 'durationMs', 'expiresInMs', 'priority']) {
    if (!Number.isFinite(snap[k])) return 'snapshot ' + k + ' not finite';
  }
  if (!snap.stats || !Number.isFinite(snap.stats.claims)) return 'stats missing';
  return true;
});

const sessClock = { t: 0 };
const arbiter = A.createPerformanceArbiter({ now: () => sessClock.t });
suite('perf:arbiter-session', 3000, (rnd) => {
  sessClock.t += int(rnd, 0, 500);
  if (chance(rnd, 0.45)) {
    return {
      op: 'begin', owner: pick(rnd, ['clip', 'v2', 'manual', 'scenes', 'micro']),
      meta: { key: 'k' + int(rnd, 0, 3), durationMs: pick(rnd, [0, 500, 3000]), preempt: chance(rnd, 0.25) },
    };
  }
  if (chance(rnd, 0.8)) return { op: 'end', owner: pick(rnd, ['clip', 'v2', 'manual', 'scenes', 'micro']), token: arbiter.token };
  return { op: 'status' };
}, (op) => {
  if (op.op === 'begin') {
    const res = arbiter.begin(op.owner, op.meta);
    if (!res || typeof res.ok !== 'boolean') return 'bad begin result';
    if (res.ok) {
      if (res.token === null || res.session === null) return 'ok without token/session';
      if (!res.session.active) return 'session not active';
      if (res.session.owner !== op.owner) return 'session owner mismatch';
      if (arbiter.owner !== op.owner) return 'arbiter owner mismatch';
    } else {
      if (res.token !== null || res.session !== null) return 'busy but carries session';
      if (res.reason !== 'busy') return 'non-busy begin failure';
    }
    return true;
  }
  if (op.op === 'end') {
    const ownerBefore = arbiter.owner;
    const res = arbiter.end(op.owner, op.token);
    if (res) {
      if (arbiter.owner !== null) return 'end ok but owner remains';
      if (arbiter.session.status().active) return 'end ok but session active';
    } else if (ownerBefore === op.owner) {
      return 'end failed for current owner';
    }
    return true;
  }
  const st = arbiter.snapshot();
  if (!st.claim || !st.session) return 'snapshot shape';
  if (!Number.isFinite(st.claim.stats.claims)) return 'claim stats';
  if (!Number.isFinite(st.session.elapsedMs) || st.session.elapsedMs < 0) return 'session elapsed';
  if (st.session.active && (!Number.isFinite(st.session.t) || !Number.isFinite(st.session.duration))) return 'session t/duration';
  return true;
});

// ═══════════════════════════════════════════════════════════════════════
// 9. tts-playback-engine: playResult + viseme
// ═══════════════════════════════════════════════════════════════════════
const TTS_PATH = path.join(NEURO, 'js/voice/tts-playback-engine.js');
const TTS_SRC = fs.readFileSync(TTS_PATH, 'utf8');
const PLAYRESULT_M = TTS_SRC.match(/function playResult\(status, reason\) \{([\s\S]*?)\n\}/);
if (!PLAYRESULT_M) throw new Error('playResult source not found');
const playResult = new Function('status', 'reason', PLAYRESULT_M[1]);
const CALL_SITE_STATUSES = [...TTS_SRC.matchAll(/playResult\('([^']*)'/g)].map((m) => m[1]);
const ALLOWED_STATUS = new Set(['completed', 'stopped', 'error', 'skipped']);
suite('tts:playResult', 5000, (rnd) => ({
  status: chance(rnd, 0.7) ? pick(rnd, [...ALLOWED_STATUS]) : evilString(rnd, 12),
  reason: pick(rnd, [undefined, null, '', 'why', 0, 123, { a: 1 }, evilString(rnd, 20)]),
}), ({ status, reason }) => {
  const out = playResult(status, reason);
  if (!out || typeof out !== 'object') return 'non-object';
  if (out.status !== status) return 'status mismatch';
  if (typeof out.completed !== 'boolean' || out.completed !== (status === 'completed')) return 'completed flag';
  if (typeof out.error !== 'boolean' || out.error !== (status === 'error')) return 'error flag';
  if (typeof out.stopped !== 'boolean' || out.stopped !== (status === 'stopped')) return 'stopped flag';
  if (reason) {
    if (typeof out.reason !== 'string') return 'reason not string';
  } else if ('reason' in out) return 'reason present for falsy input';
  return true;
});
suite('tts:playResult-callsites', CALL_SITE_STATUSES.length || 1, (rnd, i) => CALL_SITE_STATUSES[i], (s) => (
  s === undefined ? 'no call sites found' : (ALLOWED_STATUS.has(s) ? true : 'unknown status in call site: ' + s)
));

const T = require(path.join(NEURO, 'js/voice/tts-playback-engine.js'));
const V = require(path.join(NEURO, 'js/voice/viseme.js'));
const ttsEngine = new T.TTSPlaybackEngine({}, null, null, null);
const VISEME_PUNCT = /[\s，。！？、；：""''（）()]/;
function genVisemeCase(rnd) {
  const r = rnd();
  const text = r < 0.1 ? '' : (r < 0.2
    ? pick(rnd, ['，。！？ ', '   ', '。。。'])
    : evilString(rnd, chance(rnd, 0.02) ? 2000 : 400));
  return {
    text,
    timeSec: pick(rnd, [0, rnd() * 10, -1, NaN, Infinity, -Infinity, rnd() * 1e6]),
    durationSec: pick(rnd, [0, -1, NaN, 0.001, rnd() * 30, 1, 120, Infinity]),
  };
}
suite('tts:viseme-index', 5000, genVisemeCase, ({ text, timeSec, durationSec }) => {
  ttsEngine.currentSegmentText = text;
  let plan = null;
  if (durationSec > 0) {
    plan = ttsEngine._buildVisemePlan(text, durationSec);
    if (!plan || !Array.isArray(plan.positions)) return 'plan positions missing';
    if (!Number.isFinite(plan.msPerChar) || plan.msPerChar < 60 || plan.msPerChar > 300) return 'msPerChar out of [60,300]: ' + plan.msPerChar;
    let last = -1;
    for (const idx of plan.positions) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= text.length) return 'position out of text';
      if (idx <= last) return 'positions not strictly increasing';
      if (VISEME_PUNCT.test(text[idx])) return 'punctuation kept in positions';
      last = idx;
    }
  }
  const hit = ttsEngine._visemeCharAt(timeSec, durationSec);
  if (!hit || typeof hit !== 'object') return 'hit not object';
  if (hit.text !== text) return 'hit.text mismatch';
  if (!Number.isInteger(hit.index) || !Number.isInteger(hit.ordinal)) return 'index/ordinal not integer';
  const expectedEarly = !text || !(durationSec > 0) || (plan && plan.positions.length === 0);
  if (expectedEarly) {
    if (hit.index !== -1 || hit.ordinal !== -1) return 'expected -1 for empty/invalid input';
    if (hit.ch !== '') return 'expected empty ch';
    return true;
  }
  if (hit.index < 0 || hit.index >= text.length) return 'index out of text length';
  if (hit.ch !== text[hit.index]) return 'ch/index mismatch';
  if (hit.ordinal < 0 || hit.ordinal >= plan.positions.length) return 'ordinal out of positions';
  const tSec = Number(timeSec) || 0;
  const wantOrdinal = Math.min(plan.positions.length - 1,
    Math.max(0, Math.floor((tSec * 1000) / (plan.msPerChar || 100))));
  if (hit.ordinal !== wantOrdinal) return 'ordinal computation mismatch';
  return true;
});
suite('tts:viseme-openness', 5000, (rnd) => ({
  final: chance(rnd, 0.5) ? pick(rnd, ['a', 'o', 'e', 'i', 'u', 'v', 'iu', 'ui', 'un', 'n', 'm', 'ng', 'ang', '']) : evilString(rnd, 20),
  ch: chance(rnd, 0.5) ? pick(rnd, ['a', '你', '😀', '\uD800', '', null, undefined]) : evilString(rnd, 3),
}), ({ final, ch }) => {
  const o = V.opennessForFinal(final);
  if (!Number.isFinite(o) || o < 0 || o > 1) return 'openness out of [0,1]: ' + o;
  const shape = V.shapeFor(ch);
  if (shape !== null && (!Number.isFinite(shape) || shape < 0 || shape > 1)) return 'shape out of [0,1]';
  return true;
});

// ── 独立小探针：Symbol 直达 applyFACS 是否抛（JSON 不可能产生，仅记录） ──
let symbolProbe = 'ok';
try { applyFACS({ browDown: Symbol('x') }, facsProfile); }
catch (e) { symbolProbe = 'THROW ' + e.message; }

// ═══════════════════════════════════════════════════════════════════════
// 报告
// ═══════════════════════════════════════════════════════════════════════
function fmtMs(v) {
  if (v < 0.001) return v.toExponential(2);
  if (v < 0.1) return v.toFixed(4);
  return v.toFixed(2);
}
console.log('\n');
console.log('模块 | 次数 | 总耗时ms | p50/op ms | p95/op ms | max/op ms | 失败数 | 最差失败输入(≤200)');
console.log('---|---|---|---|---|---|---|---');
for (const r of results) {
  const worst = r.examples[0] ? preview(r.examples[0].input, 200) : '-';
  console.log(`${r.name} | ${r.n} | ${r.wallMs.toFixed(1)} | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${fmtMs(r.max)} | ${r.fails} | ${worst}`);
}
const slow = results.filter((r) => r.wallMs > 2000);
console.log('\n>2s 项: ' + (slow.length ? slow.map((r) => r.name + '=' + r.wallMs.toFixed(0) + 'ms').join(', ') : '无'));
console.log('applyFACS 输出落在 [-1,1] 之外的值次数: ' + NOTES.applyFACSOutOfUnit + '（绝对通道 eyeOpen 声明范围 [0,1.5]，属预期）');
console.log('secret-mask 幂等失败中「secret:null → ""」型: ' + NOTES.secretNullRoundTrip +
  (NOTES.secretOther ? ('；其他型: ' + NOTES.secretOther) : ''));
if (NOTES.secretOtherSample) console.log('secret-mask 其他型样例: ' + NOTES.secretOtherSample);
if (NOTES.secretOrderOnly) console.log('secret-mask 仅键序不同型: ' + NOTES.secretOrderOnly + ' 样例: ' + NOTES.secretOrderSample);
console.log('claim 接受空 owner 的次数: ' + NOTES.emptyOwnerClaims + '；空 owner 无法 release 的次数: ' + (NOTES.emptyOwnerReleaseStuck || 0));
console.log('claim 接受 durationMs=Infinity 的次数: ' + NOTES.claimInfiniteDuration);
console.log('applyFACS(Symbol) 探针: ' + symbolProbe);
console.log('playResult 调用点 status: ' + JSON.stringify([...new Set(CALL_SITE_STATUSES)]));

const failed = results.filter((r) => r.fails > 0);
if (failed.length) {
  console.log('\n===== 失败样例 =====');
  for (const r of failed) {
    console.log('\n## ' + r.name + ' 失败 ' + r.fails + '/' + r.n);
    const top = [...r.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log('  原因分布: ' + top.map(([k, v]) => v + '× ' + k).join(' | '));
    for (const ex of r.examples) {
      console.log('  why: ' + ex.why);
      console.log('  input: ' + ex.input);
    }
  }
} else {
  console.log('\n全部套件 0 失败。');
}
console.log('\nSEED=' + SEED + '（固定，可复现）');
process.exitCode = failed.length ? 1 : 0;
