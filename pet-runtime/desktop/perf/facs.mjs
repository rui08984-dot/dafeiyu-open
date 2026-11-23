// FACS 语义层 —— 情绪与「模型参数」之间的中间表示。
//
// 为什么要这一层（借鉴 soullink-emotion-sdk 的核心结构，2026-11-12）：
//   之前 emotion-engine 的 EMOTIONS 表直接把情绪写成 ParamBrowRY / ParamMouthForm
//   这类**某个模型的具体参数名**。后果是：换模型就全废、缺参数就静默不生效、
//   也没法把「眉毛在动」和「嘴角在动」分开叠加。
//   FACS 层把「表情长什么样」和「模型怎么画」解耦：
//       情绪 → VAD → FACS(23 个语义通道) → 模型画像 → 具体参数
//   语义通道是稳定的，模型画像可以换、可以缺、可以降级。
//
// 单位约定：除 eyeOpen（1 = 正常睁眼）外，其余通道都是 0..1 的强度量；
//           gazeX/gazeY/head*/body* 是 -1..1 的方向量（本模型暂不由这一层驱动，
//           见 profile.mjs 里的外部所有权表）。

export const FACS_KEYS = Object.freeze([
  'browInnerUp', 'browOuterUp', 'browDown', 'browUpL', 'browUpR',
  'eyeOpen', 'eyeSmile', 'eyeSquint', 'eyeBlinkL', 'eyeBlinkR',
  'mouthSmile', 'mouthSmileL', 'mouthSmileR', 'mouthFrown', 'mouthOpen', 'mouthPucker',
  'eyeSquintL', 'eyeSquintR', 'cheekPuff',
  'gazeX', 'gazeY',
  'headX', 'headY', 'headZ',
  'bodyX', 'bodyY', 'bodyZ',
  'blush', 'tear', 'sweat',
  'breath',
]);

// 中性脸。改这里等于改「她的默认长相」，改动前先想清楚。
export const NEUTRAL_FACS = Object.freeze({
  browInnerUp: 0, browOuterUp: 0, browDown: 0, browUpL: 0, browUpR: 0,
  eyeOpen: 1, eyeSmile: 0, eyeSquint: 0, eyeBlinkL: 0, eyeBlinkR: 0,
  mouthSmile: 0.04, mouthSmileL: 0, mouthSmileR: 0, mouthFrown: 0, mouthOpen: 0, mouthPucker: 0,
  eyeSquintL: 0, eyeSquintR: 0, cheekPuff: 0,
  gazeX: 0, gazeY: 0,
  headX: 0, headY: 0, headZ: 0,
  bodyX: 0, bodyY: 0, bodyZ: 0,
  blush: 0, tear: 0, sweat: 0,
  breath: 0.5,
});

// 叠加语义：这几类参数是「偏移量」，多层直接相加（点头 + 情绪歪头要能同时存在）；
// 剩下的是「表现量」，多层取最大（谁更明显听谁的），避免两层笑意叠成咧嘴。
export const ADDITIVE_KEYS = new Set([
  'headX', 'headY', 'headZ', 'bodyX', 'bodyY', 'bodyZ',
  'breath', 'eyeBlinkL', 'eyeBlinkR', 'eyeOpen', 'gazeX', 'gazeY',
  'browUpL', 'browUpR',
]);
export const MAX_KEYS = new Set([
  'mouthOpen', 'blush', 'tear', 'sweat', 'mouthPucker',
  // 不对称表情是「表现量」：两层都笑时取更明显的那个，不叠加成咧嘴（2026-11-12 P0-4）
  'mouthSmileL', 'mouthSmileR', 'eyeSquintL', 'eyeSquintR', 'cheekPuff',
]);

const RANGE = {
  // [min, max]，clamp 用。eyeOpen 允许睁大到 1.28（惊讶），闭到 0.2（眯眼）
  eyeOpen: [0.2, 1.32],
  gazeX: [-1, 1], gazeY: [-1, 1],
  headX: [-1, 1], headY: [-1, 1], headZ: [-1, 1],
  bodyX: [-1, 1], bodyY: [-1, 1], bodyZ: [-1, 1],
};

export function createFACS(overrides = {}) {
  return Object.assign({}, NEUTRAL_FACS, overrides);
}

export function clampFACS(state) {
  const out = {};
  for (const key of FACS_KEYS) {
    const raw = Number(state[key]);
    const value = Number.isFinite(raw) ? raw : NEUTRAL_FACS[key];
    const [min, max] = RANGE[key] || [0, 1];
    out[key] = value < min ? min : value > max ? max : value;
  }
  return out;
}

export function addFACS(base, layer, gain = 1) {
  const out = createFACS(base);
  if (!layer) return out;
  for (const key of FACS_KEYS) {
    const value = Number(layer[key]);
    if (!Number.isFinite(value)) continue;
    out[key] = key === 'eyeOpen'
      ? out[key] + (value - 1) * gain          // eyeOpen 是绝对值，叠加的是「比正常睁大/眯小多少」
      : out[key] + value * gain;
  }
  return clampFACS(out);
}

export function lerpFACS(from, to, amount) {
  const t = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  const out = {};
  for (const key of FACS_KEYS) {
    const a = Number.isFinite(from?.[key]) ? from[key] : NEUTRAL_FACS[key];
    const b = Number.isFinite(to?.[key]) ? to[key] : NEUTRAL_FACS[key];
    out[key] = a + (b - a) * t;
  }
  return clampFACS(out);
}

// 「这张脸有多用力」——用来算表情强度，eyeOpen 环绕 1 取偏离量。
export function facsMagnitude(state) {
  let sum = 0;
  for (const key of FACS_KEYS) {
    const value = Number(state?.[key]);
    if (!Number.isFinite(value)) continue;
    const neutral = NEUTRAL_FACS[key];
    const delta = key === 'eyeOpen' ? (value - neutral) * 2.2 : key === 'breath' ? 0 : value - neutral;
    sum += Math.abs(delta);
  }
  return Math.min(1, sum / 3.2);
}

// 把一张脸按 weight 缩放到中性（weight=0 就是完全中性）。
export function scaleFACS(state, weight) {
  return lerpFACS(NEUTRAL_FACS, clampFACS(state), weight);
}
