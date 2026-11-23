// VAD 连续情绪状态（Valence 效价 / Arousal 唤醒 / Dominance 支配）。
//
// 为什么要它（借鉴 soullink-emotion-sdk 的 EmotionStateController）：
//   原来的情绪是「离散事件 + TTL」：开心 4 秒 → 啪一下回到中性 → 下一条消息再说。
//   人不是这样的：情绪有惯性（不会说完就消失）、有底色（同一句话在心情好和心情差时
//   表现不同）、也有环境漂移（没有新刺激时会在中性附近缓慢游走）。
//   VAD 把「情绪」变成一个连续的状态量，所有下游（表情、动作幅度、TTS 韵律）都从
//   同一个状态派生，表情和声音才不会各说各的。
//
// 设计要点：
//   · target 被 nudge 推开，current 用指数逼近 target（有惯性）；
//   · hold（保持期）内不衰减，hold 结束后 target 缓慢回 baseline（有余韵）；
//   · ambientDrift 是一层极小的随机游走，让「她保持一个表情」时也不是一张死图；
//   · 全部随机走 seeded RNG，同一个 seed 可以复现同一段表演（做回归测试的前提）。

import { clamp } from './util.mjs';

// 情绪锚点。同一套数值同时给「表情合成」和「TTS 律」用，保证声音和脸一致。
// 取值范围都按 -1..1；数值是调的，不是测出来的，改完要肉眼过一遍。
export const VAD_PRESETS = Object.freeze({
  neutral:    { valence:  0.00, arousal:  0.00, dominance:  0.00 },
  happy:      { valence:  0.62, arousal:  0.44, dominance:  0.14 },
  excited:    { valence:  0.72, arousal:  0.82, dominance:  0.34 },
  sad:        { valence: -0.58, arousal: -0.42, dominance: -0.36 },
  angry:      { valence: -0.46, arousal:  0.64, dominance:  0.48 },
  anger:      { valence: -0.46, arousal:  0.64, dominance:  0.48 },
  surprise:   { valence:  0.08, arousal:  0.74, dominance: -0.30 },
  shy:        { valence:  0.28, arousal:  0.10, dominance: -0.68 },
  smug:       { valence:  0.50, arousal:  0.20, dominance:  0.58 },
  tease:      { valence:  0.24, arousal:  0.32, dominance:  0.44 },
  bored:      { valence: -0.26, arousal: -0.56, dominance: -0.04 },
  aggrieved:  { valence: -0.48, arousal:  0.12, dominance: -0.58 },
  guilty:     { valence: -0.30, arousal:  0.22, dominance: -0.44 },
  sleepy:     { valence: -0.18, arousal: -0.74, dominance: -0.24 },
  calm:       { valence:  0.22, arousal: -0.38, dominance:  0.12 },
  warm:       { valence:  0.40, arousal:  0.06, dominance:  0.02 },
  affectionate: { valence: 0.42, arousal: 0.08, dominance: 0.00 },
  curious:    { valence:  0.26, arousal:  0.30, dominance:  0.06 },
  anxiety:    { valence: -0.40, arousal:  0.44, dominance: -0.40 },
});

export function getVADPreset(emotion, fallback = VAD_PRESETS.neutral) {
  const key = String(emotion || '').trim().toLowerCase();
  return VAD_PRESETS[key] || fallback;
}

// 距离权重：支配轴（谁强谁弱）对「看起来像什么情绪」区分度最高，权重给大一点。
function weightedDistance(a, b) {
  const v = a.valence - b.valence;
  const r = a.arousal - b.arousal;
  const d = a.dominance - b.dominance;
  return v * v * 1.06 + r * r * 0.9 + d * d * 1.24;
}

export function vadMagnitude(vad) {
  return clamp((Math.abs(vad.valence) + Math.abs(vad.arousal) * 0.82 + Math.abs(vad.dominance) * 0.64) / 2.46, 0, 1);
}

// 最近的锚点（不含 neutral/angry 这类同义重复项），超过阈值就当「说不上是什么情绪」。
function nearestPreset(vad) {
  let best = 'neutral';
  let bestDistance = Infinity;
  for (const [name, preset] of Object.entries(VAD_PRESETS)) {
    if (name === 'neutral' || name === 'angry' || name === 'affectionate' || name === 'excited' || name === 'calm') continue;
    const distance = weightedDistance(vad, preset);
    if (distance < bestDistance) { bestDistance = distance; best = name; }
  }
  return bestDistance < 0.92 ? best : 'neutral';
}

