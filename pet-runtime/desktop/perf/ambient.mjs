// ambient.mjs —— 待机层：6 态 Markov + 对数正态停留 + 加权待机池 + 程序化呼吸（P1，ADR-015 §3.4）
//
// 为什么要有它（审计 §2.6）：
//   现在「待机」是 8 个互不相干的定时器：BodyDirector 每 6–14s 随机小动作、perf idle 层
//   2.4s 后微抽、待机随机表情 45–90s、v2 空闲通道 8min、clip 空闲通道 8min……
//   没有状态机、没有环境调制、没有非均匀停留，几何分布还会造成「3 分钟后又来一段」的簇。
//   这一层只做一件事：把「她现在没事时的状态」变成一个可解释的 6 状态机，输出**小幅偏置**，
//   让静帧有生命感，而不产生「会动的壁纸」。
//
// 公式来源（只移植公式/常量，不复制代码；许可见 ADR-015 §10）：
//   · 加权待机池      P(i) = weight_i / Σ weight_j                       —— ChatdollKit（Apache-2.0）
//   · 非固定间隔      next_delay ~ U(90s, 300s)，每次重抽                —— ai-vtuber（GPL-3.0，只抄公式）
//   · 程序化呼吸      base + amp·π·sin(t)，周期 4–6s，幅度分级 .04/.02/.01 —— Amica（MIT）
//   · 效用 margin     score_i = U_i + ε_i, ε~U(0, 0.05–0.15)，×0.7^最近次数 —— Utility AI 方法论
//   · 对数正态停留    μ 按状态，σ=0.6，钳 [20s, 8min]                    —— ADR-015 §3.4
//
// 契约（给接线方）：
//   sample(now, ctx) -> {
//     enabled, state, prev, dwellMs, elapsedMs, amp,
//     bias: { headYaw, headPitch, breath, gazeX, gazeY, posture },
//     needsRecompute, nextDelayMs, action, transitions
//   }
//   · amp ≤ performance.ambient.scale（默认 0.3，即「表演幅度的 30%」）；
//   · 任一 |bias.*| > 0.0015（渲染器脏帧阈值）；万一全部落在阈值内，needsRecompute=true，
//     调用方据此要求重算，而不是让画面「冻住但没人知道为什么」。
//
// 纯模块：now / 随机源 / 上下文全部注入；不 require fs / electron / DOM。

import { normalizePresenceState } from './presence.mjs';

/** 6 状态（ADR-015 §3.4） */
export const AMBIENT_STATES = Object.freeze(['quiet', 'observe', 'bored', 'sleepy', 'playful', 'settle']);

/** 脏帧阈值：与 cubism-renderer.mjs 的 0.0015 同源 */
export const DIRTY_EPS = 0.0015;

export const AMBIENT_DEFAULTS = Object.freeze({
  enabled: true,
  scale: 0.3,               // 幅度上限（相对表演）
  sigma: 0.6,               // 对数正态 σ
  minDwellMs: 20 * 1000,    // 钳下界
  maxDwellMs: 8 * 60 * 1000,// 钳上界
  delayMinMs: 90 * 1000,    // 非固定间隔下界（AI-Vtuber 公式）
  delayMaxMs: 300 * 1000,   // 上界
  marginMin: 0.05,          // 效用 ε 下界
  marginMax: 0.15,          // 效用 ε 上界
  inertia: 0.7,             // 「刚播过」惯性惩罚底数
  poolWindow: 6,            // 最近 N 次待机动作参与惯性
  replySampleMin: 20,       // 被接率样本门槛（与 choreo-tune 同）
  intensityWeight: 0.35,    // 导演 intensity 对幅度的压制系数
});

/**
 * 每个状态的停留中位数（ms 由 medianSec 换算）与幅度分级。
 * amp 是「相对 scale 的倍率」：最终 amp = scale × amp ≤ scale。
 * lean 是姿态偏置的符号与力度（±，避免所有状态都往同一侧歪）。
 */
