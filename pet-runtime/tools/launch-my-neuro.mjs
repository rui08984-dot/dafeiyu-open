// launch-my-neuro.mjs —— 产品启动器：直接拉起「my-neuro 宿主 + 我们的身体」，崩溃自动重启。
//
// 2026-11-21 根因修复（六项，见 _probe/test-launcher-resilience.cjs 的回归断言）：
//   ① TTS 启动闸门：__ttsStarting 原来置 true 后全仓无复位点，edge-tts 崩一次就永久不再拉起。
//      现在闸门只覆盖 spawn 窗口，spawn 成功/失败/子进程 exit/启动超时四条路径都会复位。
//   ② killStale 不再「按端口杀别人的进程」：只杀上一次自己记在 lock 文件里的 spawnedPids。
//   ③ 单实例锁：pet-runtime/.state/launcher.lock（pid + 启动时间 + 子进程 pid 清单）。
//   ④ watchdog 用「时间窗内失败次数」计数，超限退避 30/60/120s，不再靠「本轮活过 60s」清零。
//   ⑤ PET_DEVTOOLS=0 时 8004/eval 本来就不可用，不再把它当渲染层卡死（否则约 2.5 分钟杀一次）。
//   ⑥ 服务端口/启动方式统一读 tools/services.json（与 kill-all / restart-pet / doctor 共用）。
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..', '..', '_incoming', 'my-neuro', 'live-2d');
const electron = join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const logDir = resolve(here, '..', '.state');
const logFile = join(logDir, 'my-neuro.out.log');
const LOCK_PATH = process.env.PET_LAUNCHER_LOCK || join(logDir, 'launcher.lock');
const SELF = fileURLToPath(import.meta.url);

// Python 解释器统一走宿主的 runtime-paths（排除微软商店占位符），别裸 spawn('py')。
const requireApp = createRequire(import.meta.url);
const PY_BIN = (() => {
  try { return requireApp(resolve(appDir, 'js', 'core', 'runtime-paths.js')).resolvePython(); }
  catch (e) {
    console.warn('[launcher] runtime-paths 不可用，回落 py:', e && e.message || e);
    return process.platform === 'win32' ? 'py' : 'python3';
  }
})();

// 直接执行（node launch-my-neuro.mjs）才启动；被 import（测试）时只导出纯函数。
// Windows 路径大小写/短名不敏感：realpath + 小写比较，避免「明明是主程序却当成 import」。
const IS_MAIN = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const norm = (p) => {
    try { return realpathSync(p).toLowerCase(); } catch (e) { return resolve(p).toLowerCase(); }
  };
  try { return norm(argv1) === norm(SELF); } catch (e) { return false; }
})();

// ── 日志轮转（2026-11-12）───────────────────────────────────────────────
// 实测这个文件涨到 184MB / 267 万行：子进程的每一帧 console.log 都 append 进来，
// 而且没有任何上限。真正要看的 watchdog/报错全被埋掉，C 盘也被吃掉。
// 这里按 10MB 轮转，只留一份 .1（旧的可随时删）。
const LOG_MAX_BYTES = 10 * 1024 * 1024;
let logBytes = 0;
try { logBytes = existsSync(logFile) ? statSync(logFile).size : 0; } catch (e) { logBytes = 0; }

function rotateLogIfNeeded() {
  if (logBytes <= LOG_MAX_BYTES) return;
  try {
    const old = logFile + '.1';
    if (existsSync(old)) unlinkSync(old);
    renameSync(logFile, old);
  } catch (e) { /* 轮转失败不影响主链，下一次再试 */ }
  logBytes = 0;
}

function appendLog(prefix, chunk) {
  try {
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const head = prefix ? Buffer.from(prefix) : null;
    rotateLogIfNeeded();
    appendFileSync(logFile, head ? Buffer.concat([head, body]) : body);
    logBytes += body.length + (head ? head.length : 0);
  } catch (e) { /* 写日志失败绝不能拖垮 launcher */ }
}

// 持久日志 + 控制台：TTS 之类的启动失败必须留在 my-neuro.out.log 里，别只闪一下控制台。
function logBoth(prefix, line) {
  console.log(line);
  appendLog(prefix || null, line + String.fromCharCode(10));
}

// 服务清单（单一事实源）：launcher 也读同一份，端口/超时不再各处硬编码。
const MANIFEST = (() => {
  try { return loadServicesManifest(); } catch (e) {
    console.warn('[launcher] 读 services.json 失败（回退内置端口）:', e && e.message || e);
    return { version: 0, services: [] };
  }
})();
const portOf = (id, fallback) => {
  const s = MANIFEST.services.find((x) => x.id === id);
  return s && Number(s.port) ? Number(s.port) : fallback;
};
const startTimeoutOf = (id, fallback) => {
  const s = MANIFEST.services.find((x) => x.id === id);
  return s && Number(s.startTimeoutMs) ? Number(s.startTimeoutMs) : fallback;
};
const TTS_PORT = portOf('tts', 9883);
const ASR_PORT = portOf('asr', 1000);
const COWATCH_PORT = portOf('cowatch', 1001);
const CONTROL_PORT = portOf('control', 8103);
const MEMOS_PORT = portOf('memos', 8003);
const SEMANTIC_PORT = portOf('semantic', 8120);
const healthUrlOf = (id, fallback) => {
  const s = MANIFEST.services.find((x) => x.id === id);
  return (s && s.health && s.health.url) ? s.health.url : fallback;
};
const TTS_HEALTH = healthUrlOf('tts', 'http://127.0.0.1:9883/health');
const MEMOS_HEALTH = healthUrlOf('memos', 'http://127.0.0.1:8003/health');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
delete env.ELECTRON_ENABLE_LOGGING;

// ══════════════════════════════════════════════════════════════════════════
// 可测试原语（纯函数 / 依赖注入，不碰真实进程）
// ══════════════════════════════════════════════════════════════════════════

// 单实例锁。内容：{ pid, startedAt, startedAtISO, script, spawnedPids }。
// 判定：锁里的 pid 还活着 → 拒绝；进程已死（崩溃/断电残留）→ 视为陈旧，接管。
export function defaultIsPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

export function readInstanceLock(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); } catch (e) { return null; }
}

export function acquireInstanceLock(lockPath, opts = {}) {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? defaultIsPidAlive;
  // 2026-11-22 修复：pid 活着不等于「锁的持有人还活着」——进程被杀后 pid 会被系统复用。
  // 旧实现只看 process.kill(pid,0)，复用后会误判「已有实例」，从而永远不启动新宿主
  // （restart-pet 等 90s 后回退直起 electron，失去监督）。现在允许注入持有人校验。
  const isHolder = opts.isHolder ?? (() => true);
  const previous = readInstanceLock(lockPath);
  if (previous && Number(previous.pid) !== Number(pid) && isAlive(previous.pid) && isHolder(previous)) {
    return { ok: false, reason: 'held', holder: previous };
  }
  const lock = {
    pid,
    startedAt: now,
    startedAtISO: new Date(now).toISOString(),
    script: opts.script || SELF,
    spawnedPids: Array.isArray(opts.spawnedPids) ? opts.spawnedPids : [],
  };
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    const tmp = lockPath + '.' + pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(lock, null, 2));
    renameSync(tmp, lockPath);
  } catch (e) {
    return { ok: false, reason: 'io-error', error: e && e.message || String(e), holder: previous };
  }
  return { ok: true, lock, previous };
}

