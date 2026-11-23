// facs-clip-player.mjs —— FACS 片段播放器（2026-11-17 六十二轮续）
//
// 是什么：把 `pet-runtime/data/facs-clips/` 里的 FACS 片段（由 LumenAct 表演曲线转换而来）
// 在任意时刻采样成一层 FACS 状态，交给既有混合器（mixer.mjs）当 `reaction` 层用。
//
// 为什么是「一层 FACS」而不是直接写参数：
//   FACS 是我们的语义中间层（facs.mjs）。片段只描述「眼睛笑多少、眉压多少」，
//   落到哪个 Cubism 参数由 profile.mjs 决定 —— 换皮套不用改片段，缺参数自动降级。
//
// 三个必须有的行为（都是踩过坑才会想到的）：
//   1. **两端淡入淡出**：片段进/出不能瞬跳，否则像贴图切换（LumenAct 那边的参考播放器
//      也是 0.4s 交叉淡入淡出，我们取 240ms，因为我们的 FACS 层本身还有一阶惯性）。
//   2. **说话时闭嘴**：嘴的通道属于口型层（mixer 里 speech 层「绝不碰嘴」），
//      片段一旦在说话时驱动 mouthOpen，会和口型打架 → 由调用方传 speechActive，这里直接屏蔽。
//   3. **纯函数 + 注入时钟**：能在 node 里单测，不依赖渲染。
//
// 纯模块：不 require fs / electron / DOM。

import { NEUTRAL_FACS } from './facs.mjs';

export const FACSCLIP_SCHEMA = 'petbody.facs-clip.v1';

/** 嘴部通道：说话时必须屏蔽（口型层拥有它们） */
export const MOUTH_KEYS = Object.freeze(['mouthOpen', 'mouthSmile', 'mouthSmileL', 'mouthSmileR', 'mouthFrown', 'mouthPucker']);

