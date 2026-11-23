#!/usr/bin/env node
/**
 * _probe/test-choreo-tune.cjs —— D6 导演改戏（2026-11-22）
 *
 * 验收目标（提案原文）：
 *   · performance-log → 按片段/情绪统计被接率 → {segmentMultiplier, cooldownMultiplier}；
 *   · 倍率夹 [0.5, 2]；样本 < 20 不动；
 *   · 若调整会让日均播放比上周降 >20% → 整体回退 1.0 并记 reverted；
 *   · 开关 data/导演调参.json {"enabled": false} 一键关；
 *   · 消费方只在冷却/优先级处乘倍率（choreo-auto + facs-clip-director）。
 *
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const iso = require('./lib/test-isolation.cjs');

const TMP = iso.setUpTempDataRoot('pet-choreo-tune-');
const ROOT = path.join(TMP, 'data');
fs.mkdirSync(ROOT, { recursive: true });

const TUNE = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'choreo-tune.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 0, 1); // 固定时钟
const PET = path.join(__dirname, '..', 'pet-runtime', 'desktop');

function play(recs, ts, clipId, label, emotion, extra) {
  recs.push(Object.assign({
    ts, kind: 'play', clipId, label, emotion,
    source: 'peak', intensity: 0.9, busy: false, speaking: false, activity: '', reason: 'ok',
  }, extra || {}));
}
function after(recs, ts, clipId, label, emotion, ms) {
  recs.push({ ts, kind: 'user_input_after', clipId, label, emotion, ms: ms || 1000 });
}
function writeJsonl(file, recs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/** 20 次高接话 + 20 次零接话 + 19 次（样本不足）的固定语料 */
function baseCorpus(now) {
  const recs = [];
  for (let i = 0; i < 20; i += 1) {
    const ts = T0 + i * MIN;
    play(recs, ts, 'clip-hi', '开心笑', 'happy');
    after(recs, ts + 1000, 'clip-hi', '开心笑', 'happy');
  }
  for (let i = 0; i < 20; i += 1) {
    play(recs, T0 + 2 * HOUR + i * MIN, 'clip-lo', '自然放松', 'sleepy');
  }
  for (let i = 0; i < 19; i += 1) {
    const ts = T0 + 4 * HOUR + i * MIN;
    play(recs, ts, 'clip-few', '思考专注', 'neutral');
    after(recs, ts + 1000, 'clip-few', '思考专注', 'neutral');
  }
  return recs;
}