export function updateLockPids(lockPath, pid, pids) {
  const cur = readInstanceLock(lockPath);
  if (!cur || Number(cur.pid) !== Number(pid)) return false;   // 不是我们的锁，别改
  try {
    writeFileSync(lockPath, JSON.stringify({ ...cur, spawnedPids: [...new Set([pid, ...pids])] }, null, 2));
    return true;
  } catch (e) { return false; }
}

export function releaseInstanceLock(lockPath, pid) {
  const cur = readInstanceLock(lockPath);
  if (!cur) return false;
  if (Number(cur.pid) !== Number(pid)) return false;
  try { unlinkSync(lockPath); return true; } catch (e) { return false; }
}

// 时间窗失败计数 + 退避。**不再用「本轮存活时长」清零**：
// 每 ~2.5 分钟被杀一次的进程，每轮都「活过 60s」，用存活时长清零等于上限永不触发。
// 返回 { fails, delayMs, backoff, stop }；1..maxFails 次 delay=0，之后 30s/60s/120s 递增并封顶。
export function createFailurePolicy(opts = {}) {
  const windowMs = opts.windowMs ?? 10 * 60 * 1000;
  const maxFails = opts.maxFails ?? 6;
  const backoffMs = opts.backoffMs ?? [30000, 60000, 120000];
  const hardStopAfter = opts.hardStopAfter ?? 0;   // 0 = 不硬停
  let fails = [];
  const prune = (now) => { fails = fails.filter((t) => now - t < windowMs); };
  return {
    fail(now = Date.now()) {
      prune(now);
      fails.push(now);
      const n = fails.length;
      const stop = hardStopAfter > 0 && n >= hardStopAfter;
      if (n <= maxFails) return { fails: n, delayMs: 0, backoff: false, stop };
      const idx = Math.min(n - maxFails - 1, backoffMs.length - 1);
      return { fails: n, delayMs: backoffMs[idx], backoff: true, stop };
    },
    // 成功不清零，只让过期失败自然滑出窗口（这正是「窗口」语义）
    ok(now = Date.now()) { prune(now); return fails.length; },
    count(now = Date.now()) { prune(now); return fails.length; },
  };
}

// edge-tts 启动闸门。
// 旧实现：globalThis.__ttsStarting = true 之后只有 return 那一行读它，**没有任何复位点**；
// 子进程 exit 后 2s 重试再次进入 startTts() 被「已在启动中」挡掉 → 9883 永久离线。
// 新实现：闸门只覆盖 spawn() 这一瞬间；spawn 抛错/拿不到句柄/子进程 exit/启动超时
// 都会复位并安排重试，且任何时刻最多只有一个待执行的重试定时器。
export function createTtsGate(opts = {}) {
  const log = opts.log || (() => {});
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const retryDelayMs = opts.retryDelayMs ?? 2000;
  const startTimeoutMs = opts.startTimeoutMs ?? 60000;
  const spawnChild = opts.spawnChild;
  const probe = opts.probe || null;            // async () => boolean；启动超时兜底用
  const isStopped = opts.isStopped || (() => false);

  let starting = false;
  let child = null;
  let exited = false;
  let retryTimer = null;
  let spawnCount = 0;

  function clearRetry() {
    if (retryTimer) { try { clearTimeoutFn(retryTimer); } catch (e) {} retryTimer = null; }
  }
  function scheduleRetry(why) {
    if (isStopped()) return;
    clearRetry();
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      // onRetry 用于「重试前先判端口」：端口被别的实例占着时不要再 spawn，
      // 否则会每 2 秒崩一次、无限刷日志（2026-11-22 实测的 churn）。
      if (opts.onRetry) { try { opts.onRetry(); } catch (e) { start(); } }
      else start();
    }, retryDelayMs);
    retryTimer?.unref?.();
    log('[launcher] edge-tts 将在 ' + retryDelayMs + 'ms 后重试（' + why + '）');
  }

  function start() {
    if (isStopped()) return { started: false, reason: 'stopped' };
    if (starting) { log('[launcher] edge-tts 已在启动中'); return { started: false, reason: 'starting' }; }
    if (child && !exited) { log('[launcher] edge-tts 已在运行'); return { started: false, reason: 'running' }; }
    starting = true;
    let c = null;
    try {
      c = spawnChild();
    } catch (e) {
      starting = false;                                   // ← 失败路径复位
      log('[launcher] edge-tts 启动失败: ' + ((e && e.message) || e));
      scheduleRetry('spawn-error');
      return { started: false, reason: 'spawn-error' };
    }
    spawnCount += 1;
    if (!c) {
      starting = false;                                   // ← 拿不到句柄也复位
      log('[launcher] edge-tts 启动失败: 没有拿到子进程句柄');
      scheduleRetry('no-child');
      return { started: false, reason: 'no-child' };
    }
    starting = false;                                     // ← spawn 成功立即复位（关键修复）
    child = c;
    exited = false;

    c.on?.('exit', (code, signal) => {
      exited = true;
      child = null;
      log('[launcher] edge-tts 退出 (code=' + code + ' signal=' + (signal || '-') + ')');
      scheduleRetry('exit');
    });
    c.stdout?.on?.('data', (d) => { appendLog('[tts] ', d); });
    c.stderr?.on?.('data', (d) => { appendLog('[tts] ', d); });

    // 超时兜底：spawn 成功但既不退出也不监听（卡在 import / 端口被占反复重试）→ 杀掉重来。
    if (probe) {
      const watchdog = setTimeoutFn(async () => {
        if (exited || isStopped()) return;
        let up = false;
        try { up = await probe(); } catch (e) { up = false; }
        if (up) return;
        starting = false;
        log('[launcher] edge-tts 启动超时（' + startTimeoutMs + 'ms 内 ' + TTS_PORT + ' 未就绪），复位闸门并重启');
        child = null;                 // 先摘掉引用，重试时不会被「已在运行」挡住
        exited = true;
        try { c.kill(); } catch (e) {}
        scheduleRetry('timeout');
      }, startTimeoutMs);
      watchdog?.unref?.();
    }
    log('[launcher] edge-tts 已启动');
    return { started: true, child: c };
  }

  return {
    start,
    stop() {
      clearRetry();
      try { child && child.kill(); } catch (e) {}
    },
    state() { return { starting, hasChild: !!child && !exited, retryScheduled: !!retryTimer, spawnCount }; },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 服务清单（单一事实源）
// ══════════════════════════════════════════════════════════════════════════
export function servicesManifestPath() { return join(here, 'services.json'); }
export function loadServicesManifest() {
  const raw = JSON.parse(readFileSync(servicesManifestPath(), 'utf8'));
  return { ...raw, services: Array.isArray(raw.services) ? raw.services : [] };
}

// 启动前的准备工作 ────────────────────────────────────────────────────────
// 1) 从 DSH 凭证库注入模型密钥（llm_providers.json 里只留占位符）
// 2) 体检模型端点：主 provider 不通时自动切到下一个可用的，避免「网络连接失败」糊在脸上
function runCredSync() {
  try {
    const out = execSync('node "' + join(here, 'sync-credentials.mjs') + '"', { encoding: 'utf8', windowsHide: true });
    console.log(out.trim());
    return true;
  } catch (error) {
    console.error('[launcher] 密钥注入失败:', (error.stdout || '').trim() || error.message);
    return false;
  }
}

async function probeEndpoint(url, timeoutMs = 6000) {
  // 只探「端点活着吗」。401/403/404 都算活着（说明服务器在响应，只是 /models 需要真 key，
  // 或者这个网关根本不实现 /models）；只有 5xx、超时、DNS/连接失败才算死。
  // 远端抖动很常见，所以失败重试一次再判定。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const r = await fetch(String(url).replace(/\/+$/, '') + '/models', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer probe' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (r.status < 500) return true;
    } catch (error) {
      // 继续重试
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

// 决定这一轮用哪个 provider。
//
// 关键原则：**探测失败不等于服务死了**。远端 API 偶发超时、代理抖动都会让探测误判，
// 如果因此改写 config 就会把本来好好的配置改坏。所以这里的策略是：
//   1) 当前配置的 provider 能探通 → 立刻返回，什么都不改；
//   2) 当前探不通 → 再找别的候选；只有「确认别的活着」才切换；
//   3) 全都探不通 → 保持原配置不动，只警告（让应用自己去报错，别在这里瞎改）。
async function ensureUsableProvider() {
  const provPath = join(appDir, 'llm_providers.json');
  const cfgPath = join(appDir, 'config.json');
  let data, cfg;
  try {
    data = JSON.parse(readFileSync(provPath, 'utf8'));
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (error) {
    console.error('[launcher] 读配置失败:', error.message);
    return null;
  }

  const providers = (data.providers || []).filter((p) => p.enabled && p.models && p.models.length);
  if (!providers.length) { console.error('[launcher] ⚠ 没有启用的 provider'); return null; }

  const currentId = cfg.llm && cfg.llm.provider_id;
  const current = providers.find((p) => p.id === currentId);

  // 1) 当前配置的优先
  if (current) {
    if (await probeEndpoint(current.api_url)) {
      console.log('[launcher] ✓ ' + current.id + ' 可用（当前配置）');
      return current;
    }
    console.log('[launcher] … ' + current.id + ' 探测失败，尝试其它 provider');
  }

  // 2) 找替代
  for (const provider of providers) {
    if (provider === current) continue;
    if (!(await probeEndpoint(provider.api_url))) {
      console.log('[launcher] ✗ ' + provider.id + ' 不可达: ' + provider.api_url);
      continue;
    }
    const model = (provider.models.find((m) => m.enabled) || provider.models[0]).model_id;
    console.log('[launcher] ✓ ' + provider.id + ' 可用 → 切换模型为 ' + model);
    cfg.llm = cfg.llm || {};
    cfg.llm.provider_id = provider.id;
    cfg.llm.model_id = model;
    try { writeFileSync(cfgPath, JSON.stringify(cfg, null, 4)); } catch (e) {}
    return provider;
  }

  // 3) 全都不通：保持原样，交给应用自己报错
  console.warn('[launcher] ⚠ 所有 provider 都没探通；保持现有配置不变（可能是网络抖动，先跑起来再说）');
  return current || providers[0];
}

// ══════════════════════════════════════════════════════════════════════════
// 运行时（仅 boot() 使用）
// ══════════════════════════════════════════════════════════════════════════
let stop = false;
let currentChild = null;
let startedAt = Date.now();
const spawnedPids = new Set();          // 只记录「我们自己拉起来的」pid
let lockHeld = false;

function trackPid(child) {
  if (!child || !child.pid) return child;
  spawnedPids.add(child.pid);
  persistPids();
  child.once?.('exit', () => { spawnedPids.delete(child.pid); persistPids(); });
  return child;
}
function persistPids() {
  if (!lockHeld) return;
  updateLockPids(LOCK_PATH, process.pid, [...spawnedPids]);
}

const portUp = (port) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port });
  s.setTimeout(800);
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('timeout', () => { s.destroy(); res(false); });
  s.once('error', () => res(false));
});

