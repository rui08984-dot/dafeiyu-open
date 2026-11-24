// js/avatar/petbody/ui.js —— 皮套接进 my-neuro 的「薄适配层」。
//
// 设计原则（2026-10-31 用户定）：**宿主原生 UI 一律直接用，不再自己造**。
// 宿主的 js/ui/ui-controller.js（48KB）+ css/styles.css（32KB）已经提供：
//   无框描边字幕、6 种打字框样式、跟随模型的气泡、右键快捷菜单、控制按钮组、工具气泡。
//
// 这个文件只补宿主没有的 3 件事：
//   1) 拖动：宿主没有「拖整个窗口」的能力。
//   2) 穿透判定：宿主 setupMouseIgnore 依赖 global.currentModel，我们把皮套暴露成它认识的形状。
//   3) 字幕/聊天记录里说话人标签的渲染层替换（不动宿主数据）。
// 另外补 4 个「为大窗口写死」的像素值的响应式修正。
(function () {
  'use strict';
const __silentAudit = require('../../core/silent-audit.js');
  if (window.__petBodyUiHostLoaded) return;
  window.__petBodyUiHostLoaded = true;

  const ipc = (() => {
    try { return require('electron').ipcRenderer; } catch (error) { return null; }
  })();

  const state = { clickThrough: false, lastIgnore: null, dragBase: null };

  // D8（2026-11-22）：只读通知「开始/结束拖皮套」，供交互状态机 shadow 比对。
  // 不改变拖动逻辑；事件没有别的监听者时等于 no-op。
  const dragEventBus = (() => {
    try { return require('../../core/event-bus.js').eventBus; } catch (error) { return null; }
  })();
  const dragEvents = (() => {
    try { return require('../../core/events.js').Events; } catch (error) { return null; }
  })();
  function emitDrag(active) {
    try {
      if (!dragEventBus || !dragEvents) return;
      dragEventBus.emit(active ? dragEvents.AVATAR_DRAG_START : dragEvents.AVATAR_DRAG_END);
    } catch (error) { /* 只读通知失败不影响拖动 */ }
  }

  /* ── 1. 穿透 ─────────────────────────────────────────────── */
  function sendIgnore(ignore) {
    const value = !!ignore;
    if (state.lastIgnore === value) return;
    state.lastIgnore = value;
    try {
      if (!ipc) return;
      ipc.send('set-ignore-mouse-events', value ? { ignore: true, options: { forward: true } } : { ignore: false });
    } catch (error) { try { __silentAudit.audit('ui.js:31', error); } catch (e2) {} }
  }

  // 宿主的穿透是「悬停驱动」的：mousemove 算鼠标在不在模型身上，不在就切成穿透。
  // 它靠 model.containsPoint / isPointOverInteractive —— 我们的 Cubism5 渲染器都没有，
  // 于是永远判定「不在模型上」，窗口每次移动鼠标就变穿透，用户按下去点不到、拖不动。
  //
  // 光改 ui-controller 不够：canvas 的 mouseover/mouseout、model-interaction、vrm 交互
  // 也都在发 set-ignore-mouse-events。所以在这里加一道总闸：
  // 皮套模式下，只有显式开关（托盘/设置）才能让窗口穿透，其余一律拦掉。
  function guardIgnoreChannel() {
    if (!ipc || ipc.__pbGuarded) return;
    ipc.__pbGuarded = true;
    const rawSend = ipc.send.bind(ipc);
    ipc.send = function (channel, ...args) {
      if (channel === 'set-ignore-mouse-events') {
        const payload = args[0];
        const ignore = (payload && typeof payload === 'object') ? !!payload.ignore : !!payload;
        if (ignore && !state.clickThrough) {
          window.__pbIgnoreBlocked = (window.__pbIgnoreBlocked || 0) + 1;
          return rawSend(channel, { ignore: false });
        }
      }
      return rawSend(channel, ...args);
    };
  }

  function setPassthrough(on) {
    state.clickThrough = !!on;
    sendIgnore(state.clickThrough);
    return state.clickThrough;
  }

  /* ── 2. 拖动整个窗口 ─────────────────────────────────────── */
  function screenInfo() {
    try { return ipc ? ipc.sendSync('get-screen-info-sync') : null; } catch (error) { return null; }
  }

  function onDragStart() {
    const bounds = screenInfo()?.windowBounds || null;
    state.dragBase = bounds ? { x: bounds.x, y: bounds.y } : null;
    // 告诉眼神层：正在被拖动，别追鼠标（driver 的 pet:cursor 处理里会读这个标志让她回中）。
    // __pbDraggingAt 供 driver 做 3s 新鲜度检查——拖太快 pointerup 落在窗外时自动解冻。
    window.__pbDragging = true;
    window.__pbDraggingAt = Date.now();
    emitDrag(true);
    // 拖动期间关掉毛玻璃 + 冻结渲染（2026-11-21 拖动性能）：透明窗口上
    // backdrop-filter 每帧重采样桌面、渲染循环按 60fps 重绘整窗，两者叠加把合成器打满。
    try { document.documentElement.classList.add('pb-dragging'); } catch (e) { /* ignore */ }
  }

  function onDragMove(point) {
    if (!state.dragBase || !ipc) return;
    ipc.send('pet-drag-to', {
      x: state.dragBase.x + (point?.dx || 0),
      y: state.dragBase.y + (point?.dy || 0),
    });
  }

  function onDragEnd() {
    state.dragBase = null;
    window.__pbDragging = false;
    emitDrag(false);
    try { document.documentElement.classList.remove('pb-dragging'); } catch (e) { /* ignore */ }
    try { ipc?.send('pet-drag-end'); } catch (error) { try { __silentAudit.audit('ui.js:89', error); } catch (e2) {} }
  }

  /* ── 3. 为大窗口写死的像素值 → 响应式 ────────────────────── */
  // 宿主 css 里 #text-chat-container 是 right:390px + width:350px（为 1440~2560 宽桌面写的），
  // 在 420 宽窗口里会贴左并留出 390px 空白。只改位置，样式一行不动。
  // 宿主 ui-controller 会往 #text-chat-container 写内联 width:350px !important，
  // 内联 !important 只能用同一元素的内联 !important 盖掉（CSS 打不过它）。
  // 所以这里只覆盖【宽度这一个属性】把它撑满窗口，其余皮肤一律不碰。
  function fitChatBox() {
    if (window.innerWidth >= 700) return;
    const chat = document.getElementById('text-chat-container');
    if (!chat) return;
    const want = (window.innerWidth - 32) + 'px';
    if (chat.style.getPropertyValue('width') !== want) {
      chat.style.setProperty('width', want, 'important');
      chat.style.setProperty('max-width', want, 'important');
    }
    const inp = document.getElementById('chat-input');
    if (inp && getComputedStyle(inp).boxSizing !== 'border-box') {
      inp.style.setProperty('box-sizing', 'border-box', 'important');
    }
  }
  // 字幕宽度同理（宿主写的是按主屏宽算的像素值）。
  function fitSubtitle() {
    if (window.innerWidth >= 700) return;
    const el = document.getElementById('subtitle-container');
    if (!el) return;
    const want = Math.round(window.innerWidth * 0.92) + 'px';
    if (el.style.getPropertyValue('width') !== want) {
      el.style.setProperty('width', want, 'important');
      el.style.setProperty('max-width', want, 'important');
    }
  }

  // 宿主 updateBubblePosition 里写死 offsetX=400 / offsetY=50（为 1440~2560 宽窗口写的），
  // 420 宽下气泡会被推出窗口。这里包一层，窄窗时把气泡夹在可视区内。
  function fitBubbleOffset() {
    const ui = window.uiController;
    if (!ui || typeof ui.updateBubblePosition !== 'function' || ui.__pbOffsetPatched) return;
    ui.__pbOffsetPatched = true;
    const original = ui.updateBubblePosition.bind(ui);
    ui.updateBubblePosition = function patched() {
      try {
        if (window.innerWidth >= 700) return original();
        const container = document.getElementById('bubble-container');
        if (!container || !ui.bubbleVisible) return original();
        const box = container.getBoundingClientRect();
        const w = box.width || 200;
        const x = Math.max(8, Math.min(ui.bubbleCurrentX || 8, window.innerWidth - w - 8));
        const y = Math.max(8, Math.min(ui.bubbleCurrentY || 60, window.innerHeight - 120));
        container.style.left = x + 'px';
        container.style.top = y + 'px';
      } catch (e) { try { original(); } catch (e2) {} }
    };
  }

  function fitAll() { fitChatBox(); fitSubtitle(); fitBubbleOffset(); }

  /* ── 4. 说话人标签：只在渲染层换名字 ─────────────────────── */
  // 字幕里不该出现「名字: 」前缀 —— 原版字幕就是纯内容。
  const PREFIX_RE = /^\s*[\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z0-9_ \-]{0,15}\s*[:：]\s*/;
  const CONFIRM_RE = /^\s*确定\s*/;

  function stripSubtitlePrefix() {
    const text = document.getElementById('subtitle-text');
    if (!text) return;
    const value = String(text.textContent || '');
    const next = value.replace(PREFIX_RE, '').replace(CONFIRM_RE, '');
    if (next !== value) text.textContent = next;
  }

  function renameChatLabels() {
    const messages = document.getElementById('chat-messages');
    if (!messages) return;
    for (const strong of messages.querySelectorAll('div > strong')) {
      if (/fake\s*neuro|fake_neuro/i.test(strong.textContent || '')) strong.textContent = '大肥鱼:';
    }
  }

  function watchDom() {
    const text = document.getElementById('subtitle-text');
    const box = document.getElementById('subtitle-container');
    const messages = document.getElementById('chat-messages');
    if (!text && !box && !messages) return false;
    const observer = new MutationObserver(() => {
      stripSubtitlePrefix();
      renameChatLabels();
      fitChatBox();
      fitSubtitle();
    });
    if (text) observer.observe(text, { childList: true, characterData: true, subtree: true });
    if (box) observer.observe(box, { attributes: true, attributeFilter: ['style', 'class'] });
    if (messages) observer.observe(messages, { childList: true, subtree: true });
    return true;
  }

  /* ── 3.5 整窗拖动 ───────────────────────────────────────────
     用户要求「这个皮套一整个窗口应该可以拖动」。
     实现要点：
       · 在 document 上捕获（capture），先判断落点是不是可交互 UI；
         是 UI 就让给原生（按钮/输入框/右键菜单照常工作），只有点在皮套或空白处才拖。
       · 用 5px 阈值区分「点击」和「拖动」，点击仍然触发摸头/表情。
       · 拖动时锁一次窗口原始位置，之后只发增量，避免抖动累积。 */
  const DRAG_THRESHOLD = 5;
  const drag = { active: false, pointerId: null, startX: 0, startY: 0, moved: false, base: null, down: 0, moves: 0, sends: 0, lastDx: 0, lastDy: 0 };

  function isInteractiveAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return false;
    // 原生 UI（打字框 / 快捷菜单 / 字幕调整 / 发送按钮）一律不抢
    if (el.closest('#text-chat-container, #quick-settings, #model-controls, #subtitle-confirm-btn, #lyrics-bubble-container')) return true;
    // 任何按钮/输入类元素也不抢
    if (el.closest('button, input, textarea, [contenteditable="true"], a')) return true;
    return false;
  }

  function beginDrag(event) {
    // 只左键。注意：某些注入/合成事件里 button 可能是 -1，不能只认 0。
    if (event.button > 0) return;
    if (isInteractiveAt(event.clientX, event.clientY)) return;      // 让给原生 UI
    drag.active = true;
    drag.pointerId = event.pointerId === undefined ? 'mouse' : event.pointerId;
    // ⚠ 必须记**屏幕绝对坐标**（screenX/screenY），不能用 clientX/clientY。
    // 窗口跟着指针动，clientX 是「相对窗口」的坐标 —— 窗口一移动，它反而朝反方向变，
    // 于是每次 mousemove 算出来的位移 = 真实移动 - 上次位移，窗口在「原始位置」和
    // 「拖到的位置」之间高频来回闪。这就是抖动抽搐的根因。
    //
    // 2026-11-24 实测补充：Electron `webContents.sendInputEvent` 合成的鼠标事件
    // **screenX/screenY 恒为 0**（只有 clientX/clientY 有效）。旧代码因为
    // Number.isFinite(0)===true 而误采信 0 → dx 恒 0 → 永远过不了阈值 → 「拖不动」。
    // 这里显式识别「0,0 + clientX>0」为无屏幕坐标，改用 client 坐标，并记住来源
    // 供 moveDrag 保持一致（否则开始用 screen、移动用 client 也会错位）。
    const _hasScreen = Number.isFinite(event.screenX) && !(event.screenX === 0 && event.screenY === 0);
    drag.useScreen = _hasScreen;
    drag.startX = _hasScreen ? event.screenX : event.clientX;
    drag.startY = _hasScreen ? event.screenY : event.clientY;
    drag.moved = false;
    drag.base = null;
    drag.down += 1;
  }

  function moveDrag(event) {
    if (!drag.active) return;
    drag.moves += 1;
    // 坐标来源必须与 beginDrag 一致，否则阈值判定永远不成立（合成事件 screenX=0 的坑）。
    const useScreen = drag.useScreen !== false;
    const rawX = useScreen ? event.screenX : event.clientX;
    const rawY = useScreen ? event.screenY : event.clientY;
    const x = Number.isFinite(rawX) ? rawX : event.clientX;
    const y = Number.isFinite(rawY) ? rawY : event.clientY;
    const dx = x - drag.startX;
    const dy = y - drag.startY;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      onDragStart();                              // 锁住窗口原始位置
      try { document.body.style.cursor = 'grabbing'; } catch (e) { try { __silentAudit.audit('ui.js:234', e); } catch (e2) {} }
    }
    // 一帧只发一次：mousemove 频率高于渲染帧，逐条发会让主进程排队 setPosition，
    // 队列堵住时看起来就是「跟不上 + 抖」。
    drag.pendingX = dx;
    drag.pendingY = dy;
    if (!drag.rafPending) {
      drag.rafPending = true;
      requestAnimationFrame(() => {
        drag.rafPending = false;
        if (!drag.active || !drag.moved) return;
        window.__pbDraggingAt = Date.now();   // 活拖着就续新鲜度
        onDragMove({ dx: drag.pendingX, dy: drag.pendingY });
        drag.sends += 1; drag.lastDx = drag.pendingX; drag.lastDy = drag.pendingY;
      });
    }
    event.preventDefault();
  }

  function endDrag(event) {
    if (!drag.active) return;
    const moved = drag.moved;
    drag.active = false;
    drag.moved = false;
    try { document.body.style.cursor = ''; } catch (e) { try { __silentAudit.audit('ui.js:258', e); } catch (e2) {} }
    if (moved) {
      onDragEnd();
      // 拖动结束的这一下不要再当成点击（避免误触表情）
      drag.swallowClick = true;
      setTimeout(() => { drag.swallowClick = false; }, 80);
    }
  }

  function installWindowDrag() {
    window.__dragInstalled = true;
    // 同时监听 pointer 和 mouse：真实用户走 pointer 事件；
    // Electron 的 webContents.sendInputEvent（自检通道 /drag 用）只产生 mouse 事件。
    document.addEventListener('pointerdown', beginDrag, true);
    document.addEventListener('pointermove', moveDrag, true);
    document.addEventListener('pointerup', endDrag, true);
    document.addEventListener('pointercancel', endDrag, true);
    document.addEventListener('mousedown', beginDrag, true);
    document.addEventListener('mousemove', moveDrag, true);
    document.addEventListener('mouseup', endDrag, true);
    // 拖动后紧跟着的 click 要吞掉
    document.addEventListener('click', (e) => {
      if (!drag.swallowClick) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  /* ── 启动 ───────────────────────────────────────────────── */
  function boot() {
    window.__bootRan = true;
    window.__bootSteps = [];
    const step = (name, fn) => {
      window.__bootSteps.push(name);
      try { fn(); } catch (e) { (window.__bootErr = window.__bootErr || []).push(name + ': ' + (e && e.message || e)); }
    };
    step('guardIgnore', () => { guardIgnoreChannel(); window.__petBodyInteractive(); });
    step('noZoom', () => {
      // 「长按拖动她慢慢变大」的釜底抽薪：触屏捏合/触控板 pinch/Ctrl+滚轮都是 Chromium
      // 页面缩放（zoomFactor），整页放大=她变大。皮套窗永远 1:1，锁死缩放级别。
      // 2026-11-08：原来还调了 webFrame.setZoomLimit(1,1)——**该 API 不存在**，
      // 每次抛 TypeError 被空 catch 吞掉，等于锁缩放只成功了一半。
      // 正确 API 只有 setVisualZoomLevelLimits + setZoomFactor，逐个独立 try。
      try {
        const { webFrame } = require('electron');
        try { if (typeof webFrame.setVisualZoomLevelLimits === 'function') webFrame.setVisualZoomLevelLimits(1, 1); }
        catch (e) { try { __silentAudit.audit('ui.js:setVisualZoom', e); } catch (e2) {} }
        try { if (typeof webFrame.setZoomFactor === 'function') webFrame.setZoomFactor(1); }
        catch (e) { try { __silentAudit.audit('ui.js:setZoomFactor', e); } catch (e2) {} }
      } catch (e) { try { __silentAudit.audit('ui.js:webFrame', e); } catch (e2) {} }
      document.addEventListener('wheel', (e) => {
        // Ctrl+滚轮 = 页面缩放手势，皮套窗不需要
        if (e.ctrlKey) e.preventDefault();
      }, { passive: false, capture: true });
      document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
    });
    step('fitAll', fitAll);
    step('watchDom', watchDom);
    step('installWindowDrag', installWindowDrag);
    // 宿主 ui-controller 会周期性重写内联样式，这里低频重申尺寸（只调位置，不动样式）。
    setInterval(fitAll, 1500);
    window.addEventListener('resize', () => setTimeout(fitAll, 60));
  }

  // 暴露给外部（VTS/HTTP 控制口、调试）的最小句柄。
  window.__petBodyInteractive = () => { state.clickThrough = false; state.lastIgnore = null; sendIgnore(false); return true; };

  window.petBodyUi = {
    ready: true,
    makeInteractive: () => window.__petBodyInteractive(),
    setClickThrough: (on) => setPassthrough(!!on),
    debug: () => ({ host: true, clickThrough: state.clickThrough, lastIgnore: state.lastIgnore, patchedBubble: !!window.uiController?.__pbOffsetPatched, dragActive: drag.active, dragMoved: drag.moved, bootRan: !!window.__bootRan, bootPhase: window.__bootPhase, bootDeferred: !!window.__bootDeferred, bootSteps: window.__bootSteps, bootErr: window.__bootErr, dragInstalled: !!window.__dragInstalled, dragStat: { down: drag.down, moves: drag.moves, sends: drag.sends, dx: drag.lastDx, dy: drag.lastDy, base: drag.base }, ignoreBlocked: window.__pbIgnoreBlocked || 0, guarded: !!ipc?.__pbGuarded }),
  };

  window.__bootPhase = document.readyState;
  if (document.readyState === 'loading') {
    window.__bootDeferred = true;
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
