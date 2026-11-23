// _probe/test-dispatch-followup.cjs —— 派活 v2 续聊（followup）验收用例
//
// 覆盖 2026-11-23 续聊实现：
//   1. 成功复用：父任务终态 + sessionId → 子任务带 --session-id，回传一致 → sessionReused=true，
//      子任务独立账本行（parentId/attempted/verify/outcome），父任务不被改写。
//   2. session 失配 → sessionMismatch=true / sessionReused=false / fallback=true，
//      用新会话 + 父任务摘要（含改动文件）+ 这次任务重跑；第二次 spawn 不带 --session-id。
//   3. 采纳失败（DSH 直接退出、没有 session 事件）→ 同样回退（sessionMismatch=false, fallback=true）。
//   4. 父任务未终态 → 409 parent_not_terminal（不 spawn）。
//   5. 未知 taskId → 404；父任务无 sessionId → 409 no_parent_session（不 spawn）。
//   6. 断线 → 子任务 unknown/disconnect（attempted=true，不伪造 failed）。
//   7. 插件工具面：dispatch_followup schema / 预检 / POST /dispatch/followup 透传 / 回执带续聊语义。
//
// 全程 mkdtemp 隔离 + 注入 spawn：不碰真实 data、端口、DSH，也不跑长任务。
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
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dispatch-followup-'));
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

function fakeChild({ pid, lines = [], exitCode = 0, delay = 30, hang = false, beforeExit = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid || (51000 + Math.floor(Math.random() * 500));
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  if (!hang) {
    // 不 unref：没有服务器 socket / 真实子进程撑着事件循环时，unref 会让进程静默退出。
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

async function startProbeServer({ cfgPath, dispatchSpawn, dispatchKill, log = () => {} }) {
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
  });
  const healthy = await waitHealthy(pCtrl);
  return { server, port: pCtrl, healthy, ports: [pVts, pInner, pCtrl] };
}

function sessionArg(args) {
  const list = Array.isArray(args) ? args : [];
  const i = list.indexOf('--session-id');
  return i >= 0 ? String(list[i + 1] || '') : '';
}
function lastArg(args) {
  const list = Array.isArray(args) ? args : [];
  return String(list[list.length - 1] || '');
}
function readTaskFiles(room) {
  const dir = path.join(room, 'dispatch-tasks');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) { return out; }
  for (const f of files) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (e) { /* 坏行跳过 */ }
  }
  return out;
}

