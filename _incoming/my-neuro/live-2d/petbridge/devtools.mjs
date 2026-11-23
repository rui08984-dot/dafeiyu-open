// devtools.mjs — 给「真实宿主窗口」用的自检通道。
// 为什么需要它：shot.mjs 跑的是 pet-runtime/desktop/index.html（独立舞台页），
// 宿主窗口里的布局/点击穿透/拖拽是另一套（main.js 的 setIgnoreMouseEvents + 宿主 css），
// 只有对着真窗口截图、量几何、注入输入，才算「自己用一遍」。
//
// GET  /shot?out=<path>      截窗口内容（capturePage，不受 z-order / 全屏遮挡影响）
// GET  /geom                 所有可见元素的几何 + 谁在上层（elementFromPoint 命中）
// GET  /bounds               窗口在屏幕上的位置/大小 + 当前 ignoreMouseEvents 状态
// POST /click {x,y,count?}   往窗口注入一次真实鼠标点击（Blink 层，绕过 OS 穿透）
// POST /move  {x,y}          注入 mousemove（测 hover 浮出/眼神跟随）
// POST /eval  {js}           在页面里执行表达式，返回 JSON 结果
// POST /type  {text}         注入键入
import http from 'node:http';
import fs from 'node:fs';

const MAX_BODY = 2 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const GEOM_JS = `(() => {
  const out = [];
  const seen = new Set();
  const els = document.querySelectorAll('body *');
  for (const el of els) {
    if (seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (Number(cs.opacity) < 0.02) continue;
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
    const cx = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2));
    const cy = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    const desc = (n) => n ? (n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).slice(0,3).join('.') : '')) : 'null';
    out.push({
      d: desc(el),
      id: el.id || '',
      cls: typeof el.className === 'string' ? el.className.slice(0, 60) : '',
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      pe: cs.pointerEvents, z: cs.zIndex, op: Number(cs.opacity).toFixed(2), disp: cs.display,
      hit: desc(hit),
      covered: !(hit === el || (hit && el.contains(hit))),
    });
  }
  return out;
})()`;

