import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPS, TOGGLES, assetHotkeys, listAssets } from './desktop/asset-toggles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = join(HERE, 'desktop', 'assets', 'jellyfish');

const STANDARD = [
  ['ParamAngleX', -30, 30, 0], ['ParamAngleY', -30, 30, 0], ['ParamAngleZ', -30, 30, 0],
  ['ParamBodyAngleX', -10, 10, 0], ['ParamBodyAngleY', -10, 10, 0], ['ParamBodyAngleZ', -10, 10, 0],
  ['ParamEyeLOpen', 0, 1, 1], ['ParamEyeROpen', 0, 1, 1],
  ['ParamEyeBallX', -1, 1, 0], ['ParamEyeBallY', -1, 1, 0],
  ['ParamMouthOpenY', 0, 1, 0], ['ParamMouthForm', -1, 1, 0],
  ['ParamBrowLY', -1, 1, 0], ['ParamBrowRY', -1, 1, 0],
  ['ParamBreath', 0, 1, 0], ['ParamCheek', 0, 1, 0],
];

// 开关参数（key1..key13 / Clothes1..5 / Movement1..3）以资产目录为唯一事实源：
// 它们都是 0..1，默认值来自皮套骨架（Clothes1/Clothes5 默认 1），不是 cdi3 里的兜底 -1..1。
const ASSET_BY_PARAM = new Map(TOGGLES.map((asset) => [asset.param, asset]));

/** 在 parameters 上标注资产开关（min/max/default 按皮套真实值），并挂上资产元数据 */
function markSwitchParameters(parameters) {
  for (const parameter of parameters) {
    const asset = ASSET_BY_PARAM.get(parameter.id);
    if (!asset) continue;
    parameter.min = 0;
    parameter.max = 1;
    parameter.default = asset.default;
    parameter.switch = true;
    parameter.assetId = asset.id;
    parameter.assetLabel = asset.label;
    parameter.group = asset.group;
    parameter.groupLabel = asset.groupLabel;
    parameter.assetKind = asset.kind;
    if (asset.kind === 'cycle') parameter.options = asset.options.map((option) => ({ ...option }));
  }
  return parameters;
}

export function buildModelInfo() {
  const settings = JSON.parse(readFileSync(join(MODEL_DIR, 'pet.model3.json'), 'utf8'));
  const cdi = JSON.parse(readFileSync(join(MODEL_DIR, 'pet.cdi3.json'), 'utf8').replace(/^\uFEFF/, ''));
  const parameters = [];
  const seen = new Set();
  for (const [id, min, max, def] of STANDARD) { parameters.push({ id, name: id, min, max, default: def }); seen.add(id); }
  for (const p of cdi.Parameters || []) {
    if (seen.has(p.Id)) continue;
    seen.add(p.Id);
    parameters.push({ id: p.Id, name: p.Name || p.Id, min: -1, max: 1, default: 0 });
  }
  markSwitchParameters(parameters);
  const expressions = (settings.FileReferences?.Expressions || []).map((e) => ({ name: e.Name, file: e.File }));
  const hotkeys = expressions.map((e) => ({ id: 'expr-' + e.name, name: e.name, kind: 'expression', type: 'TriggerExpression', file: e.file }));
  const motions = settings.FileReferences?.Motions || {};
  for (const [group, list] of Object.entries(motions)) {
    (list || []).forEach((m, index) => {
      hotkeys.push({ id: 'motion-' + group + '-' + index, name: group + (index ? ' ' + (index + 1) : ''), kind: 'motion', group, index, type: 'TriggerAnimation', file: m.File });
    });
  }
  // 第三类热键：资产开关（换装 / 换形态 / 手势 / 表情件），来自 desktop/asset-toggles.mjs 的 TOGGLES。
  // kind:'asset' 的条目带 assetId，协议层直接 applyAsset(renderer, hit.assetId) 即可。
  hotkeys.push(...assetHotkeys(new Set(hotkeys.map((hotkey) => hotkey.name))));
  const assets = listAssets();
  return {
    id: 'dafeiyu',
    name: '大肥鱼',
    icon: 'assets/jellyfish/icon.png',
    parameters,
    expressions,
    hotkeys,
    assets,
    assetGroups: GROUPS.map((group) => ({ id: group.id, label: group.label, count: TOGGLES.filter((asset) => asset.group === group.id).length })),
    expressionsCount: expressions.length,
    hotkeysCount: hotkeys.length,
    assetsCount: assets.length,
  };
}
