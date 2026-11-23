// remote-control.js —— 手机遥控页服务（2026-11-09 C 档）
//
// 为什么独立起一个服务、而不是给 :3002 绑 0.0.0.0：
//   :3002 现有 7 处把请求参数直接拼进 executeJavaScript 字符串
//   （expression_name / emotion_name / motion_index / filename …）——
//   暴露到局域网 = 开 7 个远程代码执行入口。这里**完全不碰 :3002**，
//   新建 :3003，且所有入参一律走白名单 + JSON 序列化，不做字符串拼接。
//
// 安全模型（局域网场景下的最小可行）：
//   ① 随机令牌：首次启动生成，写 data/遥控令牌.txt；URL 必须带 ?t=<token>
//   ② 绑定 0.0.0.0 但**仅限本服务**；:3002 / :3001 / 8090 等一律不动
//   ③ 所有动作走白名单（动作名/表情名必须是列表内的字符串）
//   ④ 说话通道：文字经 JSON.stringify 注入，绝不裸拼
//   ⑤ 只读接口不鉴权（状态查询），写接口全部鉴权
//
// 用法：由 http-server 在 startEmotionServer 后调用 startRemoteServer()

const http = require('http');

// 静默统一走 8103（2026-11-16）：手机端 loopback 是手机自己，不能直连电脑的 8103；
// 本服务跑在主进程，用 node http 直连没有 CORS 概念。8103 /quiet 会依次改
// state.quiet、global.__petQuiet、广播渲染层、持久化 config.cost.quiet —— 四个入口同源。
const postQuiet = (on) => new Promise((resolve) => {
  const data = Buffer.from(JSON.stringify({ on: !!on }));
  const req = http.request({
    host: '127.0.0.1', port: 8103, path: '/quiet', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 1500,
  }, (res) => {
    let s = ''; res.on('data', (c) => { s += c; });
    res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve({ ok: res.statusCode < 400 }); } });
  });
  req.on('error', (e) => resolve({ ok: false, error: e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  req.end(data);
});

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let TOKEN = '';

function ensureToken(recordsDir) {
  try {
    const f = path.join(recordsDir, '遥控令牌.txt');
    if (fs.existsSync(f)) {
      const t = fs.readFileSync(f, 'utf8').trim();
      if (t.length >= 16) { TOKEN = t; return t; }
    }
    TOKEN = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(f, TOKEN + '\n', 'utf8');
    return TOKEN;
  } catch (e) {
    // 写不了文件也不能没令牌：用进程内随机（重启即换，用户需重扫码）
    TOKEN = crypto.randomBytes(16).toString('hex');
    return TOKEN;
  }
}

function checkToken(url) {
  const t = url.searchParams.get('t') || '';
  if (!TOKEN) return false;
  // 定时安全比较（防时序侧信道；局域网场景其实不必，但没成本）
  const a = Buffer.from(t);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#060911">
<title>大肥鱼 · 掌心伴侣遥控</title>
<style>
  :root {
    --bg-base: #060911;
    --surface: rgba(10, 16, 28, 0.94);
    --surface-card: rgba(14, 22, 38, 0.92);
    --raised: rgba(18, 29, 50, 0.88);
    --line: rgba(56, 189, 248, 0.22);
    --line-focus: rgba(56, 189, 248, 0.65);
    --ocean: #0284c7;
    --accent: #38bdf8;
    --cyan: #38bdf8;
    --cyan-light: #e0f2fe;
    --goldfish: var(--ocean);
    --goldfish-gold: var(--accent);
    --sakura: var(--accent);
    --sakura-light: var(--cyan-light);
    --peach: var(--ocean);
    --ink: #f8fafc;
    --ink-muted: #94a3b8;
    --ink-faint: #64748b;
    --ok: #34d399;
    --r-card: 16px;
    --r-btn: 12px;
    --sh: 0 10px 28px rgba(4, 7, 14, 0.6), 0 0 16px rgba(56, 189, 248, 0.16);
  }

  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0;
    background: radial-gradient(circle at 50% 0%, #0d1e38 0%, var(--bg-base) 75%);
    color: var(--ink);
    font: 14.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    padding: 16px 16px calc(24px + env(safe-area-inset-bottom));
    min-height: 100vh;
  }

  /* 顶部头像与连接状态栏 */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    padding: 4px 2px;
  }
  .brand-group {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .avatar-ring {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--ocean), var(--accent));
    display: grid;
    place-items: center;
    font-size: 18px;
    box-shadow: 0 0 14px rgba(56, 189, 248, 0.45);
    animation: ring-pulse 3.5s infinite ease-in-out;
  }
  @keyframes ring-pulse {
    0%, 100% { transform: scale(1); filter: drop-shadow(0 0 4px rgba(56, 189, 248, 0.35)); }
    50% { transform: scale(1.05); filter: drop-shadow(0 0 10px rgba(56, 189, 248, 0.6)); }
  }
  .title-wrap h1 {
    font-size: 16.5px;
    font-weight: 700;
    margin: 0;
    letter-spacing: 0.5px;
    color: #fff;
  }
  .conn-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    color: var(--ink-muted);
  }
  .conn-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 6px var(--ok);
  }

  /* 通用卡片容器 */
  .card {
    background: var(--surface-card);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    padding: 14px 16px;
    margin-bottom: 14px;
    box-shadow: var(--sh);
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .card-head h2 {
    font-size: 12.5px;
    font-weight: 700;
    margin: 0;
    color: var(--sakura-light);
    letter-spacing: 0.8px;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* 状态指标条 */
  .status-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }
  .stat-pill {
    background: var(--surface);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .stat-label {
    font-size: 11px;
    color: var(--ink-faint);
  }
  .stat-val {
    font-size: 15px;
    font-weight: 700;
    color: #fff;
    font-variant-numeric: tabular-nums;
  }

  /* 说话输入框 */
  textarea {
    width: 100%;
    background: rgba(10, 16, 28, 0.9);
    color: #fff;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 12px 14px;
    font: inherit;
    font-size: 14px;
    line-height: 1.5;
    resize: none;
    min-height: 72px;
    outline: none;
    transition: border-color .2s, box-shadow .2s;
  }
  textarea:focus {
    border-color: var(--cyan);
    box-shadow: 0 0 14px rgba(56, 189, 248, 0.35);
  }
  textarea::placeholder { color: var(--ink-faint); }

  .send-btn-wrap {
    margin-top: 10px;
  }
  button.primary-send {
    width: 100%;
    padding: 12px;
    border-radius: 12px;
    border: none;
    background: linear-gradient(135deg, var(--ocean) 0%, var(--accent) 100%);
    color: #fff;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.5px;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(2, 132, 199, 0.4);
    transition: all .15s ease;
  }
  button.primary-send:active {
    transform: scale(0.97);
    filter: brightness(1.15);
  }
  .warn-tip {
    font-size: 11px;
    color: var(--ink-faint);
    margin-top: 6px;
    text-align: center;
  }

  /* 动作网格 */
  .grid-actions {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .btn-action {
    background: var(--surface);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: var(--r-btn);
    color: var(--ink);
    padding: 10px 6px;
    font-size: 13px;
    font-weight: 550;
    cursor: pointer;
    transition: all .15s ease;
    text-align: center;
    user-select: none;
  }
  .btn-action:active {
    background: rgba(56, 189, 248, 0.22);
    border-color: var(--cyan);
    color: #fff;
    transform: scale(0.95);
  }

  /* 情绪药丸 */
  .emotions-wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .btn-emo {
    flex: 1;
    min-width: 60px;
    padding: 9px 8px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: var(--surface);
    color: var(--ink);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: all .15s;
    text-align: center;
  }
  .btn-emo:active {
    background: rgba(56, 189, 248, 0.25);
    border-color: var(--accent);
    color: #fff;
    transform: scale(0.95);
  }

  /* 静默开关 */
  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 0;
  }
  .switch-label strong {
    display: block;
    font-size: 14px;
    color: #fff;
  }
  .switch-label span {
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .btn-quiet-toggle {
    padding: 8px 16px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink-muted);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all .2s;
  }
  .btn-quiet-toggle.on {
    background: rgba(2, 132, 199, 0.35);
    border-color: var(--accent);
    color: #fff;
    box-shadow: 0 0 14px rgba(56, 189, 248, 0.4);
  }

  /* 浮动提示 */
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(28px + env(safe-area-inset-bottom));
    transform: translateX(-50%) translateY(20px);
    background: rgba(10, 16, 28, 0.96);
    border: 1px solid var(--cyan);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.7), 0 0 20px rgba(56, 189, 248, 0.3);
    border-radius: 999px;
    padding: 10px 22px;
    font-size: 13.5px;
    font-weight: 600;
    color: #fff;
    opacity: 0;
    pointer-events: none;
    transition: all .25s cubic-bezier(0.22, 0.8, 0.3, 1);
    z-index: 9999;
    white-space: nowrap;
  }
  .toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
