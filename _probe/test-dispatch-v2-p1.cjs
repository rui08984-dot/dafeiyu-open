// _probe/test-dispatch-v2-p1.cjs —— 派活 v2 P1（可停+证据）验收用例
//
// 覆盖设计 docs/设计-派活v2-2026-11-23.md §5「P1 可停+证据」：
//   1. verify 四态：pass→done_verified；fail→failed；broken/timeout→done_unproven；
//      ENOENT 在业务文件→fail，在命令/解释器→broken。
//   2. 返工：仅 fail 且 round<reworkMax；新会话注入失败输出+改动文件+只修不推倒；
//      每轮重跑 verify；broken/timeout 不返工；轮次进 verify.rounds。
//   3. settle→快照 diff→verify 的顺序与证据（真实临时目录、真实文件改动）。
//   4. workspace：别名→realpath；未知/缺失→400 且 attempted=false 不消耗；HTTP cwd 被忽略。
//   5. 取消：runner 持句柄 → taskkill /T /F（真 node 子进程）；≤2s；partialWrites；
//      幂等；无句柄（重启）→ cannot_cancel+unknown，不猜 pid。
//   6. 插件工具面：verify/workspace 透传、dispatch_cancel、_check 读 verify/outcome。
//   7. ledger_v2=false：P1 能力明确报错（不静默降级）。
//
// 全程 mkdtemp 隔离：不碰真实 data/端口/DSH。取消用真 node 子进程 + 真 taskkill，
// 证明「不是桩”。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const PROJECT = path.join(__dirname, '..');
const APP = path.join(PROJECT, '_incoming', 'my-neuro', 'live-2d');
const VERIFY_MOD = path.join(APP, 'petbridge', 'dispatch-verify.mjs');
const RUNNER_MOD = path.join(APP, 'petbridge', 'dispatch-runner.mjs');
const VTS_MOD = path.join(APP, 'petbridge', 'vts-server.mjs');
const PLUGIN_MOD = path.join(APP, 'plugins', 'community', 'dispatch', 'index.js');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(name + (detail !== undefined ? '：' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dispatch-p1-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows 偶发占用 */ }
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
function request(port, method, pathname, { body = null, token = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (token) headers['X-Pet-Token'] = token;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ status: 0, text: 'timeout', json: null }); });
    req.on('error', (e) => resolve({ status: 0, text: String((e && e.message) || e), json: null }));
    req.setTimeout(timeoutMs);
    if (data) req.write(data);
    req.end();
  });
}
async function waitHealthy(port) {
  for (let i = 0; i < 60; i += 1) {
    await sleep(80);
    const r = await request(port, 'GET', '/health', { timeoutMs: 2000 });
    if (r.status === 200) return true;
  }
  return false;
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/**
 * 假 DSH：EventEmitter + 流。lines 是 DSH NDJSON 事件；beforeExit 在退出前跑
 * （用来真改工作区文件，让快照 diff 有东西可看）。hang=true 时永不退出。
 * kill 行为由注入的 dispatchKill 决定（默认 emit exit，模拟进程树消失）。
 */
function fakeChild({ pid, lines = [], exitCode = 0, delay = 30, hang = false, beforeExit = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid || (47000 + Math.floor(Math.random() * 500));
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  if (!hang) {
    // 不 unref：这一段没有服务器 socket / 真实子进程撑着事件循环，
    // unref 会让进程在 await result 前退出（表现为「静默退出、无输出」）。
    setTimeout(() => {
      if (beforeExit) { try { beforeExit(child); } catch (e) { /* 测试准备失败不算产品 */ } }
      for (const ln of lines) child.stdout.write(JSON.stringify(ln) + '\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', exitCode);
    }, delay);
  }
  return child;
}

function writeConfig(dir, dispatch) {
  const appDir = path.join(dir, 'live-2d');
  fs.mkdirSync(appDir, { recursive: true });
  const cfgPath = path.join(appDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ dispatch }, null, 2), 'utf8');
  return { appDir, cfgPath, room: path.join(dir, 'data') };
}

async function startProbeServer({ cfgPath, dispatchSpawn, dispatchKill, verifySpawn = null, log = () => {} }) {
  const [pVts, pInner, pCtrl] = await Promise.all([freePort(), freePort(), freePort()]);
  const { startVtsServer } = await import(pathToFileURL(VTS_MOD).href);
  const server = startVtsServer({
    port: pVts,
    internalPort: pInner,
    controlPort: pCtrl,
    configPath: cfgPath,
    model: { id: 'probe', name: 'probe', expressions: [], hotkeys: [], parameters: [] },
    log,
    dispatchSpawn,
    dispatchKill,
    verifySpawn,
  });
  const healthy = await waitHealthy(pCtrl);
  return { server, port: pCtrl, healthy, ports: [pVts, pInner, pCtrl] };
}