// 只清理「上一次本 launcher 自己启动的」子进程。
// 旧实现按端口 netstat 找 pid 再 taskkill —— 会杀掉别的实例/别的项目的服务（缺陷 3）。
// pid 可能被系统复用：杀之前必须**同时**核对镜像名与命令行（只有镜像名不够：
// 别的 Electron 应用/别的 node 项目也可能是 electron.exe/node.exe）。
const OURS_IMAGES = new Set(['electron.exe', 'py.exe', 'python.exe', 'pythonw.exe', 'node.exe', 'ollama.exe']);

// 统一用 -EncodedCommand 调 Windows PowerShell：脚本里的中文路径不会经过
// 命令行 UTF-8→GBK 二次解码（本仓历史坑），也不需要拼引号。
function runPs(script, timeoutMs = 8000) {
  const b64 = Buffer.from(String(script), 'utf16le').toString('base64');
  return execSync('powershell -NoProfile -NonInteractive -EncodedCommand ' + b64,
    { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
}

function readPidMeta(pids) {
  const list = [...new Set(pids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return new Map();
  const filter = list.map((p) => 'ProcessId=' + p).join(' or ');
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Get-CimInstance Win32_Process -Filter "' + filter + '" | ForEach-Object {',
    "  $st=''; try { $st=(Get-Process -Id $_.ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch {}",
    '  "$($_.ProcessId)|$($_.Name)|$st|$($_.CommandLine)"',
    '}',
  ].join('; ');
  const out = new Map();
  try {
    const text = runPs(script);
    for (const line of String(text).split(/\r?\n/)) {
      const parts = line.split('|');
      if (parts.length < 4) continue;
      const pid = Number(parts[0]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      out.set(pid, { pid, name: (parts[1] || '').toLowerCase(), startedAt: parts[2] || '', cmd: parts.slice(3).join('|') });
    }
  } catch (e) { /* 查询失败时返回空 Map，调用方按「不确定」处理 */ }
  return out;
}

function isLikelyOurChild(pid, metaMap) {
  const meta = metaMap && metaMap.get(Number(pid));
  if (!meta || !OURS_IMAGES.has(meta.name)) return false;
  const cmd = String(meta.cmd || '').toLowerCase();
  if (!cmd) return false;
  // Electron 必须能看出是**我们这个宿主**（app 路径 live-2d）。同机可能有
  // _probe/soak 的隔离实例：它也在项目根下、也用 combined-project，仅凭根路径会误杀。
  if (meta.name === 'electron.exe' && !cmd.includes('live-2d')) return false;
  // 其它进程：项目根路径，或本项目独有的脚本名。
  const rootLower = resolve(here, '..', '..').toLowerCase();
  if (cmd.includes(rootLower)) return true;
  return ['launch-my-neuro.mjs', 'tts_server.py', 'asr_server.py', 'audio_loop_server.py',
    'memos_api_server', 'voiceprint_server.py', 'lumen-semantic-server.py'].some((k) => cmd.includes(k));
}

// 锁里的 pid 活着，是否真是「本 launcher」？
// pid 复用后可能是一个无关的 node/其它进程；那种情况下必须把锁视为陈旧，否则永远起不来。
// 判据：镜像必须是 node.exe，且进程启动时间与锁写入时间相差不超过 2 分钟
// （正常启动时先写锁后注入密钥，两者只差毫秒级）。
export function isRealLauncherHolder(lock) {
  const pid = Number(lock && lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const meta = readPidMeta([pid]).get(pid);
  if (!meta) return true;                    // 查不到就不冒险双开，按「还活着」处理
  if (meta.name !== 'node.exe') return false;
  const cmd = String(meta.cmd || '').toLowerCase();
  if (!cmd.includes('launch-my-neuro')) return false;
  const lockMs = Number(lock.startedAt);
  const holderMs = Date.parse(meta.startedAt || '');
  if (!Number.isFinite(lockMs) || !Number.isFinite(holderMs)) return true;
  return Math.abs(holderMs - lockMs) <= 120000;
}

function killStaleFromLock(previous) {
  const pids = previous && Array.isArray(previous.spawnedPids) ? previous.spawnedPids : [];
  if (!pids.length) { console.log('[launcher] 没有上次遗留的子进程记录，跳过清理'); return; }
  const alive = pids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid && defaultIsPidAlive(pid));
  const metaMap = readPidMeta(alive);          // 一次查完，避免每个 pid 起一次 PowerShell
  for (const raw of pids) {
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (!defaultIsPidAlive(pid)) continue;
    if (!isLikelyOurChild(pid, metaMap)) {
      console.log('[launcher] pid=' + pid + ' 已被系统复用或不属于本项目（命令行不符），跳过');
      continue;
    }
    try {
      execSync('taskkill /PID ' + pid + '/T /F', { stdio: 'ignore', windowsHide: true });
      console.log('[launcher] 清理上次遗留子进程 pid=' + pid);
    } catch (e) { /* 已经退出 */ }
  }
}

const crashPolicy = createFailurePolicy({ windowMs: 10 * 60 * 1000, maxFails: 6, backoffMs: [30000, 60000, 120000], hardStopAfter: 12 });
const rendererPolicy = createFailurePolicy({ windowMs: 10 * 60 * 1000, maxFails: 3, backoffMs: [30000, 60000, 120000] });

function launch() {
  startedAt = Date.now();
  // 测试时用 PET_QUIET=1 启动：起来后自动切静默，避免她自己在后台说话烧钱
  if (process.env.PET_QUIET === '1') {
    // 控制口要等窗口起来才有，轮询到成功为止
    const tryQuiet = (attempt = 0) => {
      if (attempt > 20) return;
      try {
        const body = JSON.stringify({ on: true });
        const req = httpRequest({ host: '127.0.0.1', port: CONTROL_PORT, path: '/quiet', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
            if (res.statusCode === 200) console.log('[launcher] 已在静默模式下运行（PET_QUIET=1，不主动开口/不调视觉）');
            else setTimeout(() => tryQuiet(attempt + 1), 5000);
            res.resume();
          });
        req.on('error', () => setTimeout(() => tryQuiet(attempt + 1), 5000));
        req.write(body); req.end();
      } catch (e) { setTimeout(() => tryQuiet(attempt + 1), 5000); }
    };
    setTimeout(() => tryQuiet(0), 15000);
  }
  const child = spawn(electron, [appDir], { cwd: appDir, env, windowsHide: false });
  currentChild = child;
  trackPid(child);
  child.stdout.on('data', (d) => { appendLog(null, d) });

  // 启动自检（§27 工程门禁）：语法 + doctor，后台跑、不阻塞启动；红了在日志里喊。
  // 用 --boot 而不是全量：回归要动真实窗口、耗时 50s+，不该每次开机都跑。
  try {
    const gatePath = resolve(here, '..', '..', '_probe', 'check-all.mjs');
    if (existsSync(gatePath)) {
      // 延迟 120s：刚启动时 TTS/MemOS/ASR 还在预热，doctor 会报一堆假异常
      // （实测开机 3 秒跑出 7 异常，预热后是 0）。
      setTimeout(() => {
      const gate = spawn(process.execPath, [gatePath, '--boot'], { windowsHide: true });
      let gateOut = '';
      gate.stdout.on('data', (d) => { gateOut += d; });
      gate.stderr.on('data', (d) => { gateOut += d; });
      gate.on('exit', (code) => {
        const lines = gateOut.split(String.fromCharCode(10)).map((l) => l.trimEnd());
        if (code === 0) {
          const summary = lines.reverse().find((l) => l.includes('全部通过')) || '通过';
          appendLog('[boot] OK 启动自检: ' + summary.trim() + String.fromCharCode(10));
        } else {
          const fails = lines.filter((l) => l.startsWith('FAIL')).map((l) => l.replace(/^FAIL\s+\d+ms\s+/, ''));
          appendLog('[boot] FAIL 启动自检未通过（' + fails.length + ' 项）: ' + fails.slice(0, 6).join(' | ') + String.fromCharCode(10));
        }
      });
      gate.on('error', () => {});
      }, 120000).unref?.();
    }
  } catch (e) { /* 自检本身失败不能拦住她启动 */ }
  child.stderr.on('data', (d) => { appendLog(null, d) });
  const kill = () => { stop = true; try { child.kill(); } catch (e) {} };
  process.once('SIGINT', kill);
  process.once('SIGTERM', kill);
  child.on('exit', (code, signal) => {
    spawnedPids.delete(child.pid);
    persistPids();
    // 退出码 0 = 正常结束（多半是「已有实例」被单实例锁挡掉），不要重启，否则会重启风暴。
    if (code === 0) {
      // ⚠ 2026-11-12 根因修复：原来这里**无条件** process.exit(0)。
      //   TTS/MemOS 是本进程的子进程，父进程一退出它们的 stdout 管道就断，
      //   写入 EPIPE 直接死 —— 用户看到的是「语音和记忆突然都没了」，而且日志只说「正常退出」。
      //   现在先确认 3003 上有没有人接着提供服务：有就留在后台守着服务，没有才退。
      portUp(3003).then((alive) => {
        if (alive) {
          console.log('[launcher] 已有实例在跑 —— 保持 TTS/MemOS 存活，launcher 留在后台（不退出）');
          return;
        }
        console.log('[launcher] 主进程正常退出，且无人接管，停止');
        process.exit(0);
      }).catch(() => process.exit(0));
      return;
    }
    process.removeListener('SIGINT', kill);
    process.removeListener('SIGTERM', kill);
    if (stop) { console.log('[launcher] stopped'); process.exit(0); }
    // 时间窗计数（不再用「活过 60s 就清零」，那会让 >6 的上限永远到不了）
    const verdict = crashPolicy.fail();
    if (verdict.stop) {
      console.error('[launcher] 10 分钟内崩溃 ' + verdict.fails + ' 次，停止自恢复（看 ' + logFile + '）');
      process.exit(1);
    }
    const delay = verdict.backoff ? verdict.delayMs : 1500;
    if (verdict.backoff) {
      console.error('[launcher] ⏸ 崩溃过密（10 分钟窗口内 ' + verdict.fails + ' 次），退避 ' + Math.round(delay / 1000) + 's 再重启');
    }
    console.log('[launcher] 退出 code=' + code + ' signal=' + signal + '，' + (delay / 1000) + 's 后重启');
    setTimeout(launch, delay);
  });
}

// Edge TTS 常驻：my-neuro 的 tts.url 指向它（config.tts.url = http://127.0.0.1:9883/tts）。
const ttsScript = resolve(here, '..', '..', 'edge-tts', 'tts_server.py');
let ttsChild = null;
async function ttsAlive() { try { const r = await fetch(TTS_HEALTH, { signal: AbortSignal.timeout(5000) }); return r.ok; } catch (e) { return false; } }
// MemOS 长期记忆后端（端口 8003）。
// 它自己会去调 :8090 的 llama.cpp 嵌入服务；那个服务由 scripts/start-embed.ps1 负责，
// 探一下在不在，不在就提示而不是硬起（嵌不进去的记忆后端比没有更糟）。
let memosChild = null;
const MEMOS_DIR = join(appDir, '..', 'plugins-dlc', 'memos', 'memos_system');
const MEMOS_ENTRY = join(MEMOS_DIR, 'api', 'memos_api_server_v2.py');

function embedServerAlive() {
  try {
    const out = execSync('curl -s --max-time 3 http://127.0.0.1:8090/health', { encoding: 'utf8' });
    return /"status"\s*:\s*"ok"/.test(out);
  } catch (e) { return false; }
}

// 2026-11-22：「项目启动后这些模型服务应该自己活过来」——8090 是 Docker 容器 llama-embed
// （restart=unless-stopped，Docker 起来就自启）。但 Docker Desktop 没起/容器被手动停过时，
// 旧逻辑只打印「先跑一次 2-start-embed.bat」→ MemOS 跟着起不来、记忆全挂。
// 现在先尝试 docker start 把它拉起来（10 秒内轮询健康），失败才退回人工提示。
async function ensureEmbedServer() {
  if (embedServerAlive()) return true;
  try {
    const names = String(execSync('docker ps -a --filter name=llama-embed --format "{{.Names}}"',
      { encoding: 'utf8', timeout: 8000 })).trim().split(/\r?\n/);
    if (!names.includes('llama-embed')) throw new Error('没有 llama-embed 容器');
    console.log('[launcher] 嵌入服务 :8090 没起来，尝试 docker start llama-embed');
    try { execSync('docker start llama-embed', { encoding: 'utf8', timeout: 20000 }); }
    catch (e) { /* 启动失败也走下面的轮询，最后统一提示 */ }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (embedServerAlive()) { console.log('[launcher] 嵌入服务已拉起 (8090)'); return true; }
    }
  } catch (e) { /* docker 不可用/没容器 → 走人工提示 */ }
  console.log('[launcher] ⚠ 嵌入服务 :8090 仍没起来，MemOS 会启动失败。');
  console.log('[launcher]   先跑一次 pwsh -File scripts/start-embed.ps1（llama.cpp + Qwen3-Embedding-0.6B），或确认 Docker Desktop 已启动');
  return false;
}

let memosHealthFails = 0;
let memosStartedAt = 0;

async function startMemos() {
  if (await portUp(MEMOS_PORT)) { console.log("[launcher] MemOS 已在运行，跳过"); return; }
  if (!existsSync(MEMOS_ENTRY)) { console.log('[launcher] 没找到 MemOS 后端，跳过（确认 _incoming/my-neuro/plugins-dlc/memos/ 存在；缺失见 README）'); return; }
  await ensureEmbedServer();
  memosChild = trackPid(spawn(PY_BIN, [MEMOS_ENTRY], { cwd: MEMOS_DIR, windowsHide: true }));
  // 捕获输出（2026-11-12）：原来 stdio 没接，MemOS 的 [记忆提取] 日志全丢，
  // 出问题只能靠猜。现在进统一日志（带 [memos] 前缀，10MB 轮转）。
  memosChild.stdout.on('data', (d) => appendLog('[memos] ', d));
  memosChild.stderr.on('data', (d) => appendLog('[memos] ', d));
  memosStartedAt = Date.now();   // 健康探针的预热基准
  memosHealthFails = 0;
  memosChild.on('exit', (code) => {
    if (!stop) { console.log('[launcher] MemOS 退出(code=' + code + ')，5 秒后重启'); setTimeout(startMemos, 5000); }
  });
  console.log('[launcher] MemOS 记忆后端已启动 (' + MEMOS_PORT + ')');
}

// ── 本地记忆模型（llama-server 11435，可选）──────────────────────────────
// ADR-014 轨道 2-10：片段卡/MemOS 抽取走本地 4B（MemOperator-4B，28K/q8），省云端配额。
// **默认不自动拉起**（services.json 里 enabled=false）：28K/q8 要占 ~7GB，门禁/游戏期间
// 抢显存会让拖拽/操控测试假红。要常驻时把 enabled 改成 true，重启 launcher 生效；
// 临时用直接 `start-local-memory-llm.ps1 -Daily`。
// 只允许 Daily 档自动启动：Batch/Long（turbo3 KV）实测结构化 JSON 会复读/乱码，见脚本头注释。
let localLlmChild = null;
let localLlmAttempts = 0;
const LOCAL_LLM_ID = 'local-memory-llm';
const LOCAL_LLM_PORT = portOf(LOCAL_LLM_ID, 11435);
const LOCAL_LLM_HEALTH = healthUrlOf(LOCAL_LLM_ID, 'http://127.0.0.1:11435/health');
const LOCAL_LLM_SCRIPT = join(appDir, 'scripts', 'start-local-memory-llm.ps1');
// 手动暂停文件（2026-11-25 用户拍板）：`start-local-memory-llm.ps1 -Stop` 写、`-Daily` 删。
// 存在 = 人说了「别开」：启动时跳过、watchdog 既不杀也不拉（否则门禁/手动停模型后
// 2 分钟内就被自动拉回来抢显存）。
const LOCAL_LLM_PAUSE = process.env.PET_LOCAL_LLM_PAUSE_FILE || join(logDir, 'local-llm.pause');
const localLlmPaused = () => existsSync(LOCAL_LLM_PAUSE);

async function startLocalMemory() {
  if (localLlmPaused()) {
    console.log('[launcher] 本地记忆模型：手动暂停中（local-llm.pause），跳过');
    return;
  }
  const svc = MANIFEST.services.find((x) => x.id === LOCAL_LLM_ID);
  if (!svc) return;                       // 没登记 = 不启用（保持旧行为）
  if (svc.enabled === false) {
    console.log('[launcher] 本地记忆模型：services.json enabled=false，跳过（需要时跑 -Daily）');
    return;
  }
  if (await portUp(LOCAL_LLM_PORT)) { console.log('[launcher] 本地记忆模型已在运行，跳过'); return; }
  if (!existsSync(LOCAL_LLM_SCRIPT)) { console.log('[launcher] 本地记忆模型启动脚本缺失，跳过'); return; }
  // 2026-11-25 用户拍板「随宿主启停」：不再经 pwsh 脚本 Start-Process（那样 llama-server
  // 会成为 pwsh 的孤儿子进程，launcher 死了它还活着占显存）。改问脚本要最终参数（-PrintArgs，
  // 输出一行 JSON，含显存守门 skip 判定），然后**launcher 直接 spawn llama-server**——
  // 它成为 launcher 的直接子进程，exit 处理器/killTree/taskkill /T 都能带走它。
  let spec = null;
  try {
    const mode = (svc.start && Array.isArray(svc.start.args) && svc.start.args.includes('-Batch')) ? '-Batch'
      : (svc.start && svc.start.args && svc.start.args.includes('-Long')) ? '-Long' : '-Daily';
    const out = execSync('pwsh -NoProfile -File "' + LOCAL_LLM_SCRIPT + '" ' + mode + ' -PrintArgs',
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const line = out.split('\n').map((s) => s.trim()).find((s) => s.startsWith('{'));
    if (!line) throw new Error('PrintArgs 没输出 JSON：' + out.slice(0, 200));
    spec = JSON.parse(line);
  } catch (e) {
    console.log('[launcher] 本地记忆模型参数获取失败（不启动，不影响宿主）：' + (e && e.message || e).slice(0, 160));
    return;
  }
  if (!spec || spec.skip) {
    console.log('[launcher] 本地记忆模型：显存守门跳过（' + ((spec && spec.reason) || '未知') + '）；后台任务会按 local_down 跳过，不烧云');
    return;
  }
  localLlmChild = trackPid(spawn(spec.exe, spec.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  localLlmChild.stdout.on('data', (d) => appendLog('[local-llm] ', d));
  localLlmChild.stderr.on('data', (d) => appendLog('[local-llm] ', d));
  localLlmChild.on('exit', (code) => {
    // 非正常退出才重试（exit 0 = 显存守门/有意退出不重试；停机中 stop=true 也不重试）。
    // 连续 3 次起不来（比如显存真不够 OOM）就放弃，避免 30s 一轮的空转刷日志。
    if (!stop && code !== 0) {
      localLlmAttempts += 1;
      if (localLlmAttempts > 3) {
        console.log('[launcher] 本地记忆模型连续 3 次退出(code=' + code + ')，放弃自动重启（下次 launcher 启动再试）');
        return;
      }
      console.log('[launcher] 本地记忆模型退出(code=' + code + ') —— 不影响宿主；30 秒后重试');
      setTimeout(startLocalMemory, 30000);
    }
  });
  console.log('[launcher] 本地记忆模型已启动 (' + LOCAL_LLM_PORT + ')，后台等就绪…');
  // 不阻塞宿主启动：90s 预热期（首次加载 2.4GB 模型 + CUDA）
  (async () => {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const r = await fetch(LOCAL_LLM_HEALTH, { signal: AbortSignal.timeout(3000) });
        if (r.ok) { console.log('[launcher] 本地记忆模型就绪 (' + LOCAL_LLM_PORT + ')'); return; }
      } catch (_) { /* 预热中 */ }
    }
    console.log('[launcher] ⚠ 本地记忆模型 90s 未就绪（后台任务会按 local_down 跳过，不烧云）');
  })().catch(() => {});
}

// ── 本地记忆模型：显存压力自动停 / 空闲自动重启（2026-11-25 用户拍板）────────
// 用户场景：桌宠还开着，但正在打游戏/渲染 —— 模型占着 ~4.9GB 会把它挤进共享内存。
// 判据不用「猜哪个是游戏」，只看**实际剩余显存**：
//   · 模型活着 & free < autoStopFreeMiB（默认 600）连续 3 分钟 → 杀掉模型腾显存；
//   · 模型不在 & 已过冷却（默认 10 分钟）& free ≥ restartFreeMiB（默认 5000）连续 2 分钟 → 自动拉起。
// 这些阈值可在 services.json 的条目里覆盖（autoStopFreeMiB/restartFreeMiB/idleRestartMs）。
const LOCAL_LLM_MON = { lowStreak: 0, highStreak: 0, suppressUntil: 0, lastFree: -1 };

function gpuFreeMiB() {
  try {
    const out = execSync('nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits',
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const n = parseInt(String(out).trim().split(/\r?\n/)[0], 10);
    return Number.isFinite(n) ? n : -1;
  } catch (_) { return -1; }
}

function startLocalMemoryWatchdog() {
  const svc = MANIFEST.services.find((x) => x.id === LOCAL_LLM_ID);
  if (!svc || svc.enabled === false) return;
  const low = Number(svc.autoStopFreeMiB) || 600;
  const high = Number(svc.restartFreeMiB) || 5000;
  const coolMs = Number(svc.idleRestartMs) || 10 * 60 * 1000;
  setInterval(() => {
    if (stop) return;
    // 手动暂停中（local-llm.pause 存在）：既不杀也不拉——显存压力再大也不动，
    // 拉起更不允许。门禁/用户 -Stop 之后模型必须保持停着。
    if (localLlmPaused()) return;
    const free = gpuFreeMiB();
    if (free < 0) return;
    LOCAL_LLM_MON.lastFree = free;
    const alive = localLlmChild && localLlmChild.exitCode === null;
    if (alive) {
      LOCAL_LLM_MON.highStreak = 0;
      if (free < low) {
        LOCAL_LLM_MON.lowStreak += 1;
        if (LOCAL_LLM_MON.lowStreak >= 3) {
          console.log('[launcher] 显存压力（free=' + free + 'MiB < ' + low + ' 连续 3 次）→ 暂停本地记忆模型，腾显存');
          try { localLlmChild.kill(); } catch (_) { /* 杀不掉交给系统回收 */ }
          LOCAL_LLM_MON.lowStreak = 0;
          LOCAL_LLM_MON.suppressUntil = Date.now() + coolMs;
        }
      } else {
        LOCAL_LLM_MON.lowStreak = 0;
      }
      return;
    }
    LOCAL_LLM_MON.lowStreak = 0;
    if (Date.now() < LOCAL_LLM_MON.suppressUntil) return;   // 冷却期内不重启
    if (free >= high) {
      LOCAL_LLM_MON.highStreak += 1;
      if (LOCAL_LLM_MON.highStreak >= 2) {
        LOCAL_LLM_MON.highStreak = 0;
        console.log('[launcher] 显存空闲（free=' + free + 'MiB ≥ ' + high + '）→ 重新拉起本地记忆模型');
        startLocalMemory();
      }
    } else {
      LOCAL_LLM_MON.highStreak = 0;
    }
  }, 60 * 1000).unref?.();
}

// ⚡ MemOS 挂起自愈（拍板：自动重启）。挂起=进程活着但不应答，exit-restart 抓不住——
// 每 30s 探一次 /health（10s 超时，容忍嵌入时的重负载）；**连续 3 次失败**（约 90s 无应答）
// 才杀掉——exit 处理器会 5 秒后自动 startMemos。刚启动给 90s 预热期不探。
function startMemosWatchdog() {
  setInterval(async () => {
    if (stop || !memosChild || memosChild.exitCode !== null) return;
    if (Date.now() - memosStartedAt < 90000) return;   // 预热期（首次加载模型可能十几秒）
    try {
      const r = await fetch(MEMOS_HEALTH, { signal: AbortSignal.timeout(10000) });
      if (r.ok) { memosHealthFails = 0; return; }
      throw new Error('status ' + r.status);
    } catch (e) {
      memosHealthFails += 1;
      console.log('[launcher] MemOS 健康检查失败 x' + memosHealthFails + '（' + (e && e.message || e) + '）');
      if (memosHealthFails >= 3) {
        memosHealthFails = 0;
        memosStartedAt = Date.now();   // 重启后重新预热
        console.log('[launcher] ⚡ MemOS 疑似挂起（连续 3 次无应答），自动重启（拍板项）');
        try { memosChild.kill(); } catch (_) {}
      }
    }
  }, 30000).unref?.();
}

// ⚡ 渲染层 watchdog（今天两次热重载卡死的根治，工程债 E 档）：
// 8103/health 活（主进程好）但 8004/eval 挂（渲染层僵）= 卡死特征。
// **PET_DEVTOOLS=0 时 8004/eval 天生不可用**，不能再当卡死（旧实现会每 ~2.5 分钟杀一次宿主）。
// 连续 3 次 eval 挂 → 杀 electron 子进程，exit 处理器自动重启；重启间隔走时间窗退避。
let rendererStall = 0;
function startRendererWatchdog() {
  if (process.env.PET_DEVTOOLS === '0') {
    console.log('[launcher] PET_DEVTOOLS=0：跳过渲染层自检（8004/eval 不可用，不算卡死）');
    return;
  }
  let delay = 45000;
  const tick = async () => {
    try {
      if (stop || !currentChild || currentChild.exitCode !== null) return;
      try {
        await fetch('http://127.0.0.1:' + CONTROL_PORT + '/health', { signal: AbortSignal.timeout(4000) });
      } catch (e) { return; }                      // 主进程没了 → 交给 exit 重启
      try {
        const res = await fetch('http://127.0.0.1:8004/eval', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ js: '1+1' }),
          signal: AbortSignal.timeout(5000),
        });
        const j = await res.json();
        if (j && j.value !== undefined) {
          rendererStall = 0;
          rendererPolicy.ok();
          delay = 45000;                            // 恢复：回到正常节奏
          return;
        }
        throw new Error('eval 无值');
      } catch (e) {
        rendererStall += 1;
        console.log('[launcher] 渲染层自检失败 x' + rendererStall + '（' + (e && e.message || e) + '）');
        if (rendererStall >= 3) {
          rendererStall = 0;
          const verdict = rendererPolicy.fail();
          delay = verdict.backoff ? verdict.delayMs : 45000;
          console.log('[launcher] ⚡ 渲染层僵死（连续 3 次 eval 挂），自动重启' +
            (verdict.backoff ? '；窗口内 ' + verdict.fails + ' 次，自检间隔退避 ' + Math.round(delay / 1000) + 's' : ''));
          try { currentChild.kill(); } catch (_) {}
        }
      }
    } finally {
      if (!stop) setTimeout(tick, delay).unref?.();
    }
  };
  setTimeout(tick, 45000).unref?.();
}

// ⚡ Ollama（意图路由的本地小模型底座，拍板：本地 0.5-3B）。在跑就不动；没跑就拉起。
// 意图路由挂了会自动退避回落全量工具（能力不折损），所以这里只保证"尽量在"。
const OLLAMA_EXE = join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
let ollamaChild = null;
function startOllama() {
  if (!existsSync(OLLAMA_EXE)) { console.log('[launcher] 没找到 Ollama（意图路由将走退避回落）'); return; }
  fetch('http://127.0.0.1:11434/', { signal: AbortSignal.timeout(2000) })
    .then(() => console.log('[launcher] Ollama 已在跑（11434）'))
    .catch(() => {
      ollamaChild = spawn(OLLAMA_EXE, ['serve'], { windowsHide: true, detached: true, stdio: 'ignore' });
      ollamaChild.unref();
      console.log('[launcher] Ollama 已拉起（11434，意图路由底座）');
    });
}

const ttsGate = createTtsGate({
  log: (line) => logBoth('[tts] ', line),
  spawnChild: () => {
    const ttsArgs = [ttsScript, '--port', String(TTS_PORT)];
    // 换声线不用改代码：set PET_TTS_VOICE=zh-CN-XiaoxiaoNeural
    if (process.env.PET_TTS_VOICE) ttsArgs.push('--voice', process.env.PET_TTS_VOICE);
    const c = spawn(PY_BIN, ttsArgs, { cwd: dirname(ttsScript), windowsHide: true });
    ttsChild = c;
    trackPid(c);
    c.once('exit', () => { if (ttsChild === c) ttsChild = null; });
    return c;
  },
  probe: ttsAlive,
  startTimeoutMs: startTimeoutOf('tts', 60000),
  retryDelayMs: 2000,
  isStopped: () => stop,
  // 重试前先判端口：如果 9883 已被（外部/孤儿）实例占着，再 spawn 只会每 2 秒崩一次。
  onRetry: () => { void startTts(); },
});
async function startTts() {
  if (!existsSync(ttsScript)) { console.log('[launcher] 未找到 edge-tts 服务，跳过'); return; }
  if (await portUp(TTS_PORT)) {
    logBoth('[tts] ', '[launcher] edge-tts 已在运行 (' + TTS_PORT + ')，跳过重复拉起');
    return;
  }
  ttsGate.start();
}

// 本地语音识别（SenseVoice）：给桌宠耳朵，PTT 按住 V 说话。
const asrScript = resolve(here, '..', '..', 'asr', 'asr_server.py');
let asrChild = null;
async function startAsr() {
  if (!existsSync(asrScript)) { console.log('[launcher] 未找到 asr_server.py，跳过语音输入'); return; }
  if (await portUp(ASR_PORT)) { console.log('[launcher] SenseVoice ASR 已在运行 (' + ASR_PORT + ')，跳过重复拉起'); return; }
  asrChild = trackPid(spawn(PY_BIN, [asrScript, '--port', String(ASR_PORT)], { cwd: dirname(asrScript), windowsHide: true }));
  asrChild.stdout.on('data', (d) => { appendLog('[asr] ', d) });
  asrChild.stderr.on('data', (d) => { appendLog('[asr] ', d) });
  asrChild.on('exit', () => { if (!stop) setTimeout(() => { void startAsr(); }, 3000); });
  console.log('[launcher] SenseVoice ASR 已启动 (' + ASR_PORT + ')');
}

// 「一起看」的耳朵：WASAPI 回环录系统声音 → VAD 切句 → SenseVoice 识别。
// 没有它，桌宠就听不见剧里的对白，只能靠画面猜。
const loopScript = resolve(here, '..', '..', 'audio-loop', 'audio_loop_server.py');
let loopChild = null;
async function startAudioLoop() {
  if (!existsSync(loopScript)) { console.log('[launcher] 未找到 audio_loop_server.py，跳过「一起看」'); return; }
  if (await portUp(COWATCH_PORT)) { console.log('[launcher] 「一起看」已在运行 (' + COWATCH_PORT + ')，跳过重复拉起'); return; }
  loopChild = trackPid(spawn(PY_BIN, [loopScript, '--port', String(COWATCH_PORT)], { cwd: dirname(loopScript), windowsHide: true }));
  loopChild.stdout.on('data', (d) => { appendLog('[loop] ', d) });
  loopChild.stderr.on('data', (d) => { appendLog('[loop] ', d) });
  loopChild.on('exit', (code) => { if (!stop) { console.log('[launcher] 「一起看」退出(code=' + code + ')，3 秒后重启'); setTimeout(() => { void startAudioLoop(); }, 3000); } });
  console.log('[launcher] 「一起看」耳朵已启动 (' + COWATCH_PORT + ')');
}

// 声纹嵌入（resemblyzer 256 维）：隔离 venv 运行，绝不装进系统 Python（numpy 2.3.5 保护）。
const vpScript = resolve(here, '..', '..', 'audio_common', 'voiceprint_server.py');
const vpPython = resolve(here, '..', 'venv-voice', 'Scripts', 'python.exe');
let vpChild = null;
async function startVoiceprint() {
  if (!existsSync(vpPython) || !existsSync(vpScript)) { console.log('[launcher] 未找到 venv-voice/voiceprint_server.py，跳过声纹服务'); return; }
  const vpPort = portOf('voiceprint', 8020);
  if (await portUp(vpPort)) { console.log('[launcher] 声纹服务已在运行 (' + vpPort + ')，跳过重复拉起'); return; }
  vpChild = trackPid(spawn(vpPython, [vpScript], { cwd: dirname(vpScript), windowsHide: true }));
  vpChild.stdout.on('data', (d) => { appendLog('[voiceprint] ', d); });
  vpChild.stderr.on('data', (d) => { appendLog('[voiceprint] ', d); });
  vpChild.on('exit', (code) => { if (!stop) { console.log('[launcher] 声纹服务退出(code=' + code + ')，5 秒后重启'); setTimeout(() => { void startVoiceprint(); }, 5000); } });
  console.log('[launcher] 声纹嵌入服务已启动 (' + vpPort + ')');
}

// LumenAct 语义选择器（8120）：27 类情绪外观 + 14 类语音风格，单次 7–9ms。
// **必须常驻**：冷启动要加载 146MB ONNX（实测 11.4s），按需起会卡死当轮对话。
// 资产在 _research/lumenact（gitignored）→ 缺资产就跳过并说清楚，不静默降级。
const semScript = resolve(here, 'lumen-semantic-server.py');
const semModels = resolve(here, '..', '..', '_research', 'lumenact', 'models', 'selector.onnx');
let semChild = null;
async function startSemantic() {
  if (!existsSync(semScript)) { console.log('[launcher] 未找到 lumen-semantic-server.py，跳过语义服务'); return; }
  if (!existsSync(semModels)) { console.log('[launcher] 缺 _research/lumenact/models/selector.onnx，跳过语义服务（见交接 §63 下载命令）'); return; }
  if (await portUp(SEMANTIC_PORT)) { console.log('[launcher] 语义服务已在运行 (' + SEMANTIC_PORT + ')，跳过重复拉起'); return; }
  semChild = trackPid(spawn(PY_BIN, [semScript, '--port', String(SEMANTIC_PORT)], { cwd: dirname(semScript), windowsHide: true }));
  semChild.stdout.on('data', (d) => { appendLog('[semantic] ', d) });
  semChild.stderr.on('data', (d) => { appendLog('[semantic] ', d) });
  semChild.on('exit', (code) => { if (!stop) { console.log('[launcher] 语义服务退出(code=' + code + ')，5 秒后重启'); setTimeout(() => { void startSemantic(); }, 5000); } });
  console.log('[launcher] LumenAct 语义服务已启动 (' + SEMANTIC_PORT + '，首个请求前约 11s 加载模型)');
}

// ── 通知采集（Phase 3 缺口 1）────────────────────────────────────────────
// 每 10 分钟在包身份里读最近 50 条通知 → data/notifications.jsonl（world-sense 读它）。
// 不新增端口、不建计划任务：只是 launcher 内部定时 spawn 一次 PowerShell（脚本自己进包）。
// 采集脚本未授权时只返回 not-allowed，**不会弹系统对话框**（后台进程不能骚扰用户）。
const NOTIFY_COLLECT_INTERVAL_MS = 10 * 60 * 1000;
let notifyChild = null;
function startNotificationCollector() {
  const script = join(here, 'notification-probe.ps1');
  if (!existsSync(script)) {
    console.log('[launcher] 没找到 notification-probe.ps1，跳过通知采集');
    return;
  }
  const psPath = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const psExe = existsSync(psPath) ? psPath : 'powershell.exe';
  const run = () => {
    if (stop || notifyChild) return;   // 上一轮还没回来就跳过，绝不叠加
    let child;
    try {
      child = spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Collect', '-Json'],
        { windowsHide: true });
    } catch (e) {
      appendLog('[notify] 启动采集失败：' + ((e && e.message) || e) + String.fromCharCode(10));
      return;
    }
    notifyChild = child;
    trackPid(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const killTimer = setTimeout(() => { try { child.kill(); } catch (e) { /* 已退出 */ } }, 180000);
    if (killTimer.unref) killTimer.unref();
    child.on('error', (e) => {
      clearTimeout(killTimer);
      if (notifyChild === child) notifyChild = null;
      appendLog('[notify] 采集进程错误：' + ((e && e.message) || e) + String.fromCharCode(10));
    });
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      if (notifyChild === child) notifyChild = null;
      const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop() || '';
      let j = null;
      try { j = JSON.parse(line); } catch (e) { j = null; }
      if (j && j.ok) {
        appendLog('[notify] 采集 +' + (j.added || 0) + ' 条（去重 ' + (j.duplicates || 0)
          + '，坏行 ' + (j.invalid || 0) + '，总数 ' + (j.total || 0)
          + (j.includeTitle ? '，含标题' : '，不含标题') + '）' + String.fromCharCode(10));
      } else if (j && !j.ok) {
        appendLog('[notify] 未采集（' + (j.reason || 'unknown') + '）' + String.fromCharCode(10));
      } else if (code !== 0) {
        appendLog('[notify] 采集退出 code=' + code + (err ? '：' + String(err).slice(0, 200) : '') + String.fromCharCode(10));
      }
    });
  };
  // 启动后 60s 跑第一次（别和宿主启动抢 IO），之后每 10 分钟一次。
  setTimeout(() => {
    run();
    setInterval(run, NOTIFY_COLLECT_INTERVAL_MS).unref?.();
  }, 60000).unref?.();
  console.log('[launcher] 通知采集已排程（每 10 分钟，脚本自进包）');
}

// ── 启动 ─────────────────────────────────────────────────────────────────
export async function boot() {
  if (!existsSync(electron)) { console.error('找不到 electron：', electron); process.exit(1); }
  mkdirSync(logDir, { recursive: true });

  // ① 单实例锁：第二个 launcher 直接退出（缺陷 3）。锁里带 pid + 启动时间 + 子进程清单。
  //    pid 活着还要核对「它真是本 launcher」（镜像+启动时间），否则 pid 复用会永久挡住启动。
  const got = acquireInstanceLock(LOCK_PATH, { isHolder: isRealLauncherHolder });
  if (!got.ok) {
    const h = got.holder || {};
    if (got.reason === 'held') {
      console.log('[launcher] 已有实例 pid=' + h.pid + (h.startedAtISO ? '（启动于 ' + h.startedAtISO + '）' : '') + '，本实例退出');
      process.exit(0);
    }
    console.error('[launcher] 锁文件不可写（' + (got.error || got.reason) + '），为避免双实例失控，退出');
    process.exit(1);
  }
  if (got.previous && Number(got.previous.pid) !== Number(process.pid)) {
    console.log('[launcher] 锁里是陈旧实例 pid=' + got.previous.pid + '（不是活着的本 launcher），已接管');
  }
  lockHeld = true;
  spawnedPids.add(process.pid);
  persistPids();

  // ② 只清理上一次「自己」留下的子进程（不再按端口杀别人的监听者）
  killStaleFromLock(got.previous);

  process.on('exit', () => {
    for (const child of [currentChild, memosChild, ttsChild, asrChild, loopChild, vpChild, semChild, ollamaChild, notifyChild]) killTree(child);
    if (lockHeld) releaseInstanceLock(LOCK_PATH, process.pid);
  });

  console.log('[launcher] app =', appDir);

  // 启动前先把手弄干净：注入密钥 → 体检端点 → 选一个真能用的模型
  runCredSync();
  await ensureUsableProvider();
  // 每个服务启动前都先判端口：已有实例（外部启动/孤儿）就跳过，
  // 否则会 spawn 一个必然 bind 失败的进程并无限重试（2026-11-22 实测 churn）。
  await startTts();
  await startAsr();
  await startAudioLoop();
  await startVoiceprint();
  await startSemantic();
  await startMemos();
  await startLocalMemory();
  startOllama();
  startMemosWatchdog();
  startLocalMemoryWatchdog();
  startRendererWatchdog();
  startNotificationCollector();
  launch();
}

// 2026-11-10 四十轮（抄 rust_core_prototype/main.rs 的 Job Object KILL_ON_JOB_CLOSE 意图）：
//   启动器退出时把**整棵进程树**带走，防止 electron / MemOS / 耳朵 / 声纹留下孤儿。
//   Node 没有 Job Object 绑定，用 taskkill /T /F 做等价物（同步，exit 事件里能跑完）。
function killTree(child) {
  if (!child || !child.pid) return;
  try { execSync('taskkill /PID ' + child.pid + '/T /F', { stdio: 'ignore', windowsHide: true }); } catch (e) { /* 已经没了 */ }
}

if (IS_MAIN) {
  await boot();
}