</style>
</head>
<body>

<header class="header">
  <div class="brand-group">
    <div class="avatar-ring">🐟</div>
    <div class="title-wrap">
      <h1>大肥鱼 · 掌心伴侣</h1>
      <div class="conn-badge">
        <span class="conn-dot"></span>
        <span id="conn">连接中…</span>
      </div>
    </div>
  </div>
</header>

<div class="card">
  <div class="card-head">
    <h2>✦ 实时状态</h2>
  </div>
  <div class="status-grid" id="status">
    <div class="stat-pill"><span class="stat-label">心情</span><span class="stat-val" id="st-mood">读取中</span></div>
    <div class="stat-pill"><span class="stat-label">饱食度</span><span class="stat-val" id="st-hunger">—</span></div>
    <div class="stat-pill"><span class="stat-label">精力值</span><span class="stat-val" id="st-energy">—</span></div>
    <div class="stat-pill"><span class="stat-label">亲密度</span><span class="stat-val" id="st-intimacy">—</span></div>
  </div>
</div>

<div class="card">
  <div class="card-head">
    <h2>💌 传递心语</h2>
  </div>
  <textarea id="say" placeholder="在手机上写点什么，她会在电脑桌面上念出并互动…"></textarea>
  <div class="send-btn-wrap">
    <button class="primary-send" id="btn-say">发送给大肥鱼</button>
  </div>
  <div class="warn-tip">走完整对话链（记忆提取、情感共鸣与工具调用），非单向复读。</div>
