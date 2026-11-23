/**
 * dispatch-runner.mjs — 派活 v2 P1：后端适配器（2026-11-23）
 *
 * 设计依据：docs/设计-派活v2-2026-11-23.md §3.1/§4.5/§6。
 *
 * 为什么要有它：P0 的 vts-server 是用 node 起 dsh-dispatch.mjs 的**孙进程** —— 真正跑 DSH 的是
 * **孙进程**，主进程手里只有「CLI 壳」的 pid，`taskkill /T` 杀不到 DSH 自己派生的会话；
 * 而且壳一死句柄即失，取消无从谈起。P1 把「起 DSH、持句柄、解析事件、取消」搬进主进程
 * 内的这一层，vts-server 直接调用它；dsh-dispatch.mjs 退化成 CLI 薄壳（同一实现）。
 *
 * 不新增进程/端口：本模块只在已存在的 Electron 主进程里被 import。
 * 取消语义（§4.5）：
 *   · 句柄在 → `taskkill /PID <pid> /T /F`，轮询进程消失（≤ cancel_grace_ms）；
 *   · 句柄不在（主进程重启后）→ cannot_cancel，**不猜 pid**（Windows pid 会复用，猜就是杀错人）。
 *
 * 可测性：spawn/kill/pidAlive/now 全部可注入。测试用真 node 子进程跑取消，
 * 但绝不 spawn 真的 dsh.exe。
 */
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_DSH_ROOT = '<user-home>/AppData/Local/Programs/DeepSeek Harness';
export const DEFAULT_CANCEL_GRACE_MS = 2000;
export const DEFAULT_POLL_MS = 100;
export const STDOUT_KEEP_BYTES = 1024 * 1024;

/**
 * 任务后缀（从 dsh-dispatch.mjs 原样搬来；历史两处真 bug 的修复理由见那里的注释）：
 *   · 任务正文放最前（DSH 会把「执行约束」误认成自己的 runtime context）；
 *   · 「做完保持结果状态」防止编码型 agent 顺手清理它自己拉起的进程。
 */
export const TASK_SUFFIX = [
  '',
  '（补充要求，优先级同样高：这是真实请求，不是测试或演练，直接完成目标；完成后保持结果状态——打开的程序/窗口不要关、创建的文件不要删、启动的服务不要停，不要顺手清理或回滚；若要启动进程，用 detached 方式让它在你结束后仍在运行；只做到要求的那一步就停。）',
].join('\n');

export function appendTaskSuffix(task) {
  return String(task == null ? '' : task).trim() + TASK_SUFFIX;
}

/** DSH 的 exe/cli 位置（与旧 dsh-dispatch.mjs 同一口径，可用 DSH_ROOT 覆盖）。 */
export function resolveDshPaths(env = process.env) {
  const root = String((env && env.DSH_ROOT) || DEFAULT_DSH_ROOT);
  return {
    root,
    exe: join(root, 'DeepSeek Harness.exe'),
    cli: join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
  };
}

/**
 * 从 ~/.dsh/.credentials.yaml 读 provider key（headless profile 不会自己读）。
 * 已在环境里的不动；返回新对象，不打印、不落盘。
 */
export function withDshCredentials(env = process.env, opts = {}) {
  const home = opts.homeDir || homedir();
  const credPath = join(home, '.dsh', '.credentials.yaml');
  const out = Object.assign({}, env);
  let text = '';
  try { text = fs.readFileSync(credPath, 'utf8'); } catch (e) { return out; }
  for (const name of ['COMAD_BUNNY_API_KEY', 'DEEPSEEK_API_KEY']) {
    if (out[name]) continue;
    const m = text.match(new RegExp('^\\s*' + name + ':\\s*(.+)$', 'm'));
    if (m) out[name] = m[1].trim();
  }
  return out;
}

/**
 * 产出一条 spawn 计划。测试可注入自己的 plan 来复用 runner 的句柄/取消逻辑，
 * 而不用真的调 DSH。
 * @returns {{exe:string, args:string[], options:object}}
 */
