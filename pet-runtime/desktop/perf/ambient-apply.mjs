// ambient-apply.mjs —— 待机层偏置「真正落到参数」的换算层（2026-11-25 P1.5，ADR-015 §3.4）
//
// 为什么需要这一层（P1 的教训）：
//   P1 把 ambient 的 bias 并进了 perf 的 FACS idle 层，但 headX/headY/headZ/gazeX/gazeY/
//   breath/bodyX/bodyY/bodyZ 在 profile.mjs 的 EXTERNALLY_OWNED 里**全部**是外部所有
//   （interaction-motion / GazeFollow / body-director），buildProfile 建画像时整通道丢弃。
//   于是「看起来在写、实际被画像扔掉」——只有 motionScale 真的生效。
//
// 这一层的定位：
//   · 输入 base = body-director / interaction-motion **本帧已经算出来的原值**（它们是这些
//     参数的合法所有者）；输出 = 加上 ambient 偏置后的同一个值。
//   · 渲染器把它并进自己那次 PROC_MOTION 写入（同帧单写），因此不新增第二个写者，
//     也不碰参数所有权表 —— ambient 只是「同一所有者内部的一个加法项」。
//
// 单位约定：
//   · amb.* 是**归一化** [-1,1] 的偏置（bias/满量程，见 normalizeAmbientBias）；
//   · 系数把归一化量换算成模型参数单位：头 yaw/pitch ±3.0°、roll ±1.5°、
//     breath ±0.12、ParamBodyAngleZ ±2.0°、眼球 ±0.15、Position ±0.02。
//
// 纯模块：不 require fs / electron / DOM，可单测。

import { clamp } from './util.mjs';

/**
 * 系数默认值（可被 opts.coeffs 覆盖）。
 * 单位 = 目标参数的模型单位（不是 FACS 单位）。
 */
export const AMBIENT_APPLY_DEFAULTS = Object.freeze({
  headYawDeg: 3.0,     // ParamAngleX ±3.0°
  headPitchDeg: 3.0,   // ParamAngleY ±3.0°
  headRollDeg: 1.5,    // ParamAngleZ ±1.5°（bias 没有独立 roll 通道，由 posture 驱动）
  breath: 0.12,        // ParamBreath ±0.12（0..1 量纲）
  bodyZDeg: 2.0,       // ParamBodyAngleZ ±2.0°
  gaze: 0.15,          // ParamEyeBallX/Y ±0.15（-1..1）
  pos: 0.02,           // PositionX/Z ±0.02
  // 说话时头/眼系数减半（呼吸不变）：说话时主体动作归 interaction-motion 的 speaking 分支，
  // ambient 只保留「还在呼吸 / 还在慢慢看」的痕迹，不该参与「对着人说话」的指向。
  speakingHeadScale: 0.5,
  speakingGazeScale: 0.5,
});

/** 参数钳位范围（模型 rig 的硬边界，见 cubism-renderer 的 setParameter） */
export const AMBIENT_CLAMP = Object.freeze({
  angle: 30,      // ParamAngleX/Y/Z ∈ [-30,30]
  breath: [0, 1], // ParamBreath ∈ [0,1]
  bodyZ: 10,      // ParamBodyAngleZ ∈ [-10,10]
  gaze: 1,        // ParamEyeBallX/Y ∈ [-1,1]
});

/**
 * ambient.mjs 的 biasAt() 在 amp=1 时的满量程（FACS 偏移单位）。
 *
 * 为什么归一化要跟 biasAt 绑死：bias 的实际量级是 amp × 这些常量（amp ≤ 0.3），
 * 直接把 0.006 当成「归一化值」去乘 3° 会得到 0.018°（肉眼不可见）——
 * 那正是 P1「接了线但什么都没发生」的另一种形态。
 * 归一化后 |amb| ≤ amp ≤ 0.3，再乘系数 → 幅度天然被 scale 约束。
 * ⚠ 改 biasAt 的系数时必须同步改这里（_probe/test-perf-ambient-apply.cjs 会钉住）。
 */
export const AMBIENT_BIAS_FULL_SCALE = Object.freeze({
  headYaw: 0.02,
  headPitch: 0.02,
  breath: 0.04 * Math.PI,
  gazeX: 0.01,
  gazeY: 0.01,
  posture: 0.06,   // |0.02·lean| + 0.04·sin 的最坏情况
});

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clean = (v) => (v === 0 ? 0 : v); // 把 -0 归一成 0，便于 === 断言

/**
 * bias（FACS 偏移单位）→ 归一化 [-1,1]。
 * 缺失字段按 0；不做「全 0 就返回 null」，下游用 0 判断即可。
 * @param {{headYaw?:number,headPitch?:number,breath?:number,gazeX?:number,gazeY?:number,posture?:number}} bias
 * @returns {{headYaw:number,headPitch:number,breath:number,gazeX:number,gazeY:number,posture:number}}
 */
export function normalizeAmbientBias(bias) {
  const src = bias && typeof bias === 'object' ? bias : {};
  const out = {};
  for (const [key, ref] of Object.entries(AMBIENT_BIAS_FULL_SCALE)) {
    out[key] = clean(clamp(num(src[key], 0) / ref, -1, 1));
  }
  return out;
}

