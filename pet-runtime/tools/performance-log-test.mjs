// performance-log-test.mjs —— 表演决策日志单测（2026-11-17 六十六轮）
//
// 钉住：① play/skip 记录字段够分析 ② 「用户接话」只在 90 秒窗口内且只配对一次
//      ③ 写日志失败不影响决策 ④ 内存有上限（不会长跑爆内存）
//
// 用法：node pet-runtime/tools/performance-log-test.mjs

import { createPerformanceLog, FOLLOW_WINDOW_MS } from '../desktop/perf/performance-log.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { pass += 1; return; }
  fail += 1;
  console.error('  ✗ ' + name + ' —— got ' + a + ' want ' + b);
}

function mk() {
  const lines = [];
  let T = 1_000_000;
  const log = createPerformanceLog({ append: (l) => lines.push(l), now: () => T });
  return { log, lines, setT: (v) => { T = v; }, tick: (ms) => { T += ms; }, getT: () => T };
}

// ── ① play / skip ────────────────────────────────────────────────────
{
  const { log, lines } = mk();
  const r = log.noteDecision({
    source: 'peak', emotion: 'sad', intensity: 0.82, played: true, activity: 'working',
    decision: { clipId: 'lumen-23', label: '难过流泪', reason: 'ok', detail: { energy: 455, durationMs: 4650 } },
  });
  eq('play 记录 kind', r.kind, 'play');
  eq('play 带 clipId/label', [r.clipId, r.label], ['lumen-23', '难过流泪']);
  eq('play 带 energy/duration', [r.energy, r.durationMs], [455, 4650]);
  eq('play 带来源与情绪', [r.source, r.emotion, r.intensity], ['peak', 'sad', 0.82]);
  ok('落盘一行合法 JSON', (() => { try { JSON.parse(lines[0]); return true; } catch (e) { return false; } })());

  const s = log.noteDecision({ source: 'idle', emotion: 'bored', intensity: 0.9, played: false, decision: { reason: 'weak-emotion' } });
  eq('skip 记录 kind', s.kind, 'skip');
  eq('skip 带 reason', s.reason, 'weak-emotion');
  ok('skip 不写 clipId', s.clipId === undefined);
  eq('stats 计数', [log.stats.plays, log.stats.skips], [1, 1]);
  eq('bySource 计数', log.stats.bySource.peak, 1);
  eq('byReason 计数', log.stats.byReason['weak-emotion'], 1);
}

// ── ② 用户接话配对 ───────────────────────────────────────────────────
{
  const { log, tick, getT } = mk();
  log.noteDecision({ source: 'peak', emotion: 'shy', intensity: 0.8, played: true, decision: { clipId: 'lumen-91', label: '害羞', reason: 'ok', detail: {} } });
  tick(3000);
  const a = log.noteUserInput();
  ok('窗口内接话会被记录', a && a.kind === 'user_input_after', JSON.stringify(a));
  eq('记录毫秒数', a.ms, 3000);
  eq('带 clipId', a.clipId, 'lumen-91');
  ok('同一次表演只配对一次', log.noteUserInput() === null);

  // 超出窗口：不再配对
  log.noteDecision({ source: 'peak', emotion: 'happy', intensity: 0.7, played: true, decision: { clipId: 'lumen-83', label: '自然放松', reason: 'ok', detail: {} } });
  tick(FOLLOW_WINDOW_MS + 1000);
  ok('超过 90 秒不配对', log.noteUserInput() === null);
  eq('stats.userAfter', log.stats.userAfter, 1);

  // 没播过就不配对
  const fresh = mk();
  ok('没有播放记录时接话不产生记录', fresh.log.noteUserInput() === null);
  ok('时间回退（负 ms）也不记', (() => {
    const x = mk();
    x.log.noteDecision({ source: 'peak', emotion: 'sad', intensity: 0.9, played: true, decision: { clipId: 'c', label: 'l', reason: 'ok', detail: {} } });
    x.setT(x.getT() - 500);
    return x.log.noteUserInput() === null;
  })());
}

// ── ③ 写日志失败不影响决策 ────────────────────────────────────────────
{
  const log = createPerformanceLog({ append: () => { throw new Error('disk full'); }, now: () => 1 });
  let threw = false;
  try {
    const r = log.noteDecision({ source: 'peak', emotion: 'sad', intensity: 0.9, played: true, decision: { clipId: 'x', label: 'y', reason: 'ok', detail: {} } });
    ok('append 抛错时仍返回记录', r && r.kind === 'play');
  } catch (e) { threw = true; }
  ok('append 抛错不外泄', threw === false);
}

// ── ④ 内存上限 ───────────────────────────────────────────────────────
{
  const log = createPerformanceLog({ append: () => {}, now: (() => { let t = 0; return () => (t += 1); })(), keep: 10 });
  for (let i = 0; i < 50; i += 1) {
    log.noteDecision({ source: 'idle', emotion: 'bored', intensity: 0.6, played: false, decision: { reason: 'cooldown' } });
  }
  eq('内存只保留 keep 条', log.recent(999).length, 10);
  eq('累计计数不丢', log.stats.skips, 50);
}

