/**
 * dispatch-verify.mjs — 派活 v2 P1：四态验收 + 文件快照/scope（2026-11-23）
 *
 * 设计依据：docs/设计-派活v2-2026-11-23.md §4.1/§4.4/§6「快照成本」。
 *
 * 职责边界（刻意做成纯 Node，不碰账本/HTTP/Electron）：
 *   · resolveWorkspace：别名 → realpath → 存在/非盘根/深度≥2；
 *   · snapshotWorkdir / diffSnapshots：开工前/收工后各拍一次，回答「改了哪些文件」；
 *   · settleWorkdir：DSH 退出后先等 mtime 连续 1s 不变（最多 5s）再验收 ——
 *     fleet 实测「不等落盘会读到半成品」；
 *   · runVerify：一条命令的四态判定 pass/fail/broken/timeout。
 *
 * 信任顺序（§4.1）：command > evidence > model > none。
 * DSH 的 final/tools 只算 model，永不足以判 done_verified —— 这一层只负责产出
 * command 级证据，是否算「已证实」由调用方按 verdict 映射。
 *
 * Windows 口径：verify 用 `cmd /d /s /c` + `windowsVerbatimArguments`，避免多引号
 * 嵌套被 cmd 的引号处理器吃掉；spawn 不走 shell，任务正文不会被换行截断。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export const VERIFY_VERDICTS = Object.freeze(['pass', 'fail', 'broken', 'timeout', 'none']);

/** verdict → 三态 outcome（§4.1）。timeout/broken 是「无法判定」，不是模型的锅。 */
export const VERDICT_OUTCOME = Object.freeze({
  pass: 'done_verified',
  fail: 'failed',
  broken: 'done_unproven',
  timeout: 'done_unproven',
  none: null,
});

export const SNAPSHOT_MAX_FILES = 4000;
// 8MB 是「内容读取」预算（fleet 口径）。本实现只 stat（mtime+size），不读内容，
// 所以它不截断遍历，只累计展示；真正限制遍历的是 4000 文件上限。
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
/** 跳过目录：.git/node_modules/dist/build/.venv（§6），外加几个同类产物目录。 */
export const SNAPSHOT_SKIP_DIRS = Object.freeze([
  '.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__',
  '.next', '.cache', '.turbo', 'coverage', '.idea', '.vscode',
]);

const OUTPUT_KEEP = 4000;      // 模块内保留；账本层再裁到 1500（§3.4）
const INTERPRETER_RE = /^(?:node|nodejs|python|python3|py)$/i;
const VERIFY_TIMEOUT_DEFAULT = 60000;

function clip(s, max) {
  const v = String(s == null ? '' : s);
  return v.length > max ? v.slice(0, max) : v;
}

function normRel(p) {
  return String(p || '').split(path.sep).join('/');
}

