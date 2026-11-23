/**
 * ui/assets-bridge.mjs — 换装桥：把「宿主 petBody」和「我们自己的 renderer」统一成一套调用。
 *
 * 两套宿主（同一个页面里可能只命中一种）：
 *   1) my-neuro 宿主：页面里 window.petBody 由 petbody 驱动创建，window.petAssets 是
 *      打包进 petbody.js 的 asset-toggles 全局 API（同一份实现，不重复打包）。
 *   2) 自己的 Electron 桌宠：没有 petBody，A 的 stage 传入 { module, renderer }（老路径）。
 *
 * 设计约束：
 *   - 本文件不 import asset-toggles（否则会被 esbuild 再打一份目录，出现两套状态）；
 *     一律优先用 window.petAssets，其次用调用方传入的 module。
 *   - 所有函数都不抛错：宿主/渲染器没就绪时返回 null / false / []，面板照常渲染。
 *
 * 典型用法（A 的面板）：
 *   const ctx = { module: state.assets.module, renderer };
 *   await waitForHostBody(ctx);            // my-neuro 里等 petBody 就绪；桌宠里立刻返回
 *   ensureRestored(ctx);                   // 恢复上次换装（幂等）
 *   applyAssetVia(ctx, 'glasses-frame');   // 翻转一个开关
 *   readCurrentPreset(ctx)?.label;         // 当前预设高亮
 *   const stop = subscribeHost(ctx, () => refresh());  // 换皮/就绪后刷新
 */

/** 宿主里的资产 API（window.petAssets，由 petbody bundle 暴露） */
export function hostApi(scope = globalThis) {
  try {
    const api = scope && scope.petAssets;
    return api && typeof api.getState === 'function' ? api : null;
  } catch (error) { return null; }
}

/** 宿主里的 petBody 对象（my-neuro 驱动初始化后设置） */
export function getPetBody(scope = globalThis) {
  try {
    const body = scope && scope.petBody;
    return body && typeof body === 'object' ? body : null;
  } catch (error) { return null; }
}

/** 宿主渲染器：petBody.renderer（兼容 getRenderer()），没有就返回 null */
export function getHostRenderer(scope = globalThis) {
  const body = getPetBody(scope);
  const renderer = body && (body.renderer || (typeof body.getRenderer === 'function' ? body.getRenderer() : null));
  return renderer && typeof renderer === 'object' ? renderer : null;
}

/** 宿主渲染器是否已经 ready（ready === false 表示还在加载） */
export function isHostReady(scope = globalThis) {
  const renderer = getHostRenderer(scope);
  return !!renderer && renderer.ready !== false;
}

function normalizeCtx(ctx) {
  if (ctx && typeof ctx === 'object') return ctx;
  return { scope: globalThis, module: null, renderer: null };
}

function pickApi(ctx) {
  const c = normalizeCtx(ctx);
  return hostApi(c.scope) || (c.module && typeof c.module.getState === 'function' ? c.module : null);
}

function pickRenderer(ctx) {
  const c = normalizeCtx(ctx);
  const hostRenderer = getHostRenderer(c.scope);
  if (hostRenderer) return hostRenderer;
  const renderer = c.renderer;
  return renderer && typeof renderer === 'object' ? renderer : null;
}

/** 当前模式：'petbody'（宿主）/ 'local'（自己的渲染器）/ 'none'（都没有） */
export function bridgeMode(ctx) {
  const c = normalizeCtx(ctx);
  if (getPetBody(c.scope) || hostApi(c.scope)) return 'petbody';
  return pickRenderer(c) || pickApi(c) ? 'local' : 'none';
}

/** 等宿主 petBody 就绪；桌宠（没有 petBody）或已就绪时立刻返回。返回 {body,renderer} 或 null */
export function waitForHostBody(ctx, options = {}) {
  const c = normalizeCtx(ctx);
  const scope = c.scope || globalThis;
  const interval = Math.max(50, Number(options.interval) || 200);
  const timeout = Math.max(0, Number(options.timeout) || 20000);
  const immediate = () => {
    const body = getPetBody(scope);
    if (!body) return null;
    const renderer = getHostRenderer(scope);
    if (!renderer || renderer.ready === false) return null;
    return { body, renderer };
  };
  const ready = immediate();
  if (ready) return Promise.resolve(ready);
  if (!getPetBody(scope) && pickRenderer(c)) return Promise.resolve({ body: null, renderer: pickRenderer(c) });
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const hit = immediate();
      if (hit) { clearInterval(timer); resolve(hit); return; }
      if (Date.now() - started >= timeout) { clearInterval(timer); resolve(null); }
    }, interval);
  });
}

/** 恢复上次换装（幂等；每个渲染器只恢复一次）。返回 true 表示本次真的写了存档。 */
export function ensureRestored(ctx) {
  const c = normalizeCtx(ctx);
  const api = pickApi(c);
  const renderer = pickRenderer(c);
  const scope = c.scope || globalThis;
  try {
    const body = getPetBody(scope);
    if (body && typeof body.restoreAssets === 'function') { body.restoreAssets(); return true; }
    if (api && typeof api.restoreSavedAssets === 'function' && renderer) { api.restoreSavedAssets(renderer); return true; }
    if (api && typeof api.getState === 'function' && renderer) { api.getState(renderer); return true; } // getState 会懒恢复
  } catch (error) {
    console.warn('[assets-bridge] 恢复换装失败', error);
  }
  return false;
}

