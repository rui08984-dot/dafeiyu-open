// _probe/test-dispatch-ledger.cjs —— 派活 v2 P0（可见+安全）验收用例
//
// 覆盖（设计 docs/设计-派活v2-2026-11-23.md §5「P0 可见+安全」）：
//   1. spawn 前 attempted 先落盘；spawn 同步失败 → failed + attempted:false（可安全重派）
//   2. 正常完成 → done_unproven（无 verify）；结果/耗时/工具名落账本
//   3. 超时 / 断线 → unknown + attempted:true；同 requestId 复用旧记录（reused:true，不重派）
//   4. 启动 recover：上次 running → unknown + restart
//   5. GET /dispatch/tasks：无 token → 401/403；列表只回 ≤120 字预览；详情才回全文
//   6. ledger_v2=false → 旧路径（不写任何账本文件）
//   7. JSONL 坏行不影响读取；超过 200 条终态裁剪最旧（未终态保留）
//
// 全程 mkdtemp 隔离：不碰真实 data、不连真实 8001/8102/8103、不 spawn 真 DSH。
// 用法：node _probe/test-dispatch-ledger.cjs   → 退出码 0 = 全过
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');

const PROJECT = path.join(__dirname, '..');
const APP = path.join(PROJECT, '_incoming', 'my-neuro', 'live-2d');
const LEDGER_MOD = path.join(APP, 'petbridge', 'dispatch-ledger.mjs');
const VTS_MOD = path.join(APP, 'petbridge', 'vts-server.mjs');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dispatch-ledger-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows 偶发占用 */ }
}

/** 避开 8001/8102/8103 —— 测试绝不碰真实端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const forbidden = new Set([8001, 8102, 8103]);
    const attempt = () => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        srv.close(() => (forbidden.has(port) ? attempt() : resolve(port)));
      });
    };
    attempt();
  });
}

function request(port, method, pathname, opts = {}) {
  const { token, body } = opts;
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (token !== undefined) headers['X-Pet-Token'] = token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ status: 0, text: 'timeout', json: null }); });
    req.on('error', (e) => resolve({ status: 0, text: String((e && e.message) || e), json: null }));
    if (data) req.write(data);
    req.end();
  });
}

async function waitHealthy(port) {
  for (let i = 0; i < 50; i += 1) {
    await sleep(80);
    const r = await request(port, 'GET', '/health');
    if (r.status === 200) return true;
  }
  return false;
}

/**
 * 假 DSH 子进程：EventEmitter + stdout/stderr 流 + kill。
 * autoExit=false 时永不退出（用来制造超时/断线）。
 */
function fakeChild({ stdout = '', exitCode = 0, autoExit = true, delay = 25 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 42000 + Math.floor(Math.random() * 1000);
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  if (autoExit) {
    const timer = setTimeout(() => {
      if (stdout) child.stdout.write(stdout);
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', exitCode);
    }, delay);
    if (timer.unref) timer.unref();
  }
  return child;
}

function writeConfig(dir, ledgerV2) {
  const appDir = path.join(dir, 'live-2d');
  fs.mkdirSync(appDir, { recursive: true });
  const cfgPath = path.join(appDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    dispatch: { ledger_v2: ledgerV2 !== false },
  }, null, 2), 'utf8');
  return { appDir, cfgPath, room: path.join(dir, 'data') };
}

async function startProbeServer(opts) {
  const { cfgPath, dispatchSpawn, dispatchKill = () => ({ ok: true, injected: true }), log = () => {} } = opts;
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
    // P1：runner 现在直接持有 child 句柄；测试里绝不真跑 taskkill（假 pid 会杀错真进程）。
    dispatchKill,
  });
  const healthy = await waitHealthy(pCtrl);
  return { server, port: pCtrl, healthy, ports: [pVts, pInner, pCtrl] };
}