</div>

<div class="card">
  <div class="card-head">
    <h2>🎭 互动表演 (12种动作)</h2>
  </div>
  <div class="grid-actions" id="scenes"></div>
</div>

<div class="card">
  <div class="card-head">
    <h2>✨ 表情与情绪切换</h2>
  </div>
  <div class="emotions-wrap" id="emotions">
    <button class="btn-emo" data-emo="happy">😊 开心</button>
    <button class="btn-emo" data-emo="sad">🥺 难过</button>
    <button class="btn-emo" data-emo="angry">😤 生气</button>
    <button class="btn-emo" data-emo="surprised">😲 惊讶</button>
    <button class="btn-emo" data-emo="neutral">🍵 平静</button>
  </div>
</div>

<div class="card">
  <div class="switch-row">
    <div class="switch-label">
      <strong>静默模式</strong>
      <span>不主动自言自语，省 API 额度</span>
    </div>
    <button class="btn-quiet-toggle" id="btn-quiet">静默模式：关</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const TOKEN = new URLSearchParams(location.search).get('t') || '';
const api = (p, body) => fetch(p + '?t=' + encodeURIComponent(TOKEN), body ? {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
} : {}).then(r => r.json());

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

// 动作图标映射表
const SCENE_ICONS = {
  '打招呼': '👋', '撒娇': '🥰', '生气': '😤', '难过': '🥺',
  '得意': '✨', '伸懒腰': '🥱', '鼓掌': '👏', '想事情': '🤔',
  '点头': '👌', '晚安': '🌙', '鞠躬': '🙇', '指一指': '👉'
};