// 显式判据优先：某些组合（高唤醒 + 低支配 = 慌；正效价 + 低支配 = 害羞）
// 在「最近锚点」上会被邻域抢走，用规则先切一刀。
// 顺序有讲究：越靠前越优先，凡是能在锚点之间混淆的组合都要先判。
// 单测里有一条 round-trip（每个情绪锚点必须能推回自己），改顺序先跑它。
export function inferDominant(vad) {
  const { valence: v, arousal: r, dominance: d } = vad;
  if (v > 0.55 && r > 0.60) return 'excited';
  if (v > 0.20 && d < -0.40) return 'shy';
  if (v > 0.20 && d > 0.40) return r > 0.28 ? 'tease' : 'smug';
  // 好奇与开心在 VAD 上几乎重合；用「效价不到 0.35 且唤醒偏高」把低强度的那一侧判成好奇。
  if (v > 0.05 && v < 0.35 && r > 0.24 && d > -0.10) return 'curious';
  if (v > 0.18 && r > 0.12) return 'happy';
  if (v > 0.10 && r < 0.05) return v > 0.30 ? 'warm' : 'calm';
  if (v < -0.34 && r > 0.38 && d < -0.12) return 'anxiety';
  if (v < -0.42 && r > 0.42 && d > 0.18) return 'anger';
  if (v < -0.30 && r < -0.30) return 'sad';
  if (v < -0.34 && d < -0.42 && r > -0.20) return 'aggrieved';
  if (v < -0.25 && d < -0.30) return 'guilty';
  if (r < -0.50 && v < -0.05) return d < -0.15 ? 'sleepy' : 'bored';
  if (r < -0.45 && v < -0.05) return 'bored';
  return nearestPreset(vad);
}

// 弱情绪：幅度很小时不要报「开心」，报「有点高兴」这种底色，避免表情一惊一乍。
function inferSubtle(vad) {
  const { valence: v, arousal: r, dominance: d } = vad;
  if (v > 0.004 && r > 0.004) return 'soft-happy';
  if (v > 0.004 && r < -0.004) return 'soft-calm';
  if (v > 0.004) return 'soft-positive';
  if (v < -0.004 && r > 0.004) return 'soft-uneasy';
  if (v < -0.004) return 'soft-low';
  if (r > 0.004) return 'soft-curious';
  if (r < -0.004) return 'soft-calm';
  if (d < -0.004) return 'soft-shy';
  if (d > 0.004) return 'soft-steady';
  return 'neutral';
}

// 对外统一入口：先看幅度（太小就只报底色），再走显式判据。
export function dominantFromVAD(vad) {
  const magnitude = vadMagnitude(vad);
  if (magnitude < 0.002) return 'neutral';
  if (magnitude < 0.075) return inferSubtle(vad);
  return inferDominant(vad);
}

