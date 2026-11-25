// choreo-performer.mjs —— 表演播放器：把离线编译好的参数轨道按时间采样成「这一帧的叠加量」
//
// 与 choreo-tracks.mjs 的分工（2026-11-15）：
//   choreo-tracks.mjs   = v1 情绪微表演（6 段，2-4 秒，手写，随情绪自动触发）
//   choreo-performer.mjs= v2 情景长表演（15 段，19-38 秒，Python 离线编译）
// 两者可以共存：v1 负责「说话时的情绪小动作」，v2 负责「演一段戏」。
//
// 三条裁决落地（详见交接 §55）：
//   1. 角度类参数（AngleX/Y/Z、PositionX/Y/Z、LeanInput）走**加法偏置**进物理链；
//      归一化参数（眼/嘴/眉/换装开关）走**权重混合覆盖**。
//   2. 手势不写参数轨道，改成下发 playMotion(组, 0/1) + 换装资产。
//   3. 表情不写参数轨道，改成锁脸（exp3 交给 ExpressionManager）。
//
// ── v3（2026-11-16 深夜）：用户说「长表演机械、不连贯」的四个根因与修法 ──
//   ① 关键帧间用 smoothstep ⇒ 每个关键帧速度都归零（走走停停）。
//      改 **PCHIP 单调三次插值**：区间内 C1 连续，速度过关键帧不归零，且不过冲。
//   ② 每条轨道都「回到 0 再停下」，相邻动作之间出现中性停顿。
//      把轨道尾段的回落时间拉长（≤0.5s），相邻动作自然叠上，不再是「pose→0→pose」。
//   ③ 保持姿势时完全静止 ⇒ 像雕像。
//      叠一层**生命层**：极小的连续漂移（±0.7° 头、±0.02 眼球），只在表演时叠加。
//   ④ 同一时刻的多张表情（13 的「裙子+眼镜」、04 的「＞＜+脸红」）只取第一张。
//      改成返回 **expressions 数组**，由渲染层按权重融合（见 cubism-renderer.setPerformanceFaces）。
//
// 采样成本：461 轨 × 平均 5.5 点；PCHIP 切线在第一次播放时缓存到 WeakMap。

import DATA from './choreo-performances.mjs';

/**
 * 手势：作者 motion 组名 + 对应的换装资产（决定「哪只手显示出来」）。
 */
export const GESTURE_GROUP = {
  point: { group: '竖手指', asset: '竖手指' },
  hand_on_chest: { group: '抚胸手', asset: '抚胸' },
  grass: { group: '狗尾巴草', asset: '狗尾草' },
};

/** 有语音时让权的参数：说话时嘴型归语音，编舞的 talk 动作不能抢 */
const SPEECH_OWNED = new Set(['ParamMouthOpenY', 'ParamMouthForm']);

export const PERFORMANCES = DATA.performances;
export const PERFORMANCE_KEYS = Object.keys(PERFORMANCES);

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function smoothstep(u) {
  const x = clamp01(u);
  return x * x * (3 - 2 * x);
}

/**
 * PCHIP（单调三次 Hermite）切线。
 * 端点切线取 0（软起软落）；内部按 Fritsch–Carlson 公式，保证不过冲、速度连续。
 * @returns {number[]} 与 points 等长的切线数组
 */
function pchipTangents(points) {
  const n = points.length;
  const m = new Array(n).fill(0);
  if (n < 2) return m;
  const h = [];
  const d = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dt = Math.max(1e-6, points[i + 1][0] - points[i][0]);
    h.push(dt);
    d.push((points[i + 1][1] - points[i][1]) / dt);
  }
  for (let i = 1; i < n - 1; i += 1) {
    if (d[i - 1] * d[i] <= 0) { m[i] = 0; continue; }
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  return m;
}

/** Hermite 插值（给定两端点值与切线） */
function hermite(t, t0, t1, v0, v1, m0, m1) {
  const h = Math.max(1e-6, t1 - t0);
  const u = clamp01((t - t0) / h);
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return h00 * v0 + h10 * h * m0 + h01 * v1 + h11 * h * m1;
}

/** 在 points（[[t,v],...]，t 相对轨道起点）上采样（PCHIP，C1 连续，不过冲） */
export function samplePoints(points, t) {
  const n = points.length;
  if (!n) return 0;
  if (t <= points[0][0]) return points[0][1];
  const last = points[n - 1];
  if (t >= last[0]) return last[1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= t) lo = mid; else hi = mid;
  }
  const m = pchipTangents(points);
  return hermite(t, points[lo][0], points[hi][0], points[lo][1], points[hi][1], m[lo], m[hi]);
}

