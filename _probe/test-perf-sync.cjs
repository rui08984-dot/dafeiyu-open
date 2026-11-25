#!/usr/bin/env node
/**
 * _probe/test-perf-sync.cjs —— 离线同步点标注（P2a/P2a2，ADR-015 §3.2）
 *
 * 钉住六件事：
 *   ① 覆盖率：15 段 v2 + 97 段 clip 全覆盖，字段形状与边界（relax 不贴段首/段尾）；
 *   ② 可打断性：非 atomic 的每一项「首 → 各 relax → 尾」任意相邻间距 ≤ 5000ms
 *      （含首尾锚点 —— 否则长段开头十几秒没有可打断点，调度器会退化成只能等演完）；
 *   ③ 静止点语义（P2a2）：v2 的 relax 是「可以安全换段/收势的点」—— 每个 step 的结束时刻、
 *      手势 exitAt、空档中点，**不再**是 step.start（那是动作起始瞬间）；相邻 relax 至少
 *      1200ms（密度上限）；relaxMeta 与 relaxMs 一一对应，q ∈ {authored,derived,inserted}；
 *   ④ 密度治理：lumen-77（51.95s，近平坦包络）的 relax ≤ 12（prominence + 密度上限生效）；
 *   ⑤ 幂等：同样的输入 + 同样的 generatedAt → 逐字节一致；hash 只由输入内容决定，
 *      改一个 step.start 就必须变；
 *   ⑥ 降级：perf-sync.json 缺失/损坏时 loadSync() 返回 null 且不抛（调度器退化为整段 atomic）。
 *
 * 用法：node _probe/test-perf-sync.cjs
 * 退出码：0 全过 / 1 有失败
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'pet-runtime', 'tools', 'annotate-performances.mjs');
const DESKTOP = path.join(ROOT, 'pet-runtime', 'desktop');
const SYNC_FILE = path.join(ROOT, 'pet-runtime', 'data', 'perf-sync.json');

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

const MAX_GAP = 5000;
const MIN_GAP = 1200;
const EDGE = 500;
const EPS = 0.05;
const QUALITIES = ['authored', 'derived', 'inserted'];

(async () => {
  const {
    loadInputs, buildSyncDoc, hashSyncInputs, syncSummary, annotatePerformance,
    fillRelaxGaps, findLocalMinima, performanceCandidates, prominenceOfMinima,
    selectRelaxPoints, planRelax, SYNC_VERSION, RELAX_MAX_GAP_MS, RELAX_MIN_GAP_MS,
  } = await import(pathToFileURL(TOOL).href);
  const { loadSync, syncFor } = await import(pathToFileURL(path.join(DESKTOP, 'perf', 'perf-scheduler.mjs')).href);
  eq('常量：最小间距 1200ms / 最大 5000ms', [RELAX_MIN_GAP_MS, RELAX_MAX_GAP_MS], [MIN_GAP, MAX_GAP]);

  // ── ① 输入 + 覆盖 ────────────────────────────────────────────────────
  const inputs = await loadInputs();
  const perfKeys = Object.keys(inputs.performances);
  eq('输入：v2 表演 15 段', perfKeys.length, 15);
  eq('输入：clip 97 段', inputs.clips.size, 97);
  ok('输入：index.fps = 20', Number(inputs.index.fps) === 20, String(inputs.index.fps));
  ok('输入：19 条 FACS 通道', Array.isArray(inputs.index.facsChannels) && inputs.index.facsChannels.length === 19);

  const AT = '2026-01-01T00:00:00.000Z';
  const doc = buildSyncDoc(inputs, { generatedAt: AT });
  const itemKeys = Object.keys(doc.items);
  eq('产物：112 项 = 15 + 97', itemKeys.length, 112);
  eq('产物：version 1', doc.version, SYNC_VERSION);
  ok('产物：hash 为 16 位 hex', /^[0-9a-f]{16}$/.test(doc.hash), doc.hash);

  let missingPerf = [];
  for (const key of perfKeys) if (!doc.items[key]) missingPerf.push(key);
  const missingClip = [...inputs.clips.keys()].filter((id) => !doc.items[id]);
  eq('覆盖：15 段 v2 全在', missingPerf, []);
  eq('覆盖：97 段 clip 全在', missingClip, []);

  // ── ② 字段形状与边界 ────────────────────────────────────────────────
  const shapeBad = [];
  const edgeBad = [];
  for (const key of itemKeys) {
    const it = doc.items[key];
    if (!it || typeof it !== 'object') { shapeBad.push(key + ':not-object'); continue; }
    if (!(Number(it.durationMs) > 0)) shapeBad.push(key + ':duration');
    if (Number(it.endMs) !== Number(it.durationMs)) shapeBad.push(key + ':end!=duration');
    if (typeof it.atomic !== 'boolean') shapeBad.push(key + ':atomic');
    if (!Array.isArray(it.relaxMs)) shapeBad.push(key + ':relax');
    if (!Array.isArray(it.relaxMeta) || it.relaxMeta.length !== (it.relaxMs || []).length) shapeBad.push(key + ':relaxMeta');
    for (const m of Array.isArray(it.relaxMeta) ? it.relaxMeta : []) {
      if (!m || typeof m !== 'object') { shapeBad.push(key + ':meta-shape'); break; }
      if (!QUALITIES.includes(m.q)) { shapeBad.push(key + ':meta-q=' + m.q); break; }
      if (!Number.isFinite(Number(m.t))) { shapeBad.push(key + ':meta-t'); break; }
    }
    if (!Number.isFinite(Number(it.prepMs))) shapeBad.push(key + ':prep');
    if (!Number.isFinite(Number(it.strokeMs))) shapeBad.push(key + ':stroke');
    for (const ms of it.relaxMs || []) {
      if (!(ms >= EDGE && ms <= Number(it.durationMs) - EDGE)) edgeBad.push(key + ':' + ms);
    }
  }
  eq('形状：112 项字段齐全', shapeBad, []);
  eq('边界：relax 全部落在 [500, duration-500]', edgeBad, []);

  const v2Atomic = perfKeys.filter((k) => doc.items[k].atomic === true);
  eq('v2：15 段都不是 atomic（长段可按 relax 打断）', v2Atomic, []);

  const atomicClips = [...inputs.clips.entries()].filter(([, c]) => Number(c.durationMs) < 1500).map(([id]) => id);
  const atomicItems = itemKeys.filter((k) => doc.items[k].atomic === true);
  eq('atomic：只有 <1.5s 的片段被标 atomic', atomicItems.slice().sort(), atomicClips.slice().sort());
  ok('atomic：lumen-96（1050ms）为 atomic', doc.items['lumen-96'] && doc.items['lumen-96'].atomic === true);
  eq('atomic：没有 relax 点', doc.items['lumen-96'].relaxMs, []);

  // relax 单调/去重/1 位小数
  const orderBad = [];
  const decimalBad = [];
  for (const key of itemKeys) {
    const relax = doc.items[key].relaxMs;
    for (let i = 1; i < relax.length; i += 1) {
      if (!(relax[i] > relax[i - 1])) orderBad.push(key + ':' + relax[i - 1] + '>=' + relax[i]);
    }
    for (const ms of relax) {
      if (Math.abs(ms * 10 - Math.round(ms * 10)) > 1e-9) decimalBad.push(key + ':' + ms);
    }
  }
  eq('relax：严格递增且无重复', orderBad, []);
  eq('relax：最多 1 位小数', decimalBad, []);

  // 间距（含首尾锚点）
  const gapBad = [];
  let maxGap = 0;
  for (const key of itemKeys) {
    const it = doc.items[key];
    if (it.atomic) continue;
    const points = [0, ...it.relaxMs, Number(it.endMs)];
    for (let i = 1; i < points.length; i += 1) {
      const gap = Math.round((points[i] - points[i - 1]) * 10) / 10;
      maxGap = Math.max(maxGap, gap);
      if (gap > MAX_GAP + 1e-6) gapBad.push(key + ':' + points[i - 1] + '-' + points[i] + '=' + gap);
    }
  }
  eq('间距：非 atomic 项任意相邻 relax ≤ 5000ms（含首尾）', gapBad, []);
  ok('间距：实测最大值 ≤ 5000', maxGap <= MAX_GAP, String(maxGap) + 'ms');

  // ── ②b P2a2：静止点语义 / 密度上限 / relaxMeta ──────────────────────
  const metaMismatch = [];
  const minGapBad = [];
  for (const key of itemKeys) {
    const it = doc.items[key];
    const relax = it.relaxMs;
    for (let i = 0; i < relax.length; i += 1) {
      const m = it.relaxMeta[i];
      if (!m || Math.abs(Number(m.t) - relax[i]) > EPS) metaMismatch.push(key + '#' + i);
    }
    for (let i = 1; i < relax.length; i += 1) {
      const gap = Math.round((relax[i] - relax[i - 1]) * 10) / 10;
      if (gap < MIN_GAP - 1e-6) minGapBad.push(key + ':' + relax[i - 1] + '-' + relax[i] + '=' + gap);
    }
  }
  eq('relaxMeta：与 relaxMs 等长且逐项同 t', metaMismatch, []);
  eq('间距：任意相邻 relax ≥ 1200ms（密度上限）', minGapBad, []);

  // v2：relax 是静止点（step 结束 / 手势 exitAt / 空档中点），不是 step.start
  const startOnly = [];
  const noStepEnd = [];
  const authoredBad = [];
  for (const key of perfKeys) {
    const it = doc.items[key];
    const perf = inputs.performances[key];
    const starts = (perf.steps || []).map((s) => Number(s.start)).filter(Number.isFinite).map((v) => v * 1000);
    const ends = (perf.steps || [])
      .map((s) => Number(s.start) + Number(s.duration)).filter(Number.isFinite).map((v) => v * 1000);
    const exits = (perf.gestureSteps || [])
      .map((g) => Number(g.exitAt)).filter(Number.isFinite).map((v) => v * 1000);
    const has = (list, t) => list.some((v) => Math.abs(v - t) <= EPS);
    for (const t of it.relaxMs) {
      // 只被 step.start 解释、又不是任何 step 结束/手势 exit 的点 = 切在动作起始瞬间
      if (has(starts, t) && !has(ends, t) && !has(exits, t)) startOnly.push(key + ':' + t);
    }
    if (!it.relaxMs.some((t) => has(ends, t))) noStepEnd.push(key);
    for (const m of it.relaxMeta) {
      if (m.q !== 'authored') continue;
      if (!has(ends, m.t) && !has(exits, m.t)) authoredBad.push(key + ':' + m.t);
    }
  }
  eq('v2：relax 不含「只靠 step.start 解释」的点', startOnly, []);
  eq('v2：每段都含至少一个 step 结束时刻', noStepEnd, []);
  eq('v2：authored 点只能来自 step 结束或手势 exitAt', authoredBad, []);

  const c77 = doc.items['lumen-77'];
  ok('密度：lumen-77（51.95s 近平坦）relax ≤ 12', c77 && c77.relaxMs.length <= 12, String(c77 && c77.relaxMs.length));
  const c77q = {};
  for (const m of c77.relaxMeta) c77q[m.q] = (c77q[m.q] || 0) + 1;
  ok('密度：lumen-77 至少有一个真静止点（derived），不是全靠 inserted',
    (c77q.derived || 0) >= 1, JSON.stringify(c77q));

  // 顶层 quality 统计 = 逐项累加
  const sumQ = { authored: 0, derived: 0, inserted: 0 };
  for (const key of itemKeys) for (const m of doc.items[key].relaxMeta) sumQ[m.q] += 1;
  eq('quality：顶层统计等于逐项累加', doc.quality, sumQ);
  eq('quality：三类之和 = relax 总数',
    doc.quality.authored + doc.quality.derived + doc.quality.inserted,
    itemKeys.reduce((n, k) => n + doc.items[k].relaxMs.length, 0));
  ok('quality：authored 全部来自 v2（片段只能 derived/inserted）',
    Object.keys(doc.items).filter((k) => k.startsWith('lumen-'))
      .every((k) => doc.items[k].relaxMeta.every((m) => m.q !== 'authored')));
  eq('atomic：lumen-96 的 relaxMeta 为空', doc.items['lumen-96'].relaxMeta, []);

  // 具体样例：v2 的 stroke 取第一个非 look/tilt；手势 exitAt 必须进 relax
  const curiosity = doc.items['01-curiosity'];
  eq('样例：01-curiosity durationMs 20200', curiosity.durationMs, 20200);
  eq('样例：01-curiosity strokeMs = 第一个非 look/tilt（pose 0.3s）', curiosity.strokeMs, 300);
  ok('样例：01-curiosity 含手势 exitAt 14870', curiosity.relaxMs.includes(14870), JSON.stringify(curiosity.relaxMs));
  const lumen0 = doc.items['lumen-0'];
  eq('样例：lumen-0 durationMs 3050', lumen0.durationMs, 3050);
  ok('样例：lumen-0 有 relax 点', lumen0.relaxMs.length > 0, JSON.stringify(lumen0.relaxMs));

  const summary = syncSummary(doc);
  eq('summary：112 项（15 + 97）', [summary.performances, summary.clips], [15, 97]);
  eq('summary：atomic 1 段', summary.atomic, 1);
  eq('summary：quality 与产物一致', summary.quality, doc.quality);
  ok('summary：inserted 占比 < 50%（多数点是真静止点）', summary.insertedRatio < 0.5,
    String(summary.insertedRatio));
  eq('summary：lumen-77 relax 数与产物一致', summary.lumen77Relax, c77.relaxMs.length);

  // ── ③ 纯函数边角 ────────────────────────────────────────────────────
  eq('fillRelaxGaps：空输入靠锚点补齐（0→12000 等距 3 段）', fillRelaxGaps([], 12000), [4000, 8000]);
  eq('fillRelaxGaps：间距 8000 插一个中点', fillRelaxGaps([5000], 12000).filter((v) => v > 5000 && v < 12000 - 500), [8500]);
  eq('findLocalMinima：平台（全零能量）不算极小', findLocalMinima(new Array(200).fill(0), 20), []);
  eq('findLocalMinima：单峰能量的极小在两侧', findLocalMinima([0, 0, 3, 0, 0], 20), []);

  eq('selectRelaxPoints：1200ms 内只留一个（authored 压过 derived）',
    selectRelaxPoints([{ t: 1000, q: 'derived' }, { t: 1500, q: 'authored' }, { t: 3000, q: 'derived' }], 10000)
      .map((p) => [p.t, p.q]),
    [[1500, 'authored'], [3000, 'derived']]);
  eq('planRelax：无候选时全靠 inserted 补齐',
    planRelax([], 12000).map((p) => [p.t, p.q]),
    [[4000, 'inserted'], [8000, 'inserted']]);

  const envSyn = new Array(120).fill(0.5);
  envSyn[20] = 0;      // 深坑：真静止
  envSyn[60] = 0.45;   // 浅坑：相对闸应该拦掉
  const synMinima = findLocalMinima(envSyn, 20, { minGapMs: 0 });
  eq('prominenceOfMinima：浅坑被相对闸拦下',
    prominenceOfMinima(envSyn, 20, synMinima, {}).map((m) => m.i), [20]);
  eq('prominenceOfMinima：密度上限只留最突出的',
    prominenceOfMinima(envSyn, 20, synMinima, { maxPoints: 1 }).map((m) => m.i), [20]);

  const cand01 = performanceCandidates(inputs.performances['01-curiosity']);
  ok('performanceCandidates：含 step 结束（pose 8+2.5=10500）', cand01.some((c) => c.t === 10500));
  ok('performanceCandidates：不使用 step.start（16700 不是候选）', !cand01.some((c) => Math.abs(c.t - 16700) <= EPS));
  const perf01 = annotatePerformance('01-curiosity', inputs.performances['01-curiosity']);
  eq('annotatePerformance：手势 exitAt 进 relax', perf01.relaxMs.includes(14870), true);
  eq('annotatePerformance：relaxMeta 与 relaxMs 等长', perf01.relaxMeta.length, perf01.relaxMs.length);

  // ── ④ 幂等与 hash ───────────────────────────────────────────────────
  const docA = buildSyncDoc(inputs, { generatedAt: AT });
  const docB = buildSyncDoc(inputs, { generatedAt: AT });
  ok('幂等：同输入同时间 → 逐字节一致', JSON.stringify(docA) === JSON.stringify(docB));
  eq('幂等：hash 相同', docA.hash, docB.hash);
  const mutated = JSON.parse(JSON.stringify(inputs.performances));
  mutated['01-curiosity'].steps[0].start = Number(mutated['01-curiosity'].steps[0].start) + 0.01;
  const mutatedHash = hashSyncInputs({ performances: mutated, index: inputs.index, clips: inputs.clips });
  ok('hash：改一个 step.start 就变', mutatedHash !== docA.hash, mutatedHash + ' vs ' + docA.hash);

  // 落盘产物与构建结果一致（仓库里的 perf-sync.json 必须是最新的）
  const onDisk = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8'));
  eq('落盘：perf-sync.json hash 与输入一致', onDisk.hash, docA.hash);
  ok('落盘：generatedAt 是 ISO 字符串', !Number.isNaN(Date.parse(onDisk.generatedAt)), onDisk.generatedAt);

  // ── ⑤ 降级：loadSync ────────────────────────────────────────────────
  eq('loadSync：无参数 → null（不抛）', loadSync(), null);
  eq('loadSync：文件缺失 → null（不抛）', loadSync({ file: path.join(ROOT, 'no-such', 'perf-sync.json'), readFile: fs.readFileSync }), null);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-sync-'));
  try {
    const broken = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(broken, '{ this is not json', 'utf8');
    eq('loadSync：坏 JSON → null（不抛）', loadSync({ file: broken, readFile: fs.readFileSync }), null);
    const noItems = path.join(tmpDir, 'no-items.json');
    fs.writeFileSync(noItems, JSON.stringify({ version: 1 }), 'utf8');
    eq('loadSync：没有 items → null', loadSync({ file: noItems, readFile: fs.readFileSync }), null);
    const loaded = loadSync({ file: SYNC_FILE, readFile: fs.readFileSync });
    ok('loadSync：正常文件返回文档', Boolean(loaded && loaded.items && loaded.items['01-curiosity']));
    const sync01 = syncFor(loaded, '01-curiosity');
    ok('syncFor：取到 01-curiosity 的 relax（毫秒）', Boolean(sync01 && sync01.relaxMs.includes(14870)));
    eq('syncFor：缺失 key → null', syncFor(loaded, 'no-such-key'), null);

    // ── ⑥ CLI：生成 / --check 三种退出码 / 二次生成逐字节一致 ──────────
    const outFile = path.join(tmpDir, 'perf-sync.json');
    const run = (args) => spawnSync(process.execPath, [TOOL].concat(args), { encoding: 'utf8' });
    const gen1 = run(['--out', outFile]);
    eq('CLI：首次生成退出 0', gen1.status, 0);
    ok('CLI：生成文件存在', fs.existsSync(outFile));
    const bytes1 = fs.readFileSync(outFile);
    const gen2 = run(['--out', outFile]);
    eq('CLI：二次生成退出 0', gen2.status, 0);
    ok('CLI：二次生成逐字节一致（幂等）', Buffer.compare(bytes1, fs.readFileSync(outFile)) === 0);
    const check1 = run(['--check', '--out', outFile]);
    eq('CLI：--check 最新 → 退出 0', check1.status, 0);
    const tampered = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    tampered.hash = 'deadbeefdeadbeef';
    fs.writeFileSync(outFile, JSON.stringify(tampered), 'utf8');
    const check2 = run(['--check', '--out', outFile]);
    eq('CLI：--check 过期 → 退出 3', check2.status, 3);
    fs.unlinkSync(outFile);
    const check3 = run(['--check', '--out', outFile]);
    eq('CLI：--check 缺失 → 退出 2', check3.status, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' perf-sync：PASS ' + pass + ' / FAIL ' + fail
    + '（最大间距 ' + maxGap + 'ms，atomic ' + summary.atomic
    + '，质量 a' + summary.quality.authored + '/d' + summary.quality.derived + '/i' + summary.quality.inserted
    + '，lumen-77 ' + summary.lumen77Relax + ' 点）');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('  ✗ 测试崩溃：' + ((e && e.stack) || e));
  process.exit(1);
});
