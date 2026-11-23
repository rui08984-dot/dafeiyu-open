// choreo-tracks.mjs —— 皮套「编舞」v1：把语义动作编译成参数轨道并逐帧播放
//
// 为什么要有（2026-11-15 六十三轮）：原版 my-neuro 的 motion-director 会生成参数级编舞，
// 但它只在自家 Live2D(pixi) 栈里落地；petbody 下被仲裁掉，只剩「贴表情 + 几个固定动作」。
// 用户想 A/B 看差别，但原版 2D 模型资产已不在（2D/ 目录为空），所以这里做一个**petbody 版**
// 的最小编舞：同一份模型、同一批参数 ID，数据驱动，可一键开关。
//
// 借的是 jingyu-live2d-agent 的思路（同一份模型）：语义动作 → 参数轨道 → 低通滑回。
// v1 只做「头/眼/身体/眉/嘴形」这些稳的参数，不碰手臂/手指（那部分要靠 arm_binding，风险高）。
//
// 轨道格式：{ name, emotion, duration, tracks: [{ param, keys: [{ t, v }] }] }
// 采样：分段 smoothstep；轨道之外不自带回正 —— 由播放器按权重淡出（避免和物理/呼吸抢）。

export const PERFORMANCES = {
  // 好奇：先看左，再歪头，往前凑
  curious: {
    name: 'curious', emotion: 'curious', duration: 3.2,
    tracks: [
      { param: 'ParamEyeBallX', keys: [{ t: 0, v: 0 }, { t: 0.5, v: -0.7 }, { t: 2.2, v: -0.7 }, { t: 3.2, v: 0 }] },
      { param: 'ParamAngleZ', keys: [{ t: 0, v: 0 }, { t: 0.9, v: 0 }, { t: 1.7, v: 7 }, { t: 2.6, v: 7 }, { t: 3.2, v: 0 }] },
      { param: 'ParamAngleY', keys: [{ t: 0, v: 0 }, { t: 1.2, v: 0 }, { t: 2.0, v: 4 }, { t: 3.2, v: 0 }] },
      { param: 'ParamBodyAngleX', keys: [{ t: 0, v: 0 }, { t: 1.4, v: 0 }, { t: 2.2, v: 5 }, { t: 3.2, v: 0 }] },
      { param: 'ParamBrowLY', keys: [{ t: 0, v: 0 }, { t: 0.6, v: 0.35 }, { t: 2.4, v: 0.35 }, { t: 3.2, v: 0 }] },
    ],
  },
  // 开心：小跳一下（身体上下 + 头点头），眉毛抬起来 + 嘴角上扬
  // ⚠ 实测本模型**没有** ParamEyeLSmile / ParamEyeRSmile / ParamCheek（509 参数里查不到），
  //   所以「眼睛弯」改用眉毛 + 嘴形表达，别再写不存在的参数（写了也是 0，白费）。
  happy: {
    name: 'happy', emotion: 'happy', duration: 2.8,
    tracks: [
      { param: 'ParamBodyAngleY', keys: [{ t: 0, v: 0 }, { t: 0.25, v: 2.5 }, { t: 0.55, v: 0 }, { t: 0.8, v: 1.4 }, { t: 1.05, v: 0 }] },
      { param: 'ParamAngleY', keys: [{ t: 0, v: 0 }, { t: 0.3, v: 3 }, { t: 0.6, v: 0 }, { t: 0.9, v: 1.6 }, { t: 1.2, v: 0 }] },
      { param: 'ParamBrowLY', keys: [{ t: 0, v: 0 }, { t: 0.4, v: 0.5 }, { t: 2.2, v: 0.5 }, { t: 2.8, v: 0 }] },
      { param: 'ParamMouthForm', keys: [{ t: 0, v: 0 }, { t: 0.5, v: 0.7 }, { t: 2.3, v: 0.7 }, { t: 2.8, v: 0 }] },
    ],
  },
  // 俏皮：先歪头，再挑一下眉，身体重心换边
  playful: {
    name: 'playful', emotion: 'playful', duration: 3.0,
    tracks: [
      { param: 'ParamAngleZ', keys: [{ t: 0, v: 0 }, { t: 0.6, v: -8 }, { t: 2.4, v: -8 }, { t: 3.0, v: 0 }] },
      { param: 'ParamEyeBallY', keys: [{ t: 0, v: 0 }, { t: 0.8, v: 0.4 }, { t: 2.2, v: 0.4 }, { t: 3.0, v: 0 }] },
      { param: 'ParamBrowLY', keys: [{ t: 0, v: 0 }, { t: 1.0, v: 0.5 }, { t: 1.6, v: 0 }, { t: 3.0, v: 0 }] },
      { param: 'ParamBodyAngleZ', keys: [{ t: 0, v: 0 }, { t: 1.2, v: -3 }, { t: 2.6, v: -3 }, { t: 3.0, v: 0 }] },
      { param: 'ParamMouthForm', keys: [{ t: 0, v: 0 }, { t: 0.9, v: 0.35 }, { t: 2.4, v: 0.35 }, { t: 3.0, v: 0 }] },
    ],
  },
  // 难过：低头、眼睛下垂、身体塌一点
  sad: {
    name: 'sad', emotion: 'sad', duration: 3.6,
    tracks: [
      { param: 'ParamAngleY', keys: [{ t: 0, v: 0 }, { t: 0.8, v: -6 }, { t: 3.0, v: -6 }, { t: 3.6, v: 0 }] },
      { param: 'ParamEyeBallY', keys: [{ t: 0, v: 0 }, { t: 0.9, v: -0.5 }, { t: 3.0, v: -0.5 }, { t: 3.6, v: 0 }] },
      { param: 'ParamBrowLAngle', keys: [{ t: 0, v: 0 }, { t: 1.0, v: 0.5 }, { t: 3.0, v: 0.5 }, { t: 3.6, v: 0 }] },
      { param: 'ParamBrowRAngle', keys: [{ t: 0, v: 0 }, { t: 1.0, v: 0.5 }, { t: 3.0, v: 0.5 }, { t: 3.6, v: 0 }] },
      { param: 'ParamBodyAngleX', keys: [{ t: 0, v: 0 }, { t: 1.2, v: -3 }, { t: 3.0, v: -3 }, { t: 3.6, v: 0 }] },
    ],
  },
  // 惊讶：向后一顿（身体先退再回），头微微上仰，眼睛往上看
  surprised: {
    name: 'surprised', emotion: 'surprised', duration: 2.2,
    tracks: [
      { param: 'ParamBodyAngleX', keys: [{ t: 0, v: 0 }, { t: 0.18, v: -5 }, { t: 0.7, v: -1.5 }, { t: 2.2, v: 0 }] },
      { param: 'ParamAngleY', keys: [{ t: 0, v: 0 }, { t: 0.2, v: -6 }, { t: 0.9, v: -1 }, { t: 2.2, v: 0 }] },
      { param: 'ParamEyeBallY', keys: [{ t: 0, v: 0 }, { t: 0.3, v: -0.55 }, { t: 1.5, v: -0.4 }, { t: 2.2, v: 0 }] },
      { param: 'ParamBrowLY', keys: [{ t: 0, v: 0 }, { t: 0.25, v: 0.7 }, { t: 1.6, v: 0.5 }, { t: 2.2, v: 0 }] },
    ],
  },
  // 生气：往前压、低头、眉头压低、嘴角向下
  angry: {
    name: 'angry', emotion: 'angry', duration: 3.0,
    tracks: [
      { param: 'ParamBodyAngleX', keys: [{ t: 0, v: 0 }, { t: 0.5, v: 6 }, { t: 2.4, v: 4 }, { t: 3.0, v: 0 }] },
      { param: 'ParamAngleY', keys: [{ t: 0, v: 0 }, { t: 0.6, v: -4 }, { t: 2.4, v: -3 }, { t: 3.0, v: 0 }] },
      { param: 'ParamBrowLY', keys: [{ t: 0, v: 0 }, { t: 0.6, v: -0.45 }, { t: 2.4, v: -0.4 }, { t: 3.0, v: 0 }] },
      { param: 'ParamMouthForm', keys: [{ t: 0, v: 0 }, { t: 0.7, v: -0.45 }, { t: 2.4, v: -0.4 }, { t: 3.0, v: 0 }] },
      { param: 'ParamAngleZ', keys: [{ t: 0, v: 0 }, { t: 0.8, v: -2.5 }, { t: 2.4, v: -2.5 }, { t: 3.0, v: 0 }] },
    ],
  },
};