// ── ⑤ P0 新语义：perf.end / endedBy / during vs afterEnd ──────────────
{
  const { log, tick } = mk();
  log.noteDecision({ source: 'auto', emotion: '', intensity: null, played: true, perfKind: 'v2', decision: { clipId: '01-curiosity', label: '疑惑', reason: 'v2-long', detail: { durationMs: 20000 } } });
  tick(5000);
  const end = log.noteEnd({ endedBy: 'interrupt' });
  eq('perf.end 记录 kind', end.kind, 'perf.end');
  eq('perf.end 记录 endedBy=interrupt', end.endedBy, 'interrupt');
  eq('perf.end 记录 actualMs（开始到现在）', end.actualMs, 5000);
  eq('perf.end 带 plannedMs', end.plannedMs, 20000);
  eq('stats 计 endedBy', log.stats.byEndedBy.interrupt, 1);
  ok('同一次表演不重复结账', log.noteEnd({ endedBy: 'natural' }) === null);
  eq('lastPlay 已结账', log.lastPlay.endedAt != null, true);

  tick(10000);   // 开始后 15s，结束后 10s
  const u = log.noteUserInput();
  eq('演完之后输入 → phase=afterEnd', u && u.phase, 'afterEnd');
  eq('afterEnd 的 ms 仍按开始计时（旧字段兼容）', u.ms, 15000);
  eq('afterEnd 记 sinceEndMs', u.sinceEndMs, 10000);
  eq('stats 分账 afterEnd', log.stats.afterEnd, 1);
  eq('stats 分账 during=0', log.stats.during, 0);
}

// ── ⑥ 播放中的输入记 during（打断），不能被算成被吸引 ────────────────
{
  const { log, tick } = mk();
  log.noteDecision({ source: 'peak', emotion: 'happy', intensity: 0.8, played: true, perfKind: 'clip', decision: { clipId: 'lumen-1', label: '微笑', reason: 'ok', detail: { durationMs: 20000 } } });
  tick(3000);
  const u = log.noteUserInput();
  eq('播放中输入 → phase=during', u && u.phase, 'during');
  eq('during 的 sinceEndMs 为空', u.sinceEndMs, null);
  eq('stats 分账 during', log.stats.during, 1);
  eq('stats 分账 afterEnd=0', log.stats.afterEnd, 0);
  eq('userAfter 仍是总数（旧字段语义不变）', log.stats.userAfter, 1);
}

// ── ⑦ afterEnd 窗口从「结束」算，不是从「开始」算 ─────────────────────
{
  const { log, tick } = mk();
  log.noteDecision({ source: 'peak', emotion: 'sad', intensity: 0.9, played: true, perfKind: 'clip', decision: { clipId: 'c1', label: '难过流泪', reason: 'ok', detail: { durationMs: 2000 } } });
  tick(2000);
  log.noteEnd({ endedBy: 'natural' });
  tick(FOLLOW_WINDOW_MS + 1);   // 距结束已超 90s（距开始更久）
  ok('演完超过 90 秒不再记', log.noteUserInput() === null);

  const y = mk();
  y.log.noteDecision({ source: 'peak', emotion: 'sad', intensity: 0.9, played: true, perfKind: 'clip', decision: { clipId: 'c2', label: '难过流泪', reason: 'ok', detail: { durationMs: 30000 } } });
  y.tick(30000);
  y.log.noteEnd({ endedBy: 'natural' });
  y.tick(FOLLOW_WINDOW_MS - 100);
  const late = y.log.noteUserInput();
  ok('长片演完后 90s 内仍算被吸引（旧实现按开始算会漏掉）', late && late.phase === 'afterEnd', JSON.stringify(late));
}

// ── ⑧ noteEnd 的归属校验与 endedBy 兜底 ──────────────────────────────
{
  const { log, tick } = mk();
  log.noteDecision({ source: 'peak', emotion: 'shy', intensity: 0.8, played: true, perfKind: 'clip', decision: { clipId: 'lumen-91', label: '害羞', reason: 'ok', detail: {} } });
  tick(1000);
  ok('clipId 不匹配时不结账（片段 stop 不会误结 v2 的账）', log.noteEnd({ clipId: 'other-clip' }) === null);
  const bad = log.noteEnd({ endedBy: 'nonsense' });
  eq('非法 endedBy 回落 natural', bad.endedBy, 'natural');
}

// ── ⑨ 摘要（导演预算/被接率闭环）与 perf.request ─────────────────────
{
  const { log, tick } = mk();
  log.noteDecision({ source: 'auto', emotion: '', intensity: null, played: true, perfKind: 'v2', decision: { clipId: 'k1', label: 'long', reason: 'v2-long', detail: { durationMs: 20000 } } });
  tick(1000);
  log.noteEnd({ endedBy: 'natural' });
  tick(200000);
  log.noteDecision({ source: 'peak', emotion: 'happy', intensity: 0.7, played: true, perfKind: 'clip', decision: { clipId: 'k2', label: '微笑', reason: 'ok', detail: { durationMs: 3000 } } });
  tick(1000);
  log.noteEnd({ endedBy: 'natural' });
  tick(5000);
  log.noteUserInput();
  const sum = log.summary();
  eq('摘要：播放数', sum.plays, 2);
  eq('摘要：10 分钟内播放数', sum.plays10, 2);
  eq('摘要：长段今日计数（>10s）', sum.longToday, 1);
  eq('摘要：今日播放数', sum.playsToday, 2);
  eq('摘要：被接率样本=已结账次数', sum.replySamples, 2);
  eq('摘要：被接率', sum.replyRate, 0.5);

  const req = log.noteRequest({
    owner: 'v2', key: 'auto:idle', perfKind: 'v2', presence: 'away',
    intensity: 0.3, maxMs: 8000, allowed: false, reason: 'presence:away', mode: 'dryrun',
  });
  eq('perf.request 记录 kind', req.kind, 'perf.request');
  eq('perf.request 记录 allowed=false', req.allowed, false);
  eq('perf.request 记录 mode', req.mode, 'dryrun');
  eq('perf.request 计数', log.stats.requests, 1);
  eq('perf.request 按 reason 计数', log.stats.byRequestReason['presence:away'], 1);
  eq('摘要：今日请求数', log.summary().requestsToday, 1);
  eq('摘要：今日被拦数', log.summary().blockedToday, 1);
}

console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 表演决策日志：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
