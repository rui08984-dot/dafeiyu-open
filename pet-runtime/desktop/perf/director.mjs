// director.mjs —— 「此刻该不该演、演多重、最多多久」（2026-11-25 P0，ADR-015 §3.3）
//
// 放哪：纯函数模块，决策在渲染进程内、`perfAuto` 旁边调用；**只减少请求，不碰 claim/写入**。
//
// 为什么先 dry-run（审计 §6 的建议，不是偷懒）：
//   直接开闸 = 拍脑袋调参。实测基线是 183 次/天、被接率 2.5–4%、away 1484 条 skip
//   （但 v2 自动通道根本没有 away 记录，因为代码不传 presence）。先只把
//   `perf.request {allowed, reason}` 写进日志 24h，拿到「本来会被拦掉多少、拦得对不对」
//   的真实分布，再决定阈值 —— 这条把「猜」变成「有数据」。
//
// 契约：
//   mode = 'enforce'（enabled=true，真拦）| 'dryrun'（dry_run=true，只记不拦）| 'off'（都不开）
//   调用方用 `gate(decision, kind)` 判断是否继续；dry-run/off 永远 proceed=true。
//
// 纯模块：不 require fs / electron / DOM；now / config / session 全由调用方注入。

import { allowsLongPerformance, normalizePresenceState } from './presence.mjs';

/** director 的默认值（与 live-2d/config.json 的 performance.director 一一对应；缺键=这里） */
export const DIRECTOR_DEFAULTS = Object.freeze({
  // P1（2026-11-25）开闸：P0 的 24h dry-run 已完成，按 ADR-015 §4.1 默认即 enforce。
  // 回滚：把 config.json 的 enabled 改 false（dry_run=false → off；dry_run=true → 只看日志）。
  enabled: true,
  dry_run: false,
  max_plays_per_day: 40,     // 正常日播放上限（含微动作；**只统计自动来源**）
  max_long_per_day: 12,      // >10s 长段上限（同样只统计自动来源）
  max_per_10min: 2,          // 从 4 降到 2
  min_reply_rate: 0.15,      // 最近 10 次被接率低于它 → 降强度
  high_reply_rate: 0.4,      // 高于它 → 允许 +1 次/10min
  min_gap_ms: 60 * 1000,     // 两次演出之间的最短间隔
  max_gap_ms: 180 * 1000,
  short_ms: 8000,            // 低强度只允许 ≤8s
  medium_ms: 12000,
  long_ms: 20000,
  max_ms: 45000,
  v2_gate_intensity: 0.6,    // ≥它才允许 v2 长表演
  long_gate_intensity: 0.8,  // ≥它才允许节目单
});

/** `performance.*` 整组的默认值（config.json 缺键时按这份走） */
export const PERFORMANCE_DEFAULTS = Object.freeze({
  scheduler: { enabled: true },
  // P4 才接线；P0 只保留「缺键 = 关」的默认（ADR-015 §4.1）
  channel_overlay: { enabled: false },
  director: DIRECTOR_DEFAULTS,
  ambient: { enabled: true, scale: 0.3 },
  program: { enabled: true, max_per_day: 2 },
  writer: { enabled: false },
});

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * 合并调用方给的 `config.performance`（缺键/脏值一律回落默认，不抛错）。
 * @param {object} [raw]
 */
export function resolvePerformanceConfig(raw) {
  const src = isObj(raw) ? raw : {};
  const merge = (name) => Object.assign({}, PERFORMANCE_DEFAULTS[name], isObj(src[name]) ? src[name] : {});
  return {
    scheduler: merge('scheduler'),
    channel_overlay: merge('channel_overlay'),
    director: merge('director'),
    ambient: merge('ambient'),
    program: merge('program'),
    writer: merge('writer'),
  };
}

/**
 * 时长预算：低强度只允许短段，高强度才允许长段。
 * 分段而不是线性：审计要的是「低强度不许长段」这条硬门，线性插值在中低强度仍会放出 16s 段。
 */
export function maxMsForIntensity(intensity) {
  const i = clamp01(num(intensity, 0));
  if (i <= 0.4) return DIRECTOR_DEFAULTS.short_ms;
  if (i <= 0.6) return DIRECTOR_DEFAULTS.medium_ms;
  if (i <= 0.8) return DIRECTOR_DEFAULTS.long_ms;
  return DIRECTOR_DEFAULTS.max_ms;
}

