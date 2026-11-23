// _probe/test-control-auth.cjs —— 8103 浏览器来源写令牌（2026-11-21 红队 P1）
//
// 判据（与 petbridge/vts-server.mjs 的 controlAuthVerdict 同一份口径）：
//   · 没有 Origin → 进程内调用，放行（浏览器页面无法省略 Origin）；
//   · 带任意 Origin + GET/HEAD/OPTIONS → 不要求令牌；
//   · 带任意 Origin + 写（POST…）→ 必须 X-Pet-Token == 本机 .control-token，否则 403；
//   · /browser-tab 仍走扩展自己的 browser_ext_token / browser_ext_ids，不叠加令牌。
//
// 用法：node _probe/test-control-auth.cjs
// 输出：PASS n / FAIL m（check-all 靠这个汇总）
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { pathToFileURL } = require('node:url');

const MOD = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'petbridge', 'vts-server.mjs');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(name + (detail ? '：' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-auth-'));
  const app = path.join(root, 'live-2d');
  fs.mkdirSync(app, { recursive: true });
  return {
    root,
    app,
    cfgPath: path.join(app, 'config.json'),
    tokenFile: path.join(root, 'data', '.control-token'),
  };
}
function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* Windows 偶发占用 */ }
}

/** 取一个空闲高位端口；绝不碰 8001/8102/8103。 */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, method, pathname, opts = {}) {
  const { origin, token, body } = opts;
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (origin !== undefined) headers.Origin = origin;
    if (token !== undefined) headers['X-Pet-Token'] = token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout: 4000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON 就留 null */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ status: 0, text: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, text: String((e && e.message) || e) }));
    if (data) req.write(data);
    req.end();
  });
}

async function waitHealthy(port) {
  for (let i = 0; i < 40; i += 1) {
    await sleep(100);
    const r = await request(port, 'GET', '/health');
    if (r.status === 200) return true;
  }
  return false;
}

