// perf 引擎总装：VAD → FACS → 混合 → 模型画像 → 参数。
//
// 它和 emotion-engine 的分工（重要，别混）：
//   emotion-engine = 情绪仲裁：读文本/事件，决定「现在该是什么情绪、多强、
//                    要不要配个动作/气泡」。这部分规则是过去几轮手调出来的，保留。
//   perf          = 情绪表征：把「情绪 + 强度」变成连续的 VAD 状态、一张连续的
//                    FACS 脸、再按模型画像落到参数上，带惯性/余韵/微表情/语音重点。
// 一句话：谁来决定演什么 → 老引擎；怎么演得像人 → 这个引擎。
//
// 这样切的好处：老的 L1-L4/冷却/TTL/演出编排一行不动，出问题随时能退回
// legacy 的表驱动路径（PERF_MODE='legacy'），不存在「换了引擎全乱」。

import { VadController, vadMagnitude } from './vad.mjs';
import { NEUTRAL_FACS, clampFACS, createFACS, lerpFACS, scaleFACS } from './facs.mjs';
import { applyStyle, vadToFACS } from './expression.mjs';
import { resolveArchetypeStyle, normalizeEmotion } from './archetypes.mjs';
import { mixLayers } from './mixer.mjs';
import { applyFACS, buildProfile, describeCoverage } from './profile.mjs';
import { createSpeechAccents } from './speech.mjs';
import { clamp, smoothingFactor } from './util.mjs';

// 每个通道的低通时间常数（秒）：眉毛跟得快，嘴角跟得慢，脸红最慢。
// 这条「不同部位不同惯性」是表情不显机械的关键——整张脸同速变化会像贴图切换。
const TAU_BY_CHANNEL = {
  browInnerUp: 0.14, browOuterUp: 0.14, browDown: 0.14, browUpL: 0.16, browUpR: 0.16,
  eyeOpen: 0.12, eyeSmile: 0.18, eyeSquint: 0.16,
  mouthSmile: 0.30, mouthFrown: 0.30, mouthPucker: 0.34,
  blush: 0.55, tear: 0.6, sweat: 0.5,
  headX: 0.16, headY: 0.16, headZ: 0.16,
  bodyX: 0.22, bodyY: 0.22, bodyZ: 0.22,
  breath: 0.3, gazeX: 0.1, gazeY: 0.1, eyeBlinkL: 0.05, eyeBlinkR: 0.05,
};

/**
 * 情绪增益（2026-11-21 P2）：把一张 FACS 脸的「离中性距离」乘 gain。
 *
 * 为什么不能继续用 scaleFACS(face, gate*gain)：scaleFACS 内部的 lerpFACS 会把权重
 * clamp 到 0..1，gate=1 时 gain=1.5 被压回 1 —— 控制面板的「情绪增益」对 perf
 * 路径完全无效（只对 legacy 的 applyEmotionTargets 有效）。这里在缩放之后再乘
 * 一次幅度，gain>1 才能真的「夸张」，gain<1 才能真的「收敛」。
 */
function amplifyFACS(state, gain) {
  if (!Number.isFinite(gain) || Math.abs(gain - 1) < 1e-6) return state;
  const out = {};
  for (const key of Object.keys(NEUTRAL_FACS)) {
    const neutral = NEUTRAL_FACS[key];
    const value = Number(state[key]);
    out[key] = Number.isFinite(value) ? neutral + (value - neutral) * gain : neutral;
  }
  return out;
}