export function attachDevtools(win, { port = 8004, log = console.log, getWorld = null } = {}) {
  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  // 输入注入闸（2026-11-20 审计 P1）：评测 run 超时后，runner 会把
  // `window.__petEvalDisabled` 置 true；在这之前，残留脚本每 8ms 一个 char
  // 仍可能打进用户窗口。所有直接注入输入的入口先问一句，禁用期一律 409。
  const inputBlocked = async () => {
    try { return (await win.webContents.executeJavaScript('window.__petEvalDisabled === true')) === true; }
    catch (e) { return false; }   // 页面不可读时不额外拦（真异常由实际注入报错）
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      // 2026-11-21 红队审计 P0：8004/8005 是**本机 Node 自检通道**，/eval 会把任意 JS
      // executeJavaScript 到宿主窗口（该窗口 nodeIntegration=true、contextIsolation=false），
      // 等于本机 RCE。浏览器发出的请求一定带 Origin（fetch/表单 POST）或 Sec-Fetch-Site
      // （所有子资源，含 <img>），Node/curl 两者都不带 —— 凡浏览器来源一律拒绝。
      // 这样 /eval、/click、/type 不能再被网页 CSRF；/shot?out= 的写盘也不再服务网页。
      const browserish = typeof req.headers.origin === 'string'
        || typeof req.headers['sec-fetch-site'] === 'string';
      if (req.method === 'POST' && browserish) {
        return send(res, 403, {
          ok: false, error: 'browser_forbidden',
          hint: '自检通道只接受本机 Node/curl 调用（浏览器来源被拒绝：防网页 CSRF 驱动宿主）',
        });
      }
      if (req.method === 'GET' && url.pathname === '/bounds') {
        const b = win.getBounds();
        return send(res, 200, {
          bounds: b,
          ignoreMouse: global.__petIgnoreMouse === true,
          alwaysOnTop: win.isAlwaysOnTop(),
          visible: win.isVisible(),
          opacity: win.getOpacity(),
          contentSize: win.getContentSize(),
          dpr: win.webContents.getZoomFactor(),
        });
      }
      if (req.method === 'GET' && url.pathname === '/geom') {
        const out = await win.webContents.executeJavaScript(GEOM_JS);
        return send(res, 200, { inner: out.length, elements: out });
      }
      // 世界感知（2026-11-17 六十二轮）：世界状态住在渲染层插件里，
      // 这里只是转手一次。没挂世界感知时如实说，不假装有数据。
      if (req.method === 'GET' && url.pathname === '/world') {
        if (typeof getWorld !== 'function') return send(res, 200, { ok: false, error: '世界感知未挂载（getWorld 缺失）' });
        const world = await getWorld();
        return send(res, 200, { ok: !!(world && world.ok !== false), world: world || null });
      }
      if (req.method === 'GET' && url.pathname === '/shot') {
        const image = await win.webContents.capturePage();
        const out = url.searchParams.get('out');
        // 审计 P1：out 是任意路径写盘。浏览器 `<img src=.../shot?out=...>` 无 Origin，
        // 但一定带 Sec-Fetch-Site；Node 调用（shot.mjs/petctl/评测）两样都没有。
        if (out && browserish) {
          return send(res, 403, { ok: false, error: 'browser_forbidden', hint: '/shot?out= 只接受本机 Node 调用' });
        }
        if (out) fs.writeFileSync(out, image.toPNG());
        return send(res, 200, { ok: true, out: out || null, size: image.getSize(), bytes: image.toPNG().length });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (url.pathname === '/eval') {
          const value = await win.webContents.executeJavaScript(String(body.js || 'null'));
          return send(res, 200, { ok: true, value: value === undefined ? null : value });
        }
        if (url.pathname === '/click' || url.pathname === '/move' || url.pathname === '/drag' || url.pathname === '/type') {
          if (await inputBlocked()) return send(res, 409, { ok: false, error: 'eval_disabled', path: url.pathname });
        }
        if (url.pathname === '/click') {
          const x = Math.round(Number(body.x) || 0), y = Math.round(Number(body.y) || 0);
          const count = Math.max(1, Number(body.count) || 1);
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          await new Promise((r) => setTimeout(r, 30));
          win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: count });
          await new Promise((r) => setTimeout(r, 40));
          win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: count });
          return send(res, 200, { ok: true, x, y, count });
        }
        if (url.pathname === '/move') {
          const x = Math.round(Number(body.x) || 0), y = Math.round(Number(body.y) || 0);
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          return send(res, 200, { ok: true, x, y });
        }
        if (url.pathname === '/drag') {
          // 从 (x1,y1) 拖到 (x2,y2)，中间分步，模拟真人拖动，用来验 window 真的移动了。
          const { x1, y1, x2, y2 } = body;
          const steps = Math.max(4, Number(body.steps) || 10);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: x1, y: y1 });
          await new Promise((r) => setTimeout(r, 40));
          win.webContents.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 });
          for (let i = 1; i <= steps; i++) {
            const x = Math.round(x1 + (x2 - x1) * i / steps), y = Math.round(y1 + (y2 - y1) * i / steps);
            win.webContents.sendInputEvent({ type: 'mouseMove', x, y, button: 'left', buttons: 1 });
            await new Promise((r) => setTimeout(r, 16));
          }
          win.webContents.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 });
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/type') {
          const text = String(body.text == null ? '' : body.text);
          for (const ch of text) {
            win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
            await new Promise((r) => setTimeout(r, 8));
          }
          if (body.enter) win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
          return send(res, 200, { ok: true, len: text.length });
        }
        return send(res, 404, { error: 'unknown path ' + url.pathname });
      }
      return send(res, 404, { error: 'unknown path ' + url.pathname });
    } catch (error) {
      return send(res, 500, { error: String(error && error.message || error) });
    }
  });

  server.on('error', (error) => log('[devtools] 启动失败:', error && error.message || error));
  server.listen(port, '127.0.0.1', () => log('[devtools] 自检通道 http://127.0.0.1:' + port + ' (/shot /geom /bounds /click /move /drag /type /eval)'));
  return {
    server,
    close() { try { server.close(); } catch (e) {} },
  };
}
