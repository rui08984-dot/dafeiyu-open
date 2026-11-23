// ui/stage.mjs — 舞台层总装
// 把字幕、悬停圆钮、控制面板、点击反应和主进程 ws 消息接在一起。
// 对外只暴露 stage 对象，渲染细节仍归 cubism-renderer.mjs。

import { Caption } from './caption.mjs';
import { Panel } from './panel.mjs';
import { installPointer } from './pointer.mjs';
import { loadAssetModule, readAssetItems, readAssetState, assetDisplay, applyAssetTo, readAssetPresets, applyAssetPreset, currentAssetPreset } from './assets.mjs';
import { playAction } from './actions.mjs';

const HEAD_RATIO = 0.34;      // 窗口高度 34% 以上算"头部"（半身取景）
const DOCK_IDLE_MS = 2600;    // 鼠标停住多久后收起圆钮

const HEAD_REACTIONS = ['唔…好痒', '嘿嘿，再摸一下', '头…头发要乱啦'];
const BODY_REACTIONS = ['呀！', '嗯？戳我干嘛', '痒…别闹'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function createStage({ renderer, sampleAlpha, bridge, onAssetApplied, gaze, runtimeInfo } = {}) {
  const $ = (id) => document.getElementById(id);
  const dockEl = $('dock');
  const panelEl = $('panel');
  const tabs = [...panelEl.querySelectorAll('.panel-tab')];
  const views = Object.fromEntries([...panelEl.querySelectorAll('.panel-view')].map((view) => [view.dataset.view, view]));
  const dockButtons = [...dockEl.querySelectorAll('.dock-btn')];

  const caption = new Caption({
    root: $('caption'),
    text: $('caption-text'),
    close: $('caption-close'),
    reaction: $('reaction'),
    reactionText: $('reaction-text'),
    toast: $('toast'),
  });

  const panel = new Panel({
    panel: panelEl, tabs, views,
    closeButton: $('panel-close'),
    dockButtons,
    onClose: () => scheduleDockHide(900),
    // 每次切到换装页都用 C 的 getState 重读，面板高亮永远是模型真实状态。
    onTabChange: (tab) => { markActivity(); if (tab === 'asset') refreshAssetState(); },
  });

  const state = {
    ready: false,
    activeExpression: '',
    expressions: [],
    motions: [],
    assets: { module: null, items: [], presets: [], activePreset: '', state: {}, error: '', loading: false },
    lastTap: null,
    dockTimer: 0,
    flashTimer: 0,
    captionMode: 'normal',
    fullscreen: false,
    lastActivityAt: performance.now(),
  };
  const localAssetState = {};

  /* ── 目录：表情 / 动作直接读渲染器已加载的骨架 ───────────── */
  function refreshCatalog() {
    state.expressions = [...(renderer?.expressions?.keys?.() ?? [])];
    state.motions = [];
    for (const key of renderer?.motions?.keys?.() ?? []) {
      const [group, index] = String(key).split(':');
      const motionIndex = Number(index) || 0;
      let label = group;
      try {
        // model3 里同一动作组可能有两个动作，用文件名区分（如「狗尾草切换出来」「狗尾草切回默认手」）。
        const file = renderer?.settings?.getMotionFileName?.(group, motionIndex);
        if (file) label = String(file).replace(/^.*\//, '').replace(/\.motion3\.json$/i, '') || group;
      } catch (error) { /* 没有 settings 时退回组名 */ }
      state.motions.push({ group, index: motionIndex, label });
    }
    panel.setCounts({ expressions: state.expressions.length, motions: state.motions.length, assets: state.assets.items.length });
    panel.renderExpressions(state.expressions, state.activeExpression);
    panel.renderMotions(state.motions);
  }

  function refreshExpressionUI() {
    panel.renderExpressions(state.expressions, state.activeExpression);
  }

  /* ── 活动 / 空闲（给 app 的降帧用） ─────────────────────── */
  function markActivity() { state.lastActivityAt = performance.now(); }

  function isIdle(now = performance.now()) {
    if (!state.ready) return false;
    if (caption.visible) return false;            // 有字幕不降帧
    if (gaze?.active) return false;               // 鼠标在窗口上时保持顺滑
    if (renderer?.motionDirector?.playing) return false; // 正在播动作
    return now - state.lastActivityAt >= 3000;    // 静止 3s
  }

  /* ── 大字幕 / 全屏淡出 ─────────────────────────────────── */
  function setCaptionMode(mode) {
    state.captionMode = caption.setMode(mode);
    markActivity();
    return state.captionMode;
  }

  function setFullscreenDim(on) {
    state.fullscreen = !!on;
    document.body.classList.toggle('is-dimmed', state.fullscreen);
    markActivity();
    return state.fullscreen;
  }

  /* ── 悬停圆钮 ───────────────────────────────────────────── */
  function revealDock() {
    clearTimeout(state.dockTimer);
    dockEl.classList.add('show');
  }

  function scheduleDockHide(delay = DOCK_IDLE_MS) {
    clearTimeout(state.dockTimer);
    state.dockTimer = setTimeout(() => {
      if (!panel.isOpen) dockEl.classList.remove('show');
    }, delay);
  }

  /* ── 控制面板 ───────────────────────────────────────────── */
  function openPanel(tab) {
    markActivity();
    panel.open(tab);
    revealDock();
    clearTimeout(state.dockTimer);
    if (panel.currentTab === 'asset') {
      if (!state.assets.module && !state.assets.loading) ensureAssets();
      else refreshAssetState();
    }
  }

  function closePanel() {
    panel.close();
    scheduleDockHide(700);
  }

  /* ── 表情 ───────────────────────────────────────────────── */
  function setExpression(name, { silent = false } = {}) {
    markActivity();
    if (!renderer?.ready) return false;
    const next = name ? String(name) : '';
    if (!next) {
      if (state.activeExpression) { try { renderer.setNamedExpression?.(state.activeExpression, false); } catch (e) { /* ignore */ } }
      state.activeExpression = '';
      refreshExpressionUI();
      if (!silent) caption.toast('表情已取下');
      return true;
    }
    if (next === state.activeExpression) {
      try { renderer.setNamedExpression?.(next, false); } catch (e) { /* ignore */ }
      state.activeExpression = '';
      refreshExpressionUI();
      if (!silent) caption.toast('表情已取下');
      return true;
    }
    let pinned = false;
    try { pinned = renderer.setNamedExpression?.(next, true) === true; } catch (e) { pinned = false; }
    state.activeExpression = pinned ? next : '';
    refreshExpressionUI();
    if (!silent) caption.toast(pinned ? '表情 · ' + next : '没有找到表情「' + next + '」');
    return pinned;
  }

  /** 外部（VTS / 热键）切换表情后同步面板高亮，不重复调用渲染器。 */
  function syncExpression(name, active) {
    if (active) state.activeExpression = String(name || '');
    else if (state.activeExpression === name) state.activeExpression = '';
    refreshExpressionUI();
  }

  function flashExpression(name, ms) {
    if (state.activeExpression || !renderer?.expressions?.has?.(name)) return;
    let ok = false;
    try { ok = renderer.setNamedExpression?.(name, true) === true; } catch (e) { ok = false; }
    if (!ok) return;
    clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(() => {
      if (state.activeExpression) return;
      try { renderer.setNamedExpression?.(name, false); } catch (e) { /* ignore */ }
    }, ms);
  }

  /* ── 动作 ───────────────────────────────────────────────── */
  function playMotionItem(item) {
    markActivity();
    if (!renderer?.ready || !item) return false;
    let ok = false;
    try { ok = renderer.playMotion?.(item.group, item.index, 2) === true; } catch (e) { ok = false; }
    if (ok) caption.toast('动作 · ' + (item.group === 'Idle' ? '待机' : item.group));
    else caption.toast('这个动作暂时播不了');
    revealDock();
    return ok;
  }

  function handleAction(name) {
    markActivity();
    const action = String(name || '').trim();
    if (!action) return;
    playAction(renderer, action);
    caption.toast('动作 · ' + action);
    revealDock();
  }

  function triggerAction(name) {
    const action = String(name || '').trim();
    if (!action) return false;
    return playAction(renderer, action);
  }

  /* ── 换装资产 ───────────────────────────────────────────── */
  function currentAssetState() {
    if (state.assets.module) {
      const fresh = readAssetState(state.assets.module, renderer);
      state.assets.state = fresh;
      return fresh;
    }
    return state.assets.state;
  }

  function refreshAssetState() {
    if (!state.assets.module) return;
    const fresh = currentAssetState();
    state.assets.activePreset = currentAssetPreset(state.assets.module, renderer)?.id || '';
    panel.renderAssets({ items: state.assets.items, state: fresh, presets: state.assets.presets, activePreset: state.assets.activePreset });
  }

  function notifyAssetApplied(id) {
    let states = state.assets.state;
    try { states = state.assets.module?.getState?.(renderer) || states; } catch (error) { /* 用缓存兜底 */ }
    try { onAssetApplied?.({ id, states }); } catch (error) { console.warn('[stage] asset-applied 上报失败', error); }
  }

  async function ensureAssets({ retry = false } = {}) {
    if (state.assets.loading) return false;
    state.assets.loading = true;
    state.assets.error = '';
    panel.renderAssets({ loading: true });
    panel.setStatus('正在读取资产目录…');
    let module = null;
    try { module = await loadAssetModule({ retry }); } catch (e) { module = null; }
    state.assets.loading = false;
    if (!module) {
      state.assets.module = null;
      state.assets.items = [];
      state.assets.error = '资产模块（asset-toggles.mjs）还没就绪。等 C 提交后点下面的按钮重新加载，表情和动作不受影响。';
      panel.renderAssets({ error: state.assets.error });
      panel.setCounts({ assets: 0 });
      panel.setStatus('资产模块未就绪');
      return false;
    }
    state.assets.module = module;
    state.assets.items = readAssetItems(module);
    state.assets.presets = readAssetPresets(module);
    state.assets.state = readAssetState(module, renderer);
    state.assets.activePreset = currentAssetPreset(module, renderer)?.id || '';
    panel.setCounts({ assets: state.assets.items.length });
    panel.setStatus(state.assets.items.length ? '换装开关已就绪' : '资产目录为空');
    panel.renderAssets({ items: state.assets.items, state: state.assets.state, presets: state.assets.presets, activePreset: state.assets.activePreset });
    while (pendingAssets.length) {
      const queued = pendingAssets.shift();
      applyAsset(queued.id, queued.on, { silent: true });
    }
    return true;
  }

  function findAssetItem(key) {
    const wanted = String(key ?? '');
    const item = state.assets.items.find((entry) => entry.id === wanted || entry.param === wanted || entry.label === wanted);
    if (item) return item;
    // 外部消息可能用参数名（key11）或别名，交给 C 的 findAsset 兜一层。
    try {
      const found = state.assets.module?.findAsset?.(wanted);
      if (found) return found;
    } catch (error) { /* ignore */ }
    return null;
  }

  /**
   * 应用/翻转一个资产。
   * on = true/false 显式设定；on = null/undefined 翻转（C 的约定：省略 on 即取反）。
   */
  function applyAsset(id, on, { silent = false } = {}) {
    markActivity();
    const key = String(id ?? '');
    const item = findAssetItem(key);
    if (!item) {
      if (!silent) caption.toast('没有这个资产：' + key);
      return false;
    }
    const flip = on === null || on === undefined;
    const ok = applyAssetTo(state.assets.module, renderer, item, flip ? undefined : !!on);
    // 有 C 模块时完全以 getState(renderer) 为准；本地缓存只在模块缺席时兜底。
    if (state.assets.module) {
      state.assets.state = readAssetState(state.assets.module, renderer);
    } else {
      if (!flip) {
        localAssetState[item.id] = !!on;
        if (item.param) localAssetState[item.param] = on ? 1 : 0;
      } else {
        delete localAssetState[item.id];
        if (item.param) delete localAssetState[item.param];
      }
      state.assets.state = { ...localAssetState };
    }
    state.assets.activePreset = state.assets.module ? (currentAssetPreset(state.assets.module, renderer)?.id || '') : '';
    panel.renderAssets({ items: state.assets.items, state: state.assets.state, presets: state.assets.presets, activePreset: state.assets.activePreset });
    if (!silent) {
      const label = item.label || item.id;
      const display = assetDisplay(item, state.assets.state);
      if (!ok) caption.toast('资产模块没接住「' + label + '」');
      else caption.toast(label + ' · ' + display.optionLabel);
    }
    notifyAssetApplied(item.id);
    revealDock();
    return ok;
  }

  /** 一键预设（C2）：套用后按 getState 重读并刷新高亮。 */
  function applyPreset(presetId) {
    markActivity();
    if (!state.assets.module) return false;
    const result = applyAssetPreset(state.assets.module, renderer, presetId);
    if (!result || result.ok === false) { caption.toast('预设没套上：' + String(presetId)); return false; }
    state.assets.state = readAssetState(state.assets.module, renderer);
    state.assets.activePreset = currentAssetPreset(state.assets.module, renderer)?.id || (result.preset?.id || '');
    panel.renderAssets({ items: state.assets.items, state: state.assets.state, presets: state.assets.presets, activePreset: state.assets.activePreset });
    caption.toast(result.message || ('预设 · ' + (result.preset?.label || presetId)));
    notifyAssetApplied(result.preset?.id || String(presetId));
    revealDock();
    return true;
  }

  const pendingAssets = [];
  function handleAssetMessage(msg) {
    const id = String(msg?.id ?? '');
    if (!id) return;
    const flip = msg?.toggle === true || msg?.on === undefined || msg?.on === null;
    // 资产模块还在加载时先排队，加载完补放，避免丢掉早到的热键。
    if (!state.assets.module) {
      pendingAssets.push({ id, on: flip ? null : msg?.on === true });
      ensureAssets();
      return;
    }
    applyAsset(id, flip ? null : msg?.on === true, { silent: false });
  }

  /* ── 热键：资产 / 表情 / 动作三路兜底 ─────────────────────── */
  function handleHotkey(rawName) {
    markActivity();
    const name = String(rawName ?? '').trim();
    if (!name) return;
    // 顺序与 model-info 的热键表一致：表情 → 动作 → 资产，最后才当动作词典的英文标签。
    if (state.expressions.includes(name)) { setExpression(name); revealDock(); return; }
    const motion = state.motions.find((entry) => entry.group === name || entry.label === name || name === entry.group + ' ' + (entry.index + 1));
    if (motion) { playMotionItem(motion); return; }
    const asset = findAssetItem(name);
    if (asset) { applyAsset(asset.id, null); return; }
    playAction(renderer, name);
    caption.toast('热键 · ' + name);
    revealDock();
  }

  /* ── 点击反应：34% 以上摸头，以下轻戳 ─────────────────────── */
  function onTap({ x = 0, y = 0 } = {}) {
    markActivity();
    if (!renderer?.ready) return;
    const head = y < (window.innerHeight || 760) * HEAD_RATIO;
    state.lastTap = { x: Math.round(x), y: Math.round(y), head, at: Date.now() };
    try { renderer.beginAttention?.(); } catch (e) { /* ignore */ }
    if (head) {
      caption.reaction(pick(HEAD_REACTIONS));
      playAction(renderer, 'tilt head left');
      flashExpression('脸红', 1800);
    } else {
      caption.reaction(pick(BODY_REACTIONS));
      playAction(renderer, 'shrug');
    }
    revealDock();
  }

  /* ── 事件接线 ───────────────────────────────────────────── */
  panel.setHandlers({
    onExpression: (name) => setExpression(name),
    onMotion: (item) => playMotionItem(item),
    onAsset: (item, on) => applyAsset(item.id, on),
    onPreset: (presetId) => applyPreset(presetId),
    onRetryAssets: () => ensureAssets({ retry: true }),
  });

  for (const button of dockButtons) {
    button.addEventListener('click', () => {
      const tab = button.dataset.panel;
      if (panel.isOpen && panel.currentTab === tab) closePanel();
      else openPanel(tab);
    });
  }

  dockEl.addEventListener('pointerenter', () => { clearTimeout(state.dockTimer); });
  dockEl.addEventListener('pointerleave', () => scheduleDockHide(1200));

  let lastHoverAt = 0;
  installPointer({
    sampleAlpha,
    bridge,
    onTap,
    onHover: () => {
      markActivity();
      const now = performance.now();
      if (!dockEl.classList.contains('show')) revealDock();
      if (now - lastHoverAt > 260) { lastHoverAt = now; scheduleDockHide(); }
    },
    onLeave: () => scheduleDockHide(650),
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (panel.isOpen) closePanel();
    else caption.hide();
  });

  try {
    bridge?.onMenu?.((payload) => {
      const type = payload?.type;
      if (type === 'toggle-caption') {
        const on = caption.toggleEnabled();
        caption.toast(on ? '字幕已打开' : '字幕已关闭');
      } else if (type === 'open-panel') {
        openPanel(panel.currentTab || 'expression');
      } else if (type === 'caption-mode') {
        setCaptionMode(payload.mode);
      } else if (type === 'toggle-caption-mode') {
        setCaptionMode(state.captionMode === 'big' ? 'normal' : 'big');
      }
    });
  } catch (error) {
    console.warn('[stage] 菜单桥接不可用', error);
  }

  function setReady() {
    if (state.ready) return;
    state.ready = true;
    panel.setStatus('按住角色可拖动窗口');
    refreshCatalog();
    ensureAssets();
    revealDock();
    scheduleDockHide(2800);
    caption.toast('按住拖动 · 点我摸摸头', 3000);
  }

  const stage = {
    get ready() { return state.ready; },
    caption,
    panel,
    setReady,
    revealDock,
    openPanel,
    closePanel,
    showCaption: (text) => caption.show(text),
    hideCaption: () => caption.hide(),
    setCaptionMode,
    getCaptionMode: () => state.captionMode,
    setFullscreenDim,
    markActivity,
    isIdle,
    toast: (text, ms) => caption.toast(text, ms),
    reaction: (text, ms) => caption.reaction(text, ms),
    setExpression,
    syncExpression,
    playAction: (name) => triggerAction(name),
    playMotion: (item) => playMotionItem(item),
    handleAction,
    handleHotkey,
    handleAssetMessage,
    applyAsset,
    applyPreset,
    ensureAssets,
    onTap,
    sampleAlpha: (x, y) => (typeof sampleAlpha === 'function' ? sampleAlpha(x, y) : 255),
    debugState() {
      return {
        ready: state.ready,
        caption: caption.visible,
        captionText: caption.visible ? caption.lastText.slice(0, 48) : '',
        panel: panel.isOpen ? panel.currentTab : null,
        dock: dockEl.classList.contains('show'),
        expression: state.activeExpression,
        expressions: state.expressions.length,
        motions: state.motions.length,
        assets: { module: !!state.assets.module, count: state.assets.items.length, error: !!state.assets.error },
        lastTap: state.lastTap,
        captionMode: state.captionMode,
        fullscreen: state.fullscreen,
        idle: !!runtimeInfo?.()?.idle,
        fps: runtimeInfo?.()?.fps ?? 0,
        gaze: gaze ? gaze.debugState() : null,
      };
    },
  };
  return stage;
}