export const STATE_PROFILES = Object.freeze({
  //                                         呼吸周期 4–6s（Amica 常量区间）
  quiet:   { medianSec: 150, amp: 0.50, lean: -0.6, phase: 0.0, breathPeriod: 5.2 },
  observe: { medianSec: 90,  amp: 0.70, lean: 0.5, phase: 1.7, breathPeriod: 4.3 },
  bored:   { medianSec: 240, amp: 0.50, lean: -0.8, phase: 3.1, breathPeriod: 6.0 },
  sleepy:  { medianSec: 300, amp: 0.35, lean: 0.9, phase: 4.2, breathPeriod: 5.6 },
  playful: { medianSec: 60,  amp: 1.00, lean: 0.4, phase: 5.3, breathPeriod: 4.0 },
  settle:  { medianSec: 45,  amp: 0.45, lean: 0.2, phase: 2.4, breathPeriod: 4.8 },
});

/**
 * 基础转移矩阵（行=当前，列=下一个）。数值是相对权重，不是概率；
 * 上下文调制之后再归一化。刻意保留自转移（人在一个状态里会待一会儿），但压到 0.6。
 */
export const BASE_TRANSITIONS = Object.freeze({
  quiet:   { quiet: 0.6, observe: 4, bored: 2, sleepy: 1, playful: 1, settle: 1 },
  observe: { quiet: 2, observe: 0.6, bored: 1, sleepy: 0.5, playful: 3, settle: 1.5 },
  bored:   { quiet: 1, observe: 2, bored: 0.6, sleepy: 2, playful: 2.5, settle: 1 },
  sleepy:  { quiet: 2, observe: 1, bored: 1.5, sleepy: 0.6, playful: 0.5, settle: 1 },
  playful: { quiet: 1, observe: 2, bored: 0.5, sleepy: 0.5, playful: 0.6, settle: 2 },
  settle:  { quiet: 3, observe: 2, bored: 0.5, sleepy: 1, playful: 0.5, settle: 0.2 },
});

/**
 * 加权待机池（ChatdollKit 的 AddIdleAnimation(duration, weight, mode) 语义）：
 * 常用 3 / 少见 1；modes 是「这个动作允许出现在哪些状态」（mode 过滤后再归一化）。
 */