/**
 * 会话强度曲线（ADR-015 §3.3）：
 *   开始 5 分钟 = 0.3（只允许短场景/微动作）；连续 3 轮对话 = 0.6；
 *   长对话 / 用户刚主动点她 = 1.0（允许 v2 / 节目单）。
 * @param {object} session
 * @param {number} now
 */
export function sessionIntensity(session, now) {
  const s = isObj(session) ? session : {};
  const turns = num(s.turns, 0);
  const ageMin = Number.isFinite(Number(s.ageMs))
    ? Number(s.ageMs) / 60000
    : (Number.isFinite(Number(s.startedAt)) ? Math.max(0, now - Number(s.startedAt)) / 60000 : 0);
  const lastAction = num(s.userActionAt, 0);
  let value = 0.3;
  if (turns >= 3) value = 0.6;
  if (turns >= 8 || ageMin >= 15) value = 1.0;
  if (lastAction > 0 && now - lastAction <= 120 * 1000) value = Math.max(value, 0.8);
  return clamp01(value);
}

/**
 * 从 `performance-log.summary()` 取**自动来源**的预算消耗。
 *
 * 为什么手点不算（2026-11-25 P1 真机实测）：`playPerformance('03-pride')` 之后
 * `budgetLeft.plays` 从 39 掉到 38（source=manual 也计数）。导演的日预算是
 * 「她**主动**演多少次」的闸门，用户点名演一段不是自动行为，不该吃掉当天额度；
 * 否则用户多点几次，她就真的不自动演了。
 *
 * summary 里没有分来源字段（旧日志/旧调用）时回落到总量 —— 保守，不假装「没花」。
 */
export function budgetsFromSummary(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const auto = (autoKey, allKey) => {
    const a = Number(s[autoKey]);
    if (Number.isFinite(a)) return Math.max(0, a);
    return Math.max(0, num(s[allKey], 0));
  };
  return {
    playsToday: auto('autoPlaysToday', 'playsToday'),
    longToday: auto('autoLongToday', 'longToday'),
    playsLast10Min: auto('autoPlays10', 'plays10'),
  };
}

/**
 * 决定「这一拍允不允许演」。
 *
 * @param {object} input
 * @param {{state?:string,inFront?:boolean,fresh?:boolean}|null} input.presence
 * @param {{key?:string,strength?:number}|null} [input.emotion]  仅记录，不参与门（情绪门在 choreo-auto/clip 导演）
 * @param {object} [input.session]  {startedAt,turns,userActionAt,replyRate,replySamples}
 * @param {number} [input.now]
 * @param {number} [input.lastPerfAt]
 * @param {{playsToday?:number,longToday?:number,playsLast10Min?:number}} [input.budgets]
 * @param {object} [input.config]  config.performance
 * @returns {{allow:boolean,intensity:number,maxMs:number,minGapMs:number,maxPer10Min:number,
 *            maxPlaysPerDay:number,maxLongPerDay:number,allowedKinds:string[],reason:string,
 *            mode:'enforce'|'dryrun'|'off',presence:string,budgetLeft:object}}
 */
