// js/core/scene-lines.js —— 12 段短场景台词的单一真源（2026-11-25 P3b）
//
// 病根（ADR-015 §4.5 第 5 条）：同一张表在 driver.js 与 ui-controller.js 各抄一份，
// 而且两份都只覆盖 12 段里的 6 段 —— 皮套 SCENES 里另外 6 段的 hint 是死数据，
// 手点场景不出字幕，改台词还得同时改两处（必然漂移）。
//
// 现在台词住在这里：
//   · 键 = pet-runtime/desktop/petbody-entry.mjs 里 SCENES 的段名（12 段一一对应）；
//   · 值 = 点这一段时她说的那句话（与 SCENES 的 hint 一致）；
//   · 消费者：js/avatar/petbody/driver.js（WS perform 消息）、
//            js/ui/ui-controller.js（右键菜单「演一段」）。
// 契约测试：_probe/test-scene-lines.cjs（12 键齐全 / 非空 / 无重复 / 两处 require 同一模块）。
'use strict';

const SCENE_LINES = {
  打招呼: '哟，来了。',
  撒娇: '……你就不能多陪我一会儿嘛。',
  生气: '哼，你自己玩去吧。',
  难过: '……算了，没事。',
  得意: '怎么样，服不服。',
  伸懒腰: '唔……几点了。',
  鼓掌: '好耶！',
  想事情: '嗯……让我想想。',
  点头: '嗯，知道了。',
  晚安: '睡了，别熬夜。',
  鞠躬: '多谢款待！',
  指一指: '诶，那边！',
};

const SCENE_LINE_KEYS = Object.keys(SCENE_LINES);

/** 取一句台词；未登记的段返回空串（调用方据此决定不显示字幕）。 */
function sceneLine(name) {
  const key = String(name == null ? '' : name);
  return Object.prototype.hasOwnProperty.call(SCENE_LINES, key) ? SCENE_LINES[key] : '';
}

module.exports = { SCENE_LINES, SCENE_LINE_KEYS, sceneLine };
