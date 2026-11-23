// VAD → FACS：把连续情绪量翻译成「脸怎么动」。
//
// 公式取自 soullink 的 VADExpressionMapper（比例改大了一档，因为我们的模型
// ParamMouthForm / 眉毛行程比它默认的 Live2D 模型浅，照抄会「看不出来」）。
// 然后再叠一层「情绪原型」的风格签名：VAD 负责方向和幅度，原型负责可读性。

import { NEUTRAL_FACS, ADDITIVE_KEYS, clampFACS, lerpFACS } from './facs.mjs';
import { resolveArchetypeStyle } from './archetypes.mjs';
import { clamp, lerp } from './util.mjs';

const STYLE_DIRECTIONAL = new Set([
  'gazeX', 'gazeY', 'headX', 'headY', 'headZ', 'bodyX', 'bodyY', 'bodyZ', 'eyeOpen',
  'browUpL', 'browUpR',
]);

// 纯 VAD → 表情。不含任何「这是哪种情绪」的信息，只是一张连续的、会呼吸的脸。
export function vadToFACS(vad) {
  const v = Number(vad?.valence) || 0;
  const r = Number(vad?.arousal) || 0;
  const d = Number(vad?.dominance) || 0;

  const positive = Math.max(0, v);
  const negative = Math.max(0, -v);
  const aroused = Math.max(0, r);
  const calm = Math.max(0, -r);
  const submissive = Math.max(0, -d);
  const dominant = Math.max(0, d);

  return clampFACS({
    mouthSmile: positive * 0.50 + calm * positive * 0.16,
    mouthFrown: negative * 0.36 + calm * negative * 0.12,
    browInnerUp: negative * 0.26 + submissive * 0.30,
    // 负效价会压住「外眉上扬」：生气时眉毛是内端下压、外端并不抬得那么开，
    // 两者都往 ParamBrowY 上写会互相抵消（实测欠火），所以负面时抑制这一项。
    browOuterUp: aroused * 0.26 * (1 - negative * 0.75) + positive * aroused * 0.10,
    browDown: dominant * negative * 0.46,
    eyeSmile: positive * 0.26 + calm * positive * 0.10,
    eyeSquint: negative * dominant * 0.30 + calm * 0.10,
    eyeOpen: clamp(1 + aroused * 0.12 - calm * 0.10 - negative * 0.06, 0.72, 1.32),
    mouthPucker: submissive * positive * 0.14,
    blush: positive * submissive * 0.55,
    sweat: negative * aroused * 0.35,
    tear: negative * submissive * 0.30,
    breath: NEUTRAL_FACS.breath,
  });
}

// 把风格签名叠到 base 上。
//   · 方向量（头/眼/单边眉）叠「偏离中性多少」，这样能保留 VAD 已经给的方向；
//   · 表现量取 max，避免两层笑意叠成咧嘴。
export function applyStyle(base, style, amount) {
  const weight = clamp(amount, 0, 1);
  if (weight <= 0 || !style) return clampFACS(base);
  const out = Object.assign({}, base);
  for (const [key, target] of Object.entries(style)) {
    const value = Number(target);
    if (!Number.isFinite(value)) continue;
    const neutral = NEUTRAL_FACS[key] ?? 0;
    const styled = lerp(neutral, value, weight);
    const current = Number.isFinite(out[key]) ? out[key] : neutral;
    if (STYLE_DIRECTIONAL.has(key) || ADDITIVE_KEYS.has(key)) out[key] = current + (styled - neutral);
    else out[key] = Math.max(current, styled);
  }
  return clampFACS(out);
}

// 一步到位：VAD + 情绪名 + 变体 → 一张完整的脸（不含 idle/语音层）。
export function composeFace(vad, options = {}) {
  const emotion = options.emotion || 'neutral';
  const style = options.style || (emotion && emotion !== 'neutral' ? resolveArchetypeStyle(emotion, options.variant) : null);
  const intensity = clamp(Number(options.intensity ?? 1), 0, 1);
  const styleGain = clamp(Number(options.styleGain ?? 1), 0, 2.4);
  // 风格强度跟着情绪幅度走：弱情绪只露一点签名，强情绪才「整张脸都在演」。
  const amount = emotion === 'neutral'
    ? 0
    : clamp((0.12 + intensity * 0.62) * styleGain, 0, 0.72);

  let face = vadToFACS(vad);
  face = applyStyle(face, style, amount);
  return clampFACS(face);
}

export { lerpFACS };
