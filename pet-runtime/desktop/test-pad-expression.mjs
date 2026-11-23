// pad-expression 单测：node test-pad-expression.mjs（纯函数，无依赖）
import { padAffect, arousalDynamics, baselineBias, expressionAffect, ANCHOR_PA } from './pad-expression.mjs';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fails++; } };
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// 1. 纯情绪复现锚点（与 pad.rs 同约定）
{
  const { p, a } = padAffect('happy', 1);
  ok(p === ANCHOR_PA.happy[0] && a === ANCHOR_PA.happy[1], 'happy@1.0 应精确在锚点');
}
// 2. 半强度向 neutral 收缩
{
  const full = padAffect('happy', 1);
  const half = padAffect('happy', 0.5);
  const n = ANCHOR_PA.neutral;
  ok(half.p > n[0] && half.p < full.p, '半强度 p 应在 neutral 与锚点之间');
  ok(half.a > n[1] && half.a < full.a, '半强度 a 应在 neutral 与锚点之间');
}
// 3. 未知情绪 → neutral
{
  const { p, a } = padAffect('unknown_emo', 1);
  ok(p === ANCHOR_PA.neutral[0] && a === ANCHOR_PA.neutral[1], '未知情绪应落 neutral');
}
// 4. 唤醒动态单调且有界
{
  const hi = arousalDynamics(0.9), lo = arousalDynamics(-0.9);
  ok(hi.gainMul > lo.gainMul, '高唤醒增益应更大');
  ok(hi.tauMul < lo.tauMul, '高唤醒跟随应更快（tau 更小）');
  ok(hi.gainMul <= 1.2 && lo.gainMul >= 0.6, '增益缩放有界');
  ok(hi.tauMul >= 0.7 && lo.tauMul <= 1.6, 'tau 缩放有界');
}
// 5. 基线偏置语义：坏心气压嘴角、锁眉；好愉悦提笑眼
{
  const down = baselineBias(0, -0.8);
  const up = baselineBias(0, 0.8);
  ok(down.ParamMouthForm < up.ParamMouthForm, '坏心气嘴角基线应更低');
  ok(down.BrowInnerUp < 0 && up.BrowInnerUp === 0, '坏心气应锁眉（负偏置），好心气不动眉');
  const happy = baselineBias(0.8, 0);
  const sad = baselineBias(-0.8, 0);
  ok(happy.EyeSmile > sad.EyeSmile, '愉悦笑眼应大于低落');
  ok(happy.EyeSmile > 0 && sad.EyeSmile === 0, '低落不该有正向笑眼');
  // 压笑容比提嘴角更敏感（人心气差时笑不开更明显）
  ok(Math.abs(baselineBias(0, -0.5).ParamMouthForm) > baselineBias(0, 0.5).ParamMouthForm, '负向心气权重更大');
}
// 6. 端到端：同一情绪不同心气 → 表情目标应不同（跨模态同源的可见效果）
{
  const a1 = expressionAffect('happy', 1, 0.8);
  const a2 = expressionAffect('happy', 1, -0.8);
  ok(a1.bias.ParamMouthForm > a2.bias.ParamMouthForm, '同说 happy，心气差嘴角目标应更低');
  ok(a2.bias.BrowInnerUp < 0 && a1.bias.BrowInnerUp === 0, '心气差应锁眉，心气好不动眉');
}
// 7. clamp 防御
{
  const b = baselineBias(5, -5);
  ok(Object.values(b).every((v) => Math.abs(v) <= 1), '极端输入下偏置仍有界');
}

if (fails) { console.error(`pad-expression: ${fails} 项失败`); process.exit(1); }
console.log('pad-expression: 全部通过（7 组）');