function sleep(ms) {
  // 不 unref：settle/取消轮询是「必须等到」的短定时器，测试里没有别的句柄时
  // unref 会让进程直接退出、Promise 永不 resolve（实测踩到）。
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ── workspace 别名（§4.4）─────────────────────────────────────────────────

function isDriveRoot(abs) {
  const p = path.resolve(abs);
  const parsed = path.parse(p);
  return p === parsed.root || /^[A-Za-z]:[\\/]?$/.test(p);
}

function depthOf(abs) {
  const p = path.resolve(abs);
  // 盘符也算一层：D:/ → 1（拒），<project-root> → 2（收）。设计 §4.4「深度≥2」。
  return p.split(/[\\/]+/).filter(Boolean).length;
}

/**
 * 把工作区别名解析成受控目录。
 * 只认 config.dispatch.workspaces 的键；值必须：
 *   · realpathSync 成功（存在）；
 *   · 是目录；
 *   · 不是盘根；
 *   · 深度 ≥2（例如 D:/ai 可以，D:/ 不行）。
 * 失败码严格限定 unknown_workspace / workspace_missing（HTTP 400，attempted=false）。
 *
 * @param {string|null} alias  请求里的别名；null/'' → 用 defaultWorkspace
 * @param {{workspaces?:object, defaultWorkspace?:string}} dispatchCfg
 * @param {object} [deps]  测试注入（fs 函数）
 * @returns {{ok:boolean, alias?:string, root?:string, realpath?:string, error?:string, reason?:string, detail?:string}}
 */
export function resolveWorkspace(alias, dispatchCfg, deps = {}) {
  const realpathSync = deps.realpathSync || fs.realpathSync;
  const statSync = deps.statSync || fs.statSync;
  const cfg = (dispatchCfg && typeof dispatchCfg === 'object') ? dispatchCfg : {};
  const table = (cfg.workspaces && typeof cfg.workspaces === 'object' && !Array.isArray(cfg.workspaces))
    ? cfg.workspaces : {};
  const requested = String(alias == null ? '' : alias).trim();
  const key = requested || String(cfg.defaultWorkspace == null ? '' : cfg.defaultWorkspace).trim();
  if (!key) return { ok: false, error: 'unknown_workspace', detail: '没有指定 workspace，也没有 defaultWorkspace' };
  if (!Object.prototype.hasOwnProperty.call(table, key)) {
    return { ok: false, error: 'unknown_workspace', alias: key, detail: 'config.dispatch.workspaces 里没有这个别名' };
  }
  const raw = table[key];
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'unknown_workspace', alias: key, detail: '别名对应的值不是路径字符串' };
  }
  let real = '';
  try {
    real = realpathSync(path.resolve(raw.trim()));
  } catch (e) {
    return { ok: false, error: 'workspace_missing', alias: key, detail: '目录不存在或不可访问：' + clip((e && e.message) || e, 200) };
  }
  let st = null;
  try { st = statSync(real); } catch (e) {
    return { ok: false, error: 'workspace_missing', alias: key, detail: '目录不可访问：' + clip((e && e.message) || e, 200) };
  }
  if (!st || typeof st.isDirectory !== 'function' || !st.isDirectory()) {
    return { ok: false, error: 'workspace_missing', alias: key, detail: '目标不是目录' };
  }
  if (isDriveRoot(real)) {
    return { ok: false, error: 'workspace_missing', alias: key, reason: 'drive_root', detail: '工作目录不能是盘根' };
  }
  if (depthOf(real) < 2) {
    return { ok: false, error: 'workspace_missing', alias: key, reason: 'too_shallow', detail: '工作目录深度必须 ≥2（不能是盘根/一级目录）' };
  }
  return { ok: true, alias: key, root: path.resolve(raw.trim()), realpath: real };
}

/** 路径是否在 root 内（两侧都先 resolve；Windows 大小写不敏感）。 */
export function isInsideRoot(root, target) {
  if (!root) return false;
  const r = path.resolve(root);
  const t = path.resolve(target);
  const cs = process.platform === 'win32';
  const a = cs ? r.toLowerCase() : r;
  const b = cs ? t.toLowerCase() : t;
  return b === a || b.startsWith(a + path.sep);
}

// ── 文件快照 ─────────────────────────────────────────────────────────────

/**
 * 递归拍快照。只读 mtime+size（不读文件内容），返回相对路径 → 指纹。
 * 跳过 .git/node_modules/dist/build/.venv 等；上限 4000 文件；可选 maxMs 时间预算
 * （主进程内同步遍历，超预算就带着已收集的部分返回并标 truncated，避免卡住皮套）。
 * 超限不抛错 —— 快照失败不能阻塞结案（§6）。
 * @returns {{ok:boolean, root:string, at:number, digest:string, files:object,
 *            fileCount:number, bytes:number, truncated:boolean, unavailableReason:string|null}}
 */