async function refresh() {
  try {
    const s = await api('/remote/status');
    if (!s.ok) { document.getElementById('conn').textContent = '鉴权失败：请重新扫码'; return; }
    document.getElementById('conn').textContent = '在线 · ' + (s.host || '局域网');
    const d = s.data || {};

    document.getElementById('st-mood').textContent = d.mood || '开心 🌸';
    document.getElementById('st-hunger').textContent = d.hunger != null ? d.hunger + '%' : '100%';
    document.getElementById('st-energy').textContent = d.energy != null ? d.energy + '%' : '100%';
    document.getElementById('st-intimacy').textContent = d.intimacy != null ? '♥ ' + d.intimacy : '♥ 100';

    const q = document.getElementById('btn-quiet');
    q.textContent = '静默模式：' + (d.quiet ? '已开启' : '已关闭');
    q.classList.toggle('on', !!d.quiet);

    const scenes = (d.scenes && d.scenes.length) ? d.scenes : ['打招呼', '撒娇', '生气', '难过', '得意', '伸懒腰', '鼓掌', '想事情', '点头', '晚安', '鞠躬', '指一指'];
    const box = document.getElementById('scenes');
    if (box.children.length !== scenes.length) {
      box.innerHTML = scenes.map(n => {
        const ic = SCENE_ICONS[n] || '🌸';
        return '<button class="btn-action" data-scene="' + n.replace(/"/g, '') + '">' + ic + ' ' + n + '</button>';
      }).join('');
    }
  } catch (e) {
    document.getElementById('conn').textContent = '未连接: ' + e.message;
  }
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button');
  if (!t) return;
  try {
    if (t.id === 'btn-say') {
      const text = document.getElementById('say').value.trim();
      if (!text) return toast('请先输入心语内容');
      toast('正在发送心语…');
      const r = await api('/remote/say', { text });
      toast(r.ok ? '✓ 她已收到' : ('失败: ' + (r.error || '')));
      if (r.ok) document.getElementById('say').value = '';
    } else if (t.dataset.scene) {
      const r = await api('/remote/perform', { scene: t.dataset.scene });
      toast(r.ok ? ('正在演一段: ' + t.dataset.scene) : ('失败: ' + (r.error || '')));
    } else if (t.dataset.emo) {
      const r = await api('/remote/emotion', { emotion: t.dataset.emo });
      toast(r.ok ? ('表情切至: ' + t.textContent) : ('失败: ' + (r.error || '')));
    } else if (t.id === 'btn-quiet') {
      const r = await api('/remote/quiet', { on: !t.classList.contains('on') });
      toast(r.ok ? ('静默模式已' + (r.on ? '开启' : '关闭')) : ('失败: ' + (r.error || '')));
      refresh();
    }
  } catch (e) { toast('出错: ' + e.message); }
});

