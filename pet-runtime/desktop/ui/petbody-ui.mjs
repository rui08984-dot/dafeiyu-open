// ui/petbody-ui.mjs — 挂进 my-neuro 宿主页的舞台层（420×760 底部堆叠布局）
//
// 分区（窗口 420×760，全部按「距底边」定位，窗口高度变化时保持结构）：
//   0–44px      顶栏：默认可拖，右侧 ⚙ / 字 两个 30×30 圆钮
//   44–470px    身体区：透明热区，可点可拖（canvas 会吞点击，所以必须有一层 DOM）
//   470–600px   字幕/气泡带：宿主 #subtitle-container 优先；最多 3 行，超出滚动
//   600–680px   输入框：宿主 #text-chat-container（宿主旧布局由 ui.js 覆盖成整行）
//   680–760px   圆钮行：5 个 44×44 圆钮，水平居中、间距 12px
//   控制面板：右侧抽屉，宽 300，高度 44–470，不和输入框/字幕/圆钮相交
//
// 样式全部 scope 在 #petbody-ui 下，宿主自己的 .panel / .caption 规则不受影响。

import { Panel } from './panel.mjs';

const STYLE_ID = 'petbody-ui-style';
const PANEL_TABS = ['expression', 'motion', 'asset'];
const IDLE_AFTER_MS = 4000;
const PASSTHROUGH_GUARD_MS = 4000;

