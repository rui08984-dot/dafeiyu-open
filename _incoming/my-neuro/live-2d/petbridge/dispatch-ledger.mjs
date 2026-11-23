/**
 * dispatch-ledger.mjs — 派活账本（P0 可见+安全，2026-11-23）
 *
 * 设计依据：docs/设计-派活v2-2026-11-23.md §3.1/§3.3/§3.4/§4.2/§4.7。
 *
 * 事实源（两份，职责不同）：
 *   · `data/dispatch-tasks/<taskId>.json` —— 每任务一份完整记录（tmp+rename 原子写），
 *     详情/幂等/恢复都读它；文件损坏只影响那一条，不拖垮整个列表。
 *   · `data/dispatch-tasks.jsonl`  —— 只追加的事件流（create/attempt/settle/recover/trim），
 *     控制中心「后台任务」区块直读它做增量列表；**只写 preview，不写任务正文/结果正文**。
 *
 * 内存只是缓存：
 *   · 最近 100 条（环形，未终态永不淘汰）；
 *   · requestId → taskId 索引（24h 内唯一；过期即失效）。
 *
 * 启动恢复（recover）：上次进程留下的 running/cancelling 一律改 unknown + stateReason=restart。
 * 系统**永不自动重派**：attempted=true 的记录只能由显式 reconcile（P2）推进。
 *
 * 本模块纯 Node（无 Electron/网络依赖），测试见 _probe/test-dispatch-ledger.cjs。
 */
import fs from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// petbridge/dispatch-ledger.mjs → 上两层 = my-neuro/（只在没有 configPath 的独立运行时兜底）
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// ── 公开常量（测试与调用方共用同一份口径）────────────────────────────────
export const LEDGER_TASKS_DIR = 'dispatch-tasks';
export const LEDGER_JSONL = 'dispatch-tasks.jsonl';
export const TERMINAL_LIMIT = 200;          // 只裁「终态」；未终态全留
export const RING_MAX = 100;                // 内存环形上限
export const REQUEST_ID_TTL_MS = 24 * 60 * 60 * 1000;
export const TASK_TEXT_MAX = 20000;
export const TASK_PREVIEW_MAX = 120;
export const RESULT_TEXT_MAX = 4000;
export const ERROR_MAX = 600;
export const TOOLS_MAX = 50;

export const TERMINAL_STATES = Object.freeze(['done', 'failed', 'cancelled']);
export const LIVE_STATES = Object.freeze(['running', 'cancelling', 'unknown']);
const ALL_STATES = new Set([...TERMINAL_STATES, ...LIVE_STATES]);

export function isTerminalState(state) {
  return TERMINAL_STATES.includes(String(state || ''));
}

/** 任务 id 只允许「文件名安全」字符；非法/缺失由 normalizeTaskId 生成。 */
export function normalizeTaskId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s)) return s;
  return 'task-' + Date.now().toString(36) + '-' + randomBytes(4).toString('hex');
}

/** 120 字预览：折叠空白 + 按码点截断（emoji 不被劈成半个代理对）。 */
export function makeTaskPreview(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, TASK_PREVIEW_MAX).join('');
}

function clipText(value, max) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * 记录室目录推导（与 vts-server 的情绪状态/令牌同一套口径）：
 *   roomDir 显式 > PET_DATA_ROOT/data > config.json 的 ../data。
 */
export function dispatchRoomDir(configPath, { roomDir = null, dataRoot = null } = {}) {
  if (roomDir) return isAbsolute(roomDir) ? roomDir : resolve(roomDir);
  if (dataRoot) return join(resolve(dataRoot), 'data');
  if (process.env.PET_DATA_ROOT) return join(resolve(process.env.PET_DATA_ROOT), 'data');
  if (configPath) return join(dirname(configPath), '..', 'data');
  return join(MODULE_DIR, '..', '..', 'data');
}

/**
 * 回滚开关 `config.dispatch.ledger_v2`：缺省 true。
 * 只有显式 false 才回旧内存 Map 行为（设计 §5 回滚列）。
 */