// 确定性 PRNG（mulberry32）。同一 seed → 同一段漂移，便于复现和单测。
export function seededRandom(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return function random() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_PERSONALITY = Object.freeze({
  baseline: null,             // 角色底色，大肥鱼默认中性
  reactivity: 1.0,            // 反应强度：同样的刺激，她情绪走多远
  targetApproachRate: 1.5,    // 逼近目标的速度（越大越快「上头」）
  decayRate: 0.30,            // 回落速度（越小余韵越久）
  emotionHoldSeconds: 5.5,    // 情绪至少保这么久再开始回落
  ambientDriftStrength: 0.032,// 环境漂移幅度：0 = 完全静止
  emotionBias: null,          // 对个别情绪的偏好（傲娇可以给 shy 加成）
});

export class VadController {
  constructor(personality = {}) {
    this.personality = { ...DEFAULT_PERSONALITY, ...personality };
    this.random = seededRandom(this.personality.seed || 9137);
    this.baseline = { ...(this.personality.baseline || VAD_PRESETS.neutral) };
    this.current = { ...this.baseline };
    this.target = { ...this.baseline };
    this.ambient = { x: 0, y: 0, z: 0 };
    this.ambientTarget = { x: 0, y: 0, z: 0 };
    this.driftClock = 0;
    this.nextDriftAt = 0.8 + this.random() * 2.1;
    this.holdRemaining = 0;
    this.dominant = 'neutral';
    this.intensity = 0;
    this.lastNudgeAt = 0;
    this.clock = 0;
  }

  setBaseline(baseline) {
    if (!baseline) return;
    this.baseline = {
      valence: clamp(baseline.valence ?? this.baseline.valence, -1, 1),
      arousal: clamp(baseline.arousal ?? this.baseline.arousal, -1, 1),
      dominance: clamp(baseline.dominance ?? this.baseline.dominance, -1, 1),
    };
  }

  // 一次情绪刺激：strength 0..1。
  // amount 用 soullink 的经验式 0.28 + s*0.58 —— 弱刺激也能推得动，
  // 强刺激不至于一步推满（推满会让「慢慢上头」的手感消失）。
  nudge(emotion, strength = 1, options = {}) {
    const preset = options.vad || getVADPreset(emotion, this.target);
    const s = clamp(Number(strength) || 0, 0, 1);
    const bias = (this.personality.emotionBias && this.personality.emotionBias[emotion]) || 1;
    const amount = clamp((0.26 + s * 0.62) * this.personality.reactivity * bias, 0, 0.96);
    this.target = {
      valence: this.target.valence + (preset.valence - this.target.valence) * amount,
      arousal: this.target.arousal + (preset.arousal - this.target.arousal) * amount,
      dominance: this.target.dominance + (preset.dominance - this.target.dominance) * amount,
    };
    const hold = options.holdSeconds ?? (2.2 + s * this.personality.emotionHoldSeconds);
    this.holdRemaining = Math.max(this.holdRemaining, hold);
    this.lastNudgeAt = this.clock;
    return this.target;
  }

  // 直接推一个 VAD 增量（给「用户语气影响她」这类外部信号用）
  nudgeVAD(delta, amount = 1) {
    const gain = clamp(amount * this.personality.reactivity, 0, 2);
    this.target = {
      valence: clamp(this.target.valence + (delta.valence || 0) * gain, -1, 1),
      arousal: clamp(this.target.arousal + (delta.arousal || 0) * gain, -1, 1),
      dominance: clamp(this.target.dominance + (delta.dominance || 0) * gain, -1, 1),
    };
    this.holdRemaining = Math.max(this.holdRemaining, 1.6 + clamp(amount, 0, 1.5) * this.personality.emotionHoldSeconds * 0.5);
  }

  update(dt) {
    const step = clamp(Number(dt) || 0, 0, 0.25);
    this.clock += step;
    const holdActive = this.holdRemaining > 0;
    const approach = 1 - Math.exp(-step * this.personality.targetApproachRate);
    const decay = holdActive ? 0 : 1 - Math.exp(-step * this.personality.decayRate);

    this.holdRemaining = Math.max(0, this.holdRemaining - step);
    this.updateAmbient(step);

    const drifted = {
      valence: clamp(this.target.valence + this.ambient.x, -1, 1),
      arousal: clamp(this.target.arousal + this.ambient.y, -1, 1),
      dominance: clamp(this.target.dominance + this.ambient.z, -1, 1),
    };
    this.current = {
      valence: this.current.valence + (drifted.valence - this.current.valence) * approach,
      arousal: this.current.arousal + (drifted.arousal - this.current.arousal) * approach,
      dominance: this.current.dominance + (drifted.dominance - this.current.dominance) * approach,
    };
    this.target = {
      valence: this.target.valence + (this.baseline.valence - this.target.valence) * decay,
      arousal: this.target.arousal + (this.baseline.arousal - this.target.arousal) * decay,
      dominance: this.target.dominance + (this.baseline.dominance - this.target.dominance) * decay,
    };

    this.intensity = vadMagnitude(this.current);
    this.dominant = dominantFromVAD(this.current);

    return this.state();
  }

  updateAmbient(step) {
    const strength = this.personality.ambientDriftStrength;
    if (!(strength > 0)) return;
    this.driftClock += step;
    if (this.driftClock >= this.nextDriftAt) {
      const pick = (scale) => -strength * scale + this.random() * strength * scale * 2;
      this.ambientTarget = { x: pick(1), y: pick(0.82), z: pick(0.68) };
      this.nextDriftAt = this.driftClock + 1.7 + this.random() * 4.4;
    }
    const approach = 1 - Math.exp(-step * 0.62);
    this.ambient = {
      x: this.ambient.x + (this.ambientTarget.x - this.ambient.x) * approach,
      y: this.ambient.y + (this.ambientTarget.y - this.ambient.y) * approach,
      z: this.ambient.z + (this.ambientTarget.z - this.ambient.z) * approach,
    };
  }

  state() {
    return {
      current: { ...this.current },
      target: { ...this.target },
      dominant: this.dominant,
      intensity: this.intensity,
      holdSeconds: this.holdRemaining,
      clock: this.clock,
    };
  }

  reset() {
    this.current = { ...this.baseline };
    this.target = { ...this.baseline };
    this.ambient = { x: 0, y: 0, z: 0 };
    this.ambientTarget = { x: 0, y: 0, z: 0 };
    this.driftClock = 0;
    this.nextDriftAt = 0.8 + this.random() * 2.1;
    this.holdRemaining = 0;
    this.dominant = 'neutral';
    this.intensity = 0;
    this.clock = 0;
  }
}