const EMOTION_ALIASES = {
  happy: 'happy', joy: 'happy', 开心: 'happy', 高兴: 'happy',
  curious: 'curious', 好奇: 'curious',
  playful: 'playful', tease: 'playful', smug: 'playful', 俏皮: 'playful',
  sad: 'sad', 难过: 'sad', 伤心: 'sad', 委屈: 'sad',
  surprised: 'surprised', surprise: 'surprised', 惊讶: 'surprised', 吃惊: 'surprised',
  angry: 'angry', anger: 'angry', 生气: 'angry', 愤怒: 'angry',
};

function smoothstep(u) {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
}

/** 在一条轨道的 keys 上采样（线性 + smoothstep 缓动） */
export function sampleTrack(keys, t) {
  if (!Array.isArray(keys) || keys.length === 0) return 0;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i += 1) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.t) {
      const span = Math.max(1e-6, b.t - a.t);
      return a.v + (b.v - a.v) * smoothstep((t - a.t) / span);
    }
  }
  return keys[keys.length - 1].v;
}

/** 情绪名 → 表演（不认识返回 null：中性句不编舞，避免每句都动） */
export function performanceForEmotion(emotion) {
  const key = EMOTION_ALIASES[String(emotion || '').trim().toLowerCase()] || EMOTION_ALIASES[String(emotion || '').trim()];
  return key ? PERFORMANCES[key] : null;
}

/** 采样整段表演：返回 { param: value }（未到/已过的轨道给 0，不写） */
export function samplePerformance(perf, t) {
  const out = {};
  if (!perf || !Array.isArray(perf.tracks)) return out;
  for (const tr of perf.tracks) {
    const v = sampleTrack(tr.keys, t);
    if (Math.abs(v) > 1e-4) out[tr.param] = v;
  }
  return out;
}

/** 淡入淡出权重：0.35s 进、最后 0.5s 出 */
export function performanceWeight(t, duration) {
  const inW = smoothstep(t / 0.35);
  const outW = smoothstep((duration - t) / 0.5);
  return Math.max(0, Math.min(inW, outW));
}