(async () => {
  // ── ① 日志解析 / 配对 / 观察窗 ────────────────────────────────────────
  const parsed = TUNE.parseLines('{"kind":"play","ts":1,"clipId":"a"}\n坏行\n\n{"kind":"skip","ts":2,"reason":"cooldown"}\n');
  ok('坏行跳过、合法行保留', parsed.records.length === 2 && parsed.bad === 1,
    `records=${parsed.records.length} bad=${parsed.bad}`);

  const pairRecs = [
    { ts: 1000, kind: 'play', clipId: 'x' },
    { ts: 2000, kind: 'user_input_after', clipId: 'x', ms: 1000 },
    { ts: 3000, kind: 'play', clipId: 'y' },
    { ts: 3000 + 91 * 1000, kind: 'user_input_after', clipId: 'y', ms: 91000 },
    { ts: 200000, kind: 'play', clipId: 'z' },
    { ts: 200500, kind: 'user_input_after', clipId: 'other', ms: 500 },
  ];
  const pairs = TUNE.pairPlays(pairRecs);
  ok('90 秒内同 clip 才配对', pairs[0].after && pairs[0].after.ts === 2000);
  ok('超过 90 秒/不同 clip 不配对', !pairs[1].after && !pairs[2].after,
    JSON.stringify(pairs.map((p) => Boolean(p.after))));

  const recentCorpus = [
    { ts: 100000, kind: 'play', clipId: 'r', label: 'R', emotion: 'happy' },
  ];
  const recentGroups = TUNE.groupPlays(TUNE.pairPlays(recentCorpus), {}, 100000 + 10 * 1000);
  ok('观察窗未满的播放不算样本', recentGroups.eligible === 0, JSON.stringify({ eligible: recentGroups.eligible }));

  // ── ② 倍率：高接话 ↑、零接话 ↓、样本不足不动、夹 [0.5,2] ──────────────
  const now = T0 + 30 * DAY;
  const tuning = TUNE.computeTuning(baseCorpus(now), { now });
  const segHi = tuning.segmentMultiplier['clip-hi'];
  const segLo = tuning.segmentMultiplier['clip-lo'];
  const cdHi = tuning.cooldownMultiplier['clip-hi'];
  const cdLo = tuning.cooldownMultiplier['clip-lo'];
  ok('高接话片段优先级 >1、冷却 <1', segHi > 1 && cdHi < 1,
    `priority=${segHi} cooldown=${cdHi}`);
  ok('零接话片段优先级 <1、冷却 >1', segLo < 1 && cdLo > 1,
    `priority=${segLo} cooldown=${cdLo}`);
  ok('样本 19 次不调（缺省 =1）', !('clip-few' in tuning.segmentMultiplier)
    && !('思考专注' in tuning.segmentMultiplier), JSON.stringify(Object.keys(tuning.segmentMultiplier)));
  const allMults = [...Object.values(tuning.segmentMultiplier), ...Object.values(tuning.cooldownMultiplier)];
  ok('所有倍率夹在 [0.5, 2]', allMults.length > 0 && allMults.every((m) => m >= 0.5 && m <= 2),
    allMults.map((m) => m.toFixed(3)).join(','));
  ok('按情绪也出了倍率（happy ↑ / sleepy ↓）',
    tuning.segmentMultiplier.happy > 1 && tuning.segmentMultiplier.sleepy < 1,
    `happy=${tuning.segmentMultiplier.happy} sleepy=${tuning.segmentMultiplier.sleepy}`);
  ok('按 label 也出了倍率（开心笑 ↑ / 自然放松 ↓）',
    tuning.segmentMultiplier['开心笑'] > 1 && tuning.segmentMultiplier['自然放松'] < 1);

  // 配置把 baselineFloor 写成 0 也不能除出 NaN/Infinity
  const zeroFloor = TUNE.computeTuning(baseCorpus(now), { now, baselineFloor: 0 });
  const zeroMults = [...Object.values(zeroFloor.segmentMultiplier), ...Object.values(zeroFloor.cooldownMultiplier)];
  ok('baselineFloor=0 时倍率仍是有限数', zeroMults.length > 0 && zeroMults.every((m) => Number.isFinite(m) && m >= 0.5 && m <= 2),
    zeroMults.join(','));

  // manual（用户点名演的）不参与学习：用户接话不能证明导演选得对
  const manualRecs = [];
  for (let i = 0; i < 20; i += 1) {
    const ts = T0 + i * MIN;
    play(manualRecs, ts, 'clip-manual', 'M', 'happy', { source: 'manual' });
    after(manualRecs, ts + 1000, 'clip-manual', 'M', 'happy');
  }
  const manualTuning = TUNE.computeTuning(manualRecs, { now });
  ok('manual 播放不计入学习样本',
    manualTuning.meta.manualExcluded === 20 && manualTuning.meta.eligiblePlays === 0
      && Object.keys(manualTuning.segmentMultiplier).length === 0,
    JSON.stringify({ manualExcluded: manualTuning.meta.manualExcluded, eligible: manualTuning.meta.eligiblePlays }));

  // ── ③ 保护闸：降太多 → 整体回退 1.0 ──────────────────────────────────
  const gateNow = T0 + 14 * DAY;
  const dropRecs = [];
  for (let i = 0; i < 20; i += 1) play(dropRecs, gateNow - 10 * DAY + i * MIN, 'clip-x', '自然放松', 'sleepy');
  for (let i = 0; i < 20; i += 1) play(dropRecs, gateNow - 3 * DAY + i * MIN, 'clip-x', '自然放松', 'sleepy');
  const dropped = TUNE.computeTuning(dropRecs, { now: gateNow });
  ok('预计日均降 >20% → 记 would_drop_too_much', dropped.reverted === 'would_drop_too_much' && dropped.meta.reverted === 'would_drop_too_much',
    JSON.stringify(dropped.meta.gate));
  ok('回退后输出表为空（消费方按 1.0）',
    Object.keys(dropped.segmentMultiplier).length === 0 && Object.keys(dropped.cooldownMultiplier).length === 0);
  ok('回退保留 proposed 供复盘', dropped.meta.proposed
    && dropped.meta.proposed.cooldownMultiplier['clip-x'] === 2,
    JSON.stringify(dropped.meta.proposed && dropped.meta.proposed.cooldownMultiplier));

  // 温和调整不触发回退
  const mildRecs = [];
  for (let i = 0; i < 20; i += 1) {
    const ts = gateNow - 10 * DAY + i * MIN;
    play(mildRecs, ts, 'clip-a', 'A', 'happy');
    if (i < 5) after(mildRecs, ts + 1000, 'clip-a', 'A', 'happy');
  }
  for (let i = 0; i < 20; i += 1) {
    const ts = gateNow - 3 * DAY + i * MIN;
    play(mildRecs, ts, 'clip-a', 'A', 'happy');
    if (i < 5) after(mildRecs, ts + 1000, 'clip-a', 'A', 'happy');
  }
  for (let i = 0; i < 20; i += 1) {
    const ts = gateNow - 3 * DAY + 3 * HOUR + i * MIN;
    play(mildRecs, ts, 'clip-b', 'B', 'sad');
    if (i < 4) after(mildRecs, ts + 1000, 'clip-b', 'B', 'sad');
  }
  const mild = TUNE.computeTuning(mildRecs, { now: gateNow });
  ok('温和调整不触发回退', mild.reverted === null && mild.meta.reverted === null
    && Object.keys(mild.segmentMultiplier).length > 0,
    JSON.stringify({ reverted: mild.meta.reverted, gate: mild.meta.gate, keys: Object.keys(mild.segmentMultiplier) }));

  // 没有上周基线 → 用「当前日均」兜底，仍然拦住 >20% 降幅（保守优先）
  const noBaseRecs = [];
  for (let i = 0; i < 20; i += 1) play(noBaseRecs, gateNow - 3 * DAY + i * MIN, 'clip-n', 'N', 'happy');
  const noBaseline = TUNE.computeTuning(noBaseRecs, { now: gateNow });
  ok('没有上周 → 当前日均兜底，仍拦 >20% 降幅',
    noBaseline.reverted === 'would_drop_too_much'
      && noBaseline.meta.reverted === 'would_drop_too_much'
      && noBaseline.meta.gate.baseline === 'current_proxy',
    JSON.stringify(noBaseline.meta.gate));

  // 兜底基线不误拦「调整不会明显降播放」的情况
  const proxyOkRecs = [];
  for (let i = 0; i < 20; i += 1) {
    const ts = gateNow - 3 * DAY + i * MIN;
    play(proxyOkRecs, ts, 'clip-p', 'P', 'happy');
    if (i < 10) after(proxyOkRecs, ts + 1000, 'clip-p', 'P', 'happy');
  }
  for (let i = 0; i < 20; i += 1) {
    const ts = gateNow - 3 * DAY + HOUR + i * MIN;
    play(proxyOkRecs, ts, 'clip-q', 'Q', 'sad');
    if (i < 8) after(proxyOkRecs, ts + 1000, 'clip-q', 'Q', 'sad');
  }
  const proxyOk = TUNE.computeTuning(proxyOkRecs, { now: gateNow });
  ok('兜底基线不误拦温和调整', proxyOk.reverted === null && proxyOk.meta.reverted === null
    && proxyOk.meta.gate.reason === 'current_proxy_ok'
    && Object.keys(proxyOk.segmentMultiplier).length > 0,
    JSON.stringify(proxyOk.meta.gate));

  // ── ④ 开关：data/导演调参.json {"enabled": false} ─────────────────
  const logFile = path.join(TMP, 'performance-log.jsonl');
  writeJsonl(logFile, baseCorpus(now));
  const configFile = path.join(ROOT, TUNE.CONFIG_NAME);
  iso.assertIsolated(logFile);
  iso.assertIsolated(configFile);
  fs.writeFileSync(configFile, JSON.stringify({ enabled: false }), 'utf8');
  TUNE._clearCache();
  const disabled = TUNE.loadTuning({ file: logFile, configFile, now, noCache: true });
  ok('开关 enabled:false → 关闭且空表',
    disabled.enabled === false && Object.keys(disabled.segmentMultiplier).length === 0,
    JSON.stringify({ enabled: disabled.enabled, reason: disabled.meta.reason }));

  fs.writeFileSync(configFile, JSON.stringify({ enabled: true, sampleMin: 20 }), 'utf8');
  TUNE._clearCache();
  const enabled = TUNE.loadTuning({ file: logFile, configFile, now, noCache: true });
  ok('开关 enabled:true → 正常算倍率',
    enabled.enabled === true && enabled.segmentMultiplier['clip-hi'] > 1,
    JSON.stringify(enabled.segmentMultiplier));
  ok('findConfigFile 跟随 PET_DATA_ROOT', TUNE.findConfigFile() === configFile,
    TUNE.findConfigFile());

  // ── ⑤ 消费方接线：choreo-auto 只在冷却/优先级乘倍率 ─────────────────
  const AUTO = await import(pathToFileURL(path.join(PET, 'choreo-auto.mjs')).href);
  const allHappy = { '04-playful': 100 * MIN - 9 * MIN, '15-flirt-layered': 100 * MIN - 9 * MIN, '03-pride': 100 * MIN - 9 * MIN };
  const noTune = AUTO.decidePerformance({ emotion: 'happy', strength: 1, now: 100 * MIN, lastAt: 0, lastByKey: allHappy });
  const withCd = AUTO.decidePerformance({
    emotion: 'happy', strength: 1, now: 100 * MIN, lastAt: 0, lastByKey: allHappy,
    tuning: { cooldownMultiplier: { '04-playful': 2, '15-flirt-layered': 2, '03-pride': 2 } },
  });
  ok('冷却倍率 2 把 9 分钟挡在 12 分钟门外',
    noTune.play === true && withCd.play === false && withCd.reason === 'key-cooldown',
    JSON.stringify({ noTune, withCd }));

  const priorityBase = { '04-playful': 100 * MIN - 15 * MIN, '15-flirt-layered': 100 * MIN - 12 * MIN, '03-pride': 100 * MIN - 9 * MIN };
  const pickNoTune = AUTO.decidePerformance({ emotion: 'happy', strength: 1, now: 100 * MIN, lastAt: 0, lastByKey: priorityBase });
  const pickTuned = AUTO.decidePerformance({
    emotion: 'happy', strength: 1, now: 100 * MIN, lastAt: 0, lastByKey: priorityBase,
    tuning: { segmentMultiplier: { '03-pride': 2 } },
  });
  ok('优先级倍率把「较新的段」提到最前',
    pickNoTune.key === '04-playful' && pickTuned.key === '03-pride',
    `${pickNoTune.key} → ${pickTuned.key}`);

  // 状态机的 tuningProvider 生效（空闲全池 9 分钟，倍率 2 → 全被 12 分钟挡住）
  let providerTuning = null;
  const trigger = AUTO.createAutoTrigger({ tuningProvider: () => providerTuning });
  for (const key of [...AUTO.IDLE_PERFORMANCES, ...AUTO.RARE_PERFORMANCES]) trigger.note(key, 100 * MIN - 9 * MIN);
  providerTuning = { cooldownMultiplier: Object.fromEntries([...AUTO.IDLE_PERFORMANCES, ...AUTO.RARE_PERFORMANCES].map((k) => [k, 2])) };
  const blockedIdle = trigger.considerIdle({ now: 100 * MIN, idleMs: 10 * MIN, rand: 0, rand2: 0.5 });
  providerTuning = {};
  const allowedIdle = trigger.considerIdle({ now: 100 * MIN, idleMs: 10 * MIN, rand: 0, rand2: 0.5 });
  ok('tuningProvider 动态生效（挡 / 放）',
    blockedIdle.play === false && blockedIdle.reason === 'key-cooldown' && allowedIdle.play === true,
    JSON.stringify({ blockedIdle, allowedIdle }));

  // ── ⑥ 消费方接线：facs-clip-director 的同段冷却/优先级 ────────────────
  const DIR = await import(pathToFileURL(path.join(PET, 'perf', 'facs-clip-director.mjs')).href);
  const oneIndex = { clips: [{ id: 'c1', label: '微笑', emotion: 'happy', energy: 300, durationMs: 1000 }] };
  const dirOpts = { gapMs: 0, maxPer10Min: 99, weakBelow: 0, minEnergy: 0, sameClipMs: 60 * 1000 };
  const dirTuned = DIR.createClipDirector(oneIndex, Object.assign({}, dirOpts, {
    tuning: { cooldownMultiplier: { c1: 2 } },
  }));
  dirTuned.notePlayed('c1', 1000);
  const dirBlocked = dirTuned.decide({ emotion: 'happy', intensity: 1, nowMs: 1000 + 90 * 1000 });
  const dirPlain = DIR.createClipDirector(oneIndex, dirOpts);
  dirPlain.notePlayed('c1', 1000);
  const dirAllowed = dirPlain.decide({ emotion: 'happy', intensity: 1, nowMs: 1000 + 90 * 1000 });
  ok('FACS 导演同段冷却 × 倍率（90s：2× 挡、1× 放）',
    dirBlocked.reason === 'no-candidate' && dirAllowed.clipId === 'c1',
    JSON.stringify({ blocked: dirBlocked.reason, allowed: dirAllowed.reason }));

  const twoIndex = { clips: [
    { id: 'p1', label: '微笑', emotion: 'happy', energy: 300, durationMs: 1000 },
    { id: 'p2', label: '大眼微笑', emotion: 'happy', energy: 300, durationMs: 1000 },
  ] };
  const dirPriorityPlain = DIR.createClipDirector(twoIndex, dirOpts);
  const plainPick = dirPriorityPlain.decide({ emotion: 'happy', intensity: 1, nowMs: 1000 });
  const dirPriorityTuned = DIR.createClipDirector(twoIndex, Object.assign({}, dirOpts, {
    tuning: { segmentMultiplier: { 微笑: 0.5, 大眼微笑: 2 } },
  }));
  const tunedPick = dirPriorityTuned.decide({ emotion: 'happy', intensity: 1, nowMs: 1000 });
  ok('FACS 导演优先级 × 倍率（低优先级 label 可被提上来）',
    plainPick.label === '微笑' && tunedPick.label === '大眼微笑',
    `${plainPick.label} → ${tunedPick.label}`);

  iso.cleanup(TMP);
  console.log('\n  导演改戏：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e && e.stack || e);
  iso.cleanup(TMP);
  process.exit(2);
});
