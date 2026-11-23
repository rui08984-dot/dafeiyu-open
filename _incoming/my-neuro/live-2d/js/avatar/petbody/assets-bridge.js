// js/avatar/petbody/assets-bridge.js —— 宿主侧换装桥（my-neuro 页面）
//
// 职责（在宿主页面里 require 一次就够，重复 require 由 require cache 保证）：
//   1) 等驱动初始化完成（driver.js 会设置 global.petBody）→ 等渲染器 ready →
//      调 window.petAssets.restoreSavedAssets(renderer) 把上次换装恢复回来。
//      提前恢复没用：骨架每帧会把参数重置成 defaults，必须等 ready 之后写，才钉得住。
//   2) 把当前预设名同步给宿主：window.petBody.currentPreset?.() / presetName?.()，
//      面板高亮不用自己猜。
//   3) 暴露 global.petAssetsBridge 给面板 / HTTP 服务：
//      status() / restoreNow() / state() / presets() / preset(id) / asset(id,on) / storage()
//   4) 换皮（renderer 换成新实例）后自动再恢复一次。
//
// 存档位置：页面 localStorage 的 'pet.assets.v1'（file:// origin，同一个 Electron profile 持久）。
// localStorage 不可用时 asset-toggles 会降级到 petBody 内存（本次会话有效），storage() 里能看出来。
//
// 换装逻辑本体在 build/petbody.js 打包的 asset-toggles.mjs（window.petAssets），
// 这里不复制 21 个开关的目录数据，避免两套状态。

const __silentAudit = require('../../core/silent-audit.js');
const fs = require("fs");
const path = require("path");

const LOG = path.resolve(__dirname, "../../../../..", "petbody-assets.log");
const INTERVAL_MS = 800;
// ⚠ 原来这里是 `const MAX_LINES = 400;` 但**全文件从未使用** —— 又一个「写了没接线」。
// 400 行 ≈ 16KB，而换装日志会一直涨；改成和其它日志一致的大小轮转（2026-11-13）。
const LOG_MAX_BYTES = 512 * 1024;
let logBytes = 0;
try { logBytes = fs.statSync(LOG).size; } catch (e) { logBytes = 0; }

function dbg(message) {
  try {
    const line = new Date().toISOString().slice(11, 19) + " " + message + "\n";
    if (logBytes > LOG_MAX_BYTES) {
      try { fs.unlinkSync(LOG + ".1"); } catch (e) { /* 没有旧的 */ }
      try { fs.renameSync(LOG, LOG + ".1"); } catch (e) { /* 改名失败不影响换装 */ }
      logBytes = 0;
    }
    fs.appendFileSync(LOG, line);
    logBytes += Buffer.byteLength(line);
  } catch (error) { try { __silentAudit.audit('assets-bridge.js:29', error); } catch (e2) {} }
}

function logInfo(message) {
  dbg(message);
  try {
    const { logToTerminal } = require("../../api-utils.js");
    logToTerminal("info", "[PetBodyAssets] " + message);
  } catch (error) { try { __silentAudit.audit('assets-bridge.js:37', error); } catch (e2) {} }
}

// 宿主页面里 window 和 node 的 global 是同一个对象（contextIsolation:false + nodeIntegration:true），
// 但为了在别的地方 require 也不炸，两个都兜住。
function host() {
  if (typeof window !== "undefined" && window) return window;
  if (typeof global !== "undefined" && global) return global;
  return {};
}

function api() {
  const g = host();
  const found = g.petAssets || (typeof global !== "undefined" ? global.petAssets : null);
  return found && typeof found.getState === "function" ? found : null;
}

function petBody() {
  const g = host();
  const body = g.petBody || (typeof global !== "undefined" ? global.petBody : null);
  return body && typeof body === "object" ? body : null;
}

