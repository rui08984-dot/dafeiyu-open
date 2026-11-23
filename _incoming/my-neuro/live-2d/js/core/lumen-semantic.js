// js/core/lumen-semantic.js —— **薄壳**（2026-11-17 六十五轮）
//
// 实现只有一份：`pet-runtime/desktop/perf/lumen-semantic-client.cjs`
// （放在那边是因为渲染层 bundle 也要用它做「规则没命中时的情绪兜底」，
//   bundle 只能 import pet-runtime 下的模块）。
// 这里只是给宿主 JS / 插件一个习惯的路径。
module.exports = require('../../../../../pet-runtime/desktop/perf/lumen-semantic-client.cjs');
