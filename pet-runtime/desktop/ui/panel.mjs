// ui/panel.mjs — 控制面板：表情 / 动作 / 换装三个分栏
// 只做"展示 + 回调"，渲染器交互由 stage.mjs 统一收口。

import { assetDisplay } from './assets.mjs';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const MOTION_LABELS = { Idle: '待机动作' };

export class Panel {
  constructor({ panel, tabs, views, closeButton, dockButtons, onClose, onTabChange }) {
    this.panel = panel;
    this.tabs = tabs;
    this.views = views;
    this.closeButton = closeButton;
    this.dockButtons = dockButtons;
    this.onClose = onClose || (() => {});
    this.onTabChange = onTabChange || (() => {});
    this.currentTab = 'expression';
    this.handlers = { onExpression: () => {}, onMotion: () => {}, onAsset: () => {}, onPreset: () => {}, onRetryAssets: () => {} };
    this.expressionGrid = document.getElementById('expression-grid');
    this.motionList = document.getElementById('motion-list');
    this.assetGroups = document.getElementById('asset-groups');
    this.statusEl = document.getElementById('panel-status');
    this.countEls = {
      expression: document.getElementById('count-expression'),
      motion: document.getElementById('count-motion'),
      asset: document.getElementById('count-asset'),
    };
    for (const tab of this.tabs) tab.addEventListener('click', () => this.selectTab(tab.dataset.tab));
    this.closeButton?.addEventListener('click', () => this.close());
  }

  setHandlers(handlers) { Object.assign(this.handlers, handlers || {}); }

  get isOpen() { return this.panel.classList.contains('show'); }

  open(tab) {
    if (tab) this.selectTab(tab);
    this.panel.classList.add('show');
    this.panel.setAttribute('aria-hidden', 'false');
    this.syncDock();
  }

  close() {
    this.panel.classList.remove('show');
    this.panel.setAttribute('aria-hidden', 'true');
    this.syncDock();
    this.onClose();
  }

  toggle(tab) { if (this.isOpen && (!tab || tab === this.currentTab)) this.close(); else this.open(tab); }

  selectTab(tab) {
    if (!tab || !this.views[tab]) return;
    this.currentTab = tab;
    for (const button of this.tabs) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    for (const [name, view] of Object.entries(this.views)) view.hidden = name !== tab;
    this.syncDock();
    this.onTabChange(tab);
  }

