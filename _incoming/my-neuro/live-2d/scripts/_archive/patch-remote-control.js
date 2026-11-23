const fs = require('fs');
const path = require('path');

const targetFile = path.resolve(__dirname, '../js/services/remote-control.js');
let content = fs.readFileSync(targetFile, 'utf8');

const startMarker = 'const PAGE = `<!DOCTYPE html>';
const endMarker = '</body></html>`;';

const startIndex = content.indexOf(startMarker);
const endIndex = content.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
  console.error('Markers not found in remote-control.js!');
  process.exit(1);
}

const newPageHtml = `const PAGE = \`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#16131c">
<title>大肥鱼 · 掌心伴侣遥控</title>
<style>
  :root {
    --bg-base: #14111a;
    --surface: rgba(30, 24, 38, 0.88);
    --surface-card: rgba(36, 29, 46, 0.92);
    --raised: rgba(52, 42, 66, 0.85);
    --line: rgba(244, 114, 182, 0.22);
    --line-focus: rgba(244, 114, 182, 0.55);
    --sakura: #f472b6;
    --sakura-light: #fce7f3;
    --peach: #fb923c;
    --ink: #fdf2f8;
    --ink-muted: #c4b5fd;
    --ink-faint: #8b7d99;
    --ok: #4ade80;
    --r-card: 16px;
    --r-btn: 12px;
    --sh: 0 10px 28px rgba(10, 8, 16, 0.5), 0 0 16px rgba(244, 114, 182, 0.12);
  }

  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0;
    background: radial-gradient(circle at 50% 0%, #2a1f33 0%, var(--bg-base) 70%);
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
    background: linear-gradient(135deg, var(--sakura), var(--peach));
    display: grid;
    place-items: center;
    font-size: 18px;
    box-shadow: 0 0 14px rgba(244, 114, 182, 0.4);
    animation: ring-pulse 3.5s infinite ease-in-out;
  }
  @keyframes ring-pulse {
    0%, 100% { transform: scale(1); filter: drop-shadow(0 0 4px rgba(244, 114, 182, 0.3)); }
    50% { transform: scale(1.05); filter: drop-shadow(0 0 10px rgba(244, 114, 182, 0.6)); }
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
    background: rgba(22, 17, 28, 0.85);
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
    border-color: var(--sakura);
    box-shadow: 0 0 14px rgba(244, 114, 182, 0.25);
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
    background: linear-gradient(135deg, var(--sakura) 0%, var(--peach) 100%);
    color: #fff;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.5px;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(244, 114, 182, 0.35);
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
    background: rgba(244, 114, 182, 0.24);
    border-color: var(--sakura);
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
    background: rgba(244, 114, 182, 0.28);
    border-color: var(--sakura);
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
    background: rgba(244, 114, 182, 0.28);
    border-color: var(--sakura);
    color: #fff;
    box-shadow: 0 0 12px rgba(244, 114, 182, 0.3);
  }

  /* 浮动提示 */
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(28px + env(safe-area-inset-bottom));
    transform: translateX(-50%) translateY(20px);
    background: rgba(30, 24, 38, 0.95);
    border: 1px solid var(--sakura);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6), 0 0 20px rgba(244, 114, 182, 0.3);
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
    <div class="avatar-ring">🌸</div>
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
</body></html>\`;`;

content = content.slice(0, startIndex) + newPageHtml + content.slice(endIndex + endMarker.length);
fs.writeFileSync(targetFile, content, 'utf8');
console.log('Successfully patched remote-control.js!');
