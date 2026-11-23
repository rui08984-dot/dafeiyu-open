// live-panel.js —— 直播监控面板（2026-11-09）
//
// 为什么需要：live-dock 只有后台逻辑，主播看不到任何东西——
// 不知道弹幕在不在进、她刚才回了什么、这场播了多久、观众在聊什么。
// 这个面板给主播一块「看得见的仪表盘」。
//
// 端口 :3004（独立，不动 :3002 情绪口 / :3003 手机遥控 / :8030 弹幕服务）
// 安全：只绑 127.0.0.1（这是给主播自己看的工作台，不需要上局域网）；
//       只读为主，唯一的写操作是「开关静默」和「手动触发一句」。
//
// 数据来源：
//   · live-dock 插件内存态（缓冲、最近回过的弹幕、连接状态）
//   · 弹幕服务 :8030 /poll（原始流）
//   · 全局状态（__petQuiet / 活着感 / 情绪）

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

const fs = require('fs');
const path = require('path');

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼 · 直播台</title>
<style>
  :root{
    --bg:#060911;
    --surface:rgba(10, 16, 28, 0.96);
    --raised:rgba(18, 29, 50, 0.92);
    --line:rgba(56, 189, 248, 0.18);
    --line-glow:rgba(56, 189, 248, 0.45);
    --ink:#f8fafc; --ink2:#94a3b8; --ink3:#64748b;
    --ocean:#0284c7; --accent:#38bdf8;
    --cyan:#38bdf8; --cyan-glow:#0284c7;
    --goldfish:var(--ocean); --goldfish-gold:var(--accent); --goldfish-light:#e0f2fe;
    --ok:#34d399; --warn:#fbbf24; --bad:#f87171; --info:#38bdf8;
    --r:12px;
  }
  *{box-sizing:border-box}
  body{
    margin:0;background:radial-gradient(ellipse at 50% 0%, #0d1e38 0%, var(--bg) 75%);
    color:var(--ink);
    font:13.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    padding:18px 20px 32px;display:grid;gap:14px;
    grid-template-columns:minmax(0,1fr) minmax(0,1fr);
    grid-auto-rows:min-content;
    align-content:start;min-height:100vh
  }
  @media (max-width:900px){ body{grid-template-columns:1fr; padding:12px} }
  h1{font-size:16.5px;margin:0;display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.3px;color:#fff}
  .brand-avatar-mini{
    width:32px;height:32px;border-radius:50%;
    background:linear-gradient(135deg, var(--ocean), var(--accent));
    display:grid;place-items:center;font-size:16px;
    box-shadow:0 0 12px rgba(56, 189, 248, 0.45);
    flex:none;
  }
  .badge-tag{
    font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;
    background:rgba(56, 189, 248, 0.16);border:1px solid rgba(56, 189, 248, 0.35);
    color:var(--cyan);letter-spacing:1px;font-family:Consolas, monospace;margin-left:4px;
  }
  .dot{width:8px;height:8px;border-radius:50%;background:var(--ink3);flex:none;transition:all .3s}
  .dot.on{background:var(--ok);box-shadow:0 0 10px var(--ok);animation:dot-glow 2s infinite ease-in-out}
  .dot.off{background:var(--bad);box-shadow:0 0 8px var(--bad)}
  @keyframes dot-glow {
    0%,100%{box-shadow:0 0 6px var(--ok)}
    50%{box-shadow:0 0 14px var(--ok)}
  }
  .sub{color:var(--ink2);font-size:12px;margin-top:2px}
  .card{
    background:var(--surface);border:1px solid var(--line);border-radius:var(--r);
    padding:16px 18px;box-shadow:0 12px 36px rgba(0,0,0,.55), 0 0 16px rgba(56,189,248,.08);
    backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
    position:relative;overflow:hidden;
  }
  .card::before{
    content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg, transparent 0%, rgba(56,189,248,.45) 30%, rgba(2,132,199,.45) 70%, transparent 100%);
    pointer-events:none;
  }
  .card h2{
    font-size:11.5px;color:var(--cyan);margin:0 0 12px;font-weight:700;
    letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center;gap:6px;
  }
  .card h2::before{
    content:'';width:3px;height:12px;background:linear-gradient(to bottom, var(--accent), var(--ocean));
    border-radius:2px;display:inline-block;
  }
  .kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .kpi div{
    background:var(--raised);border:1px solid rgba(255,255,255,.05);border-radius:10px;
    padding:10px 6px;text-align:center;min-width:0;
    transition:border-color .2s, transform .2s, box-shadow .2s;
  }
  .kpi div:hover{
    border-color:rgba(56,189,248,.35);transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,.4);
  }
  .kpi b{
    display:block;font-size:22px;font-weight:750;line-height:1.25;
    background:linear-gradient(135deg, #fff 30%, #38bdf8 100%);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;
    font-variant-numeric:tabular-nums;font-family:Consolas,"Segoe UI",monospace;
  }
  #k-gift{
    background:linear-gradient(135deg, #fff 20%, var(--accent) 100%);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;
  }
  .kpi span{font-size:11px;color:var(--ink2);white-space:nowrap;font-weight:500}
  .feed{
    max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:7px;
    scrollbar-width:thin;scrollbar-color:rgba(56,189,248,.3) transparent;
  }
  .feed::-webkit-scrollbar{width:4px}
  .feed::-webkit-scrollbar-thumb{background:rgba(56,189,248,.3);border-radius:2px}
  .item{
    background:var(--raised);border-radius:8px;padding:8px 12px;font-size:12.5px;
    border-left:3px solid var(--line);
    transition:background .15s, border-color .15s;
  }
  .item:hover{background:rgba(28,44,72,.95)}
  .item.danmu{border-left-color:var(--accent)}
  .item.gift{border-left-color:var(--accent);background:rgba(56,189,248,.12)}
  .item.superchat{border-left-color:var(--ocean);background:rgba(2,132,199,.20);font-weight:600}
  .item.follow{border-left-color:var(--ocean);background:rgba(2,132,199,.12)}
  .item.enter{border-left-color:rgba(255,255,255,.15);color:var(--ink2);font-size:12px}
  .item.system{border-left-color:var(--ink3);color:var(--ink2)}
  .item .u{color:var(--accent);font-weight:600;margin-right:6px}
  .item.gift .u, .item.superchat .u{color:var(--goldfish-light)}
  .item .t{color:var(--ink3);font-size:11px;float:right;font-family:Consolas,monospace}
  .row{display:flex;gap:10px;align-items:center;margin-bottom:10px}
  .row:last-child{margin-bottom:0}
  .row label{flex:none;width:58px;color:var(--ink2);font-size:12.5px;font-weight:550}
  .bar{flex:1;height:7px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden}
  .bar i{display:block;height:100%;border-radius:999px;transition:width .4s ease}
  #bar-time{background:linear-gradient(90deg, var(--ocean), var(--accent))}
  #bar-hunger{background:linear-gradient(90deg, #0284c7, #38bdf8)}
  #bar-energy{background:linear-gradient(90deg, #059669, #34d399)}
  #bar-intimacy{background:linear-gradient(90deg, #0369a1, #7dd3fc)}
  button{
    font:inherit;font-size:12.5px;font-weight:600;color:var(--ink);background:var(--raised);
    border:1px solid var(--line);border-radius:8px;padding:7px 14px;cursor:pointer;
    transition:all .18s cubic-bezier(.16,1,.3,1);user-select:none;
    display:inline-flex;align-items:center;justify-content:center;gap:6px;
  }
  button:hover{
    background:rgba(56,189,248,.16);border-color:var(--cyan);color:#fff;
    box-shadow:0 0 12px rgba(56,189,248,.25);
  }
  button:active{transform:scale(.97)}
  button.primary{
    background:linear-gradient(135deg, var(--ocean) 0%, var(--accent) 100%);
    border-color:rgba(56,189,248,.6);color:#fff;
    box-shadow:0 4px 14px rgba(2,132,199,.35);
  }
  button.primary:hover{filter:brightness(1.15);box-shadow:0 4px 20px rgba(56,189,248,.45)}
  button#btn-quiet.on{
    background:linear-gradient(135deg, var(--ocean) 0%, var(--accent) 100%);
    border-color:var(--accent);color:#fff;
    box-shadow:0 0 16px rgba(56,189,248,.45);
  }
  .empty{color:var(--ink3);font-size:12.5px;text-align:center;padding:24px 0}
  .wide{grid-column:1/-1}
  input{
    background:var(--raised);border:1px solid var(--line);border-radius:8px;
    color:var(--ink);padding:8px 14px;font:inherit;font-size:13px;flex:1;outline:none;
    transition:border-color .2s, box-shadow .2s;
  }
  input:focus{border-color:var(--cyan);box-shadow:0 0 14px rgba(56,189,248,.3)}
