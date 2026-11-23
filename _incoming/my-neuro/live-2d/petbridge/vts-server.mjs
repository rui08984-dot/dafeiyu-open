/**
 * ⚠ 归属（2026-11-16）：**这份是活的**。主产品 main.js 加载的是本文件
 *   （live-2d/petbridge/vts-server.mjs）。改 VTS/8102/8103 的功能请改这里。
 *   另有一份 pet-runtime/vts-server.mjs —— 只给独立 pet-runtime 宿主（开发舞台）用，
 *   主产品不加载它，别改错文件。
 */
/**
 * vts-server.mjs — 我们自己实现的「VTube Studio 协议兼容层」。
 *
 * 对外：ws://127.0.0.1:8001 按 VTube Studio Public API 收发，任何把本程序
 *       当成 VTS 来连的客户端（第三方 VTS 客户端 / OBS 插件等）都能直接驱动皮套。
 *       另开一个 HTTP 控制口（默认 8103）给不吃 WebSocket 的脚本用：
 *       POST /say   {text}          说话气泡 + 字幕
 *       POST /asset {id, on}        换装/换形态开关
 *       POST /action{name}          播放动作编舞
 *       GET  /state                 当前状态快照
 * 对内：ws://127.0.0.1:8102 推给渲染进程（Electron 页面）实际参数。
 * 端口约定：8001 VTS（对外协议）/ 8102 内部渲染 / 8103 HTTP 控制。
 * 8002、8003 必须留给上游生态（rag-memory 要 8002、MemOS 要 8003），别占。
 */
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
// 渲染层存活判据（CJS 纯函数）：主进程看门狗、8103 /state、doctor 共用同一份阈值，
// 免得「主进程判死要重载、doctor 判成省电」两套口径互相打脸。
import renderLiveness from './render-liveness.js';
// DSH 人工回答映射 + 8103 Origin 白名单（纯函数，单测见 _probe/test-dsh-ask-chain.cjs）。
// 否定句优先的规则只住在那一个文件里 —— 这里不再自己写匹配，防止两套口径漂移。
import dshMap from './dsh-answer-map.js';
// 派活账本（P0 可见+安全 · 2026-11-23）：每任务 JSON + 事件 JSONL + 24h requestId 幂等。
// 设计见 docs/设计-派活v2-2026-11-23.md；回滚开关 config.dispatch.ledger_v2=false。
import {
  createDispatchLedger,
  makeTaskPreview,
  normalizeTaskId,
  isTerminalState,
} from './dispatch-ledger.mjs';
// 派活 v2 P1（2026-11-23）：runner 直接持有 DSH 子进程句柄（取消/事件解析），
// verify 负责 settle→快照→四态验收。vts-server 不再 spawn dsh-dispatch.mjs 孙进程。
import { createDispatchRunner } from './dispatch-runner.mjs';
import {
  resolveWorkspace,
  snapshotWorkdir,
  diffSnapshots,
  settleWorkdir,
  runVerify,
} from './dispatch-verify.mjs';
import { spawn } from 'node:child_process';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// 本文件是 ESM，但配置写盘必须复用 CJS 的唯一入口 config-persist
// （原子写 + 备份 + 回读校验）。2026-11-22 审计 P0：/quiet 原来是裸
// readFileSync→writeFileSync，写一半崩溃会留下半截 config.json（下次起不来），
// 写失败还被吞掉、照样回 ok:true。
const require = createRequire(import.meta.url);
// B1 三态判定（纯 CJS 函数，插件与 8103 用同一份口径，不复制规则）。
// 缺文件也不能拖垮 8103：分类器不可用时回退最小策略（成功也保守记 done_unproven）。
let taskLedger = null;
try { taskLedger = require('../plugins/community/dispatch/task-ledger.js'); } catch (e) { taskLedger = null; }
function classifyOutcomeSafe(input) {
  if (taskLedger && typeof taskLedger.classifyOutcome === 'function') return taskLedger.classifyOutcome(input);
  return input && input.ok === true
    ? { outcome: 'done_unproven', why: '三态分类器不可用：自述成功按未证实处理' }
    : { outcome: 'failed', why: '执行器回报失败' };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCH = join(HERE, 'dsh-dispatch.mjs');

// 情绪状态持久化（C-1b）：存到 <项目>/data/情绪状态.json，原子写。
// 为什么放这里：主进程才有文件权限；渲染层通过 8103 存取（同机回环）。
const EMOTION_STATE_FILE = '情绪状态.json';
function emotionStatePath(configPath) {
  if (!configPath) return null;
  return join(dirname(configPath), '..', 'data', EMOTION_STATE_FILE);
}
function readEmotionState(configPath) {
  const p = emotionStatePath(configPath);
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function writeEmotionState(configPath, obj) {
  const p = emotionStatePath(configPath);
  if (!p) return { ok: false, error: 'no_config_path' };
  try {
    fs.mkdirSync(dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return { ok: true, path: p };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// ── 浏览器 tab 上报（世界感知 Phase 2 第一条 · 2026-11-20 六十七轮）──────────
// 自建 MV3 扩展只上报「活动 tab 的 host/title/audible」，落 data/browser-tabs.jsonl。
// 这一层是纯函数 + 一个 sink，方便 _probe/test-browser-tabs.cjs 不起 HTTP 直接测。
// 契约字段固定：ts/host/title/audible/incognito/tabCount/source（source 恒 'ext'）。
const BROWSER_TAB_FILE = 'browser-tabs.jsonl';
const BROWSER_TAB_SEEN_FILE = 'browser-tabs-seen.json';   // 「最后一次看到」≠「内容变化时间」
const BROWSER_TAB_MAX_BYTES = 2 * 1024 * 1024;   // 超过 2MB → 轮转成 .1（新文件从 1 行开始）
const BROWSER_TAB_TITLE_MAX = 80;

/** 落盘文件位置：与情绪状态同一套推导（config.json 的父目录 → my-neuro/data）。 */
export function browserTabRecordPath(configPath) {
  if (!configPath) return null;
  return join(dirname(configPath), '..', 'data', BROWSER_TAB_FILE);
}

/** 心跳标记文件：记录「最后一次看到这条页面」的服务端时刻（不追加 jsonl 行）。
 *  与 browser-tabs.jsonl 同目录，world-extras 按同一推导读取；只是运行态标记，不是配置。 */
export function browserTabSeenPath(configPath) {
  if (!configPath) return null;
  return join(dirname(configPath), '..', 'data', BROWSER_TAB_SEEN_FILE);
}

/** 标题按「字」截断（Array.from 按码点，避免把 emoji 劈成半个代理对）。 */
function clipBrowserTabTitle(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, BROWSER_TAB_TITLE_MAX).join('');
}

/**
 * /dispatch 的 HTTP 入参收敛（纯函数，便于单测）。
 * 2026-11-21 红队 P1 #4：cwd 不接受 HTTP 传入 —— 只允许进程内调用者指定；
 * 这里显式把 ignoredCwd 返回给调用方打日志，避免「静默丢弃」。
 * 2026-11-23 P0：接受可选 taskId / requestId（账本幂等；requestId 24h 内唯一）。
 * @returns {{task: any, opts: {sessionId?: any, timeoutMs?: any, taskId?: string, requestId?: string}, ignoredCwd: string}}
 */
export function sanitizeDispatchHttpBody(input) {
  const body = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const task = body.task != null ? body.task : body.text;
  const opts = {};
  if (body.sessionId != null) opts.sessionId = body.sessionId;
  if (body.timeoutMs != null) opts.timeoutMs = body.timeoutMs;
  if (body.taskId != null && String(body.taskId).trim()) opts.taskId = String(body.taskId).trim().slice(0, 80);
  if (body.requestId != null && String(body.requestId).trim()) opts.requestId = String(body.requestId).trim().slice(0, 120);
  // P1：workspace 只接受配置里的别名（不是路径）；verify 是一条命令，插件只透传。
  if (body.workspace != null && String(body.workspace).trim()) opts.workspace = String(body.workspace).trim().slice(0, 60);
  if (body.verify != null && String(body.verify).trim()) opts.verify = String(body.verify).trim().slice(0, 2000);
  if (body.verifyTimeoutMs != null && Number.isFinite(Number(body.verifyTimeoutMs))) opts.verifyTimeoutMs = Number(body.verifyTimeoutMs);
  if (body.rework != null && Number.isFinite(Number(body.rework))) opts.rework = Number(body.rework);
  return { task, opts, ignoredCwd: body.cwd != null ? String(body.cwd) : '' };
}

/**
 * 读 config.dispatch 的 P1 设置（缺省全开；只有显式 false 才关，与 ledger_v2 同口径）。
 * workspaces/defaultWorkspace 供 resolveWorkspace 使用；数值项做上限夹紧。
 * @returns {{ledgerV2:boolean, cancel:boolean, verify:boolean, workspace:boolean,
 *            workspaces:object, defaultWorkspace:string, verifyTimeoutMs:number,
 *            reworkMax:number, cancelGraceMs:number}}
 */
export function readDispatchSettings(configPath) {
  let d = null;
  if (configPath) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      d = cfg && cfg.dispatch;
      if (d && (typeof d !== 'object' || Array.isArray(d))) d = null;
    } catch (e) { d = null; }
  }
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
  };
  const table = d && d.workspaces && typeof d.workspaces === 'object' && !Array.isArray(d.workspaces)
    ? d.workspaces : {};
  return {
    ledgerV2: !(d && d.ledger_v2 === false),
    cancel: !(d && d.cancel === false),
    verify: !(d && d.verify === false),
    workspace: !(d && d.workspace === false),
    workspaces: table,
    defaultWorkspace: d && typeof d.defaultWorkspace === 'string' ? d.defaultWorkspace.trim().slice(0, 60) : '',
    verifyTimeoutMs: num(d && d.verify_timeout_ms, 60000, 5000, 600000),
    reworkMax: Math.round(num(d && d.rework_max, 1, 0, 3)),
    cancelGraceMs: num(d && d.cancel_grace_ms, 2000, 300, 10000),
  };
}

/**
 * 取消回执 partialWrites 的时间窗（2026-11-23 修）：
 * 基线以来的 diff 会带上「任务开始前就改过、只是被本进程看到」的无关改动
 * （defaultWorkspace=pet 时实测踩到）。用 mtime 过滤 modified：只保留
 * mtime ≥ startedAt - 2000ms 的条目。created 不走这个过滤（基线里不存在，
 * 必然是任务期间出现的）；-2s 是给文件系统时间戳粒度留的容差。
 *
 * 注意：evidence.modified 仍是全量（验收/返工要看全部改动），
 * 只有 partialWrites 用 modifiedSinceTask。
 */
export const PARTIAL_WRITE_WINDOW_MS = 2000;

/** 快照指纹是 "mtimeMs:size"（见 dispatch-verify.snapshotWorkdir）。 */
export function snapshotMtimeMs(fingerprint) {
  const s = String(fingerprint == null ? '' : fingerprint);
  const i = s.indexOf(':');
  const n = Number(i >= 0 ? s.slice(0, i) : s);
  return Number.isFinite(n) ? n : null;
}

export function filterModifiedSinceTask(after, modified, startedAt, windowMs = PARTIAL_WRITE_WINDOW_MS) {
  const list = Array.isArray(modified) ? modified : [];
  const start = Number(startedAt);
  if (!Number.isFinite(start) || start <= 0) return [];
  const files = (after && after.files) || {};
  const limit = start - Math.max(0, Number(windowMs) || 0);
  return list.filter((rel) => {
    const mtime = snapshotMtimeMs(files[rel]);
    return mtime != null && mtime >= limit;
  });
}

/**
 * 把上报 payload 收敛成落盘记录。非法输入返回 { ok:false, error }。
 * 隐私红线：incognito=true 时 host/title 一律清空，audible 也置 false —— 不落任何可还原站点的字段。
 * host 只接受「域名形态」（不含空白/斜杠/反斜杠，≤253 字符）；扩展侧已经用 new URL().hostname。
 */
export function sanitizeBrowserTab(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'bad-body' };
  const incognito = input.incognito === true;
  let host = '';
  if (!incognito) {
    host = String(input.host == null ? '' : input.host).trim().toLowerCase();
    if (!host) return { ok: false, error: 'empty-host' };
    if (host.length > 253 || /[\s/\\]/.test(host)) return { ok: false, error: 'bad-host' };
  }
  const n = Number(input.tabCount);
  const tabCount = Number.isFinite(n) ? Math.max(0, Math.min(10000, Math.round(n))) : 0;
  // ts 只用来保序：允许客户端给（本机回环、无安全价值），跨 24h 的一律当本地时钟不可信。
  const clientTs = Number(input.ts);
  const ts = Number.isFinite(clientTs) && clientTs > 0 && Math.abs(Date.now() - clientTs) < 24 * 60 * 60 * 1000
    ? Math.round(clientTs)
    : Date.now();
  return {
    ok: true,
    record: {
      ts,
      host,
      title: incognito ? '' : clipBrowserTabTitle(input.title),
      audible: incognito ? false : input.audible === true,
      incognito,
      tabCount,
      source: 'ext',
    },
  };
}

/**
 * 校验 X-Pet-Token 与 config.json 的 browser_ext_token。
 * 空/缺配置一律拒绝（不许默认放行）；比较用 timingSafeEqual，长度不等直接判错。
 */
export function checkBrowserToken(configPath, token) {
  if (!configPath) return { ok: false, reason: 'not-configured' };
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { return { ok: false, reason: 'config-unreadable' }; }
  const expected = String((cfg && cfg.browser_ext_token) || '').trim();
  if (!expected) return { ok: false, reason: 'not-configured' };
  const got = String(token == null ? '' : token).trim();
  if (!got) return { ok: false, reason: 'bad-token' };
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: 'bad-token' };
}

