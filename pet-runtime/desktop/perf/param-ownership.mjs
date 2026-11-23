// param-ownership.mjs —— 分层参数所有权的**运行期断言**（2026-11-21 P2）
//
// 要解决的事：`EXTERNALLY_OWNED` / `EXTERNALLY_OWNED_PARAMS` 只回答了
// 「表情层不许碰口型/眼球/头身/呼吸」。可 asset-toggles 手动开关写的是
// key1..key13 / Clothes1..5 / Movement1..3 —— 其中 **key2（流泪）/key7（脸红）/
// key13（流冷汗）这三个参数同时也在 perf 画像里**（profile.mjs 的 blush/tear/sweat 通道）。
// 结果：用户手动点「落泪/脸红/流冷汗」→ 资产层写值并 pin 进 defaults；
//       下一帧 perf 又用自己的 FACS 目标覆盖 defaults → 手动值被改（P2 双写）。
//
// 这张表把「谁拥有什么」从注释变成数据，并提供三个纯函数：
//   ① declaredParamsFor(layer, ctx)   某层声明拥有哪些参数
//   ② checkWriteSet(layer, ids, ctx)  断言「本层写入 ⊆ 声明所有权」
//   ③ filterPinnedParams / writePerfParams  资产 pin 的参数，perf 写前跳过（并计数）
//
// 纯模块：不 require fs / electron / DOM。
//
// 所有权语义（2026-11-21 用户拍板「手动 > 自动」）：
//   · 资产层是**手动操作**；一旦某个资产被手动打开（值 ≥ 0.5），它 pin 的参数
//     就归资产层，perf 不得覆盖，直到用户把它关掉（值 < 0.5 即交还）。
//   · 只有 key2/key7/key13 与 perf 有交集；其余 key/Clothes/Movement 本来就只有
//     资产层在写，列进来是为了让「写入 ⊆ 声明」这条断言能覆盖整张表。

/** 资产层拥有的全部参数（asset-toggles.mjs 的 21 个开关） */
export const ASSET_PARAM_NAMES = Object.freeze([
  'Clothes1', 'Clothes2', 'Clothes3', 'Clothes4', 'Clothes5',
  'Movement1', 'Movement2', 'Movement3',
  'key1', 'key2', 'key3', 'key4', 'key5', 'key6', 'key7', 'key8', 'key9',
  'key10', 'key11', 'key12', 'key13',
]);

export const ASSET_PARAM_SET = new Set(ASSET_PARAM_NAMES);

/**
 * perf 与资产层**共享**的参数：手动打开时归资产层（perf 跳过），
 * 未手动打开时 perf 可写（情绪脸红/泪/汗仍然要有）。
 * value = 对应的资产 id（诊断文案用）。
 */
export const SHARED_ASSET_PARAMS = Object.freeze({
  key2: 'face-tears',
  key7: 'face-blush',
  key13: 'face-sweat',
});

export const SHARED_ASSET_PARAM_SET = new Set(Object.keys(SHARED_ASSET_PARAMS));

export const OWNERSHIP_LAYER = Object.freeze({
  PERF: 'perf',
  ASSET: 'asset-toggles',
  CLIP: 'clip',
  V2: 'v2',
  SCENES: 'scenes',
  EMOTION: 'emotion',
  CHOREO: 'choreo',
});

/**
 * 某层声明拥有的参数集合。
 *
 * perf / clip 的声明来自**画像**（profile.usedParams）：画像里出现的参数才算本层拥有。
 * asset-toggles 的声明是上面的 21 个开关。
 * 其它层（v2/scenes/choreo）的轨道是离线编译数据，调用方传 ctx.params 显式声明。
 *
 * @param {string} layer
 * @param {{profile?:{usedParams?:string[]}, params?:Iterable<string>}} [ctx]
 * @returns {Set<string>}
 */
export function declaredParamsFor(layer, ctx = {}) {
  const name = String(layer || '');
  if (name === OWNERSHIP_LAYER.PERF || name === OWNERSHIP_LAYER.CLIP) {
    const used = ctx && ctx.profile && Array.isArray(ctx.profile.usedParams) ? ctx.profile.usedParams : [];
    return new Set(used.map(String));
  }
  if (name === OWNERSHIP_LAYER.ASSET) return new Set(ASSET_PARAM_NAMES);
  const explicit = ctx && ctx.params ? Array.from(ctx.params).map(String) : [];
  return new Set(explicit);
}

/**
 * 断言「本层写入 ⊆ 声明所有权」。
 * @param {string} layer
 * @param {Iterable<string>|Record<string,unknown>} ids 本帧写入的参数 id
 * @param {object} [ctx]
 * @returns {{layer:string, ok:boolean, declared:string[], undeclared:string[]}}
 */