const CSS = `
#petbody-ui {
  --pb-ink: #24344e;
  --pb-ink-soft: #5f7391;
  --pb-ink-faint: #8595ac;
  --pb-line: rgba(255, 255, 255, .88);
  --pb-blue: #6d9bd0;
  --pb-blue-deep: #4e7cb4;
  position: fixed;
  inset: 0;
  pointer-events: none;
  color: var(--pb-ink);
  font-family: "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  z-index: 30000;
}
#petbody-ui * { box-sizing: border-box; }
#petbody-ui button { font-family: inherit; cursor: pointer; }
#petbody-ui button:focus-visible { outline: 2px solid var(--pb-blue); outline-offset: 2px; }
#petbody-ui .pb-hidden { display: none !important; }

/* ── 顶栏（0–44）：可拖，右侧两个 30×30 圆钮 ───────────────── */
#petbody-ui .pb-topbar {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 7px 12px;
  pointer-events: auto;
  cursor: grab;
}
#petbody-ui .pb-topbar.dragging { cursor: grabbing; }
#petbody-ui .pb-topbar .pb-btn { pointer-events: auto; cursor: pointer; }
#petbody-ui .pb-btn {
  width: 30px; height: 30px;
  padding: 0;
  display: grid; place-items: center;
  border: 1px solid var(--pb-line);
  border-radius: 50%;
  background: linear-gradient(165deg, rgba(255, 255, 255, .92), rgba(226, 238, 251, .8));
  box-shadow: 0 3px 10px rgba(25, 45, 75, .16);
  color: #44607f;
  font-size: 14px; line-height: 1;
  /* 2026-11-21：常显按钮**不做毛玻璃**。它的背景是 alpha .8–.92 的近实色渐变，
     模糊看不到任何细节，但透明窗口上 backdrop-filter 会每帧读「窗口下方桌面」重算 —— 
     拖动时实测这是最贵的单项开销（见 petbody-entry 的拖动冻结注释）。 */
  transition: transform .16s ease, box-shadow .16s ease, color .16s ease, background .16s ease, opacity .2s ease;
}
#petbody-ui .pb-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(25, 45, 75, .22); color: var(--pb-blue-deep); }
#petbody-ui .pb-btn.active {
  color: #fff;
  background: linear-gradient(160deg, #8fb6e0, #5f8ec6);
  border-color: rgba(255, 255, 255, .8);
  box-shadow: 0 5px 14px rgba(63, 104, 156, .38);
}

/* ── 身体热区（44–470）：透明，可点可拖 ────────────────────── */
#petbody-ui .pb-body {
  position: fixed;
  top: 44px; left: 0; right: 0;
  bottom: 290px;
  pointer-events: auto;
  cursor: grab;
  background: transparent;
}
#petbody-ui .pb-body.dragging { cursor: grabbing; }

/* ── 圆钮行（680–760）：5 个 44×44，居中，间距 12px ─────────── */
#petbody-ui .pb-dock {
  position: fixed;
  bottom: 18px; left: 0; right: 0;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  pointer-events: none;
  transition: opacity .45s ease;
  z-index: 31300;
}
#petbody-ui .pb-dock.idle { opacity: .12; }
#petbody-ui .pb-dock .pb-btn {
  width: 44px; height: 44px;
  font-size: 19px;
  pointer-events: auto;
}
#petbody-ui .pb-btn.passthrough { opacity: .4; }
#petbody-ui .pb-btn[data-role="ptt"].recording {
  color: #fff;
  background: linear-gradient(160deg, #f08a8a, #d9534f);
  border-color: rgba(255, 255, 255, .85);
  animation: pb-ptt-pulse 1.1s ease-in-out infinite;
}
@keyframes pb-ptt-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(217, 83, 79, .55); }
  50% { box-shadow: 0 0 0 10px rgba(217, 83, 79, 0); }
}

/* ── 字幕/气泡带（470–600）：我们的兜底层 ─────────────────── */
#petbody-ui .caption {
  position: fixed;
  left: 16px; right: 16px;
  bottom: 160px;
  min-height: 0;
  max-height: 126px;
  padding: 8px 30px 8px 14px;
  border-radius: 16px;
  background: linear-gradient(165deg, rgba(22, 32, 48, .66), rgba(15, 23, 36, .54));
  border: 1px solid rgba(255, 255, 255, .18);
  box-shadow: 0 10px 26px rgba(8, 16, 30, .3);
  backdrop-filter: blur(9px) saturate(1.08);
  -webkit-backdrop-filter: blur(9px) saturate(1.08);
  color: #f2f7ff;
  font-size: 15px;
  line-height: 1.55;
  text-align: center;
  word-break: break-word;
  overflow-y: auto;
  scrollbar-width: none;
  pointer-events: none;
  opacity: 0;
  transition: opacity .3s ease, transform .3s ease;
  z-index: 30200;
}
#petbody-ui .caption::-webkit-scrollbar { display: none; }
#petbody-ui .caption.show { opacity: 1; }
#petbody-ui .caption.idle { opacity: .03; pointer-events: none; }
#petbody-ui .caption-text { margin: 0; white-space: pre-wrap; }
#petbody-ui .caption-close {
  position: absolute; top: 6px; right: 6px;
  display: grid; place-items: center;
  width: 18px; height: 18px; padding: 0;
  border: 0; border-radius: 50%;
  background: rgba(255, 255, 255, .12); color: #d7e4f6;
  font-size: 13px; line-height: 1; opacity: .6;
  transition: opacity .15s ease, background .15s ease;
}
#petbody-ui .caption:hover .caption-close { opacity: 1; }
#petbody-ui .caption-close:hover { background: rgba(255, 255, 255, .26); }

/* ── 控制面板：右侧抽屉 300 宽，高度 44–470 ───────────────── */
#petbody-ui .panel {
  position: fixed;
  right: 0;
  top: 44px;
  bottom: 290px;
  width: 300px;
  max-width: calc(100vw - 16px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 10px 8px;
  border-radius: 18px 0 0 18px;
  background: linear-gradient(168deg, rgba(253, 254, 255, .96), rgba(230, 240, 252, .93));
  border: 1px solid var(--pb-line);
  border-right: 0;
  box-shadow: -10px 14px 40px rgba(18, 38, 66, .26);
  backdrop-filter: blur(20px) saturate(1.16);
  -webkit-backdrop-filter: blur(20px) saturate(1.16);
  opacity: 0;
  transform: translateX(calc(100% + 18px));
  pointer-events: none;
  transition: transform .3s cubic-bezier(.22, .9, .25, 1), opacity .24s ease;
  z-index: 30500;
}
#petbody-ui .panel.show { opacity: 1; transform: none; pointer-events: auto; }
#petbody-ui .panel-head { display: flex; align-items: center; gap: 8px; flex: none; }
#petbody-ui .panel-title {
  display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0;
  font-size: 12.5px; font-weight: 600; letter-spacing: .05em; color: #33496a;
}
#petbody-ui .panel-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #a9c8ea, #6d9bd0);
  box-shadow: 0 0 0 3px rgba(109, 155, 208, .14);
}
#petbody-ui .panel-close {
  display: grid; place-items: center;
  width: 26px; height: 26px; padding: 0;
  border: 0; border-radius: 9px;
  background: rgba(120, 150, 190, .1); color: #6a7f9c;
  font-size: 17px; line-height: 1;
  transition: background .15s ease, color .15s ease;
}
#petbody-ui .panel-close:hover { background: rgba(120, 150, 190, .2); color: #3f5578; }
#petbody-ui .panel-tabs { display: flex; gap: 4px; padding: 3px; border-radius: 11px; background: rgba(128, 156, 192, .12); flex: none; }
#petbody-ui .panel-tab {
  flex: 1; min-width: 0;
  display: flex; align-items: center; justify-content: center; gap: 3px;
  padding: 5px 3px; border: 0; border-radius: 8px;
  background: transparent; color: #5e7392;
  font-size: 11.5px; line-height: 1.3; white-space: nowrap;
  transition: background .16s ease, color .16s ease, box-shadow .16s ease;
}
#petbody-ui .panel-tab em {
  font-style: normal; font-size: 9.5px; padding: 0 4px; border-radius: 999px;
  background: rgba(110, 145, 190, .16); color: #5d7b9f; line-height: 15px;
}
#petbody-ui .panel-tab[aria-selected="true"] { background: rgba(255, 255, 255, .94); color: #33547d; box-shadow: 0 1px 4px rgba(50, 80, 118, .12); }
#petbody-ui .panel-tab[aria-selected="true"] em { background: rgba(109, 155, 208, .22); color: #3d6089; }
#petbody-ui .panel-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: rgba(130, 158, 194, .45) transparent;
  padding: 2px 2px 4px;
}
#petbody-ui .panel-body::-webkit-scrollbar { width: 5px; }
#petbody-ui .panel-body::-webkit-scrollbar-thumb { background: rgba(130, 158, 194, .4); border-radius: 999px; }
#petbody-ui .panel-view { display: flex; flex-direction: column; gap: 7px; }
#petbody-ui .panel-view[hidden] { display: none; }

/* 2 列网格 + 分组标题 */
#petbody-ui .chips,
#petbody-ui .asset-groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
#petbody-ui .asset-group { display: contents; }
#petbody-ui .asset-group-title {
  grid-column: 1 / -1;
  display: flex; align-items: center; gap: 6px;
  margin: 3px 1px 1px;
  color: #7790ad; font-size: 9.5px; letter-spacing: .14em;
}
#petbody-ui .asset-group-title::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(130, 158, 194, .3), transparent); }
#petbody-ui .chip,
#petbody-ui .asset-row,
#petbody-ui .row {
  min-width: 0;
  display: flex; align-items: center; gap: 6px;
  padding: 6px 7px;
  border: 1px solid rgba(255, 255, 255, .82);
  border-radius: 9px;
  background: rgba(255, 255, 255, .66);
  color: #435b7c;
  font-size: 11px; line-height: 1.3;
  text-align: left;
  box-shadow: 0 1px 3px rgba(40, 70, 105, .06);
  transition: background .14s ease, color .14s ease, box-shadow .14s ease;
}
#petbody-ui .chip { justify-content: center; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#petbody-ui .row { grid-column: 1 / -1; }
#petbody-ui .chip:hover,
#petbody-ui .asset-row:hover,
#petbody-ui .row:hover { background: #fff; box-shadow: 0 2px 8px rgba(40, 70, 105, .12); }
#petbody-ui .chip.active {
  color: #fff; background: linear-gradient(160deg, #8ab3df, #5f8ec6);
  border-color: rgba(255, 255, 255, .7); box-shadow: 0 3px 10px rgba(63, 104, 156, .28);
}
#petbody-ui .row .row-icon {
  flex: 0 0 18px; display: grid; place-items: center;
  width: 18px; height: 18px; border-radius: 50%;
  background: rgba(109, 155, 208, .16); color: #5b83b3;
}
#petbody-ui .row .row-icon svg { width: 10px; height: 10px; fill: currentColor; }
#petbody-ui .row .row-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#petbody-ui .row .row-idx { flex: none; color: #91a2b8; font-size: 9.5px; }
#petbody-ui .asset-label { flex: 1; min-width: 0; color: #3d5578; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#petbody-ui .asset-value { flex: none; color: #7a90ab; font-size: 9.5px; max-width: 52px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#petbody-ui .switch {
  position: relative; flex: 0 0 30px; width: 30px; height: 17px; padding: 0;
  border: 1px solid rgba(255, 255, 255, .8); border-radius: 999px;
  background: rgba(150, 170, 196, .35);
  transition: background .18s ease, box-shadow .18s ease;
}
#petbody-ui .switch::after {
  content: ""; position: absolute; top: 1.5px; left: 1.5px;
  width: 12px; height: 12px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(30, 50, 80, .28);
  transition: transform .18s cubic-bezier(.2, .8, .2, 1);
}
#petbody-ui .switch[aria-checked="true"] { background: linear-gradient(160deg, #8fb6e0, #6293cb); }
#petbody-ui .switch[aria-checked="true"]::after { transform: translateX(13px); }
#petbody-ui .cycle-btn {
  flex: none; padding: 2px 7px;
  border: 1px solid rgba(255, 255, 255, .8); border-radius: 999px;
  background: rgba(255, 255, 255, .82); color: #4a6688;
  font-size: 10px; line-height: 1.4;
}
#petbody-ui .cycle-btn:hover { background: #fff; color: var(--pb-blue-deep); }

/* 预设行：固定吸底 */
#petbody-ui .panel-presets {
  flex: none;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
  padding-top: 7px;
  border-top: 1px solid rgba(130, 158, 194, .2);
}
#petbody-ui .preset-btn {
  min-width: 0;
  padding: 6px 4px;
  border: 1px solid rgba(255, 255, 255, .84);
  border-radius: 9px;
  background: rgba(255, 255, 255, .72);
  color: #42608a; font-size: 11px; line-height: 1.3;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background .15s ease, color .15s ease, box-shadow .15s ease;
}
#petbody-ui .preset-btn:hover { background: #fff; box-shadow: 0 2px 8px rgba(40, 70, 105, .14); }
#petbody-ui .preset-btn.active {
  color: #fff; background: linear-gradient(160deg, #8ab3df, #5f8ec6);
  border-color: rgba(255, 255, 255, .7);
}
#petbody-ui .notice {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  padding: 9px 10px; border-radius: 11px;
  background: rgba(255, 246, 230, .8);
  border: 1px solid rgba(238, 214, 176, .8);
  color: #7c6337; font-size: 10.5px; line-height: 1.6;
}
#petbody-ui .notice button {
  padding: 3px 9px; border: 1px solid rgba(215, 188, 148, .9); border-radius: 999px;
  background: rgba(255, 255, 255, .78); color: #8a6a37; font-size: 10px;
}

/* 轻提示 */
#petbody-ui .toast {
  position: fixed; top: 46px; left: 50%;
  transform: translate(-50%, -4px);
  max-width: 86%; padding: 5px 13px;
  border-radius: 999px;
  background: linear-gradient(160deg, rgba(255, 255, 255, .94), rgba(233, 242, 253, .9));
  border: 1px solid var(--pb-line);
  box-shadow: 0 6px 18px rgba(24, 44, 72, .18);
  backdrop-filter: blur(10px);
  color: #3d5478; font-size: 11px; line-height: 1.5;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  opacity: 0; pointer-events: none;
  transition: opacity .22s ease, transform .22s ease;
  z-index: 30600;
}
#petbody-ui .toast.show { opacity: 1; transform: translate(-50%, 0); }

@media (prefers-reduced-motion: reduce) {
  #petbody-ui *, #petbody-ui *::after { transition-duration: .01ms !important; animation: none !important; }
}

/* 拖动时关掉所有毛玻璃（2026-11-21 用户反馈拖拽掉帧）：
   透明窗口上的 backdrop-filter 需要读「窗口下方桌面」做模糊；拖动时下方内容每帧都在变，
   缓存必然失效 → 每个带模糊的按钮/面板每帧重算一次模糊，是拖动时最贵的单项开销。
   拖动只有 1~2 秒，画面里按钮会退化成纯色渐变（原本 alpha 0.8~0.92，本来就看不出模糊），
   换来的拖动跟手性值得。松手 class 移除即恢复。 */
html.pb-dragging #petbody-ui,
html.pb-dragging #petbody-ui * {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
`;

