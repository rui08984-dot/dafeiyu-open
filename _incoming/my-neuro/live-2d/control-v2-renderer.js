// ⚠ 2026-11-10 归属说明：新版面板 v2 的渲染层（对应 control-v2.html，默认加载）。
//   数据走 control-main.js 的 IPC（pet-state / pet-feed / kb-search / organ-timeline / skills-*）。
/* control-v2-renderer.js — 大肥鱼控制中心 v2（「水槽边的仪表板」）
   契约与 v1 一致：window.controlApi 不变；导航 data-page / 页面 id；
   provider 通讯录、保存链路、脏标记、关窗确认全部沿用 v1 语义。
   新增依赖：control:overview / control:memory / control:toggle-quiet（control-main.js 已实现）。 */
'use strict';

// ── 设置字段「缺键默认」与「只回写改过的字段」纯函数（2026-11-21）───────────
// 为什么放顶层：这两个决定不能靠肉眼保证，必须有可单测的纯函数
// （_probe/test-config-effective.cjs 直接 require 本文件；浏览器里 module 不存在，导出被跳过）。
//
// 病根：运行时对 llm.temperature_enabled 缺键按 true（js/ai/llm-handler.js applySampling），
// 设置页以前缺键按 false 渲染；saveConfig 又无条件回写所有字段 →
// 「打开设置点保存」就把采样温度静默写成 false。第一性原理：
//   ① UI 的缺省必须等于运行时缺省；
//   ② 保存只写用户真的动过的字段，缺键（未配置）不能被「渲染出来的默认值」实体化。
// 2026-11-21 统一管辖后，这两个 id 的开关已从面板移除（能力页 llm.temperature / svc.auto_close
// 是唯一入口）；纯函数契约保留不动 —— _probe/test-config-effective.cjs 用它锁「UI 缺省 = 运行时缺省」
// 这条规则本身，规则仍然有效（能力页不走这里，但谁再把 checked 字段加回来就得守它）。
const CHECKED_DEFAULT_TRUE = new Set(['temperature-enabled', 'auto-close-services']);

/** 字段初始渲染值：缺键时与运行时默认对齐（temperature-enabled/auto-close-services = true） */
function fieldInitialValue(fieldId, type, loadedValue) {
  if (type === 'checked') {
    const missing = loadedValue === undefined || loadedValue === null || loadedValue === '';
    if (missing) return CHECKED_DEFAULT_TRUE.has(fieldId);
    return Boolean(loadedValue);
  }
  return (loadedValue === undefined || loadedValue === null) ? '' : loadedValue;
}

/**
 * 生成「本次真正要写回」的字段清单。
 * @param {Record<string,{path:string,type:'checked'|'number'|'value'}>} specs
 * @param {Record<string,any>} current  当前 DOM 归一值（checked=boolean，其它=string）
 * @param {Record<string,any>} baseline 渲染时的值（同上）
 * @returns {{writes:Array<{id:string,path:string,value:any}>, unchanged:number, invalid:number}}
 */
function planFieldWrites(specs, current, baseline) {
  const writes = [];
  let unchanged = 0;
  let invalid = 0;
  for (const [id, spec] of Object.entries(specs || {})) {
    if (!Object.prototype.hasOwnProperty.call(current || {}, id)) continue;
    const cur = current[id];
    const normalize = (v) => (spec.type === 'checked' ? !!v : String(v ?? ''));
    if (Object.prototype.hasOwnProperty.call(baseline || {}, id) && normalize(baseline[id]) === normalize(cur)) {
      unchanged += 1;
      continue;
    }
    if (spec.type === 'number') {
      // 空输入框不写 0/NaN，否则会把「用默认值」变成「明确设成 0」
      const raw = String(cur ?? '').trim();
      if (raw === '' || !Number.isFinite(Number(raw))) { invalid += 1; continue; }
      writes.push({ id, path: spec.path, value: Number(raw) });
    } else if (spec.type === 'checked') {
      writes.push({ id, path: spec.path, value: Boolean(cur) });
    } else {
      writes.push({ id, path: spec.path, value: cur });
    }
  }
  return { writes, unchanged, invalid };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fieldInitialValue, planFieldWrites, CHECKED_DEFAULT_TRUE };
}