export function createPerfEngine(options = {}) {
  const spec = options.spec || null;
  const profile = options.profile || (spec ? buildProfile(spec, options.runtime || {}) : null);
  if (!profile) throw new Error('perf: 需要 profile 或 spec');

  const baseline = Object.assign({}, options.baseline || {});
  const vad = new VadController(Object.assign({ seed: options.seed ?? 20261112 }, options.personality || {}));
  const speech = createSpeechAccents();
  const smooth = new Map();
  const tuning = {
    styleGain: options.styleGain ?? 1,
    emotionGain: options.emotionGain ?? 1,
    microMotion: options.microMotion ?? true,
    speechAccents: options.speechAccents ?? true,
    ...(options.tuning || {}),
  };

  let gate = 1;             // 老引擎的包络权重（起势/收势）——它说收就收
  let manual = null;        // 手动层（VTS 注入/预设预览）
  let reactionLayer = null; // 一次性面部表演层（FACS 片段；默认空，见 setReaction）
  // 待机层偏置（2026-11-25 P1，ADR-015 §3.4 / 审计 §3.2）：
  //   {amp, bias:{headYaw,headPitch,breath,gazeX,gazeY,posture}} 由 perf/ambient.mjs 产出。
  //   P1.5 起这里**只**用 amp 收敛本层自己的微抽/漂移：bias 的头/身/眼/呼吸在本画像里
  //   归外部层（profile.mjs 的 EXTERNALLY_OWNED），写进 FACS 也会被画像丢弃。
  //   真正的可见偏置走渲染器 setAmbientOffset → PROC_MOTION 单写（perf/ambient-apply.mjs）。
  let ambientBias = null;
  let intentEmotion = 'neutral';
  let intentVariant = null;
  let intentStrength = 0;
  // 两个时间戳必须分开（2026-11-21 P2）：
  //   lastFeedAt   = 宿主最近一次调用 feed（**每帧**都会刷新，只用于诊断）；
  //   lastIntentAt = 最近一次「新指令」（情绪/variant 变了，或强度有实质变化）。
  // 原来微表情用 lastFeedAt 判「安静 2.4 秒」，而宿主生产环境每帧都 feed →
  // clock - lastFeedAt 恒为 0，微表情是死代码。
  let lastFeedAt = -1e9;
  let lastIntentAt = -1e9;
  let speakingFlag = false; // 宿主 TTS 播放状态（setSpeaking / feed.speaking 注入）
  let clock = 0;
  let microUntil = 0;
  let microApply = null;
  let microSeed = (options.seed ?? 20261112) >>> 0;
  let lastOutput = null;

  function feed(intent = {}) {
    const emotion = normalizeEmotion(intent.emotion);
    const strength = clamp(Number(intent.strength ?? 1), 0, 1);
    const variant = intent.variant || null;
    const prevStrength = intentStrength;
    // ⚠ 必须先把 variant 归一成 null 再比：宿主不传 variant 时是 undefined，
    //   而 intentVariant 初始为 null —— 旧写法 `undefined !== null` 恒 true，
    //   于是「changed 每帧都为真」，依赖它的节流/微表情全部失效。
    const changed = emotion !== intentEmotion || variant !== intentVariant;
    intentEmotion = emotion;
    intentVariant = variant;
    intentStrength = strength;
    lastFeedAt = clock;
    // 「新指令」判据：情绪/变体变了，或强度变化 ≥0.15（包络逐帧噪声不会触发）。
    if (changed || Math.abs(strength - prevStrength) >= 0.15) lastIntentAt = clock;
    if (Number.isFinite(intent.speaking)) speakingFlag = intent.speaking === true;
    if (emotion !== 'neutral' && (changed || strength > 0.05)) {
      vad.nudge(emotion, strength, { holdSeconds: intent.holdSeconds });
    }
    if (Number.isFinite(intent.gate)) gate = clamp(intent.gate, 0, 1);
    return vad.state();
  }

  function setGate(value) {
    gate = clamp(Number(value) || 0, 0, 1);
  }

  /**
   * 宿主 TTS 播放状态（2026-11-21 P1）。
   * 老问题：speak() 是 speech.segment() 的唯一入口，但全仓没人调用 →
   * snapshot().speaking 恒 false，「说完才演」退化成只看包络，FACS 片段
   * 在说话期间也不屏蔽嘴（SpeechActive 永远 false）。
   */
  function setSpeaking(value) {
    speakingFlag = value === true;
    return speakingFlag;
  }

  function isSpeaking() {
    return speakingFlag || speech.pending > 0;
  }

  function speak(text, durationMs) {
    if (!tuning.speechAccents) return [];
    return speech.segment(text, durationMs);
  }

  function setManual(face) {
    manual = face ? Object.assign({}, face) : null;
  }

  /**
   * 待机层偏置（ambient）。传 null 关闭。
   * P1.5：本层只消费 amp（收敛微抽）；bias 的落地在渲染器的 PROC_MOTION 单写。
   * @param {{amp?:number,bias?:object}|null} next
   */
  function setAmbientBias(next) {
    if (!next || typeof next !== 'object') { ambientBias = null; return null; }
    const amp = clamp(Number(next.amp) || 0, 0, 1);
    const b = next.bias && typeof next.bias === 'object' ? next.bias : {};
    ambientBias = {
      amp,
      bias: {
        headYaw: Number(b.headYaw) || 0,
        headPitch: Number(b.headPitch) || 0,
        breath: Number(b.breath) || 0,
        gazeX: Number(b.gazeX) || 0,
        gazeY: Number(b.gazeY) || 0,
        posture: Number(b.posture) || 0,
      },
    };
    return ambientBias;
  }

  /**
   * 把 ambient 的「安静收敛」并进 idle 层。
   *
   * ⚠ 2026-11-25 P1.5 契约变更（ADR-015 §3.4 / 审计 §3.2）：
   *   这里原来还把 bias 的 headYaw→headX、headPitch→headY、breath、gazeX/gazeY、
   *   posture→bodyZ 写进 idle 层。但这 6 个通道在 profile.mjs 的 EXTERNALLY_OWNED 里
   *   **全部**是外部所有（interaction-motion / GazeFollow / body-director），
   *   buildProfile 建画像时整通道丢弃 —— 写了也到不了参数，是「假接线」。
   *   现在 ambient 偏置的唯一落地路径是渲染器 setAmbientOffset → PROC_MOTION 单写
   *   （perf/ambient-apply.mjs）；这里只保留它唯一真正有权做的事：
   *   按 amp 把本层自己的微抽/漂移（browInnerUp / mouthSmile / eyeSmile …，均非外部通道）
   *   收敛一点，避免和待机层的「安静」叠成两份抖动。
   * @param {object|null} idleLayer
   */
  function applyAmbientToIdle(idleLayer) {
    if (!ambientBias) return idleLayer;
    const amp = clamp(ambientBias.amp, 0, 1);
    const keep = clamp(1 - amp, 0.7, 1);
    if (!idleLayer) return idleLayer;
    const out = {};
    for (const key of Object.keys(idleLayer)) {
      const raw = Number(idleLayer[key]);
      if (!Number.isFinite(raw)) continue;
      const neutral = NEUTRAL_FACS[key] ?? 0;
      out[key] = key === 'eyeOpen' ? 1 + (raw - 1) * keep : neutral + (raw - neutral) * keep;
    }
    return out;
  }

  // 微表情：情绪淡下去时让眉毛/嘴角自己抖一下，避免「石化」。
  // （老引擎里也有一份，但 perf 接管参数后那份到不了渲染层，所以这里重做。）
  function microTwitch() {
    if (!tuning.microMotion) return null;
    if (clock < microUntil) return null;
    // 只认「新指令」，不认每帧 feed（否则宿主一开播就永远是 0）
    if (clock - lastIntentAt < 2.4) { microApply = null; return null; }
    microSeed = (Math.imul(microSeed, 1103515245) + 12345) >>> 0;
    const r = (microSeed % 1000) / 1000;
    microUntil = clock + 0.7 + r * 0.6;
    microApply = [
      { browUpR: 0.06, browInnerUp: 0.04 },
      { mouthSmile: 0.05, eyeSmile: 0.05 },
      { browUpL: 0.05, eyeOpen: 1.02 },
      { browUpL: 0.06, mouthFrown: 0.03 },
    ][Math.floor(r * 4)];
    return microApply;
  }

  function update(dt) {
    const step = clamp(Number(dt) || 0, 0, 0.25);
    clock += step;

    const vadState = vad.update(step);
    const intensity = vadMagnitude(vadState.current);
    const dominant = vadState.dominant;

    // 1) 情绪层：VAD 给底，原型给签名
    const style = dominant && dominant !== 'neutral'
      ? resolveArchetypeStyle(dominant, intentVariant)
      : null;
    let emotionFace = vadToFACS(vadState.current);
    if (style) {
      // 风格占主导、VAD 调幅度：表情能不能「被读出来」主要靠签名层，连续性靠 VAD。
      const amount = clamp((0.18 + intensity * 0.90) * clamp(tuning.styleGain, 0, 2.4), 0, 0.85);
      emotionFace = applyStyle(emotionFace, style, amount);
    }
    // 老引擎的包络是「她说完了」的权威信号；VAD 的幅度已经体现在脸本身，
    // 这里只做「整体熄灯」（gate=0 时整张脸回到中性），不再二次缩小，
    // 否则弱情绪会被连乘两次削到看不见（这是第一版实测踩到的坑）。
    //
    // 情绪增益（2026-11-21 P2）拆成两段，别把 gain 再塞回 clamp(0,1)：
    //   gateW = 包络，只负责熄灯（语义与旧版一致）；
    //   gainW = 控制面板「情绪增益」，>1 时把「离中性的距离」放大（1.5 = 夸张）。
    // gainW=1 时 amplifyFACS 原样返回 → 与旧实现逐值等价。
    const gainW = clamp(tuning.emotionGain, 0, 2);
    const gateW = clamp(gate, 0, 1);
    const weight = clamp(intensity * gateW * gainW, 0, 1);
    const emotionLayer = amplifyFACS(scaleFACS(emotionFace, gateW), gainW);

    // 2) 语音表演层
    const speechLayer = tuning.speechAccents ? speech.update(step) : null;

    // 3) 微表情（只在不演戏的时候出现）
    let idleLayer = null;
    if (weight < 0.35) {
      const twitch = microTwitch();
      if (twitch) idleLayer = twitch;
      // 极小的底色漂移，避免参数被钉死
      const drift = Math.sin(clock * 1.7) * 0.012;
      idleLayer = Object.assign({}, idleLayer, { browInnerUp: (idleLayer?.browInnerUp || 0) + Math.max(0, drift) });
      // 待机层偏置（P1）：没有 ambient 时原样返回，旧行为逐值不变
      idleLayer = applyAmbientToIdle(idleLayer);
    }

    // 4) 混合 + 平滑
    //    reaction 层：一次性面部表演（LumenAct FACS 片段）。默认 null，
    //    不调 setReaction 时行为与以前**完全一致**（回归门禁会盯着这一点）。
    const mixed = mixLayers({ idle: idleLayer, emotion: emotionLayer, speech: speechLayer, reaction: reactionLayer, manual });
    const smoothed = createFACS();
    for (const key of Object.keys(NEUTRAL_FACS)) {
      const target = Number.isFinite(mixed[key]) ? mixed[key] : NEUTRAL_FACS[key];
      const current = smooth.has(key) ? smooth.get(key) : target;
      const tau = TAU_BY_CHANNEL[key] ?? 0.2;
      const next = Math.abs(target - current) < 1e-4 ? target : current + (target - current) * smoothingFactor(tau, step);
      smooth.set(key, next);
      smoothed[key] = next;
    }

    // 5) 落到模型
    const applied = applyFACS(clampFACS(smoothed), profile, baseline);

    lastOutput = {
      params: applied.params,
      expressions: applied.expressions,
      facs: smoothed,
      vad: vadState,
      emotion: dominant,
      intensity,
      weight,
      style,
      speaking: isSpeaking(),
      micro: microApply,
      clock,
    };
    return lastOutput;
  }

  function snapshot() {
    const out = lastOutput || { params: {}, expressions: [], facs: {}, emotion: 'neutral', intensity: 0, weight: 0 };
    return {
      emotion: out.emotion,
      intensity: +Number(out.intensity || 0).toFixed(3),
      weight: +Number(out.weight || 0).toFixed(3),
      vad: out.vad ? {
        valence: +out.vad.current.valence.toFixed(3),
        arousal: +out.vad.current.arousal.toFixed(3),
        dominance: +out.vad.current.dominance.toFixed(3),
      } : null,
      hold: out.vad ? +out.vad.holdSeconds.toFixed(2) : 0,
      facs: out.facs,
      params: out.params,
      expressions: out.expressions,
      speaking: out.speaking === true,
      micro: out.micro || null,
      mode: 'perf',
    };
  }

  function report() {
    return describeCoverage(profile);
  }

  function reset() {
    vad.reset();
    speech.reset();
    smooth.clear();
    gate = 1;
    manual = null;
    reactionLayer = null;
    ambientBias = null;
    intentEmotion = 'neutral';
    intentStrength = 0;
    speakingFlag = false;
    lastFeedAt = -1e9;
    lastIntentAt = -1e9;
    microUntil = 0;
    microApply = null;
    clock = 0;
    lastOutput = null;
  }

  return {
    feed,
    setGate,
    setSpeaking,
    speak,
    setManual,
    /**
     * 设置/清除一次性面部表演层（reaction）。
     * 传 null 清除。层里的键必须是 FACS 语义通道（facs.mjs 的 FACS_KEYS）。
     * 为什么单独一个入口而不是并进 feed：feed 是「情绪」的入口，
     * reaction 是「演一段」的入口，两者的生命周期不同（一个持续，一个一次性）。
     */
    setReaction(layer) { reactionLayer = layer || null; },
    /** 待机层偏置（P1）：由 ambient.mjs 每帧产出；只并进 idle 层，不新增 FACS 通道 */
    setAmbientBias,
    get ambient() { return ambientBias; },
    update,
    snapshot,
    report,
    reset,
    setStyleGain: (v) => { tuning.styleGain = clamp(Number(v) || 0, 0, 2.4); },
    // 返回实际生效值，便于宿主的计数器/面板断言「设置确实进了引擎」（P2）。
    setEmotionGain: (v) => { tuning.emotionGain = clamp(Number(v) || 0, 0, 2); return tuning.emotionGain; },
    get emotionGain() { return tuning.emotionGain; },
    get personality() { return vad.personality; },
    get profile() { return profile; },
  };
}

export { buildProfile, describeCoverage, applyFACS, PROFILE_SPECS, EXTERNALLY_OWNED, EXTERNALLY_OWNED_PARAMS, PERF_SHARED_OWNED_PARAMS } from './profile.mjs';
export { listEmotions, normalizeEmotion, EMOTION_ARCHETYPES } from './archetypes.mjs';
export { VAD_PRESETS, VadController } from './vad.mjs';
export { FACS_KEYS, NEUTRAL_FACS, createFACS, clampFACS, lerpFACS, scaleFACS, facsMagnitude } from './facs.mjs';
export { mixLayers } from './mixer.mjs';
