// ui/pointer.mjs — 手动拖动 + 点击判定 + 悬停唤出
// 关键点：
//   1) 只有按在「模型可见像素」上才开始拖动/点击（透明背景不响应，等于把 drag 区域收窄到角色本体）；
//   2) 位移超过 3px 才升级成拖动，<3px 松手算点击（摸头 / 轻反应）；
//   3) 用 pointer capture 保证拖出窗口也不丢事件。

const DRAG_THRESHOLD = 3;   // px：小于它算点击
const ALPHA_MIN = 6;        // 0..255：低于它的像素视为透明背景

const UI_SELECTOR = 'button, a, input, select, textarea, label, .panel, .caption, .dock';

export function installPointer({ sampleAlpha, bridge, onTap, onHover, onLeave, onBackground } = {}) {
  const canvas = document.getElementById('model');
  let pending = null;

  const isUiTarget = (target) => !!(target instanceof Element && target.closest(UI_SELECTOR));
  const alphaAt = (x, y) => {
    if (typeof sampleAlpha !== 'function') return 255;
    try { const a = sampleAlpha(x, y); return Number.isFinite(a) ? a : 255; } catch (e) { return 255; }
  };

  const onPointerDown = (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    if (isUiTarget(event.target)) return;
    if (alphaAt(event.clientX, event.clientY) < ALPHA_MIN) { onBackground?.(); return; }
    pending = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    document.body.classList.add('is-pressing');
    try { canvas?.setPointerCapture?.(event.pointerId); } catch (e) { /* 某些环境不支持捕获 */ }
  };

  const onPointerMove = (event) => {
    if (!pending) { onHover?.(); return; }
    if (event.pointerId !== pending.id) return;
    if (!pending.moved) {
      const dx = event.clientX - pending.x;
      const dy = event.clientY - pending.y;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      pending.moved = true;
      document.body.classList.remove('is-pressing');
      document.body.classList.add('is-dragging');
      try { bridge?.startDrag?.(); } catch (e) { /* 桥不可用时仍然可以点 */ }
    }
    try { bridge?.dragMove?.(); } catch (e) { /* 同上 */ }
  };

  const finish = (event, cancelled) => {
    if (!pending) return;
    if (event && event.pointerId !== pending.id) return;
    const gesture = pending;
    pending = null;
    try { canvas?.releasePointerCapture?.(gesture.id); } catch (e) { /* ignore */ }
    document.body.classList.remove('is-pressing');
    document.body.classList.remove('is-dragging');
    if (gesture.moved) {
      try { bridge?.endDrag?.(); } catch (e) { /* ignore */ }
      try { bridge?.savePosition?.(); } catch (e) { /* ignore */ }
      onLeave?.();
      return;
    }
    if (!cancelled) {
      const x = event?.clientX ?? gesture.x;
      const y = event?.clientY ?? gesture.y;
      try { onTap?.({ x, y }); } catch (e) { console.warn('[stage] tap handler failed', e); }
    }
  };

  const onPointerUp = (event) => finish(event, false);
  const onPointerCancel = (event) => finish(event, true);

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  document.addEventListener('pointerenter', () => onHover?.(), true);
  window.addEventListener('mouseout', (event) => { if (!event.relatedTarget) onLeave?.(); });
  window.addEventListener('blur', () => onLeave?.());
  // 浏览器默认的文本选择/拖拽会打断手动拖动。
  document.addEventListener('dragstart', (event) => event.preventDefault());

  return {
    cancel() { finish(null, true); },
    get dragging() { return !!pending && pending.moved; },
  };
}