/**
 * 归一化偏置 → 9 个目标通道的增量（未加 base、未钳位）。
 * 用途：① applyAmbientOffsets 内部；② performanceDebug 报「这一帧到底加了多少」。
 *
 * 通道映射（没有专用源的通道写 0，输出仍保留键，契约稳定）：
 *   headX ← headYaw      headY ← headPitch     headZ ← posture（roll）
 *   gazeX/gazeY ← gazeX/gazeY
 *   breath ← breath
 *   bodyZ ← posture      posX ← posture        posZ ← （暂无源，恒 0）
 * @param {object} amb 归一化偏置
 * @param {{speaking?:boolean, coeffs?:object}} [opts]
 */
export function ambientOffsets(amb, opts = {}) {
  const cfg = Object.assign({}, AMBIENT_APPLY_DEFAULTS, (opts && opts.coeffs) || {});
  const speaking = opts && opts.speaking === true;
  const headScale = speaking ? num(cfg.speakingHeadScale, 0.5) : 1;
  const gazeScale = speaking ? num(cfg.speakingGazeScale, 0.5) : 1;
  const a = amb && typeof amb === 'object' ? amb : {};
  const yaw = clamp(num(a.headYaw, 0), -1, 1);
  const pitch = clamp(num(a.headPitch, 0), -1, 1);
  const breath = clamp(num(a.breath, 0), -1, 1);
  const gazeX = clamp(num(a.gazeX, 0), -1, 1);
  const gazeY = clamp(num(a.gazeY, 0), -1, 1);
  const posture = clamp(num(a.posture, 0), -1, 1);
  return {
    breath: clean(breath * num(cfg.breath, 0)),
    bodyZ: clean(posture * num(cfg.bodyZDeg, 0)),
    headX: clean(yaw * num(cfg.headYawDeg, 0) * headScale),
    headY: clean(pitch * num(cfg.headPitchDeg, 0) * headScale),
    headZ: clean(posture * num(cfg.headRollDeg, 0) * headScale),
    gazeX: clean(gazeX * num(cfg.gaze, 0) * gazeScale),
    gazeY: clean(gazeY * num(cfg.gaze, 0) * gazeScale),
    posX: clean(posture * num(cfg.pos, 0)),
    posZ: 0,
  };
}

/**
 * 加法 + 钳位；delta 为 0（或 base 不是有限数）时**原样返回 base**。
 * 为什么不在 delta=0 时也钳：零偏置的契约是「逐值 === base」，
 * 对已经贴边的 base 先钳再返回会破坏这个断言（也会掩盖上游的越界）。
 */
function applyOne(base, delta, lo, hi) {
  const b = Number(base);
  if (!Number.isFinite(b) || !delta) return base;
  return clamp(b + delta, lo, hi);
}

/**
 * 把归一化偏置并进「所有者本帧的原值」。
 *
 * 契约：
 *   · amb 为空 / 全 0 → 返回值逐值 `===` 入参 base（不是「差不多」）；
 *   · 钳位：ParamAngle* [-30,30]、ParamBreath [0,1]、ParamBodyAngleZ [-10,10]、
 *     ParamEyeBallX/Y [-1,1]；Position 不钳（模型空间无统一硬边界）；
 *   · speaking=true 只把 head/gaze 系数减半，breath/bodyZ/pos 不变。
 *
 * @param {{breath?:number,bodyZ?:number,headX?:number,headY?:number,headZ?:number,gazeX?:number,gazeY?:number,posX?:number,posZ?:number}} base
 * @param {object|null} amb 归一化偏置
 * @param {{speaking?:boolean, coeffs?:object}} [opts]
 * @returns {{breath:number,bodyZ:number,headX:number,headY:number,headZ:number,gazeX:number,gazeY:number,posX:number,posZ:number}}
 */
export function applyAmbientOffsets(base, amb, opts = {}) {
  const b = base && typeof base === 'object' ? base : {};
  const d = ambientOffsets(amb, opts);
  const angle = num(AMBIENT_CLAMP.angle, 30);
  const [breathMin, breathMax] = AMBIENT_CLAMP.breath;
  const bodyZ = num(AMBIENT_CLAMP.bodyZ, 10);
  const gaze = num(AMBIENT_CLAMP.gaze, 1);
  return {
    breath: applyOne(b.breath, d.breath, breathMin, breathMax),
    bodyZ: applyOne(b.bodyZ, d.bodyZ, -bodyZ, bodyZ),
    headX: applyOne(b.headX, d.headX, -angle, angle),
    headY: applyOne(b.headY, d.headY, -angle, angle),
    headZ: applyOne(b.headZ, d.headZ, -angle, angle),
    gazeX: applyOne(b.gazeX, d.gazeX, -gaze, gaze),
    gazeY: applyOne(b.gazeY, d.gazeY, -gaze, gaze),
    posX: applyOne(b.posX, d.posX, -Infinity, Infinity),
    posZ: applyOne(b.posZ, d.posZ, -Infinity, Infinity),
  };
}