export function readLedgerV2Enabled(configPath) {
  if (!configPath) return true;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const d = cfg && cfg.dispatch;
    if (d && typeof d === 'object' && !Array.isArray(d) && d.ledger_v2 === false) return false;
  } catch (e) { /* 配置读不到按缺省开（账本只增可见性，不改变派活成败） */ }
  return true;
}

function safeTools(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => String(x == null ? '' : (typeof x === 'string' ? x : (x.name || x.tool || ''))).trim())
    .filter(Boolean)
    .slice(0, TOOLS_MAX)
    .map((x) => clipText(x, 80));
}

// ── P1 结构化字段（形状见设计 §3.4；只收白名单字段，防止任意大对象落盘）──────
function safePathList(list, maxItems = 300) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => clipText(String(x == null ? '' : x), 300))
    .filter(Boolean)
    .slice(0, maxItems);
}

function safeVerify(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const verdict = ['pass', 'fail', 'broken', 'timeout', 'none'].includes(String(v.verdict))
    ? String(v.verdict) : 'none';
  const rounds = Array.isArray(v.rounds)
    ? v.rounds.slice(0, 5).map((r, i) => ({
      round: Number.isFinite(Number(r && r.round)) ? Number(r.round) : i,
      verdict: ['pass', 'fail', 'broken', 'timeout', 'none'].includes(String(r && r.verdict)) ? String(r.verdict) : 'none',
      exitCode: Number.isFinite(Number(r && r.exitCode)) ? Number(r.exitCode) : null,
      output: clipText(String((r && r.output) || ''), 600),
      ranAt: Number.isFinite(Number(r && r.ranAt)) ? Number(r.ranAt) : null,
      tookMs: Number.isFinite(Number(r && r.tookMs)) ? Number(r.tookMs) : null,
      why: clipText(String((r && r.why) || ''), 200),
    }))
    : [];
  return {
    command: clipText(String(v.command || ''), 2000),
    verdict,
    exitCode: Number.isFinite(Number(v.exitCode)) ? Number(v.exitCode) : null,
    output: clipText(String(v.output || ''), 1500),
    ranAt: Number.isFinite(Number(v.ranAt)) ? Number(v.ranAt) : null,
    tookMs: Number.isFinite(Number(v.tookMs)) ? Number(v.tookMs) : null,
    why: clipText(String(v.why || ''), 200),
    rounds,
  };
}

function safeEvidence(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  return {
    created: safePathList(e.created),
    modified: safePathList(e.modified),
    // 2026-11-23 partialWrites 时间窗：modified 是全量（验收/返工证据照旧可用），
    // modifiedSinceTask 只收 mtime ≥ 任务开始（-2s 容差）的改动，取消回执用它，
    // 避免 defaultWorkspace=pet 时把任务开始前的无关改动算成「这次写下的文件」。
    modifiedSinceTask: safePathList(e.modifiedSinceTask),
    deleted: safePathList(e.deleted),
    // 快照只走 root（越界路径不可能进 diff）；字段保留给 P2 git status/外部证据用。
    scopeViolations: safePathList(e.scopeViolations),
    gitStatus: e.gitStatus == null ? null : clipText(String(e.gitStatus), 500),
    changed: e.changed === true,
    fileCount: Math.max(0, Math.round(Number(e.fileCount) || 0)),
    bytes: Math.max(0, Math.round(Number(e.bytes) || 0)),
    truncated: e.truncated === true,
    settleMs: e.settleMs == null ? null : Math.max(0, Math.round(Number(e.settleMs) || 0)),
    settleTimedOut: e.settleTimedOut === true,
    unavailableReason: e.unavailableReason == null ? null : clipText(String(e.unavailableReason), 200),
  };
}