// 每条轨道第一次播放时缓存「拉长尾段 + PCHIP 切线」，之后每帧零分配。
const prepared = new WeakMap();

/**
 * 尾段回落拉长：author 数据每条轨道都以「回到 0」结束，相邻动作之间会留下
 * 0.4~1s 的完全静止。把尾段斜坡整体延长（≤0.5s）后，相邻动作能叠在一起，
 * 动作之间不再有「回中性位」的停顿。
 * @returns {{points:number[][], tangents:number[], duration:number}}
 */
function prepareTrack(tr) {
  let out = prepared.get(tr);
  if (out) return out;
  const pts = tr.points;
  const n = pts.length;
  const clone = pts.map((p) => [p[0], p[1]]);
  let duration = Number(tr.duration) || (n ? pts[n - 1][0] : 0);
  if (n >= 2) {
    const last = clone[n - 1];
    const prev = clone[n - 2];
    const ramp = last[0] - prev[0];
    if (ramp > 1e-3) {
      // 只延长「回落」尾段（末值比前值更接近 0 才算回落），避免把还在保持的段拉长
      const isRelease = Math.abs(last[1]) < Math.abs(prev[1]) + 1e-6;
      if (isRelease) {
        const ext = Math.min(0.5, Math.max(0.15, ramp * 1.0));
        last[0] += ext;
        duration += ext;
      }
    }
  }
  out = { points: clone, tangents: pchipTangents(clone), duration };
  prepared.set(tr, out);
  return out;
}

/** 用预计算切线采样（播放器热路径） */
function samplePrepared(prep, t) {
  const points = prep.points;
  const n = points.length;
  if (!n) return 0;
  if (t <= points[0][0]) return points[0][1];
  const last = points[n - 1];
  if (t >= last[0]) return last[1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= t) lo = mid; else hi = mid;
  }
  const m = prep.tangents;
  return hermite(t, points[lo][0], points[hi][0], points[lo][1], points[hi][1], m[lo], m[hi]);
}

/**
 * 头部/躯干动作的「去舞台味」参数（2026-11-16 用户反馈「每段都左右摆头、幅度大、像刻意安排」）。
 * 实测 15 段里 10 段有 yaw 轨（±5~26°）、14 段有 roll 轨（±5~22°），12-bold 甚至有 8 次方向反转。
 * 真人的转头：幅度更小、速度更慢、不会每次都一样。
 *   gain    —— 幅度缩放（yaw 0.62 / roll 0.52）
 *   maxRate —— 最大角速度（度/秒），超了就排队慢慢转，不「啪」地甩过去
 * 手动演出同样生效（这是观感参数，不是自动触发参数）。
 */
export const HEAD_TUNE = {
  AngleX: { gain: 0.62, maxRate: 40 },
  AngleY: { gain: 0.72, maxRate: 32 },
  AngleZ: { gain: 0.52, maxRate: 26 },
  PositionX: { gain: 0.70, maxRate: 30 },
  PositionY: { gain: 0.80, maxRate: 22 },
  PositionZ: { gain: 0.72, maxRate: 26 },
  LeanInput: { gain: 0.85, maxRate: 60 },
};

/** 每次播放的幅度微扰动：0.86~1.06，避免同一段每次一模一样（刻意的来源之一） */
function headVariation() {
  return 0.86 + Math.random() * 0.2;
}

/** 全局权重：0.6s 淡入 / 1.0s 淡出（比 v2 更慢，长表演进出不再「啪」一下） */
export function performanceEnvelope(t, duration) {
  const inW = smoothstep(t / 0.6);
  const outW = smoothstep((duration - t) / 1.0);
  return Math.max(0, Math.min(inW, outW));
}

/**
 * 生命层：表演保持姿势时叠加的极小连续漂移。
 * 幅度刻意小于 1°，不会抢 authored 动作，只让「停住」的那几秒不像雕像。
 */
export function lifeLayer(t) {
  return {
    AngleX: 0.62 * Math.sin(t * Math.PI * 2 * 0.17 + 0.6) + 0.22 * Math.sin(t * Math.PI * 2 * 0.43 + 2.2),
    AngleZ: 0.5 * Math.sin(t * Math.PI * 2 * 0.13 + 1.1),
    ParamEyeBallX: 0.018 * Math.sin(t * Math.PI * 2 * 0.09 + 0.3),
  };
}

