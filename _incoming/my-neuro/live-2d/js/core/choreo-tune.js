// js/core/choreo-tune.js —— 导演改戏（D6，2026-11-22）
//
// 提案原文：performance-log 回灌冷却/优先级（倍率夹 0.5–2）；≥20 次样本才调；
// 日均播放不降 >20%。
//
// 这个模块把 pet-runtime/data/performance-log.jsonl 变成两张查表：
//   segmentMultiplier  —— 优先级倍率（>1 = 更想让她演）
//   cooldownMultiplier —— 同段冷却倍率（>1 = 隔更久再演；与优先级互补）
// 倍率夹在 [0.5, 2]，样本 < 20 的键不输出（消费方缺省 = 1.0，行为不变）。
//
// 统计口径（全部读日志，不认识任何具体应用名/片段名）：
//   · 分母 = 「观察窗已满」的 play 记录（播完 90 秒内没等到用户输入，就是没回应）；
//   · 分子 = 与该次播放配对的 user_input_after（日志里一次播放最多配一条）；
//   · 被接率 = 分子/分母。按 clipId、label、emotion 三个维度各算一份，
//     消费方查找顺序：clipId → label → emotion（越具体越优先）。
//   · 相对基线（全日志被接率）做贝叶斯平滑，避免小样本噪声直接变成倍率。
//
// 保护闸：若按当前倍率估算，本周日均播放会被拉低到「上周」的 80% 以下，
// 整体回退到 1.0，并记 reverted: 'would_drop_too_much'。
// 日志不足两周（没有上周）时用「当前日均」当兜底基线，仍然拦住 >20% 的降幅；
// 只拦「本次调整会变少」的情况，调整会提高播放不拦。
//
// 开关：data/导演调参.json → {"enabled": false} 一键关（缺省视为开）。
//
// 纯函数 computeTuning(records, opts) 可直接单测；loadTuning() 只负责读文件与缓存。
'use strict';

// 这个模块会被 pet-runtime 的 petbody bundle 引用（esbuild 把 fs/path 标成 external，
// 运行时由 Electron 渲染层的 require 提供）。纯浏览器/没有 nodeIntegration 时
// require 可能不存在 —— 和 petbody-entry 的处理一致：拿不到 fs 就不调参，绝不炸整包。
let fs = null;
let path = null;
try { fs = require('fs'); } catch (e) { /* 纯浏览器：没有 fs */ }
try { path = require('path'); } catch (e) { /* 纯浏览器：没有 path */ }

// 与 pet-runtime/desktop/perf/performance-log.mjs 的 FOLLOW_WINDOW_MS 对齐。
const FOLLOW_WINDOW_MS = 90 * 1000;
const MULT_MIN = 0.5;
const MULT_MAX = 2;
const CONFIG_NAME = '导演调参.json';

const DEFAULT_OPTIONS = Object.freeze({
  enabled: true,             // 文件里写 false 才关；缺省开
  sampleMin: 20,             // 样本 < 20 不动
  revertDropPct: 0.2,        // 预计日均比上周降 >20% → 整体回退
  windowDays: 7,             // 「上周/本周」窗口
  cacheMs: 10 * 60 * 1000,   // 日志/配置没变时最多 10 分钟重算一次
  followWindowMs: FOLLOW_WINDOW_MS,
  baselineFloor: 0.02,       // 基线被接率下限（全日志 0 回应时不让公式爆炸）
  smoothing: 10,             // 贝叶斯平滑强度
  // 只学「导演自己决定的」播放：manual 是用户点名演的，用户接话不能证明导演选得对。
  autoOnly: true,
});

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampMult(value) {
  return Math.min(MULT_MAX, Math.max(MULT_MIN, value));
}

/** 解析 JSONL：坏行跳过并计数，不中断。 */
function parseLines(text) {
  const records = [];
  let bad = 0;
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec === 'object' && rec.kind) records.push(rec);
      else bad += 1;
    } catch (e) { bad += 1; }
  }
  return { records, bad };
}

/**
 * 把 play 与紧随其后的 user_input_after 配对。
 * 日志模块的语义是「一次播放最多配一条，且只配最近一次播放」，所以这里
 * 只在 clipId 相同、时差 ∈ [0, 90s]、且这次播放还没配过时才配对。
 * @returns {Array<{rec:object, after:object|null}>}
 */
