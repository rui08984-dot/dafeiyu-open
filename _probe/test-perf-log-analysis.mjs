#!/usr/bin/env node
/**
 * _probe/test-perf-log-analysis.mjs —— 决策日志分析单测（2026-11-18 六十七轮）
 *
 * 为什么测这个：这份分析的结论会拿去决定「补素材 / 改阈值 / 训模型」，
 * 算错了就是拿错数据做错决策。钉住：
 *   ① 各种 kind 的计数与聚合（play/skip/user_input_after）
 *   ② 接话率的分母是「该 label 的播放次数」（不是日志行数）
 *   ③ --since 窗口过滤
 *   ④ 坏行不致命
 *   ⑤ 结论句式：weak-emotion / no-candidate / cooldown / 多样性低 / 零接话 各自能触发
 *
 * 用法：node _probe/test-perf-log-analysis.mjs
 */

import { parseLines, parseSince, analyzeRecords, formatReport } from '../pet-runtime/tools/analyze-performance-log.mjs';

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

const NOW = 1_800_000_000_000;
const mk = (patch) => Object.assign({ ts: NOW - 1000 }, patch);

const RECORDS = [
  mk({ kind: 'play', source: 'peak', emotion: 'sad', clipId: 'c1', label: '难过流泪', energy: 400 }),
  mk({ kind: 'play', source: 'peak', emotion: 'sad', clipId: 'c2', label: '难过流泪', energy: 300 }),
  mk({ kind: 'play', source: 'idle', emotion: 'bored', clipId: 'c3', label: '思考专注', energy: 489 }),
  mk({ kind: 'skip', source: 'peak', emotion: 'happy', reason: 'weak-emotion' }),
  mk({ kind: 'skip', source: 'peak', emotion: 'happy', reason: 'weak-emotion' }),
  mk({ kind: 'skip', source: 'peak', emotion: 'angry', reason: 'no-candidate' }),
  mk({ kind: 'skip', source: 'peak', reason: 'cooldown' }),
  mk({ kind: 'user_input_after', clipId: 'c1', label: '难过流泪', ms: 5000 }),
  mk({ kind: 'user_input_after', clipId: 'c3', label: '思考专注', ms: 9000 }),
];

// ── ① 解析 ───────────────────────────────────────────────────────────
{
  eq('--since 解析 24h', parseSince('24h'), 24 * 3600 * 1000);
  eq('--since 解析 90m', parseSince('90m'), 90 * 60 * 1000);
  eq('--since 无法解析返回 null', parseSince('abc'), null);

  const { records, bad } = parseLines([
    '{"kind":"play","label":"x"}',
    '',
    'not json',
    '{"noKind":1}',
    '{"kind":"skip","reason":"busy"}',
  ].join('\n'));
  eq('坏行被跳过并计数', bad, 2);
  eq('有效行保留', records.length, 2);
}

// ── ② 聚合 ───────────────────────────────────────────────────────────
{
  const a = analyzeRecords(RECORDS, { now: NOW });
  eq('播放/跳过/接话计数', a.totals, { plays: 3, skips: 4, userAfter: 2 });
  eq('按来源', a.bySource, { peak: 2, idle: 1 });
  eq('跳过理由直方图', a.skipReasons, { 'weak-emotion': 2, 'no-candidate': 1, cooldown: 1 });
  eq('按情绪', a.playsByEmotion, { sad: 2, bored: 1 });
  eq('按 label', a.playsByLabel, { 难过流泪: 2, 思考专注: 1 });
  eq('多样性（label/clip）', a.distinct, { labels: 2, clips: 3 });

  // 接话率：难过流泪 2 播 1 接 → 50%；思考专注 1 播 1 接 → 100%
  eq('难过流泪 接话率', a.labelStats['难过流泪'], { plays: 2, userAfter: 1, rate: 50 });
  eq('思考专注 接话率', a.labelStats['思考专注'], { plays: 1, userAfter: 1, rate: 100 });
  eq('接话延迟中位', a.latency.medianMs, 7000);
  eq('延迟样本数', a.latency.samples, 2);
  ok('窗口起止被记录', a.window.from != null && a.window.to != null);
}

// ── ③ 窗口过滤 ───────────────────────────────────────────────────────
{
  const old = [{ ts: NOW - 10 * 24 * 3600 * 1000, kind: 'play', label: '旧' }, ...RECORDS];
  const a24 = analyzeRecords(old, { now: NOW, sinceMs: 24 * 3600 * 1000 });
  eq('24h 窗口只算窗口内的', a24.totals.plays, 3);
  const aAll = analyzeRecords(old, { now: NOW });
  eq('不传窗口时全算', aAll.totals.plays, 4);
  // ts 缺失的记录在窗口模式下被排除（不能假设它新）
  const noTs = analyzeRecords([{ kind: 'play', label: 'x' }], { now: NOW, sinceMs: 1000 });
  eq('无 ts 的记录在窗口里被排除', noTs.totals.plays, 0);
}

// ── ④ 结论句式 ───────────────────────────────────────────────────────
{
  const weak = formatReport(analyzeRecords([
    ...Array.from({ length: 6 }, () => mk({ kind: 'skip', reason: 'weak-emotion' })),
    mk({ kind: 'play', label: '微笑', clipId: 'x' }),
  ], { now: NOW }));
  ok('weak-emotion 为主时给出阈值建议', /weak-emotion/.test(weak) && /阈值|情绪本来就淡/.test(weak), weak.split('\n').slice(-2).join(' | '));

  const noCand = formatReport(analyzeRecords([
    ...Array.from({ length: 4 }, () => mk({ kind: 'skip', reason: 'no-candidate' })),
  ], { now: NOW }));
  ok('no-candidate 出现时建议补素材/调门槛', /no-candidate/.test(noCand) && /候选段|补素材|门槛/.test(noCand));

  const cool = formatReport(analyzeRecords([
    ...Array.from({ length: 6 }, () => mk({ kind: 'skip', reason: 'cooldown' })),
    mk({ kind: 'play', label: '微笑', clipId: 'x' }),
  ], { now: NOW }));
  ok('cooldown 为主时提到 gapMs', /cooldown/.test(cool) && /gapMs/.test(cool));

  const mono = formatReport(analyzeRecords(Array.from({ length: 6 }, (_, i) => mk({ kind: 'play', label: '微笑', clipId: 'c' + (i % 2) })), { now: NOW }));
  ok('多样性低（≤3 段）被点出', /多样性偏低/.test(mono), mono.split('\n').slice(-2).join(' | '));

  const zero = formatReport(analyzeRecords(Array.from({ length: 6 }, (_, i) => mk({ kind: 'play', label: '微笑', clipId: 'c' + i })), { now: NOW }));
  ok('播了≥5 次零接话被点出', /一次都没接话/.test(zero));

  const empty = formatReport(analyzeRecords([], { now: NOW }));
  ok('空日志不崩且提示样本少', /样本还太少/.test(empty), empty.split('\n').slice(-1)[0]);
}

// ── ⑤ 非数组/异常输入不崩 ────────────────────────────────────────────
{
  const a = analyzeRecords(null, {});
  eq('null 输入返回零值', a.totals, { plays: 0, skips: 0, userAfter: 0 });
  const b = analyzeRecords([{ kind: 'play' }, null, 42], {});
  ok('脏元素被忽略', b.totals.plays === 1, JSON.stringify(b.totals));
}

console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 决策日志分析：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