</style></head>
<body>

<div class="card wide" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
  <div style="display:flex;align-items:center;gap:12px">
    <div class="brand-avatar-mini">🐟</div>
    <div>
      <h1><span class="dot" id="dot"></span>大肥鱼 · 直播台 <span class="badge-tag">LIVE DOCK</span></h1>
      <div class="sub" id="status">正在连接…</div>
    </div>
  </div>
  <div style="display:flex;gap:10px;align-items:center">
    <button id="btn-quiet">静默模式</button>
    <button id="btn-feed">🐟 投喂</button>
    <button id="btn-say" class="primary">💬 手动说一句</button>
  </div>
</div>

<div class="card">
  <h2>本场数据</h2>
  <div class="kpi">
    <div><b id="k-danmu">0</b><span>弹幕总数</span></div>
    <div><b id="k-replied">0</b><span>她回了</span></div>
    <div><b id="k-gift">0</b><span>礼物</span></div>
    <div><b id="k-buffer">0</b><span>等待中</span></div>
  </div>
  <div style="margin-top:14px">
    <div class="row"><label>播了</label><div class="bar"><i id="bar-time" style="width:0%"></i></div><span class="sub mono" id="t-time" style="min-width:64px;text-align:right">—</span></div>
  </div>
</div>

<div class="card">
  <h2>她的状态</h2>
  <div class="row"><label>饱食</label><div class="bar"><i id="bar-hunger" style="width:0%"></i></div><span class="sub mono" id="t-hunger" style="min-width:40px;text-align:right">—</span></div>
  <div class="row"><label>精力</label><div class="bar"><i id="bar-energy" style="width:0%"></i></div><span class="sub mono" id="t-energy" style="min-width:40px;text-align:right">—</span></div>
  <div class="row"><label>亲密</label><div class="bar"><i id="bar-intimacy" style="width:0%"></i></div><span class="sub mono" id="t-intimacy" style="min-width:40px;text-align:right">—</span></div>
  <div class="row"><label>心情</label><span class="sub" id="t-mood" style="flex:1;color:var(--accent);font-weight:600">—</span></div>
