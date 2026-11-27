// js/core/lumen-semantic.js —— **薄壳**（2026-11-17 六十五轮，2026-11-26 安装包 A 修）
//
// 实现只有一份：`pet-runtime/desktop/perf/lumen-semantic-client.cjs`
// （放在那边是因为渲染层 bundle 也要用它做「规则没命中时的情绪兜底」，
//   bundle 只能 import pet-runtime 下的模块）。
// 这里只是给宿主 JS / 插件一个习惯的路径。
//
// ⚠ 2026-11-26 实测：这里原来是**无兜底的相对 require**（上五级 → 项目根）。
// 打包后 app 在 `resources/app`，上五级跑到安装目录之外，require 抛错会让整个
// 渲染层模块图加载失败（8102 永远不连、看门狗无限重载）。而语义选择本来就是
// **可选能力**（8120 服务 + 146MB 模型都不在薄装里），缺失必须降级而不是拖垮页面。
'use strict';

const fs = require('fs');
const path = require('path');

const REL = path.join('pet-runtime', 'desktop', 'perf', 'lumen-semantic-client.cjs');
const CANDIDATES = [
  // 开发树：live-2d/js/core → 上五级 = 项目根
  path.resolve(__dirname, '..', '..', '..', '..', '..', REL),
  // 安装版 v0.4.0：运行时树随应用进 resources/app/pet-runtime（见 build-installer.ps1）
  path.resolve(__dirname, '..', '..', REL),
  // 兼容旧布局（live-2d 上三级）
  path.resolve(__dirname, '..', '..', '..', REL),
];
// 兼容旧安装布局（client 单独放 resources/pet-runtime）
if (process.resourcesPath) CANDIDATES.splice(2, 0, path.resolve(process.resourcesPath, REL));

let impl = null;
for (const file of CANDIDATES) {
  try {
    if (file && fs.existsSync(file)) { impl = require(file); break; }
  } catch (e) { /* 这个候选不可用，继续找下一个；最后有兜底 */ }
}

if (!impl) {
  // 可选能力缺失：给最小兼容形状（VOICE_TO_PROSODY 空表 = 不做语气增益；classify 恒失败）
  impl = {
    VOICE_TO_PROSODY: Object.freeze({}),
    classify: async () => ({ ok: false, error: 'lumen-semantic unavailable（未随包）' }),
  };
  try { console.warn('[lumen] 未找到 lumen-semantic-client.cjs（可选能力缺失，语气增益关闭）'); } catch (e) { /* ignore */ }
}

module.exports = impl;