export function snapshotWorkdir(root, opts = {}) {
  const maxFiles = Math.max(1, Number(opts.maxFiles) || SNAPSHOT_MAX_FILES);
  const maxBytes = Math.max(1, Number(opts.maxBytes) || SNAPSHOT_MAX_BYTES);
  const maxMs = Math.max(0, Number(opts.maxMs) || 0);
  const startedMs = Date.now();
  const skipDirs = new Set((opts.skipDirs || SNAPSHOT_SKIP_DIRS).map((x) => String(x).toLowerCase()));
  const at = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const abs = root ? path.resolve(root) : '';
  const files = Object.create(null);
  let fileCount = 0;
  let bytes = 0;
  let truncated = false;
  if (!abs) return { ok: false, root: '', at, digest: '', files, fileCount, bytes, truncated, unavailableReason: 'no_workspace' };

  const stack = [''];
  try {
    while (stack.length) {
      const relDir = stack.pop();
      const dirAbs = relDir ? path.join(abs, relDir) : abs;
      let ents = [];
      try { ents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch (e) {
        // 某个子目录读不到：不整体失败，记 unavailable 线索即可
        truncated = true; continue;
      }
      for (const ent of ents) {
        const rel = relDir ? (relDir + '/' + ent.name) : ent.name;
        if (ent.isDirectory()) {
          if (skipDirs.has(ent.name.toLowerCase())) continue;
          stack.push(rel);
          continue;
        }
        if (!ent.isFile()) continue;   // 符号链接/设备不跟：避免越界与环
        if (fileCount >= maxFiles) { truncated = true; break; }
        if (maxMs && (Date.now() - startedMs) >= maxMs) { truncated = true; break; }
        try {
          const st = fs.statSync(path.join(dirAbs, ent.name));
          files[normRel(rel)] = Math.round(Number(st.mtimeMs) || 0) + ':' + (Number(st.size) || 0);
          fileCount += 1;
          bytes += Number(st.size) || 0;
        } catch (e) { truncated = true; }
      }
      if (fileCount >= maxFiles) { truncated = true; break; }
      if (maxMs && (Date.now() - startedMs) >= maxMs) { truncated = true; break; }
    }
  } catch (e) {
    return { ok: false, root: abs, at, digest: '', files, fileCount, bytes, truncated: true, unavailableReason: clip((e && e.message) || e, 200) };
  }
  const keys = Object.keys(files).sort();
  const digest = crypto.createHash('sha1')
    .update(keys.map((k) => k + ':' + files[k]).join('\n'))
    .digest('hex');
  return { ok: true, root: abs, at, digest, files, fileCount, bytes, truncated, unavailableReason: null };
}

/**
 * 两次快照的差异。paths 都是 root 相对路径（统一 `/`）。
 * @returns {{created:string[], modified:string[], deleted:string[], changed:boolean}}
 */
export function diffSnapshots(before, after) {
  const b = (before && before.files) || {};
  const a = (after && after.files) || {};
  const created = [];
  const modified = [];
  const deleted = [];
  for (const k of Object.keys(a)) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) created.push(k);
    else if (b[k] !== a[k]) modified.push(k);
  }
  for (const k of Object.keys(b)) {
    if (!Object.prototype.hasOwnProperty.call(a, k)) deleted.push(k);
  }
  created.sort(); modified.sort(); deleted.sort();
  return { created, modified, deleted, changed: (created.length + modified.length + deleted.length) > 0 };
}

/**
 * 等落盘：文件系统连续 stableMs 没有新变化 → 稳定；最多等 maxMs。
 *
 * 首选 fs.watch(recursive)（Windows/macOS 支持）：事件驱动，不对主进程做周期性
 * 全树遍历 —— 4000 文件的 project 每 200ms 走一遍会卡住皮套动画。
 * 平台不支持/句柄耗尽时退回 mtime 指纹轮询（Linux 无 recursive watch）。
 */
