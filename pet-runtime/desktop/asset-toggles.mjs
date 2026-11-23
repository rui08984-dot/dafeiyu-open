/**
 * asset-toggles.mjs — 皮套自带的按键 / 服饰开关 / 手势，做成可编程资产（纯数据 + 纯逻辑）
 *
 * 事实基线（实测，见 docs/plans/2026-10-31-桌宠达标-plan.md 与 _incoming/probe/c-*.png）：
 *   - 参数全是 0..1 开关，骨架默认值：Clothes1=1（短裙）、Clothes5=1（有尾巴），其余 0。
 *   - key1 黑脸 / key2 落泪 / key3 圈圈眼 / key4 爱心眼 / key5 ＞＜眼 / key6 屑屑眼 / key7 脸红
 *     / key8 加载 / key9 大牙 / key10 大钢盆 / key11 黑框眼镜 / key12 单片眼镜 / key13 流冷汗。
 *   - Clothes1 长短裙(1=短裙,0=长裙) / Clothes2 大小变(0=大鱼,0.4=中鱼,1=小鱼)
 *     / Clothes3 胸口衣服(1=加层) / Clothes4 鞋子(1=脱鞋) / Clothes5 尾巴(1=有)。
 *   - Movement1 狗尾草 / Movement2 抚胸 / Movement3 竖食指。
 *
 * 对外契约（A 的 UI / Lead 的 VTS 协议都按这个接，别改签名）：
 *   TOGGLES                    资产清单：{id,label,group,groupLabel,param,kind,default,options?,exclusive?,onLabel?,offLabel?,aliases?,note?}
 *   GROUPS                     分组清单：{id,label}
 *   listAssets(groupId?)       清单的防御性拷贝（UI 直接渲染）
 *   listGroups()               带条目的分组
 *   findAsset(idOrLabel)       按 id / 中文名 / 参数名 / 别名查（找不到返回 null）
 *   applyAsset(renderer,id,on) 应用一个资产，返回应用后的状态（含 message，可直接冒泡）
 *                             on 省略 / null / 'flip' = 翻转（toggle）或下一档（cycle）
 *                             true = 开 或 下一档；false = 关 或 上一档；cycle 还接受档位 id / 中文名 / 索引
 *   getState(renderer)         全部资产当前状态（按 id 建索引）
 *   getAssetState(renderer,id) 单个资产状态
 *   setAssets(renderer,map)    批量应用 {id:on}
 *   resetAssets(renderer)      全部回到皮套默认
 *   snapshotAssets(renderer)   快照 {id:value}
 *   restoreAssets(renderer,snap) 还原快照（不受互斥影响，逐值写回）
 *   assetHotkeys()             model-info 用的热键描述（kind:'asset'）
 *   ASSET_PARAMS               21 个开关的参数名集合
 *   listAssetStates(renderer)  状态数组形态（[{id,on,value,optionId,optionLabel,…}]，协议层回传真实档位用）
 *
 * 持久化（换装记得住）：
 *   ASSETS_STORAGE_KEY         localStorage key = 'pet.assets.v1'
 *   saveAssetsState(renderer)  写存档（applyAsset / setAssets / resetAssets / applyPreset 会自动写）
 *   readSavedAssetsState()     读存档里的 21 个值；没有存档返回 null
 *   restoreSavedAssets(renderer)  手动恢复（一般不用调：getState / applyAsset 会懒恢复一次）
 *   clearAssetsState()         清空存档（当前模型状态不变）
 *   getAssetsStorageInfo()     存档概况 {available,saved,updatedAt,preset,count}
 *   setAssetsStorage(storage)  换存储后端（测试 / 特殊环境用）
 *   存储不可用（隐私模式 / file:// 被策略禁用）时全部降级为「记不住但不报错」。
 *
 * 一键预设：
 *   PRESETS                    女仆装(默认) / 居家 / 演出 / 摸鱼
 *   listPresets()              预设清单拷贝（含 items 摘要，UI 直接渲染一排按钮）
 *   findPreset(idOrLabel)      按 id / 中文名查
 *   applyPreset(renderer,id)   回默认 → 套预设 → 落盘，返回 {ok,preset,state,message}
 *   currentPreset(renderer)    当前状态命中的预设（不命中 null），面板高亮用
 *
 * 渲染层适配（不改渲染层代码，只用它已有的公开面）：
 *   写值：renderer.setParameter(id,v) -> renderer.set(id,v) -> renderer.setParameterValueById(id,v)
 *   跨帧存活：cubism-renderer.updateView() 每帧会把全部参数重置为 defaults（第 232 行），所以写值之后
 *   必须同时把值钉进 defaults（renderer.defaults[renderer.parameterIndices.get(param)]）。
 *   外观类参数（眼镜/服饰/手势）还会被 captureAppearance() 每帧回写，钉 defaults 同样成立。
 *   渲染层没有 defaults / parameterIndices 时退化为把参数登记进 appearanceParameters。
 *
 * 注意：key1..key7、key13 在渲染层属于 expressionParameters，走 blendParameters 缓动（约 0.1s~0.5s 收敛），
 * 所以按下去不会瞬变，这是 B 的动作层的既定行为，不是本模块丢值。
 */

import { ASSET_PARAM_SET } from './perf/param-ownership.mjs';

/** 分组目录（顺序即 UI 渲染顺序） */
export const GROUPS = [
  { id: 'clothes', label: '服饰' },
  { id: 'form', label: '形态' },
  { id: 'glasses', label: '眼镜' },
  { id: 'headwear', label: '头饰' },
  { id: 'gesture', label: '手势' },
  { id: 'expression', label: '表情件' },
];

const GROUP_LABEL = new Map(GROUPS.map((group) => [group.id, group.label]));

/** 资产统一带上分组中文名，UI 不用再查表 */
function defineAsset(spec) {
  const groupLabel = GROUP_LABEL.get(spec.group);
  if (!groupLabel) throw new Error('资产 ' + spec.id + ' 的分组不存在：' + spec.group);
  return Object.assign({}, spec, { groupLabel });
}

/**
 * 资产清单。
 *  - kind:'toggle' 的 default 是皮套骨架默认值（0 或 1），onLabel/offLabel 描述开/关时的样子。
 *  - kind:'cycle' 的 options 是可选档位，default 必须等于某个档位的 value。
 *  - exclusive 相同的资产互斥，开一个会自动关掉同组的其它资产。
 */
