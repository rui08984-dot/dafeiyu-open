// ui/caption.mjs — 字幕 / 反应气泡 / 轻提示
// 字幕只负责"看得清、停得住、能关掉"，不碰渲染层。

const STAY_MIN = 2200;
const STAY_MAX = 11000;

export class Caption {
  constructor({ root, text, close, reaction, reactionText, toast }) {
    this.root = root;
    this.textEl = text;
    this.reactionEl = reaction;
    this.reactionTextEl = reactionText;
    this.toastEl = toast;
    this.enabled = true;
    this.mode = 'normal';
    this.lastText = '';
    this.timer = 0;
    this.reactionTimer = 0;
    this.toastTimer = 0;
    this.fadeTimer = 0;
    this.scrollTimer = 0;
    close?.addEventListener('click', (event) => { event.stopPropagation(); this.hide(); });
    // 鼠标停在字幕上时暂停自动淡出，方便看清长句；移开后补一次收尾倒计时。
    this.root.addEventListener('pointerenter', () => { clearTimeout(this.timer); });
    this.root.addEventListener('pointerleave', () => {
      if (!this.visible) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.hide(), 2200);
    });
  }

  /** 显示一条字幕；返回实际显示的毫秒数（0 = 没显示）。 */
  show(raw) {
    const text = String(raw ?? '').replace(/\s+$/u, '').trim();
    if (!text) return 0;
    if (!this.enabled) return 0;
    this.lastText = text;
    this.textEl.textContent = text;
    // 文本越长停留越久，但封顶，避免一条长回复把字幕钉死在屏幕上。
    const stay = Math.min(STAY_MAX, Math.max(STAY_MIN, 1400 + text.length * 120));
    clearTimeout(this.timer);
    clearTimeout(this.fadeTimer);
    clearInterval(this.scrollTimer);
    this.root.classList.add('show');
    this.root.setAttribute('aria-hidden', 'false');
    this.root.scrollTop = 0;
    this.timer = setTimeout(() => this.hide(), stay);
    // 超过 4 行的长字幕：字幕盒留在 68%~78% 高度区间内，自动分页滚动，读完再淡出。
    requestAnimationFrame(() => {
      if (!this.visible) return;
      const box = this.root;
      const clientHeight = box.clientHeight || 1;
      const pages = box.scrollHeight > clientHeight + 2 ? Math.ceil(box.scrollHeight / clientHeight) : 1;
      if (pages <= 1) return;
      let page = 0;
      clearInterval(this.scrollTimer);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.hide(), Math.min(16000, stay + (pages - 1) * 2400));
      this.scrollTimer = setInterval(() => {
        page += 1;
        if (page >= pages) { clearInterval(this.scrollTimer); this.scrollTimer = 0; return; }
        try { box.scrollTo({ top: page * clientHeight, behavior: 'smooth' }); } catch (error) { box.scrollTop = page * clientHeight; }
      }, 2400);
    });
    return stay;
  }

  hide() {
    clearTimeout(this.timer);
    clearInterval(this.scrollTimer);
    this.timer = 0;
    this.scrollTimer = 0;
    this.root.classList.remove('show');
    this.root.setAttribute('aria-hidden', 'true');
  }

  get visible() { return this.root.classList.contains('show'); }

  /** 大字幕 / 普通浮层切换；默认 normal，不持久化。 */
  setMode(mode) {
    const next = mode === 'big' ? 'big' : 'normal';
    this.mode = next;
    this.root.classList.toggle('big', next === 'big');
    // 可见时重新排版一次，让分页/自动滚动按新字号重新计算。
    if (this.visible && this.lastText) this.show(this.lastText);
    return this.mode;
  }

  /** 右键菜单"显示/隐藏字幕"。关掉时正在显示的字幕立刻收起。 */
  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.hide();
    return this.enabled;
  }

  toggleEnabled() { return this.setEnabled(!this.enabled); }

  /** 点头/点身子的小反应气泡，独立于字幕，不会覆盖正在说的话。 */
  reaction(raw, ms = 1600) {
    const text = String(raw ?? '').trim();
    if (!text) return;
    this.reactionTextEl.textContent = text;
    this.reactionEl.classList.add('show');
    clearTimeout(this.reactionTimer);
    this.reactionTimer = setTimeout(() => this.reactionEl.classList.remove('show'), ms);
  }

  /** 操作反馈（换装、动作、热键），比字幕轻。 */
  toast(raw, ms = 1900) {
    const text = String(raw ?? '').trim();
    if (!text) return;
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  destroy() {
    clearTimeout(this.timer); clearTimeout(this.reactionTimer); clearTimeout(this.toastTimer);
  }
}