export function buildDshSpawnPlan({ task, cwd, sessionId = '', env = process.env, dshPaths = null, extraArgs = [] } = {}) {
  const p = dshPaths || resolveDshPaths(env);
  const args = ['--profile', 'headless', '--json'];
  if (sessionId) args.push('--session-id', String(sessionId));
  if (Array.isArray(extraArgs)) args.push(...extraArgs.map(String));
  args.push(appendTaskSuffix(task));
  const useDirect = (() => {
    try { return fs.existsSync(p.exe) && fs.existsSync(p.cli); } catch (e) { return false; }
  })();
  if (useDirect) {
    return {
      exe: p.exe,
      args: ['--expose-internals', p.cli, ...args],
      options: {
        cwd: cwd || process.cwd(),
        env: Object.assign({}, withDshCredentials(env), { ELECTRON_RUN_AS_NODE: '1' }),
        shell: false,
        windowsHide: true,
      },
    };
  }
  // 回退：没找到 exe/cli 时用 PATH 里的 dsh + shell:true（多行任务可能丢，仅兜底）
  return {
    exe: 'dsh',
    args,
    options: { cwd: cwd || process.cwd(), env: withDshCredentials(env), shell: true, windowsHide: true },
  };
}

function clip(s, max) {
  const v = String(s == null ? '' : s);
  return v.length > max ? v.slice(0, max) : v;
}

function clipTail(s, max) {
  const v = String(s == null ? '' : s);
  return v.length > max ? v.slice(-max) : v;
}

/** Windows 上 `process.kill(pid, 0)` 会被系统进程回 EPERM —— 那也算「还活着」。 */
export function defaultPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/**
 * 杀整棵进程树。句柄在时才调用（§4.5：不猜 pid）。
 * 默认实现真跑 taskkill /PID /T /F；测试可注入 killImpl。
 */
export function defaultKillTree(pid) {
  if (!pid) return { ok: false, error: 'no_pid' };
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
      return { ok: r.status === 0, code: r.status, signal: r.signal || null, output: clip((r.stdout || '') + (r.stderr || ''), 300) };
    }
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { process.kill(pid, 'SIGKILL'); }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: clip((e && e.message) || e, 200) };
  }
}

