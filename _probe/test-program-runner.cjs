#!/usr/bin/env node
/**
 * _probe/test-program-runner.cjs —— 节目单运行器（P3a，ADR-015 §3.5）
 *
 * 全部离线：假 scheduler / 假 playSegment / 假 speak / 假 sfx / 假时钟（wait 推进 now）。
 * 钉住：
 *   ① 串接：两段按顺序 playSegment，台词 await，段间 fadeOut(transitionMs)，结束 fadeOut(400)；
 *   ② 中断：notifyUserInput() **不硬切** —— 在下一 relax 点（句边界/静止点/段末）停，endedBy=interrupt；
 *   ③ 手动 stop()：立刻收势（fadeOut(400)），不等台词；
 *   ④ 台词超时不卡死（maxMs/2 到点继续），异常不炸；
 *   ⑤ 预算（budget.takeProgram）耗尽拒绝、未知 programId 拒绝、busy 拒绝、
 *      调度器拒绝/未启用拒绝；被拒不白吃额度（releaseProgram）；
 *   ⑥ 遥测：perf.program{programId,beatIdx,beatKey,lineLen,actualMs,endedBy}；
 *   ⑦ 数据：programs/*.json 两条全过校验，seg 都在 CHOREO_DATA；check-programs 退出码 0；
 *   ⑧ entry 接线点（源码扫描，不启 Electron）：listPrograms/playProgram/stopProgram/
 *      notifyUserInput/performanceDebug().program/scheduler-off/disabled。
 *
 * 用法：node _probe/test-program-runner.cjs
 * 退出码：0 全过 / 1 有失败
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

// ── 假时钟（虚拟定时器队列：按目标时间先后推进，最接近真实语义）──────────
function makeClock() {
  const c = { t: 0, timers: [], flushing: false };
  c.now = () => c.t;
  function schedule() {
    if (c.flushing) return;
    c.flushing = true;
    // 用宏任务：让「台词按虚拟时长同步推进」这类微任务先落地，再推进时钟
    setTimeout(() => {
      c.flushing = false;
      if (!c.timers.length) return;
      let idx = 0;
      for (let i = 1; i < c.timers.length; i += 1) if (c.timers[i].at < c.timers[idx].at) idx = i;
      const next = c.timers.splice(idx, 1)[0];
      if (next.done) { schedule(); return; }
      c.t = Math.max(c.t, next.at);
      next.resolve();
      if (c.timers.length) schedule();
    }, 0);
  }
  c.wait = (ms, opts) => new Promise((resolve) => {
    const item = { at: c.t + Math.max(0, Number(ms) || 0), resolve, done: false };
    const sig = opts && opts.signal;
    if (sig && typeof sig.addEventListener === 'function') {
      sig.addEventListener('abort', () => {
        item.done = true;
        const i = c.timers.indexOf(item);
        if (i >= 0) c.timers.splice(i, 1);
        resolve();
      }, { once: true });
    }
    c.timers.push(item);
    schedule();
  });
  // 直接推进时钟（台词/过渡的同步代价，不排队）
  c.advance = (ms) => { c.t += Math.max(0, Number(ms) || 0); };
  return c;
}

// ── 假调度器（request/finish/status；语义与真调度器的最小一致）──────────
function makeScheduler(opts = {}) {
  const s = { calls: [], finishes: [], current: null, seq: 0, queue: [], busyOwner: opts.busyOwner || '' };
  s.request = (req) => {
    s.calls.push(Object.assign({}, req));
    if (s.current || s.busyOwner) {
      return { ok: false, status: 'rejected', reason: 'busy', holder: (s.current && s.current.owner) || s.busyOwner, token: null };
    }
    if (opts.rejectWith) return { ok: false, status: 'rejected', reason: opts.rejectWith, token: null };
    s.seq += 1;
    const item = pullToken(req, 's' + s.seq);
    const status = opts.pending ? 'pending' : 'started';
    if (status === 'pending') {
      // 排队：还没有 claim（current 为空），等 admit() 才真正开演
      s.queue.push(item);
      return { ok: true, status, reason: 'end', token: item.token, owner: 'program', key: req.key };
    }
    s.current = item;
    return { ok: true, status, reason: 'started', token: item.token, owner: 'program', key: req.key };
  };
  function pullToken(req, token) {
    return { owner: req.owner, key: req.key, token, maxMs: req.maxMs, kind: req.kind, sync: req.sync, preempt: req.preempt };
  }
  s.syncUpdates = [];
  s.updateSync = (token, sync) => { s.syncUpdates.push({ token, sync }); return true; };
  s.finish = (token, o = {}) => {
    s.finishes.push({ token, endedBy: (o && o.endedBy) || 'natural' });
    if (!s.current || String(s.current.token) !== String(token)) return false;
    s.current = null;
    return true;
  };
  s.status = () => ({
    current: s.current ? Object.assign({}, s.current) : null,
    queue: s.queue.map((q) => Object.assign({}, q)),
    pending: null,
  });
  // 测试用：让排队的节目单「开演」
  s.admit = () => { s.current = s.queue.shift() || s.current; };
  return s;
}

function makeFakes(clock, plan = {}) {
  const rec = { segments: [], lines: [], sfx: [], fades: [], logs: [], telemetry: [] };
  const api = {
    rec,
    playSegment: (seg) => {
      rec.segments.push(String(seg));
      if (plan.onSegment) plan.onSegment(String(seg), api);
      return true;
    },
    speak: async (line) => {
      rec.lines.push(String(line));
      const dur = Number(plan.lineMs && plan.lineMs[line]) || 0;
      if (dur > 0) clock.advance(dur);
      if (plan.onSpeak) await plan.onSpeak(String(line), api);
      if (plan.hangSpeak) return new Promise(() => {});
      return { ms: dur || 1 };
    },
    sfx: (id) => { rec.sfx.push(String(id)); if (plan.sfxThrows) throw new Error('sfx down'); },
    fadeOut: (ms) => { rec.fades.push(Number(ms)); clock.advance(ms); },
    log: (line) => rec.logs.push(String(line)),
    telemetry: (evt) => rec.telemetry.push(evt),
  };
  return api;
}

const P = {
  id: 'curious-then-proud',
  title: '疑惑→得意',
  license: 'original',
  beats: [
    { seg: '01-curiosity', maxMs: 14000, line: '诶……这是什么东西？', transitionMs: 400 },
    { seg: '03-pride', maxMs: 14000, line: '哼哼，我早就知道了。', sfx: '07' },
  ],
};

(async () => {
  const R = await import(file('perf/program-runner.mjs'));
  const {
    createProgramRunner, validateProgram, normalizePrograms, PROGRAM_LIMITS,
    DEFAULT_TRANSITION_MS, INTERRUPT_FADE_MS, MIN_BEAT_RATIO, LINE_TAIL_MS,
  } = R;
  const { CHOREO_DATA } = await import(file('choreo-performances.mjs'));
  const knownSeg = (seg) => Object.prototype.hasOwnProperty.call(CHOREO_DATA.performances, String(seg));

  // ── ① 校验器 ────────────────────────────────────────────────────────
  const vOk = validateProgram(P, { isKnownSegment: knownSeg });
  ok('校验：示例数据通过', vOk.ok === true, vOk.errors.join('；'));
  eq('校验：总时长 = 两段 maxMs 之和', vOk.totalMs, 28000);
  eq('校验：规整后的段顺序', vOk.beats.map((b) => b.seg), ['01-curiosity', '03-pride']);
  eq('校验：缺省 transitionMs 回落到 400', vOk.beats[1].transitionMs, DEFAULT_TRANSITION_MS);
  eq('校验：line 原样保留', vOk.beats[1].line, '哼哼，我早就知道了。');
  ok('校验：未知 seg 报错', validateProgram({
    id: 'x', beats: [{ seg: '99-nope', maxMs: 3000 }],
  }, { isKnownSegment: knownSeg }).errors.some((e) => /不在 CHOREO_DATA/.test(e)));
  ok('校验：段数 >3 报错', validateProgram({
    id: 'x', beats: [0, 1, 2, 3].map(() => ({ seg: '01-curiosity', maxMs: 3000 })),
  }, { isKnownSegment: knownSeg }).errors.some((e) => /段数/.test(e)));
  ok('校验：总时长 >90s 报错（4×25s）', validateProgram({
    id: 'x', beats: [0, 1, 2, 3].map(() => ({ seg: '01-curiosity', maxMs: 25000 })),
  }).errors.some((e) => /总时长/.test(e)));
  ok('校验：台词 >60 字报错', validateProgram({
    id: 'x', beats: [{ seg: '01-curiosity', maxMs: 3000, line: '字'.repeat(61) }],
  }).errors.some((e) => /60 字/.test(e)));
  ok('校验：台词含换行报错', validateProgram({
    id: 'x', beats: [{ seg: '01-curiosity', maxMs: 3000, line: 'a\nb' }],
  }).errors.some((e) => /换行/.test(e)));
  ok('校验：id 非法报错', validateProgram({
    id: '带空格 的 id', beats: [{ seg: '01-curiosity', maxMs: 3000 }],
  }).errors.some((e) => /id 只能/.test(e)));
  ok('校验：license 非 original 报错', validateProgram({
    id: 'x', license: 'CC-BY', beats: [{ seg: '01-curiosity', maxMs: 3000 }],
  }).errors.some((e) => /license/.test(e)));
  ok('校验：maxMs 越界报错', validateProgram({
    id: 'x', beats: [{ seg: '01-curiosity', maxMs: 999999 }],
  }).errors.some((e) => /maxMs/.test(e)));
  ok('校验：sfx 非法报错', validateProgram({
    id: 'x', beats: [{ seg: '01-curiosity', maxMs: 3000, sfx: '../../etc' }],
  }).errors.some((e) => /sfx/.test(e)));
  ok('校验：缺 beats 报错', validateProgram({ id: 'x' }).errors.length > 0);
  eq('normalizePrograms：数组 → Map', [...normalizePrograms([P]).keys()], ['curious-then-proud']);
  eq('上限常量与 ADR 一致', [PROGRAM_LIMITS.maxBeats, PROGRAM_LIMITS.totalMs, PROGRAM_LIMITS.lineChars], [3, 90000, 60]);

  // ── ② 正常串接 ──────────────────────────────────────────────────────
  {
    const clock = makeClock();
    const sched = makeScheduler();
    const f = makeFakes(clock, { lineMs: { '诶……这是什么东西？': 500, '哼哼，我早就知道了。': 500 } });
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: sched, programs: [P],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
      log: f.log, telemetry: f.telemetry,
      syncFor: (seg) => ({ relaxPrec: [], seg }),
      budget: { takeProgram: () => ({ ok: true, left: 1 }), left: () => 1 },
    });
    let mid = null;
    const res = runner.start('curious-then-proud');
    ok('启动：ok + started', res.ok === true && res.status === 'started', JSON.stringify(res));
    eq('启动：claim 的形状（owner/kind/preempt/maxMs）',
      [sched.calls[0].owner, sched.calls[0].kind, sched.calls[0].preempt, sched.calls[0].maxMs],
      ['program', 'segmented', false, 28000]);
    ok('启动：sync 取 firstSeg', sched.calls[0].sync && sched.calls[0].sync.seg === '01-curiosity');
    eq('启动：status() 在演', [runner.status().active, runner.status().programId], [true, 'curious-then-proud']);
    await runner.idle();
    eq('串接：段顺序', f.rec.segments, ['01-curiosity', '03-pride']);
    // P1-5（对抗审计）：换段时必须把当前 claim 的 relax 表切到新段
    eq('串接：每段都 updateSync（seg 依次）', sched.syncUpdates.map((u) => u.sync && u.sync.seg),
      ['01-curiosity', '03-pride']);
    eq('串接：台词顺序', f.rec.lines, ['诶……这是什么东西？', '哼哼，我早就知道了。']);
    eq('串接：sfx 只播声明的那个', f.rec.sfx, ['07']);
    eq('串接：fadeOut = 段间 400 + 收尾 400', f.rec.fades, [400, 400]);
    eq('结束：scheduler.finish endedBy=natural', sched.finishes, [{ token: 's1', endedBy: 'natural' }]);
    const st = runner.status();
    eq('结束：状态归位', [st.active, st.beatIdx, st.lastEndedBy, st.plays], [false, -1, 'natural', 1]);
    const beats = f.rec.telemetry.filter((e) => e.scope === 'beat');
    eq('遥测：两段 beat', beats.map((b) => [b.beatIdx, b.beatKey]), [[0, '01-curiosity'], [1, '03-pride']]);
    ok('遥测：字段齐全', beats.every((b) => b.kind === 'perf.program' && typeof b.lineLen === 'number'
      && typeof b.actualMs === 'number' && b.endedBy === 'natural'), JSON.stringify(beats[0]));
    eq('遥测：lineLen 按字数（中文 1 字 1 个）', beats[0].lineLen, Array.from('诶……这是什么东西？').length);
    const end = f.rec.telemetry.find((e) => e.scope === 'program' && e.phase === 'end');
    ok('遥测：program end 带 total/endedBy', Boolean(end) && end.endedBy === 'natural' && end.plannedMs === 28000);
    const startEvt = f.rec.telemetry.find((e) => e.scope === 'program' && e.phase === 'start');
    ok('遥测：program start 先于 beat', Boolean(startEvt) && f.rec.telemetry.indexOf(startEvt) === 0);
    // 段时长地板（0.6×14000=8400）> 台词 500+800 → 跟地板走：段素材的弧必须演完
    eq('时序：每段 = 地板 8400（台词 500 远短于地板）', beats.map((b) => b.actualMs), [8400, 8400]);
    ok('时序：整条实际 17600ms（8400 + 400 过渡 + 8400 + 400 收尾）', end && end.actualMs === 17600,
      end && String(end.actualMs));
  }

  // ── ③ 用户输入 → 下一 relax（句边界）停，不是硬切 ─────────────────────
  {
    const clock = makeClock();
    const sched = makeScheduler();
    const f = makeFakes(clock, {
      lineMs: { '诶……这是什么东西？': 1200, '哼哼，我早就知道了。': 500 },
      onSpeak: (line, api) => {
        // 用户在第一句说到 600ms 时开口
        if (line === '诶……这是什么东西？') { api.interrupt = true; runner.notifyUserInput(); }
      },
    });
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: sched, programs: [P],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
      log: f.log, telemetry: f.telemetry,
    });
    f.rec.lines.length = 0;
    runner.start('curious-then-proud');
    await runner.idle();
    eq('中断：第一段仍完整说完（不硬切句）', f.rec.lines, ['诶……这是什么东西？']);
    eq('中断：第二段没开演', f.rec.segments, ['01-curiosity']);
    eq('中断：fadeOut 只有收势 400', f.rec.fades, [400]);
    ok('中断：endedBy=interrupt 进遥测', f.rec.telemetry.some((e) => e.scope === 'program' && e.endedBy === 'interrupt'));
    ok('中断：beat 遥测也标 interrupt', f.rec.telemetry.some((e) => e.scope === 'beat' && e.endedBy === 'interrupt'));
    eq('中断：scheduler.finish endedBy=interrupt', sched.finishes[0] && sched.finishes[0].endedBy, 'interrupt');
    const beatEvt = f.rec.telemetry.find((e) => e.scope === 'beat');
    ok('中断：句子说完就停（beat 实际 1200ms，不是跑满 1300ms 的 beat）',
      beatEvt && beatEvt.actualMs === 1200, JSON.stringify(beatEvt));
  }

  // ── ④ 用户输入落在「尾巴」→ 段末（relax）停 ───────────────────────────
  {
    const clock = makeClock();
    const sched = makeScheduler();
    let ticks = 0;
    let runner = null;
    const f = makeFakes(clock, {});
    const prog = {
      id: 'no-line', title: '无声两段', license: 'original',
      beats: [
        { seg: '01-curiosity', maxMs: 2000 },
        { seg: '03-pride', maxMs: 2000 },
      ],
    };
    runner = createProgramRunner({
      now: clock.now,
      wait: (ms) => clock.wait(ms).then(() => {
        ticks += 1;
        if (ticks === 5) runner.notifyUserInput();   // 第 5 片（≈500ms）时用户开口
      }),
      scheduler: sched, programs: [prog],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
      log: f.log, telemetry: f.telemetry,
    });
    runner.start('no-line');
    await runner.idle();
    eq('尾巴中断：只演第一段', f.rec.segments, ['01-curiosity']);
    const b4 = f.rec.telemetry.find((e) => e.scope === 'beat');
    eq('尾巴中断：停在本段结束（地板 0.6×2000=1200ms），不是第 5 片就切', b4 && b4.actualMs, 1200);
    ok('尾巴中断：endedBy=interrupt', f.rec.telemetry.some((e) => e.scope === 'beat' && e.endedBy === 'interrupt'));
  }

  // ── ⑤ 作者静止点（relaxMsFor）可提前停 ───────────────────────────────
  {
    const clock = makeClock();
    const sched = makeScheduler();
    let ticks = 0;
    let runner = null;
    const f = makeFakes(clock, {});
    const prog = { id: 'relaxy', title: 'r', beats: [{ seg: '01-curiosity', maxMs: 5000 }] };
    runner = createProgramRunner({
      now: clock.now,
      wait: (ms) => clock.wait(ms).then(() => {
        ticks += 1;
        if (ticks === 2) runner.notifyUserInput();   // 200ms 时开口
      }),
      scheduler: sched, programs: [prog],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
      log: f.log, telemetry: f.telemetry,
      relaxMsFor: () => [600, 1500],                 // 作者静止点
    });
    runner.start('relaxy');
    await runner.idle();
    const b5 = f.rec.telemetry.find((e) => e.scope === 'beat');
    eq('静止点：在 600ms 的 relax 点停（不是 200ms 也不是 5000ms）', b5 && b5.actualMs, 600);
    eq('静止点：只演一段就收', f.rec.segments, ['01-curiosity']);
  }

  // ── ⑥ 手动 stop：立刻收势 ───────────────────────────────────────────
  {
    const clock = makeClock();
    const sched = makeScheduler();
    const f = makeFakes(clock, {
      hangSpeak: true,
      onSpeak: (line, api) => { api.runner.stop('user'); },   // 台词刚起就点「停」
    });
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: sched, programs: [P],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
      log: f.log, telemetry: f.telemetry,
    });
    f.runner = runner;
    f.rec.lines.length = 0;
    runner.start('curious-then-proud');
    await runner.idle();
    eq('手动停：立刻收势 400（不等 7s 台词超时）', f.rec.fades, [INTERRUPT_FADE_MS]);
    eq('手动停：第二段没演', f.rec.segments, ['01-curiosity']);
    eq('手动停：endedBy=interrupt', sched.finishes[0] && sched.finishes[0].endedBy, 'interrupt');
    ok('手动停：没等台词上限（maxMs/2=7000）', (() => {
      const b = f.rec.telemetry.find((e) => e.scope === 'beat' && e.beatIdx === 0);
      return Boolean(b) && b.actualMs < 500;
    })(), JSON.stringify(f.rec.telemetry.find((e) => e.scope === 'beat')));
    eq('手动停：stop() 在空闲时返回 idle', runner.stop('user').reason, 'idle');
    eq('中断：notifyUserInput 空闲时返回 idle', runner.notifyUserInput().reason, 'idle');
  }

  // ── ⑦ 台词超时 / 异常：不卡死 ────────────────────────────────────────
  {
    const clock = makeClock();
    const sched = makeScheduler();
    const f = makeFakes(clock, { hangSpeak: true });
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: sched, programs: [P],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
      log: f.log, telemetry: f.telemetry,
    });
    runner.start('curious-then-proud');
    await runner.idle();
    ok('超时：超时后继续演（两段都过）', f.rec.segments.length === 2, JSON.stringify(f.rec.segments));
    ok('超时：日志有 line-timeout', f.rec.logs.some((l) => /台词超时/.test(l)), f.rec.logs.join(' | ').slice(0, 120));
    ok('超时：总时长有界（两段各地板 8400 + 过渡/收势）', clock.t <= 8400 * 2 + 400 * 2 + 100, 'clock=' + clock.t);
    ok('超时：台词超时后段仍按地板演完', f.rec.telemetry.filter((e) => e.scope === 'beat')
      .every((b) => b.actualMs === 8400), JSON.stringify(f.rec.telemetry.filter((e) => e.scope === 'beat').map((b) => b.actualMs)));
    eq('超时：仍按 natural 结束', runner.status().lastEndedBy, 'natural');
  }
  {
    const clock = makeClock();
    const sched = makeScheduler();
    const f = makeFakes(clock, {});
    f.speak = () => Promise.reject(new Error('tts down'));
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: sched, programs: [P],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
      log: f.log, telemetry: f.telemetry,
    });
    runner.start('curious-then-proud');
    await runner.idle();
    eq('台词异常：两段照演', f.rec.segments, ['01-curiosity', '03-pride']);
    ok('台词异常：日志留痕', f.rec.logs.some((l) => /台词异常/.test(l)));
  }

  // ── ⑧ 预算 / 未知 id / busy / 调度器拒绝 / 未启用 ────────────────────
  {
    const clock = makeClock();
    const sched = makeScheduler();
    const f = makeFakes(clock, {});
    let released = 0;
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: sched, programs: [P],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
      budget: { takeProgram: () => ({ ok: false, reason: 'budget', left: 0 }), left: () => 0, releaseProgram: () => { released += 1; } },
    });
    const r = runner.start('curious-then-proud');
    eq('预算：耗尽 → {ok:false, reason:budget}', [r.ok, r.reason], [false, 'budget']);
    eq('预算：被拒不碰调度器', sched.calls.length, 0);
    eq('预算：不知道 id → unknown-program', runner.start('nope').reason, 'unknown-program');
    eq('预算：空 id → unknown-program', runner.start('').reason, 'unknown-program');
  }
  {
    const clock = makeClock();
    const f = makeFakes(clock, {});
    const sched = makeScheduler({ rejectWith: 'busy' });
    let released = 0;
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: sched, programs: [P],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
      budget: { takeProgram: () => ({ ok: true, left: 0 }), releaseProgram: () => { released += 1; } },
    });
    const r = runner.start('curious-then-proud');
    eq('调度器拒绝：透传 reason', [r.ok, r.reason], [false, 'busy']);
    eq('调度器拒绝：退还额度', released, 1);
  }
  {
    const clock = makeClock();
    const f = makeFakes(clock, {});
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: null, programs: [P],
      playSegment: f.playSegment, speak: f.speak,
    });
    eq('未启用调度器：scheduler-off', runner.start('curious-then-proud').reason, 'scheduler-off');
  }
  {
    const clock = makeClock();
    const sched = makeScheduler();
    const f = makeFakes(clock, { lineMs: { '诶……这是什么东西？': 100, '哼哼，我早就知道了。': 100 } });
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: sched, programs: [P],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
    });
    runner.start('curious-then-proud');
    const second = runner.start('curious-then-proud');
    eq('busy：同一条在演时再点 → busy', [second.ok, second.reason], [false, 'busy']);
    await runner.idle();
  }

  // ── ⑨ 排队（pending）路径 ────────────────────────────────────────────
  {
    const clock = makeClock();
    const sched = makeScheduler({ pending: true });
    const f = makeFakes(clock, { lineMs: { '诶……这是什么东西？': 100, '哼哼，我早就知道了。': 100 } });
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: sched, programs: [P],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
      pollMs: 100, startWaitMs: 5000,
    });
    const r = runner.start('curious-then-proud');
    eq('排队：返回 pending', [r.ok, r.status, r.pending], [true, 'pending', true]);
    eq('排队：还没开演', f.rec.segments, []);
    sched.admit();
    await runner.idle();
    eq('排队：开演后两段都演', f.rec.segments, ['01-curiosity', '03-pride']);
  }
  {
    const clock = makeClock();
    const sched = makeScheduler({ pending: true });
    const f = makeFakes(clock, {});
    let released = 0;
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: sched, programs: [P],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
      budget: { takeProgram: () => ({ ok: true, left: 0 }), releaseProgram: () => { released += 1; } },
    });
    runner.start('curious-then-proud');
    const st = runner.stop('user');
    ok('排队中停止：ok', st.ok === true);
    await runner.idle();
    eq('排队中停止：退还额度', released, 1);
    eq('排队中停止：一段都没演', f.rec.segments, []);
  }

  // ── ⑨b claim 被顶掉（用户手点场景/长表演）→ 立刻收手，不淡掉接替者 ──────
  {
    const clock = makeClock();
    const sched = makeScheduler();
    const f = makeFakes(clock, {});
    let ticks = 0;
    const prog = { id: 'two', title: 't', beats: [{ seg: '01-curiosity', maxMs: 3000 }, { seg: '03-pride', maxMs: 3000 }] };
    const runner = createProgramRunner({
      now: clock.now,
      wait: (ms) => clock.wait(ms).then(() => {
        ticks += 1;
        if (ticks === 5) sched.current = { owner: 'manual', key: '03-pride', token: 'other' };  // 被人抢走
      }),
      scheduler: sched, programs: [prog],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
      log: f.log, telemetry: f.telemetry,
    });
    runner.start('two');
    await runner.idle();
    eq('claim 丢失：只演第一段', f.rec.segments, ['01-curiosity']);
    eq('claim 丢失：不再收势（避免淡掉新 owner）', f.rec.fades, []);
    eq('claim 丢失：endedBy=interrupt', runner.status().lastEndedBy, 'interrupt');
    ok('claim 丢失：日志留痕', f.rec.logs.some((l) => /claim 已被顶掉|claim 在段/.test(l)));
  }

  // ── ⑩ 段不存在 / sfx 抛错 / reset ────────────────────────────────────
  {
    const clock = makeClock();
    const sched = makeScheduler();
    const f = makeFakes(clock, { sfxThrows: true, lineMs: { '诶……这是什么东西？': 50, '哼哼，我早就知道了。': 50 } });
    f.playSegment = (seg) => { f.rec.segments.push(seg); return seg !== '03-pride'; };
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: sched, programs: [P],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut, log: f.log,
    });
    runner.start('curious-then-proud');
    await runner.idle();
    ok('段拒绝播放：记日志但继续', f.rec.logs.some((l) => /段不存在/.test(l)));
    ok('sfx 抛错：不影响收尾', runner.status().lastEndedBy === 'natural');
  }
  {
    const clock = makeClock();
    const sched = makeScheduler();
    const f = makeFakes(clock, { hangSpeak: true, onSpeak: () => {} });
    const runner = createProgramRunner({
      now: clock.now, wait: clock.wait, scheduler: sched, programs: [P],
      playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
    });
    runner.start('curious-then-proud');
    runner.reset();
    await runner.idle();
    eq('reset：状态清空', [runner.status().active, runner.status().programId], [false, '']);
    eq('reset：不再演第二段', f.rec.segments, ['01-curiosity']);
  }

  // ── ⑪ 真数据 + check-programs ───────────────────────────────────────
  {
    const dir = path.join(ROOT, 'pet-runtime', 'data', 'programs');
    const files = fs.readdirSync(dir).filter((n) => /\.json$/.test(n));
    eq('数据：两条节目单', files.sort(), ['curious-then-proud.json', 'shy-then-happy.json']);
    const docs = files.map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
    const vs = docs.map((d) => validateProgram(d, { isKnownSegment: knownSeg }));
    ok('数据：两条都过校验', vs.every((v) => v.ok), vs.flatMap((v) => v.errors).join('；'));
    ok('数据：段数 ≤3、总时长 ≤90s', vs.every((v) => v.beats.length <= 3 && v.totalMs <= 90000));
    ok('数据：每段 key 都在 CHOREO_DATA', docs.every((d) => d.beats.every((b) => knownSeg(b.seg))));
    ok('数据：每条都有台词（节目单是「事件」不是背景动画）', docs.every((d) => d.beats.every((b) => b.line)));
    ok('数据：license 都是 original', docs.every((d) => d.license === 'original'));
    const run = spawnSync(process.execPath, [path.join(ROOT, 'pet-runtime', 'tools', 'check-programs.mjs')], { encoding: 'utf8' });
    eq('check-programs：退出码 0', run.status, 0);
    ok('check-programs：报告两条通过', /2 条节目单全部通过/.test(String(run.stdout || '')), String(run.stdout || '').slice(-120));
  }

  // ── ⑪b 段时长地板（2026-11-25 真机缺陷回归）────────────────────────────
  // 现象：TTS 静音/短句时 lineMs≈0 → beat 只有 800ms，14s 素材的叙事弧完全没演到，
  // 用户看到「3 秒内 natural 结束，两段各 1 秒」。修法：beat ≥ min(beatMax, 0.6×beatMax)。
  {
    const mk = (prog, plan, extra = {}) => {
      const clock = makeClock();
      const sched = makeScheduler();
      const f = makeFakes(clock, plan);
      const runner = createProgramRunner(Object.assign({
        now: clock.now, wait: clock.wait, scheduler: sched, programs: [prog],
        playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
        log: f.log, telemetry: f.telemetry,
      }, extra));
      return { clock, sched, f, runner };
    };
    const one = (maxMs, line) => ({
      id: 'one', title: '一段', beats: [{ seg: '01-curiosity', maxMs, line }],
    });
    eq('地板：比例常量 0.6', MIN_BEAT_RATIO, 0.6);

    // 静音（lineMs≈0）→ 地板 0.6×14000=8400，绝不是 800
    {
      const { f, runner } = mk(one(14000, '诶'), {});   // speak 立即返回（无时长）
      runner.start('one');
      await runner.idle();
      const b = f.rec.telemetry.find((e) => e.scope === 'beat');
      eq('地板：静音时 beat = 8400（0.6×14000）', b && b.actualMs, 8400);
      ok('地板：静音时不再退化成 800ms（真机缺陷）', b && b.actualMs !== LINE_TAIL_MS, JSON.stringify(b));
      eq('地板：fadeOut 仍是收尾 400（段间过渡不受影响）', f.rec.fades, [INTERRUPT_FADE_MS]);
    }
    // 台词 3s + beatMax 4000 → max(3800, 2400) = 3800（台词主导）
    {
      const { f, runner } = mk(one(4000, 'a'), { lineMs: { a: 3000 } });
      runner.start('one');
      await runner.idle();
      const b = f.rec.telemetry.find((e) => e.scope === 'beat');
      eq('地板：台词 3s + beatMax 4s → 3800（台词+余韵 > 地板 2400）', b && b.actualMs, 3800);
    }
    // 台词 3s + beatMax 14000 → 地板 8400 更大
    {
      const { f, runner } = mk(one(14000, 'a'), { lineMs: { a: 3000 } });
      runner.start('one');
      await runner.idle();
      const b = f.rec.telemetry.find((e) => e.scope === 'beat');
      eq('地板：台词 3s + beatMax 14s → 8400（地板主导）', b && b.actualMs, 8400);
    }
    // 台词远超段（20s，实际被 maxMs/2 截断）→ beat 不超过 beatMax
    {
      const clock = makeClock();
      const sched = makeScheduler();
      const f = makeFakes(clock, {});
      f.speak = async () => { await clock.wait(20000); };
      const runner = createProgramRunner({
        now: clock.now, wait: clock.wait, scheduler: sched, programs: [one(14000, 'a')],
        playSegment: f.playSegment, speak: f.speak, sfx: f.sfx, fadeOut: f.fadeOut,
        log: f.log, telemetry: f.telemetry,
      });
      runner.start('one');
      await runner.idle();
      const b = f.rec.telemetry.find((e) => e.scope === 'beat');
      ok('地板：台词 20s 时 beat 仍 ≤ beatMax 14s', b && b.actualMs <= 14000 && b.beatMs <= 14000, JSON.stringify(b));
      ok('地板：20s 台词被 maxMs/2 截断（不卡死）', f.rec.logs.some((l) => /台词超时/.test(l)));
    }
    // minBeatMs 注入：2000 / 0（旧行为）/ 99999（封顶）
    {
      const { f, runner } = mk(one(14000, 'a'), {}, { minBeatMs: 2000 });
      runner.start('one');
      await runner.idle();
      eq('minBeatMs=2000：静音时 beat = 2000', f.rec.telemetry.find((e) => e.scope === 'beat').actualMs, 2000);
    }
    {
      const { f, runner } = mk(one(14000, 'a'), {}, { minBeatMs: 0 });
      runner.start('one');
      await runner.idle();
      eq('minBeatMs=0：退回旧行为（800ms）', f.rec.telemetry.find((e) => e.scope === 'beat').actualMs, LINE_TAIL_MS);
    }
    {
      const { f, runner } = mk(one(14000, 'a'), {}, { minBeatMs: 99999 });
      runner.start('one');
      await runner.idle();
      eq('minBeatMs 超过 beatMax：封顶到 14000', f.rec.telemetry.find((e) => e.scope === 'beat').actualMs, 14000);
    }
    // 总时长按实际等待累计（不是按台词）
    {
      const prog = {
        id: 'two4', title: '两条 4s', beats: [
          { seg: '01-curiosity', maxMs: 4000, line: 'a', transitionMs: 400 },
          { seg: '03-pride', maxMs: 4000, line: 'b' },
        ],
      };
      const { f, runner } = mk(prog, { lineMs: { a: 3000, b: 3000 } });
      runner.start('two4');
      await runner.idle();
      const end = f.rec.telemetry.find((e) => e.scope === 'program' && e.phase === 'end');
      eq('总时长：按实际等待累计（3800 + 400 + 3800 + 400）', end && end.actualMs, 3800 + 400 + 3800 + 400);
      eq('总时长：两段都按台词+余韵', end && end.playedBeats, 2);
    }
  }

  // ── ⑫ entry 接线（源码扫描，不启 Electron）───────────────────────────
  {
    const src = fs.readFileSync(path.join(DESKTOP, 'petbody-entry.mjs'), 'utf8');
    ok('entry：引入 program-runner', /from '\.\/perf\/program-runner\.mjs'/.test(src));
    ok('entry：listPrograms/playProgram/stopProgram 三个口', /listPrograms\s*\(/.test(src)
      && /playProgram\s*\(/.test(src) && /stopProgram\s*\(/.test(src));
    ok('entry：program.enabled 关闭 → disabled', /reason:\s*'disabled'/.test(src));
    ok('entry：调度器关 → scheduler-off', /reason:\s*'scheduler-off'/.test(src));
    ok('entry：feedText 里通知运行器（用户开口）', /notifyUserInput\s*\(\)/.test(src));
    ok('entry：performanceDebug 暴露 program', /program:\s*programDebugSnapshot\(\)/.test(src));
    ok('entry：program claim 的视觉收势已就位', /'v2'\s*\|\|\s*ev\.from\s*===\s*'manual'\s*\|\|\s*ev\.from\s*===\s*'program'/.test(src));
    ok('entry：dispose/reset 释放节目单', /programRunner[\s\S]{0,80}reset\(/.test(src));
    // P0-3（对抗审计）：热关调度器必须先 stop program 再 reset，并把 program 交还 arbiter
    ok('entry：热关先 stop program 再 reset', /programRunner\.stop\('disabled'\)[\s\S]{0,400}perfSched\.reset\(\)/.test(src));
    ok('entry：热关交还列表含 program', /perfArbiter\.end\('program'\)/.test(src));
  }

  console.log('\n' + (fail === 0 ? '✓ 全过' : '✗ 有失败') + '：' + pass + ' 断言行通过，' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试崩溃：', e && e.stack || e);
  process.exit(1);
});