export const TOGGLES = [
  // ---------- 服饰 ----------
  defineAsset({
    id: 'clothes-skirt', label: '长短裙', group: 'clothes', param: 'Clothes1', kind: 'toggle', default: 1,
    onLabel: '短裙', offLabel: '长裙', aliases: ['裙子', '裙长', '短裙', '长裙', '裙子切换'],
    note: '开=短裙（默认），关=长裙；对应皮套表情「裙子切换」。',
  }),
  defineAsset({
    id: 'clothes-chest', label: '胸口衣服', group: 'clothes', param: 'Clothes3', kind: 'toggle', default: 0,
    onLabel: '加层', offLabel: '默认', aliases: ['胸口', '胸衣', '上衣'],
    note: '开=胸口多一层衣服（遮得更多），关=皮套原本的样子。',
  }),
  defineAsset({
    id: 'clothes-shoes', label: '脱鞋', group: 'clothes', param: 'Clothes4', kind: 'toggle', default: 0,
    onLabel: '光脚', offLabel: '穿鞋', aliases: ['鞋子', '鞋', '脱鞋', '光脚'],
    note: '开=脱鞋（光脚），关=穿鞋（默认）；对应皮套表情「脱鞋」。',
  }),
  defineAsset({
    id: 'clothes-tail', label: '尾巴', group: 'clothes', param: 'Clothes5', kind: 'toggle', default: 1,
    onLabel: '有尾巴', offLabel: '无尾巴', aliases: ['鲸尾', '尾', '尾巴开关'],
    note: '开=有鲸鱼尾巴（默认），关=收起来；对应皮套表情「尾巴开关」。',
  }),

  // ---------- 形态 ----------
  defineAsset({
    id: 'form-size', label: '大小变', group: 'form', param: 'Clothes2', kind: 'cycle', default: 0,
    options: [
      { id: 'big', label: '大鱼', value: 0 },
      { id: 'mid', label: '中鱼', value: 0.4 },
      { id: 'small', label: '小鱼', value: 1 },
    ],
    aliases: ['体型', '大小', '大鱼', '中鱼', '小鱼', 'size'],
    note: '大鱼=0（默认体型）/ 中鱼=0.4（体型1）/ 小鱼=1（体型2）；按一次切下一档。',
  }),

  // ---------- 眼镜（互斥）----------
  defineAsset({
    id: 'glasses-frame', label: '黑框眼镜', group: 'glasses', param: 'key11', kind: 'toggle', default: 0,
    exclusive: 'glasses', onLabel: '戴上', offLabel: '摘下', aliases: ['眼镜', '黑框'],
    note: '与单片眼镜互斥。',
  }),
  defineAsset({
    id: 'glasses-monocle', label: '单片眼镜', group: 'glasses', param: 'key12', kind: 'toggle', default: 0,
    exclusive: 'glasses', onLabel: '戴上', offLabel: '摘下', aliases: ['单片', '单片镜'],
    note: '与黑框眼镜互斥。',
  }),

  // ---------- 头饰 ----------
  defineAsset({
    id: 'headwear-pot', label: '大钢盆', group: 'headwear', param: 'key10', kind: 'toggle', default: 0,
    onLabel: '扣上', offLabel: '取下', aliases: ['钢盆', '铁盆', '盆', '锅'],
    note: '扣上后钢盆会遮住眼睛和脸的上半部分，是皮套原样的效果。',
  }),

  // ---------- 手势（互斥）----------
  defineAsset({
    id: 'gesture-grass', label: '狗尾草', group: 'gesture', param: 'Movement1', kind: 'toggle', default: 0,
    exclusive: 'gesture', onLabel: '拿出草', offLabel: '收起', aliases: ['狗尾巴草', '草', '狗尾草'],
    note: '手里出现一根狗尾草；与抚胸、竖食指互斥。',
  }),
  defineAsset({
    id: 'gesture-chest', label: '抚胸', group: 'gesture', param: 'Movement2', kind: 'toggle', default: 0,
    exclusive: 'gesture', onLabel: '抚胸', offLabel: '放下', aliases: ['手抚胸', '捂胸口', '抚胸'],
    note: '手放在胸口；与狗尾草、竖食指互斥。',
  }),
  defineAsset({
    id: 'gesture-finger', label: '竖食指', group: 'gesture', param: 'Movement3', kind: 'toggle', default: 0,
    exclusive: 'gesture', onLabel: '竖起', offLabel: '放下', aliases: ['竖手指', '食指', '竖指'],
    note: '竖起食指；与狗尾草、抚胸互斥。',
  }),

  // ---------- 表情件（眼睛四件互斥）----------
  defineAsset({
    id: 'face-black', label: '黑脸', group: 'expression', param: 'key1', kind: 'toggle', default: 0,
    onLabel: '阴下脸', offLabel: '正常', aliases: ['黑化', '阴沉'],
    note: '额头压下一片阴影。',
  }),
  defineAsset({
    id: 'face-tears', label: '落泪', group: 'expression', param: 'key2', kind: 'toggle', default: 0,
    onLabel: '哭了', offLabel: '正常', aliases: ['流泪', '哭泣', '眼泪', '哭'],
  }),
  defineAsset({
    id: 'eyes-dizzy', label: '圈圈眼', group: 'expression', param: 'key3', kind: 'toggle', default: 0,
    exclusive: 'eyes', onLabel: '晕了', offLabel: '正常', aliases: ['晕', '晕倒', '蚊香眼'],
    note: '眼睛变白色圈圈；与爱心眼 / ＞＜眼 / 屑屑眼互斥。',
  }),
  defineAsset({
    id: 'eyes-heart', label: '爱心眼', group: 'expression', param: 'key4', kind: 'toggle', default: 0,
    exclusive: 'eyes', onLabel: '心动', offLabel: '正常', aliases: ['心心眼', '花痴', '心动'],
    note: '与圈圈眼 / ＞＜眼 / 屑屑眼互斥。',
  }),
  defineAsset({
    id: 'eyes-squint', label: '＞＜眼', group: 'expression', param: 'key5', kind: 'toggle', default: 0,
    exclusive: 'eyes', onLabel: '闭眼笑', offLabel: '正常', aliases: ['＞＜', '><', '龇牙笑', '眯眼笑'],
    note: '与圈圈眼 / 爱心眼 / 屑屑眼互斥。',
  }),
  defineAsset({
    id: 'eyes-smug', label: '屑屑眼', group: 'expression', param: 'key6', kind: 'toggle', default: 0,
    exclusive: 'eyes', onLabel: '不屑', offLabel: '正常', aliases: ['不屑', '得意', '鄙视'],
    note: '与圈圈眼 / 爱心眼 / ＞＜眼互斥。',
  }),
  defineAsset({
    id: 'face-blush', label: '脸红', group: 'expression', param: 'key7', kind: 'toggle', default: 0,
    onLabel: '害羞', offLabel: '正常', aliases: ['害羞', '羞红', '脸红'],
  }),
  defineAsset({
    id: 'face-loading', label: '加载', group: 'expression', param: 'key8', kind: 'toggle', default: 0,
    onLabel: '读取中', offLabel: '正常', aliases: ['loading', '读取', '卡住', '加载中'],
    note: '头顶出现一圈加载转圈。',
  }),
  defineAsset({
    id: 'face-fang', label: '大牙', group: 'expression', param: 'key9', kind: 'toggle', default: 0,
    onLabel: '露牙', offLabel: '正常', aliases: ['虎牙', '龅牙', '牙'],
  }),
  defineAsset({
    id: 'face-sweat', label: '流冷汗', group: 'expression', param: 'key13', kind: 'toggle', default: 0,
    onLabel: '尴尬', offLabel: '正常', aliases: ['冷汗', '汗', '尴尬'],
  }),
];

