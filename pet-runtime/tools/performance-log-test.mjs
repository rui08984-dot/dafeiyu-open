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

console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 表演决策日志：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
