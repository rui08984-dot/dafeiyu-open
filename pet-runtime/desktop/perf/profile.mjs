// 模型画像：FACS 语义通道 → 这个模型的具体参数 / 表情文件。
//
// 这一层的价值（soullink 的 ModelProfile + CapabilityDetector 的简化版）：
//   · 换模型只需要写一份画像，表情引擎一行不改；
//   · 模型缺某个参数时自动降级（没有单边眉就不做单边，没有颊红参数就走 exp3），
//     而不是像以前那样「写了 ParamBrowRY 但这个模型没有 → 静默什么都没发生」；
//   · 所有权是显式的：嘴开合归口型、眼球归 GazeFollow、头身归 interaction/body——
//     画像里写清楚，避免两层同时写一个参数互相打架（这是老 bug 的来源）。
//
// jellyfish 的实测事实（pet.cdi3.json，509 个参数）：
//   有 BrowInnerUp、ParamBrowLY/RY、ParamBrowLAngle/RAngle、ParamBrowLY2/RY2、
//   EyeSmile、ParamEyeLOpen/ROpen、LEyeSquint/REyeSquint、ParamMouthForm、
//   Mouthpucker、CheeckPuff；脸红/泪/汗走模型自带的 key1..13 连续参数
//   （key7=脸红、key2=流泪、key13=流冷汗，范围 0..1）——**不是** exp3 单槽。
//   2026-11-12 更正：这里的旧注释说「没有独立参数」，实际是 jingyu/core-inventory.json
//   第 509 条里明确有 key1..key13；用 exp3 单槽会导致「脸红和流泪不能同时亮」。

import { clamp } from './util.mjs';

export const PROFILE_SPECS = {
  jellyfish: {
    modelId: 'jellyfish',
    displayName: '大肥鱼（jellyfish）',
    channels: {
      browInnerUp: [{ param: 'BrowInnerUp', scale: 1 }],
      browOuterUp: [{ param: 'ParamBrowRY', scale: 1 }, { param: 'ParamBrowLY', scale: 1 }],
      // 这个模型只有一对「眉高低」+ 一对「眉角度」。压低眉毛必须主要走角度：
      // 高低轴同时被「外眉上扬」占用，两路相减会互相抵消（2026-11-12 实测 -0.13 变 -0.01）。
      browDown: [
        { param: 'ParamBrowRY', scale: -0.25 },
        { param: 'ParamBrowLY', scale: -0.25 },
        { param: 'ParamBrowRAngle', scale: 0.9 },
        { param: 'ParamBrowLAngle', scale: 0.9 },
      ],
      browUpL: [{ param: 'ParamBrowLY', scale: 1 }],
      browUpR: [{ param: 'ParamBrowRY', scale: 1 }],
      eyeOpen: [
        { param: 'ParamEyeLOpen', scale: 1, absolute: true },
        { param: 'ParamEyeROpen', scale: 1, absolute: true },
      ],
      eyeSmile: [{ param: 'EyeSmile', scale: 1 }],
      eyeSquint: [
        { param: 'ParamEyeLOpen', scale: -0.3 },
        { param: 'ParamEyeROpen', scale: -0.3 },
      ],
      mouthSmile: [{ param: 'ParamMouthForm', scale: 1 }],
      mouthFrown: [{ param: 'ParamMouthForm', scale: -1 }],
      mouthPucker: [{ param: 'Mouthpucker', scale: 0.85 }],
      // 连续权重（0..1）：可以同时淡入淡出，不再抢 exp3 的单一表情槽
      // 不对称通道（P0-4）：模型自带左右分开的嘴角/眯眼 + 鼓腮
      mouthSmileL: [{ param: 'MouthSmile_L', scale: 1 }],
      mouthSmileR: [{ param: 'MouthSmile_R', scale: 1 }],
      eyeSquintL: [{ param: 'LEyeSquint', scale: 1 }],
      eyeSquintR: [{ param: 'REyeSquint', scale: 1 }],
      cheekPuff: [{ param: 'CheeckPuff', scale: 1 }],
      blush: [{ param: 'key7', scale: 1 }],
      tear: [{ param: 'key2', scale: 1 }],
      sweat: [{ param: 'key13', scale: 1 }],
    },
  },
};