refresh();
setInterval(refresh, 5000);
</script>
</body></html>`;
// 页面外置（2026-11-16）：同 live-panel，优先读 pages/remote-control.html（mtime 热更新）
const PAGE_FILE = path.join(__dirname, 'pages', 'remote-control.html');
let _pageCache = { mtime: -1, html: PAGE };
function pageHtml() {
  try {
    const st = fs.statSync(PAGE_FILE);
    if (st.mtimeMs !== _pageCache.mtime) _pageCache = { mtime: st.mtimeMs, html: fs.readFileSync(PAGE_FILE, 'utf8') };
    return _pageCache.html;
  } catch (e) { return PAGE; }
}

function send(res, code, obj, type) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {object} deps
 *   deps.getWindow()     → BrowserWindow（渲染层执行用）
 *   deps.recordsDir     → 令牌存放目录
 *   deps.getLocalIPs()  → string[]（给手机显示的地址）
 *   deps.port           → 默认 3003
 */
function startRemoteServer(deps) {
  const port = Number(deps.port) || 3003;
  const token = ensureToken(deps.recordsDir);

  // 白名单：动作/情绪固定集合（不做自由字符串透传）
  const SCENES = ['打招呼', '撒娇', '生气', '难过', '得意', '伸懒腰', '鼓掌', '想事情', '点头', '晚安', '鞠躬', '指一指'];
  const EMOTIONS = ['happy', 'sad', 'angry', 'surprised', 'neutral'];

  // 编码容错（2026-11-09 实测）：从命令行 curl -d 发中文时，若客户端把 UTF-8 字节
  // 当 latin1 再编一遍，服务端会收到 mojibake。这里尝试一次 latin1→utf8 还原。
  // 只在「还原后能命中白名单」时采用，不会放过任何非法输入。
  function normalizeToWhitelist(raw, list) {
    const s = String(raw || '').trim();
    if (list.includes(s)) return s;
    try {
      const fixed = Buffer.from(s, 'latin1').toString('utf8');
      if (list.includes(fixed)) return fixed;
    } catch (e) { /* 还原失败就走原值 */ }
    return s;
  }

  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { ok: false, error: 'bad url' }); }

    // 页面本身不鉴权（手机拿不到令牌时至少能看到"鉴权失败"提示），
    // 但页面内的任何写操作都必须带对令牌。
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/remote')) {
      return send(res, 200, pageHtml(), 'text/html; charset=utf-8');
    }

    if (u.pathname === '/remote/status' && req.method === 'GET') {
      const win = deps.getWindow && deps.getWindow();
      if (!win || win.isDestroyed()) return send(res, 200, { ok: false, error: '窗口不可用' });
      // 状态查询也要求令牌：避免局域网内被人扫到生活状态
      if (!checkToken(u)) return send(res, 200, { ok: false, error: 'unauthorized' });
      const js = `(() => {
        const pb = window.petBody || {};
        const st = (window.pluginManager && window.pluginManager._plugins.get('community/alive-state'));
        let alive = null;
        try { alive = st && st.plugin && st.plugin._state ? st.plugin._state : null; } catch (e) {}
        const mood = window.__petMood && typeof window.__petMood.describe === 'function'
          ? String((window.__petMood.describe() || {}).line || '').slice(0, 20) : '';
        return JSON.stringify({
          mood: mood || '平静',
          hunger: alive ? Math.round(alive.hunger) : null,
          energy: alive ? Math.round(alive.energy) : null,
          intimacy: alive ? Math.round(alive.intimacy) : null,
          quiet: !!global.__petQuiet,
          scenes: (pb.listScenes ? pb.listScenes() : [])
        });
      })()`;
      return win.webContents.executeJavaScript(js)
        .then((raw) => {
          let data = {};
          try { data = JSON.parse(raw); } catch (e) { data = {}; }
          send(res, 200, { ok: true, host: req.headers.host || '', data });
        })
        .catch((e) => send(res, 200, { ok: false, error: String(e && e.message || e) }));
    }

    if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'not found' });
    if (!checkToken(u)) return send(res, 200, { ok: false, error: 'unauthorized' });

    let raw = '';
    let tooBig = false;
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) { tooBig = true; try { req.destroy(); } catch (e) {} }
    });
    req.on('end', () => {
      if (tooBig) return send(res, 413, { ok: false, error: 'too large' });
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (e) { return send(res, 400, { ok: false, error: 'bad json' }); }

      const win = deps.getWindow && deps.getWindow();
      if (!win || win.isDestroyed()) return send(res, 200, { ok: false, error: '窗口不可用' });
      const run = (js) => win.webContents.executeJavaScript(js);

      if (u.pathname === '/remote/say') {
        const text = String(body.text || '').trim().slice(0, 500);
        if (!text) return send(res, 200, { ok: false, error: '内容为空' });
        if (global.__petQuiet) {
          // 静默只限制「主动开口」；用户从手机说话仍应被回应
        }
        // ⚠ 关键：用 JSON.stringify 注入，绝不裸拼 —— 这段字符串里的任何引号/反引号都无害
        //
        // ⚠ 2026-11-15 五十九轮修：这条通道原来直接 `vc.sendToLLM(text)`，
        //   **跳过了 pluginManager.runUserInputHooks** —— 于是「自动召回 / 记住·忘掉口令 /
        //   久别重逢 / MemOS 注入」在手机遥控这条路上全部不生效，而聊天框打字却正常。
        //   症状极具误导性：「有时候她记得，有时候不记得」。现在先跑钩子再送 LLM，
        //   与 InputRouter.handleVoiceInput 对齐。
        const js = `(async () => {
          const vc = window.voiceChat;
          if (!vc || typeof vc.sendToLLM !== 'function') return 'no-voicechat';
          let text = ${JSON.stringify(text)};
          try {
            const pm = window.pluginManager;
            if (pm && typeof pm.runUserInputHooks === 'function') {
              const ev = { text: text, source: 'remote', getContextAdditions: () => [] };
              await pm.runUserInputHooks(ev);
              if (ev._defaultPrevented) return 'handled-by-plugin';
              if (typeof ev.text === 'string' && ev.text) text = ev.text;
            }
          } catch (e) { return 'hook-err:' + (e && e.message || e); }
          // 与聊天框/语音同源（2026-11-16）：手机发来的话也在提交瞬间喂情绪引擎，
          // 否则遥控这条路的自动长表演要等字幕打完才触发。
          try {
            const pb = window.petBody || (typeof global !== 'undefined' ? global.petBody : null);
            if (pb && typeof pb.feedText === 'function') pb.feedText(text, 'user');
          } catch (e) { /* 情绪引擎不可用不影响发送 */ }
          try { await vc.sendToLLM(text); return 'sent'; }
          catch (e) { return 'err:' + (e && e.message || e); }
        })()`;
        return run(js)
          .then((r) => send(res, 200, { ok: String(r) === 'sent', result: String(r) }))
          .catch((e) => send(res, 200, { ok: false, error: String(e && e.message || e) }));
      }

      if (u.pathname === '/remote/perform') {
        // ⚠ 2026-11-09 三十五轮修「假成功」：原来 `pb.perform(scene); return 'ok';`
        //   完全忽略 perform 的返回值 —— 而 perform 在「场景不存在」时返回 false。
        //   于是手机点一个皮套里没有的动作，页面照样显示成功，皮套一动不动。
        //   现在：检查 perform 的返回值 + 回读当前场景确认真的进演出了。
        const scene = normalizeToWhitelist(body.scene, SCENES);
        if (!SCENES.includes(scene)) return send(res, 200, { ok: false, error: '不在动作白名单' });
        const js = `(() => {
          const pb = window.petBody;
          if (!pb || typeof pb.perform !== 'function') return 'no-perform';
          let started = false;
          try { started = pb.perform(${JSON.stringify(scene)}); } catch (e) { return 'err:' + (e && e.message || e); }
          // perform 返回 false = 皮套里没有这个场景（白名单和 SCENES 不同步）
          if (started === false) {
            const avail = (typeof pb.listScenes === 'function') ? pb.listScenes() : [];
            return 'no-scene:' + avail.slice(0, 12).join(',');
          }
          return 'ok';
        })()`;
        return run(js)
          .then((r) => {
            const s = String(r);
            if (s === 'ok') return send(res, 200, { ok: true, scene, result: s });
            if (s.startsWith('no-scene:')) {
              return send(res, 200, {
                ok: false, error: '皮套里没有这个动作（白名单和实际场景不同步）',
                available: s.slice(9).split(',').filter(Boolean),
              });
            }
            return send(res, 200, { ok: false, error: s, result: s });
          })
          .catch((e) => send(res, 200, { ok: false, error: String(e && e.message || e) }));
      }

      if (u.pathname === '/remote/emotion') {
        // ⚠ 2026-11-09 三十五轮：setEmotion 返回 undefined（它是「喂给情绪引擎」，
        //   不直接说成没成）。所以回读 emotionSnapshot 的 emotionKey 来判断真的切了。
        const emo = normalizeToWhitelist(body.emotion, EMOTIONS);
        if (!EMOTIONS.includes(emo)) return send(res, 200, { ok: false, error: '不在情绪白名单' });
        const js = `(() => {
          const pb = window.petBody;
          if (!pb || typeof pb.setEmotion !== 'function') return 'no-setEmotion';
          try { pb.setEmotion(${JSON.stringify(emo)}, 1); } catch (e) { return 'err:' + (e && e.message || e); }
          // 回读：情绪引擎有没有真的记下这个 key
          try {
            const snap = typeof pb.emotionSnapshot === 'function' ? pb.emotionSnapshot() : null;
            // emotion-engine.snapshot() 的字段是 { emotion, key, strength, layer ... }
            // emotion 是当前生效的情绪 id（'happy' 这类），key 是触发它的原始 key
            const cur = snap && (snap.emotion || snap.emotionKey || snap.key) || '';
            // 中文名 → 英文 key 的映射（与 petbody 保持一致，只用于比对）
            const M = { 开心:'happy', 生气:'angry', 难过:'sad', 惊讶:'surprise', 害羞:'shy', 俏皮:'smug', 得意:'smug', 无聊:'bored', 委屈:'aggrieved', 心虚:'guilty', 困:'sleepy' };
            const want = M[${JSON.stringify(emo)}] || ${JSON.stringify(emo)};
            return 'cur:' + cur + '|want:' + want;
          } catch (e) { return 'readback-failed'; }
        })()`;
        return run(js)
          .then((r) => {
            const s = String(r);
            if (s === 'readback-failed') {
              // 回读不了不算失败（可能引擎还没出第一帧），但要标明未验证
              return send(res, 200, { ok: true, unverified: true, emotion: emo, error: '已设置但读不回状态' });
            }
            if (s.startsWith('cur:')) {
              const [cur, want] = s.slice(4).split('|want:');
              const match = String(cur).toLowerCase() === String(want).toLowerCase();
              return send(res, 200, {
                ok: match, verified: true, emotion: emo,
                current: cur, expected: want,
                ...(match ? {} : { error: '设置了但情绪引擎当前是「' + cur + '」，不是「' + want + '」' }),
              });
            }
            return send(res, 200, { ok: false, error: s, result: s });
          })
          .catch((e) => send(res, 200, { ok: false, error: String(e && e.message || e) }));
      }

      if (u.pathname === '/remote/quiet') {
        const on = !!body.on;
        // 2026-11-16：原来只改 global.__petQuiet（内存），重启即丢、且与总览页不同源。
        // 现在走 8103 /quiet；8103 不可用时才退回「只改本次运行」的旧行为。
        return postQuiet(on).then((r) => {
          if (r && r.ok !== false) return send(res, 200, { ok: true, on: r.quiet !== false });
          const js = `(() => { global.__petQuiet = ${on ? 'true' : 'false'}; return 'ok'; })()`;
          return run(js)
            .then(() => send(res, 200, { ok: true, on, persisted: false }))
            .catch((e) => send(res, 200, { ok: false, error: String(e && e.message || e) }));
        });
      }

      return send(res, 404, { ok: false, error: 'not found' });
    });
  });

  server.on('error', (e) => {
    console.error('[遥控] 启动失败:', e && e.message || e);
  });

  // 绑 0.0.0.0：手机同局域网可访问。令牌 + 白名单是这层的防线。
  server.listen(port, '0.0.0.0', () => {
    const ips = (deps.getLocalIPs && deps.getLocalIPs()) || [];
    console.log('[遥控] 手机遥控页已启动 :' + port + '（令牌已生成）');
    for (const ip of ips) console.log('[遥控]   http://' + ip + ':' + port + '/?t=' + token);
    console.log('[遥控] 令牌文件：' + path.join(deps.recordsDir || '', '遥控令牌.txt'));
  });
  if (server.unref) server.unref();
  return { server, token, port };
}

module.exports = { startRemoteServer };
