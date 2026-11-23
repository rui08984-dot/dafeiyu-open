#!/usr/bin/env node
/**
 * _probe/test-petbody-perf-fixes.cjs —— 2026-11-21 七条根因的回归门禁
 *
 * 纯 node + stub renderer，不启 Electron、不加载模型。测的是「契约」而不是画面：
 *   ① gaze：GazeFollow.prepare() 只取样不写参数；偏移必须由 updateView 在物理/顶点前提交
 *   ② 事件名：pat_head/tap 能命中 headpat/poke；未知事件返回 false 且计数 + 发声
 *   ③ speaking：TTS 播放期间 perf snapshot().speaking === true
 *   ④ browDown：物理输出参数走「物理后提交」（param-commit 的 after 段）
 *   ⑤ blink：表达式没写 EyeOpen 时不再二次相乘
 *   ⑥ 微表情：每帧 feed 但无新指令时，20 秒内仍能产生微表情
 *   ⑦ dispose：canvas 绑定解绑、FACS 片段 interval 停止
 *
 * 用法：node _probe/test-petbody-perf-fixes.cjs
 * 退出码：0 全过 / 1 有失败。
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP = path.join(ROOT, 'pet-runtime', 'desktop');
const file = (p) => pathToFileURL(path.join(DESKTOP, p)).href;
const source = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');

let pass = 0;
let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── ① gaze：帧内提交 ────────────────────────────────────────────────────
test('gaze：prepare() 只取样，偏移在 updateView 前提交（不直接写参数）', async () => {
  const { GazeFollow } = await import(file('ui/gaze.mjs'));
  const stub = {
    ready: true,
    _model: {},
    _gazeQuiet: true,
    values: new Map([
      ['ParamEyeBallX', 0.1], ['ParamEyeBallY', -0.05],
      ['ParamAngleX', 2], ['ParamAngleY', 1], ['AngleX', 2], ['AngleY', 1],
    ]),
    writes: [],
    setParameter(id, v) { this.writes.push(id); this.values.set(id, v); },
    getParameter(id) { return this.values.get(id) ?? 0; },
  };
  const gaze = new GazeFollow(stub);
  gaze.setPointer(1, -1);
  // 直接把平滑值推到目标附近，避免依赖 sleep
  gaze.x = 1; gaze.y = -1;
  gaze.lastAt = performance.now() - 120;

  assert.strictEqual(typeof gaze.prepare, 'function', 'GazeFollow 缺少 prepare()：偏移无法交给 updateView 帧内提交');
  const frame = gaze.prepare();
  assert.ok(frame, 'prepare() 应返回本帧偏移');
  assert.deepStrictEqual(stub.writes, [], 'prepare() 阶段不得直接写渲染器（旧 apply() 写在 updateView 之后，永远进不了画面）');
  assert.strictEqual(stub._gazeQuiet, false, '眼神移动时 _gazeQuiet 必须为 false（满帧语义不变）');
  assert.ok(frame.eyeX > 0.05, 'eyeX 偏移幅度不对：' + frame.eyeX);
  assert.ok(frame.eyeY > 0.05, 'eyeY 偏移幅度不对：' + frame.eyeY);

  const { applyGazeOffsets } = await import(file('perf/gaze-commit.mjs'));
  const applied = applyGazeOffsets({
    get: (id) => stub.getParameter(id),
    set: (id, v) => stub.setParameter(id, v),
  }, frame);
  assert.ok(applied.length >= 4, '至少应提交眼球 + 头部 4 个参数');
  assert.ok(Math.abs(stub.getParameter('ParamEyeBallX') - (0.1 + frame.eyeX)) < 1e-9, '眼球 X 最终值 = 基线 + 偏移');
  assert.ok(Math.abs(stub.getParameter('ParamAngleX') - (2 + frame.headX)) < 1e-9, '头部 X 最终值 = 基线 + 偏移');

  // 静止语义不变：没有指针且偏移趋零 → 不写，_gazeQuiet = true
  const quietStub = Object.assign({}, stub, {
    values: new Map([['ParamEyeBallX', 0], ['ParamEyeBallY', 0], ['ParamAngleX', 0], ['ParamAngleY', 0], ['AngleX', 0], ['AngleY', 0]]),
    writes: [], _gazeQuiet: false,
    setParameter(id, v) { this.writes.push(id); this.values.set(id, v); },
    getParameter(id) { return this.values.get(id) ?? 0; },
  });
  const quiet = new GazeFollow(quietStub);
  assert.strictEqual(quiet.prepare(), null, '静止时应返回 null（不写参数）');
  assert.strictEqual(quietStub._gazeQuiet, true, '静止时 _gazeQuiet 必须为 true');
  assert.deepStrictEqual(quietStub.writes, [], '静止时不得写参数');

  // 接线检查：entry 必须把 gaze 作为 view 字段传给 updateView，且不再在 updateView 之后 apply
  const entry = source('petbody-entry.mjs');
  assert.ok(/gaze\s*:\s*gazeFrame/.test(entry), 'petbody-entry 未把 gazeFrame 传进 updateView（仍会是「写完之后才写」）');
  assert.ok(!/GazeFollow\(renderer\)\)\.apply\(\)/.test(entry), 'petbody-entry 仍在 updateView 之后调用 GazeFollow.apply()');
  return 'prepare 不写参数；偏移由 updateView 提交';
});

// ── ② 事件名映射 + 未知事件审计 ─────────────────────────────────────────
test('事件：pat_head/tap 命中规则；未知事件 false + 计数 + 发声', async () => {
  const { createEmotionEngine } = await import(file('emotion-engine.mjs'));
  const logs = [];
  let t = 1000;
  const engine = createEmotionEngine({ now: () => t, log: (line) => logs.push(String(line)) });

  assert.strictEqual(engine.feed({ kind: 'event', name: 'pat_head', now: t }), true, 'pat_head 应命中 headpat 规则');
  assert.strictEqual(engine.feed({ kind: 'event', name: 'tap', now: (t += 100) }), true, 'tap 应命中 poke 规则');
  assert.strictEqual(engine.feed({ kind: 'event', name: 'wibble', now: (t += 100) }), false, '未知事件必须返回 false');

  const snap = engine.snapshot();
  assert.strictEqual(snap.counters.unknownEvents, 1, '未知事件必须计数（发现「事件名对不上」不能再靠猜）');
  assert.strictEqual(snap.lastUnknownEvent, 'wibble', '应记录最近一次未知事件名');
  assert.ok(logs.some((l) => l.includes('wibble')), '未知事件必须发声到 log，而不是静默返回 false');

  // 宿主侧也得把 miss 记下来（调用方丢弃返回值是原来的静默点）
  const entry = source('petbody-entry.mjs');
  assert.ok(!/feed\(head \? 'pat_head' : 'tap'\)/.test(entry), '宿主仍在使用与引擎枚举不一致的 pat_head/tap 名称');
  assert.ok(/headpat/.test(entry) && /poke/.test(entry), '宿主 feed 应改用引擎枚举 headpat/poke');
  assert.ok(/eventMiss|eventStats/.test(entry), '宿主必须为「事件没命中」保留可见计数');
  return 'pat_head→headpat, tap→poke；未知事件有计数与日志';
});

// ── ③ speaking 接入 ─────────────────────────────────────────────────────
test('speaking：setSpeaking(true) 后 snapshot().speaking === true', async () => {
  const { createPerfEngine } = await import(file('perf/index.mjs'));
  const profile = {
    modelId: 'test', channels: {}, capabilities: {},
    usedParams: [], usedExpressions: [], degraded: [], dropped: [], version: 1,
  };
  const engine = createPerfEngine({ profile, baseline: {}, seed: 1 });
  engine.update(0.016);
  assert.strictEqual(engine.snapshot().speaking, false, '初始状态不应在说话');
  assert.strictEqual(typeof engine.setSpeaking, 'function', 'perf 引擎缺少 setSpeaking()：宿主的说话状态进不来');
  engine.setSpeaking(true);
  engine.update(0.016);
  assert.strictEqual(engine.snapshot().speaking, true, 'TTS 播放期间 snapshot().speaking 必须为 true');
  engine.setSpeaking(false);
  engine.update(0.016);
  assert.strictEqual(engine.snapshot().speaking, false, '说完后 speaking 应回落');

  // 接线检查：entry 每帧把 state.speaking 推给 perf
  const entry = source('petbody-entry.mjs');
  assert.ok(/perf\.setSpeaking\(/.test(entry), 'petbody-entry 未把 state.speaking 接进 perf');
  return 'setSpeaking 生效；entry 每帧推送';
});

// ── ④ browDown：物理后提交 ──────────────────────────────────────────────
test('browDown：物理输出参数走 param-commit 的物理后提交', async () => {
  const { selectPhysicsOutputTargets, commitInOrder } = await import(file('perf/param-commit.mjs'));
  const { classifyParam } = await import(file('perf/physics-io.mjs'));
  assert.strictEqual(typeof selectPhysicsOutputTargets, 'function', 'param-commit 缺少「物理输出参数筛选」');

  const target = {
    ParamBrowRAngle: 0.45,
    ParamBrowLAngle: -0.2,
    ParamMouthForm: 0.3,
    ParamEyeLOpen: 0.8,
    ParamBrowRY: -0.1,
  };
  const selected = selectPhysicsOutputTargets(target, classifyParam);
  const ids = selected.map(([id]) => id).sort();
  assert.deepStrictEqual(ids, ['ParamBrowLAngle', 'ParamBrowRAngle'],
    '只有物理 BOTH/OUTPUT 参数需要物理后重放，实际：' + ids.join(','));

  const order = [];
  commitInOrder({ before: [], after: selected }, () => order.push('before'), () => order.push('physics'), (id) => order.push('after:' + id));
  assert.strictEqual(order[0], 'physics', '物理输出参数必须等物理算完再放');
  assert.ok(order.includes('after:ParamBrowRAngle') && order.includes('after:ParamBrowLAngle'));

  // 接线检查：renderer 认识 perfCommit，entry 每帧传
  const renderer = source('cubism-renderer.mjs');
  const entry = source('petbody-entry.mjs');
  assert.ok(/view\.perfCommit|perfCommit/.test(renderer), 'cubism-renderer 未消费 perfCommit（browDown 仍会被物理吃掉）');
  assert.ok(/perfCommit\s*:/.test(entry), 'petbody-entry 未把 perfCommit 传给 updateView');
  return 'BrowRAngle/LAngle 等物理输出在物理后重放';
});

// ── ⑤ blink 平方 ────────────────────────────────────────────────────────
test('blink：表达式未写 EyeOpen 时不做二次相乘', async () => {
  const { shouldRestackBlink } = await import(file('perf/blink-stack.mjs'));
  const eyeWriters = new Set(['＞＜']);
  assert.strictEqual(shouldRestackBlink({ eyeWriters, activeNames: ['脸红'] }), false,
    '表情不含 EyeOpen 时必须跳过 restack（否则 0.3 被乘两次 = 0.09）');
  assert.strictEqual(shouldRestackBlink({ eyeWriters, activeNames: ['＞＜'] }), true,
    '表情确实写 EyeOpen 时必须 restack（否则眨眼被表情盖掉）');
  assert.strictEqual(shouldRestackBlink({ eyeWriters, activeNames: [] }), false, '没有表情时不应 restack');
  assert.strictEqual(shouldRestackBlink({ eyeWriters: new Set(), activeNames: ['＞＜'] }), false, '没有 eye writer 时不应 restack');

  const renderer = source('cubism-renderer.mjs');
  assert.ok(/shouldRestackBlink/.test(renderer), 'cubism-renderer 仍在无条件 restack 眨眼');
  assert.ok(/eyeWritingExpressions|eyeWriters/.test(renderer), '渲染层未记录哪些 exp3 写了 EyeOpen');
  return '仅当当前表情写 EyeOpen 时才乘回';
});

// ── ⑥ 微表情：拆分「新指令」与「每帧刷新」 ──────────────────────────────
test('微表情：每帧 feed（无新指令）时 20 秒内仍能产生', async () => {
  const { createPerfEngine } = await import(file('perf/index.mjs'));
  const profile = {
    modelId: 'test', channels: {}, capabilities: {},
    usedParams: [], usedExpressions: [], degraded: [], dropped: [], version: 1,
  };
  const engine = createPerfEngine({ profile, baseline: {}, seed: 7, microMotion: true });
  let sawMicro = null;
  let seen = 0;
  for (let i = 0; i < 20 * 60; i += 1) {
    engine.feed({ emotion: 'neutral', strength: 0 });   // 宿主每帧无条件 feed
    const out = engine.update(1 / 60);
    if (out.micro) { sawMicro = out.micro; seen += 1; }
  }
  assert.ok(sawMicro, '每帧 feed 时 lastFeedAt 恒等于 clock → 微表情永远不触发（当前 bug）');
  assert.ok(seen > 0, '应至少有一帧输出 micro');
  return '20s 内产生 ' + seen + ' 帧微表情：' + JSON.stringify(sawMicro);
});

// ── ⑦ dispose：绑定/interval 清理 ───────────────────────────────────────
test('dispose：canvas 绑定解绑、FACS 片段 interval 停止', async () => {
  const { bindCanvasListeners } = await import(file('emotion-engine.mjs'));
  const listeners = new Map();
  const canvas = {
    __petEmotionBound: false,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const binding = bindCanvasListeners(canvas, { pointerdown() {}, pointerup() {} });
  assert.strictEqual(canvas.__petEmotionBound, true, '绑定后标记应为 true');
  assert.strictEqual(listeners.size, 2, '应挂上两个监听器');
  binding.dispose();
  assert.strictEqual(canvas.__petEmotionBound, false, 'dispose 后 canvas.__petEmotionBound 必须清除（否则换 VRM/MMD 再回来交互不再驱动情绪）');
  assert.strictEqual(listeners.size, 0, 'dispose 后监听器必须解绑');

  const entry = source('petbody-entry.mjs');
  assert.ok(/facsClips\?\.stop|facsClips\.stop|\.stop\(\)/.test(entry), 'dispose 未停止 FACS 片段 interval');
  assert.ok(/bindCanvasListeners|__petEmotionBound\s*=\s*false/.test(entry), 'dispose 未清理 canvas 绑定');
  const entryDispose = entry.slice(entry.indexOf('dispose() {'), entry.indexOf('dispose() {') + 900);
  assert.ok(/facsClips/.test(entryDispose), 'FACS interval 清理不在 dispose() 里');
  return '监听器解绑 + 标记清除 + clip interval 停止';
});

(async () => {
  console.log('\n[petbody perf fixes] 契约测试');
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
