// js/core/voice-style.js —— 语义语气层（2026-11-17）
//
// 它做什么：常驻语义服务（8120）除了 27 类情绪外观，还给 14 类「语音风格」（voice）。
// 这里把风格翻成 rate/pitch/energy 的**乘法增益**，叠在项目已有的「情绪→语气」之上，
// 只影响 TTS 的三个旋钮，不碰表情、不碰情绪引擎。
//
// ⚠ 为什么默认关闭（必须 `config.voice_style.enabled === true` 才生效）：
//   项目里**已经有一条语气链路**——driver.js 每 1.2s 把 {emotion, strength} 推到
//   9883/prosody，tts_server.py 用 PROSODY 表算 rate/pitch/volume（doctor「语气链路」）。
//   语义 voice 是**第二个说话人**：它按「这句台词的情绪描述」判风格，可能和情绪引擎
//   结论相反（引擎说 happy、语义说 vulnerable）。两套都按全量生效就会双源打架：
//   同一句话前半句被情绪抬起、后半句被语义压下，听感是抖动，比没有风格更糟。
//   所以先关着，由用户按听感决定开不开；关掉 = 一行配置，也就是回滚开关。
//
// 三条硬边界（保证「多出来的一层」永不反客为主）：
//   ① 只做乘法，增益夹在 [0.9, 1.1]——不抹平也不放大情绪链路已有的起伏；
//   ② 按句子键存放 + one-shot + TTL——绝不粘到后面几句，也不跨轮复活；
//   ③ 服务失败/超时/置信度不足 → 返回 base 的**逐字段拷贝**，调用方完全无感。
//
// 为什么不用「一个槽」：`processTextToSpeech` 会把整段回复一次性切成多句入队，
// 每句都会各自预取。单槽会被最后一句覆盖，其余句子全部匹配不上（实测冒烟）。
// 所以状态是一张**按句子文本索引的小表**（上限 16，超了就淘汰最旧），
// 既保持「薄」，又让每句各吃各的。
//
// 用法（接线方）：
//   configure(config.voice_style);                       // 读开关（每轮/每次请求）
//   classify({ intent: 句子, timeoutMs: 900 })
//     .then((r) => ingestSemantic(r, { text: 句子 }));    // 异步预取，不挡合成
//   const out = applyToProsody(baseProsody, Date.now(), 句子);  // 同步、零网络

'use strict';

const { VOICE_TO_PROSODY } = require('./lumen-semantic.js');

/** 参与增益的三个旋钮（与 VOICE_TO_PROSODY 的字段一一对应） */
const FIELDS = ['rate', 'pitch', 'energy'];
/** 单次增益上限：±10%。超过就开始「不像她」，而且会盖过情绪链路的区分度。 */
const GAIN_MIN = 0.9;
const GAIN_MAX = 1.1;
/** 语义置信度门槛：低于它宁可不用（宁可没有，不要喂错） */
const MIN_CONFIDENCE = 0.5;
/** 单句默认有效期：整段回复一次入队、按 ~1.2s/句合成，12s 够 10 句；跨轮由 reset 兜底 */
const DEFAULT_TTL_MS = 12000;
const MAX_TTL_MS = 20000;
/** 小表上限：正常一次回复远不到 16 句；超了淘汰最旧的（宁可少一句风格，不涨内存） */
const MAX_ENTRIES = 16;

// 薄状态：只记「这一句的 voice」，不累计、不推历史。
// 两次 ingest 同一句是覆盖而不是相乘——同一句被叠两次也是双源打架的一种。
const state = {
  enabled: false,
  ttlMs: DEFAULT_TTL_MS,
  entries: new Map(), // key = 句子原文；value = { voice, gains:{rate,pitch,energy}, confidence, at }
  counts: { ingested: 0, applied: 0, expired: 0, lowConfidence: 0, failed: 0, disabled: 0, textMismatch: 0 },
};