/** 21 个开关的参数名（B / 诊断用） */
export const ASSET_PARAMS = new Set(TOGGLES.map((asset) => asset.param));

const ASSET_BY_ID = new Map(TOGGLES.map((asset) => [asset.id, asset]));

/** 归一化查找键：大小写 / 全角尖括号 / 空白与连字符都不敏感 */
function normalizeKey(text) {
  return String(text == null ? '' : text).trim().toLowerCase()
    .replace(/＞/g, '>').replace(/＜/g, '<')
    .replace(/[\s_\-]+/g, '');
}

const ALIAS_INDEX = new Map();
for (const asset of TOGGLES) {
  for (const key of [asset.id, asset.label, asset.param, ...(asset.aliases || [])]) {
    const normalized = normalizeKey(key);
    if (normalized && !ALIAS_INDEX.has(normalized)) ALIAS_INDEX.set(normalized, asset);
  }
}

function cloneAsset(asset) {
  const copy = Object.assign({}, asset);
  if (asset.options) copy.options = asset.options.map((option) => Object.assign({}, option));
  if (asset.aliases) copy.aliases = asset.aliases.slice();
  return copy;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/** 按 id / 中文名 / 参数名 / 别名查资产；支持 'asset-xxx' 热键 id；找不到返回 null */
export function findAsset(key) {
  if (key == null) return null;
  let text = String(key).trim();
  if (!text) return null;
  const direct = ASSET_BY_ID.get(text) || ALIAS_INDEX.get(normalizeKey(text));
  if (direct) return direct;
  if (text.toLowerCase().startsWith('asset-')) {
    text = text.slice(6);
    const stripped = ASSET_BY_ID.get(text) || ALIAS_INDEX.get(normalizeKey(text));
    if (stripped) return stripped;
  }
  return null;
}

/** 资产清单拷贝（可按分组过滤）；UI 直接渲染这个 */
export function listAssets(groupId) {
  const list = groupId ? TOGGLES.filter((asset) => asset.group === groupId) : TOGGLES;
  return list.map(cloneAsset);
}

/** 分组 + 各组条目（顺序同 GROUPS） */
export function listGroups() {
  return GROUPS.map((group) => ({ id: group.id, label: group.label, items: listAssets(group.id) }));
}

/** 全部资产 id（顺序同 TOGGLES） */
export function listAssetIds() {
  return TOGGLES.map((asset) => asset.id);
}

// ---------- 渲染层适配 ----------

function writeParameter(renderer, param, value) {
  if (!renderer) throw new Error('applyAsset 需要一个渲染器');
  if (renderer.ready === false) throw new Error('渲染器还没加载完成，先 await renderer.load() 再应用资产');
  if (typeof renderer.setParameter === 'function') { renderer.setParameter(param, value); return 'setParameter'; }
  if (typeof renderer.set === 'function') { renderer.set(param, value); return 'set'; }
  if (typeof renderer.setParameterValueById === 'function') { renderer.setParameterValueById(param, value); return 'setParameterValueById'; }
  throw new Error('渲染器没有可用的参数写入方法：需要 setParameter(id,v) 或 set(id,v)');
}

// cubism-renderer.updateView() 每帧会把全部参数重置为 defaults，所以值必须钉进 defaults 才能跨帧存活。
// defaults 现在是普通 Array（cubism-renderer 用 Array.from 建的），这里同时容忍 Float32Array 之类的 TypedArray。
//
// 所有权的运行期载体（2026-11-21 P2）：手动打开（值 ≥ 0.5）的资产，其参数进入
// renderer 的 pinned 集合；perf 层写 defaults 前会跳过这些参数（见 perf/param-ownership.mjs）。
// 关掉（值 < 0.5）即交还所有权 —— 否则用户点一次「落泪」再关掉，情绪泪就永久失效。
const pinnedParamsByRenderer = new WeakMap();
const ownershipWarned = new Set();

/** 资产层当前 pin（手动拥有）的参数集合；perf 用它做写前过滤 */
export function getPinnedAssetParams(renderer) {
  if (!renderer || typeof renderer !== 'object') return new Set();
  let owned = pinnedParamsByRenderer.get(renderer);
  if (!owned) { owned = new Set(); pinnedParamsByRenderer.set(renderer, owned); }
  return owned;
}

/** 诊断/状态用：排序后的 pin 参数数组 */
export function getPinnedAssetParamList(renderer) {
  return Array.from(getPinnedAssetParams(renderer)).sort();
}

function pinParameter(renderer, param, value) {
  const id = String(param);
  const owned = getPinnedAssetParams(renderer);
  if (Number(value) >= 0.5) owned.add(id);
  else owned.delete(id);
  // 声明校验：资产层只能 pin 自己表里的参数（key1..13 / Clothes / Movement）。
  // 写错参数名时这里会喊出来 —— 以前是静默 pin 一个不存在的参数。
  if (!ASSET_PARAM_SET.has(id) && !ownershipWarned.has(id)) {
    ownershipWarned.add(id);
    try { console.warn('[asset-toggles] pin 了声明表之外的参数 "' + id + '"（该参数不属于资产层）'); } catch (e) { /* ignore */ }
  }
  const defaults = renderer.defaults;
  const indices = renderer.parameterIndices;
  if (defaults && typeof defaults.length === 'number' && indices && typeof indices.get === 'function') {
    const index = indices.get(id);
    if (typeof index === 'number' && index >= 0 && index < defaults.length) { defaults[index] = value; return 'defaults'; }
  }
  if (renderer.appearanceParameters && typeof renderer.appearanceParameters.add === 'function') {
    renderer.appearanceParameters.add(id);
    return 'appearance';
  }
  return 'none';
}

function readParameter(renderer, param, fallback) {
  if (!renderer || typeof renderer.get !== 'function') return fallback;
  try {
    const value = Number(renderer.get(param));
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

// ---------- 应用 / 读取 ----------

function nearestOptionIndex(asset, value) {
  let best = 0;
  let bestDistance = Infinity;
  asset.options.forEach((option, index) => {
    const distance = Math.abs(option.value - value);
    if (distance < bestDistance) { bestDistance = distance; best = index; }
  });
  return best;
}

const NEXT_WORDS = new Set(['next', 'cycle', '下一个', '下一档', '下一格', '下一个档位']);
const PREV_WORDS = new Set(['prev', 'previous', 'back', '上一个', '上一档', '上一格']);

function resolveCycle(asset, currentValue, on) {
  const total = asset.options.length;
  const current = nearestOptionIndex(asset, currentValue);
  let index;
  if (typeof on === 'number' && Number.isFinite(on)) {
    index = Number.isInteger(on) ? ((on % total) + total) % total : -2; // 非整数视为直接给参数值
    if (index === -2) return { index: nearestOptionIndex(asset, clamp01(on)), value: clamp01(on), exact: false };
  } else if (typeof on === 'string') {
    const key = normalizeKey(on);
    if (NEXT_WORDS.has(key) || key === 'true' || key === '') index = (current + 1) % total;
    else if (PREV_WORDS.has(key)) index = (current - 1 + total) % total;
    else {
      const byOption = asset.options.findIndex((option) => normalizeKey(option.id) === key || normalizeKey(option.label) === key);
      if (byOption >= 0) index = byOption;
      else if (key === 'false') index = (current - 1 + total) % total;
      else if (Number.isFinite(Number(on))) { const raw = clamp01(Number(on)); return { index: nearestOptionIndex(asset, raw), value: raw, exact: false }; }
      else throw new Error('资产 ' + asset.id + ' 不认识这个档位：' + String(on) + '（可用：' + asset.options.map((option) => option.id).join(' / ') + '）');
    }
  } else if (on === false) {
    index = (current - 1 + total) % total;
  } else {
    index = (current + 1) % total; // true / undefined / 其它 -> 下一档
  }
  const option = asset.options[index];
  return { index, value: option.value, exact: true };
}

function resolveToggle(asset, currentValue, on) {
  if (on === undefined || on === 'flip' || on === 'toggle' || on === 'next' || on === null) return currentValue >= 0.5 ? 0 : 1;
  if (typeof on === 'boolean') return on ? 1 : 0;
  if (typeof on === 'number') { if (!Number.isFinite(on)) throw new Error('资产 ' + asset.id + ' 的值不是数字：' + String(on)); return clamp01(on); }
  const key = normalizeKey(on);
  if (['on', 'true', '开', '开启', 'open', '1'].includes(key)) return 1;
  if (['off', 'false', '关', '关闭', 'closed', '0'].includes(key)) return 0;
  if (Number.isFinite(Number(on))) return clamp01(Number(on));
  throw new Error('资产 ' + asset.id + ' 不认识这个开关值：' + String(on) + '（可用 true / false / 省略=翻转）');
}

/** 某个参数值对应的中文说法（短裙/长裙、大鱼/中鱼/小鱼、戴上/摘下…） */
function labelForValue(asset, value) {
  if (asset.kind === 'cycle') return asset.options[nearestOptionIndex(asset, value)].label;
  return value >= 0.5 ? (asset.onLabel || '开') : (asset.offLabel || '关');
}

function describe(asset, renderer) {
  const value = round3(readParameter(renderer, asset.param, asset.default));
  if (asset.kind === 'cycle') {
    const index = nearestOptionIndex(asset, value);
    const option = asset.options[index];
    return {
      id: asset.id, label: asset.label, group: asset.group, groupLabel: asset.groupLabel,
      param: asset.param, kind: asset.kind, value,
      optionId: option.id, optionLabel: option.label, optionIndex: index,
      exact: Math.abs(option.value - value) <= 0.02,
      on: Math.abs(option.value - asset.default) > 1e-6,
      default: asset.default,
    };
  }
  const on = value >= 0.5;
  return {
    id: asset.id, label: asset.label, group: asset.group, groupLabel: asset.groupLabel,
    param: asset.param, kind: asset.kind, value,
    on, optionId: on ? 'on' : 'off', optionLabel: labelForValue(asset, value),
    default: asset.default,
  };
}

/**
 * 应用核心：写参数 + 钉住跨帧值 + 处理互斥，不读写持久化（批量 / 预设内部复用）。
 * 返回应用后的状态（字段同 getAssetState）。
 */
function applyAssetCore(renderer, id, on) {
  const asset = findAsset(id);
  if (!asset) throw new Error('没有这个资产：' + String(id) + '（可用 listAssets() 查看清单）');
  if (!renderer) throw new Error('applyAsset 需要一个渲染器');
  const current = readParameter(renderer, asset.param, asset.default);
  let value;
  let optionId;
  let optionLabel;
  let exact = true;
  if (asset.kind === 'cycle') {
    const resolved = resolveCycle(asset, current, on);
    value = resolved.value;
    exact = resolved.exact;
    const option = asset.options[nearestOptionIndex(asset, value)];
    optionId = resolved.exact ? option.id : 'custom';
    optionLabel = resolved.exact ? option.label : '最接近 ' + option.label + '（' + round3(value) + '）';
  } else {
    value = resolveToggle(asset, current, on);
    optionId = value >= 0.5 ? 'on' : 'off';
    optionLabel = value >= 0.5 ? (asset.onLabel || '开') : (asset.offLabel || '关');
  }
  writeParameter(renderer, asset.param, value);
  pinParameter(renderer, asset.param, value);
  // 互斥：同一 exclusive 键下，其它资产一律关闭
  const turnedOff = [];
  if (asset.exclusive && value >= 0.5) {
    for (const other of TOGGLES) {
      if (other === asset || other.exclusive !== asset.exclusive || other.kind === 'cycle') continue;
      writeParameter(renderer, other.param, 0);
      pinParameter(renderer, other.param, 0);
      turnedOff.push(other.id);
    }
  }
  const state = describe(asset, renderer);
  state.previous = round3(current === undefined ? asset.default : current);
  state.turnedOff = turnedOff;
  state.exact = exact;
  if (asset.kind === 'cycle' && !exact) {
    // 直接给了档位外的参数值时，档位只是最接近的参考，别谎报成某档
    state.optionId = 'custom';
    state.optionLabel = optionLabel;
  }
  state.ok = true;
  state.message = asset.label + '：' + optionLabel;
  return state;
}

/** 应用一个资产，落盘结果（下次启动自动恢复），返回应用后的状态（含 message / saved） */
export function applyAsset(renderer, id, on) {
  ensureAssetsRestored(renderer);
  const state = applyAssetCore(renderer, id, on);
  state.saved = saveAssetsState(renderer).saved;
  return state;
}

/** 单个资产当前状态；未知 id 返回 null */
export function getAssetState(renderer, id) {
  const asset = findAsset(id);
  if (!asset) return null;
  ensureAssetsRestored(renderer);
  return describe(asset, renderer);
}

/** 全部资产状态，按 id 建索引（渲染器未就绪时给默认值，不抛错） */
export function getState(renderer) {
  ensureAssetsRestored(renderer);
  const state = {};
  for (const asset of TOGGLES) state[asset.id] = describe(asset, renderer);
  return state;
}

/** 全部资产状态的数组形态（[{id,on,value,optionId,optionLabel,…}]）；协议层回传真实档位时用它 */
export function listAssetStates(renderer) {
  ensureAssetsRestored(renderer);
  return TOGGLES.map((asset) => describe(asset, renderer));
}

/** 批量应用 {id:on}；按传入顺序生效，互斥以最后一条为准；只落盘一次 */
export function setAssets(renderer, values) {
  if (!renderer) throw new Error('setAssets 需要一个渲染器');
  ensureAssetsRestored(renderer);
  const applied = [];
  for (const [id, on] of Object.entries(values || {})) applied.push(applyAssetCore(renderer, id, on));
  saveAssetsState(renderer);
  return applied;
}

/** 全部回到皮套默认（Clothes1/Clothes5 默认是 1），并落盘 */
export function resetAssets(renderer) {
  const defaults = {};
  for (const asset of TOGGLES) defaults[asset.id] = asset.default;
  writeAssetValues(renderer, defaults);
  markRestored(renderer);
  saveAssetsState(renderer);
  return getState(renderer);
}

// 存档要的是「资产想成为的值」，不是某一帧的瞬态：优先读钉在 defaults 上的值。
// （动作层演 竖食指/抚胸 的那几帧，Movement* 的实时值会被动作叠成瞬态，直接用实时值会存歪。）
function pinnedParameterValue(renderer, asset) {
  const defaults = renderer && renderer.defaults;
  const indices = renderer && renderer.parameterIndices;
  if (defaults && typeof defaults.length === 'number' && indices && typeof indices.get === 'function') {
    const index = indices.get(asset.param);
    const value = typeof index === 'number' && index >= 0 && index < defaults.length ? Number(defaults[index]) : NaN;
    if (Number.isFinite(value)) return value;
  }
  return readParameter(renderer, asset.param, asset.default);
}

/** 快照：{id: 参数值}，用于「换装方案」保存 / 还原（读资产的目标值，抗动作瞬态） */
export function snapshotAssets(renderer) {
  const snapshot = {};
  for (const asset of TOGGLES) snapshot[asset.id] = round3(pinnedParameterValue(renderer, asset));
  return snapshot;
}

/** 还原快照：逐值写回，不处理互斥（快照本身就是自洽的） */
export function restoreAssets(renderer, snapshot) {
  if (!snapshot) return getState(renderer);
  for (const asset of TOGGLES) {
    if (typeof snapshot[asset.id] !== 'number') continue;
    const value = clamp01(snapshot[asset.id]);
    writeParameter(renderer, asset.param, value);
    pinParameter(renderer, asset.param, value);
  }
  return getState(renderer);
}

/**
 * model-info 用的热键描述：kind:'asset'，Lead 的协议层按 assetId 调 applyAsset 即可。
 * type 用 VTS 的 TriggerHotkey（第三方客户端只当普通热键看）。
 * takenNames 传入已被占用的热键名（如 23 个表情热键），同名的资产热键自动加「（开关）」后缀，
 * 保证 HotkeyTriggerRequest 按名字触发时不会撞车。
 */
export function assetHotkeys(takenNames) {
  const taken = takenNames instanceof Set ? takenNames : new Set(takenNames || []);
  return TOGGLES.map((asset) => {
    let name = asset.label;
    if (taken.has(name)) name = asset.label + '（开关）';
    taken.add(name);
    return {
      id: 'asset-' + asset.id,
      name,
      kind: 'asset',
      type: 'TriggerHotkey',
      assetId: asset.id,
      param: asset.param,
      group: asset.group,
      groupLabel: asset.groupLabel,
      assetKind: asset.kind,
      file: '',
      action: asset.kind === 'cycle' ? 'next' : 'flip',
    };
  });
}

// ---------- 持久化（localStorage）----------
//
// 设计：只存「21 个资产的参数值」（{version, updatedAt, preset, values}），不存语义，
// 这样以后改标签/分组/互斥规则都不会和存档打架。
// 自动恢复时机：面板第一次读状态（getState）或第一次按键（applyAsset）时懒恢复一次，
// 每个渲染器只做一次；渲染器还没 ready 就先不恢复，等下一次调用。
// 存储不可用（隐私模式 / 被策略禁用）时所有函数降级为「记不住但不报错」。

/** 存档 key（任务约定：pet.assets.v1） */
export const ASSETS_STORAGE_KEY = 'pet.assets.v1';
const STORAGE_VERSION = 1;

/**
 * 内存后端（petBody 内存）：宿主页面里 localStorage 不可用时的降级。
 * 只保证「本次会话」内能存能读，重启后自然回到皮套默认；不会抛错、不影响换装本身。
 */
export function createMemoryStorage() {
  const map = new Map();
  return {
    backend: 'memory',
    getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
    clear() { map.clear(); },
  };
}

const memoryStorage = createMemoryStorage();

let storageOverride = null;

/** 换一个存储后端（测试 / 特殊环境）；传 null 回到自动选择（localStorage → 宿主内存 → 不记忆） */
export function setAssetsStorage(storage) { storageOverride = storage || null; }

/**
 * 是否跑在「宿主页面」里（my-neuro 用 nodeIntegration:true 加载页面，require 可用；
 * 我们自己的 Electron 桌宠是 contextIsolation:true，require 不可用）。
 * 用来决定两件事：localStorage 不可用时降级到 petBody 内存；以及是否自动挂宿主同步。
 */
export function isHostRuntime(scope = globalThis) {
  try {
    if (!scope) return false;
    if (typeof scope.require === 'function') return true;
    if (scope.petBody) return true;
  } catch (error) { /* ignore */ }
  return false;
}

let localProbe;
function probeLocalStorage() {
  if (localProbe !== undefined) return localProbe;
  try {
    const storage = globalThis.localStorage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') { localProbe = null; return localProbe; }
    const probeKey = ASSETS_STORAGE_KEY + '.probe';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    localProbe = storage;
  } catch (error) {
    localProbe = null; // file:///隐私模式/策略禁用时可能直接抛 SecurityError
  }
  return localProbe;
}

/** 当前存储后端：override > localStorage > 宿主内存（petBody 内存）> null（不记忆） */
export function getAssetsStorage() {
  if (storageOverride) return storageOverride;
  const local = probeLocalStorage();
  if (local) return local;
  if (isHostRuntime()) return memoryStorage;
  return null;
}

/** 当前后端名：'override' | 'localStorage' | 'memory' | 'none' */
export function getAssetsStorageBackend() {
  if (storageOverride) return 'override';
  if (probeLocalStorage()) return 'localStorage';
  return isHostRuntime() ? 'memory' : 'none';
}

// 互斥组里若存了两个以上开着的（手改存档 / 旧版本写的），按 TOGGLES 顺序保留第一个。
function sanitizeSavedValues(values) {
  const clean = {};
  for (const asset of TOGGLES) if (typeof values[asset.id] === 'number') clean[asset.id] = clamp01(values[asset.id]);
  const kept = new Map();
  for (const asset of TOGGLES) {
    if (!asset.exclusive || typeof clean[asset.id] !== 'number' || clean[asset.id] < 0.5) continue;
    if (kept.has(asset.exclusive)) clean[asset.id] = 0;
    else kept.set(asset.exclusive, asset.id);
  }
  return clean;
}

function readSavedRecord() {
  const storage = getAssetsStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(ASSETS_STORAGE_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!record || record.version !== STORAGE_VERSION || !record.values || typeof record.values !== 'object') return null;
    const values = sanitizeSavedValues(record.values);
    if (!Object.keys(values).length) return null;
    return {
      version: STORAGE_VERSION,
      updatedAt: Number(record.updatedAt) || 0,
      preset: typeof record.preset === 'string' ? record.preset : '',
      values,
    };
  } catch (error) {
    return null;
  }
}

function writeAssetValues(renderer, values) {
  if (!renderer) throw new Error('写资产值需要一个渲染器');
  for (const asset of TOGGLES) {
    const raw = values[asset.id];
    // 布尔是合法输入（applyAssetValue 的 toggle 分支）——之前只认 number，
    // 布尔被 continue 静默跳过，开关型直设全部无效（2026-11-08 E2E 实锤）。
    if (typeof raw !== 'number' && typeof raw !== 'boolean') continue;
    const value = raw === true ? 1 : raw === false ? 0 : clamp01(raw);
    writeParameter(renderer, asset.param, value);
    pinParameter(renderer, asset.param, value);
  }
}

const restoredRenderers = new WeakSet();
function markRestored(renderer) {
  if (renderer && typeof renderer === 'object') restoredRenderers.add(renderer);
}

// 懒恢复：面板第一次读状态 / 第一次按键时，把上次的换装恢复回来（每个渲染器只做一次）
function ensureAssetsRestored(renderer) {
  if (!renderer || typeof renderer !== 'object') return false;
  if (restoredRenderers.has(renderer)) return false;
  if (renderer.ready === false) return false; // 渲染器还没加载完，别提前标记，等下一次
  const record = readSavedRecord();
  if (!record) { markRestored(renderer); return false; }
  try {
    writeAssetValues(renderer, record.values);
  } catch (error) {
    return false; // 写失败（例如模型还没就绪）：不标记，下一次再试
  }
  markRestored(renderer);
  return true;
}

/**
 * 把当前换装写进 localStorage。preset 字段由当前状态自动识别（女仆装/居家/演出/摸鱼），
 * 不匹配任何预设时存空串。
 */
export function saveAssetsState(renderer) {
  if (!renderer) throw new Error('saveAssetsState 需要一个渲染器');
  const values = snapshotAssets(renderer);
  const preset = detectPreset(renderer);
  const record = {
    version: STORAGE_VERSION,
    updatedAt: Date.now(),
    preset: preset ? preset.id : '',
    values,
  };
  const storage = getAssetsStorage();
  if (!storage) return { saved: false, reason: 'storage-unavailable', values, preset: record.preset };
  try {
    storage.setItem(ASSETS_STORAGE_KEY, JSON.stringify(record));
    return { saved: true, updatedAt: record.updatedAt, values, preset: record.preset };
  } catch (error) {
    return { saved: false, reason: String((error && error.message) || error), values, preset: record.preset };
  }
}

/** 上次存下来的 21 个资产值（{id:value}）；没有存档返回 null */
export function readSavedAssetsState() {
  const record = readSavedRecord();
  return record ? record.values : null;
}

/**
 * 存档概况，给面板显示「已记住 / 已清除」用。
 * backend: 'localStorage'（能跨重启）| 'memory'（宿主里 localStorage 不可用，只在本次会话有效）
 *          | 'override'（测试/自定义后端）| 'none'（完全不记忆）
 * persistent: 这份存档能不能跨宿主重启活下来（memory 不行）。
 */
export function getAssetsStorageInfo() {
  const backend = getAssetsStorageBackend();
  const record = readSavedRecord();
  return {
    key: ASSETS_STORAGE_KEY,
    backend,
    available: backend !== 'none',
    persistent: backend === 'localStorage' || backend === 'override',
    saved: !!record,
    updatedAt: record ? record.updatedAt : 0,
    preset: record ? record.preset : '',
    count: record ? Object.keys(record.values).length : 0,
  };
}

/** 清空存档（模型当前状态不变，下次启动回到皮套默认） */
export function clearAssetsState() {
  const storage = getAssetsStorage();
  if (!storage) return { cleared: false, reason: 'storage-unavailable' };
  try {
    storage.removeItem(ASSETS_STORAGE_KEY);
    return { cleared: true };
  } catch (error) {
    return { cleared: false, reason: String((error && error.message) || error) };
  }
}

/** 手动恢复上次换装（一般不用调，getState / applyAsset 会懒恢复）；没有存档返回 null */
export function restoreSavedAssets(renderer) {
  if (!renderer || typeof renderer !== 'object') return null;
  const record = readSavedRecord();
  markRestored(renderer);
  if (!record) return null;
  writeAssetValues(renderer, record.values);
  return getState(renderer);
}

// ---------- 一键预设 ----------
//
// 预设 = 「先把 21 个资产回默认，再按表覆盖」；顺序无关，互斥组由表内容保证只有一个开。

/** 预设清单（任务约定 4 套） */
export const PRESETS = [
  { id: 'maid', label: '女仆装', description: '皮套原样：短裙 + 穿鞋 + 有尾巴', assets: {} },
  { id: 'home', label: '居家', description: '短裙 + 脱鞋 + 无尾巴', assets: { 'clothes-skirt': true, 'clothes-shoes': true, 'clothes-tail': false } },
  { id: 'show', label: '演出', description: '黑框眼镜 + 短裙', assets: { 'glasses-frame': true, 'clothes-skirt': true } },
  { id: 'slack', label: '摸鱼', description: '大钢盆 + 中鱼', assets: { 'headwear-pot': true, 'form-size': 'mid' } },
];

const PRESET_INDEX = new Map();
for (const preset of PRESETS) for (const key of [preset.id, preset.label]) PRESET_INDEX.set(normalizeKey(key), preset);

/** 按 id / 中文名查预设；找不到返回 null */
export function findPreset(key) {
  if (key == null) return null;
  return PRESET_INDEX.get(normalizeKey(String(key))) || null;
}

// 预设里某项想写的值 → 参数值（toggles 用 on/off，cycle 用档位 id 或中文名）
function resolvePresetValue(asset, spec) {
  if (asset.kind === 'cycle') {
    const option = asset.options.find((entry) => normalizeKey(entry.id) === normalizeKey(spec) || normalizeKey(entry.label) === normalizeKey(spec));
    if (!option) throw new Error('预设里的 ' + asset.id + ' 不认识档位：' + String(spec));
    return option.value;
  }
  return spec ? 1 : 0;
}

// 预设的完整目标值（21 项，默认值 + 覆盖项）
function presetTargetValues(preset) {
  const values = {};
  for (const asset of TOGGLES) values[asset.id] = asset.default;
  for (const [key, spec] of Object.entries(preset.assets)) {
    const asset = findAsset(key);
    if (!asset) throw new Error('预设 ' + preset.id + ' 引用了不存在的资产：' + key);
    values[asset.id] = resolvePresetValue(asset, spec);
  }
  return sanitizeSavedValues(values);
}

/** 预设清单的拷贝（UI 直接渲染一排按钮；items 是「这套预设动了哪几个资产」的可读摘要） */
export function listPresets() {
  return PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
    assets: Object.assign({}, preset.assets),
    items: Object.entries(preset.assets).map(([key, spec]) => {
      const asset = findAsset(key);
      const value = resolvePresetValue(asset, spec);
      return { assetId: asset.id, label: asset.label, group: asset.group, groupLabel: asset.groupLabel, value, optionLabel: labelForValue(asset, value) };
    }),
  }));
}