function pairPlays(records, opts = {}) {
  const follow = Math.max(1, num(opts.followWindowMs, FOLLOW_WINDOW_MS));
  const plays = [];
  let last = null;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.kind === 'play') {
      last = { rec, after: null, paired: false };
      plays.push(last);
    } else if (rec.kind === 'user_input_after') {
      if (!last || last.paired) continue;
      if (String(rec.clipId || '') !== String(last.rec.clipId || '')) continue;
      const dt = Number(rec.ts) - Number(last.rec.ts);
      if (!Number.isFinite(dt) || dt < 0 || dt > follow) continue;
      last.after = rec;
      last.paired = true;
    }
  }
  return plays;
}

function safeKey(key) {
  const k = String(key == null || key === '' ? '(unknown)' : key);
  // 日志是本地文件，但键名最终会写进普通对象；保留字改成可读别名，避免原型污染。
  return (k === '__proto__' || k === 'constructor' || k === 'prototype') ? '(reserved:' + k + ')' : k;
}

function bump(map, key, hit) {
  const k = safeKey(key);
  const bucket = map.get(k) || { key: k, plays: 0, after: 0 };
  bucket.plays += 1;
  if (hit) bucket.after += 1;
  map.set(k, bucket);
}

function groupPlays(plays, opts, now) {
  const follow = Math.max(1, num(opts.followWindowMs, FOLLOW_WINDOW_MS));
  const bySegment = new Map();
  const byLabel = new Map();
  const byEmotion = new Map();
  let eligible = 0;
  let after = 0;

  for (const p of plays) {
    const ts = Number(p.rec.ts);
    // 观察窗未满的播放先不算：她刚演完 10 秒，不能断言「用户不会接」。
    if (!Number.isFinite(ts) || ts > now - follow) continue;
    eligible += 1;
    const hit = Boolean(p.after);
    if (hit) after += 1;
    bump(bySegment, p.rec.clipId, hit);
    bump(byLabel, p.rec.label, hit);
    bump(byEmotion, p.rec.emotion, hit);
  }

  return {
    eligible,
    after,
    baselineRate: eligible > 0 ? after / eligible : 0,
    bySegment,
    byLabel,
    byEmotion,
  };
}

/**
 * 被接率 → 倍率。用全日志基线做先验做平滑，再按相对差给倍率：
 *   高于基线 → 优先级 >1、冷却 <1；低于基线反之；夹在 [0.5, 2]。
 */
function multiplierFor(plays, after, baselineRate, opts = {}) {
  const prior = Math.max(num(baselineRate, 0), Math.max(0.0001, num(opts.baselineFloor, 0.02)));
  const alpha = Math.max(1, num(opts.smoothing, 10));
  const smoothed = (after + prior * alpha) / (plays + alpha);
  const delta = (smoothed - prior) / prior;
  const priority = clampMult(1 + delta);
  const cooldown = clampMult(1 / priority);
  return {
    priority: Math.round(priority * 1000) / 1000,
    cooldown: Math.round(cooldown * 1000) / 1000,
    smoothed: Math.round(smoothed * 10000) / 10000,
    delta: Math.round(delta * 1000) / 1000,
  };
}

/** 查表：clipId → label → emotion，缺失/非法 = 1。 */
function lookupMultiplier(map, keys) {
  if (!map || typeof map !== 'object') return 1;
  for (const key of keys) {
    if (key == null || key === '') continue;
    const n = Number(map[String(key)]);
    if (Number.isFinite(n)) return clampMult(n);
  }
  return 1;
}

function emptyTuning(now, meta = {}) {
  return {
    enabled: meta.enabled !== false,
    segmentMultiplier: {},
    cooldownMultiplier: {},
    reverted: meta.reverted || null,
    meta: Object.assign({
      generatedAt: now,
      reason: meta.reason || 'no-data',
      reverted: meta.reverted || null,
      sampleMin: DEFAULT_OPTIONS.sampleMin,
      windowDays: DEFAULT_OPTIONS.windowDays,
    }, meta),
  };
}

/**
 * 保护闸：估算「本周日均播放」在倍率作用后会不会掉到上周的 80% 以下。
 * 用当前播放记录的 cooldown 倍率加权平均做投影（优先级只改选哪段，不改次数）。
 */