/** 把任意数值夹成合法增益；非法值按 1（不变）处理，绝不把 NaN 传下去 */
function clampGain(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(GAIN_MAX, Math.max(GAIN_MIN, n));
}

/**
 * 纯函数：乘法叠加。**不改调用方对象**，返回新对象。
 * 只处理 base 里真实存在的字段——base 没有 pitch 时不会凭空造一个，
 * 这样调用方传 {rate,pitch,energy} 或 {rate,pitch,volume} 都能用。
 */
function applyGain(base, voiceGains) {
  const src = base && typeof base === 'object' ? base : {};
  const out = {};
  for (const k of Object.keys(src)) out[k] = src[k];
  const g = voiceGains && typeof voiceGains === 'object' ? voiceGains : {};
  for (const f of FIELDS) {
    const b = Number(src[f]);
    if (!Number.isFinite(b)) continue;
    // 夹的是**增益**（out/base 的比值），不是绝对值：
    // base 是情绪链路已经算好的率/偏移，直接把绝对值夹到 [0.9,1.1] 会把
    // 情绪自己的 +8Hz 音调整个抹掉——那才是真正的「双源打架」。
    out[f] = b * clampGain(g[f]);
  }
  return out;
}

/** 浅拷贝 base（无增益时用，保证「输出与 base 完全相同」连引用都不共享） */
function copyBase(base) {
  const out = {};
  const src = base && typeof base === 'object' ? base : {};
  for (const k of Object.keys(src)) out[k] = src[k];
  return out;
}

/** 清掉过期项；顺手按时间淘汰到上限内 */
function prune(now) {
  for (const [k, e] of state.entries) {
    if (now - e.at > state.ttlMs) {
      state.entries.delete(k);
      state.counts.expired += 1;
    }
  }
  while (state.entries.size > MAX_ENTRIES) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, e] of state.entries) {
      if (e.at < oldestAt) { oldestAt = e.at; oldestKey = k; }
    }
    if (oldestKey === null) break;
    state.entries.delete(oldestKey);
  }
}

/**
 * 读配置。缺省即关闭；旧版没有 voice_style 段时 enabled 恒 false，行为零变化。
 * 关闭时顺手清空已缓存的结果——关就是关，不留半截状态。
 */
function configure(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  state.enabled = c.enabled === true;
  const ttl = Number(c.ttl_ms);
  state.ttlMs = Number.isFinite(ttl) && ttl >= 200 && ttl <= MAX_TTL_MS ? ttl : DEFAULT_TTL_MS;
  if (!state.enabled) state.entries.clear();
  return state.enabled;
}

/** voice 自己的置信度优先；字段缺失才回落到整体置信度（0 是「明确不确定」，不能回落）。 */
function confidenceOf(r) {
  if (!r || typeof r !== 'object') return 0;
  if (typeof r.voiceConfidence === 'number' && Number.isFinite(r.voiceConfidence)) return r.voiceConfidence;
  const c = Number(r.confidence);
  return Number.isFinite(c) ? c : 0;
}

/**
 * 记下本句的语义 voice。
 * - `result` 直接吃 lumen-semantic-client 的返回；`ok:false` 一律不生效（服务挂了不能拖垮她说话）
 * - `opts.text` 强烈建议传：apply 时按句子文本取，防止「上一句的风格」粘到下一句
 * - `opts.nowMs` 只给单测注入时钟，生产不传
 * @returns {boolean} 是否被接受（仅用于观测/单测，调用方不需要处理）
 */
