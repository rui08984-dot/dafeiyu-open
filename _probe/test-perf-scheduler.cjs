#!/usr/bin/env node
/**
 * _probe/test-perf-scheduler.cjs —— 调度器纯模块（P2a，ADR-015 §3.1）
 *
 * 钉住（每条对应 ADR 的一行规则）：
 *   ① 优先级：program 4 > clip 3 > v2 2 > micro/ambient 1；manual/scenes 5；
 *   ② manual/scenes 立即抢占，但旧层先收势（眼/头 150ms、身体 400ms），收势期间新 owner 是 pending；
 *   ③ 自动层只在当前行为的 relax 点抢；没有 relax 或优先级不高于当前 → 排队；
 *   ③b relaxMeta（P2a2）：`inserted` 点（5s 填充）不参与抢占，只有 authored/derived 才抢；
 *      全是 inserted 或旧格式（无 relaxMeta）时退回全集，保证长段仍可打断；
 *   ④ atomic 不可被自动层打断（manual 仍可）；队列上限 4，按优先级 + 到达序；
 *   ⑤ ttl 过期丢弃；maxMs 只由 shouldEnd 提示，模块不强制结束；
 *   ⑥ 旧 API begin/end/availableFor 行为与 arbiter 逐位一致；没有 arbiter 时直通降级；
 *   ⑦ claim 不复制：每次真正开始/结束都走 arbiter.begin/end（stub 计数验证）。
 *
 * 用法：node _probe/test-perf-scheduler.cjs
 * 退出码：0 全过 / 1 有失败
 */
'use strict';

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

const V2 = { owner: 'v2', key: '01-curiosity', kind: 'segmented', maxMs: 20000, channels: ['body'] };
const V2_SYNC = { relaxMs: [4000, 8000], endMs: 20000 };
const CLIP = { owner: 'clip', key: 'lumen-0', kind: 'segmented', maxMs: 10000 };
const CLIP_SYNC = { relaxMs: [3000], endMs: 10000 };

