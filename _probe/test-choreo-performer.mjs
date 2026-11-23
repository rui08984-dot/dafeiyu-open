#!/usr/bin/env node
/**
 * _probe/test-choreo-performer.mjs —— 表演库 v2：离线编译产物 + 播放器（2026-11-15）
 *
 * 两层验：
 *   ① 产物（choreo-performances.json，Python 离线编译）：结构完整、参数合法、
 *      **绝不写物理输出**（作者物理控制，写了也会被覆盖）、时间单调、值在模型范围内。
 *   ② 播放器（choreo-performer.mjs，纯函数）：权重包络、加法/覆盖两条道、
 *      说话时嘴让权、手势只触发一次、表情区间、结束收尾。
 *
 * 不加载模型、不碰窗口。
 */
'use strict';

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DESK = path.join(ROOT, 'pet-runtime', 'desktop');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const ANGLE_SET = new Set(['AngleX', 'AngleY', 'AngleZ', 'PositionX', 'PositionY', 'PositionZ', 'LeanInput']);

(async () => {
  // ── ① 产物 ───────────────────────────────────────────────────────────────
  const data = (await import(pathToFileURL(path.join(DESK, 'choreo-performances.mjs')).href)).default;
  const cdi = readJson(path.join(DESK, 'assets', 'jellyfish', 'pet.cdi3.json'));
  const phys = readJson(path.join(DESK, 'assets', 'jellyfish', 'pet.physics3.json'));
  const paramIds = new Set(cdi.Parameters.map((p) => p.Id));
  const paramRange = new Map(cdi.Parameters.map((p) => [p.Id, [p.Min, p.Max]]));
  const physOut = new Set();
  for (const s of phys.PhysicsSettings) for (const o of s.Output) physOut.add(o.Destination.Id);

  const keys = Object.keys(data.performances || {});
  ok('产物含 15 段表演', keys.length === 15, '实际 ' + keys.length);

  let totalTracks = 0;
  let badPhys = 0;
  let badMissing = 0;
  let badChannel = 0;
  let badNonMono = 0;
  let badRange = 0;
  let badNaN = 0;
  let badPoints = 0;
  for (const k of keys) {
    const p = data.performances[k];
    if (!(Number(p.duration) > 0)) { ok(`${k} duration 有效`, false, String(p.duration)); }
    if (!Array.isArray(p.tracks) || !p.tracks.length) { ok(`${k} 有轨道`, false); }
    for (const tr of p.tracks) {
      totalTracks += 1;
      if (physOut.has(tr.id)) badPhys += 1;
      if (!paramIds.has(tr.id)) badMissing += 1;
      if (tr.channel !== 'angle' && tr.channel !== 'override') badChannel += 1;
      if (tr.channel === 'angle' && !ANGLE_SET.has(tr.id)) badChannel += 1;
      if (!Array.isArray(tr.points) || tr.points.length < 2) badPoints += 1;
      const rng = paramRange.get(tr.id);
      for (let i = 0; i < (tr.points || []).length; i += 1) {
        const [t, v] = tr.points[i];
        if (!Number.isFinite(t) || !Number.isFinite(v)) badNaN += 1;
        if (i > 0 && t < tr.points[i - 1][0]) badNonMono += 1;
        if (rng && (v < rng[0] - 1e-6 || v > rng[1] + 1e-6)) badRange += 1;
      }
    }
  }
  ok('没有任何轨道写物理输出参数', badPhys === 0, badPhys + ' 处');
  ok('所有轨道参数都存在于模型', badMissing === 0, badMissing + ' 处');
  ok('通道分类合法（angle⊆7 角度参数，其余 override）', badChannel === 0, badChannel + ' 处');
  ok('每条轨道至少 2 个采样点', badPoints === 0, badPoints + ' 处');
  ok('采样点无 NaN/Infinity', badNaN === 0, badNaN + ' 处');
  ok('采样点时间单调递增', badNonMono === 0, badNonMono + ' 处');
  ok('采样值都在模型 min/max 内', badRange === 0, badRange + ' 处');
  ok('meta.stats 与实际轨道数一致', Number(data.meta?.stats?.tracks) === totalTracks,
    `${data.meta?.stats?.tracks} vs ${totalTracks}`);

  const dropped = data.meta?.stats?.droppedTracks || {};
  ok('手势轨道已让给 playMotion（122 轨）', Number(dropped['native-gesture']) === 122, String(dropped['native-gesture']));
  ok('表情轨道已让给 exp3（34 轨）', Number(dropped.expression) === 34, String(dropped.expression));

  // 每段都要有可播的东西：轨道、表情、手势至少占一样
  let emptyPerf = 0;
  for (const k of keys) {
    const p = data.performances[k];
    if (!p.tracks.length && !p.expressionSteps.length && !p.gestureSteps.length) emptyPerf += 1;
  }
  ok('没有空表演', emptyPerf === 0, emptyPerf + ' 段');

  // gestureSteps 都带原生组名映射所需的名字 + 进出时长
  let badGesture = 0;
  for (const k of keys) {
    for (const g of data.performances[k].gestureSteps || []) {
      if (!g.name || !Number.isFinite(g.enterDuration) || !Number.isFinite(g.exitAt)) badGesture += 1;
    }
  }
  ok('手势步骤带名字与进出时长', badGesture === 0, badGesture + ' 处');

  // ── ② 播放器 ─────────────────────────────────────────────────────────────
  const mod = await import(pathToFileURL(path.join(DESK, 'choreo-performer.mjs')).href);
  ok('PLAYBACK_KEYS 覆盖全部', mod.PERFORMANCE_KEYS.length === 15, String(mod.PERFORMANCE_KEYS.length));
  ok('手势映射覆盖三种', Object.keys(mod.GESTURE_GROUP).length === 3);
  ok('手势映射同时带动作组与资产名', Object.values(mod.GESTURE_GROUP).every((g) => g && g.group && g.asset),
    JSON.stringify(Object.values(mod.GESTURE_GROUP)));

  // 包络：进 0 → 中 1 → 出 0
  ok('包络起点为 0', mod.performanceEnvelope(0, 20) === 0);
  const midW = mod.performanceEnvelope(10, 20);
  ok('包络中段为 1', Math.abs(midW - 1) < 1e-9, String(midW));
  ok('包络终点为 0', mod.performanceEnvelope(20, 20) === 0);

  // 关键帧采样：端点 + 中点缓动
  const pts = [[0, 0], [1, 10], [2, 0]];
  ok('samplePoints 首值', mod.samplePoints(pts, 0) === 0);
  ok('samplePoints 中值', mod.samplePoints(pts, 1) === 10);
  ok('samplePoints 末值', mod.samplePoints(pts, 2) === 0);
  ok('samplePoints 区间内单调缓动', mod.samplePoints(pts, 0.5) > 0 && mod.samplePoints(pts, 0.5) < 10);
  ok('samplePoints 空轨道返回 0', mod.samplePoints([], 0.5) === 0);

  // 播放器时序（用假时钟，不依赖真实 performance.now）
  const key = keys.find((k) => data.performances[k].gestureSteps.length && data.performances[k].expressionSteps.length)
    || keys[0];
  const perf = data.performances[key];
  const player = mod.createPerformer();
  ok('未知表演 start 返回 false', player.start('不存在的一段', 0) === false);
  ok('已知表演 start 返回 true', player.start(key, 1000) === true);
  ok('start 后 active', player.active === true && player.key === key);

  const at0 = player.sample(1000, {});           // t=0，包络为 0
  ok('t=0 艺术家还没起势（加法为空或近 0）',
    !at0 || Object.keys(at0.additive || {}).length === 0, JSON.stringify(at0 && Object.keys(at0.additive || {})));

  const atMid = player.sample(1000 + Math.min(6, perf.duration / 2) * 1000, {});  // 中段权重=1
  ok('中段有覆盖值或加法值', !!atMid && (Object.keys(atMid.override).length > 0 || Object.keys(atMid.additive).length > 0));
  ok('中段覆盖权重为 1', Math.abs(atMid.overrideW - 1) < 1e-9, String(atMid.overrideW));

  // override 是绝对值（不乘 weight），additive 是乘过 weight 的偏移
  // 注意：同一参数在一个动作槽里会切成多条轨道（如 ParamEyeBallX 在 0-4s 与 4.5-7.5s 各一条），
  // 要按「本帧活跃的那条」比对，不能只 find 第一条。
  let overrideMatchesProduct = true;
  let overrideChecked = 0;
  for (const pid of Object.keys(atMid.override)) {
    const active = perf.tracks.filter((t) => t.id === pid && t.channel === 'override'
      && atMid.t >= t.start && atMid.t <= t.start + t.duration);
    if (!active.length) { overrideMatchesProduct = false; break; }
    const expect = mod.samplePoints(active[0].points, atMid.t - active[0].start);
    if (Math.abs(expect - atMid.override[pid]) > 1e-6) { overrideMatchesProduct = false; break; }
    overrideChecked += 1;
  }
  ok('override 是产物绝对值（未被权重缩放）', overrideMatchesProduct && overrideChecked > 0,
    overrideChecked + ' 个参数逐个比对');

  // 说话让权：挑一个「嘴参数确实在演」的时刻（不能随便取中点，那时可能只有眼神轨道）
  const mouthIds = ['ParamMouthOpenY', 'ParamMouthForm'];
  const mouthTrack = perf.tracks.find((t) => t.channel === 'override' && mouthIds.includes(t.id)
    && t.start > 0.5 && t.start + t.duration < perf.duration - 0.8);
  ok('该段确有嘴参数轨道可测', !!mouthTrack, mouthTrack ? `${mouthTrack.id} ${mouthTrack.start}-${mouthTrack.start + mouthTrack.duration}s` : '无');
  const tMouth = mouthTrack ? mouthTrack.start + mouthTrack.duration / 2 : 1;
  const p2 = mod.createPerformer();
  p2.start(key, 0);
  const quiet = p2.sample(tMouth * 1000, { speaking: false });
  const speaking = p2.sample(tMouth * 1000, { speaking: true });
  const quietHasMouth = quiet && mouthIds.some((id) => id in quiet.override);
  const speakingHasMouth = speaking && mouthIds.some((id) => id in speaking.override);
  ok('不说话时嘴参数可由表演驱动', quietHasMouth === true);
  ok('说话时嘴参数让给语音', speakingHasMouth === false);

  // 手势：进入/收回各一次，不重复
  const p3 = mod.createPerformer();
  p3.start(key, 0);
  const g = (perf.gestureSteps || [])[0];
  const before = p3.sample(Math.max(0, g.start * 1000 - 200), {});
  const atEnter = p3.sample((g.start + 0.02) * 1000, {});
  const againEnter = p3.sample((g.start + 0.10) * 1000, {});
  const atExit = p3.sample((g.exitAt + 0.02) * 1000, {});
  const againExit = p3.sample((g.exitAt + 0.10) * 1000, {});
  ok('手势未开始前不触发', !!before && before.gestures.length === 0);
  ok('手势进入触发一次', !!atEnter && atEnter.gestures.length === 1 && atEnter.gestures[0].index === 0);
  ok('手势进入不重复触发', !!againEnter && againEnter.gestures.length === 0);
  ok('手势收回触发一次', !!atExit && atExit.gestures.length === 1 && atExit.gestures[0].index === 1);
  ok('手势收回不重复触发', !!againExit && againExit.gestures.length === 0);

  // 表情：区间内给出名字，区间外不给
  const es = (perf.expressionSteps || [])[0];
  const p4 = mod.createPerformer();
  p4.start(key, 0);
  const inExpr = p4.sample((es.start + es.duration / 2) * 1000, {});
  ok('表情区间内锁脸', !!inExpr && inExpr.expression === es.name, String(inExpr && inExpr.expression));
  const outExpr = p4.sample(Math.max(0, (es.start - 0.5)) * 1000, {});
  ok('表情区间外不锁脸', !!outExpr && outExpr.expression !== es.name, String(outExpr && outExpr.expression));

  // 收尾：超过 duration+0.4 必须失效
  const p5 = mod.createPerformer();
  p5.start(key, 0);
  const done = p5.sample((perf.duration + 0.5) * 1000, {});
  ok('超过时长返回 null', done === null);
  ok('自动结束后 active=false', p5.active === false);

  ok('stop() 立即失效', (() => { const p = mod.createPerformer(); p.start(key, 0); p.stop(); return p.sample(1000, {}) === null && p.active === false; })());
  ok('list() 带标题与时长', (() => { const l = player.list(); return l.length === 15 && l.every((x) => x.title && x.duration > 0); })());


  // ── v3（2026-11-16）：平滑 / 融合 / 生命层 ──────────────────────────────
  // ① PCHIP：关键帧处速度不再归零（smoothstep 会归零 → 走走停停）
  const ramp = [[0, 0], [1, 10], [2, 20]];
  const dLeft = (mod.samplePoints(ramp, 1) - mod.samplePoints(ramp, 0.98)) / 0.02;
  const dRight = (mod.samplePoints(ramp, 1.02) - mod.samplePoints(ramp, 1)) / 0.02;
  ok('PCHIP 关键帧速度不归零（左右都 >1 单位/秒）', dLeft > 1 && dRight > 1, `${dLeft.toFixed(2)} / ${dRight.toFixed(2)}`);
  ok('PCHIP 不过冲（区间内值不超出端点）', (() => {
    for (let t = 0; t <= 2; t += 0.05) { const v = mod.samplePoints(ramp, t); if (v < -1e-6 || v > 20 + 1e-6) return false; }
    return true;
  })());

  // ② 尾段拉长：原时长结束点不再是「已归零」，相邻动作能叠上
  const angleRelease = Object.values(data.performances)
    .flatMap((p) => p.tracks)
    .find((t) => t.channel === 'angle' && t.points.length >= 4 && Math.abs(t.points.at(-1)[1]) < 1e-9
      && Math.abs(t.points.at(-2)[1]) > 1);
  ok('找到带回落的角轨', !!angleRelease, angleRelease ? angleRelease.id : '无');
  if (angleRelease) {
    const pk = Object.keys(data.performances).find((k) => data.performances[k].tracks.includes(angleRelease));
    const pr = mod.createPerformer();
    pr.start(pk, 0);
    const atOldEnd = pr.sample((angleRelease.start + angleRelease.duration - 0.02) * 1000, {});
    const v = atOldEnd && atOldEnd.additive[angleRelease.id];
    ok('尾段拉长：原结束时刻仍有回落值（>1%）', Math.abs(Number(v) || 0) > Math.abs(angleRelease.points.at(-2)[1]) * 0.01,
      String(v));
  }

  // ③ 同帧多表情：04 的「＞＜+脸红」、13 的「裙子+眼镜」不能只给第一张
  const multi = mod.createPerformer();
  multi.start('13-form-performance', 0);
  const atT2 = multi.sample(2500, {});
  ok('同帧多表情（13：裙子切换 + 黑框眼镜）', !!atT2 && atT2.expressions.length >= 2
    && atT2.expressions.includes('裙子切换') && atT2.expressions.includes('黑框眼镜'),
    atT2 ? atT2.expressions.join('+') : 'null');
  const multi2 = mod.createPerformer();
  multi2.start('04-playful', 0);
  const atT12 = multi2.sample(12500, {});
  ok('同帧多表情（04：＞＜ + 脸红）', !!atT12 && atT12.expressions.length >= 2,
    atT12 ? atT12.expressions.join('+') : 'null');

  // ④ 生命层：保持姿势时仍有极小连续漂移（<1.5°），且随时间变化
  const pl = mod.createPerformer();
  pl.start('05-weight-shift', 0);
  const l1 = pl.sample(6000, {});
  const l2 = pl.sample(6800, {});
  ok('生命层有微小漂移（AngleX 存在且 <1.5）', !!l1 && Math.abs(l1.additive.AngleX || 0) < 1.5 && Math.abs(l1.additive.AngleX || 0) > 1e-4,
    String(l1 && l1.additive.AngleX));
  ok('生命层随时间变化', !!l1 && !!l2 && Math.abs((l1.additive.AngleX || 0) - (l2.additive.AngleX || 0)) > 1e-4,
    `${l1 && l1.additive.AngleX} → ${l2 && l2.additive.AngleX}`);

  // 采样性能：最长一段全时间轴扫一遍的耗时（每帧预算 16.7ms，这里只要 < 1ms）
  const worst = keys.reduce((a, b) => (data.performances[a].tracks.length >= data.performances[b].tracks.length ? a : b));
  const pw = mod.createPerformer();
  pw.start(worst, 0);
  const N = 300;
  const t0 = performance.now();
  for (let i = 0; i < N; i += 1) pw.sample((i * data.performances[worst].duration * 1000) / N, {});
  const perFrame = (performance.now() - t0) / N;
  ok('单帧采样 < 1ms', perFrame < 1, perFrame.toFixed(4) + 'ms（' + data.performances[worst].tracks.length + ' 轨）');

  console.log('');
  console.log(`  表演库 v2：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('测试本身出错：', e);
  process.exit(2);
});