export function checkWriteSet(layer, ids, ctx = {}) {
  const declared = declaredParamsFor(layer, ctx);
  const list = ids instanceof Set ? Array.from(ids)
    : Array.isArray(ids) ? ids
    : ids && typeof ids === 'object' ? Object.keys(ids)
    : [];
  const undeclared = [];
  for (const raw of list) {
    const id = String(raw);
    if (!declared.has(id)) undeclared.push(id);
  }
  return { layer: String(layer || ''), ok: undeclared.length === 0, declared: Array.from(declared), undeclared };
}

/**
 * 从 defaults 的「外部改动」推断资产 pin（宿主的换装 UI 不走 asset-toggles）。
 *
 * 为什么需要它：生产里点「落泪/脸红/流冷汗」的是 live-2d 的 ui-controller.js，
 * 它有自己的 writeAssetParam（直接写 defaults），**不会**调用 asset-toggles 的
 * pinParameter —— 它的 pinned 集合是空的。不能改 live-2d 源码，就在 perf 写之前
 * 对比「上一帧 perf 自己写进去的值」与「此刻 defaults 里的值」：
 *   · 被人改成 ≥0.5 → 视为手动 pin，perf 让位；
 *   · 被人改回 <0.5 → 视为交还，perf 恢复写入。
 * 这样 asset-toggles 路径与宿主 UI 路径落到同一套所有权语义。
 *
 * @param {{defaults:number[]|Float32Array, indices:Map<string,number>,
 *          previous:Map<string,number>, pinned:Set<string>,
 *          candidates:Iterable<string>, epsilon?:number}} input
 * @returns {{detected:string[], released:string[]}}
 */
export function detectExternalPins(input) {
  const { defaults, indices, previous, pinned, candidates } = input || {};
  const epsilon = Number.isFinite(input && input.epsilon) ? input.epsilon : 0.05;
  const detected = [];
  const released = [];
  if (!defaults || typeof defaults.length !== 'number' || !indices || typeof indices.get !== 'function'
    || !(previous instanceof Map) || !(pinned instanceof Set)) {
    return { detected, released };
  }
  for (const raw of candidates || []) {
    const id = String(raw);
    const idx = indices.get(id);
    if (idx === undefined || idx === null) continue;
    const current = Number(defaults[idx]);
    if (!Number.isFinite(current)) continue;
    const last = previous.get(id);
    const changed = last === undefined ? current >= 0.5 : Math.abs(current - last) > epsilon;
    if (!changed) continue;
    if (current >= 0.5) {
      if (!pinned.has(id)) { pinned.add(id); detected.push(id); }
      previous.set(id, current);
    } else {
      if (pinned.has(id)) { pinned.delete(id); released.push(id); }
      previous.set(id, current);
    }
  }
  return { detected, released };
}

/**
 * 把「资产 pin 的参数」从 perf 的目标里摘掉。
 *
 * @param {Record<string, number>|Map<string, number>} params perf 本帧目标
 * @param {Set<string>|Iterable<string>|null|undefined} pinned 资产层已 pin 的参数
 * @returns {{accepted: Record<string, number>, skippedPinned: string[]}}
 */
export function filterPinnedParams(params, pinned) {
  const accepted = {};
  const skippedPinned = [];
  const pinSet = pinned instanceof Set ? pinned : new Set(pinned ? Array.from(pinned) : []);
  if (!params) return { accepted, skippedPinned };
  const entries = params instanceof Map ? [...params.entries()] : Object.entries(params);
  for (const [id, raw] of entries) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (pinSet.has(String(id))) { skippedPinned.push(String(id)); continue; }
    accepted[String(id)] = value;
  }
  return { accepted, skippedPinned };
}

/**
 * 把 perf 目标写进 renderer.defaults（跨帧基线），资产 pin 的参数跳过。
 *
 * 为什么单独一个函数：petbody-entry 里的 applyPerfParams 还要做物理后提交、
 * 越权告警等，但「哪几个参数真的写了 / 哪几个因为 pin 被跳过」是纯逻辑，
 * 放在这里才能被 node 单测钉住（P2 的核心断言）。
 *
 * @param {{params:object|Map, indices:Map<string,number>, defaults:number[],
 *          pinned?:Set<string>|Iterable<string>, drift?:number}} input
 * @returns {{written:string[], missing:string[], skippedPinned:string[], accepted:Record<string,number>}}
 */
export function writePerfParams(input) {
  const { params, indices, defaults, pinned, drift = 0 } = input || {};
  const { accepted, skippedPinned } = filterPinnedParams(params, pinned);
  const written = [];
  const missing = [];
  if (indices && typeof indices.get === 'function' && defaults && typeof defaults.length === 'number') {
    for (const [id, value] of Object.entries(accepted)) {
      const idx = indices.get(id);
      if (idx === undefined || idx === null) { missing.push(id); continue; }
      defaults[idx] = value + drift * Math.min(1, Math.abs(value) + 0.2);
      written.push(id);
    }
  } else {
    missing.push(...Object.keys(accepted));
  }
  return { written, missing, skippedPinned, accepted };
}