/**
 * ── 8103 浏览器来源写令牌（2026-11-21 红队 P1）────────────────────────────
 * 口径（唯一一份，测试见 _probe/test-control-auth.cjs）：
 *   · 请求**没有** Origin 头 → 进程内/同用户进程调用（DSH answerer、remote-control、
 *     手机 3003 服务端、插件里的 node:http），放行；
 *   · 请求**带**任意 Origin（file:// / http://localhost / https://evil …）→ 只要方法
 *     不是 GET/HEAD/OPTIONS，就必须带 X-Pet-Token 且等于本机 .control-token，否则 403。
 * 浏览器页面无法省略 Origin，所以「无 Origin 放行」挡不住网页；令牌才是闸门。
 * /browser-tab 保持既有机制（browser_ext_token / browser_ext_ids），不叠加令牌。
 */
export const CONTROL_TOKEN_FILE = '.control-token';

/** 令牌文件位置：与情绪状态同一套推导（config.json 的父目录 → my-neuro/data）。 */
export function controlTokenPath(configPath) {
  const base = configPath ? join(dirname(configPath), '..') : join(HERE, '..', '..');
  return join(base, 'data', CONTROL_TOKEN_FILE);
}

/**
 * 读 .control-token；不存在/为空则生成 32 字节随机 hex 并原子写入（尽量 0600）。
 * 读失败返回内存令牌（不阻断启动），下次启动会重新生成 —— 调用方打日志即可。
 */
export function resolveControlToken(configPath, log = null) {
  const file = controlTokenPath(configPath);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (e) { /* 首次启动 / 文件被删：走生成 */ }
  const token = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, token + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows 无 POSIX 权限语义 */ }
    return token;
  } catch (e) {
    // 写不进磁盘就只有内存令牌：主进程窗口从文件读会拿到别的值（或空），
    // 渲染层 POST 会被 403 —— 必须发声，不能静默。
    // 先重读一次：并发启动时另一个进程可能刚好写成功（用盘上那份保持一致）。
    try {
      const raced = fs.readFileSync(file, 'utf8').trim();
      if (raced) return raced;
    } catch (e2) { /* 确实没有可读文件 */ }
    if (typeof log === 'function') log('[control-auth] 写 .control-token 失败（仅本进程可用）: ' + String((e && e.message) || e));
    return token;
  }
}

/**
 * 判定一次控制口写请求。纯函数，单测直接调。
 * @returns {{ok: boolean, reason: string}}
 */
export function controlAuthVerdict({ origin, token, expectedToken, method = 'POST' } = {}) {
  const hasOrigin = typeof origin === 'string' && origin.trim() !== '';
  if (!hasOrigin) return { ok: true, reason: 'no-origin' };
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return { ok: true, reason: 'read-only' };
  const expected = String(expectedToken == null ? '' : expectedToken).trim();
  if (!expected) return { ok: false, reason: 'not-configured' };
  const got = String(token == null ? '' : token).trim();
  if (!got) return { ok: false, reason: 'missing-token' };
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b)
    ? { ok: true, reason: 'ok' }
    : { ok: false, reason: 'bad-token' };
}

/**
 * 落盘 sink：连续相同 (host,title,audible,incognito) 不重复写（只记内存上一条）。
 *
 * 2026-11-21 修（P1 心跳）：内容不变 ≠ 页面不在看。扩展每 60s 心跳一次，旧实现把
 * 心跳也判 skipped 且不刷新任何时间戳 → world-extras 按 jsonl 里那条的 `ts` 判 5 分钟
 * 新鲜度，同一页面停 5 分钟以上世界行就再也没有 web 了。
 * 现在把两个时间分开：
 *   · `ts`（jsonl 行）= 内容变化时间，只在真的追加行时写；
 *   · `seen_ts`（browser-tabs-seen.json）= 最后一次**收到上报**的服务端时刻，skipped 也刷新。
 * 不追加行（不污染日志），只在同目录覆盖一个小标记文件。标记写失败不影响上报。
 *
 * 轮转策略：append 前若文件 ≥2MB，先删旧 .1 再把当前文件改名 .1 —— 任何时刻最多两份。
 * 写盘失败返回 { ok:false, error }，由路由转 500 并打日志（绝不假成功）。
 */