function applyProtectionGate(maps, plays, opts, now) {
  const windowDays = Math.max(1, num(opts.windowDays, 7));
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const dropPct = Math.min(1, Math.max(0, num(opts.revertDropPct, 0.2)));
  const current = [];
  const previous = [];

  for (const p of plays) {
    const ts = Number(p.rec.ts);
    if (!Number.isFinite(ts) || ts > now) continue;
    if (ts > now - windowMs) current.push(p);
    else if (ts > now - 2 * windowMs) previous.push(p);
  }

  const currentDaily = current.length / windowDays;
  const previousDaily = previous.length / windowDays;
  // 「上周」不存在时（新装/日志只攒了几天）不能假装保护闸不存在：
  // 用当前观测日均当兜底基线，仍然拦住「本次调整让播放掉 >20%」。
  const hasPrevious = previous.length > 0;
  const baselineDaily = hasPrevious ? previousDaily : currentDaily;
  let sum = 0;
  for (const p of current) {
    sum += lookupMultiplier(maps.cooldownMultiplier, [p.rec.clipId, p.rec.label, p.rec.emotion]);
  }
  const avgCooldown = current.length ? sum / current.length : 1;
  const projectedDaily = currentDaily / Math.max(0.01, avgCooldown);

  const gate = {
    currentDaily: Math.round(currentDaily * 100) / 100,
    previousDaily: Math.round(previousDaily * 100) / 100,
    baselineDaily: Math.round(baselineDaily * 100) / 100,
    baseline: hasPrevious ? 'previous_week' : 'current_proxy',
    projectedDaily: Math.round(projectedDaily * 100) / 100,
    avgCooldown: Math.round(avgCooldown * 1000) / 1000,
    dropPct,
    previousDays: previous.length,
    currentPlays: current.length,
    reverted: null,
  };

  if (!current.length) { gate.reason = 'no_current_samples'; return gate; }
  // 只拦「本次调整会让它更低」的情况；本来就在低位、或调整会提高播放，不拦。
  if (avgCooldown > 1 && projectedDaily < currentDaily
    && projectedDaily < baselineDaily * (1 - dropPct)) {
    gate.reverted = 'would_drop_too_much';
    gate.reason = 'would_drop_too_much';
    return gate;
  }
  gate.reason = hasPrevious ? 'ok' : 'current_proxy_ok';
  return gate;
}

/**
 * 从日志记录算倍率（纯函数）。
 * @param {Array<object>} records
 * @param {{now?:number, sampleMin?:number, revertDropPct?:number, windowDays?:number,
 *          followWindowMs?:number, baselineFloor?:number, smoothing?:number, logFile?:string}} [opts]
 */
function computeTuning(records, opts = {}) {
  const now = num(opts.now, Date.now());
  const cfg = Object.assign({}, DEFAULT_OPTIONS, opts);
  if (!Array.isArray(records) || !records.length) {
    return emptyTuning(now, { reason: 'no-records', logFile: opts.logFile || null });
  }

  const allPlays = pairPlays(records, cfg);
  const plays = cfg.autoOnly === false
    ? allPlays
    : allPlays.filter((p) => String((p.rec && p.rec.source) || '') !== 'manual');
  const groups = groupPlays(plays, cfg, now);
  const segmentMultiplier = {};
  const cooldownMultiplier = {};
  const samples = { segments: {}, labels: {}, emotions: {} };

  function applyGroup(map, kind) {
    for (const bucket of map.values()) {
      const adjusted = bucket.plays >= cfg.sampleMin;
      const m = multiplierFor(bucket.plays, bucket.after, groups.baselineRate, cfg);
      samples[kind][bucket.key] = {
        plays: bucket.plays,
        after: bucket.after,
        rate: bucket.plays ? Math.round((bucket.after / bucket.plays) * 10000) / 10000 : 0,
        adjusted,
      };
      if (!adjusted) continue;
      // 更具体的维度先写入；同名的 label/emotion 不覆盖 clipId。
      if (!Object.prototype.hasOwnProperty.call(segmentMultiplier, bucket.key)) {
        segmentMultiplier[bucket.key] = m.priority;
        cooldownMultiplier[bucket.key] = m.cooldown;
      }
    }
  }
  applyGroup(groups.bySegment, 'segments');
  applyGroup(groups.byLabel, 'labels');
  applyGroup(groups.byEmotion, 'emotions');

  const proposed = {
    segmentMultiplier: Object.assign({}, segmentMultiplier),
    cooldownMultiplier: Object.assign({}, cooldownMultiplier),
  };
  const gate = applyProtectionGate({ segmentMultiplier, cooldownMultiplier }, plays, cfg, now);
  const reverted = gate.reverted === 'would_drop_too_much';

  return {
    enabled: true,
    // 回退时输出空表：消费方缺省 1.0。proposed 保留原值供复盘。
    segmentMultiplier: reverted ? {} : segmentMultiplier,
    cooldownMultiplier: reverted ? {} : cooldownMultiplier,
    reverted: reverted ? 'would_drop_too_much' : null,
    meta: {
      generatedAt: now,
      reason: 'ok',
      logFile: opts.logFile || null,
      records: records.length,
      autoOnly: cfg.autoOnly !== false,
      manualExcluded: allPlays.length - plays.length,
      eligiblePlays: groups.eligible,
      responded: groups.after,
      baselineRate: Math.round(groups.baselineRate * 10000) / 10000,
      sampleMin: cfg.sampleMin,
      windowDays: cfg.windowDays,
      requestedMultiplierMin: MULT_MIN,
      requestedMultiplierMax: MULT_MAX,
      gate,
      reverted: reverted ? 'would_drop_too_much' : null,
      proposed: reverted ? proposed : null,
      samples,
    },
  };
}