(async () => {
  const {
    createScheduler, normalizeSync, normalizeChannels, retractMsForChannels, schedulerPriorityOf,
    MANUAL_PRIORITY, DEFAULT_QUEUE_LIMIT, SCHEDULER_OWNER_PRIORITY, loadSync, syncFor,
  } = await import(file('perf/perf-scheduler.mjs'));
  const { createPerformanceArbiter } = await import(file('perf/performance-arbiter.mjs'));

  // ── ① 优先级表 ──────────────────────────────────────────────────────
  eq('优先级：program = 4', schedulerPriorityOf('program'), 4);
  ok('优先级：program > clip > v2 > micro', schedulerPriorityOf('program') > schedulerPriorityOf('clip')
    && schedulerPriorityOf('clip') > schedulerPriorityOf('v2')
    && schedulerPriorityOf('v2') > schedulerPriorityOf('micro'));
  eq('优先级：manual = scenes = 5', [schedulerPriorityOf('manual'), schedulerPriorityOf('scenes')], [5, 5]);
  eq('优先级：ambient = 1（与 micro 同级）', schedulerPriorityOf('ambient'), 1);
  eq('优先级：未知 owner = 0', schedulerPriorityOf('nope'), 0);
  eq('优先级：MANUAL_PRIORITY 常量 = 5', MANUAL_PRIORITY, 5);
  ok('优先级：arbiter 原表未被改动（无 program）', !('program' in SCHEDULER_OWNER_PRIORITY.__proto__)
    && SCHEDULER_OWNER_PRIORITY.program === 4);

  // ── ② 纯函数：sync / channels / 收势时长 ─────────────────────────────
  eq('normalizeSync：relaxMs 原样（毫秒）', normalizeSync({ relaxMs: [3000, 1000] }).relaxMs, [1000, 3000]);
  eq('normalizeSync：relax + units=s 转毫秒', normalizeSync({ relax: [1, 2], units: 's' }).relaxMs, [1000, 2000]);
  eq('normalizeSync：end 也按 units 换算', normalizeSync({ end: 20, units: 's' }).endMs, 20000);
  eq('normalizeSync：重复点去重', normalizeSync({ relaxMs: [1000, 1000.01, 2000] }).relaxMs, [1000, 2000]);
  eq('normalizeSync：atomic 透传', normalizeSync({ atomic: true }).atomic, true);

  // P2a2：relaxMeta → relaxPreempt（inserted 只是 5s 填充点，不参与抢占）
  {
    const mixed = normalizeSync({
      relaxMs: [1000, 2000, 3500],
      relaxMeta: [{ t: 1000, q: 'inserted' }, { t: 2000, q: 'authored' }, { t: 3500, q: 'derived' }],
    });
    eq('normalizeSync：relaxMs 仍是全集（向后兼容）', mixed.relaxMs, [1000, 2000, 3500]);
    eq('normalizeSync：relaxPreempt 只留 authored/derived', mixed.relaxPreempt, [2000, 3500]);
    const onlyInserted = normalizeSync({
      relaxMs: [1000, 2000],
      relaxMeta: [{ t: 1000, q: 'inserted' }, { t: 2000, q: 'inserted' }],
    });
    eq('normalizeSync：全是 inserted → 退回全集（不能完全无法打断）', onlyInserted.relaxPreempt, [1000, 2000]);
    eq('normalizeSync：旧格式（无 relaxMeta）→ 全集可抢',
      normalizeSync({ relaxMs: [1000, 2000] }).relaxPreempt, [1000, 2000]);
    eq('normalizeSync：relaxMeta 缺项按可用处理（不因为缺 q 把点封掉）',
      normalizeSync({ relaxMs: [1000, 2000], relaxMeta: [{ t: 1000, q: 'inserted' }] }).relaxPreempt,
      [2000]);
  }
  eq('normalizeChannels：clip 默认只写脸', normalizeChannels('clip'), ['face']);
  ok('normalizeChannels：v2 默认含身体', normalizeChannels('v2').includes('body'));
  eq('retractMsForChannels：只有脸 → 150ms', retractMsForChannels(['face']), 150);
  eq('retractMsForChannels：含身体 → 400ms', retractMsForChannels(['face', 'body']), 400);
  eq('retractMsForChannels：空 → 150ms', retractMsForChannels([]), 150);
  eq('DEFAULT_QUEUE_LIMIT = 4', DEFAULT_QUEUE_LIMIT, 4);

  // ── ③ 直通（没有 arbiter 也不抛）─────────────────────────────────────
  {
    let now = 1000;
    const s = createScheduler({ now: () => now });
    const r = s.request(Object.assign({}, V2, { sync: V2_SYNC }));
    eq('直通：request 返回 started', [r.ok, r.status], [true, 'started']);
    eq('直通：degraded 标记', s.status().degraded, true);
    eq('直通：current.owner', s.status().current.owner, 'v2');
    eq('直通：availableFor 别的 owner = false', s.availableFor('clip'), false);
    eq('直通：availableFor 自己 = true', s.availableFor('v2'), true);
    eq('直通：finish(owner) 成功', s.finish('v2'), true);
    eq('直通：finish 后 current 为空', s.status().current, null);
    eq('直通：finish 未知 owner 返回 false', s.finish('nope'), false);
    eq('直通：finish 后 availableFor 恢复', s.availableFor('clip'), true);
  }

  // ── ③b arbiter 抛错 → 降级直通，不把表演拦死 ────────────────────────
  {
    let now = 2000;
    const boom = { begin() { throw new Error('claim broken'); }, end() { throw new Error('claim broken'); }, availableFor() { return false; } };
    const s = createScheduler({ now: () => now, arbiter: boom });
    const a = s.request(Object.assign({}, V2, { sync: V2_SYNC }));
    eq('降级：arbiter 抛错时仍能开始', [a.ok, a.status], [true, 'started']);
    eq('降级：status.degraded 如实标记', s.status().degraded, true);
    const b = s.request({ owner: 'manual', key: 'perf-manual', kind: 'segmented', maxMs: 5000 });
    eq('降级：后续请求不再反复撞同一个坏 arbiter', [b.ok, b.status], [true, 'preempting']);
    now = 2400;
    s.tick(now);
    eq('降级：收势交接照常', s.status().current.owner, 'manual');
  }

  // ── ④ relax 点抢占（clip 抢 v2）─────────────────────────────────────
  {
    let now = 1000;
    const events = [];
    const s = createScheduler({ now: () => now, onChange: (e) => events.push(e) });
    s.request(Object.assign({}, V2, { sync: V2_SYNC }));
    const r = s.request(Object.assign({}, CLIP, { sync: CLIP_SYNC }));
    eq('relax：clip 请求是 pending 而不是 started', [r.ok, r.status, r.reason], [true, 'pending', 'relax']);
    eq('relax：等待点是 v2 的下一个 relax（1000+4000）', r.relaxAt, 5000);
    ok('relax：v2 仍在演，没有被立刻切掉', s.status().current.owner === 'v2');

    now = 4999;
    s.tick(now);
    eq('relax：9 帧前还没到 relax，不收势', s.status().current.retracting, false);

    now = 5000;
    s.tick(now);
    const atRelax = s.status();
    ok('relax：到点开始收势', atRelax.current.retracting === true);
    eq('relax：收势期间旧 owner 仍持有', atRelax.current.owner, 'v2');
    eq('relax：收势期间新 owner 是 pending', atRelax.pending.owner, 'clip');
    const retractEvent = events.find((e) => e.type === 'retract');
    ok('relax：收势事件存在且 atRelax=true', Boolean(retractEvent && retractEvent.atRelax === true));
    eq('relax：v2 身体收势 400ms', retractEvent && retractEvent.ms, 400);

    now = 5399;
    s.tick(now);
    eq('relax：399ms 时还没交接', s.status().current.owner, 'v2');

    now = 5400;
    s.tick(now);
    eq('relax：400ms 后 clip 接手', s.status().current.owner, 'clip');
    eq('relax：队列已清空', s.status().queue.length, 0);
    eq('relax：换了 owner 后 availableFor(v2)=false', s.availableFor('v2'), false);

    // clip（只有脸）的下一个 relax 上，program（4>3）接手 → 收势 150ms
    now = 5400;
    const rp = s.request({ owner: 'program', key: 'prog-1', kind: 'segmented', sync: { relaxMs: [3000], endMs: 30000 }, maxMs: 30000 });
    eq('relax：program 在 clip 的 relax 点等（5400+3000）', [rp.status, rp.relaxAt], ['pending', 8400]);
    now = 8400;
    s.tick(now);
    eq('relax：clip 收势 150ms（只有脸）', s.status().current.retractRemainMs, 150);
    now = 8550;
    s.tick(now);
    eq('relax：program 接手', s.status().current.owner, 'program');
  }

  // ── ④b preempt 标记不改变「只有 manual/scenes 能立即抢」───────���─────
  {
    let now = 1000;
    const s = createScheduler({ now: () => now });
    s.request(Object.assign({}, V2, { sync: V2_SYNC }));
    const r = s.request(Object.assign({}, CLIP, { preempt: true, sync: CLIP_SYNC }));
    eq('preempt：clip 即使带 preempt 也只等 relax（用户点的片段应在 P2b 映射成 manual）',
      [r.ok, r.status, r.reason], [true, 'pending', 'relax']);
  }

  // ── ④c relaxMeta：只在真静止点抢（inserted 是 5s 填充点）─────────────
  {
    let now = 1000;
    const s = createScheduler({ now: () => now });
    const sync = normalizeSync({
      relaxMs: [1500, 3000, 6000],
      relaxMeta: [{ t: 1500, q: 'inserted' }, { t: 3000, q: 'authored' }, { t: 6000, q: 'inserted' }],
      endMs: 20000,
    });
    s.request({ owner: 'v2', key: '01-curiosity', kind: 'segmented', sync, maxMs: 20000 });
    const r = s.request(Object.assign({}, CLIP, { sync: CLIP_SYNC }));
    eq('relaxMeta：clip 等真静止点（1000+3000）而不是 inserted（1000+1500）', [r.status, r.relaxAt], ['pending', 4000]);
    eq('relaxMeta：status.nextRelaxInMs 指向真静止点', s.status().current.nextRelaxInMs, 3000);
    now = 2500;
    s.tick(now);
    eq('relaxMeta：经过 inserted 点（elapsed 1500）不收势', s.status().current.retracting, false);
    eq('relaxMeta：经过 inserted 点也不会切人', s.status().current.owner, 'v2');
    now = 4000;
    s.tick(now);
    eq('relaxMeta：到 authored 点才收势', s.status().current.retracting, true);
    now = 4400;
    s.tick(now);
    eq('relaxMeta：收势 400ms 后 clip 接手', s.status().current.owner, 'clip');
  }
  {
    // 全是 inserted 的段（旧产物/短近平坦片段）：退回全集，否则完全无法打断
    let now = 1000;
    const s = createScheduler({ now: () => now });
    const sync = normalizeSync({
      relaxMs: [2000], relaxMeta: [{ t: 2000, q: 'inserted' }], endMs: 9000,
    });
    s.request({ owner: 'v2', key: 'x', kind: 'segmented', sync, maxMs: 9000 });
    const r = s.request(Object.assign({}, CLIP, { sync: CLIP_SYNC }));
    eq('relaxMeta：全 inserted 时退回（1000+2000）', [r.status, r.relaxAt], ['pending', 3000]);
  }
  {
    // 旧格式（无 relaxMeta）：行为与 P2a 逐位一致
    let now = 1000;
    const s = createScheduler({ now: () => now });
    s.request(Object.assign({}, V2, { sync: V2_SYNC }));
    const r = s.request(Object.assign({}, CLIP, { sync: CLIP_SYNC }));
    eq('relaxMeta：旧格式（无 meta）仍按 relaxMs 等点', [r.status, r.relaxAt], ['pending', 5000]);
  }

  // ── ⑤ manual 立即抢占（收势 400ms，期间新 owner pending）─────────────
  {
    let now = 5000;
    const s = createScheduler({ now: () => now });
    s.request(Object.assign({}, V2, { sync: V2_SYNC }));
    const r = s.request({ owner: 'manual', key: 'perf-manual', kind: 'segmented', sync: { relaxMs: [], endMs: 9000 } });
    eq('manual：立即返回 preempting', [r.ok, r.status], [true, 'preempting']);
    eq('manual：旧 owner 仍在演（收势中）', s.status().current.owner, 'v2');
    eq('manual：新 owner 是 pending', s.status().pending.owner, 'manual');
    eq('manual：收势时长 400ms（v2 含身体）', r.retractMs, 400);
    now = 5399;
    s.tick(now);
    eq('manual：399ms 仍是旧 owner', s.status().current.owner, 'v2');
    now = 5400;
    s.tick(now);
    eq('manual：400ms 后新 owner 接手', s.status().current.owner, 'manual');
  }

  // ── ⑥ clip 只有脸 → 收势 150ms ──────────────────────────────────────
  {
    let now = 1000;
    const s = createScheduler({ now: () => now });
    s.request(Object.assign({}, CLIP, { sync: CLIP_SYNC }));
    const r = s.request({ owner: 'scenes', key: 'scene:撒娇', kind: 'atomic', maxMs: 4000 });
    eq('收势：scenes 抢占 clip 用 150ms', r.retractMs, 150);
    now = 1149;
    s.tick(now);
    eq('收势：149ms 未交接', s.status().current.owner, 'clip');
    now = 1150;
    s.tick(now);
    eq('收势：150ms 交接完成', s.status().current.owner, 'scenes');
  }

  // ── ⑦ atomic：自动层不可打断，manual 可以 ───────────────────────────
  {
    let now = 10000;
    const s = createScheduler({ now: () => now });
    s.request({ owner: 'scenes', key: 'scene:鼓掌', kind: 'atomic', maxMs: 4000, sync: { relaxMs: [1000, 2000] } });
    const rc = s.request(Object.assign({}, CLIP, { sync: CLIP_SYNC }));
    eq('atomic：clip 只能排队', [rc.ok, rc.status, rc.reason], [true, 'pending', 'atomic']);
    now = 11000;
    s.tick(now);
    eq('atomic：有 relax 点也不能被自动层抢', s.status().current.owner, 'scenes');
    eq('atomic：仍未收势', s.status().current.retracting, false);
    const rp = s.request({ owner: 'program', key: 'prog', kind: 'segmented', maxMs: 9000 });
    eq('atomic：program 也只能排队', rp.status, 'pending');
    const rm = s.request({ owner: 'manual', key: 'perf-manual', kind: 'segmented', maxMs: 9000 });
    eq('atomic：manual 仍可抢占', rm.status, 'preempting');
    now = 11400;
    s.tick(now);
    eq('atomic：manual 收势后接手', s.status().current.owner, 'manual');
    eq('atomic：queue 里剩下的是 program（clip 被 manual 挤满？不，先到先得）',
      s.status().queue.map((q) => q.owner).sort(), ['clip', 'program']);
  }

  // ── ⑧ 队列上限 4 条 ────────────────────────────────────────────────
  {
    let now = 1000;
    const s = createScheduler({ now: () => now });
    s.request({ owner: 'program', key: 'prog-long', kind: 'segmented', maxMs: 60000, channels: ['face'] });
    const accepted = [];
    for (let i = 0; i < 4; i += 1) accepted.push(s.request({ owner: 'micro', key: 'm' + i, kind: 'segmented', maxMs: 2000 }));
    const overflow = s.request({ owner: 'micro', key: 'm4', kind: 'segmented', maxMs: 2000 });
    eq('队列：前 4 条 pending', accepted.map((r) => r.status), ['pending', 'pending', 'pending', 'pending']);
    eq('队列：没有 relax 的排队原因是 end', accepted[0].reason, 'end');
    eq('队列：第 5 条 rejected', [overflow.ok, overflow.status, overflow.reason], [false, 'rejected', 'queue-full']);
    eq('队列：长度仍是 4', s.status().queue.length, 4);
    eq('队列：yields.micro 记了一次', s.status().yields.micro, 1);
    s.finish('program');
    eq('队列：current 结束后最靠前的一条启动（同优先级按到达序）', s.status().current.key, 'm0');
  }

  // ── ⑨ ttl 过期丢弃 ─────────────────────────────────────────────────
  {
    let now = 1000;
    const s = createScheduler({ now: () => now });
    s.request({ owner: 'program', key: 'prog', kind: 'segmented', maxMs: 60000, channels: ['face'] });
    const r = s.request({ owner: 'clip', key: 'lumen-1', kind: 'segmented', maxMs: 5000, ttlMs: 1000 });
    eq('ttl：先 pending', r.status, 'pending');
    now = 2001;
    s.tick(now);
    eq('ttl：过期后被丢弃', s.status().queue.length, 0);
    eq('ttl：记 expired', s.status().stats.expired, 1);
    eq('ttl：yields.clip 记一次', s.status().yields.clip, 1);
    const r2 = s.request({ owner: 'clip', key: 'lumen-2', kind: 'segmented', maxMs: 5000, ttlMs: 8000 });
    now = 2400;
    s.tick(now);
    eq('ttl：未过期的仍在队列', [r2.status, s.status().queue.length], ['pending', 1]);
  }

  // ── ⑩ 队列按优先级（program 4 抢在 clip 3 前）────────────────────────
  {
    let now = 1000;
    const s = createScheduler({ now: () => now });
    s.request(Object.assign({}, V2, { sync: V2_SYNC }));
    const rc = s.request(Object.assign({}, CLIP, { sync: CLIP_SYNC }));
    now = 1010;
    const rp = s.request({ owner: 'program', key: 'prog', kind: 'segmented', sync: { relaxMs: [4000], endMs: 30000 } });
    eq('排队：clip 先到', [rc.status, rc.reason], ['pending', 'relax']);
    eq('排队：program 后到但优先级高', [rp.status, rp.reason], ['pending', 'relax']);
    now = 5000;
    s.tick(now);
    eq('排队：relax 点上让 program 先上', s.status().pending.owner, 'program');
    now = 5400;
    s.tick(now);
    eq('排队：program 接手后 clip 仍在队列', [s.status().current.owner, s.status().queue.map((q) => q.owner)], ['program', ['clip']]);
  }

  // ── ⑪ 同 owner 重入 = 替换；队列内同 owner 去重 ─────────────────────
  {
    let now = 1000;
    const s = createScheduler({ now: () => now });
    const a = s.request(Object.assign({}, V2, { sync: V2_SYNC }));
    now = 1500;
    const b = s.request(Object.assign({}, V2, { sync: V2_SYNC, key: '02-vulnerable' }));
    eq('同 owner：第二次也是 started', b.status, 'started');
    ok('同 owner：token 换了', a.token !== b.token, a.token + ' → ' + b.token);
    eq('同 owner：current.key 更新', s.status().current.key, '02-vulnerable');
    eq('同 owner：没有进队列', s.status().queue.length, 0);
    eq('同 owner：started 计数 2', s.status().stats.started, 2);

    s.request({ owner: 'program', key: 'prog', kind: 'segmented', maxMs: 60000 });
    s.request(Object.assign({}, CLIP, { key: 'lumen-1', sync: CLIP_SYNC }));
    now = 1600;
    s.request(Object.assign({}, CLIP, { key: 'lumen-1', sync: CLIP_SYNC }));
    eq('同 owner 同 key：队列里只留一条（后来的顶掉先前的）',
      s.status().queue.filter((q) => q.owner === 'clip').length, 1);
    s.request(Object.assign({}, CLIP, { key: 'lumen-2', sync: CLIP_SYNC }));
    eq('同 owner 不同 key：两条都在（是两次不同的演出）',
      s.status().queue.filter((q) => q.owner === 'clip').length, 2);
  }

  // ── ⑫ shouldEnd：maxMs / sync.endMs 取小，模块不强制结束 ──────────────
  {
    let now = 1000;
    const s = createScheduler({ now: () => now });
    s.request({ owner: 'v2', key: '01', kind: 'segmented', maxMs: 1000, sync: { relaxMs: [4000], endMs: 5000 } });
    eq('shouldEnd：999ms 还不到点', s.shouldEnd(now + 999), false);
    eq('shouldEnd：1000ms 到 maxMs', s.shouldEnd(now + 1000), true);

    let now2 = 5000;
    const s2 = createScheduler({ now: () => now2 });
    s2.request({ owner: 'clip', key: 'lumen-0', kind: 'segmented', sync: { relaxMs: [], endMs: 2000 } });
    eq('shouldEnd：没给 maxMs 就用 sync.endMs', s2.shouldEnd(now2 + 1999), false);
    eq('shouldEnd：到 sync.endMs', s2.shouldEnd(now2 + 2000), true);

    now2 = 9000;
    const s3 = createScheduler({ now: () => now2 });
    s3.request({ owner: 'micro', key: 'x', kind: 'segmented' });
    eq('shouldEnd：没有上限永远 false', s3.shouldEnd(now2 + 999999), false);
    eq('shouldEnd：模块不自己结束（current 还在）', s3.status().current.owner, 'micro');
  }

  // ── ⑬ 旧 API + 真 arbiter：逐位旧行为 ───────────────────────────────
  {
    let now = 20000;
    const arb = createPerformanceArbiter({ now: () => now });
    const s = createScheduler({ now: () => now, arbiter: arb });
    const a = s.begin('clip', { key: 'lumen-0', title: '微笑', durationMs: 3000 });
    eq('旧 API：clip 拿到', [a.ok, a.owner], [true, 'clip']);
    ok('旧 API：token 是字符串', typeof a.token === 'string' && a.token.length > 0, a.token);
    eq('旧 API：claim 被 arbiter 持有', [arb.owner, arb.claim.key], ['clip', 'lumen-0']);
    eq('旧 API：会话进度也记了', arb.session.status().owner, 'clip');
    const b = s.begin('v2', { key: '01', durationMs: 20000 });
    eq('旧 API：v2 不抢占 → busy', [b.ok, b.reason], [false, 'busy']);
    eq('旧 API：busy 报告持有者', b.holder, 'clip');
    eq('旧 API：busy 时 token 为 null', b.token, null);
    const c = s.begin('scenes', { key: 'scene:x', durationMs: 3000, preempt: true });
    eq('旧 API：scenes preempt 成功', c.ok, true);
    eq('旧 API：返回 preempted 供调用方停旧层', c.preempted, 'clip');
    eq('旧 API：claim 转给 scenes', arb.owner, 'scenes');
    eq('旧 API：抢占在 arbiter 里一步完成（不是先 end 再 begin）', arb.claim.stats().preempts, 1);
    eq('旧 API：新持有者的 token 就是返回的 token', arb.token, c.token);
    eq('旧 API：end(owner, token) 释放', s.end('scenes', c.token), true);
    eq('旧 API：释放后 arbiter 为空', arb.owner, null);
    eq('旧 API：可用性 availableFor(v2)', s.availableFor('v2'), true);
    const d = s.begin('v2', { key: '01', durationMs: 20000 });
    eq('旧 API：空闲时可以拿 v2', d.ok, true);
    eq('旧 API：availableFor 别的 owner=false', s.availableFor('clip'), false);
    eq('旧 API：degraded=false（有 arbiter）', s.status().degraded, false);
    eq('旧 API：end(owner) 不传 token 也能释放', s.end('v2'), true);
    eq('旧 API：释放后 arbiter 为空（2）', arb.owner, null);
  }

  // ── ⑭ 旧 API 无 arbiter：直通（逐位旧行为，只是没人记账）────────────
  {
    let now = 1000;
    const s = createScheduler({ now: () => now });
    const a = s.begin('clip', { key: 'lumen-0', durationMs: 3000 });
    eq('旧 API 直通：clip 拿到', a.ok, true);
    const a2 = s.begin('clip', { key: 'lumen-1', durationMs: 3000 });
    eq('旧 API 直通：同 owner 重入 = refresh', [a2.ok, a2.reason], [true, 'refresh']);
    const b = s.begin('v2', { key: '01', durationMs: 20000 });
    eq('旧 API 直通：别的 owner 不抢占 → busy', [b.ok, b.reason], [false, 'busy']);
    const c = s.begin('scenes', { key: 'scene:y', durationMs: 3000, preempt: true });
    eq('旧 API 直通：preempt 生效', [c.ok, c.preempted], [true, 'clip']);
    eq('旧 API 直通：队列长度始终 0（旧 API 不排队）', s.status().queue.length, 0);
  }

  // ── ⑮ claim 不复制：每次切换都走 arbiter.begin/end ───────────────────
  {
    let now = 30000;
    const calls = { begin: [], end: [] };
    const stub = {
      begin(owner, meta) { calls.begin.push({ owner, key: meta && meta.key }); return { ok: true, token: (meta && meta.token) || 'x' }; },
      end(owner, token) { calls.end.push({ owner, token }); return true; },
      availableFor() { return true; },
    };
    const s = createScheduler({ now: () => now, arbiter: stub });
    s.request(Object.assign({}, V2, { sync: V2_SYNC }));
    eq('委托：启动调了一次 arbiter.begin', [calls.begin.length, calls.begin[0].owner], [1, 'v2']);
    s.request(Object.assign({}, CLIP, { sync: CLIP_SYNC }));
    eq('委托：pending 阶段不碰 arbiter', calls.begin.length, 1);
    now = 34000;
    s.tick(now);
    eq('委托：收势期间也不提前 begin（旧层还在写）', calls.begin.length, 1);
    now = 34400;
    s.tick(now);
    eq('委托：交接时先 end 旧再 begin 新', [calls.end.length, calls.begin.length], [1, 2]);
    eq('委托：end 的是旧 owner', calls.end[0].owner, 'v2');
    eq('委托：begin 的是新 owner', calls.begin[1].owner, 'clip');
    s.finish('clip');
    eq('委托：finish 也走 arbiter.end', [calls.end.length, calls.end[1].owner], [2, 'clip']);
    const beforeRefresh = { begin: calls.begin.length, end: calls.end.length };
    s.request(Object.assign({}, CLIP, { key: 'lumen-9', sync: CLIP_SYNC }));
    eq('委托：同 owner 重入只 refresh（先 begin 后不做多余的 end）',
      [calls.begin.length, calls.end.length], [beforeRefresh.begin + 1, beforeRefresh.end]);
  }

  // ── ⑯ cancel / 峰值字段 ────────────────────────────────────────────
  {
    let now = 40000;
    const s = createScheduler({ now: () => now });
    s.request({ owner: 'program', key: 'prog', kind: 'segmented', maxMs: 60000, channels: ['face'] });
    const q = s.request(Object.assign({}, CLIP, { sync: CLIP_SYNC }));
    eq('cancel：队列里的 token 取消成功', s.cancel(q.token), true);
    eq('cancel：队列空了', s.status().queue.length, 0);
    eq('cancel：未知 token 返回 false', s.cancel('s999'), false);
    eq('cancel：current 也能取消', s.cancel('program'), true);
    eq('cancel：取消后 current 为空', s.status().current, null);
  }

  // ── ⑰ current 的 ttl 到点自动释放 ──────────────────────────────────
  {
    let now = 50000;
    const s = createScheduler({ now: () => now });
    s.request({ owner: 'v2', key: '01', kind: 'segmented', maxMs: 20000, ttlMs: 1000 });
    now = 51001;
    s.tick(now);
    eq('ttl(current)：到点自动释放', s.status().current, null);
    eq('ttl(current)：记 expired', s.status().stats.expired, 1);
  }

  // ── ⑱ status 形状（P2b 调试面板直接读）──────────────────────────────
  {
    let now = 60000;
    const s = createScheduler({ now: () => now });
    const st0 = s.status();
    ok('status：空闲时 current=null 且字段齐全', st0.current === null
      && Array.isArray(st0.queue) && typeof st0.yields === 'object'
      && typeof st0.stats === 'object' && st0.pending === null);
    eq('status：queueLimit 透出', st0.queueLimit, DEFAULT_QUEUE_LIMIT);
    s.request(Object.assign({}, V2, { sync: V2_SYNC }));
    const st = s.status();
    ok('status：current 含 nextRelaxInMs/retracting/shouldEnd',
      st.current && 'nextRelaxInMs' in st.current && 'retracting' in st.current && 'shouldEnd' in st.current);
    eq('status：nextRelaxInMs = 4000', st.current.nextRelaxInMs, 4000);
    eq('status：remainMs = 20000', st.current.remainMs, 20000);
  }

  // ── ⑲ perf-sync 读入口（P2b 接线用，缺文件即退化）───────────────────
  {
    eq('loadSync：无 readFile → null 不抛', loadSync({ file: 'perf-sync.json' }), null);
    const fakeDoc = { version: 1, items: { '01-curiosity': { relaxMs: [500, 4500], endMs: 20200, atomic: false } } };
    const loaded = loadSync({ file: 'x.json', readFile: () => JSON.stringify(fakeDoc) });
    ok('loadSync：可注入 readFile', Boolean(loaded && loaded.items));
    const sync = syncFor(loaded, '01-curiosity');
    eq('syncFor：转成调度器形状（毫秒）', sync && sync.relaxMs, [500, 4500]);
    eq('syncFor：endMs 透传', sync && sync.endMs, 20200);
    eq('syncFor：缺 key → null', syncFor(loaded, 'nope'), null);
    const fakeV2 = {
      version: 2,
      items: { '06-finger-articulation': {
        relaxMs: [3500, 7000, 16870],
        relaxMeta: [{ t: 3500, q: 'inserted' }, { t: 7000, q: 'derived' }, { t: 16870, q: 'authored' }],
        endMs: 18820,
        atomic: false,
      } },
    };
    const doc2 = loadSync({ file: 'x.json', readFile: () => JSON.stringify(fakeV2) });
    const s2 = syncFor(doc2, '06-finger-articulation');
    eq('syncFor：透传 relaxMs 全集', s2.relaxMs, [3500, 7000, 16870]);
    eq('syncFor：relaxPreempt 去掉 inserted', s2.relaxPreempt, [7000, 16870]);
  }

  // ── ⑧ 非精确帧钟：relax 用「区间跨过」判定（2026-11-25 对抗审计 P0-1）────
  {
    let t = 0;
    const s = createScheduler({ now: () => t });
    const r1 = s.request({ owner: 'v2', key: 'v2a', kind: 'segmented', sync: { relaxMs: [1000], relaxPreempt: [1000] }, maxMs: 5000 });
    const r2 = s.request({ owner: 'clip', key: 'clipa', kind: 'atomic', maxMs: 3000 });
    ok('v2 先开演、clip 排进队列', r1.ok === true && r1.status === 'started' && r2.ok === true, JSON.stringify([r1.status, r2.status]));
    let tookAt = -1;
    for (t = 0; t <= 2000; t += 16.7) {
      s.tick(t);
      const st = s.status();
      if (st.current && st.current.owner === 'clip') { tookAt = t; break; }
    }
    ok('16.7ms 步进跨过 relax → clip 最终接管（含默认 400ms 收势）', tookAt >= 1000 && tookAt < 1600, 't=' + tookAt);
  }

  // ── ⑨ updateSync：换段后 relax 表跟着换 ─────────────────────────────
  {
    let t = 0;
    const s = createScheduler({ now: () => t });
    const r = s.request({ owner: 'v2', key: 'seg1', kind: 'segmented', sync: { relaxMs: [1000], relaxPreempt: [1000] }, maxMs: 9000 });
    s.request({ owner: 'clip', key: 'c1', kind: 'atomic', maxMs: 3000 });
    ok('updateSync 命中当前 token', s.updateSync(r.token, { relaxMs: [5000], relaxPreempt: [5000] }) === true);
    let early = -1;
    for (t = 0; t <= 1500; t += 16.7) {
      s.tick(t);
      const st = s.status();
      if (st.current && st.current.owner === 'clip') { early = t; break; }
    }
    ok('旧 relax 点（1000）不再触发', early === -1, 't=' + early);
    let late = -1;
    for (; t <= 5600; t += 16.7) {
      s.tick(t);
      const st = s.status();
      if (st.current && st.current.owner === 'clip') { late = t; break; }
    }
    ok('新 relax 点（5000）触发（+400ms 收势）', late >= 5000 && late < 5700, 't=' + late);
    ok('updateSync 错 token → false', s.updateSync('nope', {}) === false);
  }

  // ── ⑩ reset 把 current/queue 都发事件（schedPending 不泄漏）──────────
  {
    const events = [];
    const s = createScheduler({ now: () => 0, onChange: (e) => events.push(e) });
    s.request({ owner: 'v2', key: 'a', kind: 'segmented', sync: { relaxMs: [10000], relaxPreempt: [10000] }, maxMs: 20000 });
    const r = s.request({ owner: 'clip', key: 'c', kind: 'atomic', maxMs: 3000 });
    s.reset();
    ok('reset：排队项发 expired（带 token）', events.some((e) => e.type === 'expired' && e.token === r.token));
    ok('reset：current 发 end(cancelled)', events.some((e) => e.type === 'end' && e.endedBy === 'cancelled'));
    ok('reset 后 lastTickAt 清零（下一次 tick 不会误跨）', s.status().current === null);
  }

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' perf-scheduler：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('  ✗ 测试崩溃：' + ((e && e.stack) || e));
  process.exit(1);
});