function rendererOf(body) {
  if (!body) return null;
  const renderer = body.renderer || (typeof body.getRenderer === "function" ? body.getRenderer() : null);
  return renderer && typeof renderer === "object" ? renderer : null;
}

const state = {
  started: false,
  timer: null,
  lastRenderer: null,
  lastRestoreAt: 0,
  lastPreset: "",
  lastBackend: "unknown",
  restores: 0,
  errors: 0,
  lastError: "",
  lastAssetsSig: "",   // 资产状态签名：变了才回传，避免每 800ms 白刷一条
};

// ── 资产状态回传（2026-11-13）───────────────────────────────────────────────
// 为什么要补这一段：8103 的 inner WS 里一直有 `asset-applied` 的**接收分支**，
// 但全仓库没有发送方 —— 所以 /state 的 assetStates 恒 null，assets 只有人手动
// POST /asset 才有值。等于「控制面板/脚本想看现在穿着什么」这件事是死的。
// 数据源用 window.petAssets.listAssetStates(renderer)（就是协议层要的
// [{id,on,value,optionId,…}] 形态）；通道复用 driver 的 __petInnerSend —— 不新开
// 连接（8103 按连接广播，多一条会让每条指令收两遍）。
function publishAssetStates(a, renderer) {
  try {
    const send = host().__petInnerSend;
    if (typeof send !== "function") return false;
    if (!a || typeof a.listAssetStates !== "function") return false;
    const states = a.listAssetStates(renderer);
    if (!Array.isArray(states) || !states.length) return false;
    const sig = states.map((s) => s.id + ":" + (s.on ? 1 : 0) + ":" + (s.optionId || "")).join("|");
    if (sig === state.lastAssetsSig) return false;
    const first = !state.lastAssetsSig;
    state.lastAssetsSig = sig;
    send({ type: "asset-applied", states });
    if (first) dbg("asset-applied 首发 " + states.length + " 项");
    return true;
  } catch (error) {
    state.errors += 1;
    state.lastError = String((error && error.message) || error);
    if (state.errors <= 3) dbg("asset-applied 失败: " + state.lastError);
    return false;
  }
}

function decorate(body, renderer) {
  if (!body || !renderer) return false;
  const fields = {
    currentPreset: () => api()?.currentPreset?.(renderer) ?? null,
    presetName: () => api()?.currentPresetName?.(renderer) ?? "",
    restoreAssets: () => api()?.restoreSavedAssets?.(renderer) ?? null,
    assetStorage: () => api()?.getAssetsStorageInfo?.() ?? null,
  };
  let changed = false;
  for (const [name, fn] of Object.entries(fields)) {
    if (typeof body[name] === "function") continue;
    try {
      Object.defineProperty(body, name, { value: fn, configurable: true, writable: true, enumerable: false });
      changed = true;
    } catch (error) {
      try { body[name] = fn; changed = true; } catch (e2) { /* ignore */ }
    }
  }
  return changed;
}

function tick() {
  try {
    const a = api();
    const body = petBody();
    const renderer = rendererOf(body);
    if (!a || !body || !renderer) return;
    if (renderer.ready === false) return; // 等渲染器 ready，否则写进去会被 defaults 覆盖
    // 资产状态变化就回传（800ms 一次比对，签名没变直接 return，不刷通道）
    publishAssetStates(a, renderer);
    decorate(body, renderer);
    if (renderer === state.lastRenderer) return;
    state.lastRenderer = renderer;
    const info = a.getAssetsStorageInfo?.() || {};
    state.lastBackend = info.backend || "unknown";
    // restoreSavedAssets 内部会处理「没有存档 / 已恢复过」两种空操作
    const restored = a.restoreSavedAssets?.(renderer) ?? null;
    state.lastPreset = a.currentPresetName?.(renderer) || "";
    state.lastRestoreAt = Date.now();
    state.restores += 1;
    const summary = {
      type: "petbody-assets-restored",
      restored: !!restored,
      preset: state.lastPreset,
      backend: state.lastBackend,
      persistent: info.persistent !== false,
      count: info.count || 0,
    };
    dbg("restored " + JSON.stringify(summary));
    // 复用驱动已经接好的调试通道（driver.js 里设置 global.__petBodyReport）
    try {
      const report = host().__petBodyReport;
      if (typeof report === "function") report(summary);
    } catch (error) { try { __silentAudit.audit('assets-bridge.js:129', error); } catch (e2) {} }
    if (state.restores === 1) {
      logInfo("已接管换装持久化：backend=" + state.lastBackend + " preset=" + (state.lastPreset || "自定义") + (restored ? "（已恢复上次换装）" : "（暂无存档）"));
    }
  } catch (error) {
    state.errors += 1;
    state.lastError = String((error && error.message) || error);
    if (state.errors <= 3) dbg("tick error: " + state.lastError);
  }
}

