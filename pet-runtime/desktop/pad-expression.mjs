// 统一情绪状态总线 · 表情侧（论文依据：ACTOR 2309.15311 n=199 ——
// 表情/语音必须由同一 driving affect 派生才有「她有情绪」的感知；语音侧已由
// pet-core/src/pad.rs blend_prosody 消费 (emotions, mood)，本文件把同一组输入
// 也喂给表情参数层：心气改「表情基线」，唤醒度改「动态节奏」。
//
// 与 pad.rs 的约定：锚点坐标 (P, A) 逐条镜像 pet-core/src/pad.rs ANCHORS，
// 两边只许同改（改一边不改另一边 = 表情与语音的情绪方向分叉）。

/** 12 情绪的 PAD 锚点 [P, A]（镜像 pad.rs，勿单改一侧） */
export const ANCHOR_PA = {
  happy:     [0.8,  0.6],
  smug:      [0.5,  0.3],
  tease:     [0.4,  0.5],
  surprise:  [0.1,  0.8],
  shy:       [0.3, -0.2],
  neutral:   [0.0,  0.3],
  bored:     [-0.3, -0.5],
  sleepy:    [-0.1, -0.8],
  sad:       [-0.8, -0.3],
  aggrieved: [-0.6, -0.1],
  angry:     [-0.6,  0.9],
  guilty:    [-0.4, -0.2],
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 当前 affect：(情绪, 强度, 心气) → 连续 PAD。
 *  强度 <1 时向 neutral 锚点收缩（与 pad.rs 的 k 语义一致：k 是「靠近锚点的程度」）。 */
export function padAffect(name, strength = 1) {
  const anchor = ANCHOR_PA[name] || ANCHOR_PA.neutral;
  const neutral = ANCHOR_PA.neutral;
  const k = clamp(Number(strength) || 1, 0, 1.5);
  const p = neutral[0] + (anchor[0] - neutral[0]) * Math.min(1, k);
  const a = neutral[1] + (anchor[1] - neutral[1]) * Math.min(1, k);
  return { p, a };
}

/** 唤醒度 → 表情动态缩放：高唤醒 = 幅度略大 + 跟随更快；低唤醒 = 收着动 + 更慢。 */
export function arousalDynamics(a) {
  const a2 = clamp(a, -1, 1);
  return {
    gainMul: 0.90 + 0.25 * a2,      // 0.65 ~ 1.15
    tauMul: 1.15 - 0.35 * a2,       // 0.80 ~ 1.50（tau 越小跟得越快）
  };
}

/** (P, 心气) → 基线偏置（参数单位，叠加在情绪引擎目标上；量级刻意收小——
 *  这是「底色」不是「表情」：心气差的人笑起来也没那么开，而不是一直哭丧脸）。
 *  键 = 情绪引擎 OWNED_PARAMS 里的参数名，值 = 加性偏置幅度。 */
export function baselineBias(p, mood) {
  const pv = clamp(p, -1, 1);
  const m = clamp(mood, -1, 1);
  return {
    // 嘴角：愉悦开一点、心气差收一点（负向更敏感——坏心气压笑容比好心气提嘴角更明显，人如此）
    ParamMouthForm: 0.10 * pv + 0.06 * m * (m < 0 ? 1.5 : 1),
    // 笑眼：愉悦度正才有，心气差打折
    EyeSmile: 0.12 * Math.max(0, pv) * (1 + 0.5 * m),
    // 眉心：心气差微微锁眉（BrowInnerUp 正值=挑眉，负向压）
    BrowInnerUp: -0.14 * Math.max(0, -m),
    // 眼睛睁度：高唤醒/坏心气时略睁大（警觉），困倦心气略眯
    ParamEyeLOpen: 0.05 * (m < 0 ? m : 0),
    ParamEyeROpen: 0.05 * (m < 0 ? m : 0),
  };
}

/** 一步到位：给 applyEmotionTargets 用的包装 */
export function expressionAffect(name, strength, mood) {
  const { p, a } = padAffect(name, strength);
  return {
    p, a,
    ...arousalDynamics(a),
    bias: baselineBias(p, mood),
  };
}

export default { ANCHOR_PA, padAffect, arousalDynamics, baselineBias, expressionAffect };