/** 当前状态命中的预设（不命中返回 null），面板用来高亮当前那套 */
export function currentPreset(renderer) {
  const preset = detectPreset(renderer);
  return preset ? { id: preset.id, label: preset.label, description: preset.description } : null;
}

function detectPreset(renderer) {
  if (!renderer) return null;
  const snapshot = snapshotAssets(renderer);
  for (const preset of PRESETS) {
    let expected;
    try { expected = presetTargetValues(preset); } catch (error) { continue; }
    let matched = true;
    for (const asset of TOGGLES) {
      const actual = typeof snapshot[asset.id] === 'number' ? snapshot[asset.id] : asset.default;
      if (Math.abs(actual - expected[asset.id]) > 0.02) { matched = false; break; }
    }
    if (matched) return preset;
  }
  return null;
}

/** 一键套用预设：回默认 → 覆盖 → 落盘，返回 {ok, preset, state, message} */
/** 设置单个资产的值：布尔（开关型）或 optionId/数值（档位型，如 form-size: 'mid'|0.4|'big'）。
 *  控制中心的「装扮与形态」区从这里走，不用为档位专门开协议。 */
export function applyAssetValue(renderer, id, value) {
  const asset = findAsset(id);
  if (!asset) throw new Error('没有这个资产：' + String(id));
  ensureAssetsRestored(renderer);
  let v = value;
  if (asset.kind === 'cycle' && typeof value === 'string') {
    const opt = (asset.options || []).find((o) => o.id === String(value));
    if (opt) v = opt.value;
  }
  if (asset.kind === 'toggle') v = !(value === false || value === 0);
  // writeAssetValues 按 asset.id 取键；这里原来传 asset.param（'Clothes2'）→ 键名错位，
  // 每次都静默 no-op（尺寸三档点了没反应的真根因）。预设路径传的就是 id 所以一直好使。
  writeAssetValues(renderer, { [asset.id]: v });
  markRestored(renderer);
  saveAssetsState(renderer);
  return getState(renderer);
}