export async function settleWorkdir(root, opts = {}) {
  const stableMs = Math.max(0, Number(opts.stableMs) || 1000);
  const maxMs = Math.max(stableMs, Number(opts.maxMs) || 5000);
  const intervalMs = Math.max(20, Number(opts.intervalMs) || 200);
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const snap = typeof opts.snapshotFn === 'function' ? opts.snapshotFn : snapshotWorkdir;
  if (!root) return { settled: true, waitedMs: 0, digest: '', reason: 'no_workspace', via: 'none' };
  const started = now();

  // ① 事件驱动：任何 change/rename 都把「最后变化时刻」推到现在
  let lastChangeAt = started;
  let changes = 0;
  let watcher = null;
  if (opts.useWatch !== false) {
    try {
      watcher = fs.watch(root, { recursive: true });
      const bump = () => { lastChangeAt = now(); changes += 1; };
      watcher.on('change', bump);
      watcher.on('rename', bump);
      watcher.on('error', () => { /* 句柄断了就按当前静默时长收口 */ });
    } catch (e) {
      try { if (watcher) watcher.close(); } catch (e2) { /* ignore */ }
      watcher = null;
    }
  }
  if (watcher) {
    try {
      for (;;) {
        const t = now();
        const quietFor = t - lastChangeAt;
        const elapsed = t - started;
        if (quietFor >= stableMs) {
          return { settled: true, waitedMs: elapsed, digest: '', reason: null, via: 'watch', changes };
        }
        if (elapsed >= maxMs) {
          return { settled: false, waitedMs: elapsed, digest: '', reason: 'settle_timeout', via: 'watch', changes };
        }
        await sleep(Math.min(intervalMs, Math.max(10, maxMs - elapsed), Math.max(10, stableMs - quietFor)));
      }
    } finally {
      try { watcher.close(); } catch (e) { /* ignore */ }
    }
  }

  // ② 回退：mtime 指纹轮询（只在 watch 不可用时）
  let lastDigest = null;
  let lastPollChange = started;
  for (;;) {
    const snapshot = snap(root, { quiet: true, now: now() });
    const t = now();
    if (!snapshot || !snapshot.ok) {
      return { settled: false, waitedMs: t - started, digest: '', reason: (snapshot && snapshot.unavailableReason) || 'snapshot_failed', via: 'poll' };
    }
    if (snapshot.digest !== lastDigest) { lastDigest = snapshot.digest; lastPollChange = t; }
    const quietFor = t - lastPollChange;
    const elapsed = t - started;
    if (quietFor >= stableMs) return { settled: true, waitedMs: elapsed, digest: lastDigest, reason: null, via: 'poll' };
    if (elapsed >= maxMs) return { settled: false, waitedMs: elapsed, digest: lastDigest, reason: 'settle_timeout', via: 'poll' };
    await sleep(Math.min(intervalMs, Math.max(10, maxMs - elapsed)));
  }
}

// ── verify 执行（§4.1）────────────────────────────────────────────────────

function firstToken(command) {
  const s = String(command || '').trim();
  if (!s) return '';
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end > 0 ? s.slice(1, end) : s.slice(1);
  }
  return s.split(/\s+/)[0] || '';
}

