// 情绪原型表：每种情绪「长什么样」。
//
// 数值是区间 [最小, 最大]，取中点作为该情绪的典型脸；区间存在的意义是
// 同一个情绪在不同强度/不同语境下可以取不同值（变体 variants 就是钉死在区间里的某一段）。
// 这些区间是给「风格层」用的：VAD 给方向和幅度，风格层给它一个「像什么情绪」的签名，
// 两层按权重混合，所以表情既有连续性，又能被一眼读成「她在委屈」而不是「她嘴角往下」。

export const EMOTION_ARCHETYPES = {
  neutral: {
    zh: '中性',
    range: { mouthSmile: [0.03, 0.09], eyeOpen: [0.98, 1.02] },
  },
  happy: {
    zh: '开心',
    range: { mouthSmile: [0.32, 0.76], eyeSmile: [0.16, 0.46], browOuterUp: [0.02, 0.1], eyeOpen: [1.0, 1.08] },
    variants: {
      soft: { mouthSmile: [0.26, 0.45], eyeSmile: [0.1, 0.26] },
      bright: { mouthSmile: [0.6, 0.9], eyeSmile: [0.34, 0.6], browOuterUp: [0.08, 0.2] },
      shy_happy: { mouthSmile: [0.3, 0.55], eyeSmile: [0.18, 0.38], blush: [0.35, 0.75] },
    },
  },
  excited: {
    zh: '兴奋',
    range: { mouthSmile: [0.52, 0.88], eyeOpen: [1.08, 1.24], browOuterUp: [0.18, 0.44], eyeSmile: [0.2, 0.48] },
  },
  sad: {
    zh: '难过',
    range: { mouthFrown: [0.24, 0.5], browInnerUp: [0.3, 0.6], eyeOpen: [0.74, 0.9], eyeSquint: [0, 0.1] },
    variants: {
      quiet: { mouthFrown: [0.14, 0.28], browInnerUp: [0.2, 0.38], eyeOpen: [0.8, 0.94] },
      crying: { mouthFrown: [0.35, 0.6], browInnerUp: [0.5, 0.8], eyeOpen: [0.55, 0.75], tear: [0.3, 0.7] },
    },
  },
  aggrieved: {
    zh: '委屈',
    range: { browInnerUp: [0.58, 0.94], mouthFrown: [0.28, 0.54], eyeOpen: [0.58, 0.8], tear: [0.05, 0.28] },
  },
  angry: {
    zh: '生气',
    range: { browDown: [0.28, 0.58], mouthFrown: [0.16, 0.42], eyeSquint: [0.1, 0.3], eyeOpen: [0.76, 0.94] },
    variants: {
      annoyed: { browDown: [0.18, 0.34], mouthFrown: [0.1, 0.22] },
      firmly: { browDown: [0.36, 0.6], mouthFrown: [0.24, 0.46] },
    },
  },
  surprise: {
    zh: '惊讶',
    range: { browOuterUp: [0.3, 0.56], eyeOpen: [1.1, 1.28], eyeSmile: [0, 0.1], mouthSmile: [0.02, 0.1] },
    variants: {
      startled: { browOuterUp: [0.4, 0.62], eyeOpen: [1.16, 1.3] },
    },
  },
  shy: {
    zh: '害羞',
    range: { mouthSmile: [0.2, 0.46], eyeSmile: [0.1, 0.3], eyeOpen: [0.8, 0.95], blush: [0.42, 0.88], browInnerUp: [0.06, 0.18] },
    variants: {
      bashful: { blush: [0.6, 0.95], mouthSmile: [0.26, 0.5], eyeSmile: [0.16, 0.36] },
      embarrassed: { blush: [0.3, 0.6], mouthSmile: [0.04, 0.16], sweat: [0.1, 0.3] },
    },
  },
  smug: {
    zh: '得意',
    range: { mouthSmile: [0.28, 0.5], eyeSmile: [0.14, 0.34], browUpR: [0.24, 0.5], browUpL: [0, 0.08],
      mouthSmileR: [0.3, 0.52], mouthSmileL: [0.08, 0.18], cheekPuff: [0.05, 0.12] },
    variants: {
      // 单边挑眉：一边高一边不抬，是她最「欠揍」的那张脸
      lopsided: { browUpR: [0.36, 0.6], browUpL: [0, 0.04], mouthSmile: [0.32, 0.54],
        mouthSmileR: [0.42, 0.6], mouthSmileL: [0.02, 0.1], eyeSquintR: [0.16, 0.3] },
    },
  },
  tease: {
    zh: '嘲讽',
    range: { mouthSmile: [0.14, 0.34], browUpL: [0.2, 0.42], eyeSmile: [0.08, 0.24], eyeOpen: [0.88, 0.98],
      // 嘲讽是「一边嘴角先翘」：左边明显、右边压住
      mouthSmileL: [0.24, 0.4], mouthSmileR: [0.02, 0.1], eyeSquintR: [0.08, 0.18] },
  },
  bored: {
    zh: '无聊',
    range: { eyeOpen: [0.54, 0.72], mouthFrown: [0.02, 0.12], browInnerUp: [0.08, 0.2], eyeSquint: [0.04, 0.14] },
  },
  guilty: {
    zh: '心虚',
    range: { eyeOpen: [0.84, 0.98], mouthFrown: [0.08, 0.22], browInnerUp: [0.18, 0.34], sweat: [0.08, 0.28] },
  },
  sleepy: {
    zh: '困',
    range: { eyeOpen: [0.34, 0.56], browInnerUp: [0.08, 0.18], mouthFrown: [0, 0.08], eyeSmile: [0, 0.1] },
    variants: {
      nodding_off: { eyeOpen: [0.22, 0.4] },
    },
  },
  calm: {
    zh: '平静',
    range: { mouthSmile: [0.08, 0.2], eyeSmile: [0.06, 0.16], eyeOpen: [0.86, 0.96] },
  },
  warm: {
    zh: '温柔',
    range: { mouthSmile: [0.24, 0.5], eyeSmile: [0.16, 0.36], browInnerUp: [0.04, 0.14], blush: [0.04, 0.18] },
  },
  curious: {
    zh: '好奇',
    range: { browOuterUp: [0.1, 0.26], eyeOpen: [1.02, 1.14], mouthSmile: [0.04, 0.14] },
  },
  anxiety: {
    zh: '不安',
    range: { browInnerUp: [0.3, 0.56], eyeOpen: [0.95, 1.1], mouthFrown: [0.1, 0.3], sweat: [0.05, 0.2] },
  },
  affectionate: {
    zh: '亲昵',
    range: { mouthSmile: [0.26, 0.52], eyeSmile: [0.18, 0.4], browInnerUp: [0.04, 0.14], blush: [0.06, 0.22] },
  },
  anger: {
    zh: '愤怒',
    range: { browDown: [0.3, 0.6], mouthFrown: [0.18, 0.44], eyeSquint: [0.1, 0.32], eyeOpen: [0.78, 0.96] },
  },
};

