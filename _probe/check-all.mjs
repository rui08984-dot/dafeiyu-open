#!/usr/bin/env node
// check-all.mjs —— 统一门禁（2026-11-12 用户拍板 §27；2026-11-21 A1 分三档）
//
// 用法：
//   node _probe/check-all.mjs            全量（含 doctor，约 4–6 分钟）
//   node _probe/check-all.mjs --fast      全量但不跑 doctor（省 ~40s）
//   node _probe/check-all.mjs --core      核心档：冒烟 + 自起服务/真实数据（预算 4min）
//   node _probe/check-all.mjs --smoke     冒烟档：纯逻辑/静态，不依赖宿主（预算 30s，可并发）
//   node _probe/check-all.mjs --boot      启动自检：只语法 + 体检（launcher 每次启动用）
//
// 检查项：
//   ① 语法：_probe/scan-syntax.mjs 全量自动发现 + 3 个 Python py_compile
//   ② 回归：_probe/regress-fake-success.cjs（契约 14 用例；--smoke 不跑）
//   ③ 单测：清单与分档在 _probe/gate-units.mjs（每条带 tier/needsHost/parallelSafe）
//   ④ 扫描：spawn 缺 windowsHide（只对生产代码判红；dev 脚本允许有窗口）
//   ⑤ 体检：doctor.mjs 摘要（异常数 > 0 判红；只有全量档跑）
//
// 分档的设计动机（A1）：原来全量严格串行约 12 分钟，「不敢常跑」等于没有快速反馈。
// 现在 --smoke 只跑纯逻辑（并发 4），改完代码 30 秒内知道核心逻辑有没有坏；
// 需要宿主的项在宿主没起时直接 SKIP 并写清理由（不去撞超时，也不假装通过）。

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNITS, TIER_INFO, unitsForTier } from './gate-units.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PY = process.env.PET_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const fast = process.argv.includes('--fast');
// --boot：启动自检专用。只跑「语法 + 体检」，跳过回归/单测（那两项要动真实窗口、耗时 50s+），
// launcher 每次启动时调用，红了在日志里喊一声，不阻塞启动。
const boot = process.argv.includes('--boot');
// 档位（A1）：--smoke / --core / --full；默认 full。
const tierArg = process.argv.find((a) => a === '--smoke' || a === '--core' || a === '--full');
const tier = tierArg ? tierArg.slice(2) : 'full';
const tierInfo = TIER_INFO[tier] || TIER_INFO.full;
const startedAt = Date.now();

// 语法检查已改为全量自动发现（见 ① 语法 全量扫描）；这里只留 Python。
const PY_FILES = [
  'pet-runtime/tools/ocr_find.py',
  'pet-runtime/tools/ocr_read.py',
  'pet-runtime/tools/game_detector.py',
];

const rows = [];
// A2 真实数据护栏：只有**冒烟档**启用。
//   冒烟档全是纯逻辑测试，全程不该写真实记录室 —— 这条断言就是防「有人往 smoke 里
//   加了一条会写真实数据的测试」的回归。core/full 档不启用：宿主在同时写同一批文件，
//   前后对比必然有差异，加了就是狼来了。
//   已知宿主正在写时（例如刚在跟她聊天）可临时 PET_GATE_GUARD=0 关掉。
const GUARD_DIR = path.join(ROOT, '_incoming', 'my-neuro', 'data');
const GUARDED_FILES = ['人格状态.json', '用户事实.json', '记忆待写队列.jsonl', 'insights.jsonl'];
const guardOn = !boot && tier === 'smoke' && process.env.PET_GATE_GUARD !== '0';
function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch (e) { return 'MISSING'; }
}
const guardBefore = guardOn
  ? Object.fromEntries(GUARDED_FILES.map((f) => [f, sha256File(path.join(GUARD_DIR, f))]))
  : null;