function baseRow(input) {
  const now = Number.isFinite(Number(input && input.now)) ? Number(input.now) : Date.now();
  const taskText = clipText(String((input && input.taskText) || ''), TASK_TEXT_MAX);
  return {
    version: 1,
    // 身份 / 幂等
    taskId: normalizeTaskId(input && input.taskId),
    requestId: input && input.requestId ? clipText(String(input.requestId), 120) : null,
    parentId: input && input.parentId ? clipText(String(input.parentId), 80) : null,
    origin: input && input.origin ? String(input.origin).slice(0, 20) : 'http',
    attemptCount: 0,
    attempted: false,
    attemptedAt: null,
    // 执行
    state: 'running',
    outcome: null,
    stateReason: null,
    backend: 'dsh',
    sessionId: null,
    sessionReused: false,
    sessionMismatch: false,
    childPid: null,
    childStartedAt: null,
    // 输入
    taskText,
    taskPreview: makeTaskPreview(taskText),
    workspaceAlias: input && input.workspaceAlias ? clipText(String(input.workspaceAlias), 60) : null,
    workspaceRoot: input && input.workspaceRoot ? clipText(String(input.workspaceRoot), 500) : null,
    workspaceRealpath: input && input.workspaceRealpath ? clipText(String(input.workspaceRealpath), 500) : null,
    verifyCommand: input && input.verifyCommand ? clipText(String(input.verifyCommand), 2000) : null,
    reworkMax: input && Number.isFinite(Number(input.reworkMax)) ? Math.max(0, Math.min(3, Number(input.reworkMax))) : null,
    // 时间 / 成本
    createdAt: now,
    startedAt: null,
    endedAt: null,
    tookMs: null,
    settleMs: null,
    // 结果
    tools: [],
    text: '',
    error: '',
    verifyTier: 'none',
    // P1 占位（P0 不实现，形状先固定，避免以后改模型）
    verify: null,
    evidence: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    partialWrites: [],
  };
}

/**
 * 创建账本实例。
 * @param {object} opts
 * @param {string} [opts.configPath]  config.json（推导记录室；也可直接给 roomDir）
 * @param {string} [opts.roomDir]     data目录（测试显式指定）
 * @param {string} [opts.dataRoot]    数据根（其下 data）
 * @param {number} [opts.terminalLimit=200]
 * @param {number} [opts.ringMax=100]
 * @param {number} [opts.requestTtlMs=24h]
 * @param {() => number} [opts.now]
 * @param {(line: string) => void} [opts.log]
 */