// 「soft-happy / soft-low」这类弱情绪别名归一到原型名，风格层才有东西可用。
export function normalizeEmotion(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return 'neutral';
  if (EMOTION_ARCHETYPES[key]) return key;
  if (key === 'soft-happy' || key === 'soft-positive') return 'happy';
  if (key === 'soft-calm' || key === 'soft-steady') return 'calm';
  if (key === 'soft-curious') return 'curious';
  if (key === 'soft-shy') return 'shy';
  if (key === 'soft-uneasy') return 'anxiety';
  if (key === 'soft-low') return 'sad';
  if (key === 'joy') return 'happy';
  if (key === 'proud') return 'smug';
  if (key === 'worried') return 'anxiety';
  return 'neutral';
}

// 区间 → 典型值（中点）。variants 里的区间会覆盖同名字段。
export function resolveArchetypeStyle(emotion, variant) {
  const key = normalizeEmotion(emotion);
  const archetype = EMOTION_ARCHETYPES[key] || EMOTION_ARCHETYPES.neutral;
  const merged = Object.assign({}, archetype.range, (variant && archetype.variants && archetype.variants[variant]) || {});
  const style = {};
  for (const [channel, range] of Object.entries(merged)) {
    if (!Array.isArray(range) || range.length < 2) continue;
    style[channel] = (Number(range[0]) + Number(range[1])) / 2;
  }
  return style;
}

export function listEmotions() {
  return Object.keys(EMOTION_ARCHETYPES).map((key) => ({ key, zh: EMOTION_ARCHETYPES[key].zh }));
}