// 这些通道由别的层拥有，画像层永远不碰。写在这里是为了「一眼能看出谁在写什么」。
export const EXTERNALLY_OWNED = Object.freeze({
  mouthOpen: 'TTS 口型层（ParamMouthOpenY）',
  gazeX: 'GazeFollow（ParamEyeBallX）',
  gazeY: 'GazeFollow（ParamEyeBallY）',
  headX: 'interaction-motion（ParamAngleX）',
  headY: 'interaction-motion（ParamAngleY）',
  headZ: 'interaction-motion（ParamAngleZ）',
  bodyX: 'body-director（ParamBodyAngleX/HipAngleX）',
  bodyY: 'body-director（ParamBodyAngleY/PositionY）',
  bodyZ: 'body-director（ParamBodyAngleZ）',
  breath: 'body-director（ParamBreath）',
  eyeBlinkL: 'CubismEyeBlink',
  eyeBlinkR: 'CubismEyeBlink',
});

/**
 * 同一份所有权的**运行期词汇**（参数 id → 归谁）。2026-11-18 §69 B3 补。
 *
 * 为什么需要第二张表：EXTERNALLY_OWNED 的键是 FACS **通道名**（mouthOpen/gazeX），
 * 它是给建画像用的（「这个通道我不碰」）。可运行期真正被写的是**参数 id**
 * （ParamMouthOpenY/ParamEyeBallX），而画像里根本不存在这些通道 ——
 * 于是「本层有没有抢别人的参数」这件事在运行期无法用通道表断言，表就成了摆设。
 *
 * ⚠ 刻意**不含** ParamEyeLOpen / ParamEyeROpen：`eyeOpen` 通道是故意共享的
 *   （表情决定眼睛形状，眨眼在这之上再乘一次）。把它列进来只会制造狼来了。
 *
 * ⚠ key1..key13 / Clothes1..5 / Movement1..3 是**资产层**的手动开关，不在这张
 *   「永远禁止」表里（perf 在未手动打开时仍可写 key2/7/13 表达情绪脸红/泪/汗）。
 *   它们的运行期所有权见 perf/param-ownership.mjs：手动打开（pin）后 perf 写前跳过。
 */
export const EXTERNALLY_OWNED_PARAMS = Object.freeze({
  ParamMouthOpenY: 'TTS 口型层',
  ParamEyeBallX: 'GazeFollow',
  ParamEyeBallY: 'GazeFollow',
  ParamAngleX: 'interaction-motion（头）',
  ParamAngleY: 'interaction-motion（头）',
  ParamAngleZ: 'interaction-motion（头）',
  ParamBodyAngleX: 'body-director（身）',
  ParamBodyAngleY: 'body-director（身）',
  ParamBodyAngleZ: 'body-director（身）',
  HipAngleX: 'body-director（髋）',
  HipAngleY: 'body-director（髋）',
  HipAngleZ: 'body-director（髋）',
  PositionX: 'body-director（位移）',
  PositionY: 'body-director（位移）',
  PositionZ: 'body-director（位移）',
  ParamBreath: 'body-director（呼吸）',
});

/**
 * 按运行时真实存在的参数裁剪画像。缺的通道直接摘掉，返回降级报告。
 * @param {object} spec PROFILE_SPECS 里的画像
 * @param {{ paramIds: Set<string>|string[], expressions?: Set<string>|string[], ranges?: Map<string,[number,number]> }} runtime
 */