// ── 路径定位（bundle 后 __dirname 可能不是源码目录，所以向上找特征目录）──────
function upDirs(start) {
  if (!path) return [];
  const out = [];
  let dir = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    out.push(dir);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

function searchStarts() {
  const starts = [];
  try { if (typeof __dirname === 'string' && __dirname) starts.push(__dirname); } catch (e) { /* bundle 里可能没有 */ }
  try { if (typeof process !== 'undefined' && process.cwd) starts.push(process.cwd()); } catch (e) { /* 纯浏览器 */ }
  return starts;
}

/** 找 performance-log.jsonl（workspace/pet-runtime/data 下）。 */
function findLogFile() {
  if (!fs || !path) return '';
  const starts = searchStarts();
  for (const start of starts) {
    for (const dir of upDirs(start)) {
      const cand = path.join(dir, 'pet-runtime', 'data', 'performance-log.jsonl');
      if (fs.existsSync(cand)) return cand;
    }
  }
  const cwd = (typeof process !== 'undefined' && process.cwd) ? process.cwd() : '.';
  return path.join(cwd, 'pet-runtime', 'data', 'performance-log.jsonl');
}

/** 找 data/导演调参.json；PET_DATA_ROOT 优先（测试隔离）。 */
function findConfigFile() {
  if (!fs || !path) return '';
  if (typeof process !== 'undefined' && process.env && process.env.PET_DATA_ROOT) {
    return path.join(path.resolve(process.env.PET_DATA_ROOT), 'data', CONFIG_NAME);
  }
  const starts = searchStarts();
  for (const start of starts) {
    for (const dir of upDirs(start)) {
      const candidates = [
        path.join(dir, 'data'),
        path.join(dir, '_incoming', 'my-neuro', 'data'),
      ];
      for (const records of candidates) {
        if (fs.existsSync(records)) return path.join(records, CONFIG_NAME);
      }
    }
  }
  const cwd = (typeof process !== 'undefined' && process.cwd) ? process.cwd() : '.';
  return path.join(cwd, '_incoming', 'my-neuro', 'data', CONFIG_NAME);
}

function readConfig(file) {
  // 不用 json-store：这是用户手改的开关，JSON 写错时不该被改名隔离。
  if (!fs || !file) return { config: {}, error: null };
  try {
    if (!fs.existsSync(file)) return { config: {}, error: null };
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return { config: {}, error: null };
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { config: {}, error: '导演调参.json 不是对象' };
    }
    return { config: obj, error: null };
  } catch (e) {
    return { config: {}, error: String((e && e.message) || e) };
  }
}