function baseNameLower(p) {
  return String(p || '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

/**
 * 非零退出时判 fail 还是 broken：
 *   · 解释器/命令本身缺失（node/python/… not recognized、9009、where 查不到）→ broken（环境坏）；
 *   · 业务文件缺失（stderr/输出里 ENOENT + 非解释器路径）→ fail（模型没产出）；
 *   · 其余 → fail（业务验收没过）。
 * commandMissing 由 runVerify 用 `where`/`which` 预探测（避免 GBK/OEM 输出乱码导致误判）。
 */
export function classifyVerifyFailure({ exitCode, output, command, commandMissing = false } = {}) {
  const text = String(output || '');
  const tok = baseNameLower(firstToken(command));
  if (commandMissing === true) {
    return { verdict: 'broken', why: '命令不存在：' + clip(firstToken(command), 120) };
  }
  const interpreterMissing = /(?:'|")?(node|nodejs|python|python3|py)(?:\.exe)?(?:'|")?\s*(?:不是内部或外部命令|not recognized|command not found)/i.test(text)
    || new RegExp('（?\\b' + (tok || 'node') + '(?:\\.exe)?\\b[^\\n]{0,80}(?:not recognized|不是内部或外部命令|command not found)', 'i').test(text);
  if (interpreterMissing) return { verdict: 'broken', why: '解释器/命令不可用（环境问题）' };
  // Python 缺业务文件的措辞不是 ENOENT，而是 can't open file / No such file or directory
  if (/(?:can't open file|can’t open file|\[Errno 2\])/i.test(text)) {
    return { verdict: 'fail', why: '业务文件缺失（解释器报 Errno 2）' };
  }
  if (Number(exitCode) === 9009) {
    if (INTERPRETER_RE.test(tok)) return { verdict: 'broken', why: '解释器不存在（cmd 9009）' };
    return { verdict: 'broken', why: '命令不存在（cmd 9009）' };
  }
  const enoent = text.match(/ENOENT[^\n]*?['"`]?([^'"`\n]+)['"`]?/i);
  if (enoent) {
    const target = String(enoent[1] || '').trim();
    if (!INTERPRETER_RE.test(baseNameLower(target))) {
      return { verdict: 'fail', why: '业务文件缺失（ENOENT）：' + clip(target, 120) };
    }
    return { verdict: 'broken', why: '解释器缺失（ENOENT）：' + clip(target, 120) };
  }
  return { verdict: 'fail', why: '验收命令非零退出（' + Number(exitCode) + '）' };
}

// cmd 内置命令：`where` 查不到但确实能跑，不能误判成 broken。
const SHELL_BUILTINS = new Set([
  'echo', 'dir', 'type', 'copy', 'move', 'del', 'erase', 'cd', 'chdir', 'set', 'if', 'for',
  'goto', 'call', 'exit', 'start', 'md', 'mkdir', 'rd', 'rmdir', 'ren', 'rename', 'cls',
  'ver', 'vol', 'date', 'time', 'path', 'title', 'color', 'pushd', 'popd', 'setlocal',
  'endlocal', 'shift', 'break', 'pause', 'rem', 'assoc', 'ftype', 'mklink', 'where', 'find',
  'findstr', 'sort', 'more', 'not', 'errorlevel', 'exist',
]);

/** 命令的第一个 token 在当前机器上是否可执行（只用于失败归因，不影响退出码）。 */
export function commandExists(command, deps = {}) {
  const token = firstToken(command).replace(/^["']|["']$/g, '');
  if (!token) return true;
  if (/[\\/]/.test(token)) {
    try {
      const target = path.isAbsolute(token) ? token : path.resolve(deps.cwd || process.cwd(), token);
      return fs.existsSync(target);
    } catch (e) { return false; }
  }
  if (SHELL_BUILTINS.has(baseNameLower(token))) return true;
  const runner = typeof deps.spawnSync === 'function' ? deps.spawnSync : spawnSync;
  try {
    const r = runner(process.platform === 'win32' ? 'where.exe' : 'which', [token], {
      windowsHide: true, timeout: 2000, encoding: 'utf8',
    });
    return r && r.status === 0;
  } catch (e) {
    return true;   // 探测失败不冤判：按普通 fail 走
  }
}

function killTree(pid) {
  if (!pid) return { ok: false, error: 'no_pid' };
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
      return { ok: r.status === 0, code: r.status, output: clip((r.stdout || '') + (r.stderr || ''), 300) };
    }
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { process.kill(pid, 'SIGKILL'); }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: clip((e && e.message) || e, 200) };
  }
}

/**
 * 跑一条验收命令，四态返回。
 * @param {string} command
 * @param {{cwd?:string, timeoutMs?:number, spawnImpl?:Function, killImpl?:Function,
 *          now?:Function, env?:object, outputMax?:number}} opts
 * @returns {Promise<{command:string, verdict:'pass'|'fail'|'broken'|'timeout'|'none',
 *                    exitCode:number|null, output:string, ranAt:number, tookMs:number,
 *                    why:string, timedOut:boolean}>}
 */
export async function runVerify(command, opts = {}) {
  const cmd = String(command == null ? '' : command).trim();
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const ranAt = now();
  if (!cmd) return { command: '', verdict: 'none', exitCode: null, output: '', ranAt, tookMs: 0, why: '没有验收命令', timedOut: false };
  const timeoutMs = Math.max(1000, Math.min(10 * 60 * 1000, Number(opts.timeoutMs) || VERIFY_TIMEOUT_DEFAULT));
  const outputMax = Math.max(200, Number(opts.outputMax) || OUTPUT_KEEP);
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;
  const killImpl = typeof opts.killImpl === 'function' ? opts.killImpl : killTree;
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const isWin = process.platform === 'win32';
  // /d 跳过 AutoRun，/s 保留命令内部的引号，/c 执行；windowsVerbatimArguments 让
  // Node 不再替我们加引号 —— 多引号命令（node -e "..."）不会被 cmd 拆坏。
  const exe = isWin ? 'cmd' : '/bin/sh';
  const args = isWin ? ['/d', '/s', '/c', '"' + cmd + '"'] : ['-c', cmd];
  const spawnOpts = { cwd, env, windowsHide: true, windowsVerbatimArguments: isWin, shell: false };

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let out = '';
    let err = '';
    let pid = 0;
    let timer = null;
    const finish = (verdict, exitCode, why) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const output = clip((out + (err ? ('\n' + err) : '')).trim(), outputMax);
      resolve({ command: cmd, verdict, exitCode, output, ranAt, tookMs: Math.max(0, now() - ranAt), why, timedOut });
    };
    let child;
    try {
      child = spawnImpl(exe, args, spawnOpts);
    } catch (e) {
      const msg = String((e && e.message) || e);
      return finish('broken', null, '启动验收命令失败：' + clip(msg, 160));
    }
    if (!child) return finish('broken', null, '启动验收命令失败：spawn 返回空');
    pid = child.pid || 0;
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', (c) => { out += c.toString(); });
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', (c) => { err += c.toString(); });
    timer = setTimeout(() => {
      timedOut = true;
      try { killImpl(pid, child); } catch (e) { try { child.kill(); } catch (e2) { /* 已退出 */ } }
      finish('timeout', null, '验收命令超时（' + timeoutMs + 'ms）');
    }, timeoutMs);
    if (typeof child.on === 'function') {
      child.on('error', (e) => {
        if (timedOut) return;
        const msg = String((e && e.message) || e);
        if (e && (e.code === 'ENOENT' || /ENOENT/.test(msg))) {
          return finish('broken', null, '验收命令的 shell/解释器不存在：' + clip(msg, 160));
        }
        finish('broken', null, '验收命令启动失败：' + clip(msg, 160));
      });
      child.on('exit', (code) => {
        if (timedOut) return;
        const exitCode = Number.isFinite(Number(code)) ? Number(code) : null;
        if (exitCode === 0) return finish('pass', 0, '验收通过');
        const cls = classifyVerifyFailure({
          exitCode,
          output: out + '\n' + err,
          command: cmd,
          // 只在失败时探测一次：OEM/GBK 乱码下光看输出判断不了「命令不存在」
          commandMissing: !commandExists(cmd, { cwd }),
        });
        finish(cls.verdict, exitCode, cls.why);
      });
    }
    // 假 child（只有流没有 on）也要能退出：测试注入的替身一般会 emit exit。
  });
}

export default {
  resolveWorkspace,
  isInsideRoot,
  snapshotWorkdir,
  diffSnapshots,
  settleWorkdir,
  runVerify,
  classifyVerifyFailure,
  commandExists,
  VERDICT_OUTCOME,
};
