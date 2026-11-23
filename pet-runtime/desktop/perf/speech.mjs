// 语音表演层（speech performance）：说话时的眉眼小动作。
//
// 借鉴 soullink 的 SpeechPerformancePlanner，核心约束是**不抢嘴**：
//   嘴由口型层独占（ParamMouthOpenY），这一层只动眉毛/眼睛/嘴角形态，
//   所以「一边说话一边表情有重点」是能叠加的，不会和口型打架。
//
// 规则很朴素，但比没有强很多：真人说话时重音会挑眉、疑问会歪头/睁眼、
// 迟疑会收一点嘴角。这些细节是「她在说话」而不是「一个喇叭在放音」的分界线。

import { clamp, ease } from './util.mjs';

const ACCENT_RULES = [
  { test: (t) => /！！|!!/.test(t), name: 'strong-exclaim', gain: 1, build: () => ({ browOuterUp: 0.22, eyeOpen: 1.06, mouthSmile: 0.08 }), duration: [420, 620] },
  { test: (t) => /[！!]/.test(t), name: 'exclaim', gain: 0.8, build: () => ({ browOuterUp: 0.14, eyeOpen: 1.03 }), duration: [300, 420] },
  { test: (t) => /[？?]/.test(t), name: 'question', gain: 0.75, build: () => ({ browInnerUp: 0.16, browUpL: 0.1, eyeOpen: 1.04 }), duration: [420, 560] },
  { test: (t) => /…|——|\.\.\./.test(t), name: 'hesitate', gain: 0.7, build: () => ({ browInnerUp: 0.12, mouthFrown: 0.06 }), duration: [520, 760] },
  { test: (t) => /[~～]/.test(t), name: 'playful', gain: 0.7, build: () => ({ mouthSmile: 0.12, eyeSmile: 0.1 }), duration: [380, 520] },
  { test: (t) => /[，,、；;]/.test(t), name: 'comma', gain: 0.45, build: () => ({ browInnerUp: 0.06 }), duration: [260, 360] },
];

// 长句：没有标点也让她每 2 秒左右「换口气」，否则整段话是一张定格脸。
const LONG_SENTENCE_ACCENT = () => ({ browInnerUp: 0.07, eyeSmile: 0.04 });

export function createSpeechAccents(options = {}) {
  const queue = [];
  let clock = 0;
  let nextBreathAt = 0;
  let lastText = '';

  function segment(text, durationMs) {
    const raw = String(text || '').trim();
    lastText = raw;
    // 每次新句子清掉上一句的残留，避免一句一个感叹号在整段里「常亮」。
    queue.length = 0;
    if (!raw) { nextBreathAt = 0; return []; }

    const duration = clamp(Number(durationMs) || 1400, 300, 20000);
    const fired = [];

    for (const rule of ACCENT_RULES) {
      if (!rule.test(raw)) continue;
      const [minDur, maxDur] = rule.duration;
      queue.push({
        name: rule.name,
        at: 0.02 + duration / 1000 * 0.12,       // 句首偏一点点，别和字的第一帧撞上
        duration: (minDur + maxDur) / 2000,
        facs: rule.build(),
        gain: rule.gain,
      });
      fired.push(rule.name);
      break;                                      // 一句只取最重要的那一种标点情绪
    }

    // 长句：按 2.2 秒一格排「换气」动作
    const seconds = duration / 1000;
    if (seconds > 2.4 && raw.length >= 10) {
      const count = Math.min(6, Math.floor(seconds / 2.2));
      for (let i = 1; i <= count; i++) {
        queue.push({
          name: 'breath',
          at: i * 2.2 + 0.15,
          duration: 0.5,
          facs: LONG_SENTENCE_ACCENT(),
          gain: 0.4,
        });
      }
    }

    nextBreathAt = 0;
    return fired;
  }

  function update(dt) {
    const step = clamp(Number(dt) || 0, 0, 0.25);
    clock += step;
    nextBreathAt = clock + 1;

    let out = null;
    for (let i = queue.length - 1; i >= 0; i--) {
      const item = queue[i];
      const local = clock - item.at;
      if (local < 0) continue;
      if (local > item.duration) { queue.splice(i, 1); continue; }
      const k = local / item.duration;
      // 起势 20% 快、保持、收势慢：用了 sin 包络，简单且不会突跳。
      const env = Math.sin(Math.PI * Math.pow(clamp(k, 0, 1), 0.72));
      if (!out) out = {};
      for (const [key, value] of Object.entries(item.facs)) {
        const delta = key === 'eyeOpen' ? (value - 1) : value;
        const amount = delta * env * item.gain;
        if (key === 'eyeOpen') out[key] = (out[key] ?? 1) + amount;
        else out[key] = (out[key] ?? 0) + amount;
      }
    }
    return out;
  }

  function reset() {
    queue.length = 0;
    clock = 0;
    lastText = '';
  }

  return {
    segment,
    update,
    reset,
    get pending() { return queue.length; },
    get lastText() { return lastText; },
  };
}