/** 读全部资产状态；拿不到返回 {} */
export function readState(ctx) {
  const c = normalizeCtx(ctx);
  const api = pickApi(c);
  const renderer = pickRenderer(c);
  try {
    if (api && typeof api.getState === 'function') return api.getState(renderer) || {};
    const body = getPetBody(c.scope);
    if (body && typeof body.assets === 'function') return body.assets() || {};
  } catch (error) { /* ignore */ }
  return {};
}

/** 应用一个资产（on 省略 = 翻转）；返回状态对象或 null */
export function applyAssetVia(ctx, id, on) {
  const c = normalizeCtx(ctx);
  const api = pickApi(c);
  const renderer = pickRenderer(c);
  try {
    if (api && typeof api.applyAsset === 'function') return api.applyAsset(renderer, id, on) || null;
    const body = getPetBody(c.scope);
    if (body && typeof body.asset === 'function') return body.asset(id, on) || null;
  } catch (error) {
    console.warn('[assets-bridge] 应用资产失败', error);
  }
  return null;
}

/** 预设清单；拿不到返回 [] */
export function readPresets(ctx) {
  const c = normalizeCtx(ctx);
  const api = pickApi(c);
  try {
    if (api && typeof api.listPresets === 'function') return api.listPresets() || [];
    const body = getPetBody(c.scope);
    if (body && typeof body.presets === 'function') return body.presets() || [];
  } catch (error) { /* ignore */ }
  return [];
}

/** 套用一个预设；返回 {ok,preset,state,message} 或 null */
export function applyPresetVia(ctx, id) {
  const c = normalizeCtx(ctx);
  const api = pickApi(c);
  const renderer = pickRenderer(c);
  try {
    if (api && typeof api.applyPreset === 'function') return api.applyPreset(renderer, id) || null;
    const body = getPetBody(c.scope);
    if (body && typeof body.preset === 'function') return body.preset(id) || null;
  } catch (error) {
    console.warn('[assets-bridge] 套预设失败', error);
  }
  return null;
}

/** 当前命中的预设（{id,label,description} 或 null），面板高亮用 */
export function readCurrentPreset(ctx) {
  const c = normalizeCtx(ctx);
  const api = pickApi(c);
  const renderer = pickRenderer(c);
  try {
    const body = getPetBody(c.scope);
    if (body && typeof body.currentPreset === 'function') return body.currentPreset() || null;
    if (api && typeof api.currentPreset === 'function') return api.currentPreset(renderer) || null;
  } catch (error) { /* ignore */ }
  return null;
}

/** 存档概况（含 backend/persistent：能看出是不是降级到宿主内存） */
export function readStorageInfo(ctx) {
  const c = normalizeCtx(ctx);
  const api = pickApi(c);
  try {
    const body = getPetBody(c.scope);
    if (body && typeof body.assetStorage === 'function') return body.assetStorage() || null;
    if (api && typeof api.getAssetsStorageInfo === 'function') return api.getAssetsStorageInfo() || null;
  } catch (error) { /* ignore */ }
  return null;
}

/** 启动宿主自恢复（幂等）；桌宠里返回 false */
export function startHostSync(ctx, options = {}) {
  const c = normalizeCtx(ctx);
  const scope = c.scope || globalThis;
  try {
    const api = hostApi(scope);
    if (api && typeof api.startHostAssetSync === 'function') return api.startHostAssetSync({ scope, ...options });
  } catch (error) { /* ignore */ }
  return false;
}

/** 监听宿主 petBody / 渲染器变化（就绪、换皮），返回取消函数 */
export function subscribeHost(ctx, listener, options = {}) {
  const c = normalizeCtx(ctx);
  const scope = c.scope || globalThis;
  if (typeof listener !== 'function') return () => {};
  const interval = Math.max(100, Number(options.interval) || 800);
  let lastBody = getPetBody(scope);
  let lastRenderer = getHostRenderer(scope);
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const body = getPetBody(scope);
    const renderer = getHostRenderer(scope);
    if (body === lastBody && renderer === lastRenderer) return;
    lastBody = body; lastRenderer = renderer;
    try { listener({ body, renderer, ready: isHostReady(scope) }); } catch (error) { console.warn('[assets-bridge] 订阅回调失败', error); }
  }, interval);
  return () => { stopped = true; clearInterval(timer); };
}

/** 调试摘要：一眼看出面板现在挂在哪儿 */
export function describeBridge(ctx) {
  const c = normalizeCtx(ctx);
  const body = getPetBody(c.scope);
  const renderer = getHostRenderer(c.scope) || (c.renderer || null);
  return {
    mode: bridgeMode(c),
    hasBody: !!body,
    hasGlobalApi: !!hostApi(c.scope),
    hasModule: !!(c.module && typeof c.module.getState === 'function'),
    rendererReady: !!(renderer && renderer.ready !== false),
    preset: (readCurrentPreset(c) || {}).id || '',
    storage: readStorageInfo(c),
  };
}