const HTML = `
  <div class="pb-topbar" data-role="topbar">
    <button type="button" class="pb-btn" data-role="panel" title="打开或收起控制面板" aria-label="打开或收起控制面板">⚙</button>
    <button type="button" class="pb-btn" data-role="caption" title="切换大字幕" aria-label="切换大字幕">字</button>
  </div>
  <div class="pb-body" data-role="body"></div>
  <div class="caption" id="petbody-caption" aria-hidden="true">
    <p class="caption-text" id="petbody-caption-text"></p>
    <button type="button" class="caption-close" title="关闭字幕" aria-label="关闭字幕">×</button>
  </div>
  <div class="pb-dock" data-role="dock">
    <button type="button" class="pb-btn" data-role="chat" title="打开或收起聊天框" aria-label="打开或收起聊天框">💬</button>
    <button type="button" class="pb-btn" data-role="panel-dock" title="打开或收起控制面板" aria-label="打开或收起控制面板">⚙</button>
    <button type="button" class="pb-btn" data-role="ptt" title="按住说话" aria-label="按住说话">🎤</button>
    <button type="button" class="pb-btn" data-role="motion" title="随机播放一个动作" aria-label="随机播放一个动作">🎭</button>
    <button type="button" class="pb-btn" data-role="passthrough" title="切换鼠标穿透（4 秒后自动恢复）" aria-label="切换鼠标穿透">👁</button>
  </div>
  <aside class="panel" aria-label="大肥鱼控制面板" aria-hidden="true">
    <header class="panel-head">
      <div class="panel-title"><span class="panel-dot" aria-hidden="true"></span>控制面板</div>
      <button type="button" class="panel-close" title="收起控制面板" aria-label="收起控制面板">×</button>
    </header>
    <nav class="panel-tabs" role="tablist" aria-label="面板分类">
      <button type="button" class="panel-tab" role="tab" data-tab="expression" aria-selected="true">表情<em id="count-expression">0</em></button>
      <button type="button" class="panel-tab" role="tab" data-tab="motion" aria-selected="false">动作<em id="count-motion">0</em></button>
      <button type="button" class="panel-tab" role="tab" data-tab="asset" aria-selected="false">换装<em id="count-asset">0</em></button>
    </nav>
    <div class="panel-body">
      <section class="panel-view" data-view="expression" aria-label="表情列表">
        <div id="expression-grid" class="chips"></div>
      </section>
      <section class="panel-view" data-view="motion" aria-label="动作列表" hidden>
        <div id="motion-list" class="rows"></div>
      </section>
      <section class="panel-view" data-view="asset" aria-label="换装列表" hidden>
        <div id="asset-groups" class="asset-groups"></div>
      </section>
    </div>
    <div class="panel-presets" id="preset-list" aria-label="一键预设"></div>
  </aside>
  <div class="toast" id="petbody-toast" role="status" aria-live="polite"></div>
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const safe = (fn, fallback, label) => {
  try { return fn(); } catch (error) { console.warn('[petbody-ui]' + (label ? ' ' + label : ''), error); return fallback; }
};

export function createPetBodyUi({ body, container, hooks = {} } = {}) {
  if (!body || !container) throw new Error('createPetBodyUi 需要 body 与 container');
  ensureStyles();

  const root = document.createElement('div');
  root.id = 'petbody-ui';
  root.innerHTML = HTML;
  container.appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const refs = {
    topbar: q('.pb-topbar'),
    body: q('.pb-body'),
    dock: q('.pb-dock'),
    panel: q('.panel'),
    tabs: [...root.querySelectorAll('.panel-tab')],
    views: Object.fromEntries([...root.querySelectorAll('.panel-view')].map((view) => [view.dataset.view, view])),
    close: q('.panel-close'),
    presetList: q('#preset-list'),
    caption: q('#petbody-caption'),
    captionText: q('#petbody-caption-text'),
    captionClose: q('.caption-close'),
    toast: q('#petbody-toast'),
    buttons: [...root.querySelectorAll('.pb-btn')],
    btnPanelTop: q('[data-role="panel"]'),
    btnCaption: q('[data-role="caption"]'),
    btnChat: q('[data-role="chat"]'),
    btnPanelDock: q('[data-role="panel-dock"]'),
    btnPtt: q('[data-role="ptt"]'),
    btnMotion: q('[data-role="motion"]'),
    btnPassthrough: q('[data-role="passthrough"]'),
  };

  const state = {
    activeExpression: '',
    activePreset: '',
    captionMode: 'off',
    chatOpen: false,
    clickThrough: false,
    idle: false,
    lastActivity: performance.now(),
    toastTimer: 0,
    passthroughTimer: 0,
    pttActive: false,
    lastHostText: '',
    lastHostTextAt: 0,
    dragging: false,
  };

  const panel = new Panel({
    panel: refs.panel,
    tabs: refs.tabs,
    views: refs.views,
    closeButton: refs.close,
    dockButtons: [],
    onClose: () => { syncDockActive(); markActivity(); },
    onTabChange: (tab) => { markActivity(); refreshTab(tab); },
  });

  /* ── 数据源 ─────────────────────────────────────────────── */
  const renderer = () => body.renderer || null;

  function expressionNames() { return [...(renderer()?.expressions?.keys?.() ?? [])]; }

  function motionItems() {
    const r = renderer();
    const out = [];
    for (const key of r?.motions?.keys?.() ?? []) {
      const [group, index] = String(key).split(':');
      const motionIndex = Number(index) || 0;
      let label = group;
      try {
        const file = r?.settings?.getMotionFileName?.(group, motionIndex);
        if (file) label = String(file).replace(/^.*\//, '').replace(/\.motion3\.json$/i, '') || group;
      } catch (error) { /* 退回组名 */ }
      out.push({ group, index: motionIndex, label });
    }
    return out;
  }

  const assetItems = () => safe(() => body.assetList() || [], [], 'assetList');
  const assetState = () => safe(() => body.assets() || {}, {}, 'assets');
  const presetItems = () => safe(() => body.presets() || [], [], 'presets');
  const activePresetId = () => safe(() => body.presetState?.()?.id || '', '', 'presetState');

  /* ── 渲染 ───────────────────────────────────────────────── */
  function renderExpressions() { panel.renderExpressions(expressionNames(), state.activeExpression); }
  function renderMotions() { panel.renderMotions(motionItems()); }

  function renderAssets() {
    const items = assetItems();
    const assets = assetState();
    state.activePreset = activePresetId();
    panel.renderAssets({ items, state: assets, presets: [], activePreset: '' });
    panel.setCounts({ expressions: expressionNames().length, motions: motionItems().length, assets: items.length });
    renderPresets();
  }

  function renderPresets() {
    const list = presetItems();
    refs.presetList.textContent = '';
    for (const preset of list) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset-btn';
      button.dataset.preset = preset.id;
      button.title = preset.description ? preset.description + '（' + (preset.label || preset.id) + '）' : ('套用预设：' + (preset.label || preset.id));
      button.textContent = preset.label || preset.id;
      if (preset.id === state.activePreset) button.classList.add('active');
      button.addEventListener('click', () => applyPreset(preset.id));
      refs.presetList.appendChild(button);
    }
    if (!list.length) {
      const tip = document.createElement('p');
      tip.className = 'notice';
      tip.textContent = '预设还没就绪';
      refs.presetList.appendChild(tip);
    }
  }

  function refreshTab(tab) {
    if (tab === 'expression') renderExpressions();
    else if (tab === 'motion') renderMotions();
    else if (tab === 'asset') renderAssets();
  }

  function refreshAll() { renderExpressions(); renderMotions(); renderAssets(); renderPresets(); }

  /* ── 提示 / 活动 ────────────────────────────────────────── */
  function toast(text, ms = 1800) {
    const value = String(text || '').trim();
    if (!value) return;
    refs.toast.textContent = value;
    refs.toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => refs.toast.classList.remove('show'), ms);
  }

  function markActivity() {
    state.lastActivity = performance.now();
    if (state.idle) {
      state.idle = false;
      refs.caption.classList.remove('idle');
      refs.dock.classList.remove('idle');
    }
  }

  function checkIdle() {
    if (state.idle) return;
    if (performance.now() - state.lastActivity < IDLE_AFTER_MS) return;
    state.idle = true;
    refs.caption.classList.add('idle');
    refs.dock.classList.add('idle');
  }

  /* ── 表情 / 动作 / 换装 / 预设 ──────────────────────────── */
  function toggleExpression(name) {
    const r = renderer();
    if (!r || !name) return false;
    markActivity();
    if (state.activeExpression === name) {
      safe(() => r.setNamedExpression(name, false), false, 'expression-off');
      state.activeExpression = '';
      renderExpressions();
      return true;
    }
    const pinned = safe(() => r.setNamedExpression(name, true) === true, false, 'expression-on');
    state.activeExpression = pinned ? name : '';
    renderExpressions();
    toast(pinned ? ('表情 · ' + name) : ('表情没加载：' + name));
    return pinned;
  }

  function playMotion(item) {
    const r = renderer();
    if (!r || !item) return false;
    markActivity();
    const ok = safe(() => r.playMotion(item.group, item.index, 2) === true, false, 'playMotion');
    toast(ok ? ('动作 · ' + (item.group === 'Idle' ? '待机' : item.label || item.group)) : '动作播放失败');
    return ok;
  }

  function flipAsset(item) {
    if (!item) return false;
    markActivity();
    const result = safe(() => body.asset(item.id), null, 'asset');
    renderAssets();
    toast((result && result.message) || ((item.label || item.id) + ' 已切换'));
    return true;
  }

  function applyPreset(presetId) {
    markActivity();
    const result = safe(() => body.preset(presetId), null, 'preset');
    state.activePreset = activePresetId();
    renderAssets();
    toast(result?.message || ('预设 · ' + String(presetId)));
    return !!result;
  }

  panel.setHandlers({
    onExpression: (name) => toggleExpression(name),
    onMotion: (item) => playMotion(item),
    onAsset: (item) => flipAsset(item),
    onPreset: (presetId) => applyPreset(presetId),
    onRetryAssets: () => { refreshAll(); toast('已刷新'); },
  });

  /* ── 字幕：宿主 #subtitle-container 优先，本层只做兜底 ──── */
  let captionObserver = null;
  let captionBodyObserver = null;
  let fallbackHideTimer = 0;

  function hostCaptionElements() {
    return { box: document.getElementById('subtitle-container'), text: document.getElementById('subtitle-text') };
  }

  // 只取 #subtitle-text，绝不取容器 textContent（否则会带上「确定」按钮的字）。
  function hostCaptionText() {
    const { text } = hostCaptionElements();
    return text ? String(text.textContent || '').trim() : '';
  }

  function hostCaptionVisible() {
    const { box } = hostCaptionElements();
    if (!box) return false;
    const style = window.getComputedStyle(box);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function setCaptionVisible(visible) {
    const on = !!visible;
    refs.caption.classList.toggle('show', on);
    refs.caption.classList.toggle('pb-hidden', !on);
    refs.caption.setAttribute('aria-hidden', String(!on));
  }

  function showFallback(text, autoHideMs = 0) {
    if (!text) return;
    refs.captionText.textContent = text;
    setCaptionVisible(true);
    clearTimeout(fallbackHideTimer);
    if (autoHideMs > 0) fallbackHideTimer = setTimeout(() => setCaptionVisible(false), autoHideMs);
  }

  function syncCaption() {
    // 字幕独立窗口模式：字幕由主进程的透明副窗显示，皮套窗口内一律不画（含本兜底带）。
    // 标志由 ui-controller.showSubtitle 按配置 ui.subtitle_window 设置。
    if (window.__SUBTITLE_WINDOW_MODE) {
      clearTimeout(fallbackHideTimer);
      setCaptionVisible(false);
      return;
    }
    const { box } = hostCaptionElements();
    const hostText = hostCaptionText();
    if (hostText) { state.lastHostText = hostText; state.lastHostTextAt = Date.now(); }
    if (state.captionMode !== 'big') {
      clearTimeout(fallbackHideTimer);
      setCaptionVisible(false);
      return;
    }
    // 宿主字幕正常显示时完全交给宿主（我们的兜底层不出现，避免出现两个框）。
    if (box && hostCaptionVisible() && hostText) {
      clearTimeout(fallbackHideTimer);
      setCaptionVisible(false);
      return;
    }
    if (!box) {
      if (state.lastHostText) showFallback(state.lastHostText, 0);
      return;
    }
    if (hostText || Date.now() - state.lastHostTextAt < 1500) {
      if (state.lastHostText) showFallback(state.lastHostText, 6000);
      return;
    }
    clearTimeout(fallbackHideTimer);
    setCaptionVisible(false);
  }

  function attachCaptionObservers() {
    captionObserver?.disconnect();
    const { box, text } = hostCaptionElements();
    if (!box || !text) return false;
    captionObserver = new MutationObserver(() => { markActivity(); syncCaption(); });
    captionObserver.observe(box, { attributes: true, attributeFilter: ['style', 'class'] });
    captionObserver.observe(text, { childList: true, characterData: true, subtree: true });
    return true;
  }

  if (!attachCaptionObservers()) {
    captionBodyObserver = new MutationObserver(() => {
      if (attachCaptionObservers()) { captionBodyObserver.disconnect(); captionBodyObserver = null; syncCaption(); }
    });
    captionBodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  function setCaptionMode(mode) {
    state.captionMode = mode === 'big' ? 'big' : 'off';
    refs.btnCaption?.classList.toggle('active', state.captionMode === 'big');
    markActivity();
    syncCaption();
    return state.captionMode;
  }

  refs.captionClose.addEventListener('click', () => setCaptionMode('off'));

  /* ── 面板 ───────────────────────────────────────────────── */
  function openPanel(tab) {
    markActivity();
    const wanted = PANEL_TABS.includes(tab) ? tab : undefined;
    panel.open(wanted);
    refs.body.classList.add('pb-hidden');
    if (wanted) refreshTab(wanted);
    syncDockActive();
  }

  function closePanel() {
    panel.close();
    refs.body.classList.remove('pb-hidden');
    syncDockActive();
    markActivity();
  }

  function togglePanel(tab) {
    if (panel.isOpen) closePanel(); else openPanel(tab || panel.currentTab || 'expression');
  }

  function syncDockActive() {
    refs.btnPanelTop?.classList.toggle('active', panel.isOpen);
    refs.btnPanelDock?.classList.toggle('active', panel.isOpen);
  }

  refs.btnPanelTop?.addEventListener('click', () => togglePanel());
  refs.btnPanelDock?.addEventListener('click', () => togglePanel());

  /* ── 聊天框开关 ─────────────────────────────────────────── */
  function setChatOpen(open) {
    const on = typeof open === 'boolean' ? open : !state.chatOpen;
    state.chatOpen = on;
    refs.btnChat?.classList.toggle('active', on);
    markActivity();
    safe(() => hooks.onChatToggle?.(on), null, 'chatToggle');
    return on;
  }

  refs.btnChat?.addEventListener('click', () => setChatOpen());

  /* ── 按住说话 ───────────────────────────────────────────── */
  function setPttActive(active) {
    state.pttActive = !!active;
    refs.btnPtt?.classList.toggle('recording', state.pttActive);
    markActivity();
  }

  refs.btnPtt?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (state.pttActive) return;
    setPttActive(true);
    safe(() => hooks.onPttStart?.(), null, 'pttStart');
  });
  const endPtt = () => {
    if (!state.pttActive) return;
    setPttActive(false);
    safe(() => hooks.onPttStop?.(), null, 'pttStop');
  };
  refs.btnPtt?.addEventListener('pointerup', endPtt);
  refs.btnPtt?.addEventListener('pointerleave', endPtt);
  refs.btnPtt?.addEventListener('pointercancel', endPtt);
  window.addEventListener('blur', endPtt);

  /* ── 随机动作 ───────────────────────────────────────────── */
  refs.btnMotion?.addEventListener('click', () => {
    markActivity();
    const items = motionItems();
    const pick = items.length ? items[Math.floor(Math.random() * items.length)] : null;
    if (pick) playMotion(pick);
    else toast('没有动作可播');
    safe(() => hooks.onRandomExpression?.(), null, 'randomExpression');
  });

  /* ── 穿透（含 4 秒防呆 + 右上角逃生口） ─────────────────── */
  function setPassthrough(on) {
    const next = !!on;
    state.clickThrough = next;
    refs.btnPassthrough?.classList.toggle('passthrough', next);
    refs.btnPassthrough?.classList.toggle('active', next);
    safe(() => hooks.onPassthrough?.(next), null, 'passthrough');
    clearTimeout(state.passthroughTimer);
    if (next) {
      toast('穿透已开启，4 秒后自动恢复（或把鼠标移到右上角）', 3200);
      // 防呆：即使没走逃生口，4 秒后也恢复可交互，避免用户永远关不回来。
      state.passthroughTimer = setTimeout(() => {
        if (state.clickThrough) setPassthrough(false);
      }, PASSTHROUGH_GUARD_MS);
    }
    markActivity();
    return next;
  }

  refs.btnPassthrough?.addEventListener('click', () => setPassthrough(!state.clickThrough));

  /* ── 顶栏 / 身体区拖动 + 点击 ───────────────────────────── */
  const DRAG_THRESHOLD = 4;
  let drag = null;

  function beginDrag(event, element) {
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, element };
    try { element.setPointerCapture?.(event.pointerId); } catch (error) { /* ignore */ }
    safe(() => hooks.onDragStart?.({ x: event.clientX, y: event.clientY }), null, 'dragStart');
  }

  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      state.dragging = true;
      refs.topbar.classList.add('dragging');
      refs.body.classList.add('dragging');
      // 拖动期间关掉毛玻璃（见 CSS 里 html.pb-dragging 的说明）
      try { document.documentElement.classList.add('pb-dragging'); } catch (e) { /* ignore */ }
    }
    safe(() => hooks.onDragMove?.({ dx, dy, x: event.clientX, y: event.clientY }), null, 'dragMove');
    markActivity();
  }

  function endDrag(event, cancelled) {
    if (!drag) return;
    const current = drag;
    drag = null;
    state.dragging = false;
    refs.topbar.classList.remove('dragging');
    refs.body.classList.remove('dragging');
    try { document.documentElement.classList.remove('pb-dragging'); } catch (e) { /* ignore */ }
    try { current.element.releasePointerCapture?.(current.id); } catch (error) { /* ignore */ }
    if (current.moved) {
      safe(() => hooks.onDragEnd?.(), null, 'dragEnd');
      return;
    }
    if (cancelled) return;
    // 小于阈值算点击：点头部摸头，点身体轻反应
    markActivity();
    const isHead = (event?.clientY ?? current.y) < Math.round(window.innerHeight * 0.55);
    safe(() => hooks.onTap?.({ x: event?.clientX ?? current.x, y: event?.clientY ?? current.y, head: isHead }), null, 'tap');
  }

  for (const element of [refs.topbar, refs.body]) {
    element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest('.pb-btn')) return;
      beginDrag(event, element);
    });
    element.addEventListener('pointermove', moveDrag);
    element.addEventListener('pointerup', (event) => endDrag(event, false));
    element.addEventListener('pointercancel', (event) => endDrag(event, true));
    element.addEventListener('lostpointercapture', () => { drag = null; state.dragging = false; try { document.documentElement.classList.remove('pb-dragging'); } catch (e) { /* ignore */ } });
  }

  /* ── 全局活动探针（恢复空闲淡出 / 穿透逃生口） ──────────── */
  document.addEventListener('mousemove', (event) => {
    markActivity();
    // 逃生口：穿透状态下把鼠标移到右上角 60×60 区域，立刻恢复可交互。
    if (state.clickThrough && event.clientX > window.innerWidth - 60 && event.clientY < 60) {
      setPassthrough(false);
      toast('已退出穿透模式');
    }
  }, true);

  setInterval(checkIdle, 500);

  window.addEventListener('keydown', (event) => {
    markActivity();
    if (event.key !== 'Escape') return;
    if (panel.isOpen) closePanel();
    else if (state.chatOpen) setChatOpen(false);
    else if (state.captionMode === 'big') setCaptionMode('off');
  });

  /* ── 对外 API ───────────────────────────────────────────── */
  function interactiveRects() {
    const rects = [];
    const add = (element) => {
      if (!element) return;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) rects.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    };
    for (const button of refs.buttons) add(button);
    if (panel.isOpen) add(refs.panel);
    return rects;
  }

  function debug() {
    const rectOf = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      mounted: true,
      ready: !!renderer()?.ready,
      panel: panel.isOpen ? panel.currentTab : null,
      captionMode: state.captionMode,
      captionFallback: refs.caption.classList.contains('show'),
      hostSubtitle: !!hostCaptionText(),
      hostSubtitleVisible: hostCaptionVisible(),
      chatOpen: state.chatOpen,
      clickThrough: state.clickThrough,
      idle: state.idle,
      pttActive: state.pttActive,
      activeExpression: state.activeExpression,
      activePreset: state.activePreset,
      counts: {
        expressions: expressionNames().length,
        motions: motionItems().length,
        assets: assetItems().length,
        presets: presetItems().length,
      },
      layout: {
        topbar: rectOf(refs.topbar),
        body: rectOf(refs.body),
        caption: rectOf(refs.caption),
        dock: rectOf(refs.dock),
        panel: panel.isOpen ? rectOf(refs.panel) : null,
        chat: rectOf(document.getElementById('text-chat-container')),
        subtitle: rectOf(document.getElementById('subtitle-container')),
      },
      errors: Array.isArray(body.errors) ? body.errors.slice(-3) : [],
    };
  }

  function dispose() {
    try { captionObserver?.disconnect(); } catch (error) { /* ignore */ }
    try { captionBodyObserver?.disconnect(); } catch (error) { /* ignore */ }
    clearTimeout(state.toastTimer);
    clearTimeout(state.passthroughTimer);
    clearTimeout(fallbackHideTimer);
    try { root.remove(); } catch (error) { /* ignore */ }
  }

  refreshAll();
  setCaptionMode('off');
  setCaptionVisible(false);
  syncDockActive();

  const api = {
    openPanel,
    closePanel,
    togglePanel,
    setChatOpen,
    setCaptionMode,
    setPassthrough,
    setPttActive,
    interactiveRects,
    debug,
    dispose,
    refresh: refreshAll,
    toast,
    isIdle: () => state.idle,
    markActivity,
  };
  hooks.onReady?.(api);
  return api;
}

export default { createPetBodyUi };