// gaze-commit.mjs —— 眼神偏移的「帧内提交」纯逻辑（2026-11-21 P1）
//
// 背景（真机根因）：GazeFollow.apply() 在 renderer.updateView() **之后**写
// ParamEyeBallX/Y、AngleX/Y，而 updateView 开头会用 defaults 重置全部参数、
// 结尾才 _model.update() 重算顶点 —— 写在后面既不参与本帧顶点重算，下一帧又被
// defaults 清掉，所以眼神跟随从来没有进入过画面。
//
// 这个模块只做「把偏移加到当前值上」，由 cubism-renderer 在物理/顶点重算之前调用。
// 单独成模块是为了能在纯 node 下用 stub 断言最终值（不启 Electron / 不加载模型）。

/** 偏移字段 → 要写的参数。眼球直接覆盖；头部是「在待机/动作之上再偏一点」，所以是加。 */
export const GAZE_FIELDS = Object.freeze([
  ['eyeX', 'ParamEyeBallX'],
  ['eyeY', 'ParamEyeBallY'],
  ['headX', 'ParamAngleX'],
  ['headY', 'ParamAngleY'],
  // 配件/第二套物理读的是控制器层 AngleXYZ，和骨头保持一致
  ['headX', 'AngleX'],
  ['headY', 'AngleY'],
]);

/**
 * 把一帧 gaze 偏移写进参数（加法语义）。
 * @param {{get:(id:string)=>number, set:(id:string,value:number)=>void}} io
 * @param {{eyeX?:number,eyeY?:number,headX?:number,headY?:number}|null} gaze
 * @returns {Array<[string, number]>} 实际写入的 [参数, 最终值]，便于断言/诊断
 */
export function applyGazeOffsets(io, gaze) {
  const applied = [];
  if (!io || !gaze) return applied;
  for (const [field, id] of GAZE_FIELDS) {
    const delta = Number(gaze[field]);
    if (!Number.isFinite(delta) || Math.abs(delta) < 1e-6) continue;
    const base = Number(io.get(id)) || 0;
    const next = base + delta;
    io.set(id, next);
    applied.push([id, next]);
  }
  return applied;
}
