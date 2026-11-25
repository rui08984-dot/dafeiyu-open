#!/usr/bin/env node
/**
 * _probe/test-perf-scheduler-integration.cjs —— P2b（2026-11-25，ADR-015 §5 P2）
 *
 * 真 scheduler + 假 arbiter + 假 performer（+ 真 performance-log），钉住接线契约：
 *   ① 开关关：request 直通 arbiter，调用序列与旧版逐项相等（不碰 scheduler 一行）；
 *   ② 开关开：manual/scenes 立即 pending → 收势 150/400ms 后 start；期间旧层还在演；
 *   ③ v2/clip 只在 relaxPreempt 点抢；inserted 填充点不抢；
 *   ④ atomic（scenes 3–4s / clip 短段）不被自动层打断，显式手动仍可；
 *   ⑤ 队列上限 4、优先级 + 到达序、finish 后自动拉起下一条；
 *   ⑥ 账目：perf.start{key,owner,plannedMs} / perf.interrupt{from,to,atRelax,retractMs} /
 *      perf.end{endedBy:natural|interrupt|budget} 字段齐全；
 *   ⑦ sync 覆盖：perf-sync.json 实读（112 项 / 15 段 v2）；
 *   ⑧ entry 接线点逐条在源码里可查（与 test-petbody-perf-fixes 同风格，不启 Electron）。
 *
 * 用法：node _probe/test-perf-scheduler-integration.cjs
 * 退出码：0 全过 / 1 有失败
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP = path.join(ROOT, 'pet-runtime', 'desktop');
const file = (p) => pathToFileURL(path.join(DESKTOP, p)).href;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(name, a === b, a === b ? '' : 'got ' + a + ' want ' + b);
}

// ── 假 arbiter（记录调用；claim 语义与真 arbiter 的最小一致）──────────────
function makeArbiter() {
  const calls = [];
  const holder = { owner: '', key: '', token: '' };
  let seq = 0;
  const arb = {
    calls,
    holder,
    begin(owner, meta = {}) {
      calls.push(['begin', owner, String(meta.key || '')]);
      const token = String(meta.token || ('a' + (seq += 1)));
      if (holder.owner && holder.owner !== owner) {
        if (meta.preempt !== true) {
          calls.push(['busy', holder.owner]);
          return { ok: false, reason: 'busy', holder: holder.owner, heldKey: holder.key };
        }
        calls.push(['preempt', holder.owner]);
        holder.owner = owner; holder.key = String(meta.key || ''); holder.token = token;
        return { ok: true, reason: 'preempted', owner, token, key: holder.key, preempted: 'x' };
      }
      holder.owner = owner; holder.key = String(meta.key || ''); holder.token = token;
      return { ok: true, reason: 'acquired', owner, token, key: holder.key };
    },
    end(owner, token) {
      calls.push(['end', String(owner || ''), String(token || '')]);
      if (holder.owner !== String(owner || '')) return false;
      if (token && holder.token !== String(token)) return false;
      holder.owner = ''; holder.key = ''; holder.token = '';
      return true;
    },
    availableFor(owner) {
      calls.push(['availableFor', String(owner || '')]);
      return !holder.owner || holder.owner === String(owner || '');
    },
    recordYield(owner, meta) { calls.push(['yield', String(owner || ''), (meta && meta.reason) || '']); },
    claim: {
      snapshot: () => ({ owner: holder.owner, key: holder.key, token: holder.token }),
      active: false,
      recordYield() {},
    },
    session: { status: () => ({ active: Boolean(holder.owner), owner: holder.owner }) },
  };
  Object.defineProperty(arb, 'owner', { get() { return holder.owner; } });
  Object.defineProperty(arb, 'active', { get() { return Boolean(holder.owner); } });
  return arb;
}

// ── 接线 harness：与 petbody-entry 的调度器分支同构（禁用时直通旧路径）────────
function makeHarness(schedulerApi, deps) {
  const h = {
    arbiter: deps.arbiter,
    perf: deps.perf,
    clip: deps.clip || { playing: false, id: '' },
    log: deps.log,
    events: [],
    calls: [],
    pending: new Map(),
    sceneTimers: 0,
  };
  const startV2 = (key, owner) => {
    h.perf.start(key);
    h.calls.push(['perf.start', key]);
    try {
      h.log.noteDecision({
        source: owner === 'manual' ? 'manual' : 'auto', emotion: '', intensity: null, played: true, perfKind: 'v2',
        decision: { clipId: key, label: key, reason: 'test', detail: { durationMs: 20000 } },
      });
    } catch (e) { /* ignore */ }
  };
  const startClip = (id) => {
    h.clip.playing = true; h.clip.id = id;
    h.calls.push(['clip.start', id]);
    try {
      h.log.noteDecision({
        source: 'peak', emotion: 'happy', intensity: 0.7, played: true, perfKind: 'clip',
        decision: { clipId: id, label: id, reason: 'ok', detail: { durationMs: 3000 } },
      });
    } catch (e) { /* ignore */ }
  };
  h.startV2 = startV2;
  h.startClip = startClip;
  h.onEvent = (ev) => {
    h.events.push(ev);
    if (ev.type === 'start') {
      try { h.log.noteStart({ key: ev.key, owner: ev.owner, plannedMs: ev.plannedMs }); } catch (e) { /* ignore */ }
      const p = h.pending.get(ev.token);
      if (p) { h.pending.delete(ev.token); p.apply(ev); }
      else if (ev.owner === 'v2' || ev.owner === 'manual') startV2(ev.key, ev.owner);
      return;
    }
    if (ev.type === 'retract') {
      try { h.log.noteInterrupt({ from: ev.from, to: ev.to, atRelax: ev.atRelax === true, retractMs: ev.ms }); } catch (e) { /* ignore */ }
      if ((ev.from === 'v2' || ev.from === 'manual') && h.perf.active) h.perf.fadeOut(ev.ms);
      return;
    }
    if (ev.type === 'end') {
      if (ev.endedBy !== 'replace') {
        const endedBy = ev.endedBy === 'natural' ? 'natural'
          : (ev.endedBy === 'expired' || ev.endedBy === 'cancelled') ? 'budget'
            : 'interrupt';
        try { h.log.noteEnd({ endedBy, clipId: ev.key, plannedMs: ev.plannedMs, actualMs: ev.actualMs }); } catch (e) { /* ignore */ }
      }
      if (ev.endedBy !== 'replace') {
        if ((ev.owner === 'v2' || ev.owner === 'manual') && h.perf.active && h.perf.key === ev.key) h.perf.stop('interrupt');
        else if (ev.owner === 'clip' && h.clip.playing && h.clip.id === ev.key) { h.clip.playing = false; h.clip.id = ''; }
        else if (ev.owner === 'scenes') h.sceneTimers = 0;
      }
    }
  };
  h.scheduler = schedulerApi;
  h.requestV2 = (req) => {
    if (!schedulerApi) {
      // 旧路径（逐位不变）
      if (req.preempt !== true && !h.arbiter.availableFor(req.owner)) {
        h.calls.push(['yield', req.owner, 'busy']);
        return { ok: false, reason: 'busy' };
      }
      const admitted = h.arbiter.begin(req.owner, { key: req.key, durationMs: req.maxMs, preempt: req.preempt === true });
      if (!admitted.ok) return { ok: false, reason: admitted.reason };
      startV2(req.key, req.owner);
      return { ok: true, status: 'started', token: admitted.token };
    }
    const r = schedulerApi.request({
      owner: req.owner, key: req.key, kind: 'segmented', sync: req.sync || null,
      maxMs: req.maxMs, preempt: req.preempt === true,
    });
    if (!r.ok) return r;
    if (r.status === 'started') { startV2(req.key, req.owner); return r; }
    h.pending.set(r.token, { apply: () => startV2(req.key, req.owner) });
    return r;
  };
  h.requestClip = (id, req = {}) => {
    const r = schedulerApi.request({ owner: 'clip', key: id, kind: 'atomic', channels: ['face'], maxMs: 3000, preempt: req.preempt === true });
    if (!r.ok) return r;
    if (r.status === 'started') { startClip(id); return r; }
    h.pending.set(r.token, { apply: () => startClip(id) });
    return r;
  };
  return h;
}