// A1：门禁台账要能回答「上周红的那条为什么红」——失败时把子进程输出尾部带上。
// 只留 30 行：够看见断言名和报错，又不会把台账写成日志仓库。
function tailOf(text, lines = 30) {
  const s = String(text || '').trimEnd();
  return s ? s.split(/\r?\n/).slice(-lines).join('\n') : '';
}
function run(label, cmd, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: opts.cwd || ROOT, encoding: 'utf8', timeout: opts.timeout || 600000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const ok = opts.passWhen ? opts.passWhen(r) : r.status === 0;
  (opts.sink || rows).push({ label, ok, ms: Date.now() - t0, note: (opts.note || ''), tail: tailOf(out) });
  return { ok, out, status: r.status };
}

// 异步版：并行档要用。输出编码按 utf8 拼（与 spawnSync 的 encoding:'utf8' 口径一致）。
function runAsync(label, cmd, args, opts = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd || ROOT, windowsHide: true });
    } catch (e) {
      rows.push({ label, ok: false, ms: 0, note: 'spawn 失败', tail: String(e && e.message) });
      resolve({ ok: false, out: '', status: null });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      // 只杀直接子进程：测试脚本自身负责收掉它拉起的服务（现有测试都这么做）
      try { child.kill(); } catch (e) { /* 已经退了 */ }
    }, opts.timeout || 600000);
    if (child.stdout) child.stdout.on('data', (d) => { out += d; });
    if (child.stderr) child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { out += '\n[spawn error] ' + String((e && e.message) || e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ label, out, ms: Date.now() - t0, status: timedOut ? 'timeout' : code });
    });
  });
}

// 并发池：固定 limit 个 worker 抢队列，结果由调用方按索引回填（保证输出顺序稳定）。
async function pool(items, limit, worker) {
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: n }, async () => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// 返回 row 的异步检查（不直接写 rows）：语法/扫描这类纯 CPU 活可与单测并行启动，
// 最后按「语法 → 回归/单测 → 扫描/体检」的固定顺序统一落表。
async function runRow(label, cmd, args, opts = {}) {
  const r = await runAsync(label, cmd, args, opts);
  const row = { label, ok: r.status === 0, ms: r.ms, note: (opts.note || ''), tail: tailOf(r.out) };
  if (opts.annotate) opts.annotate(row, r.out, r.status);
  return { row, out: r.out, status: r.status };
}

