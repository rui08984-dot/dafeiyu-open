#!/usr/bin/env node
/**
 * _probe/test-performance-arbitration.cjs —— 2026-11-21 P1/P2 回归门禁
 *
 * 纯 node + stub renderer，不启 Electron、不加载模型。钉住四件事：
 *   ① 单仲裁：同一帧「片段 trig」与「v2 perfEmo」同时就绪 → 只有一个 owner 拿到，
 *      另一个记 yield；片段播放中 v2 不启动、v2 播放中片段不启动；显式手动可抢占。
 *   ② 资产所有权：手动打开 落泪/脸红/流冷汗（key2/key7/key13）后，perf 写前跳过；
 *      关掉即交还。每层写入 ⊆ 声明所有权。
 *   ③ 面板数据：performanceStatus 的 t/duration 来自共享会话（假时钟推进后非零）。
 *   ④ 情绪增益：emotionGain=1.5 时 perf 输出参数确实大于 1.0（不再是空转）。
 *
 * 用法：node _probe/test-performance-arbitration.cjs
 * 退出码：0 全过 / 1 有失败。
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = process.env.PET_ARB_ROOT
  ? path.resolve(process.env.PET_ARB_ROOT)
  : path.resolve(__dirname, '..');
const DESKTOP = path.join(ROOT, 'pet-runtime', 'desktop');
const file = (p) => pathToFileURL(path.join(DESKTOP, p)).href;
const source = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');

let pass = 0;
let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const round = (v) => Math.round(Number(v) * 1000) / 1000;

// ── ① 单仲裁：同帧只有一个 owner ────────────────────────────────────────
test('同帧 trig+perfEmo 同时就绪：只有一个 owner，另一个记 yield', async () => {
  const { createPerformanceArbiter } = await import(file('perf/performance-arbiter.mjs'));
  let now = 10_000;
  const arb = createPerformanceArbiter({ now: () => now });

  // entry 的求值顺序：maybeTriggerFacsClip（片段）在 v2 自动启动之前。
  // 同一帧、时钟不动 —— 第一个拿到，第二个必须让位。
  const clip = arb.begin('clip', { key: 'lumen-1-害羞', title: '害羞', durationMs: 3000 });
  const v2 = arb.begin('v2', { key: '05', title: '换重心', durationMs: 22_000 });

  assert.strictEqual(clip.ok, true, '片段应拿到占用');
  assert.strictEqual(v2.ok, false, '同帧 v2 不得启动（两套表演同时写脸）');
  assert.strictEqual(v2.reason, 'busy');
  assert.strictEqual(v2.holder, 'clip');
  assert.strictEqual(arb.owner, 'clip', 'owner 必须只有 clip');
  const snap = arb.claim.snapshot();
  assert.strictEqual(snap.stats.yields.v2, 1, 'v2 必须记一次 yield');
  assert.strictEqual(snap.stats.conflicts, 1, '必须记一次冲突');
  assert.strictEqual(v2.token, null, '失败的申请不得产生 token');
  assert.strictEqual(arb.session.status().owner, 'clip', '播放会话也只能有 clip');
  return `owner=${arb.owner} yields=${JSON.stringify(snap.stats.yields)}`;
});

test('片段播放中 v2 不启动；v2 播放中片段不启动', async () => {
  const { createPerformanceArbiter } = await import(file('perf/performance-arbiter.mjs'));

  // A：片段先占 → v2 让位
  let now = 1_000;
  const a = createPerformanceArbiter({ now: () => now });
  a.begin('clip', { key: 'lumen-2', durationMs: 4000 });
  assert.strictEqual(a.availableFor('v2'), false, '片段占用时 v2 必须视为不可启动');
  assert.strictEqual(a.availableFor('clip'), true, '同层可刷新');
  const v2Blocked = a.begin('v2', { key: '06', durationMs: 20_000 });
  assert.strictEqual(v2Blocked.ok, false);
  assert.strictEqual(a.claim.snapshot().stats.yields.v2, 1);

  // 片段结束（按 token 释放）→ v2 可以启动
  a.end('clip', a.claim.token);
  assert.strictEqual(a.owner, null, '片段结束必须交还占用');
  const v2Ok = a.begin('v2', { key: '06', durationMs: 20_000 });
  assert.strictEqual(v2Ok.ok, true);

  // B：v2 先占 → 片段让位
  now = 5_000;
  const b = createPerformanceArbiter({ now: () => now });
  b.begin('v2', { key: '07', durationMs: 25_000 });
  assert.strictEqual(b.availableFor('clip'), false, 'v2 占用时片段必须视为不可启动');
  const clipBlocked = b.begin('clip', { key: 'lumen-3', durationMs: 3000 });
  assert.strictEqual(clipBlocked.ok, false);
  assert.strictEqual(clipBlocked.holder, 'v2');
  assert.strictEqual(b.claim.snapshot().stats.yields.clip, 1);
  assert.strictEqual(b.owner, 'v2', '片段让位后 owner 仍是 v2');

  // 显式手动优先级最高：可顶掉 v2
  const manual = b.begin('manual', { key: '04', durationMs: 30_000, preempt: true });
  assert.strictEqual(manual.ok, true, '显式手动应抢占长表演');
  assert.strictEqual(manual.preempted, 'v2');
  assert.strictEqual(b.claim.snapshot().stats.preempts, 1);

  // token 不匹配不得释放（防定时器误杀后来的占用）
  assert.strictEqual(b.end('manual', 'wrong-token'), false);
  assert.strictEqual(b.end('manual', manual.token), true);
  return 'clip↛v2 / v2↛clip；manual 可抢占';
});

test('仲裁接线：entry 的片段/长表演/场景/手动全部走共享 claim', () => {
  const entry = source('petbody-entry.mjs');
  assert.ok(/createPerformanceArbiter\(/.test(entry), 'entry 没有创建共享仲裁器');
  assert.ok(/function requestPerformance\(/.test(entry), 'entry 缺少统一的表演启动入口');
  assert.ok(/requestPerformance\(d\.key/.test(entry) && /requestPerformance\(di\.key/.test(entry) && /requestPerformance\(de\.key/.test(entry),
    'v2 三个自动触发点（说话/空闲/情绪到位）没有全部改走 requestPerformance');
  assert.ok(/perfArbiter\.availableFor\('v2'\)/.test(entry), 'v2 自动启动前没有查占用');
  assert.ok(/perfArbiter\.begin\('clip'/.test(entry), '片段 play() 没有 claim');
  assert.ok(/preempt: opts\.preempt === true/.test(entry), '片段 play() 没有区分自动/手动（手动应可顶掉 v2）');
  assert.ok(/play: \(idOrLabel, opts\) => play\(/.test(entry), '公开 clips.play 没有默认 preempt');
  assert.ok(/perfArbiter\.begin\('scenes'/.test(entry), 'SCENES 没有 claim');
  assert.ok(/owner: 'manual', preempt: true/.test(entry), '手动 playPerformance 没有 preempt claim');
  return 'clip/v2/scenes/manual 共用仲裁';
});

// ── ② 资产所有权：pin 后 perf 不覆盖 key2/7/13 ──────────────────────────
function makeRenderer(paramIds) {
  const indices = new Map(paramIds.map((id, i) => [id, i]));
  const defaults = paramIds.map(() => 0);
  const values = new Map();
  return {
    ready: true,
    defaults,
    parameterIndices: indices,
    written: [],
    setParameter(id, v) {
      values.set(id, v);
      this.written.push(id);
      const i = indices.get(id);
      if (i !== undefined) defaults[i] = v;
    },
    get(id) {
      if (values.has(id)) return values.get(id);
      const i = indices.get(id);
      return i !== undefined ? defaults[i] : 0;
    },
  };
}

test('资产 pin 后 perf 不覆盖 key2/7/13；关掉即交还', async () => {
  const { applyAsset, getPinnedAssetParams } = await import(file('asset-toggles.mjs'));
  const { writePerfParams, checkWriteSet, ASSET_PARAM_NAMES } = await import(file('perf/param-ownership.mjs'));

  const paramIds = ['key2', 'key7', 'key13', 'ParamMouthForm'];
  const renderer = makeRenderer(paramIds);

  for (const id of ['face-tears', 'face-blush', 'face-sweat']) {
    const st = applyAsset(renderer, id, true);
    assert.strictEqual(st.ok, true, id + ' 应能打开');
  }
  const pinned = getPinnedAssetParams(renderer);
  for (const p of ['key2', 'key7', 'key13']) assert.ok(pinned.has(p), '手动打开后 ' + p + ' 应归资产层');
  // 每层写入 ⊆ 声明所有权
  const assetAudit = checkWriteSet('asset-toggles', pinned);
  assert.strictEqual(assetAudit.ok, true, '资产 pin 出现声明表之外的参数：' + JSON.stringify(assetAudit.undeclared));
  assert.ok(Array.from(pinned).every((p) => ASSET_PARAM_NAMES.includes(p)), 'pin 集合必须 ⊆ ASSET_PARAM_NAMES');

  // 资产刚 pin 的值（1）；perf 本帧想写 key2=0.9/key7=0.9/key13=0.9 + 嘴
  const before = { key2: renderer.defaults[0], key7: renderer.defaults[1], key13: renderer.defaults[2] };
  const write = writePerfParams({
    params: { key2: 0.9, key7: 0.9, key13: 0.9, ParamMouthForm: 0.55 },
    indices: renderer.parameterIndices,
    defaults: renderer.defaults,
    pinned,
    drift: 0,
  });
  assert.deepStrictEqual(write.written, ['ParamMouthForm'], '只有非 pin 的参数允许写，实际：' + write.written.join(','));
  assert.deepStrictEqual(write.skippedPinned.sort(), ['key13', 'key2', 'key7']);
  assert.deepStrictEqual({ key2: renderer.defaults[0], key7: renderer.defaults[1], key13: renderer.defaults[2] }, before,
    'pin 参数在 defaults 里的值不得被 perf 覆盖');
  assert.strictEqual(round(renderer.defaults[3]), 0.55, '非 pin 参数应正常写入');

  // 关掉落泪 → key2 交还 perf（否则用户点一次再关，情绪泪永久失效）
  applyAsset(renderer, 'face-tears', false);
  assert.strictEqual(getPinnedAssetParams(renderer).has('key2'), false, '关掉资产后 key2 应交还');
  const write2 = writePerfParams({
    params: { key2: 0.8 }, indices: renderer.parameterIndices, defaults: renderer.defaults,
    pinned: getPinnedAssetParams(renderer), drift: 0,
  });
  assert.deepStrictEqual(write2.skippedPinned, [], '交还后 key2 不应再被跳过');
  assert.strictEqual(round(renderer.defaults[0]), 0.8);

  // entry 接线：写前必须取 pinned 并走 writePerfParams
  const entry = source('petbody-entry.mjs');
  assert.ok(/getPinnedAssetParams\(renderer\)/.test(entry), 'entry 没有读取资产 pin 集合');
  assert.ok(/writePerfParams\(/.test(entry), 'entry 没有用 writePerfParams 做写前过滤');
  assert.ok(/perfPinSkips/.test(entry), 'entry 没有记录 pin 跳过计数');
  return 'pinned=' + Array.from(pinned).sort().join(',') + '；跳过 ' + write.skippedPinned.length + ' 个';
});

test('perf 每帧写入 ⊆ 画像声明所有权', async () => {
  const { createPerfEngine } = await import(file('perf/index.mjs'));
  const { declaredParamsFor, checkWriteSet } = await import(file('perf/param-ownership.mjs'));

  const channels = {
    mouthSmile: [{ kind: 'param', id: 'ParamMouthForm', scale: 1, absolute: false, range: [-1, 1] }],
    browInnerUp: [{ kind: 'param', id: 'BrowInnerUp', scale: 1, absolute: false, range: [-1, 1] }],
    blush: [{ kind: 'param', id: 'key7', scale: 1, absolute: false, range: [0, 1] }],
    tear: [{ kind: 'param', id: 'key2', scale: 1, absolute: false, range: [0, 1] }],
    sweat: [{ kind: 'param', id: 'key13', scale: 1, absolute: false, range: [0, 1] }],
  };
  const profile = {
    modelId: 'test', channels, capabilities: {},
    usedParams: ['ParamMouthForm', 'BrowInnerUp', 'key7', 'key2', 'key13'],
    usedExpressions: [], degraded: [], dropped: [], version: 1,
  };
  const engine = createPerfEngine({ profile, baseline: { ParamMouthForm: 0, BrowInnerUp: 0, key7: 0, key2: 0, key13: 0 }, seed: 3 });
  const declared = declaredParamsFor('perf', { profile });
  const seen = new Set();
  for (const emotion of ['happy', 'sad', 'shy', 'angry', 'surprised', 'neutral']) {
    engine.setGate(1);
    engine.feed({ emotion, strength: 0.85, holdSeconds: 2 });
    for (let i = 0; i < 90; i += 1) {
      const out = engine.update(1 / 60);
      for (const id of Object.keys(out.params || {})) seen.add(id);
    }
  }
  assert.ok(seen.size > 0, '引擎应至少输出一个参数');
  const audit = checkWriteSet('perf', seen, { profile });
  assert.strictEqual(audit.ok, true, 'perf 写了未声明的参数：' + JSON.stringify(audit.undeclared));
  assert.ok(Array.from(seen).every((id) => declared.has(id)), '写入集合必须 ⊆ declaredParamsFor(profile)');
  assert.ok(declared.has('key2') && declared.has('key7') && declared.has('key13'), '共享 key 参数应在画像声明里');
  return 'seen=' + seen.size + ' undeclared=0';
});

test('宿主换装 UI 直接写 defaults 也能被识别为 pin（不用改 live-2d）', async () => {
  const { detectExternalPins, writePerfParams } = await import(file('perf/param-ownership.mjs'));
  const ids = ['key2', 'key7', 'key13', 'ParamMouthForm'];
  const renderer = makeRenderer(ids);
  const pinned = new Set();
  const ledger = new Map();
  const candidates = ['key2', 'key7', 'key13'];
  const idx = renderer.parameterIndices;

  // 第 1 帧：perf 自己写 key7=0.2（记进 ledger）
  let w = writePerfParams({ params: { key7: 0.2 }, indices: idx, defaults: renderer.defaults, pinned, drift: 0 });
  for (const id of w.written) ledger.set(id, renderer.defaults[idx.get(id)]);
  assert.strictEqual(round(renderer.defaults[1]), 0.2);

  // 宿主 UI 点「脸红」：ui-controller 的 writeAssetParam 直接写 defaults（不经过 asset-toggles）
  renderer.defaults[1] = 1;
  const d1 = detectExternalPins({ defaults: renderer.defaults, indices: idx, previous: ledger, pinned, candidates });
  assert.deepStrictEqual(d1.detected, ['key7'], '应识别出宿主 UI 的手动 pin');
  assert.ok(pinned.has('key7'), '识别后 key7 归资产层');

  // perf 下一帧想写 0.4 → 必须跳过，手动值保持 1
  w = writePerfParams({ params: { key7: 0.4 }, indices: idx, defaults: renderer.defaults, pinned, drift: 0 });
  assert.deepStrictEqual(w.skippedPinned, ['key7']);
  assert.strictEqual(round(renderer.defaults[1]), 1, '手动值不得被 perf 覆盖');

  // 宿主 UI 关掉「脸红」→ 0：识别为交还，perf 恢复写入
  renderer.defaults[1] = 0;
  const d2 = detectExternalPins({ defaults: renderer.defaults, indices: idx, previous: ledger, pinned, candidates });
  assert.deepStrictEqual(d2.released, ['key7'], '关闭应识别为交还');
  assert.strictEqual(pinned.has('key7'), false);
  w = writePerfParams({ params: { key7: 0.4 }, indices: idx, defaults: renderer.defaults, pinned, drift: 0 });
  assert.deepStrictEqual(w.written, ['key7'], '交还后 perf 应能写 key7');

  const entry = source('petbody-entry.mjs');
  assert.ok(/detectExternalPins\(/.test(entry), 'entry 没有接入宿主 UI 的外部 pin 识别');
  return 'detected→skip→released→write';
});

// ── ③ 面板数据：t / duration ────────────────────────────────────────────
test('performanceStatus 的 t/duration 非零（假时钟推进）', async () => {
  const { createPerformanceArbiter, buildPerformanceStatus } = await import(file('perf/performance-arbiter.mjs'));
  let now = 1_000;
  const arb = createPerformanceArbiter({ now: () => now });
  const admitted = arb.begin('v2', { key: '05', title: '换重心', durationMs: 20_000 });
  assert.strictEqual(admitted.ok, true);

  now = 6_000; // 演了 5 秒
  const status = buildPerformanceStatus({
    session: arb.session.status(),
    clip: null,
    performerActive: true,
    key: '05',
    title: '换重心',
    faces: ['裙子切换'],
    auto: { on: true },
    claim: arb.claim.snapshot(),
  });
  assert.strictEqual(status.active, true);
  assert.strictEqual(status.owner, 'v2');
  assert.strictEqual(status.t, 5, 't 应为已演秒数（5.0），实际：' + status.t);
  assert.strictEqual(status.duration, 20, 'duration 应为该段总时长（20s），实际：' + status.duration);
  assert.strictEqual(status.tMs, 5_000);
  assert.strictEqual(status.durationMs, 20_000);
  assert.deepStrictEqual(status.faces, ['裙子切换']);
  assert.strictEqual(status.key, '05');

  // 片段在播：用片段播放器的 elapsed/duration（50ms tick 更实时）
  now = 7_000;
  const clipStatus = buildPerformanceStatus({
    session: { active: false, owner: '', key: '', title: '', t: 0, duration: 0, durationMs: 0 },
    clip: { playing: true, clipId: 'lumen-1', label: '害羞', elapsedMs: 2_500, durationMs: 4_000 },
    performerActive: false,
    faces: [],
    claim: arb.claim.snapshot(),
  });
  assert.strictEqual(clipStatus.owner, 'clip');
  assert.strictEqual(clipStatus.t, 2.5);
  assert.strictEqual(clipStatus.duration, 4);

  // 空闲：0/0（渲染层显示「未在演」而不是 NaN）
  arb.end('v2', admitted.token);
  const idle = buildPerformanceStatus({ session: arb.session.status(), clip: { playing: false }, performerActive: false, claim: arb.claim.snapshot() });
  assert.strictEqual(idle.active, false);
  assert.strictEqual(idle.t, 0);
  assert.strictEqual(idle.duration, 0);

  const entry = source('petbody-entry.mjs');
  assert.ok(/buildPerformanceStatus\(/.test(entry), 'entry 的 performanceStatus 没有用共享状态构建器');
  assert.ok(/session: perfArbiter\.session\.status\(\)/.test(entry), 'entry 没有把播放会话接进 performanceStatus');
  return `t=${status.t}s duration=${status.duration}s`;
});

// ── ④ 情绪增益：perf 路径真的放大 ───────────────────────────────────────
test('emotionGain=1.5 时 perf 输出参数确实放大（对比 1.0）', async () => {
  const { createPerfEngine } = await import(file('perf/index.mjs'));
  const profile = {
    modelId: 'gain-test',
    channels: {
      mouthSmile: [{ kind: 'param', id: 'ParamMouthForm', scale: 1, absolute: false, range: [-1, 1] }],
      browInnerUp: [{ kind: 'param', id: 'BrowInnerUp', scale: 1, absolute: false, range: [-1, 1] }],
    },
    capabilities: {},
    usedParams: ['ParamMouthForm', 'BrowInnerUp'],
    usedExpressions: [], degraded: [], dropped: [], version: 1,
  };
  function run(gain) {
    const engine = createPerfEngine({
      profile, baseline: { ParamMouthForm: 0, BrowInnerUp: 0 }, seed: 5, emotionGain: gain,
    });
    engine.feed({ emotion: 'happy', strength: 0.6, holdSeconds: 5 });
    let out = null;
    for (let i = 0; i < 180; i += 1) out = engine.update(1 / 60);
    return { out, engine };
  }
  const normal = run(1.0);
  const boosted = run(1.5);
  const weak = run(0.7);
  const flat = run(0);

  assert.ok(normal.out.params.ParamMouthForm > 0.05, 'gain=1 应正常有表情，实际 ' + normal.out.params.ParamMouthForm);
  assert.ok(boosted.out.params.ParamMouthForm > normal.out.params.ParamMouthForm + 0.03,
    'gain=1.5 必须明显大于 1.0：1.0=' + normal.out.params.ParamMouthForm + ' 1.5=' + boosted.out.params.ParamMouthForm);
  assert.ok(weak.out.params.ParamMouthForm < normal.out.params.ParamMouthForm,
    'gain=0.7 应小于 1.0：0.7=' + weak.out.params.ParamMouthForm);
  assert.ok(flat.out.params.ParamMouthForm < 0.06, 'gain=0 应接近中性，实际 ' + flat.out.params.ParamMouthForm);

  // 引擎入口：setEmotionGain 返回值与 getter 一致
  assert.strictEqual(boosted.engine.setEmotionGain(1.8), 1.8);
  assert.strictEqual(boosted.engine.emotionGain, 1.8);

  // entry 接线：面板/托盘调 setEmotionGain 必须同时推进 perf 引擎（旧实现只写 options）
  const entry = source('petbody-entry.mjs');
  assert.ok(/emotion\.perf\.setEmotionGain\(value\)/.test(entry), 'entry 的 setEmotionGain 没有转发给 perf 引擎');
  assert.ok(/gainAppliedPerf/.test(entry), 'entry 没有记录「增益真正进了 perf」的计数');
  return `1.0=${round(normal.out.params.ParamMouthForm)} 1.5=${round(boosted.out.params.ParamMouthForm)} 0.7=${round(weak.out.params.ParamMouthForm)}`;
});

(async () => {
  console.log('\n[performance arbitration] P1/P2 契约测试');
  for (const [name, fn] of tests) {
    try {
      const detail = await fn();
      pass += 1;
      console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
    } catch (error) {
      fail += 1;
      console.error('  ✗ ' + name + ' — ' + (error && error.message || error));
      if (process.env.VERBOSE) console.error(error && error.stack);
    }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
