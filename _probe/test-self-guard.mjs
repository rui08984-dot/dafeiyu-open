#!/usr/bin/env node
/**
 * _probe/test-self-guard.mjs — 自身窗口 / 破坏性按钮守卫回归（2026-11-18 §71）
 *
 * 守的是三条判据（§69.5 的 P0 + §70.5 的实测）：
 *   ① 落点在自己窗口矩形内 → 必须拒绝（透明窗也一样）；
 *   ② 「不保存/放弃/丢弃」一族按钮 → 默认拒绝，带 confirm_destructive 才放行；
 *   ③ 「删除/格式化」这类有破坏性但可能正常 → 放行但标注 warning，不制造假拦截。
 *
 * 纯函数测试，不需要 Electron / pet-core。
 * 用法：node _probe/test-self-guard.mjs
 */
'use strict';

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'self-guard.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// 本机真实布局的量级：2560×1600@150%，皮套 420×760 DIP 在右下
const OWN = [
  { id: 1, title: '大肥鱼', transparent: true, pid: 100, rect: { x: 1700, y: 800, w: 630, h: 1140 } },
  { id: 2, title: '字幕窗', transparent: true, pid: 100, rect: { x: 1650, y: 1368, w: 960, h: 264 } },
  { id: 3, title: '设置', transparent: false, pid: 200, rect: { x: 100, y: 100, w: 1200, h: 900 } },
];

console.log('\n自身窗口 / 破坏性按钮守卫（§71）：');

// ① 落点判定
{
  const inside = G.checkPoint(OWN, 1800, 900);
  ok('落在皮套里 → 拒绝', inside.blocked === true);
  ok('拒绝原因点名是哪个窗口', /大肥鱼/.test(String(inside.reason)), String(inside.reason).slice(0, 60));
  ok('拒绝时给替代路径（UIA 不依赖坐标）', /click_element|som_click|click_text/.test(String(inside.hint)));

  const outside = G.checkPoint(OWN, 300, 300);   // 在设置窗里 → 也是自己的
  ok('落在设置窗里 → 拒绝（不透明窗）', outside.blocked === true && /设置/.test(String(outside.reason)));

  const free = G.checkPoint(OWN, 2400, 200);     // 桌面空白（右上）
  ok('落在桌面空白 → 放行', free.blocked === false, JSON.stringify(free));

  // 半开区间：左/上含，右下边不含（避免相邻窗口边界上双命中）
  ok('边界：左/上含、右下边不含（半开区间）',
    G.checkPoint(OWN, 1700, 800).blocked === true        // 左上角：命中
    && G.checkPoint(OWN, 2329, 800).blocked === true     // 右边界内 1px：命中
    && G.checkPoint(OWN, 2330, 800).blocked === false);  // 右边界外：不命中

  ok('窗口清单为空 → 放行（纯 Node 环境没有自身窗口）', G.checkPoint([], 1800, 900).blocked === false);
  ok('坐标不是数字 → 拒绝（坐标算错比点到别处好）',
    G.checkPoint(OWN, 'abc', 900).blocked === true);
  ok('rect 非法（w<=0）→ 不参与判定',
    G.checkPoint([{ rect: { x: 0, y: 0, w: 0, h: 100 } }], 0, 50).blocked === false);
}

// ② 破坏性按钮
{
  const discard = G.checkButton('不保存');
  ok('「不保存」→ 拒绝', discard.blocked === true && discard.level === 'discard');
  ok('拒绝文案讲清后果（数据丢了）', /丢弃|数据/.test(String(discard.reason)));
  ok('拒绝文案教怎么带确认', /confirm_destructive/.test(String(discard.hint)));

  ok('英文 Don\'t Save → 拒绝', G.checkButton("Don't Save").blocked === true);
  ok('「放弃更改」→ 拒绝', G.checkButton('放弃更改').blocked === true);
  ok('「Discard」→ 拒绝', G.checkButton('Discard').blocked === true);

  const confirmed = G.checkButton('不保存', { confirmDestructive: true });
  ok('带 confirm_destructive:true → 放行', confirmed.blocked === false && confirmed.level === 'discard');

  const del = G.checkButton('删除');
  ok('「删除」→ 放行但标注 warning（正常任务的一部分）',
    del.blocked === false && del.level === 'destructive' && /破坏性/.test(String(del.warning)));
  ok('「格式化」→ 放行+标注', G.checkButton('格式化').blocked === false && G.checkButton('格式化').level === 'destructive');

  ok('「保存」→ 完全不拦不标（保存不是丢弃）',
    G.checkButton('保存').blocked === false && G.checkButton('保存').level === null);
  ok('「确定」/「OK」→ 不拦不标',
    G.checkButton('确定').level === null && G.checkButton('OK').level === null);
  ok('普通按钮名 → 不拦不标', G.checkButton('下一页').level === null && G.checkButton('下一页').blocked === false);
  ok('空名字 → 不拦（不是按钮）', G.checkButton('').blocked === false && G.checkButton(null).blocked === false);
}

// ③ 类目分类器（供将来扩展）
{
  ok('classifyButton 区分三类',
    G.classifyButton('不保存').level === 'discard'
    && G.classifyButton('删除').level === 'destructive'
    && G.classifyButton('保存').level === null);
}

console.log('');
console.log(`  自身窗口/破坏性按钮守卫：PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