(async () => {
  const mod = await import(pathToFileURL(MOD).href);
  const { controlAuthVerdict, resolveControlToken, controlTokenPath, startVtsServer } = mod;
  ok('导出 controlAuthVerdict', typeof controlAuthVerdict === 'function');
  ok('导出 resolveControlToken', typeof resolveControlToken === 'function');
  ok('导出 controlTokenPath', typeof controlTokenPath === 'function');
  ok('导出 startVtsServer', typeof startVtsServer === 'function');

  // ── ① 纯函数：判定口径 ────────────────────────────────────────────────
  {
    const expected = 'a'.repeat(64);
    eq('无 Origin + POST 放行', controlAuthVerdict({ origin: undefined, method: 'POST', expectedToken: expected }).ok, true);
    eq('空 Origin + POST 放行', controlAuthVerdict({ origin: '', method: 'POST', expectedToken: expected }).ok, true);
    eq('file:// + POST 无令牌拒绝', controlAuthVerdict({ origin: 'file://', method: 'POST', expectedToken: expected }).ok, false);
    eq('file:// 无令牌原因', controlAuthVerdict({ origin: 'file://', method: 'POST', expectedToken: expected }).reason, 'missing-token');
    eq('localhost + POST 无令牌拒绝', controlAuthVerdict({ origin: 'http://localhost:9999', method: 'POST', expectedToken: expected }).ok, false);
    eq('evil + POST 无令牌拒绝', controlAuthVerdict({ origin: 'https://evil.example', method: 'POST', expectedToken: expected }).ok, false);
    eq('file:// + POST 正确令牌放行', controlAuthVerdict({ origin: 'file://', method: 'POST', expectedToken: expected, token: expected }).ok, true);
    eq('file:// + POST 错误令牌拒绝', controlAuthVerdict({ origin: 'file://', method: 'POST', expectedToken: expected, token: 'b'.repeat(64) }).ok, false);
    eq('错误令牌原因', controlAuthVerdict({ origin: 'file://', method: 'POST', expectedToken: expected, token: 'b'.repeat(64) }).reason, 'bad-token');
    eq('file:// + GET 不要求令牌', controlAuthVerdict({ origin: 'file://', method: 'GET', expectedToken: expected }).ok, true);
    eq('evil + GET 不要求令牌', controlAuthVerdict({ origin: 'https://evil.example', method: 'GET', expectedToken: expected }).ok, true);
    eq('期望令牌为空时带 Origin 写请求拒绝', controlAuthVerdict({ origin: 'file://', method: 'POST', expectedToken: '' }).ok, false);
  }

  // ── ② 令牌文件：生成 / 持久化 / 路径推导 ─────────────────────────────
  {
    const t = tempRoot();
    try {
      eq('令牌路径推导', controlTokenPath(t.cfgPath), t.tokenFile);
      const first = resolveControlToken(t.cfgPath);
      ok('首次启动生成 64 位 hex', /^[0-9a-f]{64}$/.test(first), first.slice(0, 12) + '…');
      ok('令牌文件已落盘', fs.existsSync(t.tokenFile));
      eq('文件内容与返回一致', fs.readFileSync(t.tokenFile, 'utf8').trim(), first);
      eq('再次读取保持同一令牌（重启不变）', resolveControlToken(t.cfgPath), first);
      fs.writeFileSync(t.tokenFile, 'persisted-manual-token\n', 'utf8');
      eq('预置令牌被沿用', resolveControlToken(t.cfgPath), 'persisted-manual-token');
    } finally { cleanup(t.root); }
  }

  // ── ③ 真服务器：临时高位端口（不碰 8001/8102/8103）──────────────────
  const t = tempRoot();
  let server = null;
  const [pVts, pInner, pCtrl] = await Promise.all([freePort(), freePort(), freePort()]);
  ok('临时端口互不重复', new Set([pVts, pInner, pCtrl]).size === 3);
  ok('临时端口避开 8001/8102/8103', ![8001, 8102, 8103].some((p) => [pVts, pInner, pCtrl].includes(p)));
  try {
    fs.writeFileSync(t.cfgPath, JSON.stringify({
      browser_ext_ids: ['probe-ext-id'],
    }), 'utf8');
    server = startVtsServer({
      port: pVts,
      internalPort: pInner,
      controlPort: pCtrl,
      configPath: t.cfgPath,
      model: { id: 'probe', name: 'probe', expressions: [], hotkeys: [], parameters: [] },
      log: () => {},
    });
    ok('临时服务器已启动', !!server && typeof server.close === 'function');
    ok('临时服务器 /health 可用', await waitHealthy(pCtrl));

    const token = fs.readFileSync(t.tokenFile, 'utf8').trim();
    ok('服务器生成的令牌是 64 位 hex', /^[0-9a-f]{64}$/.test(token));

    // 无 Origin + POST → 放行（不存在的路由给 404，不是 403）
    let r = await request(pCtrl, 'POST', '/__probe_unknown', { body: {} });
    ok('无 Origin + POST 不是 403', r.status !== 403, '实际 ' + r.status);
    eq('无 Origin + POST 落到 404', r.status, 404);

    // 三种 Origin，无令牌 → 403 + browser_requires_token
    for (const origin of ['file://', 'http://localhost:9999', 'https://evil.example']) {
      r = await request(pCtrl, 'POST', '/__probe_unknown', { origin, body: {} });
      eq(origin + ' + 无令牌 → 403', r.status, 403);
      eq(origin + ' 错误码', r.json && r.json.error, 'browser_requires_token');
      ok(origin + ' 响应不泄漏令牌', !r.text.includes(token), r.text.slice(0, 120));
    }

    // 三种 Origin，正确令牌 → 不是 403（未知路由 404）
    for (const origin of ['file://', 'http://localhost:9999', 'https://evil.example']) {
      r = await request(pCtrl, 'POST', '/__probe_unknown', { origin, token, body: {} });
      ok(origin + ' + 正确令牌 不是 403', r.status !== 403, '实际 ' + r.status);
      eq(origin + ' + 正确令牌 落到 404', r.status, 404);
    }

    // 错误令牌 → 403
    r = await request(pCtrl, 'POST', '/__probe_unknown', { origin: 'file://', token: 'f'.repeat(64), body: {} });
    eq('file:// + 错误令牌 → 403', r.status, 403);
    eq('错误令牌错误码', r.json && r.json.error, 'browser_requires_token');

    // 真实写路由：/quiet 无令牌 403、有令牌 200（on:false 不写 config 副作用）
    r = await request(pCtrl, 'POST', '/quiet', { origin: 'file://', body: { on: true } });
    eq('/quiet 无令牌 → 403', r.status, 403);
    r = await request(pCtrl, 'POST', '/quiet', { origin: 'file://', token, body: { on: false } });
    eq('/quiet 正确令牌 → 200', r.status, 200);

    // /say 覆盖：无令牌 403（有令牌会真的说话，这里只验拒绝面）
    r = await request(pCtrl, 'POST', '/say', { origin: 'http://localhost:9999', body: { text: 'probe' } });
    eq('/say 无令牌 → 403', r.status, 403);

    // /dispatch 覆盖：无令牌 403（正确令牌不测，避免真的派任务）
    r = await request(pCtrl, 'POST', '/dispatch', { origin: 'file://', body: { task: 'probe' } });
    eq('/dispatch 无令牌 → 403', r.status, 403);

    // /dsh/reply 覆盖：无令牌 403
    r = await request(pCtrl, 'POST', '/dsh/reply', { origin: 'file://', body: { text: 'probe' } });
    eq('/dsh/reply 无令牌 → 403', r.status, 403);

    // GET 不要求令牌
    r = await request(pCtrl, 'GET', '/health');
    eq('GET 无令牌 /health → 200', r.status, 200);
    r = await request(pCtrl, 'GET', '/state', { origin: 'file://' });
    ok('GET + file:// 无令牌 不是 403', r.status !== 403, '实际 ' + r.status);

    // 预检：白名单 origin 放行且允许 X-Pet-Token 头（否则浏览器根本发不出真请求）
    r = await request(pCtrl, 'OPTIONS', '/say', { origin: 'file://' });
    eq('OPTIONS(file://) → 204', r.status, 204);
    ok('OPTIONS 放行 X-Pet-Token 头', /x-pet-token/i.test(String(r.headers['access-control-allow-headers'] || '')),
      String(r.headers['access-control-allow-headers'] || ''));

    // /browser-tab 既有机制不受影响：扩展 Origin + browser_ext_ids 放行（不需要控制令牌）
    r = await request(pCtrl, 'POST', '/browser-tab', {
      origin: 'chrome-extension://probe-ext-id',
      body: { host: 'example.com', title: 'probe', audible: false, tabCount: 1 },
    });
    eq('/browser-tab 扩展白名单仍放行', r.status, 200);
    eq('/browser-tab 返回 ok', r.json && r.json.ok, true);
  } finally {
    try { server && server.close(); } catch (e) { /* 已关 */ }
    cleanup(t.root);
  }

  console.log('PASS ' + pass + ' / FAIL ' + fail);
  if (fail) {
    for (const f of failures) console.error('   - ' + f);
    process.exit(1);
  }
})().catch((e) => {
  console.error('PASS ' + pass + ' / FAIL ' + (fail + 1));
  console.error('   - 测试异常：' + ((e && e.stack) || e));
  process.exit(1);
});