export function applyPreset(renderer, id) {
  const preset = findPreset(id);
  if (!preset) throw new Error('没有这个预设：' + String(id) + '（可用 listPresets() 查看）');
  if (!renderer) throw new Error('applyPreset 需要一个渲染器');
  ensureAssetsRestored(renderer);
  const values = presetTargetValues(preset);
  writeAssetValues(renderer, values);
  markRestored(renderer);
  const saved = saveAssetsState(renderer);
  const state = getState(renderer);
  return {
    ok: true,
    id: preset.id,
    label: preset.label,
    description: preset.description,
    preset: { id: preset.id, label: preset.label, description: preset.description },
    values,
    state,
    saved: saved.saved,
    message: '预设：' + preset.label,
  };
}

// ---------- 宿主同步（my-neuro 的 petBody 页面）----------
//
// my-neuro 的页面是 file:// + nodeIntegration:true，驱动初始化完会设置 global.petBody。
// 这里做三件事（不依赖宿主动作，bundle 一加载就挂着）：
//   1) 等 petBody.renderer ready 后自动恢复上次换装（提前恢复会被骨架 defaults 覆盖）
//   2) 把当前预设名挂到宿主对象：window.petBody.currentPreset?.() / presetName?.()
//   3) 换皮（renderer 换新）后再恢复一次
// 我们自己的 Electron 桌宠（contextIsolation:true，require 不可用）不会走到这里。