(() => {
  const api = (typeof window !== 'undefined' && window.controlApi) || null;
  if (!api) {
    if (typeof document !== 'undefined') {
      document.body.innerHTML = '<p style="padding:24px;font:14px sans-serif">controlApi 不可用：请通过 control-main.js 打开本页。</p>';
    }
    return;
  }

  const $ = id => document.getElementById(id);
  const get = (obj, path, fallback = '') => path.split('.').reduce((value, key) => value?.[key], obj) ?? fallback;
  const set = (obj, path, value) => {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((value, key) => value[key] ??= {}, obj);
    target[last] = value;
  };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const isBlank = value => value === undefined || value === null || value === '' || (typeof value === 'number' && Number.isNaN(value));

  // ── 自建 prompt / confirm（2026-11-16）────────────────────────────────
  // Electron 28 没有实现 window.prompt（调用直接抛 “prompt() is and will not be supported”），
  // confirm 在部分平台也被禁用。知识库那三个按钮因此点了完全没反应。
  // 这里用 DOM 弹层实现同语义的异步版本，视觉走画框语言。
  function uiPrompt(title, defaultValue = '') {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.58)';
      wrap.innerHTML =
        '<div style="min-width:340px;max-width:520px;padding:18px 20px;background:linear-gradient(180deg,#1b130c,#120c07);border:1px solid #5c4613;border-radius:2px;box-shadow:0 20px 60px rgba(0,0,0,.75),inset 0 0 0 1px rgba(247,236,200,.18)">'
        + '<div style="font:500 13.5px/1.4 Georgia,serif;letter-spacing:.1em;color:#ecda9f;margin-bottom:12px">' + String(title || '') + '</div>'
        + '<input id="__ui_prompt_input" style="width:100%;padding:8px 10px;background:#2a1f14;border:1px solid #5c4613;color:#f2e6c8;border-radius:2px;font-size:13px;box-shadow:inset 0 2px 6px rgba(0,0,0,.8)" />'
        + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">'
        + '<button type="button" data-no style="padding:7px 15px;border-radius:2px;border:1px solid #5c4613;background:linear-gradient(180deg,#2c2014,#170f09);color:#ecda9f;font-size:12px;letter-spacing:.1em;cursor:pointer">取消</button>'
        + '<button type="button" data-yes style="padding:7px 15px;border-radius:2px;border:1px solid #5c4613;background:linear-gradient(180deg,#f7ecc8,#d9bd72 48%,#8f7024);color:#2b2014;font-size:12px;letter-spacing:.1em;cursor:pointer">确定</button>'
        + '</div></div>';
      document.body.appendChild(wrap);
      const input = wrap.querySelector('#__ui_prompt_input');
      input.value = String(defaultValue || '');
      const done = (value) => { try { wrap.remove(); } catch (e) { /* ignore */ } resolve(value); };
      wrap.querySelector('[data-yes]').addEventListener('click', () => done(input.value));
      wrap.querySelector('[data-no]').addEventListener('click', () => done(null));
      wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(input.value);
        else if (e.key === 'Escape') done(null);
      });
      setTimeout(() => { try { input.focus(); input.select(); } catch (e) { /* ignore */ } }, 30);
    });
  }
  function uiConfirm(title) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.58)';
      wrap.innerHTML =
        '<div style="min-width:320px;max-width:460px;padding:18px 20px;background:linear-gradient(180deg,#1b130c,#120c07);border:1px solid #5c4613;border-radius:2px;box-shadow:0 20px 60px rgba(0,0,0,.75),inset 0 0 0 1px rgba(247,236,200,.18)">'
        + '<div style="font:400 13px/1.6 sans-serif;color:#f2e6c8;margin-bottom:14px">' + String(title || '') + '</div>'
        + '<div style="display:flex;gap:8px;justify-content:flex-end">'
        + '<button type="button" data-no style="padding:7px 15px;border-radius:2px;border:1px solid #5c4613;background:linear-gradient(180deg,#2c2014,#170f09);color:#ecda9f;font-size:12px;letter-spacing:.1em;cursor:pointer">取消</button>'
        + '<button type="button" data-yes style="padding:7px 15px;border-radius:2px;border:1px solid #5c4613;background:linear-gradient(180deg,#f7ecc8,#d9bd72 48%,#8f7024);color:#2b2014;font-size:12px;letter-spacing:.1em;cursor:pointer">确定</button>'
        + '</div></div>';
      document.body.appendChild(wrap);
      const done = (v) => { try { wrap.remove(); } catch (e) { /* ignore */ } resolve(v); };
      wrap.querySelector('[data-yes]').addEventListener('click', () => done(true));
      wrap.querySelector('[data-no]').addEventListener('click', () => done(false));
      wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });
    });
  }

  // 静默文案（2026-11-16）：原「开启时不调用对话模型，不产生消耗」是夸大的——
  // 8103 /quiet 的真实语义只是「她不主动开口」，用户说话仍会调模型。三处引用统一走常量。
  const QUIET_ON = '开启后她不主动开口（不主动搭话、不发起话题）；你说话时仍会调用模型，照样产生消耗。';
  const QUIET_OFF = '她可能主动开口；你说话时也会调用模型。';
  let config = {};
  let providerBook = [];
  let configDirty = false;
  let pluginConfigDirty = false;
  let loadingConfigUi = true;
  let closePromptOpen = false;
  let overviewData = null;
  // 2026-11-10：总览每 15s 自动刷新，paintOverview 会用旧快照回填 quiet 开关。
  //   用户刚点完、/state 还没返回新值的那个窗口里，开关会被「掰回去」，看起来要点两次。
  //   记录一次用户操作时间，2.5s 内不让轮询快照覆盖用户刚做的选择。
  let quietTouchedAt = 0;
  let memoryData = null;
  let memoryLoaded = false;
  let live2dRunning = false;
  document.title = '大肥鱼 · 控制中心';
  document.documentElement.spellcheck = false;
  document.querySelectorAll('input, textarea').forEach(element => { element.spellcheck = false; });

  // ── toast / 脏标记 ────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(message) {
    const t = $('toast');
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function updateDirtyUI() {
    const dirty = configDirty || pluginConfigDirty;
    document.querySelector('.content').classList.toggle('dirty', dirty);
    $('save-config').classList.toggle('dirty', dirty);
    api.setConfigDirty(dirty);
  }
  function setConfigDirty(dirty) { configDirty = Boolean(dirty); updateDirtyUI(); }
  function setPluginConfigDirty(dirty) { pluginConfigDirty = Boolean(dirty); updateDirtyUI(); }

  // 脏态是指纹算出来的，不是单向置位：把字段改回原值，浮条自动收回
  function computeDirtyFingerprint() {
    const parts = [];
    // 2026-11-21：演出两个开关（choreo / perf-auto）已改为「点完即写盘」（能力页同一 IPC），
    // 不再参与脏态 —— 否则它们会一直把保存浮条点亮，而保存并不会写它们。
    for (const [id, [, type]] of Object.entries(fields)) {
      const el = $(id);
      if (!el) continue;
      parts.push(type === 'checked' ? String(el.checked) : String(el.value));
    }
    for (const key of ['llm', 'vision']) {
      const s = providerSections[key];
      if (!s || !s.text()) continue;
      parts.push(s.readProviderId(), s.url().value, s.key().value, s.modelInput().value);
    }
    parts.push(get(config, 'llm.reasoning_enabled') ? '1' : '0', String(get(config, 'llm.reasoning_effort', '')));
    parts.push(JSON.stringify(providerBook));
    return parts.join('\u0000');
  }
  let savedFingerprint = '';
  function captureSavedFingerprint() { savedFingerprint = computeDirtyFingerprint(); }
  function refreshDirtyFromState() {
    if (loadingConfigUi) return;
    setConfigDirty(computeDirtyFingerprint() !== savedFingerprint);
  }

  // ── 窗口按钮 / 下拉菜单基础行为 ──────────────────────────────────────
  document.querySelectorAll('[data-window]').forEach(button => {
    button.addEventListener('click', () => api.windowAction(button.dataset.window));
  });

  function closeAllMenus(except) {
    document.querySelectorAll('.dd.open').forEach(dd => { if (dd !== except) dd.classList.remove('open'); });
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('.dd')) closeAllMenus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeAllMenus(); if (!$('history-image-modal').hidden) closeHistoryPreview(); if ($('memory-graph-modal').classList.contains('open')) closeGraphDetail(); $('onboarding-components-modal')?.classList.remove('open'); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveConfig(); }
  });

  function wireTrigger(dd) {
    const trigger = dd.querySelector(':scope > .dd-trigger');
    if (!trigger) return;
    trigger.addEventListener('click', () => {
      const open = dd.classList.contains('open');
      closeAllMenus(dd);
      dd.classList.toggle('open', !open);
    });
  }
  document.querySelectorAll('.dd').forEach(wireTrigger);

  // 语言下拉：选中即写进隐藏 input（#tts-language），保存时随字段表走
  function bindMenu(ddId, { onPick } = {}) {
    const dd = $(ddId);
    const label = dd.querySelector('.dd-text');
    dd.querySelectorAll('.dd-item').forEach(item => item.addEventListener('click', () => {
      dd.querySelectorAll('.dd-item').forEach(other => {
        const selected = other === item;
        other.classList.toggle('selected', selected);
        other.setAttribute('aria-selected', String(selected));
      });
      label.textContent = item.textContent;
      dd.classList.remove('open');
      const input = dd.dataset.target ? $(dd.dataset.target) : null;
      if (input) input.value = item.dataset.value || item.textContent.trim();
      onPick?.(item);
    }));
    return {
      set(value) {
        const item = [...dd.querySelectorAll('.dd-item')].find(one => (one.dataset.value || one.textContent.trim()) === String(value));
        if (item) item.click();
      }
    };
  }
  const langMenu = bindMenu('tts-lang-dd', { onPick: () => { if (!loadingConfigUi) refreshDirtyFromState(); } });
  // TTS 引擎下拉（tts-backends.js：edge/sovits/openai/custom，换引擎不改代码）
  const ttsBackendMenu = bindMenu('tts-backend-dd', { onPick: () => { if (!loadingConfigUi) refreshDirtyFromState(); } });

  document.querySelectorAll('[data-go]').forEach(button => {
    button.addEventListener('click', () => switchPage(button.dataset.go));
  });

  // 迁移引导（2026-11-21）：四个旧页面各一条「去能力页」。
  // 能力区就在外观页内，所以先切页再滚到 #capability-rows 并短暂描边，
  // 让用户明确「开关没丢，只是搬家了」。描边用现有 --accent，不引入新配色。
  document.querySelectorAll('[data-cap-link]').forEach(button => {
    button.addEventListener('click', () => {
      switchPage('settings');
      setTimeout(() => {
        const target = $('capability-rows');
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const previous = target.style.outline;
        target.style.outline = '1px solid var(--accent)';
        target.style.outlineOffset = '4px';
        setTimeout(() => {
          target.style.outline = previous;
          target.style.outlineOffset = '';
        }, 1200);
      }, 60);
    });
  });

  // ── 页面切换（v1 契约：data-page 导航 + .page/.active）───────────────
  let overviewTimer = null;
  function switchPage(pageId, navButton = null) {
    document.querySelector('.nav.active')?.classList.remove('active');
    document.querySelector('.page.active')?.classList.remove('active');
    (navButton || document.querySelector(`[data-page="${pageId}"]`))?.classList.add('active');
    const page = $(pageId);
    if (page) page.classList.add('active');
    if (overviewTimer) { clearInterval(overviewTimer); overviewTimer = null; }
    if (pageId === 'overview') {
      loadOverview(true);
      // 演出开关每次进总览都按能力注册表重读：能力页刚改完，这里不能还是旧值
      refreshPerfSwitchState();
      refreshPerformanceState();
      overviewTimer = setInterval(() => {
        if ($('overview').classList.contains('active')) loadOverview(true);
      }, 15000);
    }
    // 演出页：三个列表 + 开关 + 状态一次性拉；进出这里不重建 DOM，3 秒心跳只刷状态
    if (pageId === 'perform') loadPerformPage().catch(() => {});
    if (pageId === 'history') loadChatHistory();
    if (pageId === 'memory' && !memoryLoaded) loadMemory();
    // 装扮状态只在启动时读一次：皮套后于面板就绪（Cubism 15~60s）或首次读取恰逢加载窗口时，
    // 装扮区会永久停在「桌宠不在线」且无恢复路径。每次切到本页重读一次（一次 8004 eval，开销可忽略）。
    if (pageId === 'petbody') { loadDressup().catch(() => {}); loadScenes(); refreshPerformanceState(); }
    if (pageId === 'knowledge') loadKnowledge();
    if (pageId === 'skills') loadSkills();
    if (pageId === 'actions') { loadActions(); loadDispatchTasks(); }
    if (pageId === 'components') loadComponents();
  }
  document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => switchPage(button.dataset.page, button)));

  // ── 组件（v0.4.0）：底座之外的能力，按需下载 ──────────────────────────
  let componentsWired = false;
  function setComponentsProgress(text, pct) {
    const wrap = $('components-progress');
    const bar = $('components-progress-bar');
    const label = $('components-progress-text');
    if (!wrap || !bar || !label) return;
    wrap.hidden = false;
    if (text) label.textContent = text;
    if (typeof pct === 'number' && Number.isFinite(pct)) bar.value = Math.max(0, Math.min(100, pct));
  }
  async function loadComponents() {
    const list = $('components-list');
    if (!list) return;
    try {
      const st = await api.componentsStatus();
      if (!st || !st.ok) {
        list.innerHTML = '<p class="hint">组件清单不可用：' + escapeHtml((st && st.error) || '未知错误') + '</p>';
        return;
      }
      if (!st.components.length) {
        list.innerHTML = '<p class="hint">这个安装包没有附带组件清单（components/manifest.json）。</p>';
        return;
      }
      list.innerHTML = st.components.map((c) => {
        const size = Math.round((Number(c.sizeBytes) || 0) / 1048576) + 'MB';
        const state = c.installed ? ('已装 ' + escapeHtml(c.installedVersion || '')) : '未装';
        const action = c.installed
          ? '<button class="btn small" data-component-remove="' + escapeHtml(c.id) + '" type="button" style="white-space:nowrap">卸载</button>'
          : '<button class="btn small" data-component-install="' + escapeHtml(c.id) + '" type="button" style="white-space:nowrap">安装</button>';
        return '<div class="row"><span class="row-label">' + escapeHtml(c.name)
          + '<br><small class="hint">' + size + ' · ' + state + '</small></span>' + action + '</div>';
      }).join('');
      list.querySelectorAll('[data-component-install]').forEach((btn) => {
        btn.addEventListener('click', () => installComponents([btn.dataset.componentInstall]));
      });
      list.querySelectorAll('[data-component-remove]').forEach((btn) => {
        btn.addEventListener('click', () => removeComponents([btn.dataset.componentRemove]));
      });
    } catch (e) {
      list.innerHTML = '<p class="hint">读取组件清单失败：' + escapeHtml(e && e.message || e) + '</p>';
    }
  }
  async function installComponents(ids) {
    if (!api || !api.componentsInstall) return;
    setComponentsProgress('开始下载…', 0);
    setComponentButtonsDisabled(true);
    try {
      const r = await api.componentsInstall(ids);
      if (r && r.ok) {
        setComponentsProgress('安装完成。请重启大肥鱼后生效。', 100);
        toast('组件安装完成；重启大肥鱼后生效');
      } else {
        setComponentsProgress('安装失败：' + ((r && r.error) || '未知错误'), 0);
        toast('组件安装失败：' + ((r && r.error) || '未知错误'));
      }
    } catch (e) {
      setComponentsProgress('安装失败：' + (e && e.message || e), 0);
    } finally {
      setComponentButtonsDisabled(false);
      await loadComponents();
    }
  }
  async function removeComponents(ids) {
    if (!api || !api.componentsRemove) return;
    setComponentButtonsDisabled(true);
    try {
      const r = await api.componentsRemove(ids);
      if (r && r.ok) toast('已卸载；重启大肥鱼后生效');
      else toast('卸载失败：' + ((r && r.error) || '未知错误'));
    } finally {
      setComponentButtonsDisabled(false);
      await loadComponents();
    }
  }
  function setComponentButtonsDisabled(disabled) {
    ['components-install-all', 'components-refresh'].forEach((id) => {
      const b = $(id);
      if (b) b.disabled = !!disabled;
    });
  }
  function wireComponents() {
    if (componentsWired) return;
    componentsWired = true;
    const all = $('components-install-all');
    if (all) all.addEventListener('click', () => installComponents(null));
    const refresh = $('components-refresh');
    if (refresh) refresh.addEventListener('click', () => loadComponents());
    const open = $('components-open-dir');
    if (open) open.addEventListener('click', () => api.componentsOpenDir());
    if (api && api.onComponentsProgress) {
      api.onComponentsProgress((p) => {
        if (!p) return;
        if (p.kind === 'progress') {
          if (p.total) setComponentsProgress(null, Math.round(p.received / p.total * 100));
          return;
        }
        const name = p.name || p.id || '';
        const map = {
          component: '正在安装 ' + name,
          download: '下载 ' + name,
          file: p.skipped ? ('已存在，跳过 ' + name) : ('下载/解压 ' + name),
          config: '写入配置…',
          setup: '写入组件配置…',
          done: '完成',
        };
        setComponentsProgress(map[p.phase] || (p.phase || '处理中…'), p.phase === 'done' ? 100 : undefined);
        // 2026-11-28：批量装 8 个时，列表行原要等整批结束才刷新；每进一个组件/写完配置就重读一次状态
        if (p.phase === 'component' || p.phase === 'config' || p.phase === 'setup' || p.phase === 'done') {
          loadComponents().catch(() => {});
        }
      });
    }
  }

  // ── 首启引导（v0.5.2，安装版）：第一次打开设置就提示「8 个组件全部装好」 ──
  // 不做档位/推荐勾选：全部默认选中（用户 2026-11-28 拍板「全亮最好」）。
  // 只在安装版生效；显示一次即记 prompted，点「稍后」也不反复弹，组件页随时可装。
  let onboardingChecked = false;
  async function maybeShowComponentsOnboarding() {
    if (onboardingChecked) return;
    onboardingChecked = true;
    try {
      if (!api || !api.onboardingState) return;
      const st = await api.onboardingState();
      if (!st || !st.ok || st.skip || st.prompted) return;
      if (!Array.isArray(st.missing) || !st.missing.length) return;
      const modal = $('onboarding-components-modal');
      const list = $('onboarding-components-list');
      if (!modal || !list) return;
      const totalMb = st.missing.reduce((sum, c) => sum + (Number(c.sizeBytes) || 0), 0) / 1048576;
      list.innerHTML = st.missing.map((c) => {
        const size = Math.round((Number(c.sizeBytes) || 0) / 1048576) + 'MB';
        return '<div class="row"><span class="row-label">' + escapeHtml(c.name)
          + '<br><small class="hint">' + size + '</small></span>'
          + '<span class="cap-badge hot">已选中</span></div>';
      }).join('');
      const foot = $('onboarding-components-foot');
      if (foot) {
        foot.textContent = '以上 ' + st.missing.length + ' 个组件合计约 ' + Math.round(totalMb)
          + 'MB；本地视觉（ollama）的三个模型另需约 9.3GB，请确保磁盘 ≥ 16GB 空闲；'
          + '8B 视觉模型在 8GB 以上显存更流畅，显存不足会自动走 CPU（较慢）。装完需要重启大肥鱼才生效。';
      }
      modal.classList.add('open');
      try { await api.onboardingPrompted(); } catch (e) { /* 标记失败只影响下次是否再弹 */ }
    } catch (e) { /* 首启引导失败不阻塞主流程 */ }
  }
  function wireOnboarding() {
    const modal = $('onboarding-components-modal');
    const later = $('onboarding-components-later');
    const install = $('onboarding-components-install');
    if (later) later.addEventListener('click', () => { if (modal) modal.classList.remove('open'); });
    if (install) install.addEventListener('click', () => {
      if (modal) modal.classList.remove('open');
      // 全部组件：installComponents(null) 会按清单全装（与组件页「全部安装」同一条链路）
      switchPage('components');
      installComponents(null);
    });
  }

  // ── 总览 ─────────────────────────────────────────────────────────────
  async function loadOverview(silent = false) {
    try {
      overviewData = await api.overview();
      paintOverview();
    } catch (error) {
      console.warn('[v2] overview 读取失败:', error);
      if (!silent) toast('总览数据读取失败：' + error.message);
    }
  }

  function fmtUptime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!total) return '';
    const minutes = Math.floor(total / 60);
    const hours = Math.floor(minutes / 60);
    if (hours) return `${hours} 小时 ${minutes % 60} 分钟`;
    if (minutes) return `${minutes} 分钟`;
    return `${total} 秒`;
  }

  function paintOverview() {
    const data = overviewData;
    if (!data) return;
    $('svc-list').innerHTML = (data.services || []).map(service =>
      // 主进程给的 detail 里可能带「 · 」分隔，统一成中文逗号再上屏
      `<div class="svc"><i class="dot ${service.up ? 'up' : 'down'}"></i><span>${escapeHtml(service.name)}</span><span class="detail">${escapeHtml(String(service.detail || '').replace(/ · /g, '，') + '（' + service.port + '）')}</span></div>`
    ).join('') || '<p class="hint" style="margin:8px 0">主进程没有返回服务列表</p>';

    // 静默值由主进程给出：8103 在线 = /state 的 live 值（quietSource:live）；
    // 8103 掉线 = 盘上 cost.quiet（quietSource:config）—— 两种情况都是真值，
    // 不会再把「不知道」画成「关」。2026-11-21 统一管辖后本页只剩总览这一个开关（快捷方式），
    // 真源仍是 8103 /quiet（能力页 proactive.quiet 与托盘同源）。
    const quiet = typeof data.quiet === 'boolean' ? data.quiet : null;
    if (quiet !== null && Date.now() - quietTouchedAt > 2500) {
      document.getElementById('quiet-switch').checked = quiet;
      document.getElementById('quiet-desc').textContent = quiet ? QUIET_ON : QUIET_OFF;
    }

    const up = fmtUptime(data.uptime);
    $('ov-uptime').textContent = up ? `已运行 ${up}` : '未运行';

    const pet = data.pet;
    $('ov-pet-pos').textContent = pet ? `皮套窗 ${pet.width}×${pet.height} @ ${pet.x},${pet.y}` : '离线';
    const sub = data.subtitle;
    $('ov-sub-pos').textContent = sub ? `字幕窗 ${sub.width}×${sub.height} @ ${sub.x},${sub.y}` : '离线';

    $('ov-memory').textContent = String(data.memoryCount ?? 0);
    const model = data.model || {};
    $('ov-model').textContent = [model.provider_id, model.model_id].filter(Boolean).join(' / ') || '未配置';
  }

  $('ov-refresh').addEventListener('click', () => loadOverview(true));

  // ── 她的状态（2026-11-10）：身体/心情/技能/历史/知识库 + 投喂 ──────────────
  // 数据走主进程 IPC（control-main.js 的 pet-state / pet-feed），不依赖渲染进程。
  async function loadHerState() {
    const body = $('ov-body');
    if (!body) return;
    try {
      const s = await api.petState();
      if (!s || !s.alive) { body.textContent = '读不到（活着感插件没跑？）'; return; }
      const a = s.alive;
      // 状态文件里是浮点（34.12191…），显示前取整
      const r0 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : v);
      body.textContent = `饱食 ${r0(a.satiety)}% · 精力 ${r0(a.energy)}% · 亲密 ${r0(a.intimacy)}`;
      if ($('ov-mood') && s.mood) {
        const sc = Number(s.mood.score);
        $('ov-mood').textContent = `${sc < -0.3 ? '低落' : sc > 0.3 ? '不错' : '平稳'}（${sc.toFixed(2)}，伤口 ${s.mood.wounds} 条${s.mood.lastWound ? '：' + s.mood.lastWound : ''}）`;
      }
      const bits = [];
      if (s.skills) bits.push(`技能 ${s.skills.active}/${s.skills.total}`);
      if (s.history) bits.push(`执行历史 ${s.history.total} 条`);
      if (s.knowledge) bits.push(`知识库 ${s.knowledge.entries} 条`);
      if (s.drift) bits.push(`漂移 ${s.drift.total24h}/24h`);
      if ($('ov-kit')) $('ov-kit').textContent = bits.join(' · ');
    } catch (e) { body.textContent = '读取失败：' + (e && e.message || e); }
  }
  $('ov-feed')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '投喂中…';
    try {
      const r = await api.petFeed();
      if (r && r.ok) {
        const st = r.state || {};
        btn.textContent = `已喂（饱食 ${st.satiety ?? '?'}%）`;
        setTimeout(() => { btn.textContent = old; try { loadHerState(); } catch (e) { /* ignore */ } }, 1200);
        return;
      }
      btn.textContent = '失败';
      setTimeout(() => { btn.textContent = old; }, 1500);
      if (r && r.error) console.warn('[pet] 投喂失败:', r.error);
    } catch (e) {
      btn.textContent = '失败';
      setTimeout(() => { btn.textContent = old; }, 1500);
    } finally { btn.disabled = false; }
  });
  loadHerState();

  // 静默：只剩总览一个开关（+能力页/托盘），三处都走同一个通道（8103 /quiet），
  // 不各写各的源。2026-11-21 统一管辖：设置页那个重复开关已删除。
  async function applyQuiet(on) {
    quietTouchedAt = Date.now();
    const paint = (v) => {
      document.getElementById('quiet-switch').checked = v;
      document.getElementById('quiet-desc').textContent = v ? QUIET_ON : QUIET_OFF;
    };
    paint(on);   // 乐观更新，2.5s 内轮询不覆盖
    const result = await api.toggleQuiet(on).catch(error => ({ ok: false, error: error.message }));
    if (result && result.ok !== false) {
      const applied = result.quiet === undefined ? on : Boolean(result.quiet);
      quietTouchedAt = Date.now();
      set(config, 'cost.quiet', applied);   // 让之后的 saveConfig 带新值，不会把旧值写回去
      paint(applied);
      toast(applied ? '静默模式已开启' : '静默模式已关闭');
    } else {
      quietTouchedAt = 0;
      paint(!on);
      toast('切换失败：' + ((result && result.error) || '桌宠不在线'));
    }
  }
  document.getElementById('quiet-switch').addEventListener('change', (e) => applyQuiet(e.target.checked));

  // ── 演出（2026-11-16 起；2026-11-25 P3b 迁成独立「演出」页）─────────────
  // 为什么独立一页：总览原先把「两个开关 + 一次手动试演」塞在一行里，而长戏还有托盘、
  // 能力页、皮套页三个入口；再接节目单就是四处入口四套文案。现在手动演出只在「演出」页，
  // 总览只留开关与一行状态（ADR-015 §4.5 第 1、2 条：避免两处入口漂移）。
  //   v1 情绪微动作 = 说话时的小动作（ui.petbody_choreo，托盘/能力页同一个键）
  //   v2 自动演长戏 = 情绪到位时演 19–38 秒（ui.petbody_perf_auto；节流在渲染层）
  //   节目单自动   = performance.program.enabled（P3a 已接线；开关写配置 + setPerformanceConfig 热下发）
  // 生效链路：control:set-config-value（白名单落盘）+ 立即 petbodyEval 让当前会话就变。
  const perfEval = (js, opts = {}) => api.petbodyEval(js).then((res) => {
    // control:petbody-eval 返回 { ok, value }（8004 /eval 的原始回包），不是裸值
    if (!res || res.ok === false) {
      if (opts.silent !== true) toast('演出通道失败：' + ((res && res.error) || '桌宠不在线'));
      return null;
    }
    return res.value === undefined ? null : res.value;
  }).catch((error) => {
    toast('演出通道失败：' + ((error && error.message) || '桌宠不在线'));
    return null;
  });

  // 演出开关的状态来源（2026-11-21 统一管辖；2026-11-25 覆盖总览 + 演出页两处控件）：
  // 以前读本地 config 副本，能力页改完这些键、总览仍显示旧值（一个功能两套显示语义）。
  // 现在读能力注册表（control:capabilities → resolveCapabilityValue：config > 当前模型 > 默认），
  // 和能力页同一份数据；注册表失败才退回 config 副本，绝不把开关刷成「猜的值」。
  async function refreshPerfSwitchState() {
    let items = null;
    try { items = await api.capabilities(); } catch (e) { items = null; }
    const valueOf = (key) => {
      const hit = Array.isArray(items) ? items.find((x) => x.key === key) : null;
      return hit && typeof hit.value === 'boolean' ? hit.value : undefined;
    };
    const choreo = valueOf('ui.petbody_choreo');
    const perfAuto = valueOf('ui.petbody_perf_auto');
    const program = valueOf('performance.program.enabled');
    const paint = (ids, value, fallback) => {
      const on = value !== undefined ? value : fallback;
      for (const id of ids) { const box = $(id); if (box) box.checked = on; }
    };
    // 缺省与渲染层默认一致（choreo 默认关、perf-auto 默认开、program 默认开）
    paint(['choreo-switch', 'perform-choreo-switch'], choreo,
      !!(config.ui && config.ui.petbody_choreo === true));
    paint(['perf-auto-switch', 'perform-auto-switch'], perfAuto,
      !(config.ui && config.ui.petbody_perf_auto === false));
    paint(['perform-program-switch'], program,
      !(config.performance && config.performance.program && config.performance.program.enabled === false));
  }

  // ── 演出页纯函数（2026-11-25 P3b）──────────────────────────────────────
  // 放这里是为了能在 Node 里直接跑（_probe/test-perf-ui.cjs 按标记提取执行）：
  // 不启动 Electron 也能验「12 段就画 12 个按钮」「缺字段不写 0」「读哪个 reason 字段」。
  // __PERF_UI_PURE_START__
  function perfEscape(value) {
    return String(value == null ? '' : value)
      .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** 12 段场景按钮：一个段一个按钮，data-scene 给点击用。 */
  function buildSceneButtons(scenes) {
    const list = Array.isArray(scenes) ? scenes : [];
    return list
      .filter((name) => String(name == null ? '' : name).trim())
      .map((name) => `<button class="btn" type="button" data-scene="${perfEscape(name)}">${perfEscape(name)}</button>`)
      .join('');
  }

  /** 15 段长戏下拉：value=运行时 key，文案=title · 秒数（秒数缺失时不写 0）。 */
  function buildPerformanceOptions(list) {
    const rows = Array.isArray(list) ? list : [];
    return rows.filter((p) => p && p.key).map((p) => {
      const secs = Number(p.duration);
      const label = `${p.title || p.key}${Number.isFinite(secs) ? ' · ' + Math.round(secs) + 's' : ''}`;
      return `<option value="${perfEscape(p.key)}">${perfEscape(label)}</option>`;
    }).join('');
  }

  function perfNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function perfFirstNumber(...values) {
    for (const value of values) { const n = perfNumber(value); if (n !== null) return n; }
    return null;
  }

  /** 剩余秒数：不在演或不给进度就是 —，绝不把缺失当 0（显示 0 秒像坏了）。 */
  function formatRemainingSeconds(status) {
    if (!status || typeof status !== 'object' || !status.active) return '—';
    const t = perfFirstNumber(status.t, status.elapsed);
    const total = perfFirstNumber(status.duration, status.total);
    if (t === null || total === null) return '—';
    return Math.max(0, Math.round(total - t)) + ' 秒';
  }

  /** performanceDebug() 只读快照 → 「最近一次为什么没演」的一行文案。 */
  function summarizePerformanceDebug(debug) {
    const db = (debug && typeof debug === 'object') ? debug : {};
    const dir = (db.director && typeof db.director === 'object') ? db.director : {};
    const mode = String(dir.mode || 'off');
    let reason = '';
    const decision = dir.lastDecision;
    if (decision && typeof decision === 'object') {
      reason = String(decision.reason || (decision.decision && decision.decision.reason) || '').trim();
    }
    if (!reason) {
      const ev = db.scheduler && db.scheduler.lastEvent;
      if (ev && typeof ev === 'object') reason = String(ev.reason || ev.kind || ev.event || '').trim();
      else if (typeof ev === 'string') reason = ev.trim();
    }
    if (reason) return { reason, mode, line: `为什么没演：${reason}（导演 ${mode}）` };
    if (mode === 'off') return { reason: '', mode, line: '导演未开，不会自动演' };
    return { reason: '', mode, line: '最近没有拦下的演出' };
  }

  /** 节目单当日预算余额：performanceDebug().program.budgetLeft 优先，缺键返回 null（= 未接线）。 */
  function readProgramBudgetLeft(debug) {
    const p = debug && typeof debug === 'object' ? debug.program : null;
    if (!p || typeof p !== 'object') return null;
    const direct = perfNumber(p.budgetLeft);
    if (direct !== null) return direct;
    const left = p.budget && p.budget.left;
    const plays = perfNumber(left && typeof left === 'object' ? left.plays : left);
    return plays;
  }

  /** listPrograms() 条目宽容解析（P3a 之前渲染层还没这个 API）。 */
  /** listPrograms() 条目宽容解析（P3a 现在回 {items:[...]}；老/别家的数组也认）。 */
  function normalizeProgramRows(list) {
    const rows = Array.isArray(list) ? list : (list && Array.isArray(list.items) ? list.items : []);
    return rows.filter((p) => p && (p.id || p.key)).map((p) => {
      const id = String(p.id || p.key);
      // 节目单的时长通常是「拍」的 maxMs 之和（listPrograms 只给 beats）
      const beatMs = Array.isArray(p.beats)
        ? p.beats.reduce((sum, b) => sum + (Number(b && b.maxMs) || 0), 0)
        : null;
      const secs = perfFirstNumber(
        p.durationSec,
        p.durationMs === undefined ? null : Number(p.durationMs) / 1000,
        p.duration,
        p.seconds,
        beatMs === null ? null : beatMs / 1000
      );
      return { id, title: String(p.title || p.name || id), seconds: secs === null ? null : Math.round(secs) };
    });
  }

  /** 节目单容器：未接线要说清楚，不能显示一个空列表让人以为坏了。 */
  function buildProgramRows(rows, wired) {
    if (!wired) return '<p class="hint" style="margin:8px 0">节目单未接线（渲染层还没有 listPrograms）</p>';
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return '<p class="hint" style="margin:8px 0">节目单是空的</p>';
    return list.map((r) => '<div class="row">'
      + `<span class="row-label">${perfEscape(r.title)}<span class="sub mono">${perfEscape(r.id)}${r.seconds === null ? '' : ' · ' + r.seconds + ' 秒'}</span></span>`
      + `<button class="btn small" type="button" data-program="${perfEscape(r.id)}">试演</button>`
      + '</div>').join('');
  }
  // __PERF_UI_PURE_END__

  // 场景/长戏/节目单三个列表只在进页面时拉一次；3 秒心跳只刷状态与预算，不重画列表。
  async function loadPerformScenes() {
    let scenes = FALLBACK_SCENES;
    try {
      const value = JSON.parse(await petEval('JSON.stringify(window.petBody && window.petBody.listScenes ? window.petBody.listScenes() : [])') || '[]');
      if (Array.isArray(value) && value.length) scenes = value;
    } catch { /* 皮套不在线就给默认六段，点了会有明确报错 */ }
    const box = $('perform-scenes');
    if (box) box.innerHTML = buildSceneButtons(scenes);
  }

  async function loadPerformLongList() {
    // 段列表从渲染层拿：编译产物是唯一真相源，重编译后这里自动跟上
    const list = await perfEval('window.__petPerformance ? window.__petPerformance.list() : null', { silent: true });
    const sel = $('perform-pick');
    if (!sel) return;
    sel.innerHTML = buildPerformanceOptions(list) || '<option value="">（桌宠未运行）</option>';
  }

  async function loadPrograms() {
    const box = $('perform-programs');
    if (!box) return;
    // listPrograms 由 P3a 的 program-runner 提供；没有就诚实显示「未接线」，不画假行。
    // 三种状态要分开：桌宠不在线 / 没这个 API（未接线）/ 有 API 但列表空。
    const raw = await perfEval(
      'JSON.stringify((function(){try{if(!window.petBody)return {online:false,wired:false,list:null};'
        + 'var wired=typeof window.petBody.listPrograms==="function";'
        + 'return {online:true,wired:wired,list:wired?(window.petBody.listPrograms()||[]):null};'
        + '}catch(e){return {online:false,wired:false,list:null,error:String(e&&e.message||e)};}})())',
      { silent: true }
    );
    let info = null;
    try { info = raw ? JSON.parse(raw) : null; } catch (e) { info = null; }
    if (!info || info.online === false) { box.innerHTML = '<p class="hint" style="margin:8px 0">桌宠不在线，读不到节目单</p>'; return; }
    const wired = info.wired === true;
    const meta = (info.list && typeof info.list === 'object' && !Array.isArray(info.list)) ? info.list : null;
    const notes = [];
    if (meta) {
      // 试演点不动的原因要提前说出来（三种拒绝理由：总开关 / 调度器 / 预算）
      if (meta.enabled !== true) notes.push('节目单总开关关着');
      if (meta.scheduler !== true) notes.push('调度器没开（performance.scheduler.enabled）');
      if (meta.error) notes.push('数据错误：' + meta.error);
    }
    box.innerHTML = (notes.length
      ? `<p class="hint" style="margin:8px 0">${perfEscape(notes.join(' · '))}</p>`
      : '') + buildProgramRows(normalizeProgramRows(info.list), wired);
  }

  async function loadPerformPage() {
    await refreshPerfSwitchState();
    await Promise.all([loadPerformScenes(), loadPerformLongList(), loadPrograms()]);
    await refreshPerformPageState();
  }

  async function readPerformanceDebugSnapshot() {
    return perfEval('window.petBody && typeof window.petBody.performanceDebug === "function" ? window.petBody.performanceDebug() : null', { silent: true });
  }

  // 演出页「实时状态」：在演什么 / 剩余秒数 / 最近一次为什么没演 / 节目单预算余额
  async function refreshPerformPageState() {
    const st = await perfEval('window.__petPerformance ? window.__petPerformance.status() : null', { silent: true });
    const db = await readPerformanceDebugSnapshot();
    const prog = db && db.program && typeof db.program === 'object' ? db.program : null;
    const stateEl = $('perform-state');
    if (stateEl) {
      if (!st && !db) stateEl.textContent = '桌宠未运行';
      else if (prog && prog.active) {
        // 节目单正在连戏：比 v2 单段更具体（第几拍 / 共几拍）
        stateEl.textContent = `节目单：${prog.title || prog.programId || '?'}（第 ${Number(prog.beatIdx) + 1}/${Number(prog.beatCount) || '?'} 拍）`;
      } else if (st && st.active) stateEl.textContent = '正在演：' + (st.title || st.key);
      else stateEl.textContent = '空闲';
    }
    const remainEl = $('perform-remaining');
    if (remainEl) remainEl.textContent = formatRemainingSeconds(st);
    const skipEl = $('perform-skip');
    if (skipEl) skipEl.textContent = db ? summarizePerformanceDebug(db).line : '读不到（桌宠不在线）';
    const budgetEl = $('perform-budget');
    if (budgetEl) {
      const left = readProgramBudgetLeft(db);
      budgetEl.textContent = !db
        ? '—'
        : (left === null ? '未接线' : left + ' 段');
    }
  }

  // ── 演出/皮套状态显示的纯函数（2026-11-21）──────────────────────────────
  // __CONTROL_V2_PURE_START__
  // 进度字段兼容：新运行时给 t/duration，旧/别家叫 elapsed/total；缺失必须是「—」，
  // 不能把 undefined 四舍五入成 0（之前显示 0/0，看起来像坏了）。
  function firstFiniteNumber(...values) {
    for (const value of values) {
      if (value === undefined || value === null || value === '') continue;
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function formatPerformanceProgress(status) {
    if (!status || typeof status !== 'object') return '';
    const t = firstFiniteNumber(status.t, status.elapsed);
    const total = firstFiniteNumber(status.duration, status.total);
    const fmt = (v) => (v === null ? '—' : String(Math.round(v)));
    return `${fmt(t)}/${fmt(total)} 秒`;
  }

  // 情绪增益是否真的被运行时接线。
  // 2026-11-25 P0：旧版只认 status.options.emotionGain，而渲染层的 buildPerformanceStatus
  // 从不返回 options → 滑杆恒定被判「未接线」禁用（审计附录 A 第 5 条）。
  // 现在以 status.gain.value（petbody-entry 一直有）为准，options.emotionGain 作为旧运行时兼容。
  // 仍然不认顶层 status.emotionGain（那是随手塞的值，不代表接线）。
  function readEmotionGainOption(status) {
    if (!status || typeof status !== 'object') return null;
    const gain = status.gain;
    if (gain && typeof gain === 'object' && Object.prototype.hasOwnProperty.call(gain, 'value')) {
      const n = Number(gain.value);
      if (Number.isFinite(n)) return n;
    }
    const options = status.options;
    if (!options || typeof options !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(options, 'emotionGain')) return null;
    const n = Number(options.emotionGain);
    return Number.isFinite(n) ? n : null;
  }

  // 插件配置里只有**顶层** enabled 已废弃（启停唯一入口是能力页）。
  // 嵌套的 enabled 是插件自己的子功能开关（如 backend_llm_fallback.fields.enabled），
  // 不能一起藏掉，否则配置编辑器会失去真实功能。
  function isDeprecatedPluginConfigKey(path) {
    return path === 'enabled';
  }
  // __CONTROL_V2_PURE_END__

  // 总览只保留这一行状态（2026-11-25 P3b）：手动试演已迁到「演出」页，
  // 这里只回答「她现在在不在演」——在演 / 空闲两个词，细节进演出页看。
  async function refreshPerformanceState() {
    const st = await perfEval('window.__petPerformance ? window.__petPerformance.status() : null', { silent: true });
    const el = $('perf-state');
    if (el) {
      if (!st) {
        el.textContent = '桌宠未运行';
      } else if (st.active) {
        el.textContent = `在演：${st.title || st.key}（到 ${formatPerformanceProgress(st)}）`;
      } else {
        const auto = st.auto || {};
        const count = Number(auto.sessionCount) || 0;
        el.textContent = `空闲 · 本会话自动演过 ${count} 段${auto.lastAt ? '' : '（还没触发过）'}`;
      }
    }
    paintEmotionGainAvailability(st);
  }

  // 情绪增益滑杆的可用性：运行时没给 options.emotionGain 就禁用并标「暂不可用」。
  let emotionGainLive = false;
  function paintEmotionGainAvailability(status) {
    const input = $('petbody-emotion-gain');
    if (!input) return;
    emotionGainLive = readEmotionGainOption(status) !== null;
    input.disabled = !emotionGainLive;
    const row = input.closest('.row');
    if (!row) return;
    row.classList.toggle('is-unavailable', !emotionGainLive);
    const sub = row.querySelector('.sub');
    if (sub) {
      if (!sub.dataset.baseText) sub.dataset.baseText = sub.textContent;
      sub.textContent = emotionGainLive
        ? sub.dataset.baseText
        : `${sub.dataset.baseText}（暂不可用：运行时未接线）`;
    }
    row.title = emotionGainLive ? '' : '当前皮套运行时没有 emotionGain 选项，滑杆已禁用';
  }

  $('petbody-emotion-gain')?.addEventListener('change', (event) => {
    // 只在运行时明确支持时下发；否则只留配置值，不动皮套（等重启/接线）。
    if (!emotionGainLive) return;
    const gain = Number(event.target.value);
    if (!Number.isFinite(gain)) return;
    perfEval(`window.petBody && typeof window.petBody.setEmotionGain === 'function' ? window.petBody.setEmotionGain(${gain}) : null`, { silent: true });
  });

  // 演出开关的写入口（2026-11-21 统一管辖；2026-11-25 两个页面同源）：
  // 以前只写本地 config 副本 + 标脏，要按「保存」才落盘；能力页同一键却是当场写盘。
  // 两个入口、两种语义 → 现在都走 control:set-config-value（能力页同一个 IPC + 同一份白名单），
  // 总览/演出页只是快捷方式：点完立即落盘 + 立即下发渲染层，不再制造「显示开了、重启丢了」。
  const PERF_SWITCH_BOXES = {
    'ui.petbody_choreo': ['choreo-switch', 'perform-choreo-switch'],
    'ui.petbody_perf_auto': ['perf-auto-switch', 'perform-auto-switch'],
    'performance.program.enabled': ['perform-program-switch'],
  };
  async function togglePerformanceCapability(path, key, on) {
    let r = null;
    try { r = await api.setConfigValue(key, on); } catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
    const wrote = !!(r && (r.ok === true || r.wrote === true));
    if (!wrote) {
      // 没落盘就把两处同名开关一起拨回去 —— 不能让 UI 停在一个只有这层相信的状态
      for (const id of (PERF_SWITCH_BOXES[key] || [])) {
        const box = $(id);
        if (box) box.checked = !on;
      }
      toast('切换失败：' + ((r && r.error) || '写盘失败'));
      return false;
    }
    set(config, path, on);   // 本地副本对齐，后续 saveConfig 不会用旧值把它盖回去
    return true;
  }

  function bindPerfSwitch(id, path, key, onMessage, applyJs, offlineNote) {
    const note = offlineNote || '（配置已存，桌宠不在线，重启后生效）';
    $(id)?.addEventListener('change', async (event) => {
      const on = event.target.checked;
      if (!(await togglePerformanceCapability(path, key, on))) return;
      let ok = null;
      if (applyJs) ok = await perfEval(applyJs(on), { silent: true });
      toast(onMessage(on) + (ok === null ? note : ''));
      // 另一处同名开关跟着变（总览 ⇄ 演出页），避免两页各显示一套值
      for (const other of (PERF_SWITCH_BOXES[key] || [])) {
        if (other === id) continue;
        const box = $(other);
        if (box) box.checked = on;
      }
    });
  }

  bindPerfSwitch('choreo-switch', 'ui.petbody_choreo', 'ui.petbody_choreo',
    (on) => (on ? '情绪微动作已开' : '情绪微动作已关'),
    (on) => `window.petBody && window.petBody.setChoreography(${on ? 'true' : 'false'})`);
  bindPerfSwitch('perform-choreo-switch', 'ui.petbody_choreo', 'ui.petbody_choreo',
    (on) => (on ? '情绪微动作已开' : '情绪微动作已关'),
    (on) => `window.petBody && window.petBody.setChoreography(${on ? 'true' : 'false'})`);
  bindPerfSwitch('perf-auto-switch', 'ui.petbody_perf_auto', 'ui.petbody_perf_auto',
    (on) => (on ? '自动演长戏已开' : '自动演长戏已关'),
    (on) => `window.petBody && window.petBody.setPerformanceAuto(${on ? 'true' : 'false'})`);
  bindPerfSwitch('perform-auto-switch', 'ui.petbody_perf_auto', 'ui.petbody_perf_auto',
    (on) => (on ? '自动演长戏已开' : '自动演长戏已关'),
    (on) => `window.petBody && window.petBody.setPerformanceAuto(${on ? 'true' : 'false'})`);
  // 节目单自动：运行时没有单元开关接口，走 setPerformanceConfig 整组下发（driver 启动时
  // 把 config.performance 注入 window.__petPerformanceConfig；这里读回来改一个键再发回去，
  // 不整组覆盖 —— 否则会把导演/待机层的现有配置打回默认）。
  bindPerfSwitch('perform-program-switch', 'performance.program.enabled', 'performance.program.enabled',
    (on) => (on ? '节目单自动已开' : '节目单自动已关'),
    (on) => `(function(){try{
      var on=${on ? 'true' : 'false'};
      var live=window.__petPerformanceConfig;
      var base=(live&&typeof live==="object")?JSON.parse(JSON.stringify(live)):{};
      base.program=Object.assign({},base.program||{},{enabled:on});
      if(live&&typeof live==="object"){live.program=Object.assign({},live.program||{},{enabled:on});}
      return (window.petBody&&typeof window.petBody.setPerformanceConfig==="function")
        ? window.petBody.setPerformanceConfig(base) : null;
    }catch(e){return null;}})()`,
    '（运行时还没接线，配置已存）');

  // 长戏「演 / 停」：从总览迁到演出页（ADR-015 §4.5 第 2 条），渲染层接口不变。
  $('perform-play')?.addEventListener('click', async () => {
    const key = $('perform-pick') && $('perform-pick').value;
    if (!key) { toast('没有可演的片段（桌宠可能没运行）'); return; }
    const ok = await perfEval(`window.petBody && window.petBody.playPerformance(${JSON.stringify(key)})`);
    toast(ok === true ? '开始演' : '没能开始（看她是不是已经停了）');
    setTimeout(refreshPerformPageState, 600);
    setTimeout(refreshPerformanceState, 600);
  });

  $('perform-stop')?.addEventListener('click', async () => {
    await perfEval('window.petBody && window.petBody.stopPerformance()');
    toast('已停');
    setTimeout(refreshPerformPageState, 300);
    setTimeout(refreshPerformanceState, 300);
  });

  // 8103 /perform（浏览器来源必须带 X-Pet-Token；缺令牌 8103 会明确回 403）
  async function postPerform(body) {
    const token = (typeof window !== 'undefined' && window.petControlToken) ? String(window.petControlToken) : '';
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Pet-Token'] = token;
    return fetch('http://127.0.0.1:8103/perform', { method: 'POST', headers, body: JSON.stringify(body) });
  }

  // 点场景 = 显式手动（优先级最高，会顶掉正在演的长戏）。皮套页与演出页共用这一段。
  async function performScene(name) {
    try {
      const response = await postPerform({ name });
      if (response.status === 403) {
        console.warn('[control] /perform 被 403 拒绝（缺 X-Pet-Token 或令牌不匹配）');
        toast('演出失败：HTTP 403（缺写令牌）');
        return;
      }
      if (!response.ok) { toast('演出失败：HTTP ' + response.status); return; }
      // ADR-015 §4.5 第 5 条：/perform 以后回 {ok, started}；老版本回 {} 也不能当失败
      let ack = null;
      try { ack = await response.json(); } catch (e) { ack = null; }
      if (ack && ack.ok === false) { toast('没演出来：' + (ack.error || ack.reason || '被拒')); return; }
      toast('已抢占当前表演：' + name);
    } catch {
      toast('皮套不在线，演出没送出去');
    }
  }

  // 节目单「试演」：走 8004 eval → window.petBody.playProgram(id)（P3a 的正式接口）。
  // 8103 /perform 目前只认场景名（扩成 kind:'program' 是 ADR §4.3 的后续项），本页不等它。
  // 三种拒绝理由必须说人话：disabled / scheduler-off / budget（外加 busy）。
  const PROGRAM_REASON_TEXT = {
    disabled: '节目单总开关关着（外观 → 能力 → 节目单（连戏））',
    'scheduler-off': '调度器没开（performance.scheduler.enabled）',
    budget: '今天的节目单额度用完了',
    busy: '正在演别的东西，等这段结束',
    'not-found': '找不到这个节目单',
  };
  async function performProgram(id, title) {
    const res = await perfEval(
      `window.petBody && typeof window.petBody.playProgram === 'function' ? window.petBody.playProgram(${JSON.stringify(String(id))}) : null`,
      { silent: true }
    );
    if (res === null) { toast('节目单未接线或皮套不在线'); return; }
    if (res && res.ok === true) {
      toast('已抢占当前表演：' + (title || id));
      setTimeout(refreshPerformPageState, 600);
      return;
    }
    const reason = String((res && res.reason) || 'unknown');
    toast('没演出来：' + (PROGRAM_REASON_TEXT[reason] || reason));
  }

  $('perform-scenes')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-scene]');
    if (!button) return;
    performScene(button.dataset.scene);
  });

  $('perform-programs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-program]');
    if (!button) return;
    const title = button.closest('.row')?.querySelector('.row-label')?.textContent || '';
    performProgram(button.dataset.program, title.trim());
  });

  // 状态 3 秒刷一次：只在总览 / 演出页可见时刷，别在后台空转。
  let perfStateTimer = null;
  function tickPerfState() {
    const page = document.querySelector('.page.active');
    if (!page) return;
    if (page.id === 'overview') refreshPerformanceState();
    else if (page.id === 'perform') refreshPerformPageState();
  }
  clearInterval(perfStateTimer);
  perfStateTimer = setInterval(tickPerfState, 3000);
  // 注意：真正的初始化（含开关初值）在启动流程里 config 加载完之后调 loadPerformPage()，
  // 这里不能提前调 —— config 还是空对象时会把开关显示成默认值。

  // 启动/停止桌宠：语义照 v1（启动前确认保存；退出事件可能先于 IPC 返回）
  function paintPetButton() {
    const button = $('start-pet');
    button.textContent = live2dRunning ? '停止桌宠' : '启动桌宠';
    button.classList.toggle('stop', live2dRunning);
  }
  $('start-pet').addEventListener('click', async () => {
    const button = $('start-pet');
    const wasRunning = live2dRunning;
    if (!wasRunning && !(await confirmUnsavedConfig('启动前保存配置'))) return;
    button.disabled = true;
    if (!wasRunning) { $('pet-log').textContent = ''; $('tool-log').textContent = ''; }
    try {
      const result = wasRunning ? await api.stopLive2d() : await api.startLive2d();
      toast(result.message);
      if (result.ok) live2dRunning = wasRunning ? false : true;
    } catch (error) {
      toast('操作失败：' + error.message);
    }
    button.disabled = false;
    paintPetButton();
  });

  // ── 日志分层：按来源标签着色（工程债②）——看日志不再一片白茫茫 ──────────
  const LOG_TAG_COLORS = [
    [/error|失败|⚠️|❌|异常|疑似挂起/i, 'log-c-err'],
    [/\[(一起看|陪玩|cowatch)|打分/, 'log-c-cowatch'],
    [/\[(记忆|MemOS|memos|图谱|rolling)/i, 'log-c-memory'],
    [/\[(语音|TTS|tts|ASR|asr|垫场|声纹)/, 'log-c-voice'],
    [/\[(直播|弹幕|live)/i, 'log-c-live'],
    [/\[(操控|直控|snapshot)/i, 'log-c-control'],
    [/\[日记/, 'log-c-diary'],
    [/\[(节目|晨昏|编播)/, 'log-c-show'],
    [/\[意图路由/, 'log-c-intent'],
  ];
  function logLineClass(line) {
    for (const [re, cls] of LOG_TAG_COLORS) if (re.test(line)) return cls;
    return '';
  }
  function appendLog(id, text) {
    const el = $(id);
    const frag = document.createDocumentFragment();
    for (const line of String(text).split('\n')) {
      const span = document.createElement('span');
      span.className = 'log-line ' + logLineClass(line);
      span.textContent = line + '\n';
      frag.appendChild(span);
    }
    el.appendChild(frag);
    el.scrollTop = el.scrollHeight;
  }
  api.onLive2dLog(text => appendLog('pet-log', text));
  api.onToolLog(text => appendLog('tool-log', text));
  api.onLive2dState(running => { live2dRunning = Boolean(running); $('start-pet').disabled = false; paintPetButton(); });
  $('clear-logs').addEventListener('click', () => { $('pet-log').textContent = ''; $('tool-log').textContent = ''; });

  // ── 提供商通讯录（模型页 + 辅助视觉子区共用，语义照 v1）──────────────
  // 通讯录由主进程以 __llm_providers 搭车带回；渲染层持工作副本，保存时随 save-config 送回。
  const REASONING_EFFORTS = ['low', 'medium', 'high'];
  const REASONING_LEVELS = ['off', ...REASONING_EFFORTS];

  const providerSections = {
    llm: {
      text: () => $('llm-provider-text'), options: () => $('llm-provider-options'), dd: () => $('llm-provider-dd'),
      url: () => $('llm-url'), key: () => $('llm-key'),
      modelInput: () => $('llm-model'), modelOptions: () => $('llm-model-options'), modelDd: () => $('llm-model-dd'), modelToggle: () => $('toggle-llm-models'),
      fetchButton: () => $('fetch-llm-models'),
      emptyText: '请选择提供商',
      readProviderId: () => String(get(config, 'llm.provider_id', '') || ''),
      writeProviderId: id => set(config, 'llm.provider_id', id),
      readModelId: () => String(get(config, 'llm.model', '') || ''),
      writeModelId: id => set(config, 'llm.model', id)
    },
    vision: {
      text: () => $('vision-provider-text'), options: () => $('vision-provider-options'), dd: () => $('vision-provider-dd'),
      url: () => $('vision-url'), key: () => $('vision-key'),
      modelInput: () => $('vision-model'), modelOptions: () => $('vision-model-options'), modelDd: () => $('vision-model-dd'), modelToggle: () => $('toggle-vision-models'),
      fetchButton: () => $('fetch-vision-models'),
      emptyText: '未配置',
      readProviderId: () => String(get(config, 'vision.provider_id', '') || ''),
      writeProviderId: id => set(config, 'vision.provider_id', id),
      readModelId: () => String(get(config, 'vision.vision_model.model', '') || ''),
      writeModelId: id => set(config, 'vision.vision_model.model', id)
    }
  };

  const bookProvider = id => providerBook.find(item => item.id === id) || null;
  const providerLabelText = item => (item && (item.name || item.id)) || '';
  const firstModelIdOf = provider => {
    const models = (provider && Array.isArray(provider.models)) ? provider.models : [];
    return (models.find(item => item && item.enabled !== false) || models[0] || {}).model_id || '';
  };

  // 视觉区块在没选提供商时直接填了凭据：按 v1 语义在通讯录里立一个「视觉模型」条目
  function ensureVisionProviderFromCredentials(sectionKey) {
    const s = providerSections[sectionKey];
    if (bookProvider(s.readProviderId())) return bookProvider(s.readProviderId());
    const hasCredentials = String(s.url().value || '').trim() || String(s.key().value || '').trim();
    if (!hasCredentials) return null;
    let id = 'vision';
    let suffix = 2;
    while (bookProvider(id)) id = `vision-${suffix++}`;
    const provider = { id, name: '视觉模型', api_key: String(s.key().value || ''), api_url: String(s.url().value || ''), enabled: true, models: [] };
    providerBook.push(provider);
    s.writeProviderId(id);
    return provider;
  }

  function renderProviderOptions(sectionKey) {
    const s = providerSections[sectionKey];
    const list = s.options();
    if (!providerBook.length) {
      list.innerHTML = '<span class="dd-item" style="cursor:default;color:var(--ink-3)">通讯录是空的：llm_providers.json 里还没有提供商</span>';
      return;
    }
    const current = s.readProviderId();
    list.innerHTML = providerBook.map(item => {
      const selected = item.id === current;
      return `<button class="dd-item provider-option${selected ? ' selected' : ''}" type="button" role="option" data-provider-section="${sectionKey}" data-provider-id="${escapeHtml(item.id)}" aria-selected="${selected}"><strong>${escapeHtml(providerLabelText(item))}</strong><small>${escapeHtml(item.api_url || '未配置接口地址')}${item.enabled === false ? '，已停用' : ''}</small></button>`;
    }).join('');
  }

  function renderModelOptions(sectionKey) {
    const s = providerSections[sectionKey];
    const list = s.modelOptions();
    const provider = bookProvider(s.readProviderId());
    const own = (provider && Array.isArray(provider.models) ? provider.models : []).filter(item => item && item.model_id).map(item => item.model_id);
    const fetched = (s.fetchedModels || []).filter(id => !own.includes(id));
    const all = [...own, ...fetched];
    const current = s.modelInput().value.trim();
    if (!all.length) {
      list.innerHTML = '<span class="dd-item" style="cursor:default;color:var(--ink-3)">该提供商还没有模型，点「获取模型」或直接输入</span>';
      return;
    }
    list.innerHTML = all.map(id =>
      `<div class="model-row"><button class="dd-item${id === current ? ' selected' : ''}" type="button" role="option" data-model-section="${sectionKey}" data-model-id="${escapeHtml(id)}" aria-selected="${id === current}">${escapeHtml(id)}</button><button class="btn tiny" type="button" data-test-section="${sectionKey}" data-test-model="${escapeHtml(id)}" aria-label="测试 ${escapeHtml(id)}">测试</button><span class="test-line" role="status" hidden></span></div>`
    ).join('');
  }

  function syncProviderSection(sectionKey) {
    const s = providerSections[sectionKey];
    if (!s || !s.text()) return;
    let provider = bookProvider(s.readProviderId());
    if (!provider && sectionKey === 'llm') {
      // 对话模型必须落在可用提供商上：id 失效时回落到第一个启用的（与运行时降级语义一致）
      provider = providerBook.find(item => item.enabled !== false) || providerBook[0] || null;
      if (provider) s.writeProviderId(provider.id);
    }
    s.text().textContent = provider ? providerLabelText(provider) : s.emptyText;
    s.url().value = provider ? String(provider.api_url || '') : '';
    s.key().value = provider ? String(provider.api_key || '') : '';
    if (provider && !s.modelInput().value.trim()) s.writeModelId(firstModelIdOf(provider));
    s.modelInput().value = s.readModelId();
    renderProviderOptions(sectionKey);
    renderModelOptions(sectionKey);
  }

  function selectProvider(sectionKey, id) {
    const s = providerSections[sectionKey];
    const provider = bookProvider(id);
    if (!s || !provider) return;
    s.writeProviderId(id);
    // 换提供商即换它的默认模型：避免把上一家的模型名混进这一家的通讯录
    s.writeModelId(firstModelIdOf(provider));
    s.fetchedModels = null;
    syncProviderSection(sectionKey);
    s.dd()?.classList.remove('open');
    if (!loadingConfigUi) refreshDirtyFromState();
  }

  function bindProviderSection(sectionKey) {
    const s = providerSections[sectionKey];
    for (const input of [s.url(), s.key()]) {
      input.addEventListener('input', () => {
        let provider = bookProvider(s.readProviderId());
        if (!provider) provider = ensureVisionProviderFromCredentials(sectionKey);
        if (!provider) return;
        provider.api_url = String(s.url().value || '');
        provider.api_key = String(s.key().value || '');
        // 两个区块指向同一家时，另一边的输入框跟着走，避免「看起来没保存上」
        const other = providerSections[sectionKey === 'llm' ? 'vision' : 'llm'];
        if (other && other.readProviderId() === provider.id) {
          if (document.activeElement !== other.url()) other.url().value = String(provider.api_url || '');
          if (document.activeElement !== other.key()) other.key().value = String(provider.api_key || '');
        }
        if (!loadingConfigUi) refreshDirtyFromState();
      });
    }
    s.modelInput().addEventListener('input', () => { s.writeModelId(s.modelInput().value.trim()); if (!loadingConfigUi) refreshDirtyFromState(); });
    s.modelInput().addEventListener('click', () => { closeAllMenus(s.modelDd()); s.modelDd().classList.add('open'); });
    s.modelToggle().addEventListener('click', () => {
      const dd = s.modelDd();
      const open = dd.classList.contains('open');
      closeAllMenus(dd);
      dd.classList.toggle('open', !open);
      s.modelToggle().setAttribute('aria-expanded', String(!open));
    });
    s.fetchButton().addEventListener('click', () => fetchModelsForSection(sectionKey));
  }

  async function fetchModelsForSection(sectionKey) {
    const s = providerSections[sectionKey];
    const button = s.fetchButton();
    const apiUrl = String(s.url().value || '').trim();
    if (!apiUrl) { s.url().focus(); toast('请先填写接口地址'); return; }
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = '获取中…';
    try {
      const models = await api.fetchLlmModels(apiUrl, s.key().value);
      s.fetchedModels = models;
      renderModelOptions(sectionKey);
      s.modelDd().classList.add('open');
      toast(`已获取 ${models.length} 个模型`);
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  document.addEventListener('click', event => {
    const providerButton = event.target.closest('[data-provider-section]');
    if (providerButton) { selectProvider(providerButton.dataset.providerSection, providerButton.dataset.providerId); return; }
    const modelOption = event.target.closest('[data-model-section]');
    if (modelOption) {
      const sectionKey = modelOption.dataset.modelSection;
      const s = providerSections[sectionKey];
      s.writeModelId(modelOption.dataset.modelId);
      s.modelInput().value = modelOption.dataset.modelId;
      s.modelDd().classList.remove('open');
      renderModelOptions(sectionKey);
      if (!loadingConfigUi) refreshDirtyFromState();
      return;
    }
    const testButton = event.target.closest('[data-test-section]');
    if (testButton) {
      const s = providerSections[testButton.dataset.testSection];
      const status = testButton.parentElement.querySelector('.test-line');
      testButton.disabled = true;
      testButton.textContent = '测试中';
      status.hidden = false;
      status.className = 'test-line';
      status.textContent = '正在请求模型，最多等待 30 秒…';
      api.testLlmModel(s.url().value, s.key().value, testButton.dataset.testModel)
        .then(result => {
          status.classList.add(result.ok ? 'ok' : 'fail');
          status.textContent = result.ok ? `可用，首字延迟 ${result.elapsedMs} ms（流式，思考已关）` : `测试失败：${result.message}`;
        })
        .catch(() => { status.classList.add('fail'); status.textContent = '测试失败，请重试'; })
        .finally(() => { testButton.disabled = false; testButton.textContent = '重测'; });
      return;
    }
    const option = event.target.closest('.dd-item');
    if (option && !option.closest('[data-target="tts-language"]')) {
      option.closest('.dd')?.classList.remove('open');
    }
  });

  bindProviderSection('llm');
  bindProviderSection('vision');

  // ── 思考等级（reasoning_enabled + reasoning_effort，四档）─────────────
  function renderReasoning() {
    const seg = $('llm-reasoning');
    const enabled = get(config, 'llm.reasoning_enabled', false) === true;
    const effort = String(get(config, 'llm.reasoning_effort', '') || '');
    const level = enabled && REASONING_EFFORTS.includes(effort) ? effort : 'off';
    seg.querySelectorAll('button[data-reasoning]').forEach(button => {
      const active = button.dataset.reasoning === level;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    });
    const hints = {
      off: '回复最快。',
      low: '偶尔多想一步，速度几乎不变。',
      medium: '更稳，稍慢。',
      high: '最周全，最慢，更费额度。'
    };
    $('llm-reasoning-hint').textContent = hints[level];
  }
  $('llm-reasoning').addEventListener('click', event => {
    const button = event.target.closest('button[data-reasoning]');
    if (!button) return;
    const level = button.dataset.reasoning;
    if (level === 'off') set(config, 'llm.reasoning_enabled', false);
    else { set(config, 'llm.reasoning_enabled', true); set(config, 'llm.reasoning_effort', level); }
    if (!loadingConfigUi) refreshDirtyFromState();
    renderReasoning();
  });

  // ── 提示词广场 ───────────────────────────────────────────────────────
  $('open-prompt-market').addEventListener('click', () => {
    $('model-form').hidden = true;
    $('prompt-market').hidden = false;
    refreshPrompts();
  });
  $('close-prompt-market').addEventListener('click', () => {
    $('prompt-market').hidden = true;
    $('model-form').hidden = false;
  });

  function renderPrompts(prompts) {
    $('prompt-market-list').innerHTML = prompts.map((prompt, index) =>
      `<div class="prompt-card">
        <div class="prompt-card-head" data-prompt-toggle="${index}">
          <strong>${escapeHtml(prompt.title || '未命名提示词')}</strong><span>${escapeHtml(prompt.summary || '')}</span>
          <button class="btn small" type="button" data-apply-prompt="${index}">应用</button>
        </div>
        <div class="prompt-detail" data-prompt-detail="${index}" hidden>
          ${prompt.prerequisites ? `<p class="prompt-prerequisite">使用要求：${escapeHtml(prompt.prerequisites)}</p>` : ''}
          <pre>${escapeHtml(prompt.content || '')}</pre>
        </div>
      </div>`
    ).join('');
    $('prompt-market-list').querySelectorAll('[data-prompt-toggle]').forEach(header => header.addEventListener('click', event => {
      if (event.target.closest('[data-apply-prompt]')) return;
      const detail = header.parentElement.querySelector('[data-prompt-detail]');
      detail.hidden = !detail.hidden;
    }));
    $('prompt-market-list').querySelectorAll('[data-apply-prompt]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      const prompt = prompts[Number(button.dataset.applyPrompt)];
      $('llm-prompt').value = prompt.content || '';
      set(config, 'llm.system_prompt', prompt.content || '');
      refreshDirtyFromState();
      toast('已更新系统提示词，请保存配置');
    }));
  }

  async function refreshPrompts() {
    const button = $('refresh-prompts');
    button.disabled = true;
    $('prompt-market-status').textContent = '正在获取提示词…';
    try {
      const prompts = await api.getPrompts();
      renderPrompts(prompts);
      $('prompt-market-status').textContent = prompts.length ? `共 ${prompts.length} 个提示词，点标题展开，点「应用」填入系统提示词` : '接口返回的提示词列表为空';
    } catch (error) {
      $('prompt-market-list').innerHTML = '';
      $('prompt-market-status').textContent = `刷新失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  }
  $('refresh-prompts').addEventListener('click', refreshPrompts);

  // ── 配置字段表（id → config 路径；语义照 v1）─────────────────────────
  const fields = {
    'llm-prompt': ['llm.system_prompt', 'value'],
    temperature: ['llm.temperature', 'number'],
    'tts-language': ['tts.language', 'value'],
    'tts-speed': ['tts.speed_factor', 'number'],
    'tts-backend': ['tts.backend', 'value'],
    'tts-backend-params': ['tts.backend_params', 'value'],
    'opening-text': ['ui.intro_text', 'value'],
    'max-messages': ['context.max_messages', 'number'],
    'user-name': ['subtitle_labels.user', 'value'],
    'ai-name': ['subtitle_labels.ai', 'value'],
    'petbody-width': ['ui.pet_window.width', 'number'],
    'petbody-height': ['ui.pet_window.height', 'number'],
    'petbody-mouth-gain': ['ui.petbody_mouth_gain', 'number'],
    'petbody-emotion-gain': ['ui.petbody_emotion_gain', 'number'],
    'latency-filler-delay': ['llm.filler_delay_ms', 'number'],
    // 2026-11-21 统一管辖（第二次）：本表只留参数（数值/文本/选择）。
    // 以下布尔开关已从面板移除，唯一入口是能力页（data-cap-key → control:set-config-value）：
    //   ui.show_chat_box / asr.ptt_enabled / context.enable_limit / context.persistent_history /
    //   llm.temperature_enabled / vision.auto_screenshot / vision.use_vision_model /
    //   asr.voice_barge_in / subtitle_labels.enabled / auto_close_services.enabled /
    //   ui.click_through_default / llm.filler_enabled / ui.petbody_framing(下拉) / ui.show_model
    //   静默（cost.quiet）走 8103 /quiet 唯一真源，总览/托盘/能力页三处入口共用。
    // 删行前先确认每个键在 js/core/capabilities.js 里都有声明 —— 没有就不删（否则功能失去入口）。
  };
  const trackedConfigIds = new Set([...Object.keys(fields)]);
  document.addEventListener('input', event => {
    if (loadingConfigUi) return;
    if (trackedConfigIds.has(event.target.id)) refreshDirtyFromState();
    else if (event.target.matches?.('[data-plugin-field]')) setPluginConfigDirty(true);
  });
  document.addEventListener('change', event => {
    if (loadingConfigUi) return;
    if (trackedConfigIds.has(event.target.id)) refreshDirtyFromState();
    else if (event.target.matches?.('[data-plugin-field]')) setPluginConfigDirty(true);
  });

  // 新键缺省补齐（空字符串也算缺失——这几个键曾被写成空值导致输入框一直空着）
  function ensurePetbodyDefaults() {
    const defaults = {
      'ui.petbody_framing': 'half',
      'ui.petbody_mouth_gain': 1.1,
      'ui.petbody_emotion_gain': 1.0,
      'ui.pet_window.width': 420,
      'ui.pet_window.height': 760
    };
    for (const [path, fallback] of Object.entries(defaults)) {
      if (isBlank(get(config, path, undefined))) set(config, path, fallback);
    }
    if (isBlank(get(config, 'ui.click_through_default', undefined))) set(config, 'ui.click_through_default', false);
  }

  // 渲染时的字段快照：saveConfig 只回写和它不同的字段（缺键不被默认值实体化）
  let baselineFieldState = {};

  function readFieldState() {
    const state = {};
    for (const [id, [, type]] of Object.entries(fields)) {
      const el = $(id);
      if (!el) continue;
      state[id] = type === 'checked' ? el.checked : String(el.value ?? '');
    }
    return state;
  }

  function renderFields() {
    ensurePetbodyDefaults();
    for (const [id, [path, type]] of Object.entries(fields)) {
      const el = $(id);
      if (!el) continue;
      // 缺键默认值走 fieldInitialValue（与运行时缺省对齐；纯函数契约见 test-config-effective）
      const value = fieldInitialValue(id, type, get(config, path, undefined));
      if (type === 'checked') el.checked = Boolean(value);
      else el.value = value ?? '';
    }
    // 2026-11-21：ui.show_model / ui.petbody_framing 的开关已移出本页（能力页唯一入口），
    // 这里不再回填隐藏复选框，避免「面板给已删除元素赋值」的隐性依赖。
    langMenu.set(String(get(config, 'tts.language', 'zh') || 'zh'));
    ttsBackendMenu.set(String(get(config, 'tts.backend', 'edge') || 'edge'));
    baselineFieldState = readFieldState();
  }

  // ── 滚轮兜底 ────────────────────────────────────────────────────────────────
// CSS 已修好（.content/.main/.pages 补 min-height:0 + overflow:hidden），
// 正常情况下滚轮是原生的。这里再兜一层，覆盖两种边缘情况：
//   ① 鼠标停在非滚动子元素上时，某些内嵌滚动区（如 .plugin-scroll）抢走事件
//   ② 窗口极矮时（docked 520px 高），原生滚动被父容器吃掉
// 只做"往上冒泡找不到滚动容器时，手动滚当前页"，不干预正常滚动。
let __wheelFallbackBound = false;
function bindWheelFallback() {
  if (__wheelFallbackBound) return;
  __wheelFallbackBound = true;
  document.addEventListener('wheel', (event) => {
    // 找到最近的、真正能滚的祖先
    let el = event.target;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 2) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') {
          const before = el.scrollTop;
          el.scrollTop += event.deltaY;
          if (el.scrollTop !== before) { event.preventDefault(); }
          return;
        }
      }
      el = el.parentElement;
    }
    // 都没滚起来 → 手动滚当前页
    const page = document.querySelector('.page.active');
    if (page && page.scrollHeight > page.clientHeight + 2) {
      page.scrollTop += event.deltaY;
      event.preventDefault();
    }
  }, { passive: false });
}

function renderAll() {
    renderFields();
    syncProviderSection('llm');
    syncProviderSection('vision');
    renderReasoning();
    renderCapabilities();
    captureSavedFingerprint();
  }

  // ── 能力注册表 → 设置行（2026-11-16 P1）─────────────────────────────
  // 数据来自主进程 control:capabilities（js/core/capabilities.js 一张表）。
  // 写回：config 类走 control:set-config-value（白名单 + 类型校验 + 原子写盘 + /reload-config）；
  //       plugin 类走已有的 control:set-plugin-enabled。
  // 注意：写回后要同步内存里的 config 和保存指纹，否则下次「保存」会用旧值把它盖回去。
  let capabilityItems = [];

  async function renderCapabilities() {
    const host = $('capability-rows');
    if (!host) return;
    let items;
    try { items = await api.capabilities(); } catch (e) {
      host.innerHTML = `<div class="row"><span class="row-label">注册表读取失败<span class="sub">${escapeHtml(e && e.message || e)}</span></span></div>`;
      return;
    }
    capabilityItems = items || [];
    const groups = [];
    const byGroup = new Map();
    for (const it of capabilityItems) {
      // 已废弃的能力（如 llm.intent_router）声明保留、代码保留，但不再渲染开关：
      // 死开关比没有开关更坏 —— 用户拨了它却什么都不发生。
      if (it.deprecated) continue;
      if (!byGroup.has(it.group)) { byGroup.set(it.group, []); groups.push(it.group); }
      byGroup.get(it.group).push(it);
    }
    host.innerHTML = groups.map((group) => {
      const rows = byGroup.get(group).map(capabilityRowHtml).join('');
      return `<div class="cap-group"><div class="cap-group-head">${escapeHtml(group)}</div>${rows}</div>`;
    }).join('');
    wireCapabilityRows(host);
  }

  function capabilityRowHtml(it) {
    const badges = [];
    if (it.kind === 'config' && it.hot) badges.push('<span class="cap-badge hot">即时</span>');
    if (it.kind === 'config' && !it.hot) badges.push('<span class="cap-badge cold">需重启</span>');
    // 插件开关实际是热的：plugin-manager 监听 enabled_plugins.json 后自动 load/unload
    // （plugin-manager.js:376-388），不该再谎报「重启生效」。hot=false 的才提示重启。
    if (it.kind === 'plugin') badges.push(`<span class="cap-badge ${it.hot ? 'hot' : 'cold'}">${it.hot ? '即时' : '重启生效'}</span>`);
    // soft = config.json 缺省合法（真值可能在 llm_providers.json / 代码默认里），
    // 不再写成「仅默认值」——它和下面的来源标记会互相矛盾。
    if (it.soft) badges.push('<span class="cap-badge soft">配置可缺省</span>');
    // 静态值 vs 运行时值（2026-11-21）：以前只读 config.json 原始值，llm.reasoning /
    // llm.temperature 的真值在 llm_providers.json 的当前模型上 → 永远显示 default。
    // 现在按运行时优先级解析并明确标注来源，用户能看出这个数是从哪来的。
    if (it.kind === 'config' && it.valueSource === 'model') {
      badges.push('<span class="cap-badge" title="真实值来自 llm_providers.json 的当前模型（运行时物化）">运行时·模型</span>');
    } else if (it.kind === 'config' && it.valueSource === 'config') {
      badges.push('<span class="cap-badge" title="值来自 config.json 显式配置">静态·config.json</span>');
    } else if (it.kind === 'config') {
      badges.push('<span class="cap-badge soft" title="config.json 与模型都没写，运行时用代码默认值">默认值</span>');
    }
    const sub = [it.key || (it.port ? ':' + it.port : ''), it.note || ''].filter(Boolean).join(' · ');
    let control = '';
    if (it.kind === 'config') {
      if (typeof it.default === 'boolean') {
        control = `<label class="switch"><input type="checkbox" data-cap-key="${escapeHtml(it.key)}" ${it.value ? 'checked' : ''}><i></i></label>`;
      } else if (Array.isArray(it.choices) && it.choices.length) {
        control = `<select class="cap-select" data-cap-key="${escapeHtml(it.key)}">`
          + it.choices.map((c) => `<option value="${escapeHtml(c)}" ${String(it.value) === String(c) ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')
          + '</select>';
      } else {
        control = `<input class="w-text" data-cap-key="${escapeHtml(it.key)}" data-cap-type="${typeof it.default}" type="${typeof it.default === 'number' ? 'number' : 'text'}" value="${escapeHtml(it.value)}">`;
      }
    } else if (it.kind === 'plugin') {
      control = `<label class="switch"><input type="checkbox" data-cap-plugin="${escapeHtml(it.key)}" ${it.pluginEnabled ? 'checked' : ''}><i></i></label>`;
    } else {
      control = `<span class="cap-readonly">端口 :${it.port}</span>`;
    }
    return `<div class="row cap-row"><span class="row-label">${escapeHtml(it.name)}<span class="sub">${escapeHtml(sub)}</span></span><span class="cap-side">${badges.join('')}${control}</span></div>`;
  }

  // ── 能力页的「即时」必须真即时（2026-11-23）───────────────────────────────
  // 病根：取景/编舞/自动演/穿透/打字框这些键的运行时状态在皮套渲染层里，
  // /reload-config 只让宿主重读 config.json，**不会**把新值下发给正在跑的皮套 →
  // 能力页写着「即时」，实际要重启（同一状态两个入口行为不同）。
  // 现在补上与托盘/总览完全相同的下发通道（8004 代理 eval），同一状态共用同一动作。
  // 返回：undefined=这个键没有运行时下发面；null=桌宠不在线（写盘成功、需重启）；其它=下发结果。
  async function applyCapabilityLive(key, value) {
    const bool = value === true ? 'true' : 'false';
    let js = '';
    if (key === 'ui.petbody_choreo') {
      // 显式 return true：setChoreography 本身返回 undefined，用它的返回值判断会把成功当失败
      js = `(function(){if(!window.petBody||typeof window.petBody.setChoreography!=='function')return false;window.petBody.setChoreography(${bool});return true;})()`;
    } else if (key === 'ui.petbody_perf_auto') {
      js = `(function(){if(!window.petBody||typeof window.petBody.setPerformanceAuto!=='function')return false;window.petBody.setPerformanceAuto(${bool});return true;})()`;
    } else if (key === 'ui.petbody_framing') {
      const mode = value === 'full' ? 'full' : 'half';
      // 与托盘 `{ type: 'framing' }` 落到同一个 renderer.setFraming
      js = `(function(){if(!window.petBody||!window.petBody.renderer||typeof window.petBody.renderer.setFraming!=='function')return false;window.petBody.renderer.setFraming('${mode}');return true;})()`;
    } else if (key === 'ui.click_through_default') {
      // 与托盘同一个专用通道（petbody 对旧通道有总闸，专用通道不会被误锁成永久穿透）
      js = `(function(){try{require('electron').ipcRenderer.send('pet:set-ignore-mouse',{ignore:${bool},options:{forward:true}});return true;}catch(e){return false;}})()`;
    } else if (key === 'ui.show_chat_box') {
      // 与右键「打字框」共用渲染层同一个实现（ui-controller.js 挂到 global）
      js = `(function(){return typeof global.__setChatBoxVisible==='function' ? !!global.__setChatBoxVisible(${bool}) : false;})()`;
    } else if (key === 'tts.muted') {
      // 与托盘 setTtsMuted 下发的是同一段代码（main.js:2115）：置位 + 立刻打断当前播报
      js = `(function(){global.__ttsMuted=${bool};if(${bool}){const t=global.ttsProcessor;if(t&&typeof t.interrupt==='function')t.interrupt();}return true;})()`;
    }
    if (!js) return undefined;
    try { return await petEval(js); } catch (e) { return null; }
  }

  function wireCapabilityRows(host) {
    host.querySelectorAll('[data-cap-key]').forEach((el) => {
      const key = el.dataset.capKey;
      el.addEventListener('change', async () => {
        const meta = capabilityItems.find((x) => x.key === key);
        let value;
        if (el.type === 'checkbox') value = el.checked;
        else if (el.dataset.capType === 'number') {
          const raw = String(el.value ?? '').trim();
          if (raw === '' || !Number.isFinite(Number(raw))) { toast('请输入数字'); return; }
          value = Number(raw);
        } else value = el.value;
        const prev = meta ? meta.value : undefined;
        try {
          const r = await api.setConfigValue(key, value);
          // 2026-11-17 六十六轮：ok:false 有两种，别混成一句「保存失败」
          //   ① 写盘就失败了 → 真失败，回滚 UI
          //   ② 写盘成功、只是宿主没重载（比如宿主没开）→ **盘上已经是新值**，
          //      不该回滚 UI（那会让人以为没保存），要如实说「重启后生效」
          if (!r) throw new Error('保存失败');
          if (r.ok === false) {
            if (r.wrote === true) {
              if (meta) meta.value = value;
              set(config, key, value);
              captureSavedFingerprint();
              // 宿主没重载也要尽力下发：8004 的皮套 eval 与宿主重载是两条独立通道
              applyCapabilityLive(key, value);
              toast(`已写盘，但宿主没重载：${meta ? meta.name : key}（重启桌宠后生效）`);
              // 模型级参数已落盘：重渲染让来源标记从 default 变成「运行时·模型」
              if (r.wroteTo === 'model') await renderCapabilities();
              return;
            }
            throw new Error(r.error || '保存失败');
          }
          if (meta) meta.value = value;
          set(config, key, value);
          captureSavedFingerprint();
          // 2026-11-21：模型级参数（思考等级/采样温度）写穿到 llm_providers.json 的
          // 当前模型；明确告诉用户写到了哪个模型，而不是含糊的「已保存」。
          // 写完重渲染，来源标记由 control:capabilities 重新解析（应为 运行时·模型）。
          if (r.wroteTo === 'model') {
            toast(`已保存：${meta ? meta.name : key}（写入当前模型 ${r.providerId || '?'}/${r.modelId || '?'}，需重启桌宠）`);
            await renderCapabilities();
          } else if (r.wroteTo === 'config' && (r.fallback === true || r.shadowed === true)) {
            toast(`已保存到 config.json：${meta ? meta.name : key}（${r.shadowed ? 'config 里有同名旧键，运行时会优先读它' : '还没有模型通讯录，宿主会自动迁移'}）`);
            await renderCapabilities();
          } else {
            // 有运行时下发面的键：先真下发，再按真实结果说「即时/需重启」，
            // 不再无条件承诺「即时生效」（能力页旧病：号称即时其实要重启）。
            const live = await applyCapabilityLive(key, value);
            const suffix = live === undefined
              ? (meta && meta.hot ? '（即时生效）' : '（需重启桌宠）')
              : live === null
                ? '（已写盘；桌宠不在线，重启后生效）'
                : live === true
                  ? '（已即时生效）'
                  // 皮套在线但当前版本没有这个下发接口（旧包未重启）→ 如实说，不假绿
                  : '（已写盘；当前皮套还没接这个即时开关，重启后生效）';
            toast(`已保存：${meta ? meta.name : key}${suffix}`);
          }
        } catch (e) {
          if (el.type === 'checkbox') el.checked = !!prev;
          else el.value = prev ?? '';
          toast('保存失败：' + (e && e.message || e));
        }
      });
    });
    host.querySelectorAll('[data-cap-plugin]').forEach((el) => {
      el.addEventListener('change', async () => {
        const rel = el.dataset.capPlugin;
        try {
          await api.setPluginEnabled(rel, el.checked);
          // enabled_plugins.json 有文件监听（plugin-manager.js:376-388），宿主在线时热加载/卸载
          toast(`插件「${rel}」已${el.checked ? '加入' : '移出'}启用清单（宿主会热${el.checked ? '加载' : '卸载'}）`);
        } catch (e) {
          el.checked = !el.checked;
          toast('插件开关失败：' + (e && e.message || e));
        }
      });
    });
  }

  // ── 保存链路：改动 → 脏标记 → 保存 → loadConfig 读回校验 → toast ────
  // 2026-11-21 统一管辖的配套：能力页是这批 config 键的唯一入口，而保存回写的是
  // 「打开面板时那份快照」。面板开着期间用户从能力页/托盘改了键（当场写盘），
  // 这里若不先按权威值对齐本地副本，保存别的字段就会把它盖回旧值（典型「控制中心缓存」事故）。
  // 只认 configured=true 的键：缺键合法（运行时默认）的键绝不在这里被实体化。
  async function syncCapabilityOwnedValues() {
    let items = null;
    try { items = await api.capabilities(); } catch (e) { return; }
    for (const it of (items || [])) {
      if (!it || it.kind !== 'config' || !it.key || it.configured !== true) continue;
      if (it.key === 'cost.quiet') continue;   // 静默的唯一真源是 8103，不走 config 回写
      const current = get(config, it.key, undefined);
      if (String(current) !== String(it.value)) set(config, it.key, it.value);
    }
  }

  async function saveConfig() {
    if (pluginConfigDirty) {
      if (!editingPlugin) setPluginConfigDirty(false); // 编辑器已关，没有可保存的插件改动
      else if (!(await savePluginConfig())) return false;
    }
    if (!configDirty) { toast('没有需要保存的修改'); return true; }
    await syncCapabilityOwnedValues();
    const sentModel = $('llm-model').value.trim();
    if (!sentModel) { toast('请先选择或填写对话模型名称'); $('llm-model').focus(); return false; }
    // 引擎参数必须是合法 JSON（运行时解析失败会回落 edge 形状，存之前就拦住）
    const backendParamsRaw = String($('tts-backend-params').value || '').trim();
    if (backendParamsRaw) {
      try { JSON.parse(backendParamsRaw); } catch (e) { toast('引擎参数不是合法 JSON：' + e.message); $('tts-backend-params').focus(); return false; }
    }
    const sentPrompt = $('llm-prompt').value;
    // 2026-11-16：保存前把「本次真正要写的字段」记成清单，保存后整份回读比对
    // （原先只比模型与系统提示词两格，别的字段写丢了、被主进程改写都看不出来）
    // 2026-11-21：只回写和渲染基线不同的字段。旧实现无条件写全部字段，而缺键字段
    // 在 UI 里被渲染成默认值（如 temperature_enabled=false）→ 点保存就把它实体化。
    const specs = {};
    for (const [id, [path, type]] of Object.entries(fields)) specs[id] = { path, type };
    const fieldPlan = planFieldWrites(specs, readFieldState(), baselineFieldState);
    const sentFields = [];
    for (const write of fieldPlan.writes) {
      set(config, write.path, write.value);
      sentFields.push([write.path, write.value]);
    }
    if (fieldPlan.unchanged > 0) {
      // 可观测：保留了哪些「没渲染出真实配置」的键（缺键不被默认值实体化）
      console.info(`[v2] 保存：${fieldPlan.unchanged} 个未改动字段保持原样（不写入 config.json）`);
    }
    // 2026-11-21：ui.show_model / ui.petbody_framing 不再由本页写回 —— 它们只有能力页入口，
    // 能力页 set-config-value 当场写盘；这里再写会拿不到 UI 值（元素已删）而把配置覆盖成默认。
    set(config, 'llm.model', sentModel);
    set(config, 'vision.vision_model.model', $('vision-model').value.trim());
    sentFields.push(['vision.vision_model.model', $('vision-model').value.trim()]);
    if (providerBook.length) config.__llm_providers = providerBook;
    delete config.conversation;
    try {
      const saveResult = await api.saveConfig(config);
      // 2026-11-17 六十二轮：宿主热重载失败必须说出来。
      // 以前主进程把「reloadConfig 未找到」也包成 success:true，用户看到「已保存」，
      // 而宿主还跑着旧 key —— 本次「UI 换 API key 没用」的真实原因之一。
      if (saveResult && saveResult.reload && saveResult.reload.success === false) {
        console.warn('[v2] 已写盘但宿主没重载:', saveResult.reload);
        toast('已写盘，但宿主没重载（改的 key/开关要重启才生效）：' + (saveResult.reload.message || '未知原因'));
        return false;
      }
      // 读回校验：重新 loadConfig，主进程物化 llm.model_id / 通讯录后比对关键字段
      config = await api.loadConfig();
      if (Array.isArray(config.__llm_providers)) {
        providerBook = structuredClone(config.__llm_providers);
        delete config.__llm_providers;
      }
      loadingConfigUi = true;
      renderAll();
      loadingConfigUi = false;
      setConfigDirty(false);
      const backModel = String(get(config, 'llm.model_id', '') || get(config, 'llm.model', '') || '');
      const backPrompt = String(get(config, 'llm.system_prompt', '') || '');
      const mismatches = [];
      if (backModel && backModel !== sentModel) mismatches.push('对话模型');
      if (backPrompt !== sentPrompt) mismatches.push('系统提示词');
      // 整份回读：本次写过的每个字段都要能在磁盘上读回来（空串与缺省等价）
      const emptyish = (v) => v === '' || v === undefined || v === null;
      for (const [path, sent] of sentFields) {
        const back = get(config, path, undefined);
        if (emptyish(sent) && emptyish(back)) continue;
        if (String(sent) !== String(back)) mismatches.push(path + '（回读=' + String(back) + '）');
      }
      if (mismatches.length) {
        console.warn('[v2] 保存读回校验不一致:', mismatches.join('、'), { sentModel, backModel });
        toast('已保存，但读回校验有出入：' + mismatches.join('、'));
        return false;
      }
      toast('配置保存成功');
      return true;
    } catch (error) {
      console.warn('[v2] 保存失败:', error);
      toast(`保存失败：${error.message}`);
      return false;
    }
  }
  $('save-config').addEventListener('click', saveConfig);

  async function confirmUnsavedConfig(title) {
    if (!configDirty && !pluginConfigDirty) return true;
    const choice = await api.confirmUnsavedConfig(title);
    if (choice === 'save') return saveConfig();
    if (choice === 'discard') return true;
    return false;
  }

  api.onCloseRequested(async () => {
    if (closePromptOpen) return;
    closePromptOpen = true;
    try {
      if (await confirmUnsavedConfig('关闭前保存配置')) {
        setConfigDirty(false);
        setPluginConfigDirty(false);
        await api.windowAction('close');
      }
    } finally {
      closePromptOpen = false;
    }
  });

  // ── 记忆页（control:memory）：读不到就明说「读取失败」，绝不拿「暂无记忆」撒谎 ──
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let memoryOk = false;

  async function readMemoryOnce() {
    try {
      const data = await api.memory();
      return (data && data.stats) ? data : null; // stats 拿不到 = 8003 没应答，不能当「没有记忆」
    } catch (error) {
      console.warn('[v2] memory 读取失败:', error);
      return null;
    }
  }

  async function loadMemory() {
    memoryLoaded = true;
    memoryOk = false;
    $('memory-retry').hidden = true;
    $('mem-meta').textContent = '正在读取…';
    let data = await readMemoryOnce();
    if (!data) { await sleep(1200); data = await readMemoryOnce(); } // 主进程超时偏紧，这里补一次重试
    memoryData = data;
    if (!data) { paintMemoryFailed(); return; }
    memoryOk = true;
    paintMemory();
  }

  function paintMemoryFailed() {
    $('mem-count').textContent = '—';
    $('mem-meta').textContent = '读取失败（可重试）';
    $('mem-list').innerHTML = '<p class="mem-empty">记忆读取失败，不是没有记忆；点右上角「重试」。</p>';
    $('digest-list').innerHTML = '<p class="hint" style="margin:8px 0">读取失败</p>';
    $('core-memory').textContent = '（读取失败）';
    $('memory-retry').hidden = false;
  }
  $('memory-retry').addEventListener('click', loadMemory);
  $('memory-refresh').addEventListener('click', loadMemory);

  function fmtTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function memListHtml() {
    const items = (memoryData && memoryData.items || []).slice()
      .sort((a, b) => String(b.timestamp || b.created_at || '').localeCompare(String(a.timestamp || a.created_at || '')));
    const query = ($('mem-search').value || '').trim().toLowerCase();
    const filtered = query
      ? items.filter(item => [item.content, item.text, (item.tags || []).join(' ')].join(' ').toLowerCase().includes(query))
      : items;
    if (!filtered.length) return `<p class="mem-empty">${query ? '无匹配' : '暂无记忆'}</p>`;
    return filtered.map(item => {
      const text = item.content || item.text || '';
      const tags = (Array.isArray(item.tags) && item.tags.length) ? `<span class="tags">${escapeHtml(item.tags.join(' '))}</span>` : '';
      return `<div class="mem-item"><time>${escapeHtml(fmtTime(item.timestamp || item.created_at))}</time>${escapeHtml(text)}${tags}</div>`;
    }).join('');
  }

  function digestHtml(markdown) {
    const out = [];
    let listOpen = false;
    for (const rawLine of String(markdown || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^#\s/.test(line)) continue;
      if (/^##\s/.test(line)) {
        if (listOpen) { out.push('</ul>'); listOpen = false; }
        out.push(`<div class="digest-time">${escapeHtml(line.replace(/^##\s*/, ''))}</div>`);
        continue;
      }
      if (/^[-*]\s/.test(line)) {
        if (!listOpen) { out.push('<ul>'); listOpen = true; }
        out.push(`<li>${escapeHtml(line.replace(/^[-*]\s*/, ''))}</li>`);
        continue;
      }
      if (listOpen) { out.push('</ul>'); listOpen = false; }
      out.push(`<p>${escapeHtml(line.replace(/\*\*/g, ''))}</p>`);
    }
    if (listOpen) out.push('</ul>');
    return out.join('');
  }

  function digestLabel(fileName) {
    const match = String(fileName).match(/(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日` : String(fileName).replace(/\.md$/i, '');
  }

  function paintMemory() {
    const data = memoryData;
    if (!data) return;
    const stats = data.stats || null;
    $('mem-count').textContent = String((stats && stats.total_count) ?? (data.items || []).length ?? 0);
    if (!stats) {
      $('mem-meta').textContent = '读取失败（可重试）';
    } else {
      const bits = [];
      if (stats.storage_type) bits.push('向量检索已启用');
      bits.push('图谱' + (stats.graph_enabled ? '开' : '关'));
      if (stats.today_count) bits.push('今日 +' + stats.today_count);
      $('mem-meta').textContent = bits.join('，');
    }
    $('mem-list').innerHTML = memListHtml();
    $('digest-list').innerHTML = (data.digests || []).map((digest, index) =>
      `<details class="digest"${index === 0 ? ' open' : ''}><summary>${escapeHtml(digestLabel(digest.file))}</summary><div class="digest-body">${digestHtml(digest.content)}</div></details>`
    ).join('') || '<p class="hint" style="margin:8px 0">暂无整理日志</p>';
    $('core-memory').textContent = data.core || '（暂无）';
  }
  $('mem-search').addEventListener('input', () => { if (memoryOk && memoryData) $('mem-list').innerHTML = memListHtml(); });

  // ── 记忆页「图谱」小块：nodes/edges 由主进程归一化好（control:memory 的 graph 字段，同源 control:memory-graph），
  // 这里手写 SVG 力导布局，无第三方库；节点点击弹出该实体的来源记忆文本；数据空时明示「图谱为空」不白屏 ──
  // 古董画框暖系：黄铜的明暗差区分类型，object 保留橄榄绿；全表禁青蓝
  const GRAPH_TYPE_COLORS = {
    person: '#f7ecc8',       // 黄铜高光 (Brass Highlight)
    event: '#d9bd72',        // 黄铜主色 (Brass)
    object: '#8aa864',       // 橄榄绿 (Olive Green)
    place: '#8f7024',        // 黄铜暗部 (Brass Shadow)
    time: '#a8842c',         // 陈年铜 (Aged Copper)
    concept: '#b8912f',      // 亮铜 (Bright Copper)
    organization: '#7a5c18', // 深棕铜 (Deep Umber Brass)
    preference: '#c9a86a',   // 淡铜 (Pale Brass)
  };
  let memoryGraph = null; // 最近一次画出的图数据（节点点击弹窗时取 text 用）

  function graphNodeRadius(node, degree) {
    const base = 4 + Math.min(10, (Number(node.count) || 1) * 0.6);
    return Math.min(14, base + Math.min(4, degree * 0.5));
  }

  // 手写力导：库仑斥力 + 边弹簧，固定 220 轮定稿（静态图不动画，60 节点毫秒级）
  function graphLayout(nodes, edges) {
    const W = 660, H = 400, N = nodes.length;
    const pts = nodes.map((n, i) => {
      const angle = (i / N) * Math.PI * 2;
      return { x: W / 2 + Math.cos(angle) * H * 0.3, y: H / 2 + Math.sin(angle) * H * 0.3, vx: 0, vy: 0 };
    });
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    const springs = [];
    edges.forEach((e) => {
      const a = idx.get(e.source), b = idx.get(e.target);
      if (a != null && b != null) springs.push([a, b]);
    });
    for (let step = 0; step < 220; step++) {
      for (let i = 0; i < N; i++) {
        const p = pts[i];
        for (let j = i + 1; j < N; j++) {
          const q = pts[j];
          let dx = p.x - q.x, dy = p.y - q.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = 0.5 + (i % 5) * 0.1; dy = 0.5 + (j % 5) * 0.1; d2 = dx * dx + dy * dy; } // 重合时给个伪距离防除零
          const f = 2400 / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          p.vx += fx; p.vy += fy; q.vx -= fx; q.vy -= fy;
        }
      }
      springs.forEach(([i, j]) => {
        const p = pts[i], q = pts[j];
        const dx = q.x - p.x, dy = q.y - p.y;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const f = 0.02 * (d - 78);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        p.vx += fx; p.vy += fy; q.vx -= fx; q.vy -= fy;
      });
      pts.forEach((p) => {
        p.vx *= 0.8; p.vy *= 0.8;
        p.x += Math.max(-9, Math.min(9, p.vx));
        p.y += Math.max(-9, Math.min(9, p.vy));
        p.x = Math.max(36, Math.min(W - 36, p.x));
        p.y = Math.max(28, Math.min(H - 28, p.y));
      });
    }
    return { W, H, pts, idx };
  }

  function paintMemoryGraph(data) {
    const view = $('memory-graph-view');
    const note = $('memory-graph-note');
    const graph = (data && Array.isArray(data.nodes) && data.nodes.length) ? data : null;
    memoryGraph = graph;
    if (!graph) {
      // 数据空时明确写「图谱为空」，不白屏也不假装在加载
      note.hidden = true;
      view.innerHTML = `<p class="mem-empty">${(data && data.mode === 'error') ? '图谱拉取失败，可再点一次「图谱」重试' : '图谱为空'}</p>`;
      return;
    }
    const degree = new Map();
    graph.edges.forEach((e) => {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    });
    const { W, H, pts, idx } = graphLayout(graph.nodes, graph.edges);
    const lines = graph.edges.map((e) => {
      const s = pts[idx.get(e.source)], t = pts[idx.get(e.target)];
      if (!s || !t) return '';
      return `<line x1="${s.x.toFixed(1)}" y1="${s.y.toFixed(1)}" x2="${t.x.toFixed(1)}" y2="${t.y.toFixed(1)}" stroke="rgba(232, 207, 138, 0.28)" stroke-width="1.2" stroke-opacity="0.85"><title>${escapeHtml(e.label || '相关')}</title></line>`;
    }).join('');
    const circles = graph.nodes.map((n, i) => {
      const p = pts[i];
      const r = graphNodeRadius(n, degree.get(n.id) || 0);
      const color = GRAPH_TYPE_COLORS[n.type] || '#7e6e52';
      const short = String(n.label || '').length > 9 ? String(n.label).slice(0, 8) + '…' : String(n.label || '');
      return `<g data-graph-node="${i}" style="cursor:pointer"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.9" stroke="rgba(12, 8, 5, 0.95)" stroke-width="2"><title>${escapeHtml(n.label)}（${escapeHtml(n.type || '未知类型')}，来源记忆 ${n.count || 0} 条）</title></circle><text x="${p.x.toFixed(1)}" y="${(p.y + r + 11).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="500" fill="#bfa87f">${escapeHtml(short)}</text></g>`;
    }).join('');
    view.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="记忆图谱" style="width:100%;height:auto;display:block;background:rgba(13, 9, 6, 0.95);border:1px solid rgba(232, 207, 138, 0.22);border-radius:3px;box-shadow:inset 0 0 28px rgba(0,0,0,0.6)"><g>${lines}</g><g>${circles}</g></svg>`;
    if (graph.note) { note.textContent = graph.note; note.hidden = false; } else { note.hidden = true; }
    view.querySelectorAll('g[data-graph-node]').forEach((g) => {
      g.addEventListener('click', () => {
        const node = memoryGraph && memoryGraph.nodes[Number(g.dataset.graphNode)];
        if (node) openGraphDetail(node);
      });
    });
  }

  function openGraphDetail(node) {
    const color = GRAPH_TYPE_COLORS[node.type] || '#7e6e52';
    const meta = `${node.type || '未知类型'}${node.count ? ` · 来源记忆 ${node.count} 条` : ''}`;
    const text = String(node.text || node.label || '（无文本）');
    $('memory-graph-detail').innerHTML =
      `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(232,207,138,0.18)"><span style="width:12px;height:12px;border-radius:50%;background:${color};box-shadow:0 0 8px ${color};flex:none"></span><strong style="font-size:15px;color:#f2e6c8">${escapeHtml(node.label || '')}</strong><span class="kn-badge fresh" style="margin:0">${escapeHtml(meta)}</span></div><div style="font-size:13px;line-height:1.75;white-space:pre-wrap;color:var(--ink-2);overflow-wrap:anywhere">${escapeHtml(text)}</div>`;
    $('memory-graph-modal').classList.add('open');
    $('memory-graph-detail-close').focus();
  }

  function closeGraphDetail() { $('memory-graph-modal').classList.remove('open'); }

  async function pullMemoryGraph() {
    const view = $('memory-graph-view');
    try {
      view.innerHTML = '<p class="hint" style="margin:8px 0">正在拉取图谱…</p>';
      // 走 control:memory 附带的 graph 字段（preload 未透传具名通道 control:memory-graph，见 control-main.js 注释）
      const fresh = await api.memory();
      if (!fresh || typeof fresh !== 'object' || !('graph' in fresh)) {
        view.innerHTML = '<p class="mem-empty">主进程未提供图谱数据：请完全退出控制中心后重开再试</p>';
        return;
      }
      paintMemoryGraph(fresh.graph);
    } catch (error) {
      console.error('[v2] 图谱拉取失败:', error);
      paintMemoryGraph({ mode: 'error', nodes: [], edges: [] });
    }
  }
  $('memory-graph-btn').addEventListener('click', pullMemoryGraph);
  $('memory-graph-detail-close').addEventListener('click', closeGraphDetail);
  $('memory-graph-modal').addEventListener('click', event => { if (event.target === $('memory-graph-modal')) closeGraphDetail(); });

  // ── 记忆体检（B3，2026-11-23）：只读一致性报告 ────────────────────────────
  // 主进程跑 `memos-consistency.mjs --json`（不带 --fix）。这里只负责把真实计数画出来；
  // 失败必须显示原因（脚本不存在 / 超时 / 8003 没响应 / 输出不是 JSON），不许静默成「正常」。
  const MEMOS_FIX_CMD = 'node pet-runtime/tools/memos-consistency.mjs --fix';
  function fmtMemHealth(report) {
    const lines = [];
    const s = report.summary || {};
    const vec = report.vector || {};
    const vs = vec.stats || {};
    const graph = report.graph || {};
    const bm25 = report.bm25 || {};
    const mark = (ok) => ok === true ? '✓' : (ok === false ? '✗' : '?');
    lines.push(`结论：${s.consistent === true ? '一致' : '发现不一致'}（硬问题 ${Number(s.hard_issue_count) || 0} · 提醒 ${Number(s.warning_count) || 0}）`);
    lines.push(`向量：可用 ${mark(vec.available)} · 总数 ${vs.total ?? '?'}（raw ${vs.raw_points ?? '?'} / archived ${vs.archived ?? 0} / deleted ${vs.deleted ?? 0}）`);
    lines.push(`图谱：${graph.available === false ? '不可用' : '可用'} · 实体 ${graph.entity_count ?? '?'} · 关系 ${graph.relation_count ?? '?'} · 死引用 ${graph.dead_reference_count ?? '?'}`);
    lines.push(`BM25：${bm25.available === false ? '不可用' : '可用'} · 命中 ${bm25.hit ?? '?'}/${bm25.tested ?? '?'}${bm25.note ? '（' + bm25.note + '）' : ''}`);
    const issues = Array.isArray(report.issues) ? report.issues : [];
    if (issues.length) {
      lines.push('', `问题（前 ${Math.min(issues.length, 5)} 条，共 ${issues.length} 条）：`);
      for (const it of issues.slice(0, 5)) {
        const text = typeof it === 'string' ? it : (it.detail || it.message || it.kind || JSON.stringify(it));
        lines.push('  · ' + String(text).slice(0, 200));
      }
    }
    lines.push('', '修复命令（只读体检不会自动修，确认后可手动执行）：', MEMOS_FIX_CMD);
    return lines.join('\n');
  }

  async function runMemoryHealth() {
    const btn = $('memory-health-btn');
    const out = $('memory-health-out');
    const fix = $('memory-health-fix');
    if (!btn || !out) return;
    btn.disabled = true;
    btn.textContent = '体检中…';
    out.hidden = false;
    out.textContent = '正在核对向量 / 图谱 / BM25…（8003 不在线时会等超时）';
    if (fix) fix.hidden = true;
    try {
      const res = await api.memoryConsistency();
      if (!res || res.ok !== true) {
        out.textContent = '体检失败：' + String((res && res.error) || '未知原因')
          + (res && res.detail ? '\n\n' + String(res.detail) : '');
        return;
      }
      out.textContent = fmtMemHealth(res.report || {});
      if (fix) fix.hidden = false;
    } catch (e) {
      out.textContent = '体检失败：' + String((e && e.message) || e);
    } finally {
      btn.disabled = false;
      btn.textContent = '开始体检';
    }
  }

  async function copyMemFixCmd() {
    const text = MEMOS_FIX_CMD;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        toast('修复命令已复制');
        return;
      }
    } catch (e) { /* file:// 下可能被拒，走 execCommand 兜底 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      toast(ok ? '修复命令已复制' : '复制失败：请手动选中命令');
    } catch (e) { toast('复制失败：请手动选中命令'); }
  }

  if ($('memory-health-btn')) $('memory-health-btn').addEventListener('click', runMemoryHealth);
  if ($('memory-health-copy')) $('memory-health-copy').addEventListener('click', copyMemFixCmd);

  // ── 插件页（listPlugins / setPluginEnabled / savePluginConfig / 广场）──
  let pluginData = { builtIn: [], community: [], market: [] };
  let editingPlugin = null;
  let recentlyInstalledPluginPath = null;
  let dlcButton = null;
  api.onDlcProgress(text => {
    if (!dlcButton) return;
    const match = String(text).match(/(\d+)%/);
    dlcButton.textContent = text === 'extracting' ? '解压中' : (match ? (match[1] === '100' ? '解压中' : `下载 ${match[1]}%`) : dlcButton.textContent);
  });

  // 描述里的开发者黑话不上屏：安装命令、内部包名、工具函数名、上游模板占位符收掉/翻译，原文留 title
  function friendlyDesc(text) {
    return String(text || '')
      .replace(/插件目录需[^。；.]*[。.]?/g, '')
      .replace(/（chinese-workday）/g, '（按工作日历）')
      .replace(/，?提供 execute_code ?\/ ?install_packages 工具/g, '')
      .replace(/，?提供 execute_code 工具/g, '')
      .replace(/\[英文单动作\]/g, '英文指令')
      .replace(/，?替代 dynamic-persona[^。]*。?/g, '')
      .replace(/LLM/g, '对话模型')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  const AUTHOR_LABELS = { official: '内置', community: '社区', 'pet-runtime': '皮套自带' };

  function pluginRow(plugin) {
    const dlcInstalled = !plugin.downloadDlc || plugin.dlcInstalled;
    const desc = friendlyDesc(plugin.description) || '暂无说明';
    const meta = AUTHOR_LABELS[plugin.author] || plugin.author || '';
    return `<div class="plugin-row" data-plugin-card="${escapeHtml(plugin.relPath)}" title="${escapeHtml(plugin.description || '')}">
      <div class="plugin-main">
        <strong>${escapeHtml(plugin.displayName)}</strong>
        <p>${escapeHtml(desc)}</p>
        <small>${escapeHtml(meta)}</small>
      </div>
      <div class="plugin-actions">
        ${plugin.downloadDlc && !dlcInstalled ? `<button class="btn small" type="button" data-plugin-dlc="${escapeHtml(plugin.relPath)}">下载模型</button>` : ''}
        ${plugin.bat && dlcInstalled ? `<button class="btn small" type="button" data-plugin-launch="${escapeHtml(plugin.relPath)}">启动</button>` : ''}
        ${plugin.hasConfig ? `<button class="btn small" type="button" data-plugin-config="${escapeHtml(plugin.relPath)}">配置</button>` : ''}
        ${!plugin.hasConfig && plugin.hasReadme ? `<button class="btn small" type="button" data-plugin-config="${escapeHtml(plugin.relPath)}">使用教程</button>` : ''}
      </div>
    </div>`;
  }

  function marketRow(plugin) {
    const installed = pluginData.community.find(item => item.name === plugin.id);
    if (!installed) {
      const desc = friendlyDesc(plugin.desc) || '暂无说明';
      const meta = AUTHOR_LABELS[plugin.author] || plugin.author || '';
      return `<div class="plugin-row" data-market-card="${escapeHtml(plugin.id)}" title="${escapeHtml(plugin.desc || '')}">
        <div class="plugin-main"><strong>${escapeHtml(plugin.display_name || plugin.id)}</strong><p>${escapeHtml(desc)}</p><small>${escapeHtml(meta)}</small></div>
        <div class="plugin-actions">
          ${plugin.repo ? `<button class="btn small" type="button" data-plugin-repo="${escapeHtml(plugin.repo)}">仓库</button>` : ''}
          <button class="btn small" type="button" data-plugin-install="${escapeHtml(plugin.id)}">安装</button>
        </div>
      </div>`;
    }
    const desc = friendlyDesc(installed.description || plugin.desc) || '暂无说明';
    const meta = AUTHOR_LABELS[installed.author || plugin.author] || installed.author || plugin.author || '';
    return `<div class="plugin-row" data-plugin-card="${escapeHtml(installed.relPath)}" data-market-card="${escapeHtml(plugin.id)}">
      <div class="plugin-main"><strong>${escapeHtml(installed.displayName || plugin.display_name || plugin.id)}</strong><p>${escapeHtml(desc)}</p><small>${escapeHtml(meta)}</small></div>
      <div class="plugin-actions">
        ${plugin.repo ? `<button class="btn small" type="button" data-plugin-repo="${escapeHtml(plugin.repo)}">仓库</button>` : ''}
        <span class="plugin-installed">已安装</span>
      </div>
    </div>`;
  }

  function renderPlugins() {
    // body-actions 是演出/动作链路的底座，置顶（沿用 v1 排序语义）
    const isPinned = plugin => plugin.name === 'body-actions' || plugin.relPath === 'community/body-actions';
    const installed = [...pluginData.builtIn, ...pluginData.community]
      .map((plugin, index) => ({ plugin, index }))
      .sort((a, b) => Number(isPinned(b.plugin)) - Number(isPinned(a.plugin))
        || Number(b.plugin.enabled) - Number(a.plugin.enabled)
        || Number(b.plugin.relPath === recentlyInstalledPluginPath) - Number(a.plugin.relPath === recentlyInstalledPluginPath)
        || String(a.plugin.displayName || a.plugin.name).localeCompare(String(b.plugin.displayName || b.plugin.name), 'zh-CN')
        || a.index - b.index)
      .map(item => item.plugin);
    const installedIds = new Set(pluginData.community.map(plugin => plugin.name));
    const market = pluginData.market.slice().sort((a, b) =>
      Number(installedIds.has(b.id)) - Number(installedIds.has(a.id))
      || String(a.display_name || a.id).localeCompare(String(b.display_name || b.id), 'zh-CN'));
    $('installed-plugin-list').innerHTML = installed.map(pluginRow).join('') || '<p class="hint" style="margin:10px 0">暂无已安装插件</p>';
    $('market-plugin-list').innerHTML = market.map(marketRow).join('') || '<p class="hint" style="margin:10px 0">插件广场暂无内容</p>';
  }

  async function loadPlugins() {
    try {
      pluginData = await api.listPlugins();
      if (editingPlugin) {
        const fresh = [...pluginData.builtIn, ...pluginData.community].find(item => item.relPath === editingPlugin.relPath);
        if (!fresh) closePluginEditor();
      }
      if (!$('plugin-editor').hidden && editingPlugin) {
        const fresh = [...pluginData.builtIn, ...pluginData.community].find(item => item.relPath === editingPlugin.relPath);
        if (fresh) { editingPlugin = fresh; paintPluginEditorMeta(); }
      }
      renderPlugins();
    } catch (error) {
      console.warn('[v2] 插件列表读取失败:', error);
      toast('插件列表读取失败：' + error.message);
    }
  }

  function paintPluginEditorMeta() {
    $('plugin-detail-title').textContent = editingPlugin.displayName;
    $('plugin-readme').hidden = !editingPlugin.hasReadme;
  }

  function openPluginEditor(plugin) {
    editingPlugin = plugin;
    $('plugin-lists').hidden = true;
    $('plugin-editor').hidden = false;
    paintPluginEditorMeta();
    $('plugin-detail-content').innerHTML = `<div class="plugin-config-form">`
      + '<p class="hint">插件启停请到「外观 → 能力」页管理。</p>'
      + `${configFields(plugin.config, '', new Set(plugin.maskedKeys || []))}</div>`;

  }
  function closePluginEditor() {
    editingPlugin = null;
    $('plugin-editor').hidden = true;
    $('plugin-lists').hidden = false;
    $('plugin-detail-content').innerHTML = '';
  }

  function configFields(definitions, prefix = '', maskedPaths = null) {
    let html = '';
    for (const [key, definition] of Object.entries(definitions || {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      // 2026-11-21：顶层 enabled 已废弃（启停唯一入口是能力页），不再渲染；
      // 保存时 cloned config 里仍带着它，磁盘原值不会被删。
      if (isDeprecatedPluginConfigKey(path)) continue;
      if (definition && typeof definition === 'object' && definition.type === 'object' && definition.fields) {

        html += `<div class="plugin-config-group"><h3>${escapeHtml(definition.title || key)}</h3>${definition.description ? `<p>${escapeHtml(definition.description)}</p>` : ''}${configFields(definition.fields, path, maskedPaths)}</div>`;
        continue;
      }
      const schema = definition && typeof definition === 'object' && 'type' in definition;
      const type = schema ? definition.type : typeof definition;
      const value = schema ? (definition.value ?? definition.default ?? '') : definition;
      const title = schema ? (definition.title || key) : key;
      const description = schema ? (definition.description || '') : '';
      // 凭据类字段服务端只回掩码：不把 *** 填进输入框（用户会以为是真 key），
      // 改成空值 + 占位提示；留空提交 = 服务端保留磁盘原值。
      const masked = Boolean(maskedPaths && maskedPaths.has(path)) && !['boolean', 'bool', 'number', 'integer', 'int', 'float'].includes(type);
      const shown = masked ? '' : value;
      const maskHint = masked ? ' placeholder="已设置，留空=保留原值"' : '';
      if (type === 'boolean' || type === 'bool') {
        html += `<label class="plugin-config-check"><span>${escapeHtml(title)}</span><input data-plugin-field="${escapeHtml(path)}" data-field-type="boolean" type="checkbox" ${value ? 'checked' : ''}></label>`;
      } else if (type === 'text' || type === 'textarea') {
        html += `<label>${escapeHtml(title)}<textarea data-plugin-field="${escapeHtml(path)}" data-field-type="string" rows="4" spellcheck="false"${maskHint}>${escapeHtml(shown)}</textarea>${description ? `<small>${escapeHtml(description)}</small>` : ''}</label>`;
      } else {
        const numeric = ['number', 'integer', 'int', 'float'].includes(type);
        html += `<label>${escapeHtml(title)}<input data-plugin-field="${escapeHtml(path)}" data-field-type="${numeric ? 'number' : 'string'}" ${numeric ? 'type="number"' : ''} value="${escapeHtml(shown)}"${maskHint} spellcheck="false">${description ? `<small>${escapeHtml(description)}</small>` : ''}</label>`;
      }
    }
    return html;
  }

  async function savePluginConfig() {
    if (!editingPlugin) return true;
    const updated = structuredClone(editingPlugin.config);
    let invalidField = '';
    document.querySelectorAll('#plugin-detail-content [data-plugin-field]').forEach(field => {
      if (invalidField) return;
      const keys = field.dataset.pluginField.split('.');
      const leaf = keys.pop();
      let target = updated;
      for (const key of keys) target = target[key]?.fields || target[key] || (target[key] = {});
      const value = field.dataset.fieldType === 'boolean' ? field.checked
        : field.dataset.fieldType === 'number' ? Number(field.value)
        : field.value;
      if (field.dataset.fieldType === 'number' && !Number.isFinite(value)) { invalidField = field.dataset.pluginField; return; }
      if (target[leaf] && typeof target[leaf] === 'object' && 'type' in target[leaf]) target[leaf].value = value;
      else target[leaf] = value;
    });
    if (invalidField) { toast(`${invalidField} 必须是数字`); return false; }
    try {
      await api.savePluginConfig(editingPlugin.type, editingPlugin.name, updated);
      editingPlugin.config = updated;
      setPluginConfigDirty(false);
      toast('插件配置已保存');
      return true;
    } catch (error) {
      console.warn('[v2] 插件配置保存失败:', error);
      toast(`插件配置保存失败：${error.message}`);
      return false;
    }
  }

  $('plugins').addEventListener('click', async event => {
    const tab = event.target.closest('[data-plugin-tab]');
    if (tab) {
      $('plugins').querySelectorAll('[data-plugin-tab]').forEach(button => {
        const active = button === tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      $('installed-plugin-list').hidden = tab.dataset.pluginTab !== 'installed';
      $('market-plugin-list').hidden = tab.dataset.pluginTab !== 'market';
      return;
    }
    const configButton = event.target.closest('[data-plugin-config]');
    if (configButton) {
      const plugin = [...pluginData.builtIn, ...pluginData.community].find(item => item.relPath === configButton.dataset.pluginConfig);
      if (plugin) openPluginEditor(plugin);
      return;
    }
    const dlc = event.target.closest('[data-plugin-dlc]');
    if (dlc) {
      const plugin = [...pluginData.builtIn, ...pluginData.community].find(item => item.relPath === dlc.dataset.pluginDlc);
      if (!plugin) return;
      dlcButton = dlc;
      dlc.disabled = true;
      dlc.textContent = '准备安装';
      const result = await api.installPluginDlc(plugin.name, plugin.downloadDlc).catch(error => ({ ok: false, message: error.message }));
      dlcButton = null;
      dlc.textContent = result.ok ? '已安装' : '安装失败';
      toast(result.message);
      await loadPlugins();
      return;
    }
    const launch = event.target.closest('[data-plugin-launch]');
    if (launch) {
      const plugin = [...pluginData.builtIn, ...pluginData.community].find(item => item.relPath === launch.dataset.pluginLaunch);
      if (!plugin) return;
      const result = await api.launchPluginBat(plugin.name, plugin.bat).catch(error => ({ message: error.message }));
      toast(result.message);
      return;
    }
    const repo = event.target.closest('[data-plugin-repo]');
    if (repo) {
      if (repo.dataset.pluginRepo) api.openExternal(repo.dataset.pluginRepo);
      return;
    }
    const install = event.target.closest('[data-plugin-install]');
    if (install) {
      const plugin = pluginData.market.find(item => item.id === install.dataset.pluginInstall);
      if (!plugin) return;
      install.disabled = true;
      install.textContent = '安装中';
      const result = await api.installPlugin(plugin.id, plugin.repo).catch(error => ({ ok: false, message: error.message }));
      toast(result.message);
      await loadPlugins();
      if (result.ok) {
        const fresh = pluginData.community.find(item => item.name === plugin.id);
        recentlyInstalledPluginPath = fresh?.relPath || null;
        renderPlugins();
        $('plugins').querySelector('[data-plugin-tab="installed"]')?.click();
      }
      return;
    }
    if (event.target.closest('#plugin-detail-back')) { closePluginEditor(); return; }
    if (event.target.closest('#plugin-readme')) {
      if (!editingPlugin) return;
      const readme = await api.readPluginReadme(editingPlugin.type, editingPlugin.name).catch(() => '');
      $('plugin-readme').hidden = true;
      $('plugin-detail-content').innerHTML = `<div class="plugin-readme-text">${renderPluginMarkdown(readme)}</div>`;
      $('plugin-detail-content').querySelectorAll('a[href]').forEach(link => link.addEventListener('click', e => {
        e.preventDefault();
        api.openExternal(link.href);
      }));
    }
  });

  // 2026-11-21 统一管辖：插件页 = 市场（安装/配置/README），不再有每行启停开关。
  // 启停只留能力页（data-cap-plugin → api.setPluginEnabled），两处同一状态源，避免「两个开关各说各话」。

  $('refresh-plugins').addEventListener('click', async () => {
    const button = $('refresh-plugins');
    button.disabled = true;
    button.textContent = '刷新中';
    try {
      pluginData = await api.refreshPluginMarket();
      renderPlugins();
      toast(`插件广场已更新，共 ${pluginData.market.length} 个插件`);
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = '刷新广场';
    }
  });
  api.onPluginsChanged(() => loadPlugins());

  function renderPluginMarkdown(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const inline = text => escapeHtml(text)
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    const isBlockStart = (line, next = '') => /^\s*$|^```|^#{1,6}\s+|^\s*([-*+] |\d+\. )|^>\s?|^\s*([-*_])(?:\s*\2){2,}\s*$/.test(line)
      || (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(next));
    const out = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = line.match(/^```\s*([\w-]*)/);
      if (fence) {
        const code = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
        if (i < lines.length) i++;
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) { out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i++; continue; }
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
        const splitRow = row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
        const headers = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
        out.push(`<table><thead><tr>${headers.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, index) => `<td>${inline(row[index] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      const listMatch = line.match(/^\s*([-*+]|\d+\.)\s+(.+)$/);
      if (listMatch) {
        const ordered = /\d+\./.test(listMatch[1]);
        const items = [];
        while (i < lines.length) {
          const match = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.+)$/);
          if (!match || /\d+\./.test(match[1]) !== ordered) break;
          items.push(`<li>${inline(match[2])}</li>`);
          i++;
        }
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      if (/^>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
        continue;
      }
      const paragraph = [line.trim()];
      i++;
      while (i < lines.length && !isBlockStart(lines[i], lines[i + 1] || '')) paragraph.push(lines[i++].trim());
      out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  // ── 皮套页：自查 / 一起看 / 演出六段（纯本地，照 v1 直戳 8103/8004）──
  async function probeJson(url, label, lines) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) { lines.push(label + '：HTTP ' + response.status); return null; }
      return await response.json();
    } catch (error) {
      lines.push(label + '：连不上（' + (error && error.message || error) + '）');
      return null;
    }
  }

  $('petbody-probe').addEventListener('click', async () => {
    const box = $('petbody-status');
    box.textContent = '正在自查…';
    const lines = [];
    const state = await probeJson('http://127.0.0.1:8103/state', '渲染通道', lines);
    if (state) lines.push('渲染通道：' + (state.ok ? '在线' : '异常') + (state.model ? '，模型 ' + state.model : ''));
    const bounds = await probeJson('http://127.0.0.1:8004/bounds', '自检通道', lines);
    if (bounds && bounds.bounds) {
      lines.push('窗口：' + bounds.bounds.width + '×' + bounds.bounds.height + ' @(' + bounds.bounds.x + ',' + bounds.bounds.y + ')');
      lines.push('鼠标穿透：' + (bounds.ignoreMouse ? '是（点不穿）' : '否（可交互）'));
      lines.push('置顶：' + (bounds.alwaysOnTop ? '是' : '否'));
    }
    const emotion = await probeJson('http://127.0.0.1:8103/emotion', '情绪', lines);
    if (emotion) lines.push('当前情绪：' + (emotion.emotion || '?') + (emotion.remainingMs ? '（还剩 ' + Math.round(emotion.remainingMs) + 'ms）' : ''));
    box.textContent = lines.length ? lines.join('\n') : '自查通道都没连上，先确认桌宠在运行。';
  });

  async function petEval(js) {
    // 统一走 control:petbody-eval（8004 代理），错误带原因上 toast，不静默；
    // 主进程侧超时 10s，这里 3s 就判不在线，避免界面挂着等
    const result = await Promise.race([
      api.petbodyEval(js),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, error: '桌宠不在线' }), 3000))
    ]);
    if (!result || result.ok !== true) throw new Error((result && result.error) || '桌宠不在线');
    return result.value;
  }

  // ── 装扮与形态：petBody 存在则用 petBody.*，否则回落 petAssetsBridge ──
  const ASSET_GROUPS = [
    ['服饰', [['clothes-skirt', '长短裙', 1], ['clothes-chest', '胸口衣服', 0], ['clothes-shoes', '脱鞋', 0], ['clothes-tail', '尾巴', 1]]],
    ['眼镜', [['glasses-frame', '黑框眼镜', 0], ['glasses-monocle', '单片眼镜', 0]]],
    ['头饰', [['headwear-pot', '大钢盆', 0]]],
    ['手势', [['gesture-grass', '狗尾草', 0], ['gesture-chest', '抚胸', 0], ['gesture-finger', '竖食指', 0]]],
    ['表情件', [['face-black', '黑脸', 0], ['face-tears', '落泪', 0], ['eyes-dizzy', '圈圈眼', 0], ['eyes-heart', '爱心眼', 0], ['eyes-squint', '眯眯眼', 0], ['eyes-smug', '屑屑眼', 0], ['face-blush', '脸红', 0], ['face-loading', '转圈圈', 0], ['face-fang', '大牙', 0], ['face-sweat', '流冷汗', 0]]]
  ];
  const PRESETS = [['maid', '女仆装'], ['home', '居家'], ['show', '演出'], ['slack', '摸鱼']];
  const FORMS = [['big', '大鱼'], ['mid', '中鱼'], ['small', '小鱼']];
  // 皮套内部把档位记成 0/1/2（默认 0=中鱼），字符串档位按队长契约直设
  // form-size 的 value 是参数值（big=0 / mid=0.4 / small=1，见 asset-toggles 注册表），
  // 不是档位序号——之前 ['mid','big','small'] 把默认值 0 错映成中鱼（注册表默认 0=大鱼）。
  const FORM_VALUE_MAP = { '0': 'big', '0.4': 'mid', '1': 'small' };
  let dressupOnline = false;

  async function readDressupState() {
    const raw = await petEval(`JSON.stringify((function(){
      // 资产真源是 petAssetsBridge（petBody.snapshot 是演出快照，没有 assets 字段——
      // 先走它的话 assets 恒空、paintDressup 永远画默认，看起来「点了没反应」）
      if (window.petAssetsBridge && window.petAssetsBridge.state) return { src: 'bridge', assets: window.petAssetsBridge.state() || {}, preset: (window.petAssetsBridge.currentPreset && window.petAssetsBridge.currentPreset()) || null };
      if (window.petBody && window.petBody.snapshot) { var s = window.petBody.snapshot(); return { src: 'petBody', assets: (s && s.assets) || {}, preset: (s && s.preset) || null }; }
      return { src: 'none', assets: {}, preset: null };
    })())`);
    return JSON.parse(raw || '{}');
  }

  function paintDressup(state) {
    const assets = state.assets || {};
    const itemOn = (item, def) => (item === undefined || item === null) ? Boolean(def)
      : (typeof item === 'object' ? Boolean(item.on) : Boolean(item));
    document.querySelectorAll('#asset-groups [data-asset]').forEach(input => {
      const id = input.dataset.asset;
      const def = Number(input.dataset.assetDefault || 0);
      const on = itemOn(assets[id], def);
      input.checked = on;
      input.closest('.asset-row')?.classList.toggle('on', on);
    });
    let formValue = assets['form-size'];
    if (formValue && typeof formValue === 'object') formValue = formValue.value;   // bridge 的 describe 对象
    let form = typeof formValue === 'number' ? (FORM_VALUE_MAP[String(formValue)] || null) : formValue;
    if (!FORMS.some(([value]) => value === form)) form = formValue === undefined ? FORM_VALUE_MAP['0'] : null; // 注册表默认档 value 0=大鱼
    document.querySelectorAll('#form-seg [data-form]').forEach(button => {
      const active = button.dataset.form === form;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const presetId = state.preset && typeof state.preset === 'object' ? state.preset.id : state.preset;
    document.querySelectorAll('#preset-row [data-preset]').forEach(button => {
      const active = Boolean(presetId) && button.dataset.preset === presetId;
      button.classList.toggle('active', active);
    });
  }

  function setDressupOffline(message) {
    dressupOnline = false;
    $('dressup').hidden = false;
    $('dressup').classList.add('offline');
    const status = $('dressup-status');
    status.hidden = false;
    status.textContent = message || '桌宠不在线';
  }

  async function refreshDressup() {
    const state = await readDressupState();
    if (state.src === 'none') { setDressupOffline(); return false; }
    $('dressup').hidden = false;
    if (!dressupOnline) {
      dressupOnline = true;
      $('dressup').classList.remove('offline');
      $('dressup-status').hidden = true;
    }
    paintDressup(state);
    return true;
  }

  async function loadDressup() {
    try {
      await refreshDressup();
    } catch (error) {
      setDressupOffline(error.message);
    }
  }

  async function dressupOperate(evalJs, revertInput, opts = {}) {
    try {
      await petEval(evalJs);
      // 资产开关：applyAsset 是同步写参数的，eval 返回时状态已经落定。
      // 再读一次 state 反而会被并发刷新（切页/慢读）用旧快照把开关画回去 ——
      // 用户看到的就是「点一下不翻，点第二下才翻」。所以开关成功就只同步行高亮，不回读。
      if (opts.skipRefresh) {
        if (revertInput) revertInput.closest('.asset-row')?.classList.toggle('on', revertInput.checked);
        return;
      }
      await refreshDressup();
    } catch (error) {
      if (revertInput) revertInput.checked = !revertInput.checked;
      toast(error.message);
      try { await refreshDressup(); } catch { /* 状态读不回就保持现样 */ }
    }
  }

  function buildDressupUi() {
    $('preset-row').innerHTML = PRESETS.map(([id, label]) =>
      `<button class="btn" type="button" data-preset="${escapeHtml(id)}">${escapeHtml(label)}</button>`
    ).join('');
    const toggleRows = group => group[1].map(([id, label, def]) =>
      `<div class="asset-row"><span class="asset-name">${escapeHtml(label)}</span><label class="switch"><input type="checkbox" data-asset="${escapeHtml(id)}" data-asset-default="${def}"><i></i><span class="sr">${escapeHtml(label)}</span></label></div>`
    ).join('');
    const group = (title, inner) => `<section class="asset-group"><h3>${escapeHtml(title)}</h3>${inner}</section>`;
    // 双栈栅格：左右两列节标题等高起步， tall 的表情件独占右列不再把左列顶悬空
    const leftCol = group('形态', `<div class="seg" id="form-seg">${FORMS.map(([value, label]) => `<button type="button" data-form="${value}">${escapeHtml(label)}</button>`).join('')}</div>`)
      + group(ASSET_GROUPS[0][0], toggleRows(ASSET_GROUPS[0]))
      + group(ASSET_GROUPS[1][0], toggleRows(ASSET_GROUPS[1]))
      + group(ASSET_GROUPS[2][0], toggleRows(ASSET_GROUPS[2]));
    const rightCol = group(ASSET_GROUPS[3][0], toggleRows(ASSET_GROUPS[3]))
      + group(ASSET_GROUPS[4][0], toggleRows(ASSET_GROUPS[4]));
    $('asset-groups').innerHTML = `<div class="asset-col">${leftCol}</div><div class="asset-col">${rightCol}</div>`;
  }

  $('dressup').addEventListener('change', async event => {
    const input = event.target.closest('[data-asset]');
    if (!input) return;
    if (!dressupOnline) { input.checked = !input.checked; toast('桌宠不在线'); return; }
    const id = input.dataset.asset;
    await dressupOperate(`JSON.stringify((function(){ var r = (window.petBody && window.petBody.asset) ? window.petBody.asset('${id}', ${input.checked}) : window.petAssetsBridge.asset('${id}', ${input.checked}); return JSON.stringify(r === undefined ? null : r); })())`, input, { skipRefresh: true });
  });

  $('dressup').addEventListener('click', async event => {
    const preset = event.target.closest('[data-preset]');
    if (preset) {
      await dressupOperate(`JSON.stringify((function(){ var r = (window.petBody && window.petBody.preset) ? window.petBody.preset('${preset.dataset.preset}') : window.petAssetsBridge.preset('${preset.dataset.preset}'); return JSON.stringify(r === undefined ? null : r); })())`);
      return;
    }
    const form = event.target.closest('[data-form]');
    if (form) {
      await dressupOperate(`JSON.stringify((function(){ var r = (window.petBody && window.petBody.setAssetValue) ? window.petBody.setAssetValue('form-size', '${form.dataset.form}') : window.petAssetsBridge.asset('form-size', '${form.dataset.form}'); return JSON.stringify(r === undefined ? null : r); })())`);
    }
  });

  $('petbody-cowatch-refresh').addEventListener('click', async () => {
    const box = $('petbody-cowatch');
    box.style.display = '';
    box.textContent = '正在问她的眼睛和耳朵…';
    try {
      const raw = await petEval(`JSON.stringify((()=>{
        const p = window.pluginManager && window.pluginManager._plugins.get('community/watch-screen');
        const o = p && p.plugin && p.plugin._organ;
        const plugin = p && p.plugin;
        return {
          visual: o && o._lastSummaryText ? o._lastSummaryText : '',
          atmosphere: plugin && plugin._audioAtmosphere ? (plugin._audioAtmosphere(60) || '') : '',
          lines: plugin ? (plugin._audioLines || []).slice(-3).map(x => x.text) : [],
          keyframes: o ? o.stats().keyframes : 0,
        };
      })())`);
      const data = JSON.parse(raw || '{}');
      const rows = [];
      rows.push('画面：' + (data.visual || '（还没看到东西）'));
      rows.push('气氛：' + (data.atmosphere || '（还没听到声音）'));
      if (data.lines && data.lines.length) rows.push('最近的声音：' + data.lines.join(' / '));
      rows.push('看过 ' + (data.keyframes || 0) + ' 个关键帧');
      box.textContent = rows.join('\n');
    } catch (error) {
      box.textContent = '读不到（她可能没在运行）：' + (error && error.message || error);
    }
  });

  const FALLBACK_SCENES = ['打招呼', '撒娇', '生气', '难过', '得意', '晚安'];
  async function loadScenes() {
    let scenes = FALLBACK_SCENES;
    try {
      const value = JSON.parse(await petEval('JSON.stringify(window.petBody && window.petBody.listScenes ? window.petBody.listScenes() : [])') || '[]');
      if (Array.isArray(value) && value.length) scenes = value;
    } catch { /* 皮套不在线就给默认六段，点了会有明确报错 */ }
    // 按钮 HTML 与演出页共用 buildSceneButtons（2026-11-25 P3b：两处必须一样）
    $('scene-box').innerHTML = buildSceneButtons(scenes);
  }
  // 皮套页的场景按钮保留（用户习惯），点击与演出页走同一段 performScene：
  // toast 现在明确写「已抢占当前表演」（ADR-015 §4.5 第 7 条）。
  $('scene-box').addEventListener('click', (event) => {
    const button = event.target.closest('[data-scene]');
    if (!button) return;
    performScene(button.dataset.scene);
  });

  // ── 记录页（对话历史 + 分页 + 截图预览，语义照 v1）───────────────────
  const historyPageSize = 30;
  let historyRounds = [];
  let historyPage = 1;

  function groupHistoryRounds(messages) {
    const rounds = [];
    for (const message of messages) {
      if (message.role === 'user' || rounds.length === 0) rounds.push([]);
      rounds[rounds.length - 1].push(message);
    }
    return rounds;
  }

  function historyContent(content) {
    const formatText = value => escapeHtml(value).replace(/&lt;([\u4e00-\u9fa5]+)&gt;/g, '<span class="emotion-tag">&lt;$1&gt;</span>');
    if (typeof content === 'string') return `<p>${formatText(content)}</p>`;
    if (!Array.isArray(content)) return `<p>${escapeHtml(content == null ? '' : JSON.stringify(content))}</p>`;
    return content.map(item => {
      if (typeof item === 'string') return `<p>${formatText(item)}</p>`;
      if (item?.type === 'text') return `<p>${formatText(item.text || '')}</p>`;
      const url = item?.image_url?.url || item?.image_url;
      if (typeof url === 'string' && (url.startsWith('data:image/') || /^https?:\/\//i.test(url))) {
        return `<img class="history-image" src="${escapeHtml(url)}" alt="对话图片">`;
      }
      return '';
    }).join('');
  }

  // 工具调用翻译成人话；工具名/参数/结果与表情符号只留在悬停 title 里
  const stripEmoji = text => String(text ?? '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();

  const TOOL_PHRASES = {
    record_memory: args => (args ? `已记住：${args}` : '记了一条记忆'),
    recall_memory: args => (args ? `翻了记忆：${args}` : '翻了翻记忆'),
    search_memory: args => (args ? `翻了记忆：${args}` : '翻了翻记忆'),
    web_search: args => (args ? `联网查了：${args}` : '联网查了些资料'),
    take_screenshot: () => '看了一眼屏幕',
    screen_narrate: args => (args ? `看了眼屏幕：${args}` : '看了眼屏幕')
  };

  function toolCallLines(toolCalls) {
    return (Array.isArray(toolCalls) ? toolCalls : []).map(call => {
      const fn = call?.function || {};
      let args = fn.arguments || '';
      try { args = Object.values(JSON.parse(args)).join('，'); } catch { /* 保留原文 */ }
      return { name: fn.name || 'unknown', args: stripEmoji(args) };
    });
  }

  function historyMessageHtml(message) {
    if (message.role === 'tool') return ''; // 工具结果是调试噪声，并入调用行的悬停
    const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'other';
    const roleName = role === 'user'
      ? (String(get(config, 'subtitle_labels.user', '') || '') || '你')
      : role === 'assistant'
        ? (String(get(config, 'subtitle_labels.ai', '') || '') || '她')
        : (message.role || '未知');
    const calls = toolCallLines(message.tool_calls);
    const callMeta = calls.map(call => `${call.name} ${call.args}`.trim()).join(' ｜ ');
    const callHtml = calls.map(call => {
      const phrase = TOOL_PHRASES[call.name] ? TOOL_PHRASES[call.name](call.args) : '';
      return `<div class="history-meta" title="${escapeHtml(callMeta)}">${escapeHtml(phrase || '执行了后台操作')}</div>`;
    }).join('');
    const images = (Array.isArray(message.history_images) ? message.history_images : [])
      .filter(url => typeof url === 'string' && url.startsWith('data:image/'))
      .map(url => `<img class="history-image" src="${escapeHtml(url)}" alt="对话截图" title="点击查看大图" tabindex="0" role="button">`)
      .join('');
    return `<article class="history-item ${role}"><header>${escapeHtml(roleName)}</header><div class="history-content">${historyContent(message.content)}${images}${callHtml}</div></article>`;
  }

  function renderHistoryPage() {
    const totalPages = Math.max(1, Math.ceil(historyRounds.length / historyPageSize));
    historyPage = Math.min(Math.max(1, historyPage), totalPages);
    const start = (historyPage - 1) * historyPageSize;
    const rounds = historyRounds.slice(start, start + historyPageSize);
    $('history-list').innerHTML = rounds.flat().map(historyMessageHtml).join('') || '<div class="history-empty">暂无对话记录</div>';
    $('history-sub').textContent = `共 ${historyRounds.length} 轮`;

    const pagination = $('history-pagination');
    pagination.hidden = historyRounds.length === 0;
    if (pagination.hidden) { pagination.innerHTML = ''; return; }
    const visiblePages = [];
    for (let page = 1; page <= totalPages; page++) {
      if (page === 1 || page === totalPages || Math.abs(page - historyPage) <= 2) visiblePages.push(page);
    }
    let previous = 0;
    const buttons = [];
    for (const page of visiblePages) {
      if (previous && page - previous > 1) buttons.push('<span class="gap">…</span>');
      buttons.push(`<button type="button" data-history-page="${page}" class="${page === historyPage ? 'active' : ''}" ${page === historyPage ? 'aria-current="page"' : ''}>${page}</button>`);
      previous = page;
    }
    pagination.innerHTML = buttons.join('');
  }

  async function loadChatHistory() {
    try {
      const result = await api.getChatHistory();
      if (!result.exists) {
        $('history-list').innerHTML = '<div class="history-empty">对话历史文件不存在</div>';
        $('history-pagination').hidden = true;
        $('history-sub').textContent = '对话流水，按轮分页';
        return;
      }
      historyRounds = groupHistoryRounds(result.messages);
      historyPage = Math.max(1, Math.ceil(historyRounds.length / historyPageSize));
      renderHistoryPage();
    } catch (error) {
      $('history-list').innerHTML = `<div class="history-empty">读取失败：${escapeHtml(error.message)}</div>`;
      $('history-pagination').hidden = true;
    }
  }

  $('history-list').addEventListener('click', event => {
    const image = event.target.closest('.history-image');
    if (image) openHistoryPreview(image.src);
  });
  $('history-list').addEventListener('keydown', event => {
    const image = event.target.closest('.history-image');
    if (image && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openHistoryPreview(image.src); }
  });
  $('history-pagination').addEventListener('click', event => {
    const button = event.target.closest('[data-history-page]');
    if (!button) return;
    historyPage = Number(button.dataset.historyPage);
    renderHistoryPage();
  });

  // 截图大图预览：滚轮缩放 + 拖拽（语义照 v1）
  let historyImageScale = 1;
  let historyImageX = 0;
  let historyImageY = 0;
  let historyImageDrag = null;

  function paintHistoryImageTransform() {
    $('history-image-preview').style.transform = `translate(${historyImageX}px, ${historyImageY}px) scale(${historyImageScale})`;
    $('history-image-zoom-value').textContent = `${Math.round(historyImageScale * 100)}%`;
    $('history-image-viewport').classList.toggle('zoomed', historyImageScale > 1);
  }
  function setHistoryImageZoom(scale) {
    historyImageScale = Math.min(8, Math.max(0.25, scale));
    if (historyImageScale <= 1) { historyImageX = 0; historyImageY = 0; }
    paintHistoryImageTransform();
  }
  function resetHistoryImageTransform() {
    historyImageScale = 1;
    historyImageX = 0;
    historyImageY = 0;
    paintHistoryImageTransform();
  }
  function openHistoryPreview(src) {
    if (!src) return;
    $('history-image-preview').src = src;
    resetHistoryImageTransform();
    $('history-image-modal').classList.add('open');
    $('history-image-close').focus();
  }
  function closeHistoryPreview() {
    $('history-image-modal').classList.remove('open');
    $('history-image-preview').removeAttribute('src');
  }
  $('history-image-close').addEventListener('click', closeHistoryPreview);
  $('history-image-zoom-in').addEventListener('click', () => setHistoryImageZoom(historyImageScale * 1.25));
  $('history-image-zoom-out').addEventListener('click', () => setHistoryImageZoom(historyImageScale / 1.25));
  $('history-image-reset').addEventListener('click', resetHistoryImageTransform);
  $('history-image-viewport').addEventListener('wheel', event => {
    event.preventDefault();
    setHistoryImageZoom(historyImageScale * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });
  $('history-image-preview').addEventListener('dblclick', resetHistoryImageTransform);
  $('history-image-preview').addEventListener('pointerdown', event => {
    if (historyImageScale <= 1) return;
    historyImageDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, imageX: historyImageX, imageY: historyImageY };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('dragging');
  });
  $('history-image-preview').addEventListener('pointermove', event => {
    if (!historyImageDrag || historyImageDrag.pointerId !== event.pointerId) return;
    historyImageX = historyImageDrag.imageX + event.clientX - historyImageDrag.startX;
    historyImageY = historyImageDrag.imageY + event.clientY - historyImageDrag.startY;
    paintHistoryImageTransform();
  });
  const stopHistoryImageDrag = event => {
    if (!historyImageDrag || historyImageDrag.pointerId !== event.pointerId) return;
    historyImageDrag = null;
    event.currentTarget.classList.remove('dragging');
  };
  $('history-image-preview').addEventListener('pointerup', stopHistoryImageDrag);
  $('history-image-preview').addEventListener('pointercancel', stopHistoryImageDrag);
  $('history-image-modal').addEventListener('click', event => {
    if (event.target === $('history-image-modal')) closeHistoryPreview();
  });

  // ── 外观页：位置按钮 ─────────────────────────────────────────────────
  $('reset-model-position').addEventListener('click', async () => {
    const result = await api.resetModelPosition();
    toast(result.message);
  });
  $('adjust-subtitle-position').addEventListener('click', async () => {
    const result = await api.adjustSubtitlePosition();
    toast(result.message);
  });

  
  // ── 知识库、技能库与操控日志业务逻辑 ───────────────────────────────────

  // 1. 知识库
  let currentKnGame = '植物大战僵尸';
  let knCurrentData = null;

  async function loadKnowledge(game = null) {
    if (game) currentKnGame = game;
    try {
      const games = await api.knowledgeListGames();
      const tabsEl = $('kn-game-tabs');
      if (tabsEl && Array.isArray(games)) {
        tabsEl.innerHTML = games.map(g => `
          <button class="game-tab ${g === currentKnGame ? 'active' : ''}" data-game="${escapeHtml(g)}" type="button">${escapeHtml(g)}</button>
        `).join('');
        tabsEl.querySelectorAll('.game-tab').forEach(btn => {
          btn.addEventListener('click', () => loadKnowledge(btn.dataset.game));
        });
      }

      const res = await api.knowledgeGetGame(currentKnGame);
      if (!res.ok) {
        toast('知识读取失败: ' + res.error);
        return;
      }
      knCurrentData = res.data;
      paintKnowledge(res.data, res.reliability);
    } catch (e) {
      console.warn('[v2] loadKnowledge failed:', e);
    }
  }

  function paintKnowledge(data, reliability) {
    if (!data) return;
    $('kn-rule-count').textContent = Array.isArray(data.rules) ? data.rules.length : 0;
    $('kn-exp-count').textContent = Array.isArray(data.experience) ? data.experience.length : 0;

    const freshEl = $('kn-live-freshness');
    if (data.live && data.live.updatedAt) {
      const days = Math.floor((Date.now() - Date.parse(data.live.updatedAt)) / 86400000);
      if (days <= 30) {
        freshEl.className = 'kn-badge fresh';
        freshEl.textContent = `鲜活 (近${days}天)`;
      } else if (days <= 90) {
        freshEl.className = 'kn-badge aging';
        freshEl.textContent = `临期 (${days}天)`;
      } else {
        freshEl.className = 'kn-badge stale';
        freshEl.textContent = `过时降权 (${days}天)`;
      }
      $('kn-live-time').textContent = `更新时间: ${data.live.updatedAt} (${data.live.source || '用户实测'})`;
    } else {
      freshEl.className = 'kn-badge';
      freshEl.textContent = '未配置动态层';
      $('kn-live-time').textContent = '暂无动态 RAG 层覆盖';
    }

    const confEl = $('kn-confidence-badge');
    confEl.textContent = (data.confidence || 'medium').toUpperCase();
    confEl.className = 'kn-badge ' + (data.confidence === 'high' ? 'high' : 'med');

    const rulesList = $('kn-rules-list');
    if (rulesList) {
      if (Array.isArray(data.rules) && data.rules.length) {
        rulesList.innerHTML = data.rules.map(r => `
          <div class="kn-rule-item">
            <span class="kn-rule-tag">${escapeHtml(r.kind || '规则')}</span>
            <span>${escapeHtml(r.text || '')}</span>
          </div>
        `).join('');
      } else {
        rulesList.innerHTML = '<p class="hint">暂无稳定规则条目</p>';
      }
    }

    const keysGrid = $('kn-keys-grid');
    if (keysGrid) {
      const keys = Object.entries(data.keys || {});
      if (keys.length) {
        keysGrid.innerHTML = keys.map(([k, v]) => `
          <div class="kn-key-chip">
            <span class="kn-key-name">${escapeHtml(k)}</span>
            <span class="kn-key-val">${escapeHtml(v)}</span>
          </div>
        `).join('');
      } else {
        keysGrid.innerHTML = '<span class="hint">无特定键位</span>';
      }
    }

    const actBox = $('kn-typical-actions');
    if (actBox) {
      if (Array.isArray(data.typicalActions) && data.typicalActions.length) {
        actBox.innerHTML = data.typicalActions.map(a => `
          <span class="kn-act-chip">${escapeHtml(a)}</span>
        `).join('');
      } else {
        actBox.innerHTML = '<span class="hint">无常用动作预设</span>';
      }
    }

    const liveBox = $('kn-live-content');
    if (liveBox) {
      if (data.live) {
        liveBox.innerHTML = `
          <div><strong>版本：</strong>${escapeHtml(data.live.version || '最新')}</div>
          ${data.live.overrides ? '<div style="margin-top:6px;"><strong>覆盖键位：</strong>' + escapeHtml(JSON.stringify(data.live.overrides.keys || {})) + '</div>' : ''}
          ${Array.isArray(data.live.extra) ? '<div style="margin-top:6px;">' + data.live.extra.map(e => '<div>✦ ' + escapeHtml(e.text) + '</div>').join('') + '</div>' : ''}
        `;
      } else {
        liveBox.innerHTML = '<span class="hint">当前游戏完全走稳定 rules 层，无需动态覆盖。</span>';
      }
    }

    const expTimeline = $('kn-exp-timeline');
    if (expTimeline) {
      if (Array.isArray(data.experience) && data.experience.length) {
        expTimeline.innerHTML = data.experience.slice().reverse().map(e => `
          <div class="kn-exp-card ${e.kind === 'success' ? 'success' : 'failure'}">
            <div class="kn-exp-head">
              <span class="kn-exp-badge ${e.kind === 'success' ? 'success' : 'failure'}">
                ${e.kind === 'success' ? '✓ 成功验证' : '✗ 尝试失败'}
              </span>
              <span class="sub mono">${escapeHtml(String(e.ts || '').slice(5, 16))}</span>
            </div>
            <div class="kn-exp-action">${escapeHtml(e.action || '')}</div>
            <div class="kn-exp-evidence">
              ${e.evidence ? '<span><strong>证据：</strong>' + escapeHtml(e.evidence) + '</span> ' : ''}
              ${e.note ? '<span>(' + escapeHtml(e.note) + ')</span>' : ''}
            </div>
          </div>
        `).join('');
      } else {
        expTimeline.innerHTML = '<p class="hint">暂无该游戏的实操经验记录。</p>';
      }
    }
  }

  // 规则编辑弹窗
  let _wireKnDone = false;
  function wireKnowledgeModals() {
    if (_wireKnDone) return;
    _wireKnDone = true;
    $('kn-refresh')?.addEventListener('click', () => loadKnowledge());
    $('kn-edit-rules-btn')?.addEventListener('click', () => {
      if (!knCurrentData) return;
      $('kn-modal-gamename').value = currentKnGame;
      $('kn-modal-keys').value = JSON.stringify(knCurrentData.keys || {}, null, 2);
      $('kn-modal-rules').value = JSON.stringify(knCurrentData.rules || [], null, 2);
      $('kn-edit-modal').classList.add('open');
    });

    $('kn-add-rule-btn')?.addEventListener('click', async () => {
      const gName = await uiPrompt('新游戏名称（如 pvz / mc）', '');
      if (!gName) return;
      $('kn-modal-gamename').value = gName.trim();
      $('kn-modal-keys').value = '{\n  "暂停": "space",\n  "菜单": "esc"\n}';
      $('kn-modal-rules').value = '[\n  {\n    "id": "intro",\n    "text": "规则概述",\n    "kind": "mechanic"\n  }\n]';
      $('kn-edit-modal').classList.add('open');
    });

    $('kn-add-exp-btn')?.addEventListener('click', async () => {
      const act = await uiPrompt('执行的动作（如 pvz auto 1,3,2）', '');
      if (!act) return;
      const ok = await uiConfirm('该动作是否成功执行？点「确定」= 成功，点「取消」= 失败');
      const note = (await uiPrompt('备注说明（例如：卡槽1种向日葵）', '')) || '';
      try {
        await api.knowledgeAddExperience({
          game: currentKnGame,
          kind: ok ? 'success' : 'failure',
          action: act.trim(),
          verified: ok,
          evidence: ok ? '手动录入验证' : '人工标记失败',
          note: note.trim()
        });
        toast('实操经验已入库！');
        loadKnowledge(currentKnGame);
      } catch (err) {
        toast('写入经验失败: ' + err.message);
      }
    });

    const closeModal = () => $('kn-edit-modal')?.classList.remove('open');
    $('kn-modal-close')?.addEventListener('click', closeModal);
    $('kn-modal-cancel')?.addEventListener('click', closeModal);

    $('kn-modal-save')?.addEventListener('click', async () => {
      const game = $('kn-modal-gamename').value;
      let keys = {}, rules = [];
      try {
        keys = JSON.parse($('kn-modal-keys').value);
      } catch (e) {
        alert('键位映射 JSON 格式错误: ' + e.message);
        return;
      }
      try {
        rules = JSON.parse($('kn-modal-rules').value);
      } catch (e) {
        alert('规则列表 JSON 格式错误: ' + e.message);
        return;
      }

      const payload = {
        game,
        version: '1.x 通用',
        updatedAt: new Date().toISOString().slice(0, 10),
        confidence: 'high',
        rules,
        keys,
        typicalActions: knCurrentData ? (knCurrentData.typicalActions || []) : []
      };

      const res = await api.knowledgeSaveRules(game, payload);
      if (res.ok) {
        toast('游戏规则已更新！');
        closeModal();
        loadKnowledge(game);
      } else {
        toast('保存失败: ' + res.error);
      }
    });
  }

  // 2. 技能库
  async function loadSkills() {
    try {
      const res = await api.skillsList();
      const skills = (res && res.skills) || [];
      $('sk-total-count').textContent = skills.length;

      let sumRel = 0;
      let lastRun = '-';
      skills.forEach(s => {
        if (s.reliability && s.reliability.mean) sumRel += s.reliability.mean;
        if (s.lastRunAt && (!lastRun || s.lastRunAt > lastRun)) lastRun = s.lastRunAt;
      });
      const avg = skills.length ? Math.round((sumRel / skills.length) * 100) : 0;
      $('sk-avg-rel').textContent = avg + '%';
      $('sk-last-run').textContent = lastRun !== '-' ? lastRun.slice(5, 19).replace('T', ' ') : '无记录';

      const grid = $('skills-grid');
      if (!grid) return;
      if (!skills.length) {
        grid.innerHTML = '<p class="hint" style="grid-column:1/-1;">技能库尚为空。当她在操控中验证完成一个成功序列时，会自动或手动固化成技能。</p>';
        return;
      }

      grid.innerHTML = skills.map(sk => {
        const mean = sk.reliability ? Math.round(sk.reliability.mean * 100) : 50;
        const sCount = sk.successCount || 0;
        const aCount = sk.attemptCount || 0;
        const isDeleted = sk.deleted === true;
        const steps = Array.isArray(sk.steps) ? sk.steps : [];

        return `
          <div class="skill-card ${isDeleted ? 'deleted' : ''}">
            <div class="skill-head">
              <h3 class="skill-title">${escapeHtml(sk.name)}</h3>
              ${isDeleted ? '<span class="kn-badge stale">已归档</span>' : '<span class="kn-badge fresh">已就绪</span>'}
            </div>
            <p class="skill-desc">${escapeHtml(sk.description || '无详细描述')}</p>

            <div class="skill-rel-box">
              <div class="skill-rel-meta">
                <span>Beta后验可靠度: <strong>${mean}%</strong></span>
                <span class="mono">验证: ${sCount} / 尝试: ${aCount}</span>
              </div>
              <div class="skill-rel-track">
                <div class="skill-rel-bar" style="width: ${mean}%;"></div>
              </div>
            </div>

            <div class="skill-steps-title">包含动作序列 (${steps.length} 步):</div>
            <div class="skill-steps-list">
              ${steps.map((st, i) => `
                <div class="skill-step-row">
                  <span class="skill-step-num">${i + 1}.</span>
                  <span class="skill-step-act">${escapeHtml(st.action || '')}</span>
                  <span class="skill-step-arg">${escapeHtml(st.arg || '')}</span>
                </div>
              `).join('')}
            </div>

            <div class="skill-actions-bar">
              ${!isDeleted ? `
                <button class="btn tiny" data-skill-del="${escapeHtml(sk.name)}" type="button">遗忘</button>
                <button class="btn tiny primary" data-skill-run="${escapeHtml(sk.name)}" type="button">▶ 跑一次</button>
              ` : '<span class="sub">已软删除</span>'}
            </div>
          </div>
        `;
      }).join('');

      grid.querySelectorAll('[data-skill-run]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const nm = btn.dataset.skillRun;
          toast('开始执行技能: ' + nm);
          try {
            const r = await api.skillsRun(nm);
            if (r.ok) toast('✓ 技能执行完成: ' + nm);
            else toast('✕ 技能执行未通过: ' + (r.detail || r.error || '失败'));
            loadSkills();
          } catch (e) {
            toast('执行错误: ' + e.message);
          }
        });
      });

      grid.querySelectorAll('[data-skill-del]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const nm = btn.dataset.skillDel;
          if (confirm('确认遗忘技能「' + nm + '」吗？')) {
            await api.skillsDelete(nm);
            toast('已遗忘技能: ' + nm);
            loadSkills();
          }
        });
      });
    } catch (e) {
      console.warn('[v2] loadSkills failed:', e);
    }
  }

  // 3. 操控执行日志
  let actionFilter = 'all';

  async function loadActions(filter = null) {
    if (filter) actionFilter = filter;
    try {
      const res = await api.actionsGetHistory();
      const list = (res && res.history) || [];
      $('act-count-hint').textContent = `共 ${list.length} 条实战执行`;

      const filtered = list.filter(item => {
        if (actionFilter === 'all') return true;
        return item.effect === actionFilter;
      });

      const timelineEl = $('actions-timeline');
      if (!timelineEl) return;
      if (!filtered.length) {
        timelineEl.innerHTML = '<p class="hint">当前无符合筛选条件的操控日志。</p>';
        return;
      }

      timelineEl.innerHTML = filtered.map(item => {
        const isNoop = item.effect === 'suspected_noop';
        return `
          <div class="act-log-card ${isNoop ? 'suspected_noop' : ''}">
            <div class="act-left-info">
              <span class="act-time">${escapeHtml(String(item.ts || '').slice(11, 19) || '-')}</span>
              <span class="act-command">${escapeHtml(item.action || '')} ${escapeHtml(item.arg || '')}</span>
              <span class="act-detail">${escapeHtml(item.detail || '')} ${item.evidence ? '· ' + escapeHtml(item.evidence) : ''}</span>
            </div>
            <div class="act-right-meta">
              <span class="act-tier-pill">${escapeHtml(item.tier || 'L1')}</span>
              <span class="act-effect-pill ${escapeHtml(item.effect || '')}">
                ${isNoop ? '⚠️ 疑似空操作' : escapeHtml(item.effect || 'confirmed')}
              </span>
              <span class="act-cost">${item.costMs || 0}ms</span>
            </div>
          </div>
        `;
      }).join('');
    } catch (e) {
      console.warn('[v2] loadActions failed:', e);
    }
  }

  // 3.5 后台任务（派活账本 · 2026-11-23）
  // 列表来自 control-main 直读 data/dispatch-tasks.jsonl（坏行只跳过）；
  // 详情走 8103 GET /dispatch/tasks?id=（带 .control-token）。
  // 详情内的按钮全部按真实闸门出现：取消=only running；重试=failed+attempted=false；
  // 续聊=终态+有 sessionId（判定与 IPC 同源，见 dispatch-followup-policy.js）。
  const DISPATCH_PILL_CLASS = {
    done: 'confirmed',
    failed: 'suspected_noop',
    unknown: 'unverifiable',
    running: 'confirmed_idempotent',
    cancelling: 'unverifiable',
    cancelled: 'not_sent',
  };

  function fmtDispatchMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '-';
    return n >= 1000 ? (Math.round(n / 100) / 10) + 's' : Math.round(n) + 'ms';
  }

  function fmtDispatchTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '-';
    try { return new Date(n).toLocaleTimeString('zh-CN', { hour12: false }); } catch (e) { return '-'; }
  }

  async function loadDispatchTasks() {
    const listEl = $('dispatch-tasks-list');
    const countEl = $('dispatch-task-count');
    if (!listEl) return;
    try {
      const res = await api.dispatchTasksList();
      const tasks = (res && Array.isArray(res.tasks)) ? res.tasks : [];
      if (countEl) {
        countEl.textContent = tasks.length
          ? ('共 ' + tasks.length + ' 条' + (res && res.badLines ? ' · 跳过坏行 ' + res.badLines : ''))
          : '暂无记录';
      }
      if (!tasks.length) {
        listEl.innerHTML = '<p class="hint">还没有后台任务。派一次活（dispatch_to_dsh）后，账本会在这里出现。</p>';
        return;
      }
      listEl.innerHTML = tasks.map((t) => {
        const state = String(t.state || 'unknown');
        const cls = DISPATCH_PILL_CLASS[state] || '';
        const detail = [
          t.outcome ? String(t.outcome) : '',
          t.stateReason ? String(t.stateReason) : '',
          t.attempted === false ? 'attempted=false' : '',
        ].filter(Boolean).join(' · ');
        return `
          <div class="act-log-card" data-dispatch-id="${escapeHtml(String(t.taskId || ''))}" role="button" tabindex="0" title="点击看详情">
            <div class="act-left-info">
              <span class="act-time">${escapeHtml(fmtDispatchTime(t.createdAt))}</span>
              <span class="act-command">${escapeHtml(String(t.taskId || ''))}</span>
              <span class="act-detail">${escapeHtml(String(t.taskPreview || '（无摘要）'))}${detail ? ' · ' + escapeHtml(detail) : ''}</span>
            </div>
            <div class="act-right-meta">
              <span class="act-effect-pill ${cls}">${escapeHtml(state)}</span>
              <span class="act-cost">${escapeHtml(fmtDispatchMs(t.tookMs))}</span>
            </div>
          </div>
        `;
      }).join('');
      listEl.querySelectorAll('[data-dispatch-id]').forEach((el) => {
        const open = () => showDispatchDetail(el.dataset.dispatchId);
        el.addEventListener('click', open);
        el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
      });
    } catch (e) {
      if (countEl) countEl.textContent = '读取失败';
      listEl.innerHTML = '<p class="hint">账本读取失败：' + escapeHtml(String((e && e.message) || e)) + '</p>';
    }
  }

  async function showDispatchDetail(taskId) {
    const box = $('dispatch-task-detail');
    if (!box || !taskId) return;
    box.hidden = false;
    box.textContent = '正在读 ' + taskId + ' 的详情…';
    try {
      const r = await api.dispatchTaskDetail(taskId);
      if (!r || !r.ok || !r.task) {
        box.textContent = '详情读不到：' + String((r && r.error) || '未知原因');
        return;
      }
      const t = r.task;
      // 状态中文化（2026-11-23 与新状态机对齐）：running/done/failed/unknown/cancelled
      // 是派活 v2 的全部状态；以前详情直接打英文，用户分不清 unknown≠失败。
      const DISPATCH_STATE_ZH = { running: '运行中', done: '已完成', failed: '失败', unknown: '不确定（断线/超时，可能还在跑）', cancelled: '已取消' };
      const stateText = DISPATCH_STATE_ZH[t.state] || String(t.state || '?');
      const lines = [
        '任务 ' + t.taskId,
        '状态 ' + stateText + (DISPATCH_STATE_ZH[t.state] ? '（' + t.state + '）' : '')
          + (t.outcome ? ' · 结果 ' + t.outcome : '')
          + (t.stateReason ? ' · 原因 ' + t.stateReason : '')
          + ' · attempted=' + (t.attempted === true)
          + ' · 次数 ' + (t.attemptCount || 0),
        '创建 ' + (t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN') : '-')
          + ' · 耗时 ' + fmtDispatchMs(t.tookMs),
        '',
        '任务正文：',
        String(t.taskText || '（空）'),
      ];
      if (t.text) lines.push('', '结果：', String(t.text));
      if (t.error) lines.push('', '错误：', String(t.error));
      if (Array.isArray(t.tools) && t.tools.length) lines.push('', '工具：' + t.tools.join(', '));
      // 「继续聊」的可见条件要能自查：会话 id / 是否接上 / 父任务都摆在详情里
      const sessionBits = [t.sessionId ? '会话 ' + String(t.sessionId) : '会话（无）'];
      if (t.sessionReused === true) sessionBits.push('接上原会话');
      if (t.sessionMismatch === true) sessionBits.push('会话失配');
      if (t.parentId) sessionBits.push('父任务 ' + String(t.parentId));
      if (t.note) sessionBits.push(String(t.note));
      lines.push(sessionBits.join(' · '));
      box.textContent = lines.join('\n');
      box.style.whiteSpace = 'pre-wrap';
      // 派活 v2 P1：只有 running 才可能出现取消按钮（unknown/cancelled 没有可杀句柄）
      if (t.state === 'running') {
        const row = document.createElement('div');
        row.style.cssText = 'margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn small';
        btn.style.color = '#b33';
        btn.textContent = '停止这个任务';
        let armedAt = 0;
        btn.addEventListener('click', async () => {
          // Electron 28 没有 window.confirm（点了会没反应）→ 内联二次确认
          if (Date.now() - armedAt > 3000) {
            armedAt = Date.now();
            btn.textContent = '再点一次确认停止（已写文件不回滚）';
            return;
          }
          btn.disabled = true;
          btn.textContent = '正在停止…';
          const out = await api.dispatchCancel(t.taskId);
          if (out && out.ok) {
            btn.textContent = '已停止';
            loadDispatchTasks();
            setTimeout(() => { showDispatchDetail(t.taskId); }, 400);
          } else {
            btn.disabled = false;
            btn.textContent = '取消失败：' + String((out && out.error) || '未知') + '（可再点一次停止）';
            armedAt = 0;
          }
        });
        row.appendChild(btn);
        box.appendChild(row);
      }
      // B9：只有「spawn 同步失败」（failed + 明确的 attempted=false）才安全重派
      if (t.state === 'failed' && t.attempted === false && String(t.taskText || '').trim()) {
        const row = document.createElement('div');
        row.style.cssText = 'margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn small';
        btn.textContent = '重试（未执行过）';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = '正在重派…';
          const out = await api.dispatchRetry(t);
          if (out && out.ok) {
            btn.textContent = out.finished ? '已结束（刷新看结果）' : '已派出（刷新看进度）';
            loadDispatchTasks();
          } else {
            btn.disabled = false;
            btn.textContent = '重试失败：' + String((out && out.error) || '未知');
          }
        });
        row.appendChild(btn);
        box.appendChild(row);
      }
      // 续聊（2026-11-23）：父任务终态（done/failed/cancelled）+ 有 sessionId 才出现。
      // 判定/文案与 control-main 的 IPC 同源（js/core/dispatch-followup-policy.js）。
      const P = (typeof window !== 'undefined' && window.DispatchFollowupPolicy) || null;
      const gateReason = P ? P.followupBlockedReason(t) : '续聊策略模块没加载（control-v2.html 少了 script）';
      if (!gateReason) {
        const row = document.createElement('div');
        row.style.cssText = 'margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn small';
        btn.textContent = '继续聊';
        // 小输入框直接长在详情里（不弹窗/不跳页）：提交后沿用父任务工作区与会话
        const form = document.createElement('div');
        form.hidden = true;
        form.style.cssText = 'margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '接着让它做什么…（沿用父任务的工作区/会话）';
        input.style.cssText = 'flex:1;min-width:200px;padding:4px 8px;font-size:12px';
        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'btn small';
        send.textContent = '发送';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn small';
        close.textContent = '取消';
        const status = document.createElement('div');
        status.className = 'hint';
        status.style.cssText = 'flex-basis:100%;margin:2px 0 0;color:#b33';
        const submit = async () => {
          const text = input.value.trim();
          if (!text) { status.textContent = '先写一句要接着做什么'; input.focus(); return; }
          send.disabled = true;
          close.disabled = true;
          send.textContent = '提交中…';
          status.textContent = '';
          let out = null;
          try {
            out = await api.dispatchFollowup(t.taskId, text, { state: t.state, sessionId: t.sessionId, parentId: t.parentId });
          } catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
          send.disabled = false;
          close.disabled = false;
          send.textContent = '发送';
          if (out && out.ok) {
            const msg = (out.finished && out.result)
              ? P.describeFollowupOutcome(out.result)
              : P.describeFollowupPending(out.taskId || (out.result && out.result.taskId) || '');
            toast(msg.message);
            form.hidden = true;
            input.value = '';
            loadDispatchTasks();
            const child = out.taskId || (out.result && out.result.taskId);
            if (child) setTimeout(() => showDispatchDetail(String(child)), 350);
          } else {
            const why = String((out && (out.hint || out.error)) || '未知原因');
            status.textContent = '续聊失败：' + why;
            toast('续聊失败：' + why);
          }
        };
        btn.addEventListener('click', () => {
          form.hidden = !form.hidden;
          if (!form.hidden) input.focus();
        });
        send.addEventListener('click', submit);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
          if (ev.key === 'Escape') { form.hidden = true; }
        });
        close.addEventListener('click', () => { form.hidden = true; status.textContent = ''; });
        form.appendChild(input);
        form.appendChild(send);
        form.appendChild(close);
        form.appendChild(status);
        row.appendChild(btn);
        box.appendChild(row);
        box.appendChild(form);
      } else {
        // 不留假按钮：running/unknown 或没有会话 id 时把原因写在详情里
        const why = document.createElement('div');
        why.className = 'hint';
        why.style.cssText = 'margin-top:8px';
        why.textContent = '不能续聊：' + gateReason;
        box.appendChild(why);
      }
      box.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      box.textContent = '详情读取失败：' + String((e && e.message) || e);
    }
  }

  let _wireActDone = false;
  function wireActionsFilters() {
    if (_wireActDone) return;
    _wireActDone = true;
    document.querySelectorAll('#act-filter-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#act-filter-chips .chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        loadActions(btn.dataset.filter);
      });
    });
    $('act-refresh')?.addEventListener('click', () => { loadActions(); loadDispatchTasks(); });
    $('sk-refresh')?.addEventListener('click', () => loadSkills());
  }


  // ── 启动 ─────────────────────────────────────────────────────────────
  (async () => {
    try {
      config = await api.loadConfig();
      // 模型通讯录搭车在 config.__llm_providers：取走后立刻摘除，避免混进 config.json
      if (Array.isArray(config.__llm_providers)) {
        providerBook = structuredClone(config.__llm_providers);
        delete config.__llm_providers;
      }
      renderAll();
      loadPerformPage();   // 演出页：config 已就绪，此时读开关初值才对
      // 知识库/操控/技能的按钮绑定原先只在「进皮套页」时执行 → 首次打开那三页按钮全死。
      // 这里启动即绑一次（两个 wire 内部都有幂等 guard）。
      // 静默初始值由总览轮询（control:overview ← 8103 /state）回填，不再在设置页写第二份。
      wireKnowledgeModals();
      wireActionsFilters();
      wireComponents();
      wireOnboarding();
      maybeShowComponentsOnboarding();
      bindWheelFallback();   // 滚轮兜底（CSS 已修好，这层只处理边缘情况）
      // 皮套右键「换装」进来时带 page 参数直接落页；page 支持 "<id>+dirty"（快照取证的脏态）
      let dirtyParam = false;
      try {
        const raw = new URLSearchParams(window.location.search).get('page') || '';
        dirtyParam = raw.endsWith('+dirty');
        const targetPage = dirtyParam ? raw.slice(0, -6) : raw;
        if (targetPage && $(targetPage) && document.querySelector(`[data-page="${targetPage}"]`)) switchPage(targetPage);
      } catch { /* 无 page 参数，停在总览 */ }
      await loadPlugins();
      loadingConfigUi = false;
      setConfigDirty(false);
      if (dirtyParam) setConfigDirty(true);
      loadOverview(true);
      buildDressupUi();
      loadDressup();
      loadScenes();
    } catch (error) {
      loadingConfigUi = false;
      console.warn('[v2] 初始化失败:', error);
      toast('配置加载失败：' + error.message);
    }
  })();
})();