export const AMBIENT_POOL = Object.freeze([
  { key: 'breathe', weight: 3, modes: ['quiet', 'observe', 'bored', 'sleepy', 'playful', 'settle'] },
  { key: 'look-around', weight: 3, modes: ['quiet', 'observe', 'playful'] },
  { key: 'shift-weight', weight: 3, modes: ['quiet', 'observe', 'bored', 'settle'] },
  { key: 'gaze-drift', weight: 3, modes: ['quiet', 'observe', 'sleepy', 'settle'] },
  { key: 'ear-twitch', weight: 1, modes: ['observe', 'playful', 'settle'] },
  { key: 'small-stretch', weight: 1, modes: ['observe', 'playful', 'settle'] },
  { key: 'yawn', weight: 1, modes: ['sleepy', 'bored'] },
]);

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** mulberry32：小而可复现的 PRNG（测试注入同一种子必须逐值一致） */
export function mulberry32(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function random() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller（保留备用值，避免每次消耗两个随机数） */
export function createGaussian(random) {
  let spare = null;
  return function gauss() {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = random() * 2 - 1;
      v = random() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  };
}

/**
 * 对数正态停留。`μ = ln(medianMs)`，`dwell = exp(μ + σ·Z)`。
 * @param {string} state
 * @param {{random?:Function, gauss?:Function, sigma?:number, minMs?:number, maxMs?:number, clampToRange?:boolean}} [opts]
 */
export function logNormalDwellMs(state, opts = {}) {
  const profile = STATE_PROFILES[state] || STATE_PROFILES.quiet;
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  const gauss = typeof opts.gauss === 'function' ? opts.gauss : createGaussian(random);
  const sigma = num(opts.sigma, AMBIENT_DEFAULTS.sigma);
  const medianMs = profile.medianSec * 1000;
  const raw = Math.exp(Math.log(medianMs) + sigma * gauss());
  if (opts.clampToRange === false) return raw;
  const minMs = num(opts.minMs, AMBIENT_DEFAULTS.minDwellMs);
  const maxMs = num(opts.maxMs, AMBIENT_DEFAULTS.maxDwellMs);
  return clamp(raw, minMs, maxMs);
}

/** 上下文归一化（presence 复用统一入口的六态词汇；时间/整点可注入） */
export function normalizeContext(input, nowInput) {
  const src = input && typeof input === 'object' ? input : {};
  const now = num(nowInput, num(src.now, Date.now()));
  const hour = Number.isFinite(Number(src.hour)) ? Number(src.hour) : new Date(now).getHours();
  return {
    now,
    hour,
    presence: normalizePresenceState(src.presence != null ? src.presence : src.activity),
    idleSec: Math.max(0, num(src.idleSec, 0)),
    conversationEndedAt: num(src.conversationEndedAt, 0),
    intensity: clamp(num(src.intensity, 0), 0, 1),
    reply: {
      rate: Number.isFinite(Number(src.reply && src.reply.rate)) ? Number(src.reply.rate) : null,
      samples: num(src.reply && src.reply.samples, 0),
    },
  };
}

/**
 * 按上下文调制后的转移权重（未归一化）。away 直接收敛到 quiet。
 * @param {string} from
 * @param {object} ctx normalizeContext 的输出
 */
export function transitionWeights(from, ctx = {}) {
  const current = AMBIENT_STATES.includes(from) ? from : 'quiet';
  const c = normalizeContext(ctx, ctx && ctx.now);
  if (c.presence === 'away') return { quiet: 1 };

  const w = Object.assign({}, BASE_TRANSITIONS[current]);
  const inFront = c.presence !== 'unknown' && c.presence !== 'away';
  const night = c.hour >= 23 || c.hour < 7;
  const recentlyTalked = c.conversationEndedAt > 0 && c.now - c.conversationEndedAt <= 60 * 1000;

  // 在场 → 更常「看」；不在场 → 收敛到安静
  w.observe *= inFront ? 1.8 : 0.6;
  w.quiet *= inFront ? 1 : 1.8;
  // 刚聊完 → 余韵（settle）
  w.settle *= recentlyTalked ? 2.5 : 1;
  // 深夜 → 困；久不动 → 困
  w.sleepy *= (night ? 2.4 : 1) * (c.idleSec >= 900 ? 1.4 : 1);
  // 久无交互 → 无聊
  w.bored *= c.idleSec >= 600 ? 2.0 : 1;
  // 活跃度调制：导演 intensity 高时更可能 playful（也更容易被表演接走）
  w.playful *= (inFront ? 1.2 : 0.5) * (night ? 0.5 : 1) * (0.6 + 1.2 * c.intensity);
  // 强度越高，待机越不该往 sleepy 走（她刚被逗起来）
  w.sleepy *= 1.3 - 0.6 * c.intensity;
  return w;
}

/** 递归归一化 + 按权重抽样一个下一状态 */
export function pickNextState(from, ctx, random = Math.random) {
  const c = normalizeContext(ctx, ctx && ctx.now);
  if (c.presence === 'away') return 'quiet';
  const weights = transitionWeights(from, c);
  const entries = Object.entries(weights).filter(([, v]) => Number.isFinite(v) && v > 0);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (!entries.length || total <= 0) return 'quiet';
  let r = clamp(Number(random()) || 0, 0, 0.999999999);
  for (const [state, weight] of entries) {
    r -= weight / total;
    if (r < 0) return state;
  }
  return entries[entries.length - 1][0];
}

/** 状态 → 归一化后的转移概率（测试与诊断用） */
export function transitionProbabilities(from, ctx) {
  const c = normalizeContext(ctx, ctx && ctx.now);
  if (c.presence === 'away') return { quiet: 1 };
  const weights = transitionWeights(from, c);
  const total = Object.values(weights).reduce((sum, v) => sum + (Number.isFinite(v) && v > 0 ? v : 0), 0) || 1;
  const out = {};
  for (const [state, w] of Object.entries(weights)) out[state] = +((Number.isFinite(w) && w > 0 ? w : 0) / total).toFixed(6);
  return out;
}

/**
 * 加权待机池：权重 = 基础权重（3/1）+ 被接率映射。
 * 被接率只在样本 ≥20 时生效（与 choreo-tune 同一门槛，复用阈值不新造）。
 * @param {string} state
 * @param {object} ctx
 * @returns {Array<{key:string, weight:number, utility:number}>}
 */
export function poolWeights(state, ctx = {}) {
  const c = normalizeContext(ctx, ctx && ctx.now);
  const entries = AMBIENT_POOL
    .filter((item) => item.modes.includes(state))
    .map((item) => {
      let weight = item.weight;
      const reply = c.reply;
      if (reply.samples >= AMBIENT_DEFAULTS.replySampleMin && Number.isFinite(reply.rate)) {
        if (reply.rate < 0.15) weight = Math.max(1, weight - 1);          // 被接率低 → 少做花活
        else if (reply.rate > 0.4) weight = Math.min(4, weight + 1);      // 被接率高 → 多一点变化
      }
      return { key: item.key, weight };
    });
  const total = entries.reduce((sum, item) => sum + item.weight, 0) || 1;
  return entries.map((item) => ({ key: item.key, weight: item.weight, utility: item.weight / total }));
}

/** P(i) = weight_i / Σ weight_j（ChatdollKit 公式，mode 过滤后） */
export function poolProbabilities(state, ctx = {}) {
  const entries = poolWeights(state, ctx);
  const total = entries.reduce((sum, item) => sum + item.weight, 0) || 1;
  const out = {};
  for (const item of entries) out[item.key] = +(item.weight / total).toFixed(6);
  return out;
}

/**
 * 池选择：先按 P(i)=weight_i/Σweight（ChatdollKit），再乘 0.7^最近次数（惯性），
 * 最后用效用 margin 做「加权轮盘」的扰动。
 *
 * 为什么不是 argmax(U+ε)（研究里的效用 margin 原式）：
 *   权重差 3:1 时 U 的差（≈0.154）比 ε 的上限（0.15）还大，argmax 会让少见动作
 *   **永远不可能**被选中 —— 这就违背了加权待机池「少见 1 但仍会出现」的定义。
 *   所以这里把同一个 score（U+ε，乘惯性）当作轮盘权重：公式的语义保留，
 *   分布上仍严格是 weight/Σweight（ε 均值为 0.5·margin，对各候选同加）。
 * @param {string} state
 * @param {object} ctx
 * @param {Function} random
 * @param {string[]} recent 最近选过的 key（数次数用）
 */
export function pickPoolAction(state, ctx = {}, random = Math.random, recent = []) {
  const entries = poolWeights(state, ctx);
  if (!entries.length) return null;
  const marginMin = clamp(num(ctx && ctx.marginMin, AMBIENT_DEFAULTS.marginMin), 0, 1);
  const marginMax = clamp(num(ctx && ctx.marginMax, AMBIENT_DEFAULTS.marginMax), marginMin, 1);
  const counts = new Map();
  for (const key of recent) counts.set(key, (counts.get(key) || 0) + 1);
  const scores = [];
  let total = 0;
  for (const item of entries) {
    const eps = marginMin + clamp(Number(random()) || 0, 0, 1) * (marginMax - marginMin);
    const inertia = Math.pow(AMBIENT_DEFAULTS.inertia, counts.get(item.key) || 0);
    const score = Math.max(0, (item.utility + eps) * inertia);
    scores.push({ key: item.key, score });
    total += score;
  }
  if (total <= 0) return entries[0].key;
  let r = clamp(Number(random()) || 0, 0, 0.999999999) * total;
  for (const item of scores) {
    r -= item.score;
    if (r < 0) return item.key;
  }
  return scores[scores.length - 1].key;
}

/**
 * 某一时刻的程序化偏置（Amica：base + amp·π·sin(t)，相位一致、幅度分级）。
 * 单位是「FACS 偏移量」：brch 用 spine 档 0.04，头/眼用 neck/limb 档 0.02/0.01。
 */
export function biasAt(state, elapsedMs, amp, intensity = 0) {
  const profile = STATE_PROFILES[state] || STATE_PROFILES.quiet;
  const t = Math.max(0, Number(elapsedMs) || 0) / 1000;
  const a = Math.max(0, Number(amp) || 0);
  const phase = profile.phase;
  // 幅度已经由 amp 承担 intensity 压制（amp = scale × prof.amp × (1 - 0.35·intensity)），
  // 这里不再二次缩放 —— 否则 intensity=1 时幅度会被压到 42%。
  void intensity;
  const breathPeriod = profile.breathPeriod;
  const breath = a * 0.04 * Math.PI * Math.sin((2 * Math.PI * t) / breathPeriod + phase);
  const headYaw = a * 0.02 * Math.sin(t / 2.7 + phase);
  const headPitch = a * 0.02 * Math.sin(t / 3.9 + phase * 0.7);
  const gazeX = a * 0.01 * Math.sin(t / 1.9 + phase * 1.3);
  const gazeY = a * 0.01 * Math.sin(t / 2.3 + phase * 0.5);
  // 姿态：一个恒定的重心偏移（保证「总有东西在动」）+ 很慢的摆动
  const posture = a * (0.02 * profile.lean + 0.04 * Math.sin(t / 6.1 + phase));
  return { headYaw, headPitch, breath, gazeX, gazeY, posture };
}

/**
 * 待机层实例。时间与随机源注入；sample 每帧 O(1)，只做一次三角与一次比较。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]
 * @param {number} [opts.scale] 幅度上限（= performance.ambient.scale）
 * @param {number} [opts.seed]
 * @param {Function} [opts.random]
 * @param {boolean} [opts.now]
 */
export function createAmbient(opts = {}) {
  const cfg = Object.assign({}, AMBIENT_DEFAULTS, (opts && opts.config) || {});
  let enabled = opts.enabled !== undefined ? opts.enabled !== false : cfg.enabled !== false;
  let scale = clamp(num(opts.scale, cfg.scale), 0, 1);
  const seed = (num(opts.seed, 20261125) >>> 0);
  const random = typeof opts.random === 'function' ? opts.random : mulberry32(seed);
  const gauss = createGaussian(random);

  let state = 'quiet';
  let prev = '';
  let since = null;
  let dwellMs = 0;
  let until = 0;
  let nextDelayMs = 0;
  let nextActionAt = 0;
  let action = null;
  let intensity = 0;
  let transitions = 0;
  const recent = [];

  function rollDelay() {
    return cfg.delayMinMs + clamp(random(), 0, 1) * (cfg.delayMaxMs - cfg.delayMinMs);
  }

  function enter(next, at, ctx) {
    prev = state;
    state = AMBIENT_STATES.includes(next) ? next : 'quiet';
    since = at;
    dwellMs = logNormalDwellMs(state, {
      random, gauss, sigma: cfg.sigma, minMs: cfg.minDwellMs, maxMs: cfg.maxDwellMs,
    });
    until = at + dwellMs;
    nextDelayMs = rollDelay();
    nextActionAt = at + nextDelayMs;
    action = null;
    transitions += 1;
    // 保住「同一状态不连续复用待机动作」：换状态时清惯性的短期记忆之外不动
    void ctx;
  }

  /**
   * 每帧调用。返回可直接消费的偏置快照（不改任何外部状态）。
   * @param {number} nowMs
   * @param {object} [context] {presence, idleSec, conversationEndedAt, hour, intensity, reply:{rate,samples}}
   */
  function sample(nowMs, context) {
    const now = num(nowMs, Date.now());
    const ctx = normalizeContext(context, now);
    // 只有调用方显式给了 intensity 才覆盖（setIntensity 设的值不会被「没传」清掉）
    if (context && context.intensity != null && Number.isFinite(Number(context.intensity))) {
      intensity = clamp(Number(context.intensity), 0, 1);
    }
    ctx.intensity = intensity;
    const ampScale = 1 - AMBIENT_DEFAULTS.intensityWeight * intensity;

    if (!enabled || scale <= 0) {
      return {
        enabled: false, state: 'quiet', prev: '', dwellMs: 0, elapsedMs: 0, amp: 0, motionScale: 1,
        bias: { headYaw: 0, headPitch: 0, breath: 0, gazeX: 0, gazeY: 0, posture: 0 },
        needsRecompute: false, nextDelayMs: 0, action: null, transitions,
      };
    }

    if (since == null) enter(state, now, ctx);
    // 停留到期 → 转移（边界用 until 而不是 now，保证 overshoot 不被吞掉）
    let guard = 0;
    while (now >= until && guard < 16) {
      enter(pickNextState(state, ctx, random), until, ctx);
      guard += 1;
    }

    // 待机动作：非固定间隔重抽（AI-Vtuber 公式），同一动作不连续复用
    if (now >= nextActionAt) {
      const picked = pickPoolAction(state, ctx, random, recent);
      if (picked) {
        // 同一动作不连续复用：命中就再抽一次（最多 3 次，避免死循环）
        let attempt = 0;
        let nextPick = picked;
        while (action && nextPick === action && attempt < 3) {
          nextPick = pickPoolAction(state, ctx, random, recent) || nextPick;
          attempt += 1;
        }
        action = nextPick;
        recent.push(action);
        while (recent.length > cfg.poolWindow) recent.shift();
      }
      nextDelayMs = rollDelay();
      nextActionAt = now + nextDelayMs;
    }

    const profile = STATE_PROFILES[state] || STATE_PROFILES.quiet;
    const amp = clamp(scale * profile.amp * ampScale, 0, scale);
    // 渲染器用的「旧待机摆动乘数」：0.45..1。不走 amp 的绝对值（0.1–0.3）是因为
    // 直接把 BodyDirector 压到 10% 会让呼吸/物理链看起来像停机；这里只表达
    // 「安静的待机比平常收敛一些」，真正的幅度预算仍由 amp 本身表达（≤ scale）。
    const motionScale = scale > 0 ? clamp(0.45 + 0.55 * (amp / scale), 0.45, 1) : 1;
    let bias = biasAt(state, now - since, amp, intensity);
    let needsRecompute = false;
    let maxAbs = 0;
    for (const key of Object.keys(bias)) maxAbs = Math.max(maxAbs, Math.abs(bias[key]));
    if (maxAbs < DIRTY_EPS) {
      // 显式要求重算：不假装「有偏置」，也不让待机在某几帧里静默冻住
      needsRecompute = true;
      const magnitude = DIRTY_EPS * 1.2;
      bias = {
        headYaw: bias.headYaw,
        headPitch: bias.headPitch,
        breath: bias.breath,
        gazeX: bias.gazeX,
        gazeY: bias.gazeY,
        posture: bias.posture + (bias.posture < 0 ? -magnitude : magnitude),
      };
    }
    return {
      enabled: true,
      state,
      prev,
      dwellMs: Math.round(dwellMs),
      elapsedMs: Math.round(now - since),
      amp: +amp.toFixed(4),
      motionScale: +motionScale.toFixed(4),
      bias,
      needsRecompute,
      nextDelayMs: Math.round(nextDelayMs),
      action,
      transitions,
    };
  }

  function reset(at) {
    state = 'quiet';
    prev = '';
    since = null;
    void at;
    dwellMs = 0;
    until = 0;
    nextDelayMs = 0;
    nextActionAt = 0;
    action = null;
    transitions = 0;
    recent.length = 0;
  }

  return {
    sample,
    setIntensity(v) { intensity = clamp(num(v, 0), 0, 1); return intensity; },
    setScale(v) { scale = clamp(num(v, scale), 0, 1); return scale; },
    setEnabled(v) { enabled = v !== false; return enabled; },
    reset,
    get state() { return state; },
    get enabled() { return enabled; },
    get scale() { return scale; },
    get intensity() { return intensity; },
    get transitions() { return transitions; },
    snapshot() {
      return {
        state, prev, dwellMs: Math.round(dwellMs), since, until: Math.round(until),
        nextDelayMs: Math.round(nextDelayMs), action, intensity, enabled, scale, transitions,
        recent: recent.slice(),
      };
    },
    config: cfg,
  };
}