// 宿主探测（A1）：只 TCP 连通性，不依赖 HTTP/HTTPS 协议差异。
// 探测失败 → needsHost 项标 SKIP（理由写清），不去撞 120s 超时。
const hostUp = {};
function probePort(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch (e) { /* ignore */ }
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// ① 语法（**并行启动**：纯 CPU/静态，与 ③ 单测互不依赖；冒烟档从 26s 压到 ~15s）
const headPromises = [
  runRow('语法 全量扫描', process.execPath, [path.join(ROOT, '_probe', 'scan-syntax.mjs')], {
    timeout: 180000,
    annotate: (row, out) => {
      const m = out.match(/语法扫描 (\d+) 个文件：通过 (\d+) \/ 失败 (\d+)/);
      row.note = m ? `${m[1]} 个文件 / 失败 ${m[3]}` : '未解析到汇总';
      if (!m || Number(m[3]) > 0) row.ok = false;
    },
  }),
  ...PY_FILES.map((f) => runRow('语法 ' + path.basename(f), PY, ['-m', 'py_compile', path.join(ROOT, f)], { timeout: 60000 })),
];
// ② 回归 / ③ 单测 / ④ 扫描 / ⑤ 体检的 row 先落各自桶，最后按固定顺序拼进 rows
const midRows = [];
const tailRows = [];

// ② 回归（启动自检跳过；冒烟档不跑：它要起临时宿主/窗口，属 core）
if (!boot && tier !== 'smoke') {
  const sink = [];
  const r = run('回归 regress-fake-success', process.execPath, [path.join(ROOT, '_probe', 'regress-fake-success.cjs')], { timeout: 600000, sink });
  const m = r.out.match(/PASS (\d+) \/ FAIL (\d+) \/ SKIP (\d+)/) || r.out.match(/PASS (\d+) \/ FAIL (\d+)/);
  const note = m ? `PASS ${m[1]} / FAIL ${m[2]}${m[3] ? ' / SKIP ' + m[3] : ''}` : '未解析到汇总';
  sink[0].note = note;
  // 2026-11-13：原来只看 FAIL>0。可是**全 SKIP**（宿主没起/环境缺失）时是
  // 「PASS 0 / FAIL 0」—— 断言一条没跑，却判绿。现在 PASS=0 也算失败。
  if (m && (Number(m[2]) > 0 || Number(m[1]) === 0)) sink[0].ok = false;
  midRows.push(sink[0]);
}

// ── 按需拉起控制中心（§75 / §68 B18）────────────────────────────────────────
// 只有全量档会跑 8771 验收；--smoke/--core 不拉，省掉一次进程启动。
// 它是独立进程，平时只有托盘点「打开设置」才起 —— 只在我们**自己起的**时候收掉。
let __ccPid = null;
if (!boot && tier === 'full') {
  try {
    const cc = await import(new URL('./ensure-control-center.mjs', import.meta.url).href);
    const r = await cc.ensureControlCenter({
      appDir: APP,
      log: (m) => console.log(m),
    });
    if (r.started) __ccPid = r.pid;
    if (!r.ok) console.log('[control-center] 起不来，两条 8771 验收会 SKIP：' + (r.error || '未知'));
  } catch (e) {
    console.log('[control-center] 辅助模块加载失败（两条 8771 验收会 SKIP）：' + ((e && e.message) || e));
  }
}

// ③ 单测（清单在 _probe/gate-units.mjs）
const units = boot ? [] : unitsForTier(tier);
// 2026-11-21 审计：单测清单里同一个文件被登记两次（webui 配置写读回），
// 门禁跑了两遍却看不出来 —— 一条测试没跑也会被另一条同名结果糊过去。
// 这里显式查重，重复即判红（防止以后再加测试时复制粘贴出错）。
{
  const seen = new Map();
  const dups = [];
  for (const u of units) {
    if (seen.has(u.file)) dups.push(`${u.file}（${seen.get(u.file)} / ${u.label}）`);
    else seen.set(u.file, u.label);
  }
  midRows.push({
    label: '门禁 单测清单无重复',
    ok: dups.length === 0,
    ms: 0,
    note: dups.length ? '重复：' + dups.join('；') : `${units.length} 个唯一文件（${tierInfo.name}档）`,
  });
}

async function runUnit(u) {
  const row = { label: u.label, ok: false, ms: 0, note: '', tail: '' };
  if (u.needsHost && !hostUp[u.needsHost]) {
    row.ok = true;
    row.skip = true;
    row.note = `宿主 ${u.needsHost} 未起，未验`;
    return row;
  }
  const abs = path.join(ROOT, u.file);
  if (!fs.existsSync(abs)) { row.note = '缺少测试文件'; row.ok = false; return row; }
  // UNITS 也收 Python 单测（如 tts-prosody-gain-test.py）：按扩展名选解释器。
  // 电脑操控评测给 240s：#22 之后每条任务最多花 8s 读 trace，10 条基线在页面忙时
  // 可能从 48s 拖到 ~130s；120s 会把「未取证」误杀成门禁超时（假红）。
  const unitTimeout = u.timeoutMs || (u.label.includes('电脑操控评测') ? 240000 : 120000);
  // 可选参数（gate-units 的 args）：例如评测的 --quiet（不占用户屏幕）
  const extraArgs = Array.isArray(u.args) ? u.args : (u.args ? String(u.args).split(/\s+/).filter(Boolean) : []);
  const r = u.file.endsWith('.py')
    ? await runAsync(u.label, PY, [abs, ...extraArgs], { timeout: unitTimeout })
    : await runAsync(u.label, process.execPath, [abs, ...extraArgs], { timeout: unitTimeout });
  row.ms = r.ms;
  row.tail = tailOf(r.out);
  row.ok = r.status === 0;
  if (r.status === 'timeout') row.note = `超时 ${Math.round(unitTimeout / 1000)}s`; 
  // 两种汇总格式都认：老格式 "PASS 13 / FAIL 0"，新格式 "4/4 全过"
  // （后者以前解析不到 → note 空着，看不出到底跑了几条断言）
  const m = r.out.match(/PASS (\d+) \/ FAIL (\d+)/);
  const m2 = r.out.match(/(\d+)\/(\d+) 全过/);
  if (m) row.note = `PASS ${m[1]} / FAIL ${m[2]}`;
  else if (m2) row.note = `PASS ${m2[1]} / FAIL ${Number(m2[2]) - Number(m2[1])}`;
  // 2026-11-20 审计 P2 #22：评测的「未取证」必须能在门禁备注里看到。
  // 只加备注，不改退出码（未取证不单独判红，由 runner 自己决定）。
  const uv = r.out.match(/unverified=(\d+)/);
  if (uv && row.note) row.note += ` / unverified=${uv[1]}`;
  // 「跳过」必须可见（2026-11-18 §69）：8771 没监听时 ui-button-accept 会 exit 0 并打一行 SKIP，
  // 门禁原来把它当 PASS —— 一条断言都没跑却判绿，正是 §27「失败路径必须发声」要防的。
  // 这里不改退出码（缺环境不该假红），但把行标成 SKIP 并在汇总里计数。
  // 只把「整条没跑」当 SKIP：有 PASS/FAIL 汇总的行即使内部有 SKIP（部分子项跳过）也不算。
  // 否则「验收 电脑操控评测（真机）」这种内部打 SKIP 的会被记成「从未验过」，台账被污染。
  const hasSummary = /PASS \d+ \/ FAIL \d+/.test(r.out);
  if (r.status === 0 && !hasSummary && /^\s*SKIP\b/m.test(r.out)) {
    const why = r.out.split('\n').find((line) => /^\s*SKIP\b/.test(line)) || 'SKIP';
    row.skip = true;
    row.note = why.trim().slice(0, 90);
  }
  return row;
}

if (units.length) {
  // 先探测需要的宿主：一次探测，所有 needsHost 项共用结果
  const ports = [...new Set(units.map((u) => u.needsHost).filter(Boolean))];
  await Promise.all(ports.map(async (p) => { hostUp[p] = await probePort(p); }));
  for (const p of ports) {
    if (!hostUp[p]) console.log(`[host] ${p} 未监听：相关 ${units.filter((u) => u.needsHost === p).length} 项将 SKIP`);
  }

  const unitRows = new Array(units.length);
  const parallelIdx = [];
  const serialIdx = [];
  units.forEach((u, i) => (u.parallelSafe ? parallelIdx : serialIdx).push(i));
  if (parallelIdx.length) {
    console.log(`[units] 并行 ${parallelIdx.length} 项（并发 4）+ 串行 ${serialIdx.length} 项`);
    await pool(parallelIdx, 4, async (i) => { unitRows[i] = await runUnit(units[i]); });
  }
  // 串行组：碰真实窗口/真实数据/固定端口的项，一条一条来
  for (const i of serialIdx) unitRows[i] = await runUnit(units[i]);
  midRows.push(...unitRows.filter(Boolean));
}

// ④ 扫描（启动自检跳过）
if (!boot) {
  const sink = [];
  const r = run('扫描 spawn 缺 windowsHide', process.execPath, [path.join(ROOT, '_probe', 'scan-spawn-hide.cjs')], {
    timeout: 120000,
    sink,
    // 2026-11-13：原来是 passWhen: () => true —— 永远 PASS，等于没查。
    // 现在只有「生产代码缺 0 处」才算过；dev 工具（stdio:inherit）本来就该显示输出，不计。
    passWhen: (rr) => {
      const hit = String(rr.stdout || '').match(/生产缺 (\d+) 处/);
      return hit ? Number(hit[1]) === 0 : false;
    },
  });
  const m = r.out.match(/生产缺 (\d+) 处 \/ dev 缺 (\d+) 处/);
  sink[0].note = m ? `生产缺 ${m[1]} / dev 缺 ${m[2]}（dev 允许）` : '未解析';
  sink[0].warn = m ? Number(m[2]) : 0;
  tailRows.push(sink[0]);
}

// ⑤ 体检（只有全量档；--fast/--smoke/--core 都跳过）
if (!fast && tier === 'full') {
  const sink = [];
  const r = run('体检 doctor', process.execPath, [path.join(ROOT, 'pet-runtime', 'tools', 'doctor.mjs')], { timeout: 300000, sink });
  const m = r.out.match(/(\d+) 项：(\d+) 绿 \/ (\d+) 异常/);
  if (m) {
    sink[0].note = `${m[1]} 项 / ${m[2]} 绿 / ${m[3]} 异常`;
    if (Number(m[3]) > 0) sink[0].ok = false;
  } else {
    sink[0].ok = false;
    sink[0].note = '未解析到汇总';
  }
  tailRows.push(sink[0]);
}

// A2 护栏判定（放在汇总前：它要覆盖整轮）
if (guardOn) {
  const changed = GUARDED_FILES.filter((f) => sha256File(path.join(GUARD_DIR, f)) !== guardBefore[f]);
  tailRows.push({
    label: '门禁 冒烟档不写真实数据（A2）',
    ok: changed.length === 0,
    ms: 0,
    note: changed.length ? '变化：' + changed.join('、') : `${GUARDED_FILES.length} 个文件 0 字节变化`,
  });
}

// 收齐并行启动的语法检查，按固定顺序落表：语法 → 回归/单测 → 扫描/体检
rows.push(
  ...(await Promise.all(headPromises)).map((x) => x.row),
  ...midRows,
  ...tailRows,
);

// 汇总
const totalMs = Date.now() - startedAt;
const fails = rows.filter((r) => !r.ok);
const skips = rows.filter((r) => r.ok && r.skip);
console.log('\n── 门禁汇总 ─────────────────────────────────────────');
for (const r of rows) {
  const flag = r.skip ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL');
  console.log(`${flag}  ${String(r.ms).padStart(6)}ms  ${r.label}${r.note ? '  — ' + r.note : ''}`);
}
console.log('────────────────────────────────────────────────────');
console.log(`档位 ${tierInfo.name}：${rows.length} 项 / ${(totalMs / 1000).toFixed(1)}s（预算 ${(tierInfo.budgetMs / 1000).toFixed(0)}s）`
  + (totalMs > tierInfo.budgetMs ? `  ⚠ 超预算 ${((totalMs / tierInfo.budgetMs - 1) * 100).toFixed(0)}%：有重活混进了这档` : ''));
if (fails.length) {
  console.log(`❌ ${fails.length} 项未过：` + fails.map((r) => r.label).join('、'));
} else {
  console.log(`✅ 全部通过（${rows.length} 项${skips.length ? `，其中 ${skips.length} 项 SKIP：` + skips.map((r) => r.label).join('、') + '（环境不在，未验）' : ''}）`);
}
// 收掉我们自己拉起的控制中心（用户自己开的不会被碰）
if (__ccPid) {
  try {
    const cc = await import(new URL('./ensure-control-center.mjs', import.meta.url).href);
    const killed = cc.stopControlCenter(__ccPid);
    console.log(killed.ok ? '[control-center] 已关闭（本轮为门禁临时拉起）' : '[control-center] 关闭失败：' + killed.error);
  } catch (e) { console.log('[control-center] 关闭异常：' + ((e && e.message) || e)); }
}
// ④ 台账（§73 / §68 B4）：记录每项的通过/跳过/失败时间 + 耗时样本 + 失败尾 30 行。
// 为什么要有：真机项在服务没起时只能 SKIP，§71 让 SKIP 可见了，但「多久没真正跑过」
// 还是没人盯 —— 一项真机验收 40 天没跑，门禁照旧全绿，等于没有这条验收。
// 台账写失败不阻断门禁（它就是统计），但必须说出来。
{
  try {
    // check-all 是 ESM（.mjs）：没有 require，必须动态 import（CJS 互操作取 default）
    const mod = await import(new URL('./gate-history.cjs', import.meta.url).href);
    const gh = mod.default || mod;
    const rec = gh.recordRun(gh.defaultPath(ROOT), rows);
    if (!rec.ok) console.log('[gate-history] 写台账失败（不阻断门禁）：' + rec.error);
  } catch (e) {
    console.log('[gate-history] 台账模块加载失败（不阻断门禁）：' + ((e && e.message) || e));
  }
}
process.exit(fails.length ? 1 : 0);
