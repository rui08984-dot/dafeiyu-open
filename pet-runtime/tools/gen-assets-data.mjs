// gen-assets-data.mjs —— 把 desktop/asset-toggles.mjs 的资产目录导出成宿主可直接用的静态 JS。
//
// 为什么在构建期导出，而不是宿主里 import：
// 那个模块在「宿主运行时」里一 import 就会自动启动 startHostAssetSync()（700ms 循环，
// 反复 decorateHostBody），实测几秒内把 my-neuro 的渲染进程拖死（frame disposed）。
// 我们在宿主侧只需要它的**数据**（分组/资产/预设）和十几个纯函数行为，
// 所以构建期导出数据，宿主侧自己实现读写参数——没有副作用，也不会崩。
import { GROUPS, TOGGLES, PRESETS } from '../desktop/asset-toggles.mjs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'avatar', 'petbody', 'assets-data.js');

const data = {
  version: 1,
  groups: GROUPS,
  presets: PRESETS,
  assets: TOGGLES.map((a) => ({
    id: a.id, label: a.label, group: a.group, groupLabel: a.groupLabel,
    param: a.param, kind: a.kind, default: a.default, exclusive: a.exclusive || null,
    aliases: a.aliases || [], note: a.note || '',
    onLabel: a.onLabel || '', offLabel: a.offLabel || '',
    options: a.options || null,
  })),
};

writeFileSync(out, [
  '// 由 pet-runtime/desktop/asset-toggles.mjs 自动导出，请勿手改。',
  '// 重新生成：node pet-runtime/tools/gen-assets-data.mjs',
  'window.__PET_ASSETS = ' + JSON.stringify(data, null, 2) + ';',
  '',
].join('\n'));
console.log('[assets] 导出 ' + data.assets.length + ' 个资产 / ' + data.groups.length + ' 组 / ' + data.presets.length + ' 预设 → ' + out);