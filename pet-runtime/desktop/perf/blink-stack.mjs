// blink-stack.mjs —— 眨眼「二次相乘」的判定（2026-11-21 P2）
//
// 根因：updateView 在眨眼之后保存 __blinkEyeL/R，表情层跑完再乘一次——
// 注释的假设是「表情运动会写 ParamEyeLOpen/ROpen，把眨眼盖掉」。
// 但 jellyfish 的 23 个 exp3 **没有一个写 EyeOpen**（换装配件为主），
// 于是这个乘法在「有表情」时恒成立：0.3 × 0.3 = 0.09，眨眼被平方，几乎看不见。
//
// 正确判据：只有当前真的挂着「会写 EyeOpen 的表情」时才乘回。
// 纯函数，便于在 node 下用 stub 断言（cubism-renderer 依赖 .ts，node 不能直接 import）。

/** 眼睛开合参数 id。 */
export const EYE_OPEN_IDS = Object.freeze(['ParamEyeLOpen', 'ParamEyeROpen']);

/** 这组参数里是否包含眼睛开合（用于加载期给每个 exp3 打标）。 */
export function writesEyeOpen(paramIds) {
  const list = Array.isArray(paramIds) ? paramIds : [];
  for (const id of list) {
    if (id === EYE_OPEN_IDS[0] || id === EYE_OPEN_IDS[1]) return true;
  }
  return false;
}

/**
 * 本帧是否需要把眨眼结果乘回。
 * @param {{eyeWriters?: Set<string>, activeNames?: Iterable<string>}} input
 *   eyeWriters：加载期统计的「会写 EyeOpen 的表情名」；activeNames：本帧在演的脸
 * @returns {boolean}
 */
export function shouldRestackBlink(input = {}) {
  const writers = input.eyeWriters;
  if (!writers || typeof writers.has !== 'function') return false;
  const names = input.activeNames;
  if (!names) return false;
  for (const name of names) {
    if (name && writers.has(String(name))) return true;
  }
  return false;
}