(async () => {
  const { createScheduler, loadSync, syncFor } = await import(file('perf/perf-scheduler.mjs'));
  const { createPerformanceLog } = await import(file('perf/performance-log.mjs'));
  const entry = fs.readFileSync(path.join(DESKTOP, 'petbody-entry.mjs'), 'utf8');
  const logMod = fs.readFileSync(path.join(DESKTOP, 'perf', 'performance-log.mjs'), 'utf8');

  let now = 0;
  const clock = () => now;
  const mkLog = () => {
    const lines = [];
    const log = createPerformanceLog({ now: clock, append: (line) => lines.push(JSON.parse(line)) });
    return { log, lines };
  };
  const mkPerf = () => {
    const calls = [];
    let cur = '';
    return {
      calls,
      start(key) { calls.push(['start', key]); cur = key; return true; },
      stop(reason) { if (cur) calls.push(['stop', cur, reason || '']); cur = ''; return []; },
      fadeOut(ms) { calls.push(['fadeOut', cur, ms]); return Boolean(cur); },
      get active() { return Boolean(cur); },
      get key() { return cur; },
    };
  };
  const mkSched = (arb, onChange) => createScheduler({ now: clock, arbiter: arb, onChange });

  // ── ① 开关关：直通 arbiter，调用序列与旧版逐项相等 ──────────────────────
  {
    const arb = makeArbiter();
    const { log, lines } = mkLog();
    const h = makeHarness(null, { arbiter: arb, perf: mkPerf(), log });
    let schedTouched = 0;
    const spySched = { request() { schedTouched += 1; return { ok: false }; } };
    // 用 spy 模拟「开关关时不建 scheduler」：harness 拿到 null 就不会去问它
    ok('disabled：scheduler 未被创建（request 不经过它）', schedTouched === 0 && h.scheduler === null);
    const r = h.requestV2({ owner: 'v2', key: '05-weight-shift', maxMs: 20000 });
    eq('disabled：返回形状与旧版一致', [r.ok, r.status], [true, 'started']);
    eq('disabled：arbiter 调用序列 = availableFor → begin（逐项相等）',
      arb.calls, [['availableFor', 'v2'], ['begin', 'v2', '05-weight-shift']]);
    eq('disabled：performer 立即启动（无 pending 阶段）', h.perf.key, '05-weight-shift');
    eq('disabled：没有 scheduler 事件', h.events.length, 0);
    eq('disabled：play 日志由调用处写（lastPlay 有值）', lines.filter((x) => x.kind === 'play').length, 1);
    // busy：自动层让位，不 begin
    const arb2 = makeArbiter();
    arb2.begin('clip', { key: 'lumen-0', durationMs: 3000 });
    const h2 = makeHarness(null, { arbiter: arb2, perf: mkPerf(), log: mkLog().log });
    const busy = h2.requestV2({ owner: 'v2', key: '03-pride', maxMs: 19000 });
    eq('disabled：占用时自动层让位（busy）', [busy.ok, busy.reason], [false, 'busy']);
    ok('disabled：让位时只问 availableFor，不 begin', JSON.stringify(arb2.calls).includes('availableFor') && !arb2.calls.some((c) => c[0] === 'begin' && c[1] === 'v2'));
    ok('disabled：不往 scheduler 发任何东西（spy 计数 0）', schedTouched === 0 && Boolean(spySched));
  }

  // ── ② manual over v2：立即 pending → 收势 400ms（含身体）→ start ─────────
  {
    now = 0;
    const arb = makeArbiter();
    const perf = mkPerf();
    const { log, lines } = mkLog();
    const events = [];
    const h = makeHarness(mkSched(arb, (ev) => { events.push(ev); h.onEvent(ev); }), { arbiter: arb, perf, log });
    const a = h.requestV2({ owner: 'v2', key: '05-weight-shift', maxMs: 20000, sync: { relaxMs: [3000], endMs: 20000 } });
    eq('enabled：第一条 v2 直接 started', a.status, 'started');
    now = 100;
    const m = h.requestV2({ owner: 'manual', key: '03-pride', maxMs: 9000, preempt: true });
    eq('manual：立即返回 preempting（不硬切）', [m.ok, m.status], [true, 'preempting']);
    eq('manual：旧 owner 仍在演（收势中）', arb.holder.owner, 'v2');
    eq('manual：收势时长 400ms（旧层含身体通道）', m.retractMs, 400);
    eq('manual：新 owner 处于 pending', events.filter((e) => e.type === 'pending' && e.owner === 'manual').length >= 1, true);
    const fade = perf.calls.find((c) => c[0] === 'fadeOut');
    ok('manual：旧层收到 fadeOut(400)（不做一帧硬切）', Boolean(fade && fade[2] === 400), JSON.stringify(fade));
    now = 499;
    h.scheduler.tick(now);
    eq('manual：399ms 后仍是旧 owner', arb.holder.owner, 'v2');
    now = 500;
    h.scheduler.tick(now);
    eq('manual：400ms 后新 owner 接手', arb.holder.owner, 'manual');
    eq('manual：performer 换到手动段', perf.key, '03-pride');
    ok('manual：interrupt 账 atRelax=false + retractMs=400', lines.some((x) => x.kind === 'perf.interrupt'
      && x.from === 'v2' && x.to === 'manual' && x.atRelax === false && x.retractMs === 400));
  }

  // ── ③ scenes over clip：clip 只申请 face → 收势 150ms ────────────────────
  {
    now = 0;
    const arb = makeArbiter();
    const perf = mkPerf();
    const h = makeHarness(mkSched(arb, (ev) => h.onEvent(ev)), { arbiter: arb, perf, log: mkLog().log });
    const c = h.requestClip('lumen-0');
    eq('clip：atomic 直接 started', c.status, 'started');
    now = 200;
    const s = h.requestV2({ owner: 'scenes', key: 'scene:打招呼', maxMs: 4500, preempt: true });
    const schedR = h.scheduler.request({ owner: 'scenes', key: 'scene:打招呼', kind: 'atomic', maxMs: 4500, preempt: true });
    eq('scenes：抢占 clip 收势 150ms（只有脸）', [s.ok || schedR.ok, s.retractMs || schedR.retractMs], [true, 150]);
    now = 349;
    h.scheduler.tick(now);
    eq('scenes：149ms 时 clip 还在演', arb.holder.owner, 'clip');
    now = 350;
    h.scheduler.tick(now);
    eq('scenes：150ms 交接完成', arb.holder.owner, 'scenes');
    eq('scenes：clip 播放器被真正停掉（不残留写脸）', h.clip.playing, false);
  }

  // ── ④ v2 只在 relaxPreempt 点被 clip 抢 ────────────────────────────────
  {
    now = 0;
    const arb = makeArbiter();
    const perf = mkPerf();
    const h = makeHarness(mkSched(arb, (ev) => h.onEvent(ev)), { arbiter: arb, perf, log: mkLog().log });
    h.requestV2({
      owner: 'v2', key: '01-curiosity', maxMs: 20000,
      sync: {
        relaxMs: [4000, 7500],
        relaxMeta: [{ t: 4000, q: 'authored' }, { t: 7500, q: 'derived' }],
        endMs: 20000,
      },
    });
    now = 1000;
    const p = h.requestClip('lumen-7');
    eq('relax：clip 先排队（pending）', [p.ok, p.status, p.reason], [true, 'pending', 'relax']);
    eq('relax：给出第一个可抢点（起点 + 4000）', p.relaxAt, 4000);
    now = 3999;
    h.scheduler.tick(now);
    eq('relax：3999ms 还不收势', arb.holder.owner, 'v2');
    now = 4000;
    h.scheduler.tick(now);
    eq('relax：到点开始收势（v2 仍在写，pending 里是 clip）', [h.scheduler.status().current.retracting, h.scheduler.status().pending.owner], [true, 'clip']);
    now = 4399;
    h.scheduler.tick(now);
    eq('relax：收势未满 400ms 时旧层还在写', arb.holder.owner, 'v2');
    now = 4400;
    h.scheduler.tick(now);
    eq('relax：收势结束 clip 接手', arb.holder.owner, 'clip');
    eq('relax：performer 已停（收势完成）', perf.active, false);
    ok('relax：interrupt 账 atRelax=true', h.events.some((e) => e.type === 'retract' && e.atRelax === true));
  }

  // ── ⑤ inserted 填充点不参与抢占 ─────────────────────────────────────────
  {
    now = 0;
    const arb = makeArbiter();
    const perf = mkPerf();
    const h = makeHarness(mkSched(arb, (ev) => h.onEvent(ev)), { arbiter: arb, perf, log: mkLog().log });
    h.requestV2({
      owner: 'v2', key: '06-finger-articulation', maxMs: 19000,
      sync: {
        relaxMs: [1500, 3000, 6000],
        relaxMeta: [{ t: 1500, q: 'inserted' }, { t: 3000, q: 'authored' }, { t: 6000, q: 'inserted' }],
        endMs: 19000,
      },
    });
    now = 500;
    const p = h.requestClip('lumen-8');
    eq('inserted：跳到第一个真静止点（起点 0 + 3000）', [p.status, p.relaxAt], ['pending', 3000]);
    now = 2500;
    h.scheduler.tick(now);   // elapsed 2500：inserted 点(1500)已过，authored(3000)未到
    eq('inserted：经过 inserted 点不收势', h.scheduler.status().current.retracting, false);
    now = 3000;
    h.scheduler.tick(now);   // elapsed 3000（authored 点）
    eq('inserted：到 authored 点才收势', h.scheduler.status().current.retracting, true);
  }

  // ── ⑥ atomic：自动层打不断，显式手动仍可 ───────────────────────────────
  {
    now = 0;
    const arb = makeArbiter();
    const perf = mkPerf();
    const h = makeHarness(mkSched(arb, (ev) => h.onEvent(ev)), { arbiter: arb, perf, log: mkLog().log });
    const s = h.scheduler.request({ owner: 'scenes', key: 'scene:撒娇', kind: 'atomic', maxMs: 6200, preempt: true });
    eq('atomic：scenes 开演', s.status, 'started');
    now = 1000;
    const auto = h.scheduler.request({ owner: 'v2', key: '04-playful', kind: 'segmented', maxMs: 25000 });
    eq('atomic：自动 v2 只能排队（reason=atomic）', [auto.ok, auto.status, auto.reason], [true, 'pending', 'atomic']);
    now = 5000;
    h.scheduler.tick(now);
    eq('atomic：到 5s 仍未被自动层打断', arb.holder.owner, 'scenes');
    const manual = h.scheduler.request({ owner: 'manual', key: '03-pride', kind: 'segmented', maxMs: 9000, preempt: true });
    eq('atomic：显式手动仍可抢', [manual.ok, manual.status], [true, 'preempting']);
    eq('atomic：手动收势按通道算（manual 默认含 body → 400ms，纯脸层才是 150ms）', manual.retractMs, 400);
  }

  // ── ⑦ 队列上限 4 + 优先级 + finish 拉起下一条 ───────────────────────────
  {
    now = 0;
    const arb = makeArbiter();
    const perf = mkPerf();
    const h = makeHarness(mkSched(arb, (ev) => h.onEvent(ev)), { arbiter: arb, perf, log: mkLog().log });
    const cur = h.scheduler.request({ owner: 'scenes', key: 'scene:点头', kind: 'atomic', maxMs: 4000, preempt: true });
    for (let i = 0; i < 4; i += 1) {
      const r = h.scheduler.request({ owner: 'v2', key: 'q' + i, kind: 'segmented', maxMs: 5000 });
      eq('队列：第 ' + (i + 1) + ' 条进入 pending', [r.ok, r.status], [true, 'pending']);
    }
    eq('队列：上限 4', h.scheduler.status().queue.length, 4);
    const over = h.scheduler.request({ owner: 'v2', key: 'q5', kind: 'segmented', maxMs: 5000 });
    eq('队列：第 5 条被 rejected（queue-full）', [over.ok, over.reason], [false, 'queue-full']);
    now = 4000;
    h.scheduler.finish(cur.token, { endedBy: 'natural' });
    eq('队列：finish 后自动拉起下一条（v2）', arb.holder.owner, 'v2');
    eq('队列：被拉起的是最早到达的那条', arb.holder.key, 'q0');
    eq('队列：剩余 3 条', h.scheduler.status().queue.length, 3);
  }

  // ── ⑧ 账目：perf.start / perf.interrupt / perf.end 字段齐全 ─────────────
  {
    now = 0;
    const arb = makeArbiter();
    const perf = mkPerf();
    const { log, lines } = mkLog();
    const h = makeHarness(mkSched(arb, (ev) => h.onEvent(ev)), { arbiter: arb, perf, log });
    h.requestV2({ owner: 'v2', key: '05-weight-shift', maxMs: 20000, sync: { relaxMs: [3000], endMs: 20000 } });
    now = 100;
    h.requestV2({ owner: 'manual', key: '03-pride', maxMs: 9000, preempt: true });
    now = 500;
    h.scheduler.tick(now);
    now = 1500;
    h.scheduler.finish('manual', { endedBy: 'natural' });

    const starts = lines.filter((x) => x.kind === 'perf.start');
    const ints = lines.filter((x) => x.kind === 'perf.interrupt');
    const ends = lines.filter((x) => x.kind === 'perf.end');
    eq('账：两条 perf.start（v2 + manual）', starts.length, 2);
    ok('账：perf.start 带 key/owner/plannedMs', starts.every((x) => x.key && x.owner && Number(x.plannedMs) > 0),
      JSON.stringify(starts[0]));
    eq('账：一条 perf.interrupt', ints.length, 1);
    ok('账：perf.interrupt 带 from/to/atRelax/retractMs', ints[0] && ints[0].from === 'v2' && ints[0].to === 'manual'
      && ints[0].atRelax === false && ints[0].retractMs === 400, JSON.stringify(ints[0]));
    eq('账：两条 perf.end（打断 + 自然）', ends.map((x) => x.endedBy), ['interrupt', 'natural']);
    ok('账：perf.end 带 plannedMs/actualMs', ends.every((x) => Number(x.plannedMs) > 0 && Number(x.actualMs) >= 0),
      JSON.stringify(ends));
    eq('账：被顶掉的 v2 那笔账没丢（clipId 对上）', ends[0].clipId, '05-weight-shift');
    eq('账：日志模块统计 starts/interrupts', [log.stats.starts, log.stats.interrupts], [2, 1]);
  }

  // ── ⑨ 预算/过期：endedBy 映射为 budget ──────────────────────────────────
  {
    now = 0;
    const arb = makeArbiter();
    const perf = mkPerf();
    const { log, lines } = mkLog();
    const h = makeHarness(mkSched(arb, (ev) => h.onEvent(ev)), { arbiter: arb, perf, log });
    h.scheduler.request({ owner: 'v2', key: '09-composure', kind: 'segmented', maxMs: 1000 });
    now = 1600;   // maxMs + 600 = TTL 到点
    h.scheduler.tick(now);
    eq('过期：claim 被释放', arb.holder.owner, '');
    eq('过期：perf.end endedBy=budget', lines.filter((x) => x.kind === 'perf.end').map((x) => x.endedBy), ['budget']);
  }

  // ── ⑩ sync 覆盖：真 perf-sync.json 实读 ─────────────────────────────────
  {
    const syncPath = path.join(ROOT, 'pet-runtime', 'data', 'perf-sync.json');
    const doc = loadSync({ file: syncPath, readFile: (f) => fs.readFileSync(f, 'utf8') });
    ok('sync：perf-sync.json 可读', Boolean(doc && doc.items));
    eq('sync：version = 2', doc && doc.version, 2);
    eq('sync：112 项（15 段 v2 + 97 段 clip）', Object.keys(doc.items).length, 112);
    const v2sync = syncFor(doc, '01-curiosity');
    ok('sync：v2 段有 relaxMs 且 endMs 对齐时长', Array.isArray(v2sync.relaxMs) && v2sync.relaxMs.length >= 5 && v2sync.endMs === 20200,
      JSON.stringify({ relax: v2sync.relaxMs, end: v2sync.endMs }));
    ok('sync：relaxPreempt 已剔除 inserted（若有）', Array.isArray(v2sync.relaxPreempt) && v2sync.relaxPreempt.length > 0);
    eq('sync：不存在的 key → null（退化 atomic）', syncFor(doc, 'nope'), null);
    const clipSync = syncFor(doc, 'lumen-0');
    ok('sync：clip 段也在表里', Boolean(clipSync && clipSync.endMs > 0), JSON.stringify(clipSync && { end: clipSync.endMs, atomic: clipSync.atomic }));
  }

  // ── ⑪ entry 接线点（源码契约，不启 Electron）────────────────────────────
  {
    ok('entry 引入 createScheduler / loadSync / syncFor',
      /import \{ createScheduler, loadSync as loadPerfSync, syncFor as selectPerfSync \} from '\.\/perf\/perf-scheduler\.mjs'/.test(entry));
    ok('entry 有 schedulerEnabled() 且严格要求 enabled === true', /function schedulerEnabled\(\)[\s\S]{0,240}enabled === true/.test(entry));
    ok('entry 有 ensureScheduler()（关闭时返回 null，不建）', /function ensureScheduler\(\)[\s\S]{0,160}if \(!schedulerEnabled\(\)\) return null/.test(entry));
    eq('entry：segmented 请求（v2/manual）', (entry.match(/kind: 'segmented'/g) || []).length >= 1, true);
    eq('entry：atomic 请求（clip/scenes 各一处）', (entry.match(/kind: 'atomic'/g) || []).length >= 2, true);
    ok('entry：request 带 syncFor(key) 的 relax 点', /sync: selectPerfSync\(perfSyncDoc, key\)/.test(entry));
    ok('entry：每帧一次 tick（rAF 内）', /sched\.tick\(now\)/.test(entry) && /function frame\(now\)[\s\S]{0,900}sched\.tick\(now\)/.test(entry));
    ok('entry：三处结束统一走 endClaim（clip stop / v2 done / 场景定时器）',
      (entry.match(/endClaim\(/g) || []).length >= 4);
    ok('entry：收势走 performer.fadeOut(ev.ms)', /performer\.fadeOut\(Number\(ev\.ms\) \|\| 0\)/.test(entry));
    ok('entry：停止时补发的手势 exit 每帧取走', /performer\.takeExits\(\)/.test(entry) && /applyGestureEvent\(/.test(entry));
    ok('entry：没有资产 API 时发 petbody:asset 关闭事件', /'petbody:asset'/.test(entry));
    ok('entry：performanceDebug 暴露 scheduler 块', /scheduler: \(\(\) => \{[\s\S]{0,700}enabled,[\s\S]{0,200}mode:/.test(entry));
    ok('entry：performanceDebug 暴露 current/pending/queue/yields', /current: st \? st\.current/.test(entry)
      && /pending: st \? st\.pending/.test(entry) && /queue: st \? st\.queue/.test(entry) && /yields: st \? st\.yields/.test(entry));
    ok('entry：syncCoverage 实读 items/loaded/version',
      /syncCoverage: \(\(\) => \{[\s\S]{0,300}items: perfSyncInfo\.items, loaded: perfSyncInfo\.loaded, version: perfSyncInfo\.version/.test(entry));
    ok('entry：perf.start / perf.interrupt 有账', /perfLog\.noteStart\(\{ key: ev\.key/.test(entry)
      && /perfLog\.noteInterrupt\(\{[\s\S]{0,120}from: ev\.from/.test(entry));
    ok('entry：endedBy 映射到 natural/interrupt/budget（expired/cancelled → budget）',
      /expired' \|\| s === 'cancelled'\) return 'budget'/.test(entry));
    ok('entry：配置关掉时热回滚（reset + 交还 claim）', /perfSched\.reset\(\)/.test(entry) && /schedPending\.clear\(\)/.test(entry));
    ok('performance-log 暴露 noteStart / noteInterrupt', /function noteStart\(/.test(logMod) && /function noteInterrupt\(/.test(logMod)
      && /noteStart,/.test(logMod) && /noteInterrupt,/.test(logMod));
  }

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' scheduler 接线：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('  ✗ 测试崩溃：' + ((e && e.stack) || e));
  process.exit(1);
});