export function buildProfile(spec, runtime) {
  const paramIds = runtime.paramIds instanceof Set ? runtime.paramIds : new Set(runtime.paramIds || []);
  const expressionIds = runtime.expressions instanceof Set ? runtime.expressions : new Set(runtime.expressions || []);
  const ranges = runtime.ranges instanceof Map ? runtime.ranges : new Map();

  const channels = {};
  const degraded = [];
  const dropped = [];
  const usedParams = new Set();
  const usedExpressions = new Set();

  for (const [channel, outputs] of Object.entries(spec.channels)) {
    if (EXTERNALLY_OWNED[channel]) { dropped.push({ channel, reason: '外部所有权：' + EXTERNALLY_OWNED[channel] }); continue; }
    const kept = [];
    for (const output of outputs) {
      if (output.param) {
        if (!paramIds.has(output.param)) { degraded.push({ channel, missing: output.param, kind: 'param' }); continue; }
        usedParams.add(output.param);
        kept.push({ kind: 'param', id: output.param, scale: output.scale ?? 1, absolute: !!output.absolute, range: ranges.get(output.param) || null });
      } else if (output.expression) {
        if (!expressionIds.has(output.expression)) { degraded.push({ channel, missing: output.expression, kind: 'expression' }); continue; }
        usedExpressions.add(output.expression);
        kept.push({ kind: 'expression', name: output.expression, gain: output.gain ?? 1, threshold: output.threshold ?? 0.15 });
      }
    }
    if (kept.length) channels[channel] = kept;
  }

  const capabilities = {};
  for (const channel of Object.keys(spec.channels)) capabilities[channel] = Boolean(channels[channel]);

  return {
    modelId: spec.modelId,
    displayName: spec.displayName,
    channels,
    capabilities,
    usedParams: [...usedParams],
    usedExpressions: [...usedExpressions],
    degraded,
    dropped,
    version: 1,
  };
}

/**
 * FACS → 具体参数值 + 表情权重。
 * @param {object} facs
 * @param {object} profile buildProfile 的返回值
 * @param {Record<string, number>} baseline 每个参数的「中性基线」（模型默认值或初始化时抓的姿态）
 * @returns {{ params: Record<string, number>, expressions: Array<{name:string, weight:number}> }}
 */
export function applyFACS(facs, profile, baseline = {}) {
  const params = {};
  const expressionWeights = new Map();

  for (const [channel, outputs] of Object.entries(profile.channels)) {
    const raw = Number(facs?.[channel]);
    const value = Number.isFinite(raw) ? raw : 0;
    if (value === 0) continue;
    for (const output of outputs) {
      if (output.kind === 'expression') {
        if (value < output.threshold) continue;
        const prev = expressionWeights.get(output.name) || 0;
        expressionWeights.set(output.name, Math.max(prev, clamp(value * output.gain, 0, 1)));
        continue;
      }
      const base = Number.isFinite(baseline[output.id]) ? baseline[output.id] : (output.absolute ? 1 : 0);
      const delta = output.absolute ? (value - 1) * output.scale : value * output.scale;
      const next = (Number.isFinite(params[output.id]) ? params[output.id] : base) + delta;
      const [min, max] = output.range || (output.absolute ? [0, 1.5] : [-1, 1]);
      params[output.id] = clamp(next, Math.min(min, max), Math.max(min, max));
    }
  }

  return {
    params,
    expressions: [...expressionWeights.entries()].map(([name, weight]) => ({ name, weight })).sort((a, b) => b.weight - a.weight),
  };
}

// 诊断：一眼看出这个模型能吃下多少表情能力（给控制面板/自查用）。
export function describeCoverage(profile) {
  const total = Object.keys(profile.capabilities).length || 1;
  const covered = Object.values(profile.capabilities).filter(Boolean).length;
  return {
    modelId: profile.modelId,
    covered,
    total,
    ratio: +(covered / total).toFixed(3),
    degraded: profile.degraded,
    dropped: profile.dropped,
    usedParams: profile.usedParams,
    usedExpressions: profile.usedExpressions,
  };
}
