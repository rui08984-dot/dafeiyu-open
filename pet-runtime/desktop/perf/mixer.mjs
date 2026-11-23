// 分层混合器：把「待机 / 情绪 / 语音表演 / 反应 / 手动」几路表情叠成一张脸。
//
// 为什么不能直接相加（这是 soullink 的 MotionMixer 教的最重要一件事）：
//   头/身/眨眼是偏移量，相加是对的；但笑容、脸红、泪是表现量，两层相加会溢出
//   （"微笑 + 微笑 = 咧嘴"）。所以每个通道按语义定一套规则：
//     additive —— 偏移量，相加
//     max      —— 表现量，谁更明显听谁的
//     set      —— 覆盖（手动表情/预设预览）
// 这套规则是「叠加不炸」的地基，后面想加任何新层都不用重算公式。

import { ADDITIVE_KEYS, MAX_KEYS, NEUTRAL_FACS, clampFACS, createFACS } from './facs.mjs';

const LAYER_ORDER = ['idle', 'emotion', 'speech', 'reaction', 'manual'];

function ruleFor(layer, key) {
  if (layer === 'manual') return 'set';
  if (layer === 'reaction') return ADDITIVE_KEYS.has(key) ? 'add' : 'max';
  if (layer === 'speech') {
    // 语音表演只碰眉眼，绝不碰嘴（嘴归口型层）；眉毛是偏移量，眼笑/眯眼取 max。
    if (key === 'eyeOpen') return 'add';
    if (ADDITIVE_KEYS.has(key) || key.startsWith('brow')) return 'add';
    return 'max';
  }
  if (layer === 'idle') return ADDITIVE_KEYS.has(key) ? 'add' : 'max';
  // emotion
  if (key === 'eyeOpen') return 'add';
  if (ADDITIVE_KEYS.has(key) || key.startsWith('brow') || key === 'mouthSmile' || key === 'mouthFrown') return 'add';
  if (MAX_KEYS.has(key)) return 'max';
  return 'max';
}

/**
 * @param {Record<string, object|null|undefined>} layers
 * @returns {import('./facs.mjs').FACSLikeState}
 */
export function mixLayers(layers) {
  let result = createFACS();
  for (const layerName of LAYER_ORDER) {
    const layer = layers && layers[layerName];
    if (!layer) continue;
    const next = Object.assign({}, result);
    for (const key of Object.keys(layer)) {
      const raw = Number(layer[key]);
      if (!Number.isFinite(raw)) continue;
      const neutral = NEUTRAL_FACS[key] ?? 0;
      const delta = key === 'eyeOpen' ? raw - 1 : raw - neutral;
      const rule = ruleFor(layerName, key);
      if (rule === 'set') next[key] = raw;
      else if (rule === 'add') next[key] = (Number.isFinite(result[key]) ? result[key] : neutral) + delta;
      else next[key] = Math.max(Number.isFinite(result[key]) ? result[key] : neutral, raw);
    }
    result = clampFACS(next);
  }
  return result;
}