export function createDispatchLedger({
  configPath = null,
  roomDir = null,
  dataRoot = null,
  terminalLimit = TERMINAL_LIMIT,
  ringMax = RING_MAX,
  requestTtlMs = REQUEST_ID_TTL_MS,
  now = () => Date.now(),
  log = null,
} = {}) {
  const room = dispatchRoomDir(configPath, { roomDir, dataRoot });
  const tasksDir = join(room, LEDGER_TASKS_DIR);
  const jsonlPath = join(room, LEDGER_JSONL);
  const cache = new Map();              // taskId -> row（插入序 = 最近活跃序）
  const requestIndex = new Map();       // requestId -> { taskId, createdAt }
  let terminalCount = 0;
  let loaded = false;

  const say = (line) => { try { if (typeof log === 'function') log('[dispatch-ledger] ' + line); } catch (e) { /* 日志失败不影响账本 */ } };

  function ensureDirs() {
    fs.mkdirSync(tasksDir, { recursive: true });
  }

  function taskFile(taskId) {
    return join(tasksDir, normalizeTaskId(taskId) + '.json');
  }

  function putCache(row) {
    cache.delete(row.taskId);
    cache.set(row.taskId, row);
    // 环形上限：只淘汰最旧的「终态」；running/unknown 永不淘汰（否则会丢未结案证据）
    while (cache.size > ringMax) {
      let victim = null;
      for (const [id, r] of cache) {
        if (isTerminalState(r.state)) { victim = id; break; }
      }
      if (!victim) break;
      cache.delete(victim);
    }
  }

  function writeJson(row, { strict = true } = {}) {
    try {
      ensureDirs();
      const file = taskFile(row.taskId);
      const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(3).toString('hex');
      fs.writeFileSync(tmp, JSON.stringify(row, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows 无 POSIX 权限语义 */ }
      return true;
    } catch (e) {
      say('写 JSON 失败 ' + row.taskId + ': ' + String((e && e.message) || e));
      if (strict) throw e;
      return false;
    }
  }

  /** JSONL 只写事件摘要：preview + 状态 + 耗时，绝不写正文/结果。 */
  function appendEvent(type, row, extra = {}) {
    try {
      ensureDirs();
      const ev = {
        ts: now(),
        type: String(type || 'update'),
        taskId: row.taskId,
        state: row.state,
        outcome: row.outcome,
        stateReason: row.stateReason,
        taskPreview: row.taskPreview,
        createdAt: row.createdAt,
        requestId: row.requestId,
        origin: row.origin,
        attempted: row.attempted,
        attemptCount: row.attemptCount,
        tookMs: row.tookMs,
        version: row.version,
        ...extra,
      };
      fs.appendFileSync(jsonlPath, JSON.stringify(ev) + '\n', 'utf8');
      return true;
    } catch (e) {
      say('写 JSONL 失败: ' + String((e && e.message) || e));
      return false;
    }
  }

  function parseRowFile(file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || !raw.taskId) return null;
      if (!ALL_STATES.has(String(raw.state))) raw.state = 'unknown';
      return raw;
    } catch (e) {
      // 单条损坏只影响这一条：列表/详情读不到它，其它记录照常。
      say('跳过坏记录文件 ' + file + ': ' + String((e && e.message) || e));
      return null;
    }
  }

  /** 读全部 JSON（恢复/统计用）；顺带重建 requestId 索引与终态计数。 */
  function loadAll({ reset = true } = {}) {
    if (reset) {
      cache.clear();
      requestIndex.clear();
      terminalCount = 0;
    }
    let files = [];
    try { files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json')); } catch (e) { return []; }
    const rows = [];
    for (const f of files) {
      const row = parseRowFile(join(tasksDir, f));
      if (!row) continue;
      rows.push(row);
      putCache(row);
      rememberRequest(row);
    }
    // 计数永远从文件重算，避免多次 load/evict 后重复累加
    terminalCount = rows.filter((r) => isTerminalState(r.state)).length;
    loaded = true;
    return rows;
  }

  function ensureLoaded() {
    if (!loaded) loadAll();
  }

  function rememberRequest(row) {
    if (!row || !row.requestId) return;
    const created = Number(row.createdAt) || 0;
    if (created && now() - created > requestTtlMs) return;
    requestIndex.set(String(row.requestId), { taskId: row.taskId, createdAt: created });
  }

  function get(taskId) {
    const id = normalizeTaskId(taskId);
    if (cache.has(id)) return cache.get(id);
    let row = null;
    try { row = parseRowFile(taskFile(id)); } catch (e) { row = null; }
    if (!row) return null;
    putCache(row);
    if (isTerminalState(row.state)) { /* 计数由 loadAll 负责；这里只补缓存 */ }
    rememberRequest(row);
    return row;
  }

  function create(input = {}) {
    const row = baseRow(Object.assign({}, input, { now: now() }));
    const existing = get(row.taskId);
    if (existing) return existing;   // 幂等：同 taskId 不覆盖既有记录
    if (!writeJson(row, { strict: true })) throw new Error('ledger_write_failed');
    putCache(row);
    rememberRequest(row);
    appendEvent('create', row);
    return row;
  }

  function update(taskId, patch = {}, { strict = false } = {}) {
    const row = get(taskId);
    if (!row) return null;
    const p = patch && typeof patch === 'object' ? patch : {};
    if (p.state != null) {
      const st = String(p.state);
      if (!ALL_STATES.has(st)) throw new Error('bad_state:' + st);
      row.state = st;
    }
    if (p.outcome !== undefined) row.outcome = p.outcome == null ? null : String(p.outcome);
    if (p.stateReason !== undefined) row.stateReason = p.stateReason == null ? null : String(p.stateReason);
    if (p.attempted !== undefined) row.attempted = p.attempted === true;
    if (p.attemptedAt !== undefined) row.attemptedAt = p.attemptedAt == null ? null : Number(p.attemptedAt);
    if (p.attemptCount != null) row.attemptCount = Math.max(0, Math.round(Number(p.attemptCount) || 0));
    if (p.childPid !== undefined) row.childPid = p.childPid == null ? null : Number(p.childPid);
    if (p.childStartedAt !== undefined) row.childStartedAt = p.childStartedAt == null ? null : Number(p.childStartedAt);
    if (p.startedAt !== undefined) row.startedAt = p.startedAt == null ? null : Number(p.startedAt);
    if (p.endedAt !== undefined) row.endedAt = p.endedAt == null ? null : Number(p.endedAt);
    if (p.tookMs !== undefined) row.tookMs = p.tookMs == null ? null : Number(p.tookMs);
    if (p.settleMs !== undefined) row.settleMs = p.settleMs == null ? null : Number(p.settleMs);
    if (p.sessionId !== undefined) row.sessionId = p.sessionId == null ? null : clipText(String(p.sessionId), 200);
    if (p.sessionReused !== undefined) row.sessionReused = p.sessionReused === true;
    if (p.sessionMismatch !== undefined) row.sessionMismatch = p.sessionMismatch === true;
    if (p.text !== undefined) row.text = clipText(String(p.text == null ? '' : p.text), RESULT_TEXT_MAX);
    if (p.error !== undefined) row.error = clipText(String(p.error == null ? '' : p.error), ERROR_MAX);
    if (p.tools !== undefined) row.tools = safeTools(p.tools);
    if (p.verifyTier !== undefined) row.verifyTier = String(p.verifyTier || 'none').slice(0, 20);
    if (p.workspaceAlias !== undefined) row.workspaceAlias = p.workspaceAlias == null ? null : String(p.workspaceAlias).slice(0, 60);
    if (p.workspaceRoot !== undefined) row.workspaceRoot = p.workspaceRoot == null ? null : String(p.workspaceRoot).slice(0, 500);
    if (p.workspaceRealpath !== undefined) row.workspaceRealpath = p.workspaceRealpath == null ? null : String(p.workspaceRealpath).slice(0, 500);
    if (p.verifyCommand !== undefined) row.verifyCommand = p.verifyCommand == null ? null : clipText(String(p.verifyCommand), 2000);
    if (p.reworkMax !== undefined) row.reworkMax = p.reworkMax == null ? null : Number(p.reworkMax);
    if (p.cancelRequestedAt !== undefined) row.cancelRequestedAt = p.cancelRequestedAt == null ? null : Number(p.cancelRequestedAt);
    if (p.cancelledAt !== undefined) row.cancelledAt = p.cancelledAt == null ? null : Number(p.cancelledAt);
    // P1：验收四态 / 文件证据 / 取消时已写文件清单
    if (p.verify !== undefined) row.verify = safeVerify(p.verify);
    if (p.evidence !== undefined) row.evidence = safeEvidence(p.evidence);
    if (p.partialWrites !== undefined) row.partialWrites = safePathList(p.partialWrites, 200);
    row.version = Math.max(1, Number(row.version) || 1) + 1;

    const ok = writeJson(row, { strict });
    putCache(row);
    rememberRequest(row);
    appendEvent('update', row);
    return row;
  }

  /**
   * spawn 前必须成功落盘（strict=true）：写不进去就抛，调用方据此拒绝派活。
   * 顺序契约：attempted=true/attemptCount+1 先于 spawn —— 这是「不可逆点」。
   */
  function markAttempted(taskId, { childPid = null, childStartedAt = null, startedAt = null } = {}) {
    const row = get(taskId);
    if (!row) throw new Error('ledger_task_not_found');
    const at = now();
    row.attempted = true;
    row.attemptedAt = at;
    row.attemptCount = Math.max(1, Math.round(Number(row.attemptCount) || 0) + 1);
    row.startedAt = startedAt == null ? (row.startedAt || at) : Number(startedAt);
    if (childPid != null) row.childPid = Number(childPid);
    if (childStartedAt != null) row.childStartedAt = Number(childStartedAt);
    // 重试（仅 spawn_failed + attempted=false 合法）：回到 running，清掉上次终态痕迹。
    row.state = 'running';
    row.outcome = null;
    row.stateReason = null;
    row.endedAt = null;
    row.tookMs = null;
    row.version = Math.max(1, Number(row.version) || 1) + 1;
    writeJson(row, { strict: true });   // 失败必须抛出，绝不能「写不进去还照派」
    putCache(row);
    rememberRequest(row);
    appendEvent('attempt', row);
    return row;
  }

  function finish(taskId, patch = {}) {
    const row = get(taskId);
    if (!row) return null;
    const wasTerminal = isTerminalState(row.state);
    const ended = now();
    const p = Object.assign({}, patch);
    if (p.state == null) p.state = (p.outcome === 'failed') ? 'failed' : 'done';
    if (p.endedAt == null) p.endedAt = ended;
    if (p.tookMs == null) p.tookMs = Math.max(0, ended - (Number(row.startedAt) || Number(row.createdAt) || ended));
    const next = update(taskId, p, { strict: false });
    if (!next) return null;
    if (!wasTerminal && isTerminalState(next.state)) terminalCount += 1;
    if (terminalCount > terminalLimit) trimTerminal();
    appendEvent('settle', next);
    return next;
  }

  /** 断线/超时/重启：状态 unknown、outcome=null；attempted 保持原值（绝不回退成可重派）。 */
  function markUnknown(taskId, reason, patch = {}) {
    const row = get(taskId);
    if (!row) return null;
    const ended = now();
    return update(taskId, Object.assign({
      state: 'unknown',
      outcome: null,
      stateReason: String(reason || 'disconnect'),
      endedAt: ended,
      tookMs: Math.max(0, ended - (Number(row.startedAt) || Number(row.createdAt) || ended)),
    }, patch || {}), { strict: false });
  }

  function findByRequestId(requestId) {
    const key = String(requestId == null ? '' : requestId).trim();
    if (!key) return null;
    const hit = requestIndex.get(key);
    if (!hit) {
      // 索引可能因进程内新建而缺失：兜底扫一遍缓存
      for (const row of cache.values()) {
        if (row.requestId === key) return row;
      }
      return null;
    }
    if (now() - (Number(hit.createdAt) || 0) > requestTtlMs) {
      requestIndex.delete(key);
      return null;
    }
    return get(hit.taskId);
  }

  /** 列表只返回「可公开展示」的字段（preview≤120，无正文/结果）。 */
  function listPreview({ limit = 50 } = {}) {
    ensureLoaded();
    // 以文件为真源重新扫一遍：缓存只保最近 100 条，不能让「被淘汰的旧记录」
    // 把列表挤成随机子集（保留 200 条终态，但列表默认只显示最近 50）。
    const rows = [];
    let files = [];
    try { files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json')); } catch (e) { files = []; }
    if (files.length) {
      for (const f of files) {
        const row = parseRowFile(join(tasksDir, f));
        if (row) rows.push(row);
      }
    } else {
      rows.push(...cache.values());
    }
    rows.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    const n = Math.max(1, Math.min(500, Math.round(Number(limit) || 50)));
    return rows.slice(0, n).map((r) => ({
      taskId: r.taskId,
      taskPreview: makeTaskPreview(r.taskPreview || r.taskText),
      state: r.state,
      outcome: r.outcome,
      stateReason: r.stateReason,
      attempted: r.attempted === true,
      attemptCount: r.attemptCount,
      tookMs: r.tookMs,
      createdAt: r.createdAt,
      endedAt: r.endedAt,
      origin: r.origin,
    }));
  }

  /** 详情：完整记录（调用方负责鉴权；HTTP 详情端点强制 X-Pet-Token）。 */
  function getDetail(taskId) {
    return get(taskId);
  }

  /** 裁剪：只裁终态，保留最近 terminalLimit 条；未终态（running/unknown）全留。 */
  function trimTerminal() {
    let files = [];
    try { files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json')); } catch (e) { return { removed: 0 }; }
    const terminals = [];
    let live = 0;
    for (const f of files) {
      const row = parseRowFile(join(tasksDir, f));
      if (!row) continue;
      if (isTerminalState(row.state)) terminals.push(row);
      else live += 1;
    }
    terminals.sort((a, b) => (Number(a.endedAt) || Number(a.createdAt) || 0) - (Number(b.endedAt) || Number(b.createdAt) || 0));
    const need = terminals.length - terminalLimit;
    if (need <= 0) {
      terminalCount = terminals.length;
      return { removed: 0, terminal: terminals.length, live };
    }
    let removed = 0;
    for (let i = 0; i < need; i += 1) {
      const row = terminals[i];
      try {
        fs.unlinkSync(taskFile(row.taskId));
        cache.delete(row.taskId);
        removed += 1;
        appendEvent('trim', row, { reason: 'terminal_limit' });
      } catch (e) {
        say('裁剪失败 ' + row.taskId + ': ' + String((e && e.message) || e));
      }
    }
    terminalCount = Math.max(0, terminals.length - removed);
    return { removed, terminal: terminalCount, live };
  }

  /**
   * 启动恢复：上次进程留下的 running/cancelling → unknown + stateReason=restart。
   * 只改状态，不删任何字段；attempted 保持不变（重启不等于没跑过）。
   */
  function recover() {
    const rows = loadAll({ reset: true });
    const recovered = [];
    for (const row of rows) {
      if (row.state !== 'running' && row.state !== 'cancelling') continue;
      const ended = now();
      row.state = 'unknown';
      row.outcome = null;
      row.stateReason = 'restart';
      row.endedAt = ended;
      row.tookMs = Math.max(0, ended - (Number(row.startedAt) || Number(row.createdAt) || ended));
      row.version = Math.max(1, Number(row.version) || 1) + 1;
      if (writeJson(row, { strict: false })) {
        putCache(row);
        appendEvent('recover', row, { reason: 'restart' });
        recovered.push(row.taskId);
      }
    }
    return recovered;
  }

  /** 观测/测试用：文件为真源，cache 只做参考。JSONL 坏行只计数，不影响其它统计。 */
  function stats() {
    const rows = loadAll({ reset: false });
    const states = {};
    for (const s of ALL_STATES) states[s] = 0;
    for (const r of rows) states[r.state] = (states[r.state] || 0) + 1;
    let jsonlBytes = 0;
    let jsonlEvents = 0;
    let badEventLines = 0;
    try { jsonlBytes = fs.statSync(jsonlPath).size; } catch (e) { jsonlBytes = 0; }
    try {
      for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const ev = JSON.parse(s);
          if (ev && ev.taskId) jsonlEvents += 1;
          else badEventLines += 1;
        } catch (e) { badEventLines += 1; }
      }
    } catch (e) { /* 文件不存在 = 还没写过事件 */ }
    return {
      room,
      tasksDir,
      jsonlPath,
      total: rows.length,
      terminal: rows.filter((r) => isTerminalState(r.state)).length,
      live: rows.filter((r) => !isTerminalState(r.state)).length,
      states,
      requestIndexSize: requestIndex.size,
      jsonlBytes,
      jsonlEvents,
      badEventLines,
      cacheSize: cache.size,
    };
  }

  return {
    room,
    tasksDir,
    jsonlPath,
    create,
    get,
    getDetail,
    update,
    markAttempted,
    finish,
    markUnknown,
    findByRequestId,
    listPreview,
    trimTerminal,
    recover,
    stats,
    // 测试/排障：显式触发全量重载
    reload: () => loadAll({ reset: true }),
  };
}

export default { createDispatchLedger, readLedgerV2Enabled, dispatchRoomDir, makeTaskPreview, normalizeTaskId, isTerminalState };