  syncDock() {
    for (const button of this.dockButtons) {
      const active = this.isOpen && button.dataset.panel === this.currentTab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  setStatus(text) { if (this.statusEl) this.statusEl.textContent = text; }

  setCounts({ expressions, motions, assets } = {}) {
    if (Number.isFinite(expressions)) this.countEls.expression.textContent = String(expressions);
    if (Number.isFinite(motions)) this.countEls.motion.textContent = String(motions);
    if (Number.isFinite(assets)) this.countEls.asset.textContent = String(assets);
  }

  /* ── 表情 ───────────────────────────────────────────────── */
  renderExpressions(names, activeName) {
    const grid = this.expressionGrid;
    grid.textContent = '';
    for (const name of names) {
      const chip = el('button', 'chip', name);
      chip.type = 'button';
      chip.dataset.expression = name;
      chip.title = activeName === name ? '再点一次取下这个表情' : '戴上「' + name + '」';
      chip.setAttribute('aria-pressed', String(activeName === name));
      if (activeName === name) chip.classList.add('active');
      chip.addEventListener('click', () => this.handlers.onExpression(name));
      grid.appendChild(chip);
    }
    if (activeName) {
      const reset = el('button', 'chip ghost', '取下');
      reset.type = 'button';
      reset.title = '取下当前表情';
      reset.addEventListener('click', () => this.handlers.onExpression(null));
      grid.appendChild(reset);
    }
  }

  /* ── 动作 ───────────────────────────────────────────────── */
  renderMotions(items) {
    const list = this.motionList;
    list.textContent = '';
    for (const item of items) {
      const row = el('button', 'row');
      row.type = 'button';
      row.dataset.group = item.group;
      row.dataset.index = String(item.index);
      row.title = '播放「' + (MOTION_LABELS[item.group] || item.label) + '」';
      const icon = el('span', 'row-icon');
      icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>';
      row.appendChild(icon);
      row.appendChild(el('span', 'row-label', MOTION_LABELS[item.group] || item.label));
      if (item.index > 0) row.appendChild(el('span', 'row-idx', '#' + (item.index + 1)));
      row.addEventListener('click', () => {
        this.handlers.onMotion(item);
        row.classList.add('playing');
        setTimeout(() => row.classList.remove('playing'), 320);
      });
      list.appendChild(row);
    }
    if (!items.length) list.appendChild(el('p', 'panel-tip', '动作还没加载出来。'));
  }

  /* ── 换装 ───────────────────────────────────────────────── */
  renderAssets({ items = [], state = {}, presets = [], activePreset = '', error = '', loading = false } = {}) {
    const root = this.assetGroups;
    root.textContent = '';
    if (loading) { root.appendChild(this._notice('正在读取资产目录…')); return; }
    if (error) { root.appendChild(this._notice(error, true)); return; }
    if (!items.length) { root.appendChild(this._notice('资产目录是空的（或还没加载）。', true)); return; }
    if (presets.length) {
      const row = el('div', 'preset-row');
      row.appendChild(el('div', 'asset-group-title', '一键预设'));
      const buttons = el('div', 'preset-buttons');
      for (const preset of presets) {
        const button = el('button', 'preset-btn', preset.label || preset.id);
        button.type = 'button';
        button.dataset.preset = preset.id;
        button.title = preset.description || ('套用「' + (preset.label || preset.id) + '」');
        if (preset.id === activePreset) button.classList.add('active');
        button.addEventListener('click', () => this.handlers.onPreset(preset.id));
        buttons.appendChild(button);
      }
      row.appendChild(buttons);
      root.appendChild(row);
    }
    const groups = new Map();
    for (const item of items) {
      const name = item.groupLabel || item.group || '其他';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(item);
    }
    for (const [groupName, groupItems] of groups) {
      const box = el('div', 'asset-group');
      box.appendChild(el('div', 'asset-group-title', groupName));
      for (const item of groupItems) {
        const row = el('div', 'asset-row');
        row.dataset.asset = item.id;
        row.appendChild(el('span', 'asset-label', item.label || item.id));
        const display = assetDisplay(item, state);
        if (item.kind === 'cycle') {
          row.appendChild(el('span', 'asset-value', display.optionLabel));
          const button = el('button', 'cycle-btn', '切换');
          button.type = 'button';
          button.title = '循环切换「' + (item.label || item.id) + '」';
          button.addEventListener('click', () => this.handlers.onAsset(item, null));
          row.appendChild(button);
        } else {
          row.appendChild(el('span', 'asset-value', display.optionLabel));
          const button = el('button', 'switch');
          button.type = 'button';
          button.setAttribute('role', 'switch');
          button.setAttribute('aria-checked', String(display.on));
          button.title = '切换「' + (item.label || item.id) + '」';
          // 点击直接翻转（C 的 applyAsset 省略 on 即取反），避免用可能过期的 UI 状态判断。
          button.addEventListener('click', () => this.handlers.onAsset(item, null));
          row.appendChild(button);
        }
        box.appendChild(row);
      }
      root.appendChild(box);
    }
  }


  _notice(text, withRetry = false) {
    const box = el('div', 'notice');
    box.appendChild(el('span', '', text));
    if (withRetry) {
      const button = el('button', '', '重新加载资产模块');
      button.type = 'button';
      button.addEventListener('click', () => this.handlers.onRetryAssets());
      box.appendChild(button);
    }
    return box;
  }
}

function isOn(item, state) {
  for (const key of [item.id, item.param]) {
    if (!key || !state || !Object.hasOwn(state, key)) continue;
    const value = state[key];
    return value === true || (typeof value === 'number' ? value > 0.5 : !!value);
  }
  return false;
}