/** 当前预设 id（不命中返回空串），宿主同步用 */
export function currentPresetName(renderer) {
  const preset = detectPreset(renderer);
  return preset ? preset.id : '';
}

/** 当前预设中文名（不命中返回空串） */
export function currentPresetLabel(renderer) {
  const preset = detectPreset(renderer);
  return preset ? preset.label : '';
}

function defineHostField(target, name, value) {
  try { Object.defineProperty(target, name, { value, configurable: true, writable: true, enumerable: false }); }
  catch (error) { try { target[name] = value; } catch (e2) {} }
}

function hostReport(scope, event) {
  try {
    const report = scope && scope.__petBodyReport;
    if (typeof report === 'function') report(event);
  } catch (error) { /* 宿主调试通道不可用就算了 */ }
}

/** 找到宿主里的 petBody 对象（my-neuro：global.petBody） */
export function getHostBody(scope = globalThis) {
  try {
    const body = scope && scope.petBody;
    return body && typeof body === 'object' ? body : null;
  } catch (error) { return null; }
}

/** 找到宿主里的渲染器（petBody.renderer；兼容 getRenderer()） */
export function getHostRenderer(scope = globalThis) {
  const body = getHostBody(scope);
  const renderer = body && (body.renderer || (typeof body.getRenderer === 'function' ? body.getRenderer() : null));
  return renderer && typeof renderer === 'object' ? renderer : null;
}

