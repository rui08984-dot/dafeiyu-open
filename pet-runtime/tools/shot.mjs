// shot.mjs — CDP 无头截图/交互工具（源自 A 的 cdp-shot）：等渲染器真正 ready 再截图，支持步骤脚本。
// 用法（在 pet-runtime 下）：
//   node tools/shot.mjs [--out x.png] [--query "framing=half"] [--steps '[...]'] [--wait 800] [--w 420 --h 760]
// steps: [{"js":"window.__stage.openPanel('asset')","wait":800}, ...]
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { join, normalize, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', 'desktop');
const OUTDIR = resolve(HERE, '..', '..', '_incoming', 'probe');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.moc3': 'application/octet-stream', '.map': 'application/json', '.css': 'text/css' };

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : fallback; };
const outPath = arg('out', join(OUTDIR, (process.env.LABEL || 'shot') + '.png'));
const query = arg('query', 'framing=half');
const waitMs = Number(arg('wait', 4000));
const stepsFile = arg('steps-file', '');
const steps = stepsFile ? JSON.parse(await readFile(stepsFile, 'utf8')) : JSON.parse(arg('steps', '[]'));
const page = arg('page', 'index.html');
const W = Number(arg('w', 420)), H = Number(arg('h', 760));

const logs = [];
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST') { const chunks = []; for await (const c of req) chunks.push(c); logs.push(Buffer.concat(chunks).toString('utf8')); res.writeHead(200).end('ok'); return; }
    let p = decodeURIComponent(u.pathname); if (p === '/') p = '/' + page;
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return; }
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(buf);
  } catch (e) { try { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); } catch {} }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = 'http://127.0.0.1:' + port + '/' + page + (query ? '?' + query : '');

const dbgPort = 9400 + Math.floor(Math.random() * 400);
const profile = join(HERE, 'profile-' + process.pid);
const child = spawn(EDGE, ['--headless=new', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=' + W + ',' + H, '--remote-debugging-port=' + dbgPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', (d) => { stderr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitEndpoint() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch('http://127.0.0.1:' + dbgPort + '/json/version'); if (r.ok) return await r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('DevTools endpoint timeout');
}
const version = await waitEndpoint();
const newTarget = await (await fetch('http://127.0.0.1:' + dbgPort + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(newTarget.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map(); const events = [];
ws.addEventListener('message', (event) => {
  const m = JSON.parse(event.data);
  if (m.id && pending.has(m.id)) { const { resolve: r, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : r(m.result); }
  else events.push(m);
});
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) return { error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') };
  return r.result?.value;
};

const preloadFile = arg('preload', '');
if (preloadFile) await send('Page.addScriptToEvaluateOnNewDocument', { source: await readFile(preloadFile, 'utf8') });
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });

// 等页面里的舞台/渲染器就绪
let ready = false;
for (let i = 0; i < 240; i++) {
  const v = await evaluate('!!(window.__stage && window.__stage.ready) || !!(window.__pet && window.__pet.renderer && window.__pet.renderer.ready)');
  if (v === true) { ready = true; break; }
  await sleep(100);
}
const results = [];
const extraShots = [];
for (const step of steps) {
  if (step.js) results.push({ js: step.js, value: await evaluate(step.js) });
  if (step.wait) await sleep(step.wait);
  if (step.shot) {
    const p = join(OUTDIR, step.shot);
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    await writeFile(p, Buffer.from(s.data, 'base64'));
    extraShots.push({ path: p, bytes: (await stat(p)).size });
  }
}
if (waitMs) await sleep(waitMs);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
await writeFile(outPath, Buffer.from(shot.data, 'base64'));
const state = await evaluate('window.__stage ? window.__stage.debugState() : null');
const consoleErrors = events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error').map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 20);
const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.text + ' ' + (e.params.exceptionDetails?.exception?.description || '')).slice(0, 20);
const logErrors = events.filter((e) => e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)).map((e) => e.params.entry.level + ': ' + e.params.entry.text).slice(0, 20);
let size = 0; try { size = (await stat(outPath)).size; } catch {}
console.log(JSON.stringify({ outPath, size, ready, port, dbgPort, extraShots, results, state, consoleErrors, exceptions, logErrors, harnessLogs: logs.slice(-20) }, null, 2));
try { ws.close(); } catch {}
try { child.kill('SIGKILL'); } catch {}
await sleep(300);
try { await new Promise((r) => server.close(r)); } catch {}
try { await rm(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