/**
 * 建一个播放器实例。渲染层每帧调 sample()，把结果塞进 updateView 的 view。
 * 单实例单表演：start() 会顶掉当前表演（不做队列，避免「排队演戏」）。
 *
 * ── P2b（2026-11-25，ADR-015 §3.1 前提）──
 * 旧实现只有 stop()（一帧硬切），于是「收势」无从谈起，且中途停止不补手势 exit
 * （审计 §1.5/§2.4：竖指/抚胸/狗尾草资产会留在手上）。现在补三样：
 *   · fadeOut(ms)：ms 内所有权重线性降到 0，然后 stop()（旧 stop 仍是立即硬切）；
 *   · stop()：把「已进入但还没收回」的手势补成 exit 事件（有 exitDuration 就带上 fadeMs）；
 *   · canCutAt(at, relaxPreempt)：给调度器查「现在能不能切」，sync 仍由调度器持有。
 */
export function createPerformer(options = {}) {
  const envelope = options.envelope || performanceEnvelope;
  const life = options.life === false ? null : (options.life || lifeLayer);
  const clock = typeof options.now === 'function' ? options.now : () => (
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
  let cur = null;
  // 停止时补发的手势 exit：等下一次 sample（或调用方 takeExits）取走再下发。
  // 上限 8 条：一段戏最多 2 个手势，正常不会溢出；溢出说明有人忘了取。
  let pendingExits = [];

  function exitEventsFor(c, reason) {
    const out = [];
    if (!c) return out;
    const gsteps = (c.data && c.data.gestureSteps) || [];
    for (let i = 0; i < gsteps.length; i += 1) {
      const g = gsteps[i];
      const map = GESTURE_GROUP[g.name];
      if (!map) continue;
      const enterKey = `g${i}:in`;
      const exitKey = `g${i}:out`;
      // 只补「进过但没出过」的：已经正常收回的不重复发
      if (!c.fired.has(enterKey) || c.fired.has(exitKey)) continue;
      c.fired.add(exitKey);
      const exitDuration = Number.isFinite(g.exitDuration) ? Math.max(0, g.exitDuration) : 0.6;
      out.push({
        group: map.group,
        asset: map.asset,
        on: false,
        index: 1,
        label: `${g.label || g.name}·收回（${reason || 'stop'}）`,
        // 资产开关本身没有淡出 API；把作者的 exitDuration 带出去，宿主/资产层要淡出时用它
        fadeMs: Math.round(exitDuration * 1000),
        forced: true,
      });
    }
    return out;
  }

  /** 取走待发的 exit（entry 每帧调一次；没有就是空数组，零分配语义） */
  function takeExits() {
    if (!pendingExits.length) return [];
    const out = pendingExits;
    pendingExits = [];
    return out;
  }

  /**
   * 立即停止（旧语义：一帧硬切）。**新增**：补发未收回的手势 exit。
   * 返回本次补发的 exit 数组（同时进 pendingExits，sample 也会带出去）。
   */
  function stop(reason) {
    if (!cur) return takeExits();
    const exits = exitEventsFor(cur, reason || 'stop');
    if (exits.length) pendingExits = pendingExits.concat(exits).slice(-8);
    cur = null;
    return exits;
  }

  /**
   * 收势：ms 内把本段所有权重线性降到 0，降到 0 时走 stop()（补发手势 exit）。
   * ms<=0 等价 stop()。时间锚点取**第一次 sample 的 now** —— 单测/调用方
   * 用的时钟不必和内部一致，也不会出现「fadeOut 时锚到另一个时钟」的漂移。
   */
  function fadeOut(ms) {
    if (!cur) return false;
    const dur = Math.max(0, Number(ms) || 0);
    if (!(dur > 0)) { stop('fade'); return true; }
    cur.fade = { ms: dur, at: null };
    return true;
  }

  /** 已播毫秒（调度器/调试读；没有表演时 0） */
  function elapsedMs(at) {
    if (!cur) return 0;
    const t = Number.isFinite(Number(at)) ? Number(at) : clock();
    return Math.max(0, Math.round((t - cur.startedAt) * 10) / 10);
  }

  /**
   * 给调度器查询「现在能不能切」。sync（relax 点）由调度器从 perf-sync.json 持有，
   * 这里**不重复实现**，只把 elapsedMs 与调用方给的 relaxPreempt 对一下：
   *   · 没有 relax 点 → atomic=true / canCut=false（只能等这一段结束）
   *   · 已到/过了某个 relax 点 → canCut=true + 最近一个点的相对毫秒
   * @param {number} at
   * @param {number[]} [relaxPreempt] 允许抢占的 relax 点（相对本段起点的毫秒）
   */
  function canCutAt(at, relaxPreempt) {
    if (!cur) return { active: false, elapsedMs: 0, atomic: false, nextRelaxMs: 0, canCut: false, fading: false };
    const elapsed = elapsedMs(at);
    const list = (Array.isArray(relaxPreempt) ? relaxPreempt : [])
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 0)
      .sort((a, b) => a - b);
    const next = list.find((v) => v >= elapsed - 1e-6);
    return {
      active: true,
      elapsedMs: elapsed,
      atomic: list.length === 0,
      nextRelaxMs: next == null ? 0 : Math.round(next * 10) / 10,
      canCut: next != null,
      fading: Boolean(cur.fade),
    };
  }

  /** 开始一段表演。返回 false 表示没有这段（名字写错）。 */
  function start(key, now = Date.now(), opts = {}) {
    const data = PERFORMANCES[String(key)];
    if (!data) return false;
    cur = {
      key: String(key),
      data,
      startedAt: now,
      gain: Number.isFinite(opts.gain) ? Math.max(0, Math.min(1.5, opts.gain)) : 1,
      fired: new Set(),        // 已触发的一次性事件（表情锁/手势进出）
      tracks: (data.tracks || []).map((tr) => ({ tr, prep: prepareTrack(tr) })),
      prev: new Map(),         // 限速器状态：参数 → 上一次输出
      prevAt: now,
      headVar: headVariation(),// 每次播放的幅度扰动（0.86~1.06）
    };
    return true;
  }

  /**
   * 采样这一帧。
   * @returns {null | {
   *   key, t, duration, done,
   *   additive: { param: number },
   *   override: { param: number },
   *   overrideW: number,
   *   expression: string|null,          // 兼容字段：第一张脸
   *   expressions: string[],            // 本帧所有该锁的脸（渲染层按权重融合）
   *   gestures: Array<{ group, asset, on, index, label }>
   * }}
   */
  function sample(now = Date.now(), ctx = {}) {
    if (!cur) return null;
    const data = cur.data;
    const t = (now - cur.startedAt) / 1000;
    const duration = Number(data.duration) || 0;
    if (t > duration + 0.4) {
      stop('natural');
      return null;
    }
    // 收势权重：线性的 1 → 0（fadeOut 只在收势窗口里乘，不影响正常包络）
    let fadeW = 1;
    if (cur.fade) {
      if (cur.fade.at == null) cur.fade.at = now;
      fadeW = Math.max(0, 1 - (now - cur.fade.at) / cur.fade.ms);
      if (fadeW <= 0) { stop('fade-out'); return null; }
    }
    const w = envelope(t, duration) * fadeW;
    const gain = cur.gain;
    const speaking = ctx.speaking === true;

    const additive = {};
    const override = {};
    for (const entry of cur.tracks) {
      const tr = entry.tr;
      const prep = entry.prep;
      // 活跃窗口：轨道自身 [start, start+duration]（duration 已含尾段延长）
      if (t < tr.start || t > tr.start + prep.duration) continue;
      const v = samplePrepared(prep, t - tr.start);
      if (Math.abs(v) < 1e-6) continue;
      if (tr.channel === 'angle') {
        // 同一参数可能有多条重叠轨道（语义动作分段编译），加法语义要累加而不是覆盖
        additive[tr.id] = (additive[tr.id] || 0) + v * w * gain;
      } else {
        if (speaking && SPEECH_OWNED.has(tr.id)) continue;
        override[tr.id] = v;
      }
    }

    // 生命层：叠加极小连续漂移（只在表演期间有）
    if (life) {
      const drift = life(t);
      for (const id of Object.keys(drift)) {
        const off = drift[id] * w * gain;
        if (Math.abs(off) < 1e-6) continue;
        additive[id] = (additive[id] || 0) + off;
      }
    }

    // ── 去舞台味：头部/躯干幅度缩放 + 角速度限速（v3.1）─────────────
    // 用户反馈「每段都左右摆头、幅度大、像刻意安排」。
    // 缩放让 ±18~26° 的转头落到 ±11~16°；限速让 0.3 秒甩 18°（60°/s）降到 ≤40°/s。
    // 限速是逐帧的，dt 用相邻两次 sample 的时间差；稀疏采样时封顶 100ms，避免一次跳变。
    {
      const dt = Math.min(0.1, Math.max(0.001, (now - cur.prevAt) / 1000));
      cur.prevAt = now;
      // 先算所有目标（幅度缩放 + 每次播放微扰动）
      const targets = {};
      for (const id of Object.keys(HEAD_TUNE)) {
        targets[id] = (additive[id] || 0) * HEAD_TUNE[id].gain * cur.headVar;
      }
      // 转头和歪头同时很大时读作「大幅摆头」。转头越大，歪头自动收一点（人做动作不会两头都满格）。
      const yawMag = Math.min(1, Math.abs(targets.AngleX || 0) / 18);
      if (targets.AngleZ) targets.AngleZ *= (1 - 0.35 * yawMag);
      for (const id of Object.keys(HEAD_TUNE)) {
        const target = targets[id];
        const prev = cur.prev.get(id) || 0;
        const maxStep = HEAD_TUNE[id].maxRate * dt;
        let out = target;
        if (target - prev > maxStep) out = prev + maxStep;
        else if (target - prev < -maxStep) out = prev - maxStep;
        if (Math.abs(out) < 1e-5) { delete additive[id]; cur.prev.delete(id); }
        else { additive[id] = out; cur.prev.set(id, out); }
      }
    }

    // 表情：本帧所有区间命中的脸（13 的裙子+眼镜、04 的＞＜+脸红 都要）
    const expressions = [];
    const steps = data.expressionSteps || [];
    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i];
      if (t >= s.start && t < s.start + s.duration) {
        const name = s.name || null;
        if (name && !expressions.includes(name)) expressions.push(name);
      }
    }

    // 手势：进入/退出各触发一次（原生 motion 只播一遍，不能每帧重发）
    // 先把「上一次 stop() 补发的 exit」带出去，再按时间轴发本帧进出。
    const gestures = takeExits();
    const gsteps = data.gestureSteps || [];
    for (let i = 0; i < gsteps.length; i += 1) {
      const g = gsteps[i];
      const map = GESTURE_GROUP[g.name];
      if (!map) continue;
      const enterKey = `g${i}:in`;
      const exitKey = `g${i}:out`;
      if (!cur.fired.has(enterKey) && t >= g.start - 0.05) {
        cur.fired.add(enterKey);
        gestures.push({ group: map.group, asset: map.asset, on: true, index: 0, label: `${g.label || g.name}·进入` });
      }
      const exitAt = Number.isFinite(g.exitAt) ? g.exitAt : g.start + g.duration - (g.exitDuration || 0.6);
      if (!cur.fired.has(exitKey) && t >= exitAt) {
        cur.fired.add(exitKey);
        gestures.push({ group: map.group, asset: map.asset, on: false, index: 1, label: `${g.label || g.name}·收回` });
      }
    }

    const done = t > duration;
    return {
      key: cur.key,
      t,
      duration,
      done,
      additive,
      override,
      overrideW: w * gain,
      fadeW,
      expression: expressions[0] || null,
      expressions,
      gestures,
    };
  }

  return {
    start,
    stop,
    sample,
    fadeOut,
    takeExits,
    elapsedMs,
    canCutAt,
    get active() { return !!cur; },
    get key() { return cur ? cur.key : ''; },
    get title() { return cur ? (cur.data.title || cur.key) : ''; },
    /** 正在收势时非 0（剩余毫秒由调用方自己按 fadeOut 的 ms 推） */
    get fading() { return Boolean(cur && cur.fade); },
    /** 某段**声明**会写哪些参数（编译数据里的轨道 id）。用于所有权断言，不参与渲染。 */
    params(key) {
      const data = PERFORMANCES[String(key)];
      if (!data) return [];
      return (data.tracks || []).map((tr) => String(tr.id));
    },
    list() {
      return PERFORMANCE_KEYS.map((k) => ({
        key: k,
        title: PERFORMANCES[k].title,
        duration: PERFORMANCES[k].duration,
        steps: (PERFORMANCES[k].steps || []).length,
      }));
    },
  };
}
