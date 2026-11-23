// ui/actions.mjs — 动作词典适配层（对 B 的 motion-vocab.mjs 做运行时桥接）
// B 可能把 playAction 挂在 renderer 上，也可能只在模块里导出；两种都接。
// 模块存在与否都不影响 UI 骨架。

let loadPromise = null;
let attempts = 0;
let moduleRef = null;

function moduleUrl(retry) {
  const url = new URL('../motion-vocab.mjs', import.meta.url);
  return retry ? url.href + (url.search ? '&' : '?') + 'retry=' + Date.now() : url.href;
}

export function loadMotionVocab({ retry = false } = {}) {
  if (retry) { loadPromise = null; }
  if (!loadPromise) {
    const url = moduleUrl(attempts > 0);
    attempts += 1;
    loadPromise = import(/* @vite-ignore */ url)
      .then((namespace) => {
        moduleRef = namespace || null;
        return moduleRef;
      })
      .catch((error) => {
        console.info('[stage] 动作词典暂未就绪：' + String((error && error.message) || error));
        return null;
      });
  }
  return loadPromise;
}

function pickActionFunction(module) {
  if (!module) return null;
  for (const key of ['playAction', 'play', 'trigger', 'perform', 'run']) {
    if (typeof module[key] === 'function') return module[key];
  }
  const fallback = module.default;
  if (fallback) {
    for (const key of ['playAction', 'play', 'trigger', 'perform', 'run']) {
      if (typeof fallback[key] === 'function') return fallback[key];
    }
  }
  return null;
}

/**
 * 播一个英文动作标签（如 "wave" / "nod head"）。
 * 返回 true 表示同步接住了；false 表示正在等模块加载或根本不可用（调用方可继续做兜底反应）。
 */
export function playAction(renderer, name) {
  const action = String(name ?? '').replace(/^\[|\]$/g, '').trim().slice(0, 120);
  if (!action) return false;
  if (renderer && typeof renderer.playAction === 'function') {
    try {
      const handled = renderer.playAction(action);
      if (handled !== false) return true;
    } catch (error) {
      console.warn('[stage] renderer.playAction 出错', error);
    }
  }
  loadMotionVocab().then((module) => {
    const fn = pickActionFunction(module);
    if (!fn) return;
    try {
      if (fn.length >= 2) fn(renderer, action);
      else if (fn(action) === false) fn(renderer, action);
    } catch (error) {
      console.warn('[stage] 动作词典执行失败', error);
    }
  });
  return false;
}