(async () => {
  const { createDispatchLedger, readLedgerV2Enabled } = await import(pathToFileURL(LEDGER_MOD).href);
  ok('账本模块导出 createDispatchLedger', typeof createDispatchLedger === 'function');
  ok('账本模块导出 readLedgerV2Enabled', typeof readLedgerV2Enabled === 'function');

  // ── 1a. 账本层：attempted 是 spawn 前必须落盘的不可逆点 ────────────────
  {
    const root = tempRoot('dispatch-ledger-attempt-');
    try {
      const led = createDispatchLedger({ roomDir: path.join(root, 'data') });
      const secretTail = 'SECRET-TAIL-DO-NOT-LOG-' + 'z'.repeat(80);
      const bodyText = '写文件并改配置：' + 'a'.repeat(140) + secretTail;
      const row = led.create({ taskId: 'pre-spawn', requestId: 'req-pre', taskText: bodyText });
      eq('create 后 attempted=false', row.attempted, false);
      eq('create 后 state=running', row.state, 'running');
      led.markAttempted('pre-spawn', { startedAt: Date.now() });
      const onDisk = JSON.parse(fs.readFileSync(path.join(led.tasksDir, 'pre-spawn.json'), 'utf8'));
      eq('markAttempted 后磁盘 attempted=true', onDisk.attempted, true);
      eq('markAttempted 后磁盘 attemptCount=1', onDisk.attemptCount, 1);
      ok('attemptedAt 已写', Number(onDisk.attemptedAt) > 0, String(onDisk.attemptedAt));
      const jsonl = fs.readFileSync(led.jsonlPath, 'utf8');
      ok('JSONL 有 attempt 事件', /"type":"attempt"/.test(jsonl), jsonl.slice(0, 200));
      ok('JSONL 只有 preview，不写任务正文', !jsonl.includes(secretTail) && !jsonl.includes('"taskText"'), 'jsonl 泄漏了正文');
    } finally { cleanup(root); }
  }

  // ── 公共测试服务器（ledger_v2=true；spawn 可切换）───────────────────────
  const root = tempRoot('dispatch-ledger-server-');
  let probe = null;
  try {
    const { cfgPath, room } = writeConfig(root, true);
    const tokenFile = path.join(room, '.control-token');

    let spawnMode = 'ok';
    let spawnCount = 0;
    let spawnObservedAttempted = null;
    const spawnLog = [];
    const dispatchSpawn = (exe, args, spawnOpts) => {
      spawnCount += 1;
      spawnLog.push({ exe, args: Array.isArray(args) ? args.slice() : [], cwd: spawnOpts && spawnOpts.cwd });
      // spawn 刚好发生在「attempted 已落盘」之后：此刻同步读磁盘验证
      try {
        const tasksDir = path.join(room, 'dispatch-tasks');
        const rows = fs.readdirSync(tasksDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8')));
        const target = rows.find((r) => r.taskId === 'probe-ok');
        if (target) spawnObservedAttempted = target.attempted;
      } catch (e) { spawnObservedAttempted = 'read-error:' + e.message; }

      if (spawnMode === 'throw') throw new Error('boom-spawn');
      if (spawnMode === 'hang') return fakeChild({ autoExit: false });
      return fakeChild({
        stdout: JSON.stringify({
          ok: true, code: 0, tookMs: 123, sessionId: 'sess-probe',
          text: '已整理完毕', error: '', tools: ['read_file', 'write_file'],
        }),
        exitCode: 0,
        delay: 20,
      });
    };

    probe = await startProbeServer({ cfgPath, dispatchSpawn });
    ok('测试服务器 /health 可用（临时端口）', probe.healthy);
    ok('临时端口避开真实端口', ![8001, 8102, 8103].some((p) => probe.ports.includes(p)));
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    ok('服务器生成的 .control-token 是 64 位 hex', /^[0-9a-f]{64}$/.test(token), token.slice(0, 8) + '…');

    // ── 1b. spawn 同步失败 → failed + attempted:false（唯一可安全重派）────
    spawnMode = 'throw';
    let r = await request(probe.port, 'POST', '/dispatch', {
      body: {
        task: '把配置文件补全', taskId: 'probe-spawn-fail', requestId: 'req-spawn-fail',
      },
    });
    eq('spawn 同步失败 HTTP 200', r.status, 200);
    eq('spawn 同步失败 state=failed', r.json && r.json.state, 'failed');
    eq('spawn 同步失败 outcome=failed', r.json && r.json.outcome, 'failed');
    eq('spawn 同步失败 attempted=false', r.json && r.json.attempted, false);
    eq('spawn 同步失败 stateReason=spawn_failed', r.json && r.json.stateReason, 'spawn_failed');
    let d = await request(probe.port, 'GET', '/dispatch/tasks?id=probe-spawn-fail', { token });
    eq('账本落盘 failed', d.json && d.json.task && d.json.task.state, 'failed');
    eq('账本 attempted=false', d.json && d.json.task && d.json.task.attempted, false);
    eq('账本 attemptCount=1（尝试过一次启动）', d.json && d.json.task && d.json.task.attemptCount, 1);

    // ── 2. 正常完成 → done_unproven；结果/耗时/工具名落账本 ───────────────
    spawnMode = 'ok';
    const longTask = '整理文件：把下载目录里的文档按月份归档，并写一份索引清单。' + 'x'.repeat(200);
    r = await request(probe.port, 'POST', '/dispatch', {
      body: { task: longTask, taskId: 'probe-ok', requestId: 'req-ok', timeoutMs: 5000 },
    });
    eq('正常完成 HTTP 200', r.status, 200);
    eq('正常完成 state=done', r.json && r.json.state, 'done');
    eq('无 verify → outcome=done_unproven', r.json && r.json.outcome, 'done_unproven');
    eq('正常完成 attempted=true', r.json && r.json.attempted, true);
    eq('正常完成 tookMs=123', r.json && r.json.tookMs, 123);
    eq('spawn 时磁盘 attempted 已为 true（先落盘再 spawn）', spawnObservedAttempted, true);
    ok('spawn 参数里带任务正文（P1 起直接 spawn DSH，不再经过 CLI 壳）',
      spawnLog.some((x) => x.args.some((a) => String(a).includes(longTask.slice(0, 20)))),
      JSON.stringify((spawnLog[spawnLog.length - 1] || {}).args || []).slice(0, 240));
    d = await request(probe.port, 'GET', '/dispatch/tasks?id=probe-ok', { token });
    ok('详情可读', !!(d.json && d.json.ok && d.json.task), d.text && d.text.slice(0, 160));
    eq('详情 state=done', d.json && d.json.task && d.json.task.state, 'done');
    eq('详情 outcome=done_unproven', d.json && d.json.task && d.json.task.outcome, 'done_unproven');
    eq('详情 text 落账本', d.json && d.json.task && d.json.task.text, '已整理完毕');
    eq('详情 tookMs 落账本', d.json && d.json.task && d.json.task.tookMs, 123);
    ok('详情 tools 落账本', Array.isArray(d.json && d.json.task && d.json.task.tools)
      && d.json.task.tools.length === 2, JSON.stringify(d.json && d.json.task && d.json.task.tools));
    eq('详情 taskText 全文保留', d.json && d.json.task && d.json.task.taskText, longTask);

    // ── 3a. 超时 → unknown + attempted:true ─────────────────────────────
    spawnMode = 'hang';
    const hangTask = '把日志目录里三天前的文件清掉';
    r = await request(probe.port, 'POST', '/dispatch', {
      body: { task: hangTask, taskId: 'probe-timeout', requestId: 'req-timeout', timeoutMs: 250 },
    });
    eq('超时 HTTP 200', r.status, 200);
    eq('超时 state=unknown', r.json && r.json.state, 'unknown');
    eq('超时 outcome=null', r.json && r.json.outcome, null);
    eq('超时 stateReason=timeout', r.json && r.json.stateReason, 'timeout');
    eq('超时 attempted=true', r.json && r.json.attempted, true);
    d = await request(probe.port, 'GET', '/dispatch/tasks?id=probe-timeout', { token });
    eq('账本超时 state=unknown', d.json && d.json.task && d.json.task.state, 'unknown');
    eq('账本超时 outcome=null', d.json && d.json.task && d.json.task.outcome, null);
    eq('账本超时 attempted=true', d.json && d.json.task && d.json.task.attempted, true);

    // ── 3b. 同 requestId 复用旧记录（不重派）──────────────────────────────
    const spawnBefore = spawnCount;
    r = await request(probe.port, 'POST', '/dispatch', {
      body: { task: hangTask, taskId: 'probe-timeout-retry', requestId: 'req-timeout', timeoutMs: 250 },
    });
    eq('同 requestId 返回 reused=true', r.json && r.json.reused, true);
    eq('reused 复用旧 taskId', r.json && r.json.taskId, 'probe-timeout');
    eq('reused 状态仍是 unknown', r.json && r.json.state, 'unknown');
    eq('reused 不产生第二次 spawn', spawnCount, spawnBefore);
    // 同 requestId + 不同任务正文 → 409
    r = await request(probe.port, 'POST', '/dispatch', {
      body: { task: '换一个完全不同的任务', requestId: 'req-timeout' },
    });
    eq('同 requestId 不同任务 → 409', r.status, 409);
    eq('冲突错误码 request_id_conflict', r.json && r.json.error, 'request_id_conflict');

    // ── 3c. HTTP 断线（响应未写完）→ unknown + disconnect ────────────────
    spawnMode = 'hang';
    await new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify({
        task: '慢慢跑一个长任务', taskId: 'probe-disconnect', requestId: 'req-disconnect', timeoutMs: 30000,
      }), 'utf8');
      const req = http.request({
        host: '127.0.0.1', port: probe.port, path: '/dispatch', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      }, () => { /* 不需要响应：下面主动断开 */ });
      req.on('error', () => resolve());
      req.write(body);
      req.end();
      setTimeout(() => { try { req.destroy(); } catch (e) { /* ignore */ } resolve(); }, 180);
    });
    let disconnected = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(80);
      const g = await request(probe.port, 'GET', '/dispatch/tasks?id=probe-disconnect', { token });
      if (g.json && g.json.ok && g.json.task && g.json.task.state !== 'running') { disconnected = g.json.task; break; }
    }
    ok('断线后账本可读', !!disconnected, '40 次轮询仍是 running');
    eq('断线 state=unknown', disconnected && disconnected.state, 'unknown');
    eq('断线 outcome=null', disconnected && disconnected.outcome, null);
    eq('断线 stateReason=disconnect', disconnected && disconnected.stateReason, 'disconnect');
    eq('断线 attempted=true', disconnected && disconnected.attempted, true);

    // ── 5. 列表/详情令牌与预览上限 ───────────────────────────────────────
    r = await request(probe.port, 'GET', '/dispatch/tasks');
    ok('无 token → 401/403', r.status === 401 || r.status === 403, '实际 ' + r.status);
    r = await request(probe.port, 'GET', '/dispatch/tasks', { token: 'f'.repeat(64) });
    ok('错 token → 401/403', r.status === 401 || r.status === 403, '实际 ' + r.status);
    r = await request(probe.port, 'GET', '/dispatch/tasks', { token });
    eq('带 token 列表 200', r.status, 200);
    const list = (r.json && r.json.tasks) || [];
    const okItem = list.find((x) => x.taskId === 'probe-ok');
    ok('列表含 probe-ok', !!okItem);
    ok('列表 taskPreview ≤120 字', okItem && Array.from(String(okItem.taskPreview || '')).length <= 120,
      '长度 ' + (okItem && Array.from(String(okItem.taskPreview || '')).length));
    ok('列表不返回 taskText（正文只在详情）', okItem && okItem.taskText === undefined);
    ok('列表不返回 result text', okItem && okItem.text === undefined);
    d = await request(probe.port, 'GET', '/dispatch/tasks?id=probe-ok', { token });
    ok('详情返回全文（>120 字）', d.json && d.json.task && String(d.json.task.taskText || '').length > 120);
    r = await request(probe.port, 'GET', '/dispatch/tasks?id=does-not-exist', { token });
    eq('不存在任务 → 404', r.status, 404);

    // ── 取消端点的 P1 语义（P0 这里曾固定断言 501；P1 已实现，完整用例见
    //    _probe/test-dispatch-v2-p1.cjs）。这一档只验「不伪报成功 + 终态幂等」。──
    r = await request(probe.port, 'POST', '/dispatch/cancel', { body: { taskId: 'no-such-task' } });
    eq('取消不存在的任务 → 404', r.status, 404);
    eq('取消不存在不伪报成功', r.json && r.json.ok, false);
    r = await request(probe.port, 'POST', '/dispatch/cancel', { body: { taskId: 'probe-ok' } });
    eq('取消已终态任务 → already_finished', r.json && r.json.error, 'already_finished');
    eq('取消已终态任务不伪报成功', r.json && r.json.ok, false);

    // ── 4. 启动 recover：running → unknown/restart ────────────────────────
    {
      // 4a. 账本层：新实例读旧文件
      const recRoot = tempRoot('dispatch-ledger-recover-');
      try {
        const roomDir = path.join(recRoot, 'data');
        const led1 = createDispatchLedger({ roomDir });
        led1.create({ taskId: 'recover-me', requestId: 'req-recover', taskText: '写一半就重启的任务' });
        led1.markAttempted('recover-me', { startedAt: Date.now() });
        led1.create({ taskId: 'keep-done', requestId: 'req-keep', taskText: '已经完成的任务' });
        led1.finish('keep-done', { state: 'done', outcome: 'done_unproven', text: 'ok' });

        const led2 = createDispatchLedger({ roomDir });
        const recovered = led2.recover();
        ok('recover 报告恢复了 recover-me', recovered.includes('recover-me'), JSON.stringify(recovered));
        const row = led2.get('recover-me');
        eq('recover 后 state=unknown', row && row.state, 'unknown');
        eq('recover 后 stateReason=restart', row && row.stateReason, 'restart');
        eq('recover 后 outcome=null', row && row.outcome, null);
        eq('recover 保留 attempted=true', row && row.attempted, true);
        const done = led2.get('keep-done');
        eq('recover 不碰已终态任务', done && done.state, 'done');
        const onDisk = JSON.parse(fs.readFileSync(path.join(led2.tasksDir, 'recover-me.json'), 'utf8'));
        eq('recover 已回写磁盘', onDisk.state, 'unknown');
      } finally { cleanup(recRoot); }
    }
    {
      // 4b. 服务端层：startVtsServer 启动即 recover（同 config，新端口）
      const led = probe.server.dispatchLedger;
      led.create({ taskId: 'probe-restart', requestId: 'req-restart', taskText: '重启前正在跑的任务' });
      led.markAttempted('probe-restart', { startedAt: Date.now() });
      const probe2 = await startProbeServer({
        cfgPath,
        dispatchSpawn: () => fakeChild({ stdout: '{"ok":true}', exitCode: 0, delay: 20 }),
      });
      try {
        ok('第二实例（模拟重启）可用', probe2.healthy);
        const g = await request(probe2.port, 'GET', '/dispatch/tasks?id=probe-restart', { token });
        ok('重启后仍能查到 running 任务', !!(g.json && g.json.ok && g.json.task), g.text && g.text.slice(0, 120));
        eq('服务端启动 recover → unknown', g.json && g.json.task && g.json.task.state, 'unknown');
        eq('服务端启动 recover → restart', g.json && g.json.task && g.json.task.stateReason, 'restart');
        eq('服务端启动 recover 保留 attempted', g.json && g.json.task && g.json.task.attempted, true);
      } finally {
        try { probe2.server.close(); } catch (e) { /* ignore */ }
      }
    }
  } finally {
    try { if (probe && probe.server) probe.server.close(); } catch (e) { /* ignore */ }
    cleanup(root);
  }

  // ── 6. ledger_v2=false：旧路径，不写账本 ─────────────────────────────
  {
    const offRoot = tempRoot('dispatch-ledger-off-');
    let offProbe = null;
    try {
      const { cfgPath, room } = writeConfig(offRoot, false);
      eq('readLedgerV2Enabled 读显式 false', readLedgerV2Enabled(cfgPath), false);
      offProbe = await startProbeServer({
        cfgPath,
        dispatchSpawn: () => fakeChild({
          stdout: JSON.stringify({ ok: true, code: 0, tookMs: 9, sessionId: 'sess-off', text: '旧路径完成', error: '', tools: [] }),
          exitCode: 0,
          delay: 20,
        }),
      });
      ok('ledger_v2=false 服务器可用', offProbe.healthy);
      const r = await request(offProbe.port, 'POST', '/dispatch', {
        body: { task: '旧路径跑一遍', taskId: 'probe-off', requestId: 'req-off' },
      });
      eq('旧路径仍返回 ok', r.json && r.json.ok, true);
      eq('旧路径 text 正常', r.json && r.json.text, '旧路径完成');
      ok('ledger_v2=false 不创建 dispatch-tasks.jsonl', !fs.existsSync(path.join(room, 'dispatch-tasks.jsonl')));
      ok('ledger_v2=false 不创建 dispatch-tasks/ 目录', !fs.existsSync(path.join(room, 'dispatch-tasks')));
    } finally {
      try { if (offProbe && offProbe.server) offProbe.server.close(); } catch (e) { /* ignore */ }
      cleanup(offRoot);
    }
  }

  // ── 7. JSONL 坏行容错 + 终态裁剪（200 条）────────────────────────────
  {
    const trimRoot = tempRoot('dispatch-ledger-trim-');
    try {
      let clock = 1_700_000_000_000;
      const led = createDispatchLedger({ roomDir: path.join(trimRoot, 'data'), now: () => (clock += 1) });
      // 先证明坏行不影响读取
      led.create({ taskId: 'bad-line-anchor', requestId: 'req-bad', taskText: '坏行前已存在的任务' });
      fs.appendFileSync(led.jsonlPath, '{this is not json\n\x00garbage\n', 'utf8');
      const list = led.listPreview({ limit: 10 });
      ok('JSONL 坏行不影响列表读取', list.some((x) => x.taskId === 'bad-line-anchor'), JSON.stringify(list));

      // 未终态记录：裁剪时必须保留
      led.create({ taskId: 'trim-live', requestId: 'req-live', taskText: '永远不该被裁掉的未终态任务' });
      // 205 条终态
      for (let i = 0; i < 205; i += 1) {
        const id = 'trim-' + String(i).padStart(3, '0');
        led.create({ taskId: id, requestId: 'req-trim-' + i, taskText: '批量终态 ' + i });
        led.finish(id, { state: 'done', outcome: 'done_unproven', text: 'ok ' + i });
      }
      const stats = led.stats();
      ok('终态裁剪后 ≤200 条', stats.terminal <= 200, '实际 ' + stats.terminal);
      eq('终态恰好保留 200 条', stats.terminal, 200);
      ok('最旧的终态文件已删除（trim-000）', !fs.existsSync(path.join(led.tasksDir, 'trim-000.json')));
      ok('最新的终态文件还在（trim-204）', fs.existsSync(path.join(led.tasksDir, 'trim-204.json')));
      ok('未终态记录未被裁剪（trim-live）', fs.existsSync(path.join(led.tasksDir, 'trim-live.json')));
      const live = led.get('trim-live');
      eq('未终态记录状态不变', live && live.state, 'running');
      ok('坏行之后追加的裁剪事件仍可读', fs.readFileSync(led.jsonlPath, 'utf8').includes('"type":"trim"'));
      ok('JSONL 坏行被计数但不影响账本', stats.badEventLines >= 1, 'badEventLines=' + stats.badEventLines + ' events=' + stats.jsonlEvents);
      ok('内存环形 ≤100（终态可淘汰，未终态保留）', stats.cacheSize <= 101,
        'cacheSize=' + stats.cacheSize + ' terminal=' + stats.terminal + ' live=' + stats.live);
    } finally { cleanup(trimRoot); }
  }

  // ── 7b. requestId 索引 24h 过期（过期后允许新请求，不再复用）──────────
  {
    const ttlRoot = tempRoot('dispatch-ledger-ttl-');
    try {
      let clock = 1_700_000_000_000;
      const led = createDispatchLedger({
        roomDir: path.join(ttlRoot, 'data'),
        requestTtlMs: 60_000,
        now: () => clock,
      });
      led.create({ taskId: 'ttl-task', requestId: 'req-ttl', taskText: '索引过期测试' });
      ok('TTL 内命中 requestId', !!led.findByRequestId('req-ttl'));
      clock += 61_000;
      eq('超过 TTL 后 requestId 失效', led.findByRequestId('req-ttl'), null);
    } finally { cleanup(ttlRoot); }
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
