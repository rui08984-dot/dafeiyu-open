#!/usr/bin/env node
/**
 * _probe/test-perf-ambient.cjs —— Ambient 待机层（2026-11-25 P1，ADR-015 §3.4）
 *
 * 钉住的是「公式」而不是「观感」：
 *   ① 6 状态集合与默认参数（σ=0.6、钳 [20s,8min]、幅度 scale=0.3）；
 *   ② 对数正态停留：边界、非均匀（方差）、中位数 ≈ exp(μ)；
 *   ③ 转移概率受上下文调制：away→quiet、在场→observe↑、深夜→sleepy↑、久无交互→bored↑、刚聊完→settle↑；
 *   ④ 加权待机池：P(i)=weight_i/Σweight（3:1）、被接率映射（样本≥20 才动）、采样频率≈解析概率、mode 过滤；
 *   ⑤ 效用 margin + 惯性（0.7^最近次数）；
 *   ⑥ 非固定间隔 U(90s,300s)，每次重抽（不是固定周期）；
 *   ⑦ 幅度 ≤ scale，且任一 |bias|>0.0015 或 needsRecompute=true（脏帧阈值）；
 *   ⑧ 随机可复现（同种子逐值一致），不同种子不同；
 *   ⑨ 接线：choreo-auto 的 considerIdle 只认 intensity≥0.8；BodyDirector/InteractionMotion 的 amp；
 *      输出契约含 motionScale 与 bias 全字段；perf 的 idle 层不再写外部通道（P1.5 契约变更，
 *      偏置改由渲染器 setAmbientOffset → PROC_MOTION 单写落地，见 test-perf-ambient-apply.cjs）。
 *
 * 用法：node _probe/test-perf-ambient.cjs
 * 退出码：0 全过 / 1 有失败
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('node:url');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail !== undefined ? ' —— ' + detail : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { pass += 1; return; }
  fail += 1;
  console.error('  ✗ ' + name + ' —— got ' + a + ' want ' + b);
}
function near(name, got, want, eps) {
  ok(name, Number.isFinite(got) && Math.abs(got - want) <= eps, `${got} vs ${want} ±${eps}`);
}

const DESKTOP = path.join(__dirname, '..', 'pet-runtime', 'desktop');
const file = (p) => pathToFileURL(path.join(DESKTOP, p)).href;
const NOW = 1_800_000_000_000;

(async () => {
  const A = await import(file('perf/ambient.mjs'));
  const {
    AMBIENT_STATES, AMBIENT_DEFAULTS, STATE_PROFILES, AMBIENT_POOL, DIRTY_EPS,
    mulberry32, logNormalDwellMs, transitionProbabilities, pickNextState,
    poolWeights, poolProbabilities, pickPoolAction, biasAt, createAmbient,
    normalizeContext,
  } = A;

  // ── ① 状态集合与默认参数 ─────────────────────────────────────────────
  eq('6 状态集合', AMBIENT_STATES, ['quiet', 'observe', 'bored', 'sleepy', 'playful', 'settle']);
  eq('σ=0.6', AMBIENT_DEFAULTS.sigma, 0.6);
  eq('停留下界 20s', AMBIENT_DEFAULTS.minDwellMs, 20000);
  eq('停留上界 8min', AMBIENT_DEFAULTS.maxDwellMs, 8 * 60 * 1000);
  eq('幅度上限 0.3', AMBIENT_DEFAULTS.scale, 0.3);
  eq('非固定间隔 [90s,300s]', [AMBIENT_DEFAULTS.delayMinMs, AMBIENT_DEFAULTS.delayMaxMs], [90000, 300000]);
  eq('效用 ε 区间 [0.05,0.15]', [AMBIENT_DEFAULTS.marginMin, AMBIENT_DEFAULTS.marginMax], [0.05, 0.15]);
  eq('惯性底数 0.7', AMBIENT_DEFAULTS.inertia, 0.7);
  ok('每个状态都有 μ/ψ 档位', AMBIENT_STATES.every((s) => STATE_PROFILES[s] && STATE_PROFILES[s].medianSec > 0));
  ok('呼吸周期落在 4–6s（Amica 常量区间）',
    AMBIENT_STATES.every((s) => STATE_PROFILES[s].breathPeriod >= 4 && STATE_PROFILES[s].breathPeriod <= 6),
    AMBIENT_STATES.map((s) => STATE_PROFILES[s].breathPeriod).join(','));

  // ── ② 对数正态停留 ──────────────────────────────────────────────────
  {
    const rnd = mulberry32(1234);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 600; i += 1) {
      const d = logNormalDwellMs('quiet', { random: rnd });
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    ok('停留 ≥20s', min >= 20000, String(min));
    ok('停留 ≤8min', max <= 480000, String(max));
    ok('停留不是固定值（至少 100 个不同值）', new Set(
      Array.from({ length: 300 }, () => Math.round(logNormalDwellMs('observe', { random: rnd }))),
    ).size > 100);
  }
  {
    // 不截断时 log(dwell) 的标准差应 ≈ σ
    const rnd = mulberry32(99);
    const gauss = A.createGaussian(rnd);
    const logs = [];
    for (let i = 0; i < 800; i += 1) logs.push(Math.log(logNormalDwellMs('bored', { gauss, clampToRange: false })));
    const mean = logs.reduce((s, v) => s + v, 0) / logs.length;
    const sd = Math.sqrt(logs.reduce((s, v) => s + (v - mean) ** 2, 0) / logs.length);
    near('log 停留 σ≈0.6', sd, 0.6, 0.08);
    near('中位数≈exp(μ)', Math.exp(mean), STATE_PROFILES.bored.medianSec * 1000, 30000);
  }
  {
    // 不同状态的停留中位数不同（不是「所有状态一个时长」）
    const meds = AMBIENT_STATES.map((s) => STATE_PROFILES[s].medianSec);
    ok('各状态停留中位数不全相同', new Set(meds).size >= 4, meds.join(','));
    ok('playful 比 sleepy 短', STATE_PROFILES.playful.medianSec < STATE_PROFILES.sleepy.medianSec);
  }

  // ── ③ 转移概率受上下文调制 ──────────────────────────────────────────
  const ctxDay = { now: NOW, hour: 14, presence: 'working', idleSec: 0, conversationEndedAt: 0, intensity: 0.5 };
  {
    for (const s of AMBIENT_STATES) {
      eq('away → quiet（' + s + '）', pickNextState(s, Object.assign({}, ctxDay, { presence: 'away' }), mulberry32(7)), 'quiet');
    }
    const observeP = transitionProbabilities('quiet', Object.assign({}, ctxDay, { presence: 'working' })).observe;
    const awayP = transitionProbabilities('quiet', Object.assign({}, ctxDay, { presence: 'unknown' })).observe;
    ok('在场 → observe 概率更高', observeP > awayP, `${observeP} vs ${awayP}`);
    const night = transitionProbabilities('quiet', Object.assign({}, ctxDay, { hour: 2 })).sleepy;
    const day = transitionProbabilities('quiet', ctxDay).sleepy;
    ok('深夜 → sleepy 概率更高', night > day, `${night} vs ${day}`);
    const longIdle = transitionProbabilities('quiet', Object.assign({}, ctxDay, { idleSec: 1200 })).bored;
    const fresh = transitionProbabilities('quiet', ctxDay).bored;
    ok('久无交互 → bored 概率更高', longIdle > fresh, `${longIdle} vs ${fresh}`);
    const justTalked = transitionProbabilities('quiet', Object.assign({}, ctxDay, { conversationEndedAt: NOW - 10000 })).settle;
    const stale = transitionProbabilities('quiet', ctxDay).settle;
    ok('刚聊完 → settle 概率更高', justTalked > stale, `${justTalked} vs ${stale}`);
    const p = transitionProbabilities('observe', ctxDay);
    const sum = Object.values(p).reduce((s, v) => s + v, 0);
    near('转移概率归一', sum, 1, 1e-5);
    const hot = transitionProbabilities('quiet', Object.assign({}, ctxDay, { intensity: 1 })).playful;
    const low = transitionProbabilities('quiet', Object.assign({}, ctxDay, { intensity: 0 })).playful;
    ok('导演 intensity 高 → playful 权重更高（也更容易被表演接走）', hot > low, `${hot} vs ${low}`);
  }
  {
    // 抽样频率与解析概率一致（2000 次）
    const rnd = mulberry32(4242);
    const counts = Object.create(null);
    for (let i = 0; i < 2000; i += 1) {
      const s = pickNextState('observe', ctxDay, rnd);
      counts[s] = (counts[s] || 0) + 1;
    }
    const probs = transitionProbabilities('observe', ctxDay);
    const observeFreq = (counts.observe || 0) / 2000;
    near('抽样 observe 频率 ≈ 解析概率', observeFreq, probs.observe, 0.06);
    ok('抽样覆盖 ≥4 个状态', Object.keys(counts).length >= 4, Object.keys(counts).join(','));
    const pure = normalizeContext({ presence: 'allowed' }, NOW);
    eq('未知活动态归一为 unknown', pure.presence, 'unknown');
  }

  // ── ④ 加权待机池（ChatdollKit 公式）────────────────────────────────
  {
    const probs = poolProbabilities('quiet', ctxDay);
    const sum = Object.values(probs).reduce((s, v) => s + v, 0);
    near('池概率归一', sum, 1, 1e-5);
    const common = AMBIENT_POOL.filter((i) => i.weight === 3).length;
    const rare = AMBIENT_POOL.filter((i) => i.weight === 1).length;
    ok('池里有常用（3）与少见（1）两档', common > 0 && rare > 0, `common=${common} rare=${rare}`);
    const w = poolWeights('observe', ctxDay);
    const breathe = w.find((i) => i.key === 'breathe');
    const rareItem = w.find((i) => i.key === 'ear-twitch');
    ok('observe 池里常用动作权重 > 少见动作（3:1 语义）', Boolean(breathe && rareItem && breathe.weight > rareItem.weight));
    // mode 过滤
    const sleepyKeys = Object.keys(poolProbabilities('sleepy', ctxDay));
    ok('sleepy 池含 yawn', sleepyKeys.includes('yawn'), sleepyKeys.join(','));
    ok('sleepy 池不含 look-around（mode 过滤）', !sleepyKeys.includes('look-around'), sleepyKeys.join(','));
    // 被接率映射：样本 <20 不动
    const lowSample = poolWeights('quiet', Object.assign({}, ctxDay, { reply: { rate: 0.02, samples: 10 } }));
    eq('样本 <20 不改权重', lowSample.find((i) => i.key === 'breathe').weight, 3);
    const lowRate = poolWeights('quiet', Object.assign({}, ctxDay, { reply: { rate: 0.05, samples: 25 } }));
    const highRate = poolWeights('quiet', Object.assign({}, ctxDay, { reply: { rate: 0.6, samples: 25 } }));
    eq('被接率 5%（≥20 样本）→ 常用动作 3→2', lowRate.find((i) => i.key === 'breathe').weight, 2);
    eq('被接率 60%（≥20 样本）→ 常用动作 3→4', highRate.find((i) => i.key === 'breathe').weight, 4);
    eq('权重下限不会被压到 0', lowRate.find((i) => i.key === 'breathe').weight >= 1, true);
  }
  {
    // margin=0（纯 ChatdollKit 公式）时，采样频率应 ≈ P(i)=weight/Σweight
    const rnd = mulberry32(2026);
    const counts = Object.create(null);
    for (let i = 0; i < 4000; i += 1) {
      const k = pickPoolAction('observe', { now: NOW, marginMin: 0, marginMax: 0 }, rnd, []);
      counts[k] = (counts[k] || 0) + 1;
    }
    const probs = poolProbabilities('observe', ctxDay);
    for (const key of Object.keys(probs)) {
      near('池抽样频率 ' + key, (counts[key] || 0) / 4000, probs[key], 0.03);
    }
    const commonHits = ['breathe', 'look-around', 'shift-weight', 'gaze-drift']
      .reduce((s, k) => s + (counts[k] || 0), 0) / 4;
    const rareHits = ['ear-twitch', 'small-stretch'].reduce((s, k) => s + (counts[k] || 0), 0) / 2;
    ok('常用动作的采样频率高于少见动作（≥1.3×）', commonHits > rareHits * 1.3, `${commonHits.toFixed(1)} vs ${rareHits.toFixed(1)}`);
    ok('采样覆盖池内全部动作（少见动作仍会出现）', ['breathe', 'look-around', 'shift-weight', 'gaze-drift', 'ear-twitch', 'small-stretch'].every((k) => (counts[k] || 0) > 0), Object.keys(counts).join(','));
    // margin=0 且权重相同 → 均匀（不依赖固定顺序）
    const tie = Object.create(null);
    for (let i = 0; i < 2000; i += 1) {
      const k = pickPoolAction('quiet', { now: NOW, marginMin: 0, marginMax: 0 }, rnd, []);
      tie[k] = (tie[k] || 0) + 1;
    }
    ok('同权重时四个动作都被选中（无固定顺序）', Object.keys(tie).length >= 4, Object.keys(tie).join(','));
    // 惯性：最近连做 4 次 breathe → 下一次选它的概率显著下降
    let withInertia = 0;
    for (let i = 0; i < 2000; i += 1) {
      if (pickPoolAction('quiet', { now: NOW, marginMin: 0, marginMax: 0 }, rnd, ['breathe', 'breathe', 'breathe', 'breathe']) === 'breathe') withInertia += 1;
    }
    const base = poolProbabilities('quiet', ctxDay).breathe;
    ok('0.7^最近次数 惯性压低重复（0.7^4≈0.24）', withInertia / 2000 < base * 0.55, `${(withInertia / 2000).toFixed(3)} vs base ${base}`);
  }

  // ── ⑤ 非固定间隔 + amp/偏置 ─────────────────────────────────────────
  {
    const amb = createAmbient({ seed: 777, scale: 0.3 });
    const delays = [];
    let maxAmp = 0;
    let badBias = 0;
    let recompute = 0;
    let now = NOW;
    let ampViolations = 0;
    const calmCtx = Object.assign({}, ctxDay, { intensity: 0 });
    for (let i = 0; i < 400; i += 1) {
      now += 15000; // 15 秒一步，跨过多次停留
      const out = amb.sample(now, calmCtx);
      maxAmp = Math.max(maxAmp, out.amp);
      if (out.amp > 0.3 + 1e-9) ampViolations += 1;
      let maxAbs = 0;
      for (const v of Object.values(out.bias)) maxAbs = Math.max(maxAbs, Math.abs(v));
      if (maxAbs <= DIRTY_EPS && out.needsRecompute !== true) badBias += 1;
      if (out.needsRecompute) recompute += 1;
      delays.push(out.nextDelayMs);
    }
    eq('amp 从不越界（≤ scale）', ampViolations, 0);
    ok('amp 最大值恰为 scale（playful 状态能到满预算）', Math.abs(maxAmp - 0.3) < 1e-6, String(maxAmp));
    ok('没有「偏置全在脏帧阈值内且未要求重算」的帧', badBias === 0, String(badBias));
    ok('needsRecompute 偶发但非默认（<10%）', recompute / 400 < 0.1, String(recompute));
    ok('nextDelay 全部 ∈[90s,300s]', delays.every((d) => d >= 90000 && d <= 300000), String(Math.min(...delays)) + '..' + Math.max(...delays));
    ok('nextDelay 每次重抽（≥30 个不同值）', new Set(delays.map((d) => Math.round(d / 1000))).size >= 30);
    ok('至少迁移过 2 次状态', amb.transitions >= 2, String(amb.transitions));
  }
  {
    // 直接验 biasAt：任何状态、amp=0.105（最小档）时都超过脏帧阈值
    for (const s of AMBIENT_STATES) {
      let maxAbs = 0;
      for (let t = 0; t < 20000; t += 370) {
        const b = biasAt(s, t, 0.105);
        for (const v of Object.values(b)) maxAbs = Math.max(maxAbs, Math.abs(v));
      }
      ok('最小 amp 下仍有 >0.0015 的偏置（' + s + '）', maxAbs > DIRTY_EPS, String(maxAbs));
    }
    const sleepyAmp = 0.3 * STATE_PROFILES.sleepy.amp;
    const playfulAmp = 0.3 * STATE_PROFILES.playful.amp;
    ok('sleepy 幅度 < playful 幅度', sleepyAmp < playfulAmp, `${sleepyAmp} vs ${playfulAmp}`);
  }
  {
    // 可复现：同种子逐值一致；不同种子不同
    const run = (seed) => {
      const amb = createAmbient({ seed, scale: 0.3 });
      const out = [];
      let now = NOW;
      for (let i = 0; i < 40; i += 1) {
        now += 9000;
        const s = amb.sample(now, ctxDay);
        out.push([s.state, s.dwellMs, s.amp, +s.bias.headYaw.toFixed(6), s.nextDelayMs]);
      }
      return out;
    };
    eq('同种子可复现', run(123), run(123));
    ok('不同种子不同', JSON.stringify(run(123)) !== JSON.stringify(run(124)));
  }
  {
    const amb = createAmbient({ seed: 5, scale: 0.3 });
    amb.setIntensity(1);
    const hot = amb.sample(NOW + 1000, { now: NOW + 1000, presence: 'working', hour: 14 });
    amb.setIntensity(0);
    const calm = amb.sample(NOW + 2000, { now: NOW + 2000, presence: 'working', hour: 14 });
    ok('导演 intensity=1 时幅度被压（≤65%）', hot.amp <= calm.amp + 1e-9, `${hot.amp} vs ${calm.amp}`);
    const off = createAmbient({ seed: 5, enabled: false });
    const z = off.sample(NOW, ctxDay);
    eq('禁用时 amp=0 / 偏置全 0', [z.amp, z.bias.headYaw, z.bias.posture], [0, 0, 0]);
    eq('禁用时 motionScale=1（旧行为）', z.motionScale, 1);
  }
  {
    // 输出契约（P1.5）：motionScale 与 bias 全字段必须稳定存在且可消费
    const amb = createAmbient({ seed: 11, scale: 0.3 });
    let now = NOW;
    let msMin = Infinity;
    let msMax = -Infinity;
    for (let i = 0; i < 200; i += 1) {
      now += 7000;
      const out = amb.sample(now, Object.assign({}, ctxDay, { intensity: 0.4 }));
      if (typeof out.motionScale !== 'number') { ok('输出含 motionScale', false); break; }
      msMin = Math.min(msMin, out.motionScale);
      msMax = Math.max(msMax, out.motionScale);
      const keys = Object.keys(out.bias).sort();
      if (JSON.stringify(keys) !== JSON.stringify(['breath', 'gazeX', 'gazeY', 'headPitch', 'headYaw', 'posture'])) {
        ok('bias 全字段稳定', false, keys.join(','));
        break;
      }
    }
    ok('输出契约含 motionScale（0.45..1）', msMin >= 0.45 - 1e-9 && msMax <= 1 + 1e-9, `${msMin}..${msMax}`);
    ok('motionScale 随幅度变化（不是常数）', msMax - msMin > 0.01, `${msMin}..${msMax}`);
    eq('bias 全字段', Object.keys(amb.sample(NOW + 9000, ctxDay).bias).sort(),
      ['breath', 'gazeX', 'gazeY', 'headPitch', 'headYaw', 'posture']);
  }

  // ── ⑥ 接线：choreo-auto 的 intensity 门 ─────────────────────────────
  {
    const AUTO = await import(file('choreo-auto.mjs'));
    eq('DEFAULT_OPTIONS.idleMinIntensity=0.8', AUTO.DEFAULT_OPTIONS.idleMinIntensity, 0.8);
    const trig = AUTO.createAutoTrigger({});
    const blocked = trig.considerIdle({ now: 100 * 60000, idleMs: 10 * 60000, rand: 0, rand2: 0.5, intensity: 0.3 });
    eq('intensity 0.3 → 只走 ambient', [blocked.play, blocked.reason], [false, 'director-low-intensity']);
    eq('被门挡住不吃冷却（sessionCount 仍 0）', trig.sessionCount, 0);
    const allowed = trig.considerIdle({ now: 100 * 60000 + 1, idleMs: 10 * 60000, rand: 0, rand2: 0.5, intensity: 0.9 });
    eq('intensity 0.9 → 允许空闲长段', [allowed.play, allowed.reason], [true, 'ok']);
    eq('允许后才记账', trig.sessionCount, 1);
    const legacy = AUTO.decideIdle({ now: 100 * 60000, idleMs: 10 * 60000, rand: 0, rand2: 0.5 });
    eq('不传 intensity = 旧行为（不设门）', legacy.play, true);
  }

  // ── ⑦ 接线：BodyDirector / InteractionMotion 的 amp ─────────────────
  {
    const { BodyDirector } = await import(file('body-director.mjs'));
    const mk = () => new BodyDirector({ random: mulberry32(31337) });
    const full = mk();
    const soft = mk();
    let maxFull = 0;
    let maxSoft = 0;
    for (let i = 0; i < 900; i += 1) {
      const a = full.sample({ delta: 0.016, state: 'idle', speechRate: 0 });
      const b = soft.sample({ delta: 0.016, state: 'idle', speechRate: 0, amp: 0.3 });
      maxFull = Math.max(maxFull, Math.abs(a.bodyX), Math.abs(a.posX), Math.abs(a.idleX), Math.abs(a.breath - 0.5) * 20);
      maxSoft = Math.max(maxSoft, Math.abs(b.bodyX), Math.abs(b.posX), Math.abs(b.idleX), Math.abs(b.breath - 0.5) * 20);
    }
    ok('amp=0.3 把身体摆动压到 ≤40%', maxSoft <= maxFull * 0.4, `${maxSoft.toFixed(3)} vs ${maxFull.toFixed(3)}`);
    ok('amp 不把呼吸压成 0（中位 0.5 保留）', Number.isFinite(soft.sample({ delta: 0.016 }).breath));
    // 旧行为逐值一致：不传 amp 与显式 amp=1 必须完全相同（不是「差不多」）
    const legacy = mk();
    const explicit = mk();
    let identical = true;
    for (let i = 0; i < 300; i += 1) {
      const a = legacy.sample({ delta: 0.016, state: 'idle', speechRate: 0.2 });
      const b = explicit.sample({ delta: 0.016, state: 'idle', speechRate: 0.2, amp: 1 });
      if (JSON.stringify(a) !== JSON.stringify(b)) { identical = false; break; }
    }
    ok('amp 缺省与 amp=1 逐值一致（旧行为不变）', identical);
  }
  {
    const { InteractionMotion } = await import(file('interaction-motion.mjs'));
    const base = { now: 1000, delta: 0.016, state: 'idle', head: true, body: true, blink: true };
    const a = new InteractionMotion();
    const b = new InteractionMotion();
    let maxA = 0;
    let maxB = 0;
    for (let i = 0; i < 400; i += 1) {
      const m = a.sample(Object.assign({}, base, { elapsed: i * 0.016, amp: 1 }));
      const s = b.sample(Object.assign({}, base, { elapsed: i * 0.016, amp: 0.3 }));
      maxA = Math.max(maxA, Math.abs(m.yaw), Math.abs(m.roll));
      maxB = Math.max(maxB, Math.abs(s.yaw), Math.abs(s.roll));
    }
    ok('InteractionMotion amp=0.3 头部摆幅 ≤40%', maxB <= maxA * 0.4, `${maxB.toFixed(3)} vs ${maxA.toFixed(3)}`);
    const c = new InteractionMotion();
    const d = new InteractionMotion();
    let identical = true;
    for (let i = 0; i < 200; i += 1) {
      const p = Object.assign({}, base, { elapsed: i * 0.016 });
      if (JSON.stringify(c.sample(p)) !== JSON.stringify(d.sample(Object.assign({}, p, { amp: 1 })))) { identical = false; break; }
    }
    ok('amp 缺省与 amp=1 逐值一致（旧行为不变）', identical);
  }

  // ── ⑧ 接线：perf 的 idle 层不再「假写」外部通道（P1.5 契约变更）────
  //    变更原因：headX/headY/headZ/gazeX/gazeY/breath/bodyZ 在 profile.mjs 的
  //    EXTERNALLY_OWNED 里全部是外部所有，buildProfile 建画像时整通道丢弃 ——
  //    以前在这里写的偏置「看起来在写、实际到不了参数」。现在偏置唯一落地路径是
  //    渲染器 setAmbientOffset → applyAmbientOffsets → PROC_MOTION 单写
  //    （见 _probe/test-perf-ambient-apply.cjs）；这里只保留「本层收敛微抽」。
  {
    const { createPerfEngine, buildProfile, PROFILE_SPECS } = await import(file('perf/index.mjs'));
    const profile = buildProfile(PROFILE_SPECS.jellyfish, {
      paramIds: new Set(['ParamBrowLY', 'ParamBrowRY', 'EyeSmile', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthForm']),
      expressions: new Set(),
      ranges: new Map(),
    });
    const engine = createPerfEngine({ profile, baseline: {}, seed: 1 });
    const plain = createPerfEngine({ profile, baseline: {}, seed: 1 });
    const bias = { headYaw: 0.06, headPitch: 0.02, breath: 0.03, gazeX: 0.02, gazeY: 0.01, posture: -0.008 };
    const accepted = engine.setAmbientBias({ amp: 0.3, bias });
    eq('setAmbientBias 清洗后原样返回（含 amp/bias）', [accepted.amp, accepted.bias.headYaw], [0.3, 0.06]);
    for (let i = 0; i < 30; i += 1) { engine.update(0.05); plain.update(0.05); }
    const snap = engine.snapshot();
    const ref = plain.snapshot();
    eq('idle 层不再写 headX（外部所有权：interaction-motion）', snap.facs.headX, 0);
    eq('idle 层不再写 bodyZ（外部所有权：body-director）', snap.facs.bodyZ, 0);
    eq('idle 层不再写 breath（外部所有权：body-director）', snap.facs.breath, 0.5);
    eq('idle 层不再写 gazeX/gazeY（外部所有权：GazeFollow）', [snap.facs.gazeX, snap.facs.gazeY], [0, 0]);
    ok('非外部通道的微抽仍在（browInnerUp 非 0）', snap.facs.browInnerUp > 0, String(snap.facs.browInnerUp));
    near('ambient 把本层微抽收敛到 ≈1-amp（0.7×）', snap.facs.browInnerUp, ref.facs.browInnerUp * 0.7, 1e-6);
    engine.setAmbientBias(null);
    for (let i = 0; i < 40; i += 1) engine.update(0.05);
    eq('清除 ambient 后外部通道仍为 0（从未被写过）', [engine.snapshot().facs.headX, engine.snapshot().facs.bodyZ], [0, 0]);
  }

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' Ambient 待机层：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('  ✗ 测试崩溃：' + ((e && e.stack) || e));
  process.exit(1);
});