/**
 * 把资产能力挂到宿主 petBody 上（幂等）：
 *   petBody.currentPreset()  → {id,label,description} | null（A 的面板高亮用，任务要求 3）
 *   petBody.presetName()     → 'home' | ''
 *   petBody.restoreAssets()  → 手动恢复存档
 *   petBody.assetStorage()   → 存档概况（含 backend/persistent，能看出是不是降级到内存）
 */
export function decorateHostBody(body, renderer) {
  if (!body || typeof body !== 'object') return false;
  const target = renderer || body.renderer || null;
  if (!target || typeof target !== 'object') return false;
  defineHostField(body, 'currentPreset', () => currentPreset(target));
  defineHostField(body, 'presetName', () => currentPresetName(target));
  defineHostField(body, 'restoreAssets', () => restoreSavedAssets(target));
  defineHostField(body, 'assetStorage', () => getAssetsStorageInfo());
  return true;
}

let hostSync = null;

/**
 * 宿主自恢复：等 petBody.renderer ready 后恢复存档，并把预设名同步到宿主。
 * bundle 在宿主页面里加载时自动启动；换皮后 renderer 换新会再恢复一次。
 * 返回 { stop(), poke(), restores }；重复调用返回同一个控制器。
 */
export function startHostAssetSync(options = {}) {
  if (hostSync) return hostSync;
  const scope = options.scope || globalThis;
  const interval = Math.max(60, Number(options.interval) || 700);
  const restores = [];
  let lastRenderer = null;
  let running = true;
  let controller = null;
  const tick = () => {
    if (!running) return;
    try {
      const body = getHostBody(scope);
      const renderer = getHostRenderer(scope);
      if (!body || !renderer) return;
      if (renderer.ready === false) return; // 等渲染器 ready：提前写会被骨架 defaults 覆盖
      decorateHostBody(body, renderer);
      if (renderer === lastRenderer) return;
      lastRenderer = renderer;
      const entry = {
        at: Date.now(),
        hadSaved: !!readSavedRecord(),
        restored: ensureAssetsRestored(renderer),
        preset: currentPresetName(renderer),
        backend: getAssetsStorageBackend(),
      };
      restores.push(entry);
      hostReport(scope, { type: 'assets-restored', ...entry });
      try {
        if (typeof scope.dispatchEvent === 'function' && typeof scope.CustomEvent === 'function') {
          scope.dispatchEvent(new scope.CustomEvent('petbody-assets-restored', { detail: entry }));
        }
      } catch (error) { /* ignore */ }
    } catch (error) {
      hostReport(scope, { type: 'assets-restore-error', message: String((error && error.message) || error) });
    }
  };
  tick();
  const timer = setInterval(tick, interval);
  controller = {
    scope,
    interval,
    poke: tick,
    stop() { running = false; clearInterval(timer); if (hostSync === controller) hostSync = null; },
    get restores() { return restores.slice(); },
    get lastRestore() { return restores.length ? restores[restores.length - 1] : null; },
  };
  hostSync = controller;
  return controller;
}