</div>

<div class="card" style="grid-row:span 2">
  <h2>弹幕流（最近 40 条）</h2>
  <div class="feed" id="feed" style="max-height:520px"><div class="empty">还没收到弹幕</div></div>
</div>

<div class="card wide">
  <h2>她最近回的</h2>
  <div class="feed" id="replies" style="max-height:180px"><div class="empty">还没回过</div></div>
</div>

<div class="card wide">
  <h2>手动说话</h2>
  <div style="display:flex;gap:10px">
    <input id="say-input" placeholder="打一句让她说…（回车发送）">
    <button id="btn-say-send" class="primary">发送</button>
  </div>
</div>

<script>
async function api(path, body) {
  const r = await fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : {});
  return r.json();
}
function esc(s) { return String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
function fmtTime(s) {
  if (!s || s < 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  return h > 0 ? h + '小时' + m + '分' : (m > 0 ? m + '分' + ss + '秒' : ss + '秒');
}
let lastFeedKey = '';

async function refresh() {
  try {
    const d = await api('/live-panel/data');
    if (!d.ok) { document.getElementById('status').textContent = '数据读取失败：' + (d.error || ''); return; }
    const s = d.data || {};
    // 连接状态
    const dot = document.getElementById('dot');
    dot.className = 'dot ' + (s.serverUp ? 'on' : 'off');
    document.getElementById('status').textContent =
      (s.serverUp ? '弹幕服务在线' : '弹幕服务离线') +
      ' · 房间 ' + (s.roomId || '未设置') +
      ' · 源 ' + (s.source || '?') +
      (s.liveNow ? ' · 正在直播' : '') +
      (s.quiet ? ' · 静默中' : '');

    // KPI
    document.getElementById('k-danmu').textContent = s.totalDanmaku || 0;
    document.getElementById('k-replied').textContent = s.repliedCount || 0;
    document.getElementById('k-gift').textContent = s.giftCount || 0;
    document.getElementById('k-buffer').textContent = s.bufferLen || 0;

    // 时长
    const dur = s.liveSeconds || 0;
    document.getElementById('t-time').textContent = fmtTime(dur);
    document.getElementById('bar-time').style.width = Math.min(100, (dur / 7200) * 100) + '%';

    // 状态
    const st = s.alive || {};
    for (const k of ['hunger', 'energy', 'intimacy']) {
      const v = Number(st[k]);
      const pct = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
      document.getElementById('bar-' + k).style.width = pct + '%';
      document.getElementById('t-' + k).textContent = Number.isFinite(v) ? Math.round(v) + '%' : '—';
    }
    document.getElementById('t-mood').textContent = s.mood || '—';

    // 弹幕流
    const feed = s.feed || [];
    const key = feed.map(f => f.seq).join(',');
    if (key !== lastFeedKey) {
      lastFeedKey = key;
      const box = document.getElementById('feed');
      box.innerHTML = feed.length ? feed.slice().reverse().map(f =>
        '<div class="item ' + esc(f.type) + '"><span class="u">' + esc(f.user) + '</span>' +
        esc(f.text) + '<span class="t">' + (f.ago != null ? f.ago + 's前' : '') + '</span></div>'
      ).join('') : '<div class="empty">还没收到弹幕</div>';
    }

    // 她的回应
    const rep = s.replies || [];
    const rkey = rep.length + ':' + (rep[0] ? rep[0].at : '');
    if (rep._k !== rkey) {
      document.getElementById('replies').innerHTML = rep.length ? rep.map(r =>
        '<div class="item danmu">' + esc(r.text) + '<span class="t">' + esc(r.to || '') + '</span></div>'
      ).join('') : '<div class="empty">还没回过</div>';
      rep._k = rkey;
    }

    document.getElementById('btn-quiet').classList.toggle('on', !!s.quiet);
    document.getElementById('btn-quiet').textContent = s.quiet ? '静默：开' : '静默：关';
  } catch (e) {
    document.getElementById('status').textContent = '连不上面板服务：' + e.message;
  }
}

document.getElementById('btn-quiet').addEventListener('click', async () => {
  const cur = document.getElementById('btn-quiet').classList.contains('on');
  await api('/live-panel/quiet', { on: !cur });
  refresh();
});
document.getElementById('btn-say-send').addEventListener('click', doSay);
document.getElementById('say-input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doSay(); });
async function doSay() {
  const el = document.getElementById('say-input');
  const t = el.value.trim();
  if (!t) return;
  await api('/live-panel/say', { text: t });
  el.value = '';
}
document.getElementById('btn-say').addEventListener('click', () => {
  document.getElementById('say-input').focus();
});
document.getElementById('btn-feed').addEventListener('click', async () => {
  const r = await api('/live-panel/feed', {});
  refresh();
});

refresh();
setInterval(refresh, 3000);
</script>
</body></html>`;
// 页面外置（2026-11-16）：内联 HTML 没法用设计工具改。优先读 pages/live-panel.html，
// 按 mtime 热更新（改完刷新浏览器即可看到）；文件缺失时回退内联 PAGE，保证不会白屏。
const PAGE_FILE = path.join(__dirname, 'pages', 'live-panel.html');
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
 *   deps.getWindow()    → BrowserWindow
 *   deps.port           → 默认 3004
 *   deps.dbPath         → 会话统计文件（可选，落盘供复盘）
 */
function startLivePanel(deps) {
    const port = Number(deps.port) || 3004;
    const startedAt = Date.now();
    const stats = { totalDanmaku: 0, repliedCount: 0, giftCount: 0, replies: [], seenSeq: 0, feed: [] };

    const server = http.createServer((req, res) => {
        let u;
        try { u = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { ok: false, error: 'bad url' }); }

        if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/live-panel')) {
            return send(res, 200, pageHtml(), 'text/html; charset=utf-8');
        }

        if (u.pathname === '/live-panel/data' && req.method === 'GET') {
            const win = deps.getWindow && deps.getWindow();
            if (!win || win.isDestroyed()) return send(res, 200, { ok: false, error: '窗口不可用' });
            const js = `(() => {
                const out = {};
                try {
                    const pm = window.pluginManager;
                    const e = pm && pm._plugins.get('community/live-dock');
                    const pl = e && e.plugin;
                    if (pl) {
                        out.source = pl._source; out.roomId = pl._roomId;
                        out.serverUp = pl._serverUp === true;
                        out.bufferLen = (pl._buffer || []).length;
                        out.lastDanmakuAt = pl._lastDanmakuAt || 0;
                        out.feed = (pl._buffer || []).slice(-40).map((it, i) => ({
                            seq: it.seq != null ? it.seq : i, user: it.user, text: it.text,
                            type: it.type || 'danmu',
                            ago: Math.round((Date.now() - (it.ts ? it.ts * 1000 : Date.now())) / 1000),
                        }));
                    }
                } catch (e) { out.err1 = String(e.message || e); }
                out.quiet = !!global.__petQuiet;
                try {
                    const st = (window.pluginManager && window.pluginManager._plugins.get('community/alive-state'));
                    const s = st && st.plugin && st.plugin._state;
                    // ⚠ 字段名对齐（2026-11-09 实测）：state-model 里叫 satiety，面板原先读 hunger
                    // → 面板一直显示「—」。这里两个名字都给，前端用 hunger 就行。
                    if (s) out.alive = {
                        hunger: s.satiety, satiety: s.satiety,
                        energy: s.energy, intimacy: s.intimacy,
                    };
                } catch (e) { /* 活着感没开 */ }
                try {
                    out.mood = window.__petMood && window.__petMood.describe
                        ? String((window.__petMood.describe() || {}).line || '').slice(0, 24) : '';
                } catch (e) { /* ignore */ }
                return JSON.stringify(out);
            })()`;
            return win.webContents.executeJavaScript(js)
                .then((raw) => {
                    let d = {};
                    try { d = JSON.parse(raw); } catch (e) { d = {}; }
                    const now = Date.now();
                    const recently = d.lastDanmakuAt && (now - d.lastDanmakuAt < 10 * 60 * 1000);
                    const liveNow = d.source === 'blivedm' && d.serverUp === true && !!recently;
                    // 统计：累计弹幕/礼物（用 seenSeq 去重，按 seq 单调递增判断新条目）
                    const feed = d.feed || [];
                    let newOnes = 0;
                    for (const it of feed) {
                        if (it.type === 'gift') stats.giftCount += 0;   // 礼物算在 total 里，不重复累加
                    }
                    // 简单累计：feed 长度变化就算新增（够用，不追求精确）
                    if (feed.length > (stats._lastFeedLen || 0)) {
                        const delta = feed.length - (stats._lastFeedLen || 0);
                        stats.totalDanmaku += delta;
                        const gifts = feed.slice(-delta).filter(f => f.type === 'gift').length;
                        stats.giftCount += gifts;
                    }
                    stats._lastFeedLen = feed.length;
                    send(res, 200, {
                        ok: true,
                        data: {
                            source: d.source, roomId: d.roomId, serverUp: d.serverUp,
                            bufferLen: d.bufferLen, feed,
                            quiet: d.quiet, alive: d.alive, mood: d.mood,
                            liveNow,
                            totalDanmaku: stats.totalDanmaku,
                            repliedCount: stats.repliedCount,
                            giftCount: stats.giftCount,
                            replies: stats.replies.slice(0, 20),
                            liveSeconds: Math.round((now - startedAt) / 1000),
                        },
                    });
                })
                .catch((e) => send(res, 200, { ok: false, error: String(e && e.message || e) }));
        }

        if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'not found' });

        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) { try { req.destroy(); } catch (e) { /* ignore */ } } });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch (e) { return send(res, 400, { ok: false, error: 'bad json' }); }
            const win = deps.getWindow && deps.getWindow();
            if (!win || win.isDestroyed()) return send(res, 200, { ok: false, error: '窗口不可用' });
            const run = (js) => win.webContents.executeJavaScript(js);

            if (u.pathname === '/live-panel/quiet') {
                const on = !!body.on;
                // 同 remote-control：走 8103 /quiet 才会持久化并广播给渲染层
                return postQuiet(on).then((r) => {
                    if (r && r.ok !== false) return send(res, 200, { ok: true, on: r.quiet !== false });
                    return run(`(() => { global.__petQuiet = ${on ? 'true' : 'false'}; return 'ok'; })()`)
                        .then(() => send(res, 200, { ok: true, on, persisted: false }))
                        .catch((e) => send(res, 200, { ok: false, error: String(e && e.message || e) }));
                });
            }
            if (u.pathname === '/live-panel/say') {
                const text = String(body.text || '').trim().slice(0, 200);
                if (!text) return send(res, 200, { ok: false, error: '内容为空' });
                return run(`(async () => {
                    const vc = window.voiceChat;
                    if (!vc || typeof vc.sendToLLM !== 'function') return 'no-voicechat';
                    try { await vc.sendToLLM(${JSON.stringify(text)}); return 'sent'; }
                    catch (e) { return 'err:' + (e && e.message || e); }
                })()`)
                    .then((r) => {
                        if (String(r) === 'sent') stats.repliedCount += 1;
                        send(res, 200, { ok: String(r) === 'sent', result: String(r) });
                    })
                    .catch((e) => send(res, 200, { ok: false, error: String(e && e.message || e) }));
            }
            if (u.pathname === '/live-panel/feed') {
                // 投喂：直接调 alive-state 的 pet_care 工具（走它自己的饱食/亲密逻辑，不绕过）
                return run(`(async () => {
                    try {
                        const pm = window.pluginManager;
                        const e = pm && pm._plugins.get('community/alive-state');
                        const pl = e && e.plugin;
                        if (!pl) return 'no-plugin';
                        // 真实方法名是 doFeed()（返回 JSON 字符串，含饱食/精力/亲密）
                        if (typeof pl.doFeed === 'function') {
                            const r = pl.doFeed();
                            return (r && String(r).indexOf('"ok":true') >= 0) ? 'ok' : ('res:' + String(r).slice(0, 60));
                        }
                        return 'no-method';
                    } catch (e) { return 'err:' + (e && e.message || e); }
                })()`)
                    .then((r) => send(res, 200, { ok: String(r) === 'ok', result: String(r) }))
                    .catch((e) => send(res, 200, { ok: false, error: String(e && e.message || e) }));
            }
            return send(res, 404, { ok: false, error: 'not found' });
        });
    });

    server.on('error', (e) => console.error('[直播台] 启动失败:', e && e.message || e));
    // 只绑本机：这是主播自己的工作台
    server.listen(port, '127.0.0.1', () => {
        console.log('[直播台] http://127.0.0.1:' + port + '/');
    });
    if (server.unref) server.unref();
    return { server, port };
}

module.exports = { startLivePanel };