(async () => {
  // 纯函数：partialWrites 时间窗边界（-2000ms 容差）
  const V = await import(pathToFileURL(VTS_MOD).href);
  {
    const t = Date.now();
    const after = { files: { 'fresh.txt': (t - 1000) + ':10', 'stale.txt': (t - 5000) + ':20' } };
    eq('时间窗：任务后改的进 modifiedSinceTask',
      V.filterModifiedSinceTask(after, ['fresh.txt', 'stale.txt'], t).join(','), 'fresh.txt');
    eq('时间窗：缺 startedAt → 空', V.filterModifiedSinceTask(after, ['fresh.txt'], 0).length, 0);
    eq('时间窗：指纹解析 mtime', V.snapshotMtimeMs('123456:9'), 123456);
    eq('时间窗：无指纹 → 排除', V.filterModifiedSinceTask({ files: {} }, ['x.txt'], t).length, 0);
    eq('时间窗：恰好 -2000ms 边界仍算任务内',
      V.filterModifiedSinceTask({ files: { 'edge.txt': (t - 2000) + ':1' } }, ['edge.txt'], t).join(','), 'edge.txt');
  }

  const root = tempRoot();
  const ws = path.join(root, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'seed.txt'), 'seed', 'utf8');
  let probe = null;
  try {
    const { cfgPath, room } = writeConfig(root, {
      ledger_v2: true,
      workspaces: { w: ws },
      cancel: true, verify: true, workspace: true,
      verify_timeout_ms: 60000, rework_max: 0, cancel_grace_ms: 2000,
    });

    // 行为由 phase 控制；spawnLog 记录每次 args（用来断言 --session-id 与回退提示词）。
    const spawnLog = [];
    let phase = 'parent';
    let sessionSeq = 0;
    let hangingChild = null;
    const dispatchSpawn = (exe, args, opts) => {
      const sid = sessionArg(args);
      spawnLog.push({ args: Array.isArray(args) ? args.slice() : [], sessionId: sid, cwd: opts && opts.cwd });
      const cwd = (opts && opts.cwd) || ws;
      const tag = String(sessionSeq += 1);
      if (phase === 'parent') {
        const sessionId = 'sess-parent-' + tag;
        return fakeChild({
          lines: [{ type: 'session', sessionId }, { type: 'final', text: '父任务第 ' + tag + ' 次完成' }],
          exitCode: 0,
          delay: 25,
          beforeExit: () => { fs.writeFileSync(path.join(cwd, 'parent-out-' + tag + '.txt'), 'PARENT ' + tag, 'utf8'); },
        });
      }
      if (phase === 'reuse') {
        // 模拟 DSH 采纳：回传的就是请求的 session id。
        return fakeChild({
          lines: [{ type: 'session', sessionId: sid || 'unexpected' }, { type: 'final', text: '续聊完成（同一会话）' }],
          exitCode: 0,
          delay: 25,
          beforeExit: () => { fs.writeFileSync(path.join(cwd, 'followup-reuse.txt'), 'REUSE', 'utf8'); },
        });
      }
      if (phase === 'mismatch') {
        if (sid) {
          // 请求采纳 sess-parent-x，DSH 却回了一个不同的会话（失配）。
          return fakeChild({
            lines: [{ type: 'session', sessionId: 'sess-other-' + tag }, { type: 'final', text: '跑在别的会话里' }],
            exitCode: 0,
            delay: 20,
          });
        }
        return fakeChild({
          lines: [{ type: 'session', sessionId: 'sess-fresh-' + tag }, { type: 'final', text: '新会话把续聊做完了' }],
          exitCode: 0,
          delay: 20,
          beforeExit: () => { fs.writeFileSync(path.join(cwd, 'followup-fallback-' + tag + '.txt'), 'FALLBACK', 'utf8'); },
        });
      }
      if (phase === 'adopt-fail') {
        if (sid) {
          // 模拟「采纳失败」：没有 session 事件，直接 stderr + exit 1（DSH 的实际行为）。
          const c = fakeChild({ lines: [], exitCode: 1, delay: 20 });
          setTimeout(() => { try { c.stderr.write('dsh: session "' + sid + '" does not exist\n'); } catch (e) { /* ignore */ } }, 5);
          return c;
        }
        return fakeChild({
          lines: [{ type: 'session', sessionId: 'sess-fallback-' + tag }, { type: 'final', text: '回退新会话完成' }],
          exitCode: 0,
          delay: 20,
        });
      }
      if (phase === 'hang') {
        hangingChild = fakeChild({ hang: true });
        return hangingChild;
      }
      return fakeChild({ lines: [{ type: 'final', text: '默认' }], exitCode: 0, delay: 20 });
    };
    const dispatchKill = (pid, child) => {
      try { if (child && typeof child.emit === 'function') child.emit('exit', null); } catch (e) { /* ignore */ }
      return { ok: true, injected: true, pid };
    };

    probe = await startProbeServer({ cfgPath, dispatchSpawn, dispatchKill });
    ok('followup 测试服务器可用（临时端口）', probe.healthy);
    const token = fs.readFileSync(path.join(room, '.control-token'), 'utf8').trim();
    const verifyCmd = 'node -e "process.exit(0)"';

    async function dispatchParent(taskId, text, requestId) {
      phase = 'parent';
      return request(probe.port, 'POST', '/dispatch', {
        body: { task: text, taskId, requestId, workspace: 'w', verify: verifyCmd, timeoutMs: 5000 },
      });
    }
    async function detail(id) {
      const r = await request(probe.port, 'GET', '/dispatch/tasks?id=' + encodeURIComponent(id), { token });
      return r.json && r.json.task ? r.json.task : null;
    }

    // ══ 1. 成功复用 ═════════════════════════════════════════════════════════
    let r = await dispatchParent('fu-parent-1', '父任务：把第一版写完并留下产物');
    eq('父任务 1 完成 done', r.json && r.json.state, 'done');
    const parent1 = await detail('fu-parent-1');
    ok('父任务 1 账本有 sessionId', !!(parent1 && parent1.sessionId), JSON.stringify(parent1 && parent1.sessionId));
    const spawnsBeforeReuse = spawnLog.length;

    phase = 'reuse';
    r = await request(probe.port, 'POST', '/dispatch/followup', {
      body: { taskId: 'fu-parent-1', task: '继续：把第二版也写完' },
    });
    eq('续聊复用 HTTP 200', r.status, 200);
    eq('续聊标记 followup', r.json && r.json.followup, true);
    eq('续聊 parentId 回传', r.json && r.json.parentId, 'fu-parent-1');
    eq('续聊 sessionReused=true', r.json && r.json.sessionReused, true);
    eq('续聊 sessionMismatch=false', r.json && r.json.sessionMismatch, false);
    eq('续聊 fallback=false', r.json && r.json.fallback, false);
    eq('续聊 state=done', r.json && r.json.state, 'done');
    eq('续聊继承 verify → done_verified', r.json && r.json.outcome, 'done_verified');
    ok('续聊只起 1 次子进程', spawnLog.length - spawnsBeforeReuse === 1, String(spawnLog.length - spawnsBeforeReuse));
    const reuseSpawn = spawnLog[spawnLog.length - 1];
    eq('复用请求拼了 --session-id', reuseSpawn.sessionId, parent1.sessionId);
    ok('复用任务正文是这次要做的事', lastArg(reuseSpawn.args).includes('继续：把第二版也写完'), lastArg(reuseSpawn.args).slice(0, 200));
    const childId1 = r.json && r.json.taskId;
    ok('子任务 id 与父任务不同', childId1 && childId1 !== 'fu-parent-1', String(childId1));
    const child1 = await detail(childId1);
    eq('子任务账本 parentId', child1 && child1.parentId, 'fu-parent-1');
    eq('子任务 attempted=true', child1 && child1.attempted, true);
    eq('子任务 sessionReused', child1 && child1.sessionReused, true);
    eq('子任务 sessionId=父会话', child1 && child1.sessionId, parent1.sessionId);
    eq('子任务 verify 独立落盘', child1 && child1.verify && child1.verify.verdict, 'pass');
    ok('子任务证据含 followup-reuse.txt', child1 && child1.evidence
      && (child1.evidence.created || []).includes('followup-reuse.txt'), JSON.stringify(child1 && child1.evidence));
    const parent1After = await detail('fu-parent-1');
    eq('父任务状态不被改写', parent1After && parent1After.state, 'done');
    eq('父任务 sessionId 不变', parent1After && parent1After.sessionId, parent1.sessionId);

    // ══ 2. session 失配 → 新会话 + 父任务摘要回退 ═══════════════════════════
    r = await dispatchParent('fu-parent-2', '父任务二：产出 parent-out 文件');
    eq('父任务 2 完成', r.json && r.json.state, 'done');
    const parent2 = await detail('fu-parent-2');
    const parent2Files = [...((parent2.evidence && parent2.evidence.created) || []),
      ...((parent2.evidence && parent2.evidence.modified) || [])];
    ok('父任务 2 有改动文件清单', parent2Files.length > 0, JSON.stringify(parent2.evidence));

    phase = 'mismatch';
    const spawnsBeforeMismatch = spawnLog.length;
    r = await request(probe.port, 'POST', '/dispatch/followup', {
      body: { taskId: 'fu-parent-2', task: '失配场景：继续做第二步' },
    });
    eq('失配 HTTP 200', r.status, 200);
    eq('失配 sessionMismatch=true', r.json && r.json.sessionMismatch, true);
    eq('失配 sessionReused=false', r.json && r.json.sessionReused, false);
    eq('失配 fallback=true', r.json && r.json.fallback, true);
    ok('失配回执说明没接上原会话', /没接上原会话/.test(String(r.json && r.json.note)), String(r.json && r.json.note));
    eq('失配 → 起 2 次子进程（失配 + 回退）', spawnLog.length - spawnsBeforeMismatch, 2);
    const mismatchFirst = spawnLog[spawnLog.length - 2];
    const fallbackSpawn = spawnLog[spawnLog.length - 1];
    eq('第一次尝试带父会话 id', mismatchFirst.sessionId, parent2.sessionId);
    eq('回退尝试不带 --session-id', fallbackSpawn.sessionId, '');
    const fallbackText = lastArg(fallbackSpawn.args);
    ok('回退提示词注入父任务摘要', fallbackText.includes('续聊上下文') && fallbackText.includes(parent2.taskText), fallbackText.slice(0, 300));
    ok('回退提示词注入父任务结果', fallbackText.includes(String(parent2.text || '').slice(0, 20)), fallbackText.slice(0, 400));
    ok('回退提示词注入改动文件', parent2Files.some((f) => fallbackText.includes(f)), fallbackText.slice(0, 500));
    ok('回退提示词注入这次任务', fallbackText.includes('失配场景：继续做第二步'), fallbackText.slice(-200));
    ok('回退提示词摘要 ≤1200 字（不含任务段）', fallbackText.split('【这次要做】')[0].length <= 1220,
      'summary=' + fallbackText.split('【这次要做】')[0].length);
    const child2 = await detail(r.json && r.json.taskId);
    eq('失配子任务 sessionMismatch 落账本', child2 && child2.sessionMismatch, true);
    eq('失配子任务 sessionReused=false', child2 && child2.sessionReused, false);
    ok('失配子任务 sessionId 是新会话', !!(child2 && child2.sessionId)
      && child2.sessionId !== parent2.sessionId, String(child2 && child2.sessionId));
    eq('失配回退后仍按 verify 结案', r.json && r.json.outcome, 'done_verified');

    // ══ 3. 采纳失败（无 session 事件 + exit 1）→ 同样回退 ═══════════════════
    r = await dispatchParent('fu-parent-3', '父任务三：采纳失败的父任务');
    eq('父任务 3 完成', r.json && r.json.state, 'done');
    const parent3 = await detail('fu-parent-3');
    phase = 'adopt-fail';
    const spawnsBeforeAdoptFail = spawnLog.length;
    r = await request(probe.port, 'POST', '/dispatch/followup', {
      body: { taskId: 'fu-parent-3', task: '采纳失败场景：接着做' },
    });
    eq('采纳失败 HTTP 200', r.status, 200);
    eq('采纳失败 sessionMismatch=false（不是不一致，是没采纳）', r.json && r.json.sessionMismatch, false);
    eq('采纳失败 sessionReused=false', r.json && r.json.sessionReused, false);
    eq('采纳失败 fallback=true', r.json && r.json.fallback, true);
    eq('采纳失败 → 2 次子进程', spawnLog.length - spawnsBeforeAdoptFail, 2);
    eq('采纳失败后回退不带父会话', spawnLog[spawnLog.length - 1].sessionId, '');
    eq('采纳失败回退后 state=done', r.json && r.json.state, 'done');

    // ══ 3b. newTaskId 预分配（插件「派完即可查」依赖它）+ 冲突拒绝 ══════════
    phase = 'reuse';
    r = await request(probe.port, 'POST', '/dispatch/followup', {
      body: { taskId: 'fu-parent-1', task: '预分配 id 的续聊任务', newTaskId: 'fu-child-fixed' },
    });
    eq('newTaskId 被采纳', r.json && r.json.taskId, 'fu-child-fixed');
    eq('预分配 id 的续聊仍复用会话', r.json && r.json.sessionReused, true);
    const spawnsBeforeConflict = spawnLog.length;
    r = await request(probe.port, 'POST', '/dispatch/followup', {
      body: { taskId: 'fu-parent-1', task: '同一个子任务 id 不该覆盖', newTaskId: 'fu-child-fixed' },
    });
    eq('重复 newTaskId → HTTP 409', r.status, 409);
    eq('重复 newTaskId 错误码', r.json && r.json.error, 'task_id_conflict');
    eq('重复 newTaskId 不 spawn', spawnLog.length, spawnsBeforeConflict);

    // ══ 4. 父任务未终态 → 409，不 spawn ════════════════════════════════════
    probe.server.dispatchLedger.create({ taskId: 'fu-running', requestId: 'req-fu-running', taskText: '还在跑' });
    probe.server.dispatchLedger.markAttempted('fu-running', { startedAt: Date.now() });
    const spawnsBeforeRunning = spawnLog.length;
    r = await request(probe.port, 'POST', '/dispatch/followup', {
      body: { taskId: 'fu-running', task: '不该被受理' },
    });
    eq('父任务未终态 HTTP 409', r.status, 409);
    eq('父任务未终态错误码', r.json && r.json.error, 'parent_not_terminal');
    eq('父任务未终态不 spawn', spawnLog.length, spawnsBeforeRunning);

    // ══ 5. 未知 taskId → 404 ═══════════════════════════════════════════════
    r = await request(probe.port, 'POST', '/dispatch/followup', {
      body: { taskId: 'no-such-task-xyz', task: '未知父任务' },
    });
    eq('未知父任务 HTTP 404', r.status, 404);
    eq('未知父任务错误码', r.json && r.json.error, 'not_found');
    eq('未知父任务不 spawn', spawnLog.length, spawnsBeforeRunning);

    // ══ 6. 父任务无 sessionId → 409，不 spawn ══════════════════════════════
    probe.server.dispatchLedger.create({ taskId: 'fu-nosess', requestId: 'req-fu-nosess', taskText: '没有会话的任务' });
    probe.server.dispatchLedger.markAttempted('fu-nosess', { startedAt: Date.now() });
    probe.server.dispatchLedger.finish('fu-nosess', { state: 'failed', outcome: 'failed', stateReason: 'spawn_failed', attempted: false });
    r = await request(probe.port, 'POST', '/dispatch/followup', {
      body: { taskId: 'fu-nosess', task: '没有会话也不该受理' },
    });
    eq('无 sessionId HTTP 409', r.status, 409);
    eq('无 sessionId 错误码', r.json && r.json.error, 'no_parent_session');
    eq('无 sessionId 不 spawn', spawnLog.length, spawnsBeforeRunning);

    // ══ 7. 断线 → 子任务 unknown/disconnect ════════════════════════════════
    r = await dispatchParent('fu-parent-4', '父任务四：断线测试的父任务');
    eq('父任务 4 完成', r.json && r.json.state, 'done');
    const parent4 = await detail('fu-parent-4');
    phase = 'hang';
    const beforeDisc = new Set(readTaskFiles(room).map((x) => x.taskId));
    await new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify({ taskId: 'fu-parent-4', task: '断线场景：跑到一半客户端没了', timeoutMs: 60000 }), 'utf8');
      const req = http.request({
        host: '127.0.0.1', port: probe.port, path: '/dispatch/followup', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      }, () => { /* 不要响应 */ });
      req.on('error', () => resolve());
      req.write(body); req.end();
      setTimeout(() => { try { req.destroy(); } catch (e) { /* ignore */ } resolve(); }, 220);
    });
    let discChild = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(100);
      const rows = readTaskFiles(room).filter((x) => x.parentId === 'fu-parent-4' && !beforeDisc.has(x.taskId));
      if (rows.length && rows[0].state === 'unknown') { discChild = rows[0]; break; }
    }
    eq('断线子任务 state=unknown', discChild && discChild.state, 'unknown');
    eq('断线子任务 stateReason=disconnect', discChild && discChild.stateReason, 'disconnect');
    eq('断线子任务 attempted=true', discChild && discChild.attempted, true);
    eq('断线子任务 outcome=null', discChild && discChild.outcome, null);
    ok('断线子任务记了父任务 id', discChild && discChild.parentId === 'fu-parent-4');
    if (hangingChild) { try { hangingChild.emit('exit', 0); } catch (e) { /* ignore */ } }
    await sleep(250);

    // ══ 8. 插件工具面 ═══════════════════════════════════════════════════════
    const DispatchPlugin = require(PLUGIN_MOD);
    const logs = [];
    const mkPlugin = () => {
      const p = new DispatchPlugin({ name: 'dispatch' }, {
        log: (lvl, msg) => logs.push(lvl + ':' + msg),
        getPluginFileConfig: () => ({
          control_port: 8103, timeout_seconds: 900, auto_receipt: false, max_concurrent: 2,
          verify_default_on: true, verify_timeout_ms: 45000, rework_max: 2, cancel_grace_ms: 1800,
        }),
      });
      return p;
    };
    const plugin = mkPlugin();
    await plugin.onInit();
    const tools = plugin.getTools();
    const byName = Object.fromEntries(tools.map((t) => [t.function.name, t.function]));
    ok('工具面含 dispatch_followup', !!byName.dispatch_followup);
    ok('dispatch_followup 必填 taskId+task', byName.dispatch_followup
      && (byName.dispatch_followup.parameters.required || []).includes('taskId')
      && (byName.dispatch_followup.parameters.required || []).includes('task'));

    // 8a. 预检拒绝：父任务不存在 / 未终态 / 无 session
    plugin._ledgerGet = async (p) => {
      if (/no-such/.test(p)) return { status: 404, json: null, text: 'not found' };
      if (/running/.test(p)) return { status: 200, json: { ok: true, task: { taskId: 'running', state: 'running', sessionId: 's' } } };
      if (/nosess/.test(p)) return { status: 200, json: { ok: true, task: { taskId: 'nosess', state: 'done', sessionId: null } } };
      return { status: 200, json: { ok: true, task: { taskId: 'ok', state: 'done', sessionId: 's-x' } } };
    };
    let out = JSON.parse(await plugin._followup({ taskId: 'no-such', task: '继续做点事' }));
    eq('插件预检：未知任务 ok=false', out.ok, false);
    ok('插件预检：未知任务错误说明', /没有这个任务/.test(String(out.error)), String(out.error));
    out = JSON.parse(await plugin._followup({ taskId: 'running', task: '继续做完这件事' }));
    eq('插件预检：父任务未终态拒绝', out.ok, false);
    ok('插件预检：未终态提示', /还没结束/.test(String(out.error)), String(out.error));
    out = JSON.parse(await plugin._followup({ taskId: 'nosess', task: '继续做完这件事' }));
    eq('插件预检：无 session 拒绝', out.ok, false);
    ok('插件预检：无 session 提示', /没有可复用的会话/.test(String(out.error)), String(out.error));

    // 8a2. check_dispatch 详情带续聊字段（UI 下一轮直接读）
    plugin._ledgerGet = async () => ({
      status: 200,
      json: {
        ok: true,
        task: {
          taskId: 'child-q', state: 'done', outcome: 'done_verified', stateReason: null,
          attempted: true, text: 'ok', error: '', tookMs: 10, taskText: '续聊任务',
          parentId: 'parent-q', sessionId: 's-q', sessionReused: true, sessionMismatch: false,
        },
      },
    });
    out = JSON.parse(await plugin._check({ id: 'child-q' }));
    eq('_check 读 parentId', out.parentId, 'parent-q');
    eq('_check 读 sessionId', out.sessionId, 's-q');
    eq('_check 读 sessionReused', out.sessionReused, true);
    eq('_check 读 sessionMismatch', out.sessionMismatch, false);

    // 8b. 通过预检 → 建 pending 行并调用 _runFollowup（这里拦下来验证参数形状）
    let runArgs = null;
    plugin._runFollowup = async (pendingId, parentId, text) => { runArgs = { pendingId, parentId, text }; };
    plugin._tasks.clear();
    out = JSON.parse(await plugin._followup({ taskId: 'ok', task: '继续把第三步做完' }));
    eq('插件受理续聊 ok=true', out.ok, true);
    eq('插件续聊回传 parentId', out.parentId, 'ok');
    eq('插件调 _runFollowup 的父 id', runArgs && runArgs.parentId, 'ok');
    eq('插件调 _runFollowup 的任务正文', runArgs && runArgs.text, '继续把第三步做完');
    eq('插件预分配的子任务 id 就是返回的 id', runArgs && runArgs.pendingId, out.id);
    ok('预分配 id 已在并发行里（派完即可查）', plugin._tasks.has(out.id), String(out.id));
    ok('插件 pending 行在并发计数里', plugin._running() >= 1, String(plugin._running()));

    // 8c. _runFollowup 真发 POST /dispatch/followup（本地假 8103），并落子任务行
    let captured = null;
    let capturedRow = null;
    const fakeHttp = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { captured = JSON.parse(raw); } catch (e) { captured = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, followup: true, parentId: 'ok', taskId: 'child-real-1', state: 'done',
          outcome: 'done_verified', attemptCount: 1, attempted: true,
          sessionReused: false, sessionMismatch: true, fallback: true,
          tookMs: 42, text: '回退新会话完成', verify: { verdict: 'pass' },
        }));
      });
    });
    await new Promise((resolve) => fakeHttp.listen(0, '127.0.0.1', resolve));
    try {
      const p2 = mkPlugin();
      await p2.onInit();
      p2._port = fakeHttp.address().port;
      p2._tasks.set('pending-fu-1', { id: 'pending-fu-1', state: 'running', task: 't', startedAt: Date.now(), text: '', error: '' });
      await p2._runFollowup('pending-fu-1', 'ok', '继续把第三步做完');
      ok('_runFollowup 发出请求体', !!captured, '未收到请求');
      eq('_runFollowup 传父任务 id', captured && captured.taskId, 'ok');
      eq('_runFollowup 传任务正文', captured && captured.task, '继续把第三步做完');
      eq('_runFollowup 传预分配子任务 id', captured && captured.newTaskId, 'pending-fu-1');
      eq('_runFollowup 透传 timeoutMs', captured && captured.timeoutMs, 900000);
      ok('_runFollowup 移除 pending 行', !p2._tasks.has('pending-fu-1'));
      capturedRow = p2._tasks.get('child-real-1');
      eq('_runFollowup 用真实子任务 id 建行', capturedRow && capturedRow.id, 'child-real-1');
      eq('_runFollowup 保留 sessionMismatch', capturedRow && capturedRow.sessionMismatch, true);
      eq('_runFollowup 保留 parentId', capturedRow && capturedRow.parentId, 'ok');
      eq('_runFollowup 状态取服务端终态', capturedRow && capturedRow.state, 'done');
    } finally {
      try { fakeHttp.close(); } catch (e) { /* ignore */ }
    }

    // 8d. 回执带续聊语义（auto_receipt 打开 + 假 sendMessage）
    const p3 = mkPlugin();
    await p3.onInit();
    p3._autoReceipt = true;
    p3._tasks.set('child-real-2', {
      id: 'child-real-2', state: 'done', outcome: 'done_unproven', task: 't',
      followupParentId: 'ok', sessionMismatch: true, tookMs: 1000, text: '结果', error: '',
    });
    let receipt = '';
    p3.context.sendMessage = async (line) => { receipt = String(line); };
    await p3._receipt('child-real-2');
    ok('续聊回执标明接着哪个任务', receipt.includes('续聊·接着任务 ok'), receipt.slice(0, 160));
    ok('续聊回执说明没接上原会话', receipt.includes('没接上原会话'), receipt.slice(0, 200));
  } finally {
    try { if (probe && probe.server) probe.server.close(); } catch (e) { /* ignore */ }
    cleanup(root);
  }

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