/** 停掉宿主同步（一般不调，测试用） */
export function stopHostAssetSync() {
  if (!hostSync) return false;
  hostSync.stop();
  hostSync = null;
  return true;
}

/** 全局资产 API（window.petAssets）：宿主页面里 A 的面板直接用这一份，避免再打一份目录出现两套状态 */
const assetsApi = {
  version: 1,
  key: ASSETS_STORAGE_KEY,
  GROUPS, TOGGLES, PRESETS, ASSET_PARAMS,
  listAssets, listGroups, listAssetIds, listAssetStates, findAsset,
  applyAsset, getState, getAssetState, setAssets, resetAssets, snapshotAssets, restoreAssets, assetHotkeys,
  listPresets, findPreset, applyPreset, currentPreset, currentPresetName, currentPresetLabel,
  saveAssetsState, readSavedAssetsState, restoreSavedAssets, clearAssetsState,
  getAssetsStorageInfo, getAssetsStorage, getAssetsStorageBackend, setAssetsStorage, createMemoryStorage,
  isHostRuntime, getHostBody, getHostRenderer, decorateHostBody, startHostAssetSync, stopHostAssetSync,
};

/** 全局 API（window.petAssets） */
export function getAssetsApi() { return assetsApi; }

try {
  if (typeof globalThis !== 'undefined' && !globalThis.petAssets) globalThis.petAssets = assetsApi;
} catch (error) { /* ignore */ }

// 宿主页面（my-neuro）里 bundle 一加载就挂上自恢复；自己的 Electron 桌宠不满足条件，不会启动
try {
  if (isHostRuntime() && !globalThis.__petAssetsHostSync) {
    globalThis.__petAssetsHostSync = true;
    startHostAssetSync();
  }
} catch (error) { /* 自恢复失败不能影响渲染 */ }

export default assetsApi;