(async () => {
  const dbg = (m) => { if (process.env.P1_DEBUG) console.error('[p1] ' + m); };
  dbg('import modules');
  const V = await import(pathToFileURL(VERIFY_MOD).href);
  const R = await import(pathToFileURL(RUNNER_MOD).href);
  dbg('section 1 verify module');

  // ══ 1. verify 模块：workspace / 快照 / settle / 四态 ═══════════════════
  {
    const root = tempRoot('p1-verify-');
    try {
      const ws = path.join(root, 'ws');
      fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'a.txt'), '1', 'utf8');
      fs.mkdirSync(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'node_modules', 'pkg', 'x.js'), 'x', 'utf8');

      // 1a. workspace 别名
      const good = V.resolveWorkspace('w', { workspaces: { w: ws } });
      ok('workspace 别名解析成功', good.ok === true, JSON.stringify(good));
      ok('workspace 返回 realpath', good.ok && path.isAbsolute(good.realpath), JSON.stringify(good));
      const viaDefault = V.resolveWorkspace('', { workspaces: { w: ws }, defaultWorkspace: 'w' });
      ok('空 alias 用 defaultWorkspace', viaDefault.ok === true && viaDefault.alias === 'w', JSON.stringify(viaDefault));
      const unknown = V.resolveWorkspace('nope', { workspaces: { w: ws } });
      eq('未知别名 → unknown_workspace', unknown.error, 'unknown_workspace');
      const missing = V.resolveWorkspace('gone', { workspaces: { gone: path.join(root, 'not-there') } });
      eq('目录不存在 → workspace_missing', missing.error, 'workspace_missing');
      const file = path.join(root, 'file.txt');
      fs.writeFileSync(file, 'x', 'utf8');
      const notDir = V.resolveWorkspace('f', { workspaces: { f: file } });
      eq('文件不是目录 → workspace_missing', notDir.error, 'workspace_missing');
      if (process.platform === 'win32') {
        const driveRoot = V.resolveWorkspace('c', { workspaces: { c: 'C:/' } });
        eq('盘根被拒', driveRoot.error, 'workspace_missing');
        eq('盘根拒绝原因 drive_root', driveRoot.reason, 'drive_root');
      }
      ok('isInsideRoot 命中子路径', V.isInsideRoot(ws, path.join(ws, 'sub', 'x')) === true);
      ok('isInsideRoot 拒绝外部路径', V.isInsideRoot(ws, path.join(root, 'other')) === false);

      // 1b. 快照 diff（真实文件改动；跳过 node_modules）
      const s1 = V.snapshotWorkdir(ws);
      ok('快照成功且跳过 node_modules', s1.ok === true && s1.files['node_modules/pkg/x.js'] === undefined,
        JSON.stringify(Object.keys(s1.files)));
      fs.writeFileSync(path.join(ws, 'b.txt'), '2', 'utf8');
      fs.writeFileSync(path.join(ws, 'a.txt'), 'changed!', 'utf8');
      fs.writeFileSync(path.join(ws, 'sub', 'c.txt'), '3', 'utf8');
      fs.unlinkSync(path.join(ws, 'sub', 'c.txt'));
      const s2 = V.snapshotWorkdir(ws);
      const diff = V.diffSnapshots(s1, s2);
      ok('diff created 含 b.txt', diff.created.includes('b.txt'), JSON.stringify(diff));
      ok('diff modified 含 a.txt', diff.modified.includes('a.txt'), JSON.stringify(diff));
      ok('diff 不把已删除又新建的 c.txt 当 created', !diff.created.includes('sub/c.txt'), JSON.stringify(diff));

      // 1c. settle：静默 1s 才稳定；持续写入则超时
      const t0 = Date.now();
      const writer = setTimeout(() => { try { fs.writeFileSync(path.join(ws, 'settle.txt'), String(Date.now()), 'utf8'); } catch (e) { /* ignore */ } }, 120);
      const settled = await V.settleWorkdir(ws, { stableMs: 300, maxMs: 1500, intervalMs: 60 });
      clearTimeout(writer);
      ok('settle 检测到中途写入后仍然稳定', settled.settled === true, JSON.stringify(settled));
      ok('settle 等待时间 ≥ stableMs', settled.waitedMs >= 250, 'waitedMs=' + settled.waitedMs + ' elapsed=' + (Date.now() - t0));

      let churn = true;
      const churnTimer = setInterval(() => { if (churn) { try { fs.writeFileSync(path.join(ws, 'churn.txt'), String(Math.random()), 'utf8'); } catch (e) { /* ignore */ } } }, 80);
      const busy = await V.settleWorkdir(ws, { stableMs: 300, maxMs: 650, intervalMs: 50 });
      churn = false;
      clearInterval(churnTimer);
      ok('持续写入 → settle 超时（settled=false）', busy.settled === false, JSON.stringify(busy));
      ok('settle 超时标 settleTimedOut 语义', busy.reason === 'settle_timeout', String(busy.reason));

      // 1d. runVerify 四态（真跑 cmd /d /s /c）
      const vPass = await V.runVerify('node -e "process.exit(0)"', { cwd: ws });
      eq('verify 退出 0 → pass', vPass.verdict, 'pass');
      const vFail = await V.runVerify('node -e "process.exit(7)"', { cwd: ws });
      eq('verify 退出 7 → fail', vFail.verdict, 'fail');
      eq('verify fail 带退出码', vFail.exitCode, 7);
      const vEnoent = await V.runVerify(`node -e "require('fs').readFileSync('no-such-business-file.txt')"`, { cwd: ws });
      eq('业务文件 ENOENT → fail', vEnoent.verdict, 'fail');
      ok('ENOENT fail 原因指向业务文件', /业务文件|ENOENT/.test(vEnoent.why), vEnoent.why);
      const vBroken = await V.runVerify('definitely-not-a-command-xyz --nope', { cwd: ws });
      eq('命令不存在 → broken', vBroken.verdict, 'broken');
      // 纯分类：Python 缺业务文件是 fail，不是环境坏；cmd 不认识 node 才是 broken
      eq('Python 缺业务文件 → fail',
        V.classifyVerifyFailure({
          exitCode: 2,
          output: "python: can't open file 'check.py': [Errno 2] No such file or directory",
          command: 'python check.py',
        }).verdict, 'fail');
      eq('node 不被 cmd 认识 → broken',
        V.classifyVerifyFailure({
          exitCode: 1,
          output: "'node' is not recognized as an internal or external command",
          command: 'node x.js',
        }).verdict, 'broken');
      ok('相对路径业务脚本存在性按 cwd 判定',
        V.commandExists('./exists-check.js', { cwd: ws }) === false,
        'ws 里没有 exists-check.js');
      const tVerify = Date.now();
      const vTimeout = await V.runVerify('node -e "setTimeout(()=>{},5000)"', { cwd: ws, timeoutMs: 1200 });
      eq('verify 超时 → timeout', vTimeout.verdict, 'timeout');
      ok('verify 超时在 3s 内收口', Date.now() - tVerify < 3000, 'took=' + (Date.now() - tVerify));
      const vNone = await V.runVerify('', { cwd: ws });
      eq('空 verify → none', vNone.verdict, 'none');
      const vSpawnEnoent = await V.runVerify('irrelevant', {
        cwd: ws,
        spawnImpl: () => { const e = new Error('spawn cmd ENOENT'); e.code = 'ENOENT'; throw e; },
      });
      eq('shell 启动 ENOENT → broken', vSpawnEnoent.verdict, 'broken');
    } finally { cleanup(root); }
  }

  // ══ 2. runner：事件解析 + 真 node 子进程取消 ═════════════════════════════
  dbg('section 2 runner');
  {
    const parsed = R.parseDshLine('{"type":"session","sessionId":"s-1"}');
    eq('parse session', parsed && parsed.kind, 'session');
    eq('parse final', R.parseDshLine('{"type":"final","text":"ok"}').kind, 'final');
    eq('parse tool', R.parseDshLine('{"type":"tool","name":"write_file"}').kind, 'tool');
    eq('parse status', R.parseDshLine('{"type":"status","reason":{"kind":"error","error":{"message":"bad"}}}').kind, 'status');
    eq('parse 聚合 JSON', R.parseDshLine('{"ok":true,"text":"done","tools":["a"]}').kind, 'aggregate');
    eq('未知事件仍可解析（DSH 漂移）', R.parseDshLine('{"type":"new-thing","x":1}').kind, 'unknown');
    eq('非 JSON 行返回 null', R.parseDshLine('hello'), null);

    // 2a. 事件 → result
    const fake = fakeChild({
      lines: [
        { type: 'session', sessionId: 'sess-runner' },
        { type: 'tool', name: 'read_file' },
        { type: 'tool', name: 'write_file' },
        { type: 'final', text: 'runner 完成' },
      ],
      exitCode: 0,
      delay: 20,
    });
    const runner1 = R.createDispatchRunner({ spawnImpl: () => fake });
    const h1 = runner1.start({ taskId: 'runner-events', task: 'x' });
    const info1 = await h1.result;
    eq('runner 解析 sessionId', info1.sessionId, 'sess-runner');
    eq('runner 解析 final text', info1.text, 'runner 完成');
    ok('runner 解析 tools', info1.tools.length === 2 && info1.tools.includes('write_file'), JSON.stringify(info1.tools));
    ok('runner 正常退出 ok=true', info1.ok === true);
    eq('退出后句柄被移除', runner1.get('runner-events'), null);

    // 2a2. final 事件也带 sessionId（续聊判据不能只依赖 session 事件）
    const fakeFinal = fakeChild({
      lines: [{ type: 'final', sessionId: 'sess-final-only', text: '只有 final' }],
      exitCode: 0,
      delay: 15,
    });
    const runnerFinal = R.createDispatchRunner({ spawnImpl: () => fakeFinal });
    const hFinal = runnerFinal.start({ taskId: 'runner-final-session', task: 'x' });
    const infoFinal = await hFinal.result;
    eq('final 事件补 sessionId', infoFinal.sessionId, 'sess-final-only');

    // 2b. 真取消：spawn 一个真 node 子进程，默认 taskkill /T /F
    const runner2 = R.createDispatchRunner({
      spawnImpl: (exe, args, opts) => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true }),
      pollMs: 50,
    });
    const h2 = runner2.start({ taskId: 'runner-real-cancel', task: 'x' });
    await sleep(250);
    ok('真子进程已启动且在跑', h2.pid > 0 && pidAlive(h2.pid), 'pid=' + h2.pid);
    const tc = Date.now();
    const cancelled = await h2.cancel({ graceMs: 2000 });
    const cancelTook = Date.now() - tc;
    ok('真取消成功（进程树消失）', cancelled.ok === true, JSON.stringify(cancelled));
    ok('取消 p95 目标 <2s', cancelTook < 2000, 'took=' + cancelTook);
    await sleep(150);
    ok('取消后 pid 不再存活', pidAlive(h2.pid) === false, 'pid=' + h2.pid);
    eq('取消后再查句柄已消失', runner2.get('runner-real-cancel'), null);
  }

  // ══ 3. vts-server 集成：verify/返工/workspace/取消 ═══════════════════════
  dbg('section 3 server');
  const root = tempRoot('p1-server-');
  const ws = path.join(root, 'workspace');
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'seed.txt'), 'seed', 'utf8');
  let probe = null;
  try {
    const { cfgPath, room } = writeConfig(root, {
      ledger_v2: true,
      workspaces: { w: ws, gone: path.join(root, 'not-there-workspace') },
      defaultWorkspace: '',
      cancel: true, verify: true, workspace: true,
      verify_timeout_ms: 60000, rework_max: 1, cancel_grace_ms: 2000,
    });
    const dispatchLog = [];
    let mode = 'ok-verify-pass';
    let lastChild = null;
    let call = 0;
    // partialWrites 时间窗用例：任务开始前就存在的旧文件，mtime 固定一年前。
    const oldMtime = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const dispatchSpawn = (exe, args, opts) => {
      call += 1;
      dispatchLog.push({ exe, args: Array.isArray(args) ? args.slice() : [], cwd: opts && opts.cwd });
      const cwd = (opts && opts.cwd) || ws;
      const child = (() => {
        switch (mode) {
          case 'ok-verify-pass':
            return fakeChild({
              lines: [{ type: 'session', sessionId: 's-pass' }, { type: 'final', text: '写完了 PASS 任务' }],
              exitCode: 0,
              delay: 30,
              beforeExit: () => { fs.writeFileSync(path.join(cwd, 'out-pass.txt'), 'PASS', 'utf8'); },
            });
          case 'ok-verify-fail':
            return fakeChild({
              lines: [{ type: 'final', text: '第一版做完了' }],
              exitCode: 0,
              delay: 30,
              beforeExit: () => { fs.writeFileSync(path.join(cwd, 'out-fail.txt'), 'v' + call, 'utf8'); },
            });
          case 'ok-verify-broken':
            return fakeChild({ lines: [{ type: 'final', text: '完成' }], exitCode: 0, delay: 20 });
          case 'ok-verify-timeout':
            return fakeChild({ lines: [{ type: 'final', text: '完成' }], exitCode: 0, delay: 20 });
          case 'hang-with-write':
            return fakeChild({
              hang: true,
              beforeExit: null,
            });
          case 'hang-no-exit':
            return fakeChild({ hang: true });
          case 'backend-timeout-verify-pass':
            return fakeChild({ hang: true });
          case 'spawn-error': {
            // Node 的真实行为：exe 不存在时 spawn 不抛，异步 emit('error') 且没有 pid。
            const c = new EventEmitter();
            c.stdout = new PassThrough();
            c.stderr = new PassThrough();
            c.killed = false;
            c.kill = () => true;
            setTimeout(() => {
              const e = new Error('spawn dsh ENOENT');
              e.code = 'ENOENT';
              c.emit('error', e);
            }, 10);
            return c;
          }
          default:
            return fakeChild({ lines: [{ type: 'final', text: '默认' }], exitCode: 0, delay: 20 });
        }
      })();
      lastChild = child;
      if (mode === 'hang-with-write') {
        setTimeout(() => {
          try {
            fs.writeFileSync(path.join(cwd, 'during-cancel.txt'), 'partial', 'utf8');
            // 2026-11-23 partialWrites 时间窗：任务中真改的旧文件（mtime 保持一年前）
            // 不应进 partialWrites；任务中正常写的新/改文件应进。
            fs.writeFileSync(path.join(cwd, 'old-mtime2.txt'), 'BBBBBB', 'utf8');
            fs.utimesSync(path.join(cwd, 'old-mtime2.txt'), oldMtime, oldMtime);
            fs.writeFileSync(path.join(cwd, 'fresh-modified.txt'), 'fresh-content', 'utf8');
          } catch (e) { /* ignore */ }
        }, 120);
      }
      return child;
    };
    // 假 child 的「进程树消失」：emit exit（真 taskkill 在 runner 单测里已经真跑过）
    const dispatchKill = (pid, child) => {
      try { if (child && typeof child.emit === 'function') child.emit('exit', null); } catch (e) { /* ignore */ }
      return { ok: true, injected: true, pid };
    };

    probe = await startProbeServer({ cfgPath, dispatchSpawn, dispatchKill });
    ok('P1 测试服务器可用（临时端口）', probe.healthy);
    const token = fs.readFileSync(path.join(room, '.control-token'), 'utf8').trim();

    // 3a. verify pass → done_verified + 证据（真实文件 diff）
    mode = 'ok-verify-pass';
    let r = await request(probe.port, 'POST', '/dispatch', {
      body: {
        task: '在 workspace 里写一个 PASS 文件', taskId: 'p1-pass', requestId: 'req-p1-pass',
        workspace: 'w', verify: 'node -e "process.exit(0)"', timeoutMs: 5000,
      },
    });
    eq('verify pass HTTP 200', r.status, 200);
    eq('verify pass state=done', r.json && r.json.state, 'done');
    eq('verify pass outcome=done_verified', r.json && r.json.outcome, 'done_verified');
    eq('verify pass verdict=pass', r.json && r.json.verify && r.json.verify.verdict, 'pass');
    ok('verify pass 证据含 out-pass.txt', r.json && r.json.evidence
      && (r.json.evidence.created || []).includes('out-pass.txt'), JSON.stringify(r.json && r.json.evidence));
    let d = await request(probe.port, 'GET', '/dispatch/tasks?id=p1-pass', { token });
    ok('账本记录 workspaceAlias=w', d.json && d.json.task && d.json.task.workspaceAlias === 'w', JSON.stringify(d.json && d.json.task && d.json.task.workspaceAlias));
    ok('账本 workspaceRealpath 是同一 realpath',
      d.json && d.json.task && path.resolve(d.json.task.workspaceRealpath || '') === path.resolve(ws));
    eq('账本 verify.verdict=pass', d.json && d.json.task && d.json.task.verify && d.json.task.verify.verdict, 'pass');
    ok('DSH 子进程 cwd = workspace realpath', dispatchLog.length > 0
      && path.resolve(dispatchLog[dispatchLog.length - 1].cwd) === path.resolve(ws),
      JSON.stringify(dispatchLog[dispatchLog.length - 1] || {}));
    ok('账本 JSON 里证据已落盘（out-pass.txt）',
      fs.readFileSync(path.join(room, 'dispatch-tasks', 'p1-pass.json'), 'utf8').includes('out-pass.txt'));

    // 3b. verify fail + 返工 1 轮 → 仍 failed；rounds=2；注入失败输出/改动文件/只修不推倒
    mode = 'ok-verify-fail';
    const beforeFailSpawn = dispatchLog.length;
    r = await request(probe.port, 'POST', '/dispatch', {
      body: {
        task: '写一个会验收失败的文件', taskId: 'p1-fail', requestId: 'req-p1-fail',
        workspace: 'w', verify: `node -e "console.error('TEST_FAIL_REASON');process.exit(2)"`,
        rework: 1, timeoutMs: 5000,
      },
    });
    eq('verify fail → state=failed', r.json && r.json.state, 'failed');
    eq('verify fail → outcome=failed', r.json && r.json.outcome, 'failed');
    eq('verify fail verdict=fail', r.json && r.json.verify && r.json.verify.verdict, 'fail');
    eq('返工 1 轮：DSH 被起 2 次', dispatchLog.length - beforeFailSpawn, 2);
    d = await request(probe.port, 'GET', '/dispatch/tasks?id=p1-fail', { token });
    ok('账本 verify.rounds 记录 2 轮', d.json && d.json.task && d.json.task.verify
      && Array.isArray(d.json.task.verify.rounds) && d.json.task.verify.rounds.length === 2,
      JSON.stringify(d.json && d.json.task && d.json.task.verify && d.json.task.verify.rounds));
    const secondSpawn = dispatchLog[dispatchLog.length - 1];
    const reworkText = String(secondSpawn.args[secondSpawn.args.length - 1] || '');
    ok('返工任务注入「只修不推倒」', reworkText.includes('只修不推倒'), reworkText.slice(0, 120));
    ok('返工任务注入失败输出', reworkText.includes('TEST_FAIL_REASON'), reworkText.slice(0, 300));
    ok('返工任务注入上次改动文件', reworkText.includes('out-fail.txt'), reworkText.slice(0, 400));
    ok('返工是全新会话（不带 --session-id）', !secondSpawn.args.includes('--session-id'), JSON.stringify(secondSpawn.args));

    // 3c. verify 命令坏 → broken → done_unproven（不返工）
    mode = 'ok-verify-broken';
    const beforeBrokenSpawn = dispatchLog.length;
    r = await request(probe.port, 'POST', '/dispatch', {
      body: {
        task: '验收命令本身坏掉的任务', taskId: 'p1-broken', requestId: 'req-p1-broken',
        workspace: 'w', verify: 'definitely-not-a-command-xyz', rework: 3, timeoutMs: 5000,
      },
    });
    eq('broken → state=done', r.json && r.json.state, 'done');
    eq('broken → outcome=done_unproven', r.json && r.json.outcome, 'done_unproven');
    eq('broken → verdict=broken', r.json && r.json.verify && r.json.verify.verdict, 'broken');
    eq('broken 不返工（只起 1 次）', dispatchLog.length - beforeBrokenSpawn, 1);

    // 3d. verify 超时 → done_unproven（不返工）
    mode = 'ok-verify-timeout';
    r = await request(probe.port, 'POST', '/dispatch', {
      body: {
        task: '验收命令超时的任务', taskId: 'p1-vtimeout', requestId: 'req-p1-vtimeout',
        workspace: 'w', verify: 'node -e "setTimeout(()=>{},9000)"', verifyTimeoutMs: 5000,
        rework: 3, timeoutMs: 5000,
      },
    });
    eq('verify timeout → state=done', r.json && r.json.state, 'done');
    eq('verify timeout → outcome=done_unproven', r.json && r.json.outcome, 'done_unproven');
    eq('verify timeout → verdict=timeout', r.json && r.json.verify && r.json.verify.verdict, 'timeout');

    // 3e. workspace 校验：未知/缺失 → 400 attempted=false 不消耗
    const beforeWsErr = dispatchLog.length;
    r = await request(probe.port, 'POST', '/dispatch', {
      body: { task: '用不存在的别名', taskId: 'p1-badws', requestId: 'req-p1-badws', workspace: 'nope' },
    });
    eq('未知 workspace → HTTP 400', r.status, 400);
    eq('未知 workspace 错误码', r.json && r.json.error, 'unknown_workspace');
    eq('未知 workspace attempted=false', r.json && r.json.attempted, false);
    eq('未知 workspace 不 spawn', dispatchLog.length, beforeWsErr);
    r = await request(probe.port, 'POST', '/dispatch', {
      body: { task: '工作目录不存在', taskId: 'p1-missws', requestId: 'req-p1-missws', workspace: 'gone' },
    });
    eq('缺失 workspace → HTTP 400', r.status, 400);
    eq('缺失 workspace 错误码', r.json && r.json.error, 'workspace_missing');
    eq('缺失 workspace attempted=false', r.json && r.json.attempted, false);
    ok('缺失 workspace 不落 running 账本',
      !fs.existsSync(path.join(room, 'dispatch-tasks', 'p1-missws.json')));

    // 3e2. 异步 spawn 失败（ENOENT error 事件、无 pid）→ spawn_failed + attempted=false
    mode = 'spawn-error';
    r = await request(probe.port, 'POST', '/dispatch', {
      body: { task: '执行器不存在时的派活', taskId: 'p1-spawnerr', requestId: 'req-p1-spawnerr', timeoutMs: 5000 },
    });
    eq('异步 spawn ENOENT → state=failed', r.json && r.json.state, 'failed');
    eq('异步 spawn ENOENT → stateReason=spawn_failed', r.json && r.json.stateReason, 'spawn_failed');
    eq('异步 spawn ENOENT → attempted=false（唯一可安全重派）', r.json && r.json.attempted, false);
    d = await request(probe.port, 'GET', '/dispatch/tasks?id=p1-spawnerr', { token });
    eq('账本异步 spawn 失败 attempted=false', d.json && d.json.task && d.json.task.attempted, false);

    // 3f. HTTP cwd 仍被忽略：即便传了 cwd，子进程 cwd 还是 workspace realpath
    mode = 'ok-verify-broken';
    r = await request(probe.port, 'POST', '/dispatch', {
      body: {
        task: '试试偷偷传 cwd', taskId: 'p1-cwd', requestId: 'req-p1-cwd',
        workspace: 'w', cwd: 'C:/Windows', timeoutMs: 5000,
      },
    });
    eq('带 workspace 的任务正常完成', r.json && r.json.state, 'done');
    const cwdSpawn = dispatchLog[dispatchLog.length - 1];
    ok('HTTP cwd 被忽略（cwd=workspace realpath）',
      path.resolve(cwdSpawn.cwd) === path.resolve(ws), JSON.stringify({ cwd: cwdSpawn.cwd, ws }));

    // 3g. 取消：长任务写了一半 → cancelled + partialWrites + 幂等
    mode = 'hang-with-write';
    // 任务开始前的旧文件 + 任务中被改的文件（partialWrites 时间窗）
    fs.writeFileSync(path.join(ws, 'old-mtime2.txt'), 'AAAA', 'utf8');
    fs.utimesSync(path.join(ws, 'old-mtime2.txt'), oldMtime, oldMtime);
    fs.writeFileSync(path.join(ws, 'fresh-modified.txt'), 'old', 'utf8');
    const cancelBody = {
      task: '跑一个会被取消的长任务', taskId: 'p1-cancel', requestId: 'req-p1-cancel',
      workspace: 'w', timeoutMs: 60000,
    };
    const pending = request(probe.port, 'POST', '/dispatch', { body: cancelBody, timeoutMs: 30000 });
    await sleep(400);   // 让 fake child 写下 during-cancel.txt
    const tc0 = Date.now();
    r = await request(probe.port, 'POST', '/dispatch/cancel', { body: { taskId: 'p1-cancel' } });
    const cancelTook = Date.now() - tc0;
    eq('取消 HTTP 200', r.status, 200);
    eq('取消 ok=true', r.json && r.json.ok, true);
    eq('取消 state=cancelled', r.json && r.json.state, 'cancelled');
    eq('取消 outcome=null', r.json && r.json.outcome, null);
    eq('取消固定话术', r.json && r.json.message, '已停止；已经写下的文件不会回滚');
    ok('取消 ≤2s', cancelTook < 2000, 'took=' + cancelTook);
    ok('partialWrites 含 during-cancel.txt', Array.isArray(r.json && r.json.partialWrites)
      && r.json.partialWrites.includes('during-cancel.txt'), JSON.stringify(r.json && r.json.partialWrites));
    // 2026-11-23 partialWrites 时间窗：只算任务开始后（-2s 容差）的修改
    ok('partialWrites 含任务中正常改的 fresh-modified.txt', Array.isArray(r.json && r.json.partialWrites)
      && r.json.partialWrites.includes('fresh-modified.txt'), JSON.stringify(r.json && r.json.partialWrites));
    ok('partialWrites 不含 mtime 在任务前的 old-mtime2.txt', Array.isArray(r.json && r.json.partialWrites)
      && !r.json.partialWrites.includes('old-mtime2.txt'), JSON.stringify(r.json && r.json.partialWrites));
    d = await request(probe.port, 'GET', '/dispatch/tasks?id=p1-cancel', { token });
    ok('evidence.modified 保留全量（含 old-mtime2.txt）', d.json && d.json.task && d.json.task.evidence
      && Array.isArray(d.json.task.evidence.modified) && d.json.task.evidence.modified.includes('old-mtime2.txt'),
      JSON.stringify(d.json && d.json.task && d.json.task.evidence && d.json.task.evidence.modified));
    ok('evidence.modifiedSinceTask 含 fresh-modified.txt', d.json && d.json.task && d.json.task.evidence
      && Array.isArray(d.json.task.evidence.modifiedSinceTask)
      && d.json.task.evidence.modifiedSinceTask.includes('fresh-modified.txt'),
      JSON.stringify(d.json && d.json.task && d.json.task.evidence && d.json.task.evidence.modifiedSinceTask));
    ok('evidence.modifiedSinceTask 不含 old-mtime2.txt', d.json && d.json.task && d.json.task.evidence
      && Array.isArray(d.json.task.evidence.modifiedSinceTask)
      && !d.json.task.evidence.modifiedSinceTask.includes('old-mtime2.txt'),
      JSON.stringify(d.json && d.json.task && d.json.task.evidence && d.json.task.evidence.modifiedSinceTask));
    const dispatchResp = await pending;
    eq('原 /dispatch 请求被取消收口', dispatchResp.json && dispatchResp.json.state, 'cancelled');
    r = await request(probe.port, 'POST', '/dispatch/cancel', { body: { taskId: 'p1-cancel' } });
    eq('重复取消仍 cancelled', r.json && r.json.state, 'cancelled');
    eq('重复取消标 already', r.json && r.json.already, true);
    r = await request(probe.port, 'POST', '/dispatch/cancel', { body: { taskId: 'no-such' } });
    eq('取消不存在 → 404', r.status, 404);

    // 3h. 无句柄（模拟重启后）：cannot_cancel + unknown，不猜 pid
    const led = probe.server.dispatchLedger;
    led.create({ taskId: 'p1-orphan', requestId: 'req-p1-orphan', taskText: '重启前正在跑的孤儿任务' });
    led.markAttempted('p1-orphan', { startedAt: Date.now() });
    r = await request(probe.port, 'POST', '/dispatch/cancel', { body: { taskId: 'p1-orphan' } });
    eq('无句柄取消 ok=false', r.json && r.json.ok, false);
    eq('无句柄取消 cannot_cancel', r.json && r.json.error, 'cannot_cancel');
    eq('无句柄取消 state=unknown', r.json && r.json.state, 'unknown');
    eq('无句柄取消 stateReason=restart', r.json && r.json.stateReason, 'restart');
    d = await request(probe.port, 'GET', '/dispatch/tasks?id=p1-orphan', { token });
    eq('账本被置 unknown', d.json && d.json.task && d.json.task.state, 'unknown');
    eq('账本 unknown 原因 restart', d.json && d.json.task && d.json.task.stateReason, 'restart');

    // 3i. 超时后仍跑一次 verify：pass → done_verified（§4.2）
    mode = 'backend-timeout-verify-pass';
    r = await request(probe.port, 'POST', '/dispatch', {
      body: {
        task: '超时但产物已写好的任务', taskId: 'p1-timeout-verify', requestId: 'req-p1-timeout-verify',
        workspace: 'w', verify: 'node -e "process.exit(0)"', timeoutMs: 300,
      },
    });
    eq('超时后 verify pass → state=done', r.json && r.json.state, 'done');
    eq('超时后 verify pass → done_verified', r.json && r.json.outcome, 'done_verified');
    eq('超时后 verify pass verdict=pass', r.json && r.json.verify && r.json.verify.verdict, 'pass');

    // 3j. 断线：先 unknown；子进程退出后 verify 仍跑一次并补进账本
    mode = 'hang-no-exit';
    const dBody = {
      task: '断线后仍要补验收的任务', taskId: 'p1-disc', requestId: 'req-p1-disc',
      workspace: 'w', verify: 'node -e "process.exit(0)"', timeoutMs: 30000,
    };
    await new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify(dBody), 'utf8');
      const req = http.request({
        host: '127.0.0.1', port: probe.port, path: '/dispatch', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      }, () => { /* 不要响应 */ });
      req.on('error', () => resolve());
      req.write(body); req.end();
      setTimeout(() => { try { req.destroy(); } catch (e) { /* ignore */ } resolve(); }, 180);
    });
    let disc = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(100);
      const g = await request(probe.port, 'GET', '/dispatch/tasks?id=p1-disc', { token });
      if (g.json && g.json.task && g.json.task.state === 'unknown') { disc = g.json.task; break; }
    }
    eq('断线 → state=unknown', disc && disc.state, 'unknown');
    ok('断线时 verify 还没跑（不伪造证据）', !disc || !disc.verify, JSON.stringify(disc && disc.verify));
    const discChild = lastChild;
    try { discChild.emit('exit', 0); } catch (e) { /* ignore */ }
    let discVerify = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(120);
      const g = await request(probe.port, 'GET', '/dispatch/tasks?id=p1-disc', { token });
      if (g.json && g.json.task && g.json.task.verify) { discVerify = g.json.task.verify; break; }
    }
    ok('断线后 verify 仍跑了一次', !!discVerify, '未补上 verify');
    eq('断线 verify 结果 pass', discVerify && discVerify.verdict, 'pass');
    d = await request(probe.port, 'GET', '/dispatch/tasks?id=p1-disc', { token });
    eq('断线补证据后 state 仍是 unknown（不被 late verify 翻案）',
      d.json && d.json.task && d.json.task.state, 'unknown');
  } finally {
    try { if (probe && probe.server) probe.server.close(); } catch (e) { /* ignore */ }
    cleanup(root);
  }

  // ══ 4. 开关：ledger_v2=false / verify=false / workspace=false 明确报错 ═══
  dbg('section 4 switches');
  {
    const offRoot = tempRoot('p1-switches-');
    let offProbe = null;
    try {
      // 4a. ledger_v2=false：verify/workspace 明确不可用（不静默忽略）
      const { cfgPath: offCfg, room: offRoom } = writeConfig(offRoot, { ledger_v2: false });
      offProbe = await startProbeServer({
        cfgPath: offCfg,
        dispatchSpawn: () => fakeChild({ lines: [{ type: 'final', text: '旧路径' }], exitCode: 0, delay: 20 }),
        dispatchKill: () => ({ ok: true }),
      });
      ok('ledger_v2=false 服务器可用', offProbe.healthy);
      let r = await request(offProbe.port, 'POST', '/dispatch', {
        body: { task: '旧路径带 verify', taskId: 'off-verify', requestId: 'req-off-verify', verify: 'node -e "process.exit(0)"' },
      });
      eq('ledger_v2=false + verify → HTTP 400', r.status, 400);
      eq('ledger_v2=false + verify 错误码', r.json && r.json.error, 'ledger_disabled');
      eq('ledger_v2=false + verify attempted=false', r.json && r.json.attempted, false);
      r = await request(offProbe.port, 'POST', '/dispatch/cancel', { body: { taskId: 'x' } });
      eq('ledger_v2=false 取消 → ledger_disabled', r.json && r.json.error, 'ledger_disabled');
      ok('ledger_v2=false 不写账本目录', !fs.existsSync(path.join(offRoom, 'dispatch-tasks')));
      try { offProbe.server.close(); } catch (e) { /* ignore */ }
      offProbe = null;

      // 4b. verify/workspace 开关关掉 → 400，且不 spawn
      const swRoot = path.join(offRoot, 'sw');
      fs.mkdirSync(path.join(swRoot, 'workspace'), { recursive: true });
      const { cfgPath: swCfg } = writeConfig(swRoot, {
        ledger_v2: true,
        workspaces: { w: path.join(swRoot, 'workspace') },
        cancel: true, verify: false, workspace: false,
      });
      let spawnCount = 0;
      offProbe = await startProbeServer({
        cfgPath: swCfg,
        dispatchSpawn: () => { spawnCount += 1; return fakeChild({ exitCode: 0, delay: 20 }); },
        dispatchKill: () => ({ ok: true }),
      });
      r = await request(offProbe.port, 'POST', '/dispatch', {
        body: { task: '验收被关掉', taskId: 'off-v', requestId: 'req-off-v', verify: 'node -e "process.exit(0)"' },
      });
      eq('verify=false → HTTP 400', r.status, 400);
      eq('verify=false 错误码 verify_disabled', r.json && r.json.error, 'verify_disabled');
      r = await request(offProbe.port, 'POST', '/dispatch', {
        body: { task: '工作区被关掉', taskId: 'off-w', requestId: 'req-off-w', workspace: 'w' },
      });
      eq('workspace=false → HTTP 400', r.status, 400);
      eq('workspace=false 错误码 workspace_disabled', r.json && r.json.error, 'workspace_disabled');
      eq('两个开关错误都不 spawn', spawnCount, 0);
    } finally {
      try { if (offProbe && offProbe.server) offProbe.server.close(); } catch (e) { /* ignore */ }
      cleanup(offRoot);
    }
  }

  // ══ 5. 插件工具面：schema 透传 / dispatch_cancel / _check 字段 ═══════════
  dbg('section 5 plugin');
  {
    const DispatchPlugin = require(PLUGIN_MOD);
    const logs = [];
    const mkPlugin = (extraCfg) => new DispatchPlugin({ name: 'dispatch' }, {
      log: (lvl, msg) => logs.push(lvl + ':' + msg),
      getPluginFileConfig: () => Object.assign({
        control_port: 8103, timeout_seconds: 900, auto_receipt: false, max_concurrent: 2,
        verify_default_on: true, verify_timeout_ms: 45000, rework_max: 2, cancel_grace_ms: 1800,
      }, extraCfg || {}),
    });
    const plugin = mkPlugin();
    await plugin.onInit();
    eq('插件读取 verify_timeout_ms', plugin._verifyTimeoutMs, 45000);
    eq('插件读取 rework_max', plugin._reworkMax, 2);
    eq('插件读取 cancel_grace_ms', plugin._cancelGraceMs, 1800);

    const tools = plugin.getTools();
    const byName = Object.fromEntries(tools.map((t) => [t.function.name, t.function]));
    ok('工具面含 dispatch_cancel', !!byName.dispatch_cancel);
    ok('dispatch_cancel 必填 id', byName.dispatch_cancel
      && (byName.dispatch_cancel.parameters.required || []).includes('id'));
    ok('dispatch_to_dsh schema 有 verify', !!byName.dispatch_to_dsh
      && !!byName.dispatch_to_dsh.parameters.properties.verify);
    ok('dispatch_to_dsh schema 有 workspace', !!byName.dispatch_to_dsh
      && !!byName.dispatch_to_dsh.parameters.properties.workspace);

    // 5a. workspace 路径形状在插件入口就被拒（不消耗服务端、不连 8103）
    let out = JSON.parse(await plugin._start({ task: '写一个测试文件', workspace: 'D:/evil/path' }));
    eq('插件拒绝 path 形状 workspace', out.ok, false);
    ok('拒绝原因说明只接受别名', /别名/.test(String(out.error)), String(out.error));
    // 5a2. verify 能力关闭时明确报错（不静默忽略）
    const noVerify = mkPlugin({ verify_default_on: false });
    await noVerify.onInit();
    out = JSON.parse(await noVerify._start({ task: '写一个测试文件', verify: 'node -e "process.exit(0)"' }));
    eq('verify_default_on=false 时拒绝 verify', out.ok, false);
    ok('拒绝原因说明验收已关闭', /验收能力已关闭/.test(String(out.error)), String(out.error));

    // 5b. _cancel 透传 route/body（不真连 8103）
    let captured = null;
    plugin._ledgerV2Enabled = () => true;
    plugin._post8103 = async (route, body, timeoutMs) => {
      captured = { route, body, timeoutMs };
      return { ok: true, state: 'cancelled', partialWrites: ['a.txt'], message: '已停止；已经写下的文件不会回滚', cancelTookMs: 42 };
    };
    out = JSON.parse(await plugin._cancel({ id: 'task-9' }));
    eq('_cancel 调 /dispatch/cancel', captured && captured.route, '/dispatch/cancel');
    eq('_cancel 传 taskId', captured && captured.body.taskId, 'task-9');
    eq('_cancel 传 cancel_grace_ms', captured && captured.body.graceMs, 1800);
    eq('_cancel 返回 cancelled', out.state, 'cancelled');
    eq('_cancel 回执保留 partialWrites', out.partialWrites[0], 'a.txt');
    eq('_cancel 回执固定话术', out.message, '已停止；已经写下的文件不会回滚');

    // 5c. _check 读账本时带 verify/outcome/evidence（用假 _ledgerGet）
    plugin._ledgerGet = async () => ({
      status: 200,
      json: {
        ok: true,
        task: {
          taskId: 'task-v', state: 'done', outcome: 'done_verified', stateReason: null,
          attempted: true, text: 'ok', error: '', tookMs: 100, taskText: '任务',
          verify: { verdict: 'pass', exitCode: 0, rounds: [{ round: 0 }], output: 'PASS', why: '验收通过' },
          evidence: { changed: true, created: ['a.txt'], modified: [], deleted: [], settleMs: 1000, unavailableReason: null },
          workspaceAlias: 'w',
        },
      },
    });
    out = JSON.parse(await plugin._check({ id: 'task-v' }));
    eq('_check 读 outcome', out.outcome, 'done_verified');
    eq('_check 读 verify.verdict', out.verify && out.verify.verdict, 'pass');
    eq('_check 读 verify.rounds 数', out.verify && out.verify.rounds, 1);
    eq('_check 读 evidence.changed', out.evidence && out.evidence.changed, true);
    eq('_check 读 workspace', out.workspace, 'w');

    // 5d. _run 透传 verify/workspace/verifyTimeoutMs/rework；服务端 400 不伪装 unknown
    const slPath = path.join(APP, 'plugins', 'community', 'dispatch', 'skill-library.js');
    const sl = require(slPath);
    const origHistory = sl.recordHistory;
    sl.recordHistory = () => ({});
    let capturedPayload = null;
    const fakeHttp = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { capturedPayload = JSON.parse(raw); } catch (e) { capturedPayload = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unknown_workspace', attempted: false, detail: '没有这个别名' }));
      });
    });
    await new Promise((resolve) => fakeHttp.listen(0, '127.0.0.1', resolve));
    try {
      plugin._port = fakeHttp.address().port;
      plugin._tasks.set('task-run', {
        id: 'task-run', requestId: 'req-run', state: 'running',
        attempted: false, startedAt: Date.now(), task: '任务正文', text: '', error: '',
      });
      await plugin._run('task-run', '任务正文', { workspace: 'nope', verify: 'node -e "process.exit(0)"' });
      ok('_run 透传 payload（有请求体）', !!capturedPayload, '未收到请求');
      eq('_run 传 workspace', capturedPayload && capturedPayload.workspace, 'nope');
      eq('_run 传 verify', capturedPayload && capturedPayload.verify, 'node -e "process.exit(0)"');
      eq('_run 传 verifyTimeoutMs', capturedPayload && capturedPayload.verifyTimeoutMs, 45000);
      eq('_run 传 rework', capturedPayload && capturedPayload.rework, 2);
      ok('_run 不传 HTTP cwd（任意 cwd 从入口消失）',
        !capturedPayload || capturedPayload.cwd === undefined, JSON.stringify(capturedPayload && capturedPayload.cwd));
      const runRow = plugin._tasks.get('task-run');
      eq('服务端前置拒绝 → state=failed', runRow && runRow.state, 'failed');
      eq('服务端前置拒绝 → stateReason=unknown_workspace', runRow && runRow.stateReason, 'unknown_workspace');
      eq('服务端前置拒绝 → attempted=false', runRow && runRow.attempted, false);
    } finally {
      try { fakeHttp.close(); } catch (e) { /* ignore */ }
      sl.recordHistory = origHistory;
    }
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────
  const total = pass + fail;
  if (fail) {
    console.log('FAIL ' + fail + ' / ' + total);
    for (const f of failures) console.log('  ✗ ' + f);
    process.exitCode = 1;
  } else {
    console.log('PASS ' + pass + ' / ' + total);
  }
})().catch((e) => {
  console.error('FATAL ' + (e && e.stack || e));
  process.exitCode = 1;
});