export function decide(input = {}) {
  const cfg = Object.assign({}, DIRECTOR_DEFAULTS, resolvePerformanceConfig(input.config).director);
  const now = num(input.now, Date.now());
  const presence = input.presence || null;
  const state = normalizePresenceState(presence && presence.state);
  const budgets = isObj(input.budgets) ? input.budgets : {};
  const playsToday = num(budgets.playsToday, 0);
  const longToday = num(budgets.longToday, 0);
  const plays10 = num(budgets.playsLast10Min, 0);
  const lastPerfAt = num(input.lastPerfAt, 0);

  const mode = cfg.enabled === true ? 'enforce' : (cfg.dry_run === true ? 'dryrun' : 'off');
  const budgetLeft = {
    plays: Math.max(0, cfg.max_plays_per_day - playsToday),
    long: Math.max(0, cfg.max_long_per_day - longToday),
    last10: Math.max(0, cfg.max_per_10min - plays10),
  };

  if (mode === 'off') {
    return {
      allow: false, intensity: 0, maxMs: 0, minGapMs: cfg.min_gap_ms,
      maxPer10Min: cfg.max_per_10min, maxPlaysPerDay: cfg.max_plays_per_day,
      maxLongPerDay: cfg.max_long_per_day, allowedKinds: [], reason: 'disabled',
      mode, presence: state, budgetLeft,
    };
  }

  // ── 强度：会话曲线 + 被接率闭环（贝叶斯平滑在 choreo-tune，这里只做阈值乘子）──
  let intensity = sessionIntensity(input.session, now);
  const replyRate = Number(input.session && input.session.replyRate);
  const replySamples = num(input.session && input.session.replySamples, 0);
  let replyPenalty = 0;
  if (replySamples >= 10 && Number.isFinite(replyRate)) {
    if (replyRate < cfg.min_reply_rate) { intensity *= 0.7; replyPenalty = -1; }
    else if (replyRate > cfg.high_reply_rate) { intensity = clamp01(intensity + 0.15); replyPenalty = 1; }
  }
  intensity = clamp01(intensity);

  let maxPer10Min = Math.max(1, cfg.max_per_10min + replyPenalty);
  let maxMs = maxMsForIntensity(intensity);
  const minGapMs = Math.round(Math.min(cfg.max_gap_ms, Math.max(cfg.min_gap_ms, cfg.max_gap_ms - 120000 * intensity)));

  // ── 在场门（最高优先）：away 禁一切；gaming/watching/meeting 禁长段 ──
  const kinds = ['micro', 'clip'];
  if (intensity >= cfg.v2_gate_intensity) kinds.push('v2');
  if (intensity >= cfg.long_gate_intensity && resolvePerformanceConfig(input.config).program.enabled !== false) {
    kinds.push('program');
  }
  let allowedKinds = kinds.slice();
  let allow = true;
  let reason = 'ok';

  if (state === 'away') {
    allow = false;
    allowedKinds = [];
    reason = 'presence:away';
  } else if (!allowsLongPerformance(presence)) {
    allowedKinds = allowedKinds.filter((k) => k === 'micro' || k === 'clip');
    maxMs = Math.min(maxMs, cfg.short_ms);
    reason = 'presence:' + state;
  }

  // ── 间隔门 ──
  if (allow && lastPerfAt > 0 && now - lastPerfAt < minGapMs) {
    allow = false;
    reason = 'gap';
  }

  // ── 预算门 ──
  if (allow && playsToday >= cfg.max_plays_per_day) {
    allow = false;
    reason = 'budget:plays';
  }
  if (allow && plays10 >= maxPer10Min) {
    allow = false;
    reason = 'budget:10min';
  }
  if (allow && longToday >= cfg.max_long_per_day
      && allowedKinds.some((k) => k === 'v2' || k === 'program')) {
    // 长段预算用尽不是「不演」，是「只许短段」
    allowedKinds = allowedKinds.filter((k) => k !== 'v2' && k !== 'program');
    maxMs = Math.min(maxMs, cfg.short_ms);
    reason = 'budget:long';
  }

  return {
    allow, intensity: +intensity.toFixed(2), maxMs, minGapMs, maxPer10Min,
    maxPlaysPerDay: cfg.max_plays_per_day, maxLongPerDay: cfg.max_long_per_day,
    allowedKinds, reason, mode, presence: state, budgetLeft,
  };
}

/**
 * 调用方的执行门：dry-run / off 永远放行（P0 不改行为），enforce 才按决策拦。
 * @param {ReturnType<typeof decide>} decision
 * @param {'micro'|'clip'|'v2'|'program'} kind
 */
export function gate(decision, kind) {
  if (!decision) return { proceed: true, reason: 'no-decision' };
  if (decision.mode !== 'enforce') return { proceed: true, reason: 'dry-run' };
  if (decision.allow !== true) return { proceed: false, reason: decision.reason || 'blocked' };
  if (!Array.isArray(decision.allowedKinds) || !decision.allowedKinds.includes(kind)) {
    return { proceed: false, reason: 'kind:' + String(kind) };
  }
  return { proceed: true, reason: 'ok' };
}