function ingestSemantic(result, opts) {
  const o = opts || {};
  if (!state.enabled) { state.counts.disabled += 1; return false; }
  if (!result || result.ok === false) { state.counts.failed += 1; return false; }

  const voice = String(result.voice || '').trim();
  const table = VOICE_TO_PROSODY[voice];
  if (!table) { state.counts.failed += 1; return false; } // 未知风格不猜

  const now = Number.isFinite(Number(o.nowMs)) ? Number(o.nowMs) : Date.now();
  // 统一 trim：调用方可能传段首带空格的分句（分段器原样入队），
  // 预取与取用时必须用同一把尺子，否则永远匹配不上。
  const key = o.text ? String(o.text).trim() : '';

  const conf = confidenceOf(result);
  if (!(conf >= MIN_CONFIDENCE)) {
    // 只清这一句：上一轮如果正好有同文本的残留，不能让它顶替这次的低置信度结论。
    // 不清别的句子——它们各自的预取还在队列里等着被合成。
    state.counts.lowConfidence += 1;
    state.entries.delete(key); // key 可能是 ''（无句子锚点的旧调用），同样要清
    return false;
  }

  state.entries.set(key, {
    voice,
    gains: { rate: clampGain(table.rate), pitch: clampGain(table.pitch), energy: clampGain(table.energy) },
    confidence: conf,
    at: now,
  });
  state.counts.ingested += 1;
  prune(now);
  return true;
}

/** 没有句子锚点时（2 参数旧调用），取最新的一条活结果 */
function latestLive(now) {
  let best = null;
  for (const e of state.entries.values()) {
    if (now - e.at > state.ttlMs) continue;
    if (!best || e.at > best.at) best = e;
  }
  return best;
}

/**
 * 取本句增益并吃掉它（one-shot），返回**新的** prosody。
 * 关闭 / 无结果 / 过期 / 句子不匹配 → 返回 base 的逐字段拷贝。
 * @param {object} base 现有语气（如 {rate,pitch,energy} 或 {rate,pitch,volume}）
 * @param {number} nowMs 当前时间（单测注入；生产传 Date.now()）
 * @param {string} [text] 本句原文；给了就只吃「同一句」的结果
 */
function applyToProsody(base, nowMs, text) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!state.enabled) return copyBase(base);

  let entry = null;
  let key = null;
  const anchor = text ? String(text).trim() : '';
  if (anchor) {
    key = anchor;
    entry = state.entries.get(key) || null;
    if (entry && now - entry.at > state.ttlMs) { state.entries.delete(key); state.counts.expired += 1; entry = null; }
    if (!entry) {
      if (state.entries.size > 0) state.counts.textMismatch += 1;
      return copyBase(base);
    }
  } else {
    entry = latestLive(now);
    if (!entry) return copyBase(base);
  }

  // one-shot：拿到就删。下一句必须重新问，哪怕文本一模一样。
  if (key) state.entries.delete(key);
  else {
    for (const [k, e] of state.entries) { if (e === entry) { state.entries.delete(k); break; } }
  }
  state.counts.applied += 1;
  return applyGain(base, entry.gains);
}

/** 清空本轮缓存（换轮/打断/重置时调用）；默认保留计数，`{stats:true}` 连计数一起清 */
function reset(opts) {
  state.entries.clear();
  if (opts && opts.stats === true) {
    for (const k of Object.keys(state.counts)) state.counts[k] = 0;
  }
}

/** 观测快照（排查「为什么这句话没风格」用）；`nowMs` 只给单测注入时钟 */
function stats(nowMs) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const live = [];
  for (const e of state.entries.values()) {
    if (now - e.at <= state.ttlMs) live.push(e);
  }
  live.sort((a, b) => b.at - a.at);
  const last = live[0] || null;
  return {
    enabled: state.enabled,
    ttlMs: state.ttlMs,
    pending: live.length,
    entry: last ? { voice: last.voice, confidence: last.confidence, ageMs: Math.max(0, now - last.at) } : null,
    counts: Object.assign({}, state.counts),
  };
}

/** 当前是否启用（接线方用来省掉一次 8120 请求） */
function isEnabled() {
  return state.enabled === true;
}

module.exports = {
  configure,
  isEnabled,
  ingestSemantic,
  applyToProsody,
  applyGain,
  clampGain,
  copyBase,
  reset,
  stats,
  VOICE_TO_PROSODY,
  MIN_CONFIDENCE,
  GAIN_MIN,
  GAIN_MAX,
  DEFAULT_TTL_MS,
};