/** FACS 通道的合理范围（用于导入校验与采样 clamp） */
export const CLIP_RANGES = Object.freeze({
  browInnerUp: [0, 1], browOuterUp: [0, 1], browDown: [0, 1], browUpL: [0, 1], browUpR: [0, 1],
  eyeOpen: [-0.8, 0.4],          // 相对 1 的偏移量（负=闭小，正=睁大）
  eyeSmile: [0, 1], eyeSquint: [0, 1], eyeSquintL: [0, 1], eyeSquintR: [0, 1],
  eyeBlinkL: [0, 1], eyeBlinkR: [0, 1],
  mouthSmile: [0, 1], mouthSmileL: [0, 1], mouthSmileR: [0, 1], mouthFrown: [0, 1],
  mouthOpen: [0, 1], mouthPucker: [0, 1], cheekPuff: [0, 1],
  tear: [0, 1], sweat: [0, 1], blush: [0, 1],
  gazeX: [-1, 1], gazeY: [-1, 1],
  headX: [-1, 1], headY: [-1, 1], headZ: [-1, 1],
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 线性插值采样一个通道数组（越界取端点） */
export function sampleChannel(arr, pos) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  if (pos <= 0) return Number(arr[0]) || 0;
  const last = arr.length - 1;
  if (pos >= last) return Number(arr[last]) || 0;
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  const a = Number(arr[i0]) || 0;
  const b = Number(arr[i0 + 1]) || 0;
  return a + (b - a) * frac;
}

/** 淡入淡出权重：0 → 1 → 0（两端各 fadeMs） */
export function fadeWeight(tMs, durationMs, fadeMs) {
  const fade = Math.max(0, Math.min(Number(fadeMs) || 0, durationMs / 2));
  if (fade <= 0) return 1;
  if (tMs < fade) return tMs / fade;
  if (tMs > durationMs - fade) return Math.max(0, (durationMs - tMs) / fade);
  return 1;
}

/**
 * 在 tMs 处采样片段。
 * @param {object} clip  facs-clip（schema = FACSCLIP_SCHEMA）
 * @param {number} tMs   片段内时间（从 0 开始）
 * @param {{speechActive?: boolean, fade?: boolean, keys?: string[]}} opts
 * @returns {{facs: Record<string, number>, weight: number, done: boolean, tMs: number}}
 */
export function sampleClip(clip, tMs, opts = {}) {
  if (!clip || clip.schema !== FACSCLIP_SCHEMA) return { facs: {}, weight: 0, done: true, tMs: 0 };
  const fps = Number(clip.fps) || 20;
  const frames = Number(clip.frames) || 0;
  const durationMs = Number(clip.durationMs) || 0;
  const t = clamp(Number(tMs) || 0, 0, durationMs);
  const done = t >= durationMs;

  const weight = opts.fade === false ? 1 : fadeWeight(t, durationMs, clip.fadeMs ?? 240);
  const pos = (t / 1000) * fps;
  const out = {};
  const only = Array.isArray(opts.keys) && opts.keys.length ? new Set(opts.keys) : null;

  for (const [key, arr] of Object.entries(clip.channels || {})) {
    if (only && !only.has(key)) continue;
    if (opts.speechActive && MOUTH_KEYS.includes(key)) continue;
    let v = sampleChannel(arr, pos);
    const range = CLIP_RANGES[key];
    if (range) v = clamp(v, range[0], range[1]);
    // 片段里存的是**相对中性的偏移量**；FACS 层要的是**绝对值**。
    // eyeOpen 的中性值是 1（1=正常睁眼），其余是 0 —— 不回填的话，
    // 淡入瞬间会把「睁眼偏移 0.3」当成「闭到 0.3」，眼睛直接闭上（实测踩到）。
    const neutral = Number.isFinite(NEUTRAL_FACS[key]) ? NEUTRAL_FACS[key] : 0;
    // 淡入淡出作用在「离中性有多远」上：weight=0 时精确回到中性
    out[key] = Math.round((neutral + v * weight) * 1000) / 1000;
  }
  return { facs: out, weight, done, tMs: t };
}

/**
 * 有状态的播放器（一帧一拍地喂 tNow）。
 * 用法：
 *   const p = createClipPlayer(clip);
 *   p.play(nowMs);
 *   const { facs, done } = p.sample(nowMs, { speechActive });
 */
export function createClipPlayer(clip, opts = {}) {
  let startedAt = 0;
  let playing = false;
  const player = {
    clip,
    play(nowMs) { startedAt = Number(nowMs) || 0; playing = true; return player; },
    stop() { playing = false; return player; },
    get isPlaying() { return playing; },
    sample(nowMs, sampleOpts = {}) {
      if (!playing) return { facs: {}, weight: 0, done: true, tMs: 0 };
      const res = sampleClip(clip, (Number(nowMs) || 0) - startedAt,
        Object.assign({ fade: opts.fade !== false }, sampleOpts));
      if (res.done) playing = false;
      return res;
    },
  };
  return player;
}

/** 片段选择：先按 label，再按 emotion，最后任意；避免与上次相同（除非只剩一段） */
export function pickClip(clips, opts = {}) {
  const list = Array.isArray(clips) ? clips : [];
  if (!list.length) return null;
  const { label, emotion, avoidId, seed } = opts;
  let pool = list;
  if (label) {
    const byLabel = list.filter((c) => c.label === label);
    if (byLabel.length) pool = byLabel;
  }
  if (pool === list && emotion) {
    const byEmotion = list.filter((c) => c.emotion === emotion);
    if (byEmotion.length) pool = byEmotion;
  }
  const filtered = avoidId && pool.length > 1 ? pool.filter((c) => c.id !== avoidId) : pool;
  const arr = filtered.length ? filtered : pool;
  const n = Number.isFinite(Number(seed)) ? Math.abs(Math.floor(seed)) : 0;
  return arr[n % arr.length];
}

/** 把片段索引映射成「情绪 → 可用 label」的清单（供导演层挑） */
export function summarizeIndex(indexDoc) {
  const clips = (indexDoc && indexDoc.clips) || [];
  const byLabel = {};
  for (const c of clips) {
    if (!c.label) continue;
    if (!byLabel[c.label]) byLabel[c.label] = [];
    byLabel[c.label].push(c.id);
  }
  return { clipCount: clips.length, labels: Object.keys(byLabel).sort(), byLabel };
}
