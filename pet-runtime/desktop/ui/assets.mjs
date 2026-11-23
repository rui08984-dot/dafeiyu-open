// ui/assets.mjs — 资产开关适配层（对 C 的 asset-toggles.mjs 做运行时桥接）
// C 的模块可能比 UI 晚落地，所以用动态 import + 失败兜底：
//   - 没加载到：面板显示提示与"重新加载"按钮，不会抛错；
//   - 加载到了：{ TOGGLES, listAssets(), applyAsset(renderer,id,on), getState(renderer) } 按契约接。

let loadPromise = null;
let attempts = 0;

function moduleUrl(retry) {
  const base = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || (typeof location !== 'undefined' && location.href) || '';
  const url = new URL('../asset-toggles.mjs', base || 'http://localhost/');
  return retry ? url.href + (url.search ? '&' : '?') + 'retry=' + Date.now() : url.href;
}

/** 加载资产目录；retry=true 时绕过浏览器对失败请求的缓存。 */
export function loadAssetModule({ retry = false } = {}) {
  if (retry) { loadPromise = null; }
  if (!loadPromise) {
    const url = moduleUrl(attempts > 0);
    attempts += 1;
    loadPromise = import(/* @vite-ignore */ url)
      .then((namespace) => normalize(namespace))
      .catch((error) => {
        console.info('[stage] 资产模块暂未就绪：' + String((error && error.message) || error));
        return null;
      });
  }
  return loadPromise;
}

function normalize(namespace) {
  const candidate = namespace && (namespace.applyAsset || namespace.TOGGLES || namespace.listAssets) ? namespace : namespace?.default;
  if (!candidate) return null;
  if (typeof candidate.applyAsset !== 'function' && !Array.isArray(candidate.TOGGLES) && typeof candidate.listAssets !== 'function') return null;
  return candidate;
}

/** 把 listAssets()/TOGGLES 统一成数组。 */
export function readAssetItems(module) {
  try {
    if (typeof module?.listAssets === 'function') {
      const list = module.listAssets();
      if (Array.isArray(list)) return list;
      if (Array.isArray(list?.items)) return list.items;
    }
    if (Array.isArray(module?.TOGGLES)) return module.TOGGLES;
  } catch (error) {
    console.warn('[stage] listAssets 读取失败', error);
  }
  return [];
}

/** 读当前开关状态，统一成 { id或param: 值 }。拿不到就返回空对象，由 UI 侧自己记。 */
export function readAssetState(module, renderer) {
  try {
    const raw = typeof module?.getState === 'function' ? module.getState(renderer) : null;
    if (!raw) return {};
    if (typeof raw.get === 'function' && typeof raw.entries === 'function') {
      const out = {};
      for (const [key, value] of raw.entries()) out[String(key)] = value;
      return out;
    }
    if (Array.isArray(raw)) {
      const out = {};
      for (const id of raw) out[String(id)] = true;
      return out;
    }
    if (typeof raw === 'object') {
      // C 的 getState 返回 { id: describe(...) }，describe 本身是对象，要原样保留（含 on/optionLabel）。
      const out = {};
      for (const [key, value] of Object.entries(raw)) {
        if (value === null || value === undefined) continue;
        out[key] = value;
      }
      return out;
    }
  } catch (error) {
    console.warn('[stage] getState 读取失败', error);
  }
  return {};
}

/** 某个资产条目是否处于开启态；state 可以是 C 的 getState（值带 .on），也可以是本地缓存。 */
export function isAssetOn(item, state) {
  const entry = assetEntry(item, state);
  if (entry === undefined) return false;
  if (entry && typeof entry === 'object') {
    if (typeof entry.on === 'boolean') return entry.on;
    if (typeof entry.value === 'number') return entry.value >= 0.5;
    return false;
  }
  if (entry === true) return true;
  if (entry === false || entry === null) return false;
  if (typeof entry === 'number') return entry > 0.5;
  if (typeof entry === 'string') return ['on', 'true', '1', '开', '开启'].includes(entry);
  return false;
}

/** 取某资产在 state 里的原始条目（C 的 getState 给了 id -> describe 对象）。 */
export function assetEntry(item, state) {
  if (!item || !state) return undefined;
  for (const key of [item.id, item.param]) {
    if (key && Object.hasOwn(state, key)) return state[key];
  }
  return undefined;
}

/** 面板展示用：{ on, optionLabel }；optionLabel 是 C 给的语义描述（短裙/长裙/戴上/摘下…） */
export function assetDisplay(item, state) {
  const entry = assetEntry(item, state);
  const on = isAssetOn(item, state);
  let optionLabel = '';
  if (entry && typeof entry === 'object') {
    if (typeof entry.optionLabel === 'string') optionLabel = entry.optionLabel;
    else if (typeof entry.label === 'string' && entry.kind === 'cycle') optionLabel = entry.label;
  }
  if (!optionLabel) optionLabel = on ? (item.onLabel || '已开启') : (item.offLabel || '已关闭');
  return { on, optionLabel };
}

/**
 * 应用一个资产开关。
 * 优先走 C 的 applyAsset(renderer,id,on)；模块缺席时退化为直接写参数（只对 toggle 有意义）。
 */
