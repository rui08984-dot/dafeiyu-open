// perf-jitter-test.mjs —— 「不许抖」回归（用户 2026-11-12 硬约束）
//
// 背景：她说一句话时如果参数每帧来回抽，看起来就是「抽搐」。平滑层能压住大部分，
// 但真正会抖的是「两层同时写同一参数」或「目标值每帧跳」。
// 这里用无头引擎跑一段真实节奏（中性 → 开心 + 说话 → 中途转生气 → 收尾），
// 逐帧记录参数，检查两件事：
//   ① 单帧最大跳变（16ms 内跳太多 = 视觉上就是闪一下）
//   ② 方向翻转次数（正负来回 = 嗡嗡抖）
//
// 跑法：node pet-runtime/tools/perf-jitter-test.mjs
import { createPerfEngine, buildProfile, PROFILE_SPECS } from '../desktop/perf/index.mjs';

const PARAMS = [
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeLOpen', 'ParamEyeROpen', 'EyeSmile',
  'LEyeSquint', 'REyeSquint', 'ParamMouthForm', 'ParamMouthOpenY', 'MouthSmile_L', 'MouthSmile_R',
  'Mouthpucker', 'CheeckPuff', 'BrowInnerUp', 'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLAngle', 'ParamBrowRAngle',
  'key2', 'key7', 'key13',
];
const profile = buildProfile(PROFILE_SPECS.jellyfish, {
  paramIds: PARAMS,
  expressions: ['脸红', '流泪', '流冷汗'],
  ranges: new Map(PARAMS.map((p) => [p, [0, 1]])),
});
const baseline = { ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamMouthForm: 0, EyeSmile: 0, BrowInnerUp: 0 };

const engine = createPerfEngine({ profile, baseline, seed: 20261112 });
const FPS = 60;
const DT = 1 / FPS;
const frames = [];

function step(n) {
  for (let i = 0; i < n; i++) {
    const out = engine.update(DT);
    frames.push({ t: frames.length * DT, params: { ...out.params }, emotion: out.emotion });
  }
}

step(90);                                                        // 1.5s 中性
engine.feed({ emotion: 'happy', strength: 0.9, holdSeconds: 1.6 });
engine.speak('哈哈，真的吗！！这也太厉害了。', 2600);             // 说话 + 语气的眉眼重音
step(60);                                                        // 1s：说话中
engine.feed({ emotion: 'angry', strength: 0.8, holdSeconds: 1.2 });
step(120);                                                       // 2s：中途转情绪
engine.setGate(0);
step(60);                                                        // 1s：收尾熄灯

// ── 指标 ─────────────────────────────────────────────────────────────
const MAX_STEP = 0.25;          // 单帧跳变上限（16ms 内 0.25 ≈ 肉眼可见的闪）
const MAX_FLIPS = 18;           // 4 秒内方向翻转次数上限（>4.5/s 就是嗡嗡抖）
const report = [];
for (const p of PARAMS) {
  let maxStep = 0;
  let flips = 0;
  let lastSign = 0;
  let prev = null;
  for (const f of frames) {
    const v = f.params[p];
    if (!Number.isFinite(v)) { prev = null; continue; }
    if (prev !== null) {
      const d = v - prev;
      if (Math.abs(d) > maxStep) maxStep = Math.abs(d);
      const sign = Math.abs(d) < 1e-4 ? 0 : Math.sign(d);
      if (sign && lastSign && sign !== lastSign) flips += 1;
      if (sign) lastSign = sign;
    }
    prev = v;
  }
  report.push({ param: p, maxStep, flips });
}

let pass = 0;
let fail = 0;
for (const r of report) {
  const okStep = r.maxStep <= MAX_STEP;
  const okFlip = r.flips <= MAX_FLIPS;
  (okStep && okFlip) ? pass++ : fail++;
  const flags = [];
  if (!okStep) flags.push(`跳变 ${r.maxStep.toFixed(3)} > ${MAX_STEP}`);
  if (!okFlip) flags.push(`翻转 ${r.flips} > ${MAX_FLIPS}`);
  console.log(`${okStep && okFlip ? 'PASS' : 'FAIL'}  ${r.param.padEnd(20)} maxΔ=${r.maxStep.toFixed(3)}  flips=${r.flips}${flags.length ? '  ← ' + flags.join(' / ') : ''}`);
}

// 场景断言：这段节奏里必须真的演过情绪（否则测试是空转）
const emotions = new Set(frames.map((f) => f.emotion).filter((e) => e && e !== 'neutral'));
console.log(`\n覆盖到的情绪: ${[...emotions].join(', ') || '(无)'}`);
if (emotions.size < 2) { fail++; console.log('FAIL  场景没覆盖到两种情绪，测试无效'); } else pass++;

console.log(`\n汇总: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