function attach(options = {}) {
  if (state.started) return status();
  state.started = true;
  const interval = Math.max(200, Number(options.interval) || INTERVAL_MS);
  tick();
  state.timer = setInterval(tick, interval);
  try { state.timer.unref?.(); } catch (error) { try { __silentAudit.audit('assets-bridge.js:146', error); } catch (e2) {} }
  dbg("attach interval=" + interval);
  return status();
}

function detach() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
  state.lastRenderer = null;
  return status();
}

function status() {
  const a = api();
  const body = petBody();
  const renderer = rendererOf(body);
  return {
    started: state.started,
    hasApi: !!a,
    hasPetBody: !!body,
    rendererReady: !!(renderer && renderer.ready !== false),
    restores: state.restores,
    lastRestoreAt: state.lastRestoreAt,
    preset: state.lastPreset,
    backend: state.lastBackend,
    errors: state.errors,
    lastError: state.lastError,
    storage: (a && a.getAssetsStorageInfo?.()) || null,
  };
}

function restoreNow() {
  const a = api();
  const renderer = rendererOf(petBody());
  if (!a || !renderer) return null;
  const restored = a.restoreSavedAssets?.(renderer) ?? null;
  state.lastPreset = a.currentPresetName?.(renderer) || "";
  dbg("restoreNow preset=" + state.lastPreset);
  return restored;
}

const bridge = {
  attach,
  detach,
  tick,
  status,
  restoreNow,
  state: () => {
    const a = api();
    const renderer = rendererOf(petBody());
    return a && renderer ? a.getState(renderer) : {};
  },
  stateList: () => {
    const a = api();
    const renderer = rendererOf(petBody());
    return a && renderer ? a.listAssetStates(renderer) : [];
  },
  presets: () => api()?.listPresets?.() || [],
  currentPreset: () => api()?.currentPreset?.(rendererOf(petBody())) || null,
  preset: (id) => {
    const a = api();
    const renderer = rendererOf(petBody());
    if (!a || !renderer) return null;
    const result = a.applyPreset?.(renderer, id) || null;
    state.lastPreset = a.currentPresetName?.(renderer) || "";
    dbg("preset " + id + " -> " + (result?.ok ? "ok" : "fail"));
    return result;
  },
  asset: (id, on) => {
    const a = api();
    const renderer = rendererOf(petBody());
    if (!a || !renderer) return null;
    const result = a.applyAsset?.(renderer, id, on) || null;
    state.lastPreset = a.currentPresetName?.(renderer) || "";
    return result;
  },
  storage: () => api()?.getAssetsStorageInfo?.() || null,
  clear: () => api()?.clearAssetsState?.() || null,
};

try {
  const g = host();
  if (!g.petAssetsBridge) g.petAssetsBridge = bridge;
  if (typeof global !== "undefined" && !global.petAssetsBridge) global.petAssetsBridge = bridge;
} catch (error) { try { __silentAudit.audit('assets-bridge.js:231', error); } catch (e2) {} }

attach();

module.exports = bridge;