export function applyAssetTo(module, renderer, item, on) {
  if (!item) return false;
  if (typeof module?.applyAsset === 'function') {
    try {
      // C 的约定：省略 on = 翻转；显式 true/false = 设定。
      const result = on === undefined ? module.applyAsset(renderer, item.id) : module.applyAsset(renderer, item.id, on);
      if (result && typeof result.then === 'function') result.catch((error) => console.warn('[stage] applyAsset 异步失败', error));
      return true;
    } catch (error) {
      console.warn('[stage] applyAsset 失败', error);
      return false;
    }
  }
  if (item.param && renderer) {
    const setter = typeof renderer.setParameter === 'function' ? renderer.setParameter : (typeof renderer.set === 'function' ? renderer.set : null);
    if (setter) {
      try {
        let target = on;
        if (target === undefined) {
          const getter = typeof renderer.getParameter === 'function' ? renderer.getParameter : (typeof renderer.get === 'function' ? renderer.get : null);
          target = getter ? Number(getter.call(renderer, item.param)) < 0.5 : true;
        }
        setter.call(renderer, item.param, target ? 1 : 0);
        return true;
      } catch (error) {
        console.warn('[stage] 参数兜底写入失败', error);
      }
    }
  }
  return false;
}

/* ───────────────────────────────────────────────────────────────
 * C2 追加导出：一键预设 + 换装持久化（只增不改，面板接这几个即可）
 *
 *   readAssetPresets(module)                预设清单 [{id,label,description,assets,items}]
 *   applyAssetPreset(module,renderer,id)    套用预设，返回 {ok,preset,state,message} / false
 *   currentAssetPreset(module,renderer)     当前命中的预设（高亮用）/ null
 *   saveAssetState(module,renderer)         手动存一次（applyAsset / 预设会自动存，一般不用调）
 *   restoreAssetState(module,renderer)      手动恢复上次换装（一般不用调，getState 会懒恢复）
 *   clearAssetState(module)                 清空存档（当前模型状态不变）
 *   assetStorageInfo(module)                存档概况 {key,available,saved,updatedAt,preset,count}
 * ─────────────────────────────────────────────────────────────── */

/** 预设清单；模块缺席或还没更新到 C2 时返回空数组（面板显示提示即可）。 */
export function readAssetPresets(module) {
  try {
    if (typeof module?.listPresets === 'function') {
      const list = module.listPresets();
      if (Array.isArray(list)) return list;
    }
    if (Array.isArray(module?.PRESETS)) return module.PRESETS;
  } catch (error) {
    console.warn('[stage] listPresets 读取失败', error);
  }
  return [];
}

/** 一键套用预设；返回 { ok, preset, state, message }，失败返回 false。 */
export function applyAssetPreset(module, renderer, presetId) {
  const id = String(presetId ?? '').trim();
  if (!id) return false;
  try {
    if (typeof module?.applyPreset === 'function') return module.applyPreset(renderer, id);
    // 兜底：模块没有预设能力时，按清单逐项 apply（先回默认再覆盖）
    const preset = readAssetPresets(module).find((entry) => entry.id === id || entry.label === id);
    if (!preset) return false;
    if (typeof module?.resetAssets === 'function') module.resetAssets(renderer);
    for (const [key, spec] of Object.entries(preset.assets || {})) {
      if (typeof module?.applyAsset === 'function') module.applyAsset(renderer, key, spec);
    }
    return { ok: true, preset: { id: preset.id, label: preset.label, description: preset.description } };
  } catch (error) {
    console.warn('[stage] applyPreset 失败', error);
    return false;
  }
}

/** 当前状态命中的预设（面板高亮用）；拿不到返回 null。 */
export function currentAssetPreset(module, renderer) {
  try {
    return typeof module?.currentPreset === 'function' ? module.currentPreset(renderer) : null;
  } catch (error) {
    return null;
  }
}

/** 手动存一次换装；返回 { saved, reason?, updatedAt?, preset? } */
export function saveAssetState(module, renderer) {
  const fail = (reason) => ({ saved: false, reason });
  if (!renderer) return fail('renderer-missing');
  try {
    if (typeof module?.saveAssetsState === 'function') return module.saveAssetsState(renderer);
  } catch (error) {
    console.warn('[stage] saveAssetsState 失败', error);
    return fail(String((error && error.message) || error));
  }
  return fail('module-missing');
}

/** 手动恢复上次换装；返回状态对象，没有存档返回 null。 */
export function restoreAssetState(module, renderer) {
  if (!renderer) return null;
  try {
    if (typeof module?.restoreSavedAssets === 'function') return module.restoreSavedAssets(renderer);
  } catch (error) {
    console.warn('[stage] restoreSavedAssets 失败', error);
  }
  return null;
}

/** 清空存档；返回 { cleared, reason? } */
export function clearAssetState(module) {
  try {
    if (typeof module?.clearAssetsState === 'function') return module.clearAssetsState();
  } catch (error) {
    console.warn('[stage] clearAssetsState 失败', error);
    return { cleared: false, reason: String((error && error.message) || error) };
  }
  return { cleared: false, reason: 'module-missing' };
}

/** 存档概况，给面板状态行显示「已记住 21 项 · 居家」/「本次不记忆」。 */
export function assetStorageInfo(module) {
  try {
    if (typeof module?.getAssetsStorageInfo === 'function') return module.getAssetsStorageInfo();
  } catch (error) {
    /* ignore */
  }
  return { key: 'pet.assets.v1', available: false, saved: false, updatedAt: 0, preset: '', count: 0 };
}