export function createBrowserTabSink({ configPath = null, fsImpl = fs, now = () => Date.now() } = {}) {
  let lastKey = null;
  let lastRecord = null;
  let lastSeenAt = 0;

  /** 刷新「最后一次看到」（服务端接收时刻，不信任客户端 ts）并尽力落标记文件。 */
  function markSeen(record) {
    lastSeenAt = now();
    const file = browserTabSeenPath(configPath);
    if (!file) return lastSeenAt;
    try {
      fsImpl.mkdirSync(dirname(file), { recursive: true });
      const tmp = file + '.tmp-' + process.pid;
      // 隐私：标记只留 host/incognito，不留 title（incognito 时 host 本来就是空）
      fsImpl.writeFileSync(tmp, JSON.stringify({
        seen_ts: lastSeenAt,
        host: record && !record.incognito ? String(record.host || '') : '',
        incognito: !!(record && record.incognito === true),
      }) + '\n', { encoding: 'utf8', mode: 0o600 });
      fsImpl.renameSync(tmp, file);
    } catch (e) { /* 标记写不进去就退化为旧行为（内存 seen_ts 本轮仍有效） */ }
    return lastSeenAt;
  }

  return {
    append(record) {
      if (!record || typeof record !== 'object') return { ok: false, error: 'bad-record' };
      const key = JSON.stringify([record.host, record.title, record.audible === true, record.incognito === true]);
      if (key === lastKey) {
        // 内容没变：不追加行，但「刚看到过」这件事必须记下来（心跳语义）
        const seen_ts = markSeen(lastRecord || record);
        return { ok: true, skipped: true, record: lastRecord, seen_ts };
      }
      const file = browserTabRecordPath(configPath);
      if (!file) return { ok: false, error: 'no_config_path' };
      try {
        fsImpl.mkdirSync(dirname(file), { recursive: true });
        try {
          if (fsImpl.statSync(file).size >= BROWSER_TAB_MAX_BYTES) {
            const bak = file + '.1';
            try { fsImpl.unlinkSync(bak); } catch (e) { /* 旧备份不存在 */ }
            fsImpl.renameSync(file, bak);
          }
        } catch (e) { /* 文件不存在 = 首次写 */ }
        fsImpl.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
        lastKey = key;
        lastRecord = record;
        const seen_ts = markSeen(record);
        return { ok: true, skipped: false, record, path: file, seen_ts };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    },
    last() { return lastRecord; },
    lastSeen() { return lastSeenAt; },
    reset() { lastKey = null; lastRecord = null; lastSeenAt = 0; },
  };
}

const API_NAME = 'VTubeStudioPublicAPI';
const API_VERSION = '1.0';
const VTS_VERSION = '1.29.0-pet-runtime';
const INJECT_FRAME_MS = 16; // 参数注入合帧：最多 60fps 推给渲染进程

export function startVtsServer({ port = 8001, internalPort = 8102, controlPort = 8103, model, log = console.log, configPath = null, quietDefault = false, getWorld = null, setWorld = null, dispatchSpawn = null, dispatchKill = null, verifySpawn = null } = {}) {
  const state = {
    params: new Map(),
    expressions: new Set(),
    subscribers: new Set(),
    clients: 0,
    lastInjectAt: 0,
    pendingParams: null,
    injectTimer: null,
    lastSay: '',
    assets: {},
    assetStates: null,
    lastFullscreen: false,
    lastPointer: null,
    // 静默模式（省钱闸）：静默版默认开（config.cost.quiet），/quiet 切换并持久化
    quiet: !!quietDefault,
    // 渲染层存活（2026-11-15）：主进程自己记账，不依赖渲染层上报 ——
    // 渲染层冻死时它自己喊不出来，只有这里记得「它上一次活着是什么时候」。
    innerClients: 0,
    lastInnerAt: 0,
    // 浏览器 tab 上报（世界感知 Phase 2）：最后一次真的落盘的那条（GET /state 可观测）。
    browserTabLast: null,
  };
  global.__petQuiet = state.quiet;
  const renderers = new Set();
  // 浏览器扩展上报的落盘器（去重 + 轮转都在里面；单测直接 require 同一份纯函数）。
  const browserTabSink = createBrowserTabSink({ configPath });

  // ── DSH 人工应答通道（2026-11-20 六十六轮）────────────────────────────────
  // DSH 的 ask_user_question 在 headless profile 里没有 Web 回答者；插件
  // dsh-pet-answerer 先 POST /dsh/ask 问宿主。我们把问题转述给用户，然后
  // **挂起等一条**用户文本/语音（渲染层 InputRouter 回传 /dsh/reply）。
  // 同时最多挂一个问题；超时如实返回空答案，让插件回落规则应答。
  // 注意：这是「一次性等待器」，不是消息代理 —— 用户那句话仍会照常走对话主链。
  const ASK_TIMEOUT_MS = (() => {
    const n = Number(process.env.PET_DSH_ASK_TIMEOUT_MS);
    return Number.isFinite(n) && n >= 5000 ? Math.min(Math.round(n), 120000) : 60000;
  })();

  // DSH 通道落盘日志：Electron 由 Start-Process 隐藏窗口拉起时 stdout 是黑洞，
  // 只 console.log 等于没证据。写 live-2d/dsh-ask.log（1MB 轮转），实测/排障可查。
  function askLog(line) {
    try { log('[dsh/ask] ' + line); } catch (e) { /* 控制台不可用不影响 */ }
    try {
      const file = join(HERE, '..', 'dsh-ask.log');
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
        try { fs.renameSync(file, file + '.1'); } catch (e) { /* 轮转失败就让文件继续长 */ }
      }
      fs.appendFileSync(file, '[' + new Date().toISOString() + '] [dsh/ask] ' + line + '\n', 'utf8');
    } catch (e) { /* 写日志失败不能影响应答 */ }
  }

  // 挂起等待器的状态机住在 dsh-answer-map.js（纯逻辑、可单测：
  // 超时返回 / busy 返回 / 人工回答 / 请求方断开）。
  const askBroker = dshMap.createAskBroker({
    timeoutMs: ASK_TIMEOUT_MS,
    onEvent: (type, info) => {
      if (type === 'timeout') askLog('等待超时（' + info.timeoutMs + 'ms），返回空答案交给规则应答');
      else if (type === 'cancel') askLog('请求方断开，取消等待');
      else if (type === 'busy') askLog('已有待答问题（id=' + info.id + '），新请求按超时回落规则');
      else if (type === 'reply') askLog('收到人工回答: ' + JSON.stringify(info.answers));
    },
  });

  // 只接受我们认识的字段，长度/数量都封顶：这是本地回环口，但不代表可以无脑信任。
  function sanitizeDshQuestions(input) {
    if (!Array.isArray(input)) return null;
    const out = [];
    for (const raw of input.slice(0, 8)) {
      if (!raw || typeof raw !== 'object') continue;
      const id = String(raw.id == null ? '' : raw.id).trim();
      const question = String(raw.question == null ? '' : raw.question).trim();
      if (!id || !question) continue;
      const options = Array.isArray(raw.options)
        ? raw.options
          .map((o) => ({ label: String((o && o.label) == null ? '' : o.label).trim() }))
          .filter((o) => o.label)
          .slice(0, 12)
        : [];
      out.push({
        id: id.slice(0, 120),
        question: question.slice(0, 500),
        header: raw.header == null ? '' : String(raw.header).slice(0, 120),
        // 审计 P2 #29：detail（plan-review 的计划正文）不能丢——它决定用户是否敢批准。
        detail: raw.detail == null ? '' : String(raw.detail).slice(0, 300),
        options,
        multiSelect: raw.multiSelect === true,
      });
    }
    return out.length ? out : null;
  }

  // 把结构化问题转成一句她真能说出口的人话（第一个问题 + 选项标签）。
  function dshAskSpeech(questions) {
    const q = questions[0];
    const labels = (q.options || []).map((o) => o.label);
    const ends = (s) => /[。！？!?]$/.test(s);
    let s = (q.header ? q.header + '：' : '') + q.question;
    if (q.detail && String(q.detail).trim()) {
      // 详情可能是一整段计划：念前 60 字让用户知道在审什么，不把 300 字全念出来
      s += '（详情：' + String(q.detail).replace(/\s+/g, ' ').trim().slice(0, 60) + '…）';
    }
    if (labels.length) s += (ends(s) ? ' ' : '。') + '选项：' + labels.join('、');
    if (questions.length > 1) s += '（一共 ' + questions.length + ' 个问题，先答这个）';
    s += (ends(s) ? '' : '。') + '你直接说或者打字回我就行。';
    return s.slice(0, 300);
  }

  // 渲染层存活判据的唯一实现（render-liveness.js 纯函数）：
  // 主进程看门狗、GET /health、GET /state、doctor 全部读这一份，阈值只有一处。
  const liveness = (now) => renderLiveness.judgeRenderLiveness({
    now: now || Date.now(),
    innerClients: renderers.size,
    lastInnerAt: state.lastInnerAt,
    lastHealthAt: state.renderHealthAt || 0,
  });

  const bcast = (msg) => {
    const s = JSON.stringify(msg);
    for (const ws of renderers) { try { ws.send(s); } catch {} }
  };
  // VTS 事件只发给订阅了的对外客户端。
  const emitEvent = (eventName, payload) => {
    if (!state.subscribers.has(eventName) && !state.subscribers.has('*')) return;
    for (const ws of vts.clients) {
      if (ws.readyState !== 1) continue;
      try {
        ws.send(JSON.stringify({
          apiName: API_NAME, apiVersion: API_VERSION, requestID: 'event-' + Date.now(),
          messageType: eventName, data: payload,
        }));
      } catch {}
    }
  };

  // 参数注入合帧：外部工具可能以 120Hz 灌参数，渲染层只需要 60fps。
  const queueParams = (values) => {
    state.pendingParams = Object.assign(state.pendingParams || {}, values);
    if (state.injectTimer) return;
    state.injectTimer = setTimeout(() => {
      state.injectTimer = null;
      const pending = state.pendingParams; state.pendingParams = null;
      if (pending) { state.lastInjectAt = Date.now(); bcast({ type: 'params', values: pending }); }
    }, INJECT_FRAME_MS);
  };

  const currentModel = () => model || { name: '大肥鱼', id: 'dafeiyu', expressions: [], hotkeys: [], parameters: [] };

  const activateExpression = (name, active) => {
    if (active) state.expressions.add(name); else state.expressions.delete(name);
    bcast({ type: 'expression', name, active });
    emitEvent('ExpressionStateChangedEvent', { expressionName: name, active });
  };

  const triggerHotkey = (hit) => {
    if (!hit) return false;
    if (hit.kind === 'expression') activateExpression(hit.name, !state.expressions.has(hit.name));
    else if (hit.kind === 'motion') bcast({ type: 'motion', group: hit.group, index: hit.index || 0 });
    else if (hit.kind === 'asset') setAsset(hit.assetId || hit.param || hit.id);
    emitEvent('HotkeyTriggeredEvent', { hotkeyID: hit.id, hotkeyName: hit.name, hotkeyTriggered: true });
    return true;
  };

  // on === undefined 表示翻转（热键语义），显式 true/false 表示设定。
  function setAsset(id, on) {
    const key = String(id);
    if (on === undefined) {
      const next = !(state.assets[key] === true);
      state.assets[key] = next;
      bcast({ type: 'asset', id: key, toggle: true, on: next });
      return next;
    }
    const value = !!on;
    state.assets[key] = value;
    bcast({ type: 'asset', id: key, on: value });
    return value;
  }

  // ── 派活账本 + P1 runner（可见+安全 → 可停+证据 · 2026-11-23）──────────
  // 开关：config.dispatch.ledger_v2（缺省 true；显式 false = 回旧内存 Map 行为）。
  // P1 能力（cancel/verify/workspace）依赖账本；ledger_v2=false 时明确报错，不静默降级。
  // 启动即 recover：上次进程留下的 running/cancelling 一律 unknown+restart，
  // 系统永不自动重派（attempted=true 的记录不给第二次执行机会）。
  const dispatchSettings = readDispatchSettings(configPath);
  const ledgerEnabled = dispatchSettings.ledgerV2;
  const dispatchLedger = ledgerEnabled ? createDispatchLedger({ configPath, log }) : null;
  if (dispatchLedger) {
    try {
      const recovered = dispatchLedger.recover();
      if (recovered.length) log('[dispatch-ledger] 启动恢复 ' + recovered.length + ' 个未结案任务 → unknown/restart');
    } catch (e) {
      log('[dispatch-ledger] 启动恢复失败（不影响派活）: ' + String((e && e.message) || e));
    }
  } else {
    log('[dispatch-ledger] ledger_v2=false：走旧内存 Map 行为，不写账本');
  }
  const spawnDispatch = typeof dispatchSpawn === 'function' ? dispatchSpawn : spawn;
  // runner 在 vts-server 进程内直接起 DSH（不经过 dsh-dispatch.mjs 孙进程）：
  // 只有这样才能持有 child 句柄、taskkill /T /F 杀到整棵树（设计 §3.1/§4.5）。
  const dispatchRunner = dispatchLedger
    ? createDispatchRunner({
      spawnImpl: typeof dispatchSpawn === 'function' ? dispatchSpawn : undefined,
      killImpl: typeof dispatchKill === 'function' ? dispatchKill : undefined,
      log,
    })
    : null;
  // 运行态：taskId → { baseline, ws, verifyCommand, rounds, timer, settled, ... }
  // 账本是事实源；这里只放「只能活在进程内」的东西（基线快照、反工轮次、取消信号）。
  const dispatchRuntime = new Map();

  /**
   * 旧路径（ledger_v2=false 回滚用）：行为与 2026-11-22 版本一致。
   * 只把 spawn 换成可注入的 spawnFn（测试用），不引入账本副作用。
   */
  function legacyDispatchTask(text, { cwd, sessionId, timeoutMs, spawnFn }) {
    bcast({ type: 'work-state', state: 'thinking' });
    say('收到，我让小D去办：' + text.slice(0, 40) + (text.length > 40 ? '…' : ''));
    return new Promise((resolve) => {
      const args = [DISPATCH, '--task', text, '--cwd', cwd];
      if (sessionId) args.push('--session', sessionId);
      const child = spawnFn(process.execPath, args, { cwd: HERE, windowsHide: true });
      let out = ''; let err = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.stdout.on('data', (c) => { out += c.toString(); });
      child.stderr.on('data', (c) => { err += c.toString(); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        let result = null;
        try { result = JSON.parse(out); } catch { result = { ok: false, error: (out || err).slice(-300) }; }
        const ok = !!(result && result.ok);
        const summary = ok ? String(result.text || '').trim().slice(0, 160) : ('没办成：' + String((result && result.error) || err).slice(0, 120));
        bcast({ type: 'work-state', state: ok ? 'done' : 'idle' });
        say(ok ? ('小D回话了：' + (summary || '办完了')) : summary);
        const payload = ok
          ? { ok: true, sessionId: result.sessionId, text: result.text, tookMs: result.tookMs, tools: result.tools }
          : { ok: false, error: (result && result.error) || String(err).slice(-300), sessionId: result && result.sessionId };
        resolve(payload);
      });
    });
  }

  const CANCEL_MESSAGE = '已停止；已经写下的文件不会回滚';

  /** 运行态收口：只 resolve 一次，并清掉超时定时器。 */
  function settleRuntime(rt, payload) {
    if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; }
    if (rt.settled) return false;
    rt.settled = true;
    const resolve = rt.resolve;
    rt.resolve = null;
    // 从运行态表摘掉：终态后不该再被取消路由看到（旧 handle 已由 runner 自己删）。
    try { dispatchRuntime.delete(rt.taskId); } catch (e) { /* 表操作失败不影响结案 */ }
    if (typeof resolve === 'function') resolve(payload);
    return true;
  }

  /** settle → 快照 diff。工作目录未知时如实标 unavailable，不伪造「无改动」。 */
  async function collectEvidence(rt, { settle = true } = {}) {
    let settleInfo = { settled: true, waitedMs: 0 };
    if (rt.ws && settle) {
      try {
        settleInfo = await settleWorkdir(rt.ws.realpath, { stableMs: 1000, maxMs: 5000 });
      } catch (e) {
        settleInfo = { settled: false, waitedMs: 0, reason: String((e && e.message) || e) };
      }
    }
    const after = rt.ws ? snapshotWorkdir(rt.ws.realpath, { maxMs: 1000 }) : null;
    const diff = (rt.baseline && after && after.ok)
      ? diffSnapshots(rt.baseline, after)
      : { created: [], modified: [], deleted: [], changed: false };
    // partialWrites 时间窗：modified 全量保留给验收/返工，modifiedSinceTask 只给取消回执。
    const modifiedSinceTask = filterModifiedSinceTask(after, diff.modified, rt && rt.startedAt);
    return {
      created: diff.created.slice(0, 300),
      modified: diff.modified.slice(0, 300),
      modifiedSinceTask: modifiedSinceTask.slice(0, 300),
      deleted: diff.deleted.slice(0, 300),
      // 快照只遍历 root：root 相对路径天然在界内；越界只能靠 P2 的外部证据（git status）。
      scopeViolations: [],
      gitStatus: null,
      changed: diff.changed,
      fileCount: after ? after.fileCount : 0,
      bytes: after ? after.bytes : 0,
      truncated: !!(after && after.truncated),
      settleMs: settleInfo.waitedMs || 0,
      settleTimedOut: settleInfo.settled === false,
      unavailableReason: rt.ws ? ((after && after.ok) ? null : ((after && after.unavailableReason) || 'snapshot_failed')) : 'no_workspace',
    };
  }

  function runVerifyForTask(rt) {
    return runVerify(rt.verifyCommand, {
      cwd: rt.cwd,
      timeoutMs: rt.verifyTimeoutMs,
      spawnImpl: typeof verifySpawn === 'function' ? verifySpawn : undefined,
    });
  }

  /** 返工提示词：同一 session 待实测，先按设计 §4.1 的「新会话 + 注入上下文」走。 */
  function buildReworkTask(rt, verify, evidence, round) {
    const changed = [...(evidence.created || []), ...(evidence.modified || [])].slice(0, 20);
    return [
      '原任务：' + rt.text,
      '',
      '上一轮验收失败（第 ' + round + ' 轮）：',
      String((verify && (verify.output || verify.why)) || '').slice(0, 1500),
      '',
      '上次改动文件（相对工作目录）：',
      changed.length ? changed.join('\n') : '（没有检测到文件改动）',
      '',
      '要求：只修不推倒 —— 在现有改动基础上修复验收失败的原因，不要重写整个方案、不要撤销已完成的部分；修完自己再跑一遍验收命令。',
    ].join('\n');
  }

  /**
   * 起一次后端执行（首次或返工）。attempted 必须在 spawn 前落盘（strict）。
   * @returns {object} runner handle
   */
  function startBackend(rt, { taskText, sessionId = '', alreadyAttempted = false, wireExit = true, autoTimeout = true, onEvent = null }) {
    const startedAt = Date.now();
    if (alreadyAttempted) {
      dispatchLedger.update(rt.taskId, { childStartedAt: startedAt }, { strict: false });
    } else {
      dispatchLedger.markAttempted(rt.taskId, { startedAt, childStartedAt: startedAt });
    }
    const handle = dispatchRunner.start({
      taskId: rt.taskId,
      task: taskText,
      cwd: rt.cwd,
      sessionId,
      onEvent,
    });
    rt.handle = handle;
    if (handle.pid) {
      dispatchLedger.update(rt.taskId, { childPid: handle.pid, childStartedAt: Date.now() }, { strict: false });
    }
    if (wireExit) {
      handle.result.then((info) => {
        if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; }
        onBackendExit(rt, info).catch((e) => {
          log('[dispatch] 收口异常 ' + rt.taskId + ': ' + String((e && e.message) || e));
          const r = dispatchLedger.markUnknown(rt.taskId, 'disconnect', { error: '收口异常：' + String((e && e.message) || e) });
          settleRuntime(rt, {
            ok: false, taskId: rt.taskId, state: 'unknown', outcome: null,
            stateReason: 'disconnect', attempted: r ? r.attempted === true : true,
            error: '收口异常，结果未知',
          });
        });
      }).catch(() => { /* result 不会 reject */ });
    }
    if (autoTimeout) {
      if (rt.timer) clearTimeout(rt.timer);
      rt.timer = setTimeout(() => onTimeout(rt), rt.timeoutMs);
    }
    return handle;
  }

  /** 超时：先记住「结果未知」，杀树；有 verify 时仍跑一次验收（§4.2）。 */
  function onTimeout(rt) {
    if (rt.settled || rt.cancelRequested || rt.timedOut) return;
    rt.timedOut = true;
    try { if (rt.handle) rt.handle.killTree(); } catch (e) { /* 可能已退出 */ }
    if (!rt.verifyCommand) {
      const r = dispatchLedger.markUnknown(rt.taskId, 'timeout', {
        error: '执行超时（' + rt.timeoutMs + 'ms），结果未知',
      });
      bcast({ type: 'work-state', state: 'idle' });
      say('后台任务超时了，结果未知，先别重复派。');
      settleRuntime(rt, {
        ok: false, taskId: rt.taskId, state: 'unknown', outcome: null,
        stateReason: 'timeout', attempted: r ? r.attempted === true : true,
        error: '执行超时，结果未知；不要重复派同一任务',
      });
      return;
    }
    // 有 verify：等子进程真的退出（最多 3s），然后照常 settle→快照→验收。
    const timer = setTimeout(() => {
      if (rt.settled || rt.cancelRequested || rt.completing) return;
      completeTask(rt, rt.lastInfo || null).catch((e) => {
        log('[dispatch] 超时后验收异常 ' + rt.taskId + ': ' + String((e && e.message) || e));
        const r = dispatchLedger.markUnknown(rt.taskId, 'timeout', { error: '验收收口异常：' + String((e && e.message) || e) });
        settleRuntime(rt, {
          ok: false, taskId: rt.taskId, state: 'unknown', outcome: null,
          stateReason: 'timeout', attempted: r ? r.attempted === true : true,
          error: '执行超时且验收收口异常，结果未知',
        });
      });
    }, 3000);
    if (timer.unref) timer.unref();
  }

  /** 子进程退出后的分派：取消/断线/超时各有自己的收口，其余走完整验收。 */
  async function onBackendExit(rt, info) {
    rt.lastInfo = info;
    if (rt.cancelRequested) return;   // cancelTask 负责拍快照 + 结案
    // 异步 spawn 失败（Node 的 ENOENT 走 error 事件，不是同步抛）：pid=0 说明根本没起来，
    // 与 P0「spawn_failed + attempted=false」同一语义 —— 这是唯一可安全重派的 failed。
    if (info && info.spawnError && !info.pid) {
      const row = dispatchLedger.finish(rt.taskId, {
        state: 'failed', outcome: 'failed', stateReason: 'spawn_failed',
        attempted: false, error: '启动失败：' + info.spawnError,
      });
      bcast({ type: 'work-state', state: 'idle' });
      say('没派成：启动执行器失败。');
      settleRuntime(rt, {
        ok: false, taskId: rt.taskId, state: 'failed', outcome: 'failed',
        stateReason: 'spawn_failed', attempted: false,
        error: '启动失败：' + String(info.spawnError || ''),
        verify: row && row.verify ? row.verify : null,
      });
      return;
    }
    if (rt.settled) {
      if (rt.timedOut && rt.verifyCommand && !rt.completing) {
        // 超时但还要跑一次验收：继续往下走
      } else {
        if (rt.disconnected) collectEvidenceOnly(rt).catch(() => {});
        return;
      }
    }
    await completeTask(rt, info);
  }

  /** 断线后仍在跑完的任务：只补证据，不改 unknown 状态（§4.2：verify 仍跑一次）。 */
  async function collectEvidenceOnly(rt) {
    if (rt.completing) return;
    rt.completing = true;
    try {
      const evidence = await collectEvidence(rt, { settle: true });
      let verify = null;
      if (rt.verifyCommand) verify = await runVerifyForTask(rt);
      dispatchLedger.update(rt.taskId, {
        evidence,
        settleMs: evidence.settleMs,
        verify: verify ? {
          command: verify.command, verdict: verify.verdict, exitCode: verify.exitCode,
          output: verify.output, ranAt: verify.ranAt, tookMs: verify.tookMs, why: verify.why,
          rounds: [{ round: 0, verdict: verify.verdict, exitCode: verify.exitCode, output: String(verify.output || '').slice(0, 600), ranAt: verify.ranAt, tookMs: verify.tookMs, why: verify.why }],
        } : undefined,
      }, { strict: false });
      log('[dispatch] 断线任务补证据完成 ' + rt.taskId + '（verify=' + (verify ? verify.verdict : 'none') + '）');
    } finally {
      rt.completing = false;
    }
  }

  /** 等一次返工子进程结束（超时则杀树），返回是否超时。 */
  function waitHandleExit(rt, handle) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        rt.timedOut = true;
        try { handle.killTree(); } catch (e) { /* 已退出 */ }
        resolve(true);
      }, rt.timeoutMs);
      if (timer.unref) timer.unref();
      handle.result.then(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /**
   * 完整结案：settle → 快照 diff → 跑 verify → 仅 fail 且未超轮次时返工，
   * 每轮重跑 verify；broken/timeout 不返工（§4.1）。
   */
  async function completeTask(rt, firstInfo) {
    if (rt.completing) return;
    rt.completing = true;
    try {
      let info = firstInfo;
      let round = 0;
      let verify = null;
      let evidence = null;
      for (;;) {
        evidence = await collectEvidence(rt, { settle: true });
        if (rt.cancelRequested) return;
        verify = rt.verifyCommand
          ? await runVerifyForTask(rt)
          : { command: '', verdict: 'none', exitCode: null, output: '', why: '没有验收命令', ranAt: Date.now(), tookMs: 0 };
        if (rt.cancelRequested) return;
        rt.rounds.push({
          round,
          verdict: verify.verdict,
          exitCode: verify.exitCode,
          output: String(verify.output || '').slice(0, 600),
          ranAt: verify.ranAt,
          tookMs: verify.tookMs,
          why: verify.why,
        });
        const canRework = verify.verdict === 'fail' && round < rt.reworkMax && !rt.timedOut;
        if (!canRework) break;
        round += 1;
        log('[dispatch] 返工第 ' + round + ' 轮 ' + rt.taskId + '（上轮验收失败）');
        let handle = null;
        try {
          handle = startBackend(rt, {
            taskText: buildReworkTask(rt, verify, evidence, round),
            sessionId: '',
            alreadyAttempted: false,
            wireExit: false,
            autoTimeout: false,
          });
        } catch (e) {
          rt.error = '返工启动失败：' + String((e && e.message) || e);
          break;
        }
        const timedOut = await waitHandleExit(rt, handle);
        if (timedOut) log('[dispatch] 返工超时 ' + rt.taskId);
        if (rt.cancelRequested) return;
        info = timedOut ? (rt.lastInfo || info) : (await handle.result);
      }
      finalizeTask(rt, { info, verify, evidence });
    } finally {
      rt.completing = false;
    }
  }

  /** 三态/状态映射 + 账本终态 + 回执。 */
  function finalizeTask(rt, { info, verify, evidence }) {
    const verifyRec = {
      command: rt.verifyCommand || '',
      verdict: verify ? verify.verdict : 'none',
      exitCode: verify ? verify.exitCode : null,
      output: verify ? verify.output : '',
      ranAt: verify ? verify.ranAt : null,
      tookMs: verify ? verify.tookMs : null,
      why: verify ? verify.why : '',
      rounds: rt.rounds.slice(0, 5),
    };
    let state;
    let outcome;
    let stateReason = null;
    const infoOk = !!(info && info.ok === true);
    if (rt.timedOut && verifyRec.verdict !== 'pass') {
      state = 'unknown'; outcome = null; stateReason = 'timeout';
    } else if (verifyRec.verdict === 'pass') {
      state = 'done'; outcome = 'done_verified';
    } else if (verifyRec.verdict === 'fail') {
      state = 'failed'; outcome = 'failed'; stateReason = 'verify_failed';
    } else if (verifyRec.verdict === 'broken' || verifyRec.verdict === 'timeout') {
      state = 'done'; outcome = 'done_unproven';
    } else {
      const cls = classifyOutcomeSafe({
        ok: infoOk,
        verified: !!(info && info.verified === true),
        evidence: info && (info.evidence || info.evidenceText),
        task: rt.text,
        changed: evidence ? evidence.changed : undefined,
      });
      outcome = cls.outcome;
      state = cls.outcome === 'failed' ? 'failed' : 'done';
      if (state === 'failed') stateReason = 'exit_failed';
    }

    if (state === 'unknown') {
      const r = dispatchLedger.markUnknown(rt.taskId, stateReason || 'timeout', {
        error: (info && info.error) || '执行超时，结果未知',
        verify: verifyRec,
        evidence,
        settleMs: evidence ? evidence.settleMs : null,
        text: info ? info.text : undefined,
        tools: info ? info.tools : undefined,
        sessionId: info ? info.sessionId : undefined,
      });
      bcast({ type: 'work-state', state: 'idle' });
      say('后台任务超时了，结果未知，先别重复派。');
      settleRuntime(rt, {
        ok: false, taskId: rt.taskId, state: 'unknown', outcome: null,
        stateReason: r ? r.stateReason : (stateReason || 'timeout'),
        attempted: r ? r.attempted === true : true,
        verify: verifyRec, evidence: evidence || null,
        error: '执行超时，结果未知；不要重复派同一任务',
      });
      return;
    }

    const finalRow = dispatchLedger.finish(rt.taskId, {
      state,
      outcome,
      stateReason,
      text: info ? info.text : '',
      error: info
        ? (info.error || (verifyRec.verdict === 'fail' ? ('验收未通过：' + String(verifyRec.output || verifyRec.why || '').slice(0, 200)) : ''))
        : (rt.error || ''),
      tools: info ? info.tools : [],
      sessionId: info ? info.sessionId : null,
      tookMs: info ? info.tookMs : null,
      settleMs: evidence ? evidence.settleMs : null,
      verify: verifyRec,
      evidence,
    }) || {};

    const ok = outcome !== 'failed';
    let summary;
    if (verifyRec.verdict === 'pass' || verifyRec.verdict === 'fail') {
      summary = verifyRec.verdict === 'pass'
        ? ('小D干完了，验收通过。' + String((info && info.text) || '').trim().slice(0, 120))
        : ('没办成：验收命令没过。' + String(verifyRec.output || '').trim().slice(0, 120));
    } else if (verifyRec.verdict === 'broken' || verifyRec.verdict === 'timeout') {
      summary = '小D干完了，但验收命令没法正常执行，结果没法判定。';
    } else if (ok) {
      summary = '小D回话了：' + (String((info && info.text) || '').trim().slice(0, 160) || '办完了');
    } else {
      summary = '没办成：' + String((info && info.error) || '未知原因').slice(0, 120);
    }
    bcast({ type: 'work-state', state: ok ? 'done' : 'idle' });
    say(summary);
    settleRuntime(rt, {
      ok,
      taskId: rt.taskId,
      state,
      outcome,
      stateReason: stateReason || null,
      attempted: true,
      text: finalRow.text || '',
      error: finalRow.error || '',
      tookMs: finalRow.tookMs || null,
      tools: finalRow.tools || [],
      sessionId: finalRow.sessionId || '',
      verify: verifyRec,
      evidence: evidence || null,
    });
  }

  /**
   * POST /dispatch/cancel（§4.5）：
   *   · 只有本进程持有句柄才杀；重启后没有句柄 → cannot_cancel + unknown（不猜 pid）；
   *   · 重复取消幂等：已 cancelled 直接返回 cancelled；
   *   · 取消后立刻快照 → partialWrites（已写文件清单，不回滚）。
   * @returns {Promise<{status:number, body:object}>}
   */
  async function cancelDispatchTask(taskId, { graceMs = null } = {}) {
    const id = normalizeTaskId(taskId);
    if (!dispatchLedger) {
      return { status: 400, body: { ok: false, error: 'ledger_disabled', taskId: id, detail: 'ledger_v2=false 时没有账本，也没有 runner 句柄' } };
    }
    if (!String(taskId == null ? '' : taskId).trim()) {
      return { status: 400, body: { ok: false, error: 'missing_task_id' } };
    }
    if (dispatchSettings.cancel === false) {
      return { status: 400, body: { ok: false, error: 'cancel_disabled', taskId: id } };
    }
    const row = dispatchLedger.getDetail(id);
    if (!row) return { status: 404, body: { ok: false, error: 'not_found', taskId: id } };
    if (row.state === 'cancelled') {
      return {
        status: 200,
        body: {
          ok: true, already: true, taskId: id, state: 'cancelled', outcome: null,
          stateReason: 'cancelled', cancelledAt: row.cancelledAt || null,
          partialWrites: Array.isArray(row.partialWrites) ? row.partialWrites : [],
          message: CANCEL_MESSAGE,
        },
      };
    }
    if (row.state === 'done' || row.state === 'failed') {
      return { status: 200, body: { ok: false, error: 'already_finished', taskId: id, state: row.state, outcome: row.outcome } };
    }
    if (row.state === 'unknown') {
      return {
        status: 200,
        body: {
          ok: false, error: 'cannot_cancel', taskId: id, state: 'unknown',
          stateReason: row.stateReason || null,
          detail: '任务已经不在运行（unknown），没有可取消的进程',
        },
      };
    }
    const rt = dispatchRuntime.get(id);
    const handle = (rt && rt.handle) || (dispatchRunner ? dispatchRunner.get(id) : null);
    if (!handle) {
      // 重启后账本有记录但进程内没有句柄：绝不按账本里的 pid 猜（pid 会复用 → 杀错人）。
      dispatchLedger.markUnknown(id, 'restart', { error: '主进程里没有子进程句柄，无法安全取消' });
      return {
        status: 200,
        body: {
          ok: false, error: 'cannot_cancel', taskId: id, state: 'unknown', stateReason: 'restart',
          detail: '没有子进程句柄（进程可能重启过）；不猜 pid，请去任务管理器/原会话核对',
        },
      };
    }
    if (rt) {
      rt.cancelRequested = true;
      if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; }
    }
    dispatchLedger.update(id, { state: 'cancelling', cancelRequestedAt: Date.now() }, { strict: false });
    const limit = Math.max(300, Math.min(10000, Number(graceMs) || dispatchSettings.cancelGraceMs));
    const killed = await handle.cancel({ graceMs: limit });
    if (!killed || killed.ok !== true) {
      // 杀不掉就退回去：running 是可重试的（不能假装停成功）
      if (rt) rt.cancelRequested = false;
      dispatchLedger.update(id, { state: 'running', cancelRequestedAt: null }, { strict: false });
      return {
        status: 200,
        body: {
          ok: false, error: 'cancel_failed', taskId: id, state: 'running',
          detail: '进程树在宽限期内没有消失（' + limit + 'ms），任务可能还在写盘',
        },
      };
    }
    // 取消后立即拍快照：只差 baseline → after，拿「已经写下的文件」（不回滚）。
    let evidence = null;
    let partialWrites = [];
    try {
      evidence = await collectEvidence(rt || { ws: null, baseline: null }, { settle: false });
      // 2026-11-23：只算「任务开始后写下的修改」；created 基线不存在，必然属于本任务。
      partialWrites = [...(evidence.created || []), ...(evidence.modifiedSinceTask || [])].slice(0, 200);
    } catch (e) {
      evidence = { created: [], modified: [], modifiedSinceTask: [], deleted: [], changed: false, unavailableReason: 'snapshot_failed' };
    }
    const finished = dispatchLedger.finish(id, {
      state: 'cancelled',
      outcome: null,
      stateReason: 'cancelled',
      cancelledAt: Date.now(),
      partialWrites,
      evidence,
      settleMs: 0,
    }) || {};
    if (rt) {
      settleRuntime(rt, {
        ok: false, taskId: id, state: 'cancelled', outcome: null,
        stateReason: 'cancelled', attempted: true,
        partialWrites, message: CANCEL_MESSAGE,
      });
    }
    bcast({ type: 'work-state', state: 'idle' });
    say('好，停下来了。已经写下的文件不会回滚。');
    log('[dispatch] 已取消 ' + id + ' pid=' + (killed.pid || '?') + ' tookMs=' + (killed.tookMs || 0)
      + ' partialWrites=' + partialWrites.length);
    return {
      status: 200,
      body: {
        ok: true, taskId: id, state: 'cancelled', outcome: null, stateReason: 'cancelled',
        attempted: true, cancelTookMs: killed.tookMs || 0,
        partialWrites: finished.partialWrites || partialWrites,
        cancelledAt: finished.cancelledAt || Date.now(),
        message: CANCEL_MESSAGE,
      },
    };
  }

  /**
   * 派活：把任务交给 DSH 的 headless profile 跑，跑完用 say() 汇报。
   *
   * P0 账本语义（设计 §3.3/§4.2）：
   *   · requestId 24h 幂等：命中旧记录 → {reused:true}，不再 spawn（同 requestId 永不重派）；
   *     唯一例外是「spawn 同步失败」的 failed + attempted=false，允许重试一次。
   *   · attempted=true 必须在 spawn **之前**落盘；写盘失败 → 拒派（不可追溯就不执行）。
   *   · 超时 / HTTP 断线 → state=unknown, outcome=null, attempted=true（绝不说 failed）。
   * P1（§4.1/§4.4/§4.5）：
   *   · workspace 只接受别名 → realpath（失败 400，attempted=false 不消耗）；
   *   · verify 四态 + 只对 fail 返工；取消由 cancelDispatchTask 负责。
   */
  function dispatchTask(task, options = {}) {
    const text = String(task || '').trim();
    if (!text) return Promise.resolve({ ok: false, error: 'empty task' });
    const timeoutMs = Math.min(Number(options.timeoutMs) || 600000, 1800000);
    const sessionId = options.sessionId || '';
    const spawnFn = typeof options.spawnFn === 'function'
      ? options.spawnFn
      : (typeof dispatchSpawn === 'function' ? dispatchSpawn : spawn);
    const wantVerify = String(options.verify == null ? '' : options.verify).trim();
    const wantWorkspace = String(options.workspace == null ? '' : options.workspace).trim();
    const wantedRework = Number(options.rework);

    // ledger_v2=false：完全回旧行为；P1 的 verify/workspace 明确不可用（不静默忽略）。
    if (!dispatchLedger) {
      if (wantVerify || wantWorkspace) {
        return Promise.resolve({
          ok: false, error: 'ledger_disabled', attempted: false,
          detail: 'verify/workspace 依赖派活账本（config.dispatch.ledger_v2=false 时不可用）',
        });
      }
      return legacyDispatchTask(text, { cwd: options.cwd || process.cwd(), sessionId, timeoutMs, spawnFn });
    }

    if (wantVerify && dispatchSettings.verify === false) {
      return Promise.resolve({ ok: false, error: 'verify_disabled', attempted: false, detail: 'config.dispatch.verify=false' });
    }
    if (wantWorkspace && dispatchSettings.workspace === false) {
      return Promise.resolve({ ok: false, error: 'workspace_disabled', attempted: false, detail: 'config.dispatch.workspace=false' });
    }

    // ── workspace：别名 → realpath（只认配置里的别名，绝不接受任意 cwd）─────────
    let ws = null;
    if (wantWorkspace) {
      ws = resolveWorkspace(wantWorkspace, dispatchSettings);
      if (!ws.ok) {
        return Promise.resolve({
          ok: false, error: ws.error, attempted: false, workspace: wantWorkspace,
          detail: ws.detail || '', reason: ws.reason || null,
        });
      }
    } else if (dispatchSettings.defaultWorkspace) {
      const def = resolveWorkspace(null, dispatchSettings);
      if (def.ok) ws = def;
      else log('[dispatch] defaultWorkspace 不可用（退回进程 cwd）: ' + (def.detail || def.error));
    }
    const cwd = ws ? ws.realpath : (options.cwd || process.cwd());
    const reworkMax = Math.max(0, Math.min(3,
      Number.isFinite(wantedRework) ? wantedRework : (Number(dispatchSettings.reworkMax) || 0)));
    const verifyTimeoutMs = Math.max(5000, Math.min(600000,
      Number.isFinite(Number(options.verifyTimeoutMs)) ? Number(options.verifyTimeoutMs) : dispatchSettings.verifyTimeoutMs));

    // ── 幂等：同 requestId 复用旧记录（24h 内；任务/工作区/验收任一不同 → 409）──
    const requestId = options.requestId != null && String(options.requestId).trim()
      ? String(options.requestId).trim().slice(0, 120)
      : null;
    if (requestId) {
      const prev = dispatchLedger.findByRequestId(requestId);
      if (prev) {
        const sameShape = prev.taskText === text
          && String(prev.workspaceAlias || '') === String(ws ? ws.alias : '')
          && String(prev.verifyCommand || '') === wantVerify;
        if (!sameShape) {
          return Promise.resolve({
            ok: false, error: 'request_id_conflict', requestId,
            taskId: prev.taskId, state: prev.state, outcome: prev.outcome,
          });
        }
        const retryable = prev.state === 'failed' && prev.attempted !== true;
        if (!retryable) {
          return Promise.resolve({
            ok: true, reused: true, taskId: prev.taskId,
            state: prev.state, outcome: prev.outcome, stateReason: prev.stateReason,
            attempted: prev.attempted === true, tookMs: prev.tookMs,
            taskPreview: makeTaskPreview(prev.taskPreview || prev.taskText),
            note: prev.state === 'unknown'
              ? '结果未知：同一 requestId 不会重派（请先核对实际结果）'
              : '同一 requestId 复用旧记录，没有第二次执行',
          });
        }
      }
    }

    // ── 建记录（taskId 冲突但 requestId 不同 → 拒绝，绝不覆盖别人）────────
    const taskId = normalizeTaskId(options.taskId);
    const sameId = dispatchLedger.get(taskId);
    if (sameId && String(sameId.requestId || '') !== String(requestId || '')) {
      return Promise.resolve({ ok: false, error: 'task_id_conflict', taskId });
    }
    let row;
    try {
      row = dispatchLedger.create({
        taskId, requestId, taskText: text, origin: options.origin || 'http',
        workspaceAlias: ws ? ws.alias : null,
        workspaceRoot: ws ? ws.root : null,
        workspaceRealpath: ws ? ws.realpath : null,
        verifyCommand: wantVerify || null,
        reworkMax,
      });
    } catch (e) {
      return Promise.resolve({ ok: false, error: 'ledger_write_failed', detail: String((e && e.message) || e) });
    }

    // ── attempted=true 先落盘（strict）：写不进去就不 spawn ────────────────
    const startedAt = Date.now();
    try {
      dispatchLedger.markAttempted(taskId, { startedAt, childStartedAt: startedAt });
    } catch (e) {
      dispatchLedger.finish(taskId, {
        state: 'failed', outcome: 'failed', stateReason: 'ledger_write_failed',
        attempted: false, error: '账本写入失败，已拒绝派发',
      });
      return Promise.resolve({
        ok: false, taskId, state: 'failed', outcome: 'failed',
        stateReason: 'ledger_write_failed', attempted: false,
        error: '账本写入失败，已拒绝派发（不可追溯就不执行）',
      });
    }

    // 基线快照（取消 partialWrites / 验收证据都靠它）；无 workspace 时如实不可用。
    // 时间预算 300ms：同步遍历会卡主进程（皮套动画），宁可标 truncated 也不冻屏。
    const baseline = ws ? snapshotWorkdir(ws.realpath, { maxMs: 300 }) : null;

    bcast({ type: 'work-state', state: 'thinking' });
    say('收到，我让小D去办：' + text.slice(0, 40) + (text.length > 40 ? '…' : ''));

    return new Promise((resolve) => {
      const rt = {
        taskId, text, cwd, ws, sessionId, timeoutMs, reworkMax, verifyTimeoutMs,
        verifyCommand: wantVerify, baseline, handle: null, timer: null,
        // startedAt：取消回执的 partialWrites 时间窗（mtime ≥ startedAt-2000ms）。
        startedAt,
        settled: false, timedOut: false, disconnected: false, cancelRequested: false,
        completing: false, rounds: [], lastInfo: null, error: '', resolve,
      };
      dispatchRuntime.set(taskId, rt);
      try {
        startBackend(rt, { taskText: text, sessionId, alreadyAttempted: true });
      } catch (e) {
        // spawn 同步失败：什么都没跑起来 → 唯一可安全重派的 failed（attempted=false）
        const msg = String((e && e.message) || e);
        dispatchLedger.finish(taskId, {
          state: 'failed', outcome: 'failed', stateReason: 'spawn_failed',
          attempted: false, error: '启动失败：' + msg,
        });
        dispatchRuntime.delete(taskId);
        bcast({ type: 'work-state', state: 'idle' });
        say('没派成：启动执行器失败。');
        return settleRuntime(rt, {
          ok: false, taskId, state: 'failed', outcome: 'failed',
          stateReason: 'spawn_failed', attempted: false, error: '启动失败：' + msg,
        });
      }

      // HTTP 断线（响应还没写完连接就没了）：子进程可能还在跑 → unknown/disconnect。
      // P1 不主动杀：用户没让停；只保证「不会产生第二次执行」，退出后补一次证据。
      const onClientGone = () => {
        if (rt.settled || rt.cancelRequested) return;
        rt.disconnected = true;
        const r = dispatchLedger.markUnknown(taskId, 'disconnect', { error: '请求方断开，结果未知' });
        bcast({ type: 'work-state', state: 'idle' });
        settleRuntime(rt, {
          ok: false, taskId, state: 'unknown', outcome: null,
          stateReason: 'disconnect', attempted: r ? r.attempted === true : true,
          error: '请求方断开，结果未知；不要重复派同一任务',
        });
      };
      if (options.signal && typeof options.signal.addEventListener === 'function') {
        if (options.signal.aborted) onClientGone();
        else options.signal.addEventListener('abort', onClientGone, { once: true });
      }
    });
  }

  // ── 续聊（followup · 2026-11-23）─────────────────────────────────────────
  // 父任务已终态且账本里有 sessionId 时，允许用同一 DSH 会话接着做一件事：
  //   POST /dispatch/followup {taskId, task}
  // 子任务独立账本行（parentId 指向父任务），独立 attempted/verify/outcome。
  //
  // 会话复用实测（2026-11-23，DSH 0.2.2-rc.1）：
  //   · `--profile headless --help` 明确列出 `--session-id <id>`（未知 id 直接报错）；
  //   · `--json` 的首个事件是 session，带本次使用的 sessionId 与 cwd；
  //   · 采纳要求同一 cwd（记录目录不一致会被拒）——所以这里必须沿用父任务的工作区。
  // 失配（回传 session ≠ 请求）或采纳失败（进程直接退出、没有 session 事件）时，
  // 回退「新会话 + 父任务摘要 + 改动文件清单」重跑，并如实标 sessionMismatch/sessionReused。

  const FOLLOWUP_SUMMARY_MAX = 1200;

  /** 父任务摘要（≤1200 字）+ 这次要做的事；原会话没接上时的回退提示词。 */
  function buildFollowupFallbackTask(parent, task) {
    const text = String(task == null ? '' : task).trim();
    const parentText = String((parent && parent.taskText) || '').slice(0, 600);
    const result = parent && parent.text
      ? String(parent.text).slice(0, 1200)
      : (parent && parent.state === 'failed'
        ? '（父任务失败）' + String(parent.error || '').slice(0, 600)
        : '（没有结果正文）');
    const files = [...((parent && parent.evidence && parent.evidence.created) || []),
      ...((parent && parent.evidence && parent.evidence.modified) || [])].slice(0, 20);
    const summary = [
      '续聊上下文（原会话没接上，下面这些是之前那次任务的信息，供你接续；不要重复已完成的部分）：',
      '【原任务】' + parentText,
      '【上次结果】' + result,
      '【上次改动文件】' + (files.length ? files.join('；') : '（没有记录到改动）'),
    ].join('\n');
    return summary.slice(0, FOLLOWUP_SUMMARY_MAX) + '\n【这次要做】' + text;
  }

  /**
   * 续聊：父任务终态 + 有 sessionId 才允许。
   * @returns {Promise<{status:number, body:object}>}
   */
  async function followupDispatchTask(parentTaskId, task, options = {}) {
    const rawId = String(parentTaskId == null ? '' : parentTaskId).trim();
    if (!rawId) return { status: 400, body: { ok: false, error: 'missing_task_id' } };
    const text = String(task == null ? '' : task).trim();
    if (!text) return { status: 400, body: { ok: false, error: 'empty task', parentId: rawId.slice(0, 80) } };
    if (!dispatchLedger) {
      return {
        status: 400,
        body: { ok: false, error: 'ledger_disabled', detail: '续聊依赖派活账本（config.dispatch.ledger_v2=false 时不可用）' },
      };
    }
    const parentId = normalizeTaskId(rawId);
    const parent = dispatchLedger.getDetail(parentId);
    if (!parent) return { status: 404, body: { ok: false, error: 'not_found', taskId: parentId } };
    if (!isTerminalState(parent.state)) {
      return {
        status: 409,
        body: {
          ok: false, error: 'parent_not_terminal', parentId, state: parent.state,
          stateReason: parent.stateReason || null,
          detail: '父任务还在跑或结果未知；等它结束（done/failed/cancelled）再续聊',
        },
      };
    }
    const requestedSessionId = String(parent.sessionId || '').trim();
    if (!requestedSessionId) {
      return {
        status: 409,
        body: {
          ok: false, error: 'no_parent_session', parentId, state: parent.state,
          detail: '父任务没有可复用的会话 id（启动失败/后端没回传 session）',
        },
      };
    }
    // 会话采纳要求同一 cwd：父任务用的工作区别名必须还能解析成同一份目录。
    let ws = null;
    if (parent.workspaceAlias) {
      ws = resolveWorkspace(parent.workspaceAlias, dispatchSettings);
      if (!ws.ok) {
        return {
          status: 400,
          body: {
            ok: false, error: ws.error, attempted: false, parentId, workspace: parent.workspaceAlias,
            detail: '父任务的工作区已不可用，不能安全地续聊（' + String(ws.detail || '') + '）',
          },
        };
      }
    }
    const cwd = ws ? ws.realpath : (parent.workspaceRealpath || process.cwd());
    const inheritedVerify = (dispatchSettings.verify !== false && parent.verifyCommand)
      ? String(parent.verifyCommand) : '';
    const reworkMax = Math.max(0, Math.min(3,
      Number.isFinite(Number(parent.reworkMax)) ? Number(parent.reworkMax) : (Number(dispatchSettings.reworkMax) || 0)));
    const timeoutMs = Math.min(Number(options.timeoutMs) || 600000, 1800000);
    const verifyTimeoutMs = Math.max(5000, Math.min(600000, Number(dispatchSettings.verifyTimeoutMs) || 60000));

    const childTaskId = normalizeTaskId(options.taskId);
    if (dispatchLedger.get(childTaskId)) {
      return { status: 409, body: { ok: false, error: 'task_id_conflict', taskId: childTaskId, parentId } };
    }
    try {
      dispatchLedger.create({
        taskId: childTaskId, taskText: text, origin: options.origin || 'followup', parentId,
        workspaceAlias: ws ? ws.alias : null,
        workspaceRoot: ws ? ws.root : null,
        workspaceRealpath: ws ? ws.realpath : null,
        verifyCommand: inheritedVerify || null,
        reworkMax,
      });
    } catch (e) {
      return { status: 500, body: { ok: false, error: 'ledger_write_failed', detail: String((e && e.message) || e) } };
    }
    const startedAt = Date.now();
    try {
      dispatchLedger.markAttempted(childTaskId, { startedAt, childStartedAt: startedAt });
    } catch (e) {
      dispatchLedger.finish(childTaskId, {
        state: 'failed', outcome: 'failed', stateReason: 'ledger_write_failed',
        attempted: false, error: '账本写入失败，已拒绝派发',
      });
      return {
        status: 500,
        body: {
          ok: false, taskId: childTaskId, state: 'failed', outcome: 'failed',
          stateReason: 'ledger_write_failed', attempted: false,
          error: '账本写入失败，已拒绝派发（不可追溯就不执行）',
        },
      };
    }
    const baseline = ws ? snapshotWorkdir(ws.realpath, { maxMs: 300 }) : null;
    bcast({ type: 'work-state', state: 'thinking' });
    say('收到，接着上次的会话办：' + text.slice(0, 40) + (text.length > 40 ? '…' : ''));

    const followupFlags = { sessionReused: false, sessionMismatch: false, observedSessionId: '', fallback: false };
    const base = await new Promise((resolve) => {
      const rt = {
        taskId: childTaskId, text, cwd, ws, sessionId: requestedSessionId,
        timeoutMs, reworkMax, verifyTimeoutMs, verifyCommand: inheritedVerify, baseline,
        handle: null, timer: null, startedAt,
        settled: false, timedOut: false, disconnected: false, cancelRequested: false,
        completing: false, rounds: [], lastInfo: null, error: '', resolve,
        followup: true, parentId,
        sessionReused: false, sessionMismatch: false, observedSessionId: '',
      };
      dispatchRuntime.set(childTaskId, rt);
      const requested = requestedSessionId;
      const captureSession = (ev) => {
        try {
          if (ev && ev.kind === 'session') rt.observedSessionId = String(ev.value.sessionId || '');
        } catch (e) { /* 观测失败不影响执行 */ }
      };
      const failBeforeStart = (msg) => {
        dispatchLedger.finish(childTaskId, {
          state: 'failed', outcome: 'failed', stateReason: 'spawn_failed', attempted: false,
          error: '启动失败：' + msg,
        });
        bcast({ type: 'work-state', state: 'idle' });
        say('没派成：启动执行器失败。');
        settleRuntime(rt, {
          ok: false, taskId: childTaskId, state: 'failed', outcome: 'failed',
          stateReason: 'spawn_failed', attempted: false, error: '启动失败：' + msg,
        });
      };
      try {
        startBackend(rt, {
          taskText: text, sessionId: requested,
          alreadyAttempted: true, wireExit: false, autoTimeout: true, onEvent: captureSession,
        });
      } catch (e) {
        failBeforeStart(String((e && e.message) || e));
        return;
      }
      // 客户端断线：子进程可能仍在跑 → unknown/disconnect；不主动杀，退出后补证据。
      const onClientGone = () => {
        if (rt.settled || rt.cancelRequested) return;
        rt.disconnected = true;
        dispatchLedger.markUnknown(childTaskId, 'disconnect', { error: '请求方断开，结果未知' });
        bcast({ type: 'work-state', state: 'idle' });
        settleRuntime(rt, {
          ok: false, taskId: childTaskId, state: 'unknown', outcome: null,
          stateReason: 'disconnect', attempted: true,
          error: '请求方断开，结果未知；不要重复派同一任务',
        });
      };
      if (options.signal && typeof options.signal.addEventListener === 'function') {
        if (options.signal.aborted) onClientGone();
        else options.signal.addEventListener('abort', onClientGone, { once: true });
      }

      const current = rt.handle;
      current.result.then(async (info) => {
        rt.lastInfo = info;
        if (rt.disconnected) { collectEvidenceOnly(rt).catch(() => {}); return; }
        if (rt.settled || rt.cancelRequested || rt.timedOut) return;
        const observed = String((info && info.sessionId) || rt.observedSessionId || '');
        const reused = !!(observed && observed === requested);
        const mismatch = !!(observed && observed !== requested);
        rt.sessionReused = reused;
        rt.sessionMismatch = mismatch;
        followupFlags.sessionReused = reused;
        followupFlags.sessionMismatch = mismatch;
        followupFlags.observedSessionId = observed;
        if (reused) {
          dispatchLedger.update(childTaskId, {
            sessionReused: true, sessionMismatch: false, sessionId: observed,
          }, { strict: false });
          await completeTask(rt, info);
          return;
        }
        if (!mismatch && info && info.ok === true) {
          // 成功但没回传 session（DSH 漂移/替身）：不重跑，避免双执行；如实标「未证实复用」。
          dispatchLedger.update(childTaskId, { sessionReused: false, sessionMismatch: false }, { strict: false });
          await completeTask(rt, info);
          return;
        }
        // 失配或采纳失败（进程直接退出）→ 新会话 + 父任务摘要重跑一次。
        dispatchLedger.update(childTaskId, { sessionReused: false, sessionMismatch: mismatch }, { strict: false });
        followupFlags.fallback = true;
        log('[dispatch] 续聊没接上原会话 ' + childTaskId + '（'
          + (mismatch ? 'session 不一致：' + observed.slice(0, 80) : '采纳失败：' + String((info && info.error) || '').slice(0, 120))
          + '）→ 回退新会话 + 父任务摘要');
        bcast({ type: 'work-state', state: 'thinking' });
        const fallbackText = buildFollowupFallbackTask(parent, text);
        let h2 = null;
        try {
          h2 = startBackend(rt, {
            taskText: fallbackText, sessionId: '',
            alreadyAttempted: false, wireExit: false, autoTimeout: true, onEvent: null,
          });
        } catch (e) {
          const msg = String((e && e.message) || e);
          rt.error = '回退启动失败：' + msg;
          dispatchLedger.finish(childTaskId, {
            state: 'failed', outcome: 'failed', stateReason: 'spawn_failed', attempted: false,
            error: rt.error,
          });
          bcast({ type: 'work-state', state: 'idle' });
          say('没办成：回退新会话也启动失败。');
          settleRuntime(rt, {
            ok: false, taskId: childTaskId, state: 'failed', outcome: 'failed',
            stateReason: 'spawn_failed', attempted: false, error: rt.error,
            parentId, sessionReused: false, sessionMismatch: mismatch,
          });
          return;
        }
        let info2;
        try { info2 = await h2.result; } catch (e) { info2 = { ok: false, error: String((e && e.message) || e), pid: h2.pid }; }
        rt.lastInfo = info2;
        if (rt.disconnected) { collectEvidenceOnly(rt).catch(() => {}); return; }
        if (rt.settled || rt.cancelRequested || rt.timedOut) return;
        await completeTask(rt, info2);
      }).catch((e) => {
        if (rt.settled) return;
        const r = dispatchLedger.markUnknown(childTaskId, 'disconnect', {
          error: '收口异常：' + String((e && e.message) || e),
        });
        settleRuntime(rt, {
          ok: false, taskId: childTaskId, state: 'unknown', outcome: null,
          stateReason: 'disconnect', attempted: r ? r.attempted === true : true,
          error: '收口异常，结果未知',
        });
      });
    });

    // 回执补上续聊语义（finalizeTask 只管通用终态，不写这几个字段）。
    const payload = Object.assign({}, base, {
      followup: true,
      parentId,
      sessionReused: followupFlags.sessionReused === true,
      sessionMismatch: followupFlags.sessionMismatch === true,
      fallback: followupFlags.fallback === true,
    });
    if (base && base.state === 'unknown') {
      payload.note = '结果未知；不要重复派同一任务';
    } else if (followupFlags.fallback === true) {
      payload.note = '没接上原会话：已用新会话 + 父任务摘要重跑';
    } else if (payload.sessionReused === true) {
      payload.note = '已接上原会话';
    } else if (base && base.state === 'cancelled') {
      payload.note = CANCEL_MESSAGE;
    } else if (base && base.state === 'failed' && base.attempted === false) {
      payload.note = '启动失败，任务没有执行：' + String(base.error || '');
    } else {
      payload.note = '已继续执行，但没能确认接上原会话（没收到 session 回传）';
    }
    return { status: 200, body: payload };
  }

  // 窗口侧输入：鼠标位置（归一化到窗口中心）与全屏状态，供舞台层做眼神跟随/淡出。
  function sendPointer(payload) { state.lastPointer = payload ? { x: payload.x, y: payload.y } : null; bcast({ type: 'pointer', x: payload ? payload.x : null, y: payload ? payload.y : null }); }
  function sendFullscreen(on) { state.lastFullscreen = !!on; bcast({ type: 'fullscreen', on: !!on }); }

  function say(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    state.lastSay = clean;
    bcast({ type: 'say', text: clean });
  }

  function playAction(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    bcast({ type: 'action', name: clean });
  }

  // ---------- 对外：VTS 兼容 ----------
  const vts = new WebSocketServer({ host: '127.0.0.1', port });
  vts.on('connection', (ws) => {
    state.clients += 1;
    const authed = { value: false };
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      const reply = (data) => {
        try {
          ws.send(JSON.stringify({
            apiName: API_NAME, apiVersion: API_VERSION, requestID: msg.requestID,
            messageType: (msg.messageType || '').replace('Request', 'Response'), data,
          }));
        } catch {}
      };
      switch (msg.messageType) {
        case 'APIStateRequest':
          return reply({ active: true, vTubeStudioVersion: VTS_VERSION, currentSessionAuthenticated: authed.value });
        case 'AuthenticationTokenRequest':
          return reply({ authenticationToken: 'pet-runtime-token' });
        case 'AuthenticationRequest':
          authed.value = true;
          return reply({ authenticated: true, reason: 'OK', authenticationToken: msg.data?.authenticationToken || 'pet-runtime-token' });
        case 'CurrentModelRequest': {
          const m = currentModel();
          return reply({
            modelLoaded: true,
            modelName: m.name, modelID: m.id,
            modelWasVTSModel: true, modelVTSModelName: m.name,
            modelVTSModelIconName: m.icon || '',
            live2DModelParameters: m.parameters, modelParameters: m.parameters,
            modelCustomParameters: [],
            modelExpressions: (m.expressions || []).map((e) => ({ name: e.name, file: e.file, active: state.expressions.has(e.name) })),
            modelHotkeys: (m.hotkeys || []).map((h) => ({ name: h.name, type: h.type || 'TriggerExpression', file: h.file || '', hotkeyID: h.id, action: h.action || '' })),
            modelMacAddresses: [], modelArtMeshList: [],
          });
        }
        case 'AvailableModelsRequest': {
          const m = currentModel();
          return reply({ availableModels: [{ modelLoaded: true, modelName: m.name, modelID: m.id, vtsModelName: m.name, modelIconFileName: '' }] });
        }
        case 'ModelLoadRequest': {
          const m = currentModel();
          setTimeout(() => emitEvent('ModelLoadedEvent', { modelLoaded: true, modelName: m.name, modelID: m.id }), 60);
          return reply({ modelLoaded: true, modelName: m.name, modelID: m.id });
        }
        case 'InjectParameterDataRequest': {
          const list = Array.isArray(msg.data?.parameterValues) ? msg.data.parameterValues : [];
          const mode = msg.data?.mode === 'add' ? 'add' : 'set';
          const values = {};
          for (const item of list) {
            if (!item || typeof item.id !== 'string') continue;
            const prev = state.params.get(item.id) ?? 0;
            const next = mode === 'add' ? prev + Number(item.value || 0) : Number(item.value || 0);
            state.params.set(item.id, next);
            values[item.id] = next;
          }
          if (Object.keys(values).length) queueParams(values);
          return reply({});
        }
        case 'ExpressionActivationRequest': {
          activateExpression(String(msg.data?.expression ?? ''), msg.data?.active !== false);
          return reply({});
        }
        case 'HotkeyTriggerRequest': {
          const id = String(msg.data?.hotkeyID ?? '');
          const byName = String(msg.data?.hotkeyName ?? '');
          const list = (currentModel().hotkeys) || [];
          const hit = list.find((h) => h.id === id) || list.find((h) => h.name === byName || h.name === id);
          if (!hit) return reply({ errorID: 800, errorMessage: 'hotkey not found' });
          triggerHotkey(hit);
          return reply({});
        }
        case 'EventSubscriptionRequest': {
          const name = String(msg.data?.eventName ?? '');
          const cfg = msg.data?.config;
          if (cfg && cfg.subscribe) state.subscribers.add(name || '*');
          else if (name) state.subscribers.add(name);
          return reply({ subscribedEventCount: state.subscribers.size });
        }
        case 'StatisticsRequest':
          return reply({ uptime: Math.round(process.uptime() * 1000), framerate: 30, allowedPlugins: state.clients, connectedPlugins: state.clients, startedWithSteam: false });
        default:
          return reply({ errorID: 999, errorMessage: 'unsupported messageType ' + msg.messageType });
      }
    });
    ws.on('close', () => { state.clients = Math.max(0, state.clients - 1); });
    ws.on('error', () => {});
  });

  // ---------- 对内：渲染进程 ----------
  const inner = new WebSocketServer({ host: '127.0.0.1', port: internalPort });
  inner.on('connection', (ws) => {
    renderers.add(ws);
    // 存活记账：连上就记一笔（断开那一刻也记，见 close），主进程看门狗只认这两个数。
    state.innerClients = renderers.size;
    state.lastInnerAt = Date.now();
    // 渲染层回传真实资产状态（含 cycle 档位），否则 /state 只能看到布尔值。
    ws.on('message', (raw) => {
      // 任何一条消息都算「渲染层还活着」：render-health 5s 一采，绝不该久无音信。
      state.lastInnerAt = Date.now();
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg && msg.type === 'emotion') {
        // 渲染层回传情绪快照，GET /emotion 直接读这个（控制面板自查用）。
        state.lastEmotion = msg.emotion || null;
        state.lastEmotionAt = Date.now();
        return;
      }
      if (msg && msg.type === 'asset-applied') {
        state.assetStates = msg.states || state.assetStates;
        // ⚠ 原来这里是 `for (const key of Object.keys(state.assets))`：只给**已有**的
        // key 回填，而 state.assets 初始是 {}，所以第一次永远空转 —— 布尔字典恒空，
        // 只有人手动 POST /asset 才会冒出 key。改成从 states 直接建字典（2026-11-13）。
        if (Array.isArray(state.assetStates)) {
          for (const item of state.assetStates) {
            if (item && item.id) state.assets[item.id] = !!item.on;
          }
        } else {
          for (const key of Object.keys(state.assets)) {
            const item = Array.isArray(state.assetStates) ? state.assetStates.find((a) => a && a.id === key) : null;
            if (item) state.assets[key] = !!item.on;
          }
        }
        return;
      }
      if (msg && msg.type === 'render-health') {
        // 渲染健康哨兵（2026-11-13）：渲染器的三条诊断（抢写/白写/让位）原来只进
        // petbody-debug.log，等人工 grep 等于没告警。这里收回结构化快照，
        // doctor 的「渲染健康」项直接读 /state，不用扫日志。
        state.renderHealth = msg.health || null;
        state.renderHealthAt = Date.now();
        return;
      }
    });
    ws.on('close', () => {
      renderers.delete(ws);
      // 断开也记一笔：看门狗从这里开始计 60s 宽限（渲染层本该 2s 内自己重连回来）。
      state.innerClients = renderers.size;
      state.lastInnerAt = Date.now();
    });
    ws.on('error', () => {});
    try {
      ws.send(JSON.stringify({ type: 'hello', model: { id: currentModel().id, name: currentModel().name } }));
      ws.send(JSON.stringify({ type: 'params', values: Object.fromEntries(state.params) }));
      for (const e of state.expressions) ws.send(JSON.stringify({ type: 'expression', name: e, active: true }));
      if (state.lastSay) ws.send(JSON.stringify({ type: 'say', text: state.lastSay }));
      ws.send(JSON.stringify({ type: 'fullscreen', on: state.lastFullscreen }));
      if (state.lastPointer) ws.send(JSON.stringify({ type: 'pointer', x: state.lastPointer.x, y: state.lastPointer.y }));
      // 渲染层刚连上就同步静默状态，插件（auto-chat / dawn-dusk 等）开机即认闸
      ws.send(JSON.stringify({ type: 'quiet', on: state.quiet === true }));
    } catch {}
  });

  // ---------- HTTP 控制口：给脚本/其他语言用 ----------
  let control = null;
  // 浏览器来源写令牌：启动时读 data/.control-token（没有就生成并落盘）。
  // 两个 Electron 窗口在创建时也从同一文件读（main.js / control-main.js），重启后不变。
  const controlToken = resolveControlToken(configPath, log);
  if (!controlToken) log('[control-auth] .control-token 解析为空：带 Origin 的写请求将全部 403');

  /**
   * /dispatch/tasks 专用闸门：**无条件**要求 X-Pet-Token（与只读 GET 的宽松口径不同）。
   * 缺 token → 401；token 不匹配/未配置 → 403。比较用 timingSafeEqual。
   */
  function requireDispatchToken(req, res, send) {
    const expected = String(controlToken == null ? '' : controlToken).trim();
    const got = String((req.headers && req.headers['x-pet-token']) || '').trim();
    if (!got) {
      send(401, { ok: false, error: 'token_required', hint: '读 data/.control-token，放在 X-Pet-Token 头里' });
      return false;
    }
    if (!expected) {
      send(403, { ok: false, error: 'token_not_configured' });
      return false;
    }
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(got, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      send(403, { ok: false, error: 'bad_token' });
      return false;
    }
    return true;
  }
  if (controlPort) {
    control = http.createServer(async (req, res) => {
      // CORS / Origin（2026-11-21 红队 P1，取代 11-20 的「本机 origin 白名单」口径）：
      // Electron 渲染层的 Origin 是字面 `file://`，任何本机开发服务器页面也是白名单
      // origin —— 光靠 Origin 分不出「她自己的窗口」和「你浏览器里任意网页」。所以：
      //   · 没有 Origin 的客户端（curl / Node / DSH answerer / remote-control / 手机
      //     3003 服务端 / 插件的 node:http）放行 —— 浏览器页面无法省略 Origin；
      //   · 带任意 Origin 的写请求（POST 等）必须带 X-Pet-Token = 本机 .control-token；
      //   · GET/HEAD 不要求令牌（只读；ACAO 仍只回显白名单 origin，网页读不到内容）；
      //   · /browser-tab 保持扩展自己的鉴权（browser_ext_token / browser_ext_ids）。
      // 预检（OPTIONS）不看令牌：浏览器预检不可能带自定义头，放行后才能发真请求；
      // 真请求没令牌 → 403 + {"ok":false,"error":"browser_requires_token"}。
      const origin = req.headers.origin;
      // 浏览器扩展 /browser-tab（2026-11-20）：MV3 service worker 的 Origin 是
      // chrome-extension://<id>（部分 Chrome 版本干脆不带 Origin）。只对这一个路由
      // 放行扩展 Origin —— 鉴权仍只认 X-Pet-Token，其他路由的令牌口径不变。
      let reqUrl = null;
      try { reqUrl = new URL(req.url, 'http://127.0.0.1'); } catch (e) { reqUrl = null; }
      const isExtensionOrigin = typeof origin === 'string' && /^(chrome|moz)-extension:\/\/[a-z0-9_-]+$/i.test(origin.trim());
      const extBrowserTab = !!(reqUrl && reqUrl.pathname === '/browser-tab' && isExtensionOrigin);
      const corsInfo = dshMap.corsFor(origin);
      const corsAllowed = corsInfo.allowed || extBrowserTab;
      const cors = extBrowserTab
        ? Object.assign({}, corsInfo.headers, {
          'Access-Control-Allow-Origin': String(origin).trim(),
          // 预检必须放行自定义头，否则浏览器在 fetch 前就把请求拦掉（popup 会显示网络失败）。
          'Access-Control-Allow-Headers': 'Content-Type, X-Pet-Token',
        })
        : Object.assign({}, corsInfo.headers, {
          // 写请求要带 X-Pet-Token；白名单 origin 的预检必须放行这个头。
          'Access-Control-Allow-Headers': 'Content-Type, X-Pet-Token',
        });
      const send = (code, obj) => { try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...cors }).end(JSON.stringify(obj)); } catch {} };
      if (req.method === 'OPTIONS') {
        if (!corsAllowed) { try { res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }).end('{"ok":false,"error":"origin_not_allowed"}'); } catch {} return; }
        try { res.writeHead(204, cors).end(); } catch {}
        return;
      }
      // 浏览器来源的写请求：令牌是唯一闸门（Origin 白名单不能再当鉴权）。
      // /browser-tab 走它自己的 401 机制，不叠加。解析 body 之前就拒。
      const isWriteMethod = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase());
      const isBrowserTabRoute = !!(reqUrl && reqUrl.pathname === '/browser-tab');
      if (isWriteMethod && !isBrowserTabRoute) {
        const verdict = controlAuthVerdict({
          origin,
          token: req.headers['x-pet-token'],
          expectedToken: controlToken,
          method: req.method,
        });
        if (!verdict.ok) {
          const route = reqUrl ? reqUrl.pathname : '?';
          log('[control-auth] 403 ' + route + ' origin=' + String(origin).slice(0, 120) + ' reason=' + verdict.reason);
          return send(403, { ok: false, error: 'browser_requires_token', reason: verdict.reason });
        }
      }
      try {
        const url = reqUrl || new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/health') {
          return send(200, {
            ok: true,
            uptime: Math.round(process.uptime()),
            connections: { vts: vts.clients.size, inner: inner.clients.size },
            // 存活判据（2026-11-15）：doctor / check-all / 手机遥控页都读这一份，
            // 主进程看门狗用的也是同一个函数 —— 三处口径不会分叉。
            renderer: liveness(),
          });
        }
        if (req.method === 'GET' && url.pathname === '/emotion') {
          return send(200, { ok: true, emotion: state.lastEmotion || null, at: state.lastEmotionAt || null });
        }
        if (req.method === 'GET' && url.pathname === '/emotion-state') {
          const saved = readEmotionState(configPath);
          return send(200, { ok: true, state: saved || null });
        }
        if (req.method === 'GET' && url.pathname === '/state') {
          return send(200, { ok: true, model: currentModel().name, assets: state.assets, assetStates: state.assetStates, expressions: [...state.expressions], lastSay: state.lastSay, quiet: state.quiet === true, renderHealth: state.renderHealth || null, renderHealthAt: state.renderHealthAt || null, renderer: liveness(), dshAsk: askBroker.current(), browserTabLast: state.browserTabLast || null });
        }
        // ── 派活任务列表/详情（P0 可见+安全 · 2026-11-23）─────────────────
        // 与其它只读 GET 不同：**无条件**要求 X-Pet-Token == .control-token
        // （不是「仅带 Origin 时」）。列表只出 120 字预览；正文/结果只在详情端点。
        // 3003 遥控页白名单不新增本路由（设计 §4.7）。
        if (req.method === 'GET' && url.pathname === '/dispatch/tasks') {
          if (!requireDispatchToken(req, res, send)) return;
          if (!dispatchLedger) return send(200, { ok: false, error: 'ledger_disabled', detail: 'config.dispatch.ledger_v2=false' });
          const id = url.searchParams.get('id') || url.searchParams.get('taskId');
          if (id) {
            const row = dispatchLedger.getDetail(id);
            if (!row) return send(404, { ok: false, error: 'not_found', taskId: String(id).slice(0, 80) });
            return send(200, { ok: true, task: row });
          }
          const limit = Number(url.searchParams.get('limit')) || 50;
          return send(200, { ok: true, tasks: dispatchLedger.listPreview({ limit }), at: Date.now() });
        }
        // 世界感知（2026-11-17 六十二轮）：与 8004 的 /world 同一份数据、同一个读取器。
        // 为什么要这个口：脚本/控制中心/验收要能「不打开 devtools 也看见她现在在干什么」。
        if (req.method === 'GET' && url.pathname === '/world') {
          if (typeof getWorld !== 'function') return send(200, { ok: false, error: '世界感知未挂载（getWorld 缺失）' });
          const w = await getWorld();
          return send(200, { ok: !!(w && w.ok !== false), world: w || null });
        }
        if (req.method === 'POST') {
          const chunks = []; for await (const c of req) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          // ── 浏览器 tab 上报（世界感知 Phase 2 · 2026-11-20）────────────────────
          // 鉴权：X-Pet-Token 必须等于 config.json 的 browser_ext_token；
          // 空配置/缺 token/错 token 一律 401（首次为空时拒绝并提示怎么配）。
          // 隐私：incognito 记录只落空 host/title，日志也只打 incognito。
          if (url.pathname === '/browser-tab') {
            const auth = checkBrowserToken(configPath, req.headers['x-pet-token']);
            // 2026-11-21：扩展 Origin 白名单作为第二鉴权（网页 CSRF 的 Origin 是 http(s)，
            // 已被外层白名单拦掉）。这样用户不必手动往 popup 填 token；token 仍可选。
            let byOrigin = false;
            if (!auth.ok) {
              const originId = (String(origin || '').match(/^(?:chrome|moz)-extension:\/\/([a-z0-9_-]+)$/i) || [])[1];
              if (originId) {
                let allowed = ['mbclgpkgcmhafgkcckjpndhjhngmebfi'];
                try {
                  const cfg2 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                  if (Array.isArray(cfg2.browser_ext_ids) && cfg2.browser_ext_ids.length) {
                    allowed = cfg2.browser_ext_ids.map(String);
                  }
                } catch (e) { /* 读不到配置就用默认 ID */ }
                byOrigin = allowed.includes(originId);
              }
            }
            if (!auth.ok && !byOrigin) {
              log('[browser-tab] 拒绝（' + auth.reason + '）');
              return send(401, {
                ok: false,
                error: 'bad-token',
                reason: auth.reason,
                hint: auth.reason === 'not-configured'
                  ? 'config.json 的 browser_ext_token 为空：先填一个随机串，再把同一个值填到扩展 popup（或在 browser_ext_ids 里放行扩展 ID）'
                  : 'X-Pet-Token 与 config.json 的 browser_ext_token 不一致；也可用 browser_ext_ids 放行扩展 Origin',
              });
            }
            const parsed = sanitizeBrowserTab(body);
            if (!parsed.ok) return send(400, { ok: false, error: parsed.error });
            const r = browserTabSink.append(parsed.record);
            if (!r.ok) {
              log('[browser-tab] 写盘失败: ' + r.error);
              return send(500, { ok: false, error: 'write-failed', detail: r.error });
            }
            // 心跳语义（2026-11-21）：skipped 也刷新 seen_ts，/state 与 world-extras 都用它判新鲜。
            const seenTs = Number(r.seen_ts) || Number(parsed.record.ts) || Date.now();
            state.browserTabLast = {
              ts: (r.record && r.record.ts) || parsed.record.ts,   // 内容变化时间
              seen_ts: seenTs,                                     // 最后一次看到
              host: parsed.record.host,
              incognito: parsed.record.incognito,
            };
            if (r.skipped) return send(200, { ok: true, skipped: true, ts: parsed.record.ts, seen_ts: seenTs });
            log(parsed.record.incognito ? '[browser-tab] incognito' : '[browser-tab] host=' + parsed.record.host);
            return send(200, { ok: true, skipped: false, ts: parsed.record.ts, seen_ts: seenTs });
          }
          // ── DSH → 人工应答（2026-11-20 六十六轮）──────────────────────────
          // answerer 插件先来这里问：把问题说出来，然后挂起等下一条用户输入。
          if (url.pathname === '/dsh/ask') {
            const questions = sanitizeDshQuestions(body && body.questions);
            if (!questions) return send(400, { ok: false, error: 'bad_questions', answers: [], timedOut: false });
            // 已有挂起：直接按 busy 回落（askBroker 也会兜一次，这里先短路省一次 say）。
            if (askBroker.busy()) {
              askLog('已有待答问题，新请求按超时回落规则');
              return send(200, { answers: [], timedOut: true, busy: true });
            }
            const speech = dshAskSpeech(questions);
            say(speech); // 与 /say 同一条通道：气泡 + 字幕 + TTS
            askLog('问题已转述: ' + speech);
            const req2 = askBroker.ask(questions);
            // 插件等待超时/主动断开时别把问题继续挂着，否则下一条普通聊天会被误当回答。
            res.on('close', () => {
              if (!res.writableEnded) askBroker.cancel(req2.id);
            });
            const result = await req2.promise;
            return send(200, result);
          }
          // 渲染层把用户下一条文本/语音原样回传到这里；没有待答问题时静默忽略。
          if (url.pathname === '/dsh/reply') {
            const text = String((body && (body.text || body.reply)) || '').trim();
            if (!text) return send(400, { ok: false, consumed: false, error: 'empty text' });
            const r = askBroker.reply(text);
            if (!r.consumed) return send(200, { ok: true, consumed: false });
            return send(200, r);
          }
          if (url.pathname === '/say') { say(body.text); return send(200, { ok: true }); }
          // 世界感知开关（2026-11-17 六十二轮）：body 形如
          //   { "privacy": true } / { "enabled": false } / { "low_power": true }
          //   { "sources": { "clipboard": false } }
          if (url.pathname === '/world') {
            if (typeof setWorld !== 'function') return send(200, { ok: false, error: '世界感知未挂载（setWorld 缺失）' });
            const r = await setWorld(body);
            return send(200, r || { ok: true });
          }
          if (url.pathname === '/asset') {
            // 2026-11-14 五十三轮（审计）：原来只读 body.on —— 客户端发的是 {id,value}，
            // `on` 恒为 undefined → 每次都被当成「切换」，接口还返回 ok（假成功）。
            // 现在 value/on 都认；**档位值（big/mid/small）这条 HTTP 通道表示不了，
            // 必须如实拒绝**，不能让客户端接着对用户说「装扮已更新」。
            const raw = (body.value !== undefined && body.value !== null && body.value !== '') ? body.value : body.on;
            const isBoolish = raw === true || raw === false || raw === 'true' || raw === 'false' || raw === undefined;
            if (!isBoolish) {
              return send(400, {
                ok: false, id: body.id, value: raw,
                error: 'HTTP /asset 只支持开关型（true/false）；档位值要走渲染进程内的 petBody.setAssetValue',
              });
            }
            const next = setAsset(body.id, raw);
            return send(200, { ok: true, id: body.id, on: next, toggled: raw === undefined });
          }
          if (url.pathname === '/action') { playAction(body.name); return send(200, { ok: true }); }
          if (url.pathname === '/fullscreen') { sendFullscreen(body.on); return send(200, { ok: true, on: !!body.on }); }
          if (url.pathname === '/pointer') { sendPointer(body || null); return send(200, { ok: true }); }
          if (url.pathname === '/framing') {
            // 取景切换：half（半身）/ full（全身）。立即生效，不用重启。
            const mode = body.mode === 'full' ? 'full' : 'half';
            bcast({ type: 'framing', mode });
            return send(200, { ok: true, mode });
          }
          if (url.pathname === '/emotion-gain') {
            // 表情强度：0=面瘫 1=正常 1.5=夸张（渲染层实时生效）
            const gain = Math.max(0, Math.min(2, Number(body.gain) || 0));
            bcast({ type: 'emotion-gain', gain });
            return send(200, { ok: true, gain });
          }
          if (url.pathname === '/chat') {
            const text = String(body.text || '').trim();
            if (!text) return send(400, { ok: false, error: 'empty text' });
            bcast({ type: 'chat', text });
            return send(200, { ok: true, text });
          }
          if (url.pathname === '/perform') {
            // 演一段：纯本地（情绪/动作/换装），不产生任何 API 调用
            const name = String(body.name || '').trim();
            if (!name) return send(400, { ok: false, error: 'empty name' });
            bcast({ type: 'perform', name });
            return send(200, { ok: true, name });
          }
          if (url.pathname === '/emotion-state') {
            // 结构最小校验：必须有两个主体、各带 revision —— 坏了就别写盘，返回原因
            const st = body && body.state;
            const okShape = st && st.user && st.companion
              && Number.isFinite(Number(st.user.revision)) && Number.isFinite(Number(st.companion.revision));
            if (!okShape) return send(400, { ok: false, error: 'bad_emotion_state' });
            const r = writeEmotionState(configPath, { state: st, savedAt: Date.now(), version: 1, restored: body.restored || null });
            return send(r.ok ? 200 : 500, r.ok ? { ok: true, path: r.path } : { ok: false, error: r.error });
          }
          if (url.pathname === '/quiet') {
            // 省钱模式：她不再主动开口，只有用户说话才会调 LLM
            const on = body.on !== false;
            state.quiet = on;
            global.__petQuiet = on;
            bcast({ type: 'quiet', on });
            log('[vts] 静默模式 =', on);
            // 持久化：重启后保持同一状态（静默版的默认来源也是这里）
            // 走 config-persist.patchVerified：原子写（tmp+rename）+ .bak + 回读校验。
            // 失败必须说实话（内存态已生效，但没写盘），不能再像旧实现那样吞掉错误回 ok:true。
            if (configPath) {
              let w = { ok: false, error: 'config_persist_unavailable' };
              try {
                const { patchVerified } = require('../js/core/config-persist.js');
                w = patchVerified(configPath, (cfg) => {
                  if (!cfg.cost || typeof cfg.cost !== 'object' || Array.isArray(cfg.cost)) cfg.cost = {};
                  cfg.cost.quiet = on;
                });
              } catch (e) { w = { ok: false, error: String((e && e.message) || e) }; }
              if (!w.ok) {
                log('[vts] 静默状态写盘失败（内存已生效，重启会回旧值）:', w.error || w.stage || 'unknown');
                return send(500, { ok: false, quiet: on, persisted: false, error: String(w.error || 'write_failed') });
              }
            }
            return send(200, { ok: true, quiet: on, persisted: !!configPath });
          }
          // 取消（P1 · §4.5）：只在 runner 持有句柄时杀树；重启后没有句柄 → cannot_cancel。
          // 幂等：已 cancelled 直接回 cancelled；绝不因为「用户点快了」再杀一次。
          if (url.pathname === '/dispatch/cancel') {
            const c = await cancelDispatchTask(body && body.taskId, { graceMs: body && body.graceMs });
            return send(c.status, c.body);
          }
          // 续聊（2026-11-23）：父任务终态 + sessionId → 同一 DSH 会话接着做。
          // body: { taskId: 父任务, task: 这次要做的事 }；cwd/workspace 不接受覆盖（沿用父任务）。
          if (url.pathname === '/dispatch/followup') {
            if (body && body.cwd) {
              log('[vts] /dispatch/followup 忽略 HTTP cwd（沿用父任务工作区）: ' + String(body.cwd).slice(0, 120));
            }
            if (body && body.workspace) {
              log('[vts] /dispatch/followup 忽略 HTTP workspace（沿用父任务工作区）: ' + String(body.workspace).slice(0, 60));
            }
            const ac = new AbortController();
            res.on('close', () => {
              if (!res.writableEnded) { try { ac.abort(); } catch (e) { /* 已 abort */ } }
            });
            const f = await followupDispatchTask(
              body && (body.taskId || body.parentId || body.id),
              body && (body.task || body.text),
              {
                origin: 'http', signal: ac.signal, timeoutMs: body && body.timeoutMs,
                // 可选：调用方预先分配子任务 id（插件用它保证「派完就能查」）。
                // 不给就由服务端生成；规格里的最小请求体仍然只有 {taskId, task}。
                taskId: body && body.newTaskId,
              },
            );
            return send(f.status, f.body);
          }
          if (url.pathname === '/dispatch') {
            // 2026-11-21 红队 P1 #4：HTTP 入口不再接受 cwd。
            // 理由：任何「被信任 origin」的本机页面都能 POST 这里；若允许指定目录，
            // 就等于「本机网页 → 让 DSH 在任意目录跑任务」——而 DSH 是 workspace-write
            // 且注入了 provider key 环境变量。目录只能由配置别名决定（P1 workspace）。
            const d = sanitizeDispatchHttpBody(body);
            if (d.ignoredCwd) log('[vts] /dispatch 忽略 HTTP cwd（只允许 workspace 别名）: ' + d.ignoredCwd.slice(0, 120));
            // 断线语义（P0）：响应没写完就断开 → dispatchTask 收到 abort → unknown/disconnect。
            const ac = new AbortController();
            res.on('close', () => {
              if (!res.writableEnded) { try { ac.abort(); } catch (e) { /* 已 abort */ } }
            });
            const result = await dispatchTask(d.task, Object.assign({}, d.opts, { origin: 'http', signal: ac.signal }));
            const conflict = !!(result && (result.error === 'request_id_conflict' || result.error === 'task_id_conflict'));
            // P1：workspace/开关类错误是「请求本身不合法」→ 400（attempted=false，不消耗任务）。
            const badRequest = !!(result && [
              'unknown_workspace', 'workspace_missing', 'workspace_disabled',
              'verify_disabled', 'ledger_disabled', 'ledger_required',
            ].includes(result.error));
            return send(conflict ? 409 : (badRequest ? 400 : 200), result);
          }
        }
        send(404, { ok: false, error: 'not found' });
      } catch (error) { send(500, { ok: false, error: String(error && error.message || error) }); }
    });
    control.on('error', () => {});
    control.listen(controlPort, '127.0.0.1');
  }

  log('[vts] VTS 兼容 API: ws://127.0.0.1:' + port + '  ·  内部渲染通道: ws://127.0.0.1:' + internalPort + (controlPort ? '  ·  HTTP 控制: http://127.0.0.1:' + controlPort : ''));
  return {
    state,
    say, setAsset, playAction, dispatchTask, sendPointer, sendFullscreen,
    // 派活账本（P0）：测试/doctor/主进程可选观测；ledger_v2=false 时为 null。
    dispatchLedger,
    ledgerEnabled,
    // P1：runner 句柄表 + 生效设置 + 取消入口（进程内调用，与 HTTP 路由同一实现）
    dispatchRunner,
    dispatchSettings,
    cancelDispatchTask,
    followupDispatchTask,
    // 渲染层存活判据（主进程看门狗直接调，不用自己再算一遍）
    rendererLiveness: liveness,
    // 主进程 → 渲染层 任意消息（托盘菜单即时切换取景/穿透等）
    sendToRenderers: (payload) => { try { bcast(payload); } catch (e) {} },
    close() { try { vts.close(); } catch {} try { inner.close(); } catch {} try { control && control.close(); } catch {} if (state.injectTimer) clearTimeout(state.injectTimer); },
    pushMouth(v) { state.params.set('ParamMouthOpenY', v); queueParams({ ParamMouthOpenY: v }); },
  };
}

if (process.argv[1] && process.argv[1].endsWith('vts-server.mjs')) {
  startVtsServer({ model: { id: 'dafeiyu', name: '大肥鱼', expressions: [], hotkeys: [], parameters: [] } });
}