function pickConfig(config) {
  const out = {};
  if (!config || typeof config !== 'object') return out;
  if (config.enabled === false) out.enabled = false;
  if (config.autoOnly === false) out.autoOnly = false;
  else if (config.autoOnly === true) out.autoOnly = true;
  for (const key of ['sampleMin', 'revertDropPct', 'windowDays', 'cacheMs', 'followWindowMs', 'baselineFloor', 'smoothing']) {
    const n = Number(config[key]);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

let _cache = null;
// 异步刷新的在途标记：同一时刻只跑一份，避免 rAF 里排队几十个相同的读。
let _refreshing = false;
let _lastRefresh = { at: 0, reason: 'idle', ms: 0 };
// 48KB/块：723KB 日志约 15 块，每块解析 ≈1ms（audit 实测全量 5–20ms → 拆散后单块 <2ms）
const READ_CHUNK_BYTES = 48 * 1024;
// 让出事件循环：Node/Electron 有 setImmediate；纯浏览器退回 setTimeout(0)
const yieldToLoop = (typeof setImmediate === 'function')
  ? () => new Promise((r) => setImmediate(r))
  : () => new Promise((r) => setTimeout(r, 0));

/**
 * 准备一次加载所需的路径/配置/缓存 key。读配置（几字节）与 stat 都很便宜，
 * 昂贵的是 723KB 日志的 readFileSync + JSON.parse（2026-11-25 审计 §4.2 实测 5–20ms）。
 */
function prepareLoad(opts) {
  const now = num(opts.now, Date.now());
  const logFile = opts.file || findLogFile();
  const configFile = opts.configFile || findConfigFile();
  const { config, error: configError } = readConfig(configFile);
  if (config.enabled === false) {
    return { early: emptyTuning(now, { enabled: false, reason: 'disabled', logFile, configFile, configError: configError || null }) };
  }
  const cfg = Object.assign({}, DEFAULT_OPTIONS, pickConfig(config), opts);
  let stat = null;
  try { stat = fs.statSync(logFile); } catch (e) { stat = null; }
  if (!stat) {
    return { early: emptyTuning(now, { reason: 'no-log', logFile, configFile, configError: configError || null }) };
  }
  const cacheMs = Math.max(1000, num(cfg.cacheMs, DEFAULT_OPTIONS.cacheMs));
  const bucket = Math.floor(now / cacheMs);
  const key = [
    logFile, stat.mtimeMs, stat.size, configFile, configError || '',
    bucket, cfg.sampleMin, cfg.revertDropPct, cfg.windowDays, cfg.autoOnly !== false,
  ].join('|');
  return { now, logFile, configFile, configError, cfg, stat, key };
}

/** 同步全量读（只给测试/CLI 的 noCache 路径用；生产路径绝不走这里） */
function computeFromFileSync(ctx) {
  try {
    const { records, bad } = parseLines(fs.readFileSync(ctx.logFile, 'utf8'));
    const tuning = computeTuning(records, Object.assign({}, ctx.cfg, { now: ctx.now, logFile: ctx.logFile }));
    tuning.meta.badLines = bad;
    tuning.meta.configFile = ctx.configFile;
    tuning.meta.configError = ctx.configError || null;
    _cache = { key: ctx.key, value: tuning };
    return tuning;
  } catch (e) {
    return emptyTuning(ctx.now, {
      reason: 'read-error', error: String((e && e.message) || e),
      logFile: ctx.logFile, configFile: ctx.configFile, configError: ctx.configError || null,
    });
  }
}

/**
 * 增量读日志：每 48KB 读一次、只解析**完整行**（按最后一个 \n 切，UTF-8 多字节
 * 不会被切坏），块与块之间用 setImmediate 让出事件循环。单块约 1–2ms，不再出现
 * 「一帧卡 5–20ms」。
 */
function readRecordsIncremental(file) {
  return new Promise((resolve, reject) => {
    fs.promises.open(file, 'r').then(async (handle) => {
      const records = [];
      let bad = 0;
      try {
        const stat = await handle.stat();
        let offset = 0;
        let pending = Buffer.alloc(0);
        while (offset < stat.size) {
          const len = Math.min(READ_CHUNK_BYTES, stat.size - offset);
          const buf = Buffer.allocUnsafe(len);
          const out = await handle.read(buf, 0, len, offset);
          if (!out.bytesRead) break;
          offset += out.bytesRead;
          const chunk = buf.subarray(0, out.bytesRead);
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          const nl = pending.lastIndexOf(0x0A);
          if (nl >= 0) {
            const parsed = parseLines(pending.subarray(0, nl + 1).toString('utf8'));
            for (const rec of parsed.records) records.push(rec);
            bad += parsed.bad;
            pending = pending.subarray(nl + 1);
          }
          // 让出事件循环：下一次 rAF 还有机会跑
          await yieldToLoop();
        }
        if (pending.length) {
          const parsed = parseLines(pending.toString('utf8'));
          for (const rec of parsed.records) records.push(rec);
          bad += parsed.bad;
        }
        resolve({ records, bad });
      } finally {
        try { await handle.close(); } catch (e) { /* ignore */ }
      }
    }).catch(reject);
  });
}

/** 异步重算并写缓存；失败保留上次值（never throw） */
function refreshAsync(ctx) {
  if (_refreshing) return false;
  _refreshing = true;
  const started = Date.now();
  const run = () => {
    readRecordsIncremental(ctx.logFile).then(({ records, bad }) => {
      const tuning = computeTuning(records, Object.assign({}, ctx.cfg, { now: num(ctx.now, Date.now()), logFile: ctx.logFile }));
      tuning.meta.badLines = bad;
      tuning.meta.configFile = ctx.configFile;
      tuning.meta.configError = ctx.configError || null;
      _cache = { key: ctx.key, value: tuning };
      _lastRefresh = { at: Date.now(), reason: 'ok', ms: Date.now() - started };
    }).catch((e) => {
      // 读失败 = 不调参（保留上次值），绝不把倍率清成空表
      _lastRefresh = { at: Date.now(), reason: String((e && e.message) || e), ms: Date.now() - started };
    }).then(() => { _refreshing = false; }, () => { _refreshing = false; });
  };
  if (typeof setImmediate === 'function') setImmediate(run);
  else Promise.resolve().then(run);
  return true;
}

/**
 * 读日志 + 开关，返回可交给决策层的倍率表。永不抛错（读不到就返回空表 = 1.0）。
 *
 * 2026-11-25 P1（审计 §4.2）：这个函数在 rAF 帧循环里被调（choreoTuning），
 * 旧实现缓存过期时同步 readFileSync 723KB + JSON.parse，每 10 分钟卡 5–20ms。
 * 现在：
 *   · 缓存命中 → 直接返回（和以前一样）；
 *   · 缓存过期 → **先返回上次值**，setImmediate 里分块异步重算（绝不阻塞帧）；
 *   · 首次还没有任何值 → 返回空表（reason='warming'），下一次调用就有值了；
 *   · 测试/CLI 传 noCache:true 仍走同步全量（行为与旧版逐值一致）。
 * @param {{file?:string, configFile?:string, now?:number, noCache?:boolean}} [opts]
 */
function loadTuning(opts = {}) {
  if (!fs || !path) return emptyTuning(num(opts.now, Date.now()), { reason: 'no-fs', logFile: null, configFile: null });
  const ctx = prepareLoad(opts);
  if (ctx.early) return ctx.early;
  // noCache 是「强制重算」（测试/CLI）；生产路径永远先吃缓存
  if (opts.noCache === true) return computeFromFileSync(ctx);
  if (_cache && _cache.key === ctx.key) return _cache.value;
  refreshAsync(ctx);
  if (_cache && _cache.value) return _cache.value;
  return emptyTuning(ctx.now, {
    reason: 'warming', logFile: ctx.logFile, configFile: ctx.configFile, configError: ctx.configError || null,
  });
}

/** 异步版本（测试/诊断用）：一定等到本次重算完成再返回 */
async function loadTuningAsync(opts = {}) {
  if (!fs || !path) return emptyTuning(num(opts.now, Date.now()), { reason: 'no-fs', logFile: null, configFile: null });
  const ctx = prepareLoad(opts);
  if (ctx.early) return ctx.early;
  if (_cache && _cache.key === ctx.key) return _cache.value;
  const { records, bad } = await readRecordsIncremental(ctx.logFile);
  const tuning = computeTuning(records, Object.assign({}, ctx.cfg, { now: num(ctx.now, Date.now()), logFile: ctx.logFile }));
  tuning.meta.badLines = bad;
  tuning.meta.configFile = ctx.configFile;
  tuning.meta.configError = ctx.configError || null;
  _cache = { key: ctx.key, value: tuning };
  return tuning;
}

module.exports = {
  FOLLOW_WINDOW_MS,
  MULT_MIN,
  MULT_MAX,
  CONFIG_NAME,
  DEFAULT_OPTIONS,
  parseLines,
  pairPlays,
  groupPlays,
  multiplierFor,
  computeTuning,
  loadTuning,
  loadTuningAsync,
  findLogFile,
  findConfigFile,
  lookupMultiplier,
  // 测试用：清掉进程内缓存
  _clearCache: () => { _cache = null; },
  // 诊断：异步刷新是否在途 / 上次刷新的结果（性能排查用）
  _asyncState: () => ({ refreshing: _refreshing, last: Object.assign({}, _lastRefresh) }),
};

// 人读入口：node js/core/choreo-tune.js → 打印当前日志算出的倍率与保护闸结论。
// 生产进程 require 本模块时 require.main !== module，不会触发。
let _isMain = false;
try { _isMain = typeof require !== 'undefined' && require.main === module; } catch (e) { _isMain = false; }
if (_isMain) {
  console.log(JSON.stringify(loadTuning({ noCache: true }), null, 2));
}
