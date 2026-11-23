// perf-compiler-test.mjs —— MVL 编译器单测（移植自 jingyu compiler.py 的硬约束）
// 跑法：node pet-runtime/tools/perf-compiler-test.mjs
import { compileAction, CompileError, ACTION_TYPES, ease } from '../desktop/perf/compiler.mjs';

let pass = 0;
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  期望 ${JSON.stringify(want)} 实际 ${JSON.stringify(got)}`}`);
};
const check = (label, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond || !extra ? '' : '  ' + extra}`);
};
const expectErr = (label, fn, code) => {
  try {
    fn();
    fail++;
    console.log(`FAIL  ${label}  期望抛 ${code}，实际没抛`);
  } catch (e) {
    const ok = e instanceof CompileError && e.code === code;
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  期望 ${code} 实际 ${e.code || e.message}`}`);
  }
};

const paramIds = new Set(['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamMouthForm', 'ParamEyeLOpen', 'key7']);
const ranges = new Map([
  ['ParamAngleX', [-30, 30]],
  ['ParamAngleY', [-30, 30]],
  ['ParamAngleZ', [-30, 30]],
  ['ParamMouthForm', [-1, 1]],
  ['ParamEyeLOpen', [0, 1]],
  ['key7', [0, 1]],
]);
const defaults = new Map([['ParamAngleX', 0], ['ParamMouthForm', 0], ['ParamEyeLOpen', 1]]);
const ctx = { paramIds, ranges, defaults, isPhysicsOutput: (id) => id === 'ParamAngleX' && false };

// ── 1. 快乐路径：首尾回默认 ───────────────────────────────────────────
{
  const out = compileAction({
    type: 'nod',
    duration: 1.2,
    params: { ParamAngleY: [[0.2, -12], [0.6, 8], [1.0, 0]] },
  }, ctx);
  eq('动作类型', out.action, 'nod');
  eq('时长', out.duration, 1.2);
  eq('轨道数', out.tracks.length, 1);
  eq('首帧回默认', out.tracks[0].keys[0], { t: 0, v: 0, ease: 'linear' });
  eq('末帧回默认', out.tracks[0].keys[out.tracks[0].keys.length - 1], { t: 1.2, v: 0, ease: 'smoothstep' });
}

// ── 2. 校验：参数不存在 ───────────────────────────────────────────────
expectErr('缺参数必须报错', () => compileAction({
  type: 'look', duration: 1, params: { ParamNope: [[0, 0]] },
}, ctx), 'MISSING_PARAM');

// ── 3. 校验：物理输出不可写 ───────────────────────────────────────────
expectErr('物理输出必须报错', () => compileAction({
  type: 'look', duration: 1, params: { ParamAngleZ: [[0, 5]] },
}, { ...ctx, isPhysicsOutput: (id) => id === 'ParamAngleZ' }), 'PHYSICS_OUTPUT');

// ── 4. 校验：越界 ─────────────────────────────────────────────────────
expectErr('越界必须报错', () => compileAction({
  type: 'tilt', duration: 1, params: { ParamAngleZ: [[0.2, 60]] },
}, ctx), 'VALUE_OUT_OF_RANGE');

// ── 5. 校验：关键帧太密 ───────────────────────────────────────────────
expectErr('关键帧间隔 < 0.08s 必须报错', () => compileAction({
  type: 'blink', duration: 1, params: { ParamEyeLOpen: [[0.5, 1], [0.53, 0]] },
}, ctx), 'KEY_TOO_DENSE');

// ── 6. 校验：总长超限 ─────────────────────────────────────────────────
expectErr('总长 > 60s 必须报错', () => compileAction({
  type: 'pose', duration: 61, params: { ParamMouthForm: [[0, 0], [60, 0.5]] },
}, ctx), 'TOO_LONG');

// ── 7. 校验：同参数时间重叠 ───────────────────────────────────────────
expectErr('同参数重叠必须报错', () => compileAction({
  type: 'trajectory', duration: 2,
  tracks: [
    { param: 'ParamMouthForm', keys: [[0, 0], [1.2, 0.5]] },
    { param: 'ParamMouthForm', keys: [[1.0, 0], [2.0, 0.2]] },
  ],
}, ctx), 'OVERLAP');

// ── 8. 未知动作类型 ───────────────────────────────────────────────────
expectErr('未知动作类型必须报错', () => compileAction({ type: 'dance' }, ctx), 'UNKNOWN_TYPE');

// ── 9. 单关键帧自动补首尾 ─────────────────────────────────────────────
{
  const out = compileAction({ type: 'smile', duration: 0.8, params: { ParamMouthForm: [[0.4, 0.6]] } }, ctx);
  const t = out.tracks[0].keys.map((k) => k.t);
  check('单关键帧会补 0 与 duration', t[0] === 0 && t[t.length - 1] === 0.8, JSON.stringify(t));
}

// ── 10. 缓动函数 ──────────────────────────────────────────────────────
eq('smoothstep(0.5)', ease('smoothstep', 0.5), 0.5);
eq('easeIn(0.5)', ease('easeIn', 0.5), 0.25);
eq('未知缓动按 linear', ease('wobble', 0.3), 0.3);
eq('动作类型数量', ACTION_TYPES.length, 10);

console.log(`\n汇总: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