function sleep(ms) {
  // 不 unref：取消轮询是「必须等到」的短定时器（假 child 没有真实句柄时，
  // unref 会让进程直接退出、cancel Promise 永不 resolve）。
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * 解析一行 DSH 事件。容忍未知事件（DSH 漂移，§6）；返回 null 表示不认识。
 * 兼容 dsh-dispatch.mjs 的「聚合 JSON」输出（ok/text/tools/tookMs/sessionId）——
 * 这样 CLI 薄壳与旧注入替身仍能走同一条链。
 */
export function parseDshLine(line) {
  const s = String(line || '').trim();
  if (!s.startsWith('{')) return null;
  let ev = null;
  try { ev = JSON.parse(s); } catch (e) { return null; }
  if (!ev || typeof ev !== 'object') return null;
  if (!ev.type && (Object.prototype.hasOwnProperty.call(ev, 'ok') || Object.prototype.hasOwnProperty.call(ev, 'text') || Object.prototype.hasOwnProperty.call(ev, 'tools'))) {
    return { kind: 'aggregate', value: ev };
  }
  if (ev.type === 'session') return { kind: 'session', value: ev };
  if (ev.type === 'final') return { kind: 'final', value: ev };
  if (ev.type === 'status') return { kind: 'status', value: ev };
  if (ev.type === 'tool' || ev.type === 'tool_call') return { kind: 'tool', value: ev };
  return { kind: 'unknown', value: ev };
}

/**
 * 创建一个 runner。每个 taskId 同时只允许一个句柄（返工要等上一轮 exit 后再 start）。
 *
 * @param {object} opts
 * @param {Function} [opts.spawnImpl=spawn]   (exe,args,options) => ChildProcess
 * @param {Function} [opts.killImpl]          (pid, child) => {ok}
 * @param {Function} [opts.pidAliveImpl]      (pid) => boolean
 * @param {Function} [opts.now]
 * @param {object}   [opts.env]
 * @param {object}   [opts.dshPaths]
 * @param {Function} [opts.log]
 */
export function createDispatchRunner(opts = {}) {
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;
  const killImpl = typeof opts.killImpl === 'function' ? opts.killImpl : defaultKillTree;
  const pidAliveImpl = typeof opts.pidAliveImpl === 'function' ? opts.pidAliveImpl : defaultPidAlive;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const env = opts.env || process.env;
  const dshPaths = opts.dshPaths || null;
  const pollMs = Math.max(20, Number(opts.pollMs) || DEFAULT_POLL_MS);
  const say = (line) => { try { if (typeof opts.log === 'function') opts.log('[dispatch-runner] ' + line); } catch (e) { /* 日志失败不影响派活 */ } };

  const handles = new Map();   // taskId -> handle

  /**
   * 起一个后台任务并持有句柄。
   * @param {{taskId:string, task:string, cwd?:string, sessionId?:string,
   *          plan?:{exe,args,options}}} input
   * @returns {object} handle {taskId,pid,child,startedAt,result,promise,cancel,killTree,state()}
   */
  function start(input = {}) {
    const taskId = String(input.taskId || '').trim();
    if (!taskId) throw new Error('missing_task_id');
    if (handles.has(taskId)) throw new Error('task_already_running:' + taskId);
    const plan = input.plan && typeof input.plan === 'object' && input.plan.exe
      ? input.plan
      : buildDshSpawnPlan({
        task: input.task,
        cwd: input.cwd,
        sessionId: input.sessionId,
        env,
        dshPaths,
      });
    let child;
    try {
      child = spawnImpl(plan.exe, plan.args, plan.options);
    } catch (e) {
      const err = new Error('spawn_failed: ' + String((e && e.message) || e));
      err.code = 'spawn_failed';
      throw err;
    }
    if (!child) {
      const err = new Error('spawn_failed: empty child');
      err.code = 'spawn_failed';
      throw err;
    }

    const st = {
      taskId,
      child,
      pid: child.pid || 0,
      startedAt: now(),
      exited: false,
      exitCode: null,
      cancelled: false,
      spawnError: '',
      sessionId: '',
      text: '',
      error: '',
      tools: [],
      aggregate: null,
      stdoutTail: '',
      stderrTail: '',
    };
    let lineBuf = '';
    let settled = false;
    let resolveResult;
    const result = new Promise((resolve) => { resolveResult = resolve; });

    const settleResult = () => {
      if (settled) return;
      settled = true;
      handles.delete(taskId);
      const agg = st.aggregate;
      const code = st.exitCode;
      const text = st.text || (agg && typeof agg.text === 'string' ? agg.text : '');
      const tools = st.tools.length ? st.tools : (agg && Array.isArray(agg.tools) ? agg.tools : []);
      const sessionId = st.sessionId || (agg && agg.sessionId ? String(agg.sessionId) : '');
      const tookMs = st.cancelled ? Math.max(0, now() - st.startedAt)
        : (agg && Number.isFinite(Number(agg.tookMs)) ? Number(agg.tookMs) : Math.max(0, now() - st.startedAt));
      const aggOk = agg && agg.ok === false ? false : true;
      const error = st.error || (agg && agg.error ? String(agg.error) : '') || st.spawnError || (code ? clip(st.stderrTail, 400) : '');
      resolveResult({
        taskId,
        ok: !st.cancelled && !st.spawnError && aggOk && code === 0 && !st.error,
        code,
        text,
        error,
        tools: tools.slice(0, 50),
        sessionId,
        tookMs,
        cancelled: st.cancelled,
        spawnError: st.spawnError,
        stdoutTail: clip(st.stdoutTail, 600),
        stderrTail: clip(st.stderrTail, 600),
        pid: st.pid,
      });
    };

    const onLine = (line) => {
      const parsed = parseDshLine(line);
      if (!parsed) return;
      if (parsed.kind === 'session') {
        st.sessionId = String(parsed.value.sessionId || '').slice(0, 200);
      } else if (parsed.kind === 'final') {
        if (typeof parsed.value.text === 'string') st.text = parsed.value.text;
        // final 也带 sessionId（DSH 0.2.2 实测）；缺 session 事件时仍能拿到身份，
        // 续聊的「回传 session 是否一致」判据不会因事件漂移而失效。
        if (!st.sessionId && parsed.value.sessionId) {
          st.sessionId = String(parsed.value.sessionId).slice(0, 200);
        }
      } else if (parsed.kind === 'status') {
        const reason = parsed.value.reason;
        if (reason && reason.kind === 'error') {
          st.error = String((reason.error && reason.error.message) || 'error');
        }
      } else if (parsed.kind === 'tool') {
        const name = String(parsed.value.name || parsed.value.tool || '').trim();
        if (name) st.tools.push(name);
      } else if (parsed.kind === 'aggregate') {
        st.aggregate = parsed.value;
      }
      // 观测钩子只调一次（未知事件也交给调用方记录，DSH 漂移时要看得见）
      if (input.onEvent) {
        try { input.onEvent(parsed); } catch (e) { /* 观测钩子失败不影响执行 */ }
      }
    };

    const onData = (chunk) => {
      const s = chunk.toString();
      st.stdoutTail = clipTail(st.stdoutTail + s, STDOUT_KEEP_BYTES);
      lineBuf += s;
      const parts = lineBuf.split('\n');
      lineBuf = parts.pop() || '';
      for (const ln of parts) onLine(ln);
    };

    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', onData);
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (c) => { st.stderrTail = clipTail(st.stderrTail + c.toString(), STDOUT_KEEP_BYTES); });
    }
    if (typeof child.on === 'function') {
      child.on('error', (e) => {
        st.spawnError = String((e && e.message) || e);
        // 没有 pid = 进程根本没起来：立刻收口（vts-server 会判 spawn_failed/attempted=false）
        if (!st.pid) { st.exited = true; settleResult(); }
      });
      child.on('exit', (code, signal) => {
        if (lineBuf) { onLine(lineBuf); lineBuf = ''; }
        st.exitCode = Number.isFinite(Number(code)) ? Number(code) : null;
        st.exitSignal = signal || null;
        st.exited = true;
        settleResult();
      });
    }

    const handle = {
      taskId,
      child,
      get pid() { return st.pid; },
      startedAt: st.startedAt,
      result,
      /** 原样杀整棵进程树（超时用）。 */
      killTree() {
        if (st.exited) return { ok: true, alreadyExited: true };
        st.cancelled = true;
        let r = { ok: false };
        try { r = killImpl(st.pid, st.child) || { ok: true }; } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
        say('killTree ' + taskId + ' pid=' + st.pid + ' ok=' + (r && r.ok));
        return r;
      },
      /**
       * 取消：杀树 + 等进程消失（≤ graceMs）。
       * @returns {Promise<{ok:boolean, reason?:string, pid:number, tookMs:number, alreadyExited?:boolean}>}
       */
      async cancel({ graceMs = DEFAULT_CANCEL_GRACE_MS } = {}) {
        const started = now();
        if (st.exited) {
          // 壳已退出 ≠ 树已消失：pid 还活着就不能报「停成功」（pid 复用会误判）。
          const alive = pidAliveImpl(st.pid);
          return { ok: !alive, alreadyExited: true, pid: st.pid, tookMs: 0, reason: alive ? 'kill_timeout' : undefined };
        }
        st.cancelled = true;
        let killRes = { ok: false };
        try { killRes = killImpl(st.pid, st.child) || { ok: true }; } catch (e) { killRes = { ok: false, error: String((e && e.message) || e) }; }
        say('cancel ' + taskId + ' pid=' + st.pid + ' kill=' + (killRes && killRes.ok));
        const limit = Math.max(200, Number(graceMs) || DEFAULT_CANCEL_GRACE_MS);
        // 轮询到「exit 事件已到」或「pid 已消失」，最多 graceMs（设计 §4.5：≤2s）。
        // 不 await result：某些包装进程的 exit 比整棵树消失更早，反过来也有；两个信号取先到。
        const deadline = started + limit;
        let gone = st.exited || !pidAliveImpl(st.pid);
        while (!gone && now() < deadline) {
          await sleep(Math.min(pollMs, Math.max(10, deadline - now())));
          gone = st.exited || !pidAliveImpl(st.pid);
        }
        const tookMs = Math.max(0, now() - started);
        if (!gone) {
          return { ok: false, reason: 'kill_timeout', pid: st.pid, tookMs, exitSeen: st.exited, kill: killRes };
        }
        return { ok: true, pid: st.pid, tookMs, exitSeen: st.exited, kill: killRes };
      },
      /** 测试/观测：当前句柄状态（不可变快照）。 */
      state() {
        return {
          taskId, pid: st.pid, exited: st.exited, exitCode: st.exitCode,
          cancelled: st.cancelled, startedAt: st.startedAt,
          tools: st.tools.slice(0, 50), sessionId: st.sessionId,
          text: clip(st.text, 4000), error: clip(st.error, 600),
        };
      },
      /** 续聊预留（P2）：句柄存活期间把新输入写到 DSH stdin（当前 DSH 不读，仅保留接口）。 */
      writeFollowup(textValue) {
        try {
          if (!st.child || !st.child.stdin || typeof st.child.stdin.write !== 'function' || st.exited) return false;
          st.child.stdin.write(String(textValue == null ? '' : textValue) + '\n');
          return true;
        } catch (e) { return false; }
      },
    };
    handles.set(taskId, handle);
    return handle;
  }

  return {
    start,
    get: (taskId) => handles.get(String(taskId || '').trim()) || null,
    has: (taskId) => handles.has(String(taskId || '').trim()),
    activeIds: () => [...handles.keys()],
    size: () => handles.size,
    /** 进程退出/异常后兜底清理（正常路径在 settleResult 里已删）。 */
    forget(taskId) { handles.delete(String(taskId || '').trim()); },
    killImpl,
    pidAliveImpl,
  };
}

export default { createDispatchRunner, buildDshSpawnPlan, resolveDshPaths, parseDshLine, appendTaskSuffix, defaultKillTree, defaultPidAlive };
