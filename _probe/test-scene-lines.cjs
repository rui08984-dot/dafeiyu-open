#!/usr/bin/env node
/**
 * _probe/test-scene-lines.cjs —— 12 段场景台词单一真源（2026-11-25 P3b）
 *
 * 验四件事：
 *   ① js/core/scene-lines.js 的 12 个键与 petbody-entry.mjs 的 SCENES 一一对应；
 *   ② 台词非空、无重复、无纯空白；
 *   ③ 台词与 SCENES 里的 hint 一致（同一句话不能有两份说法）；
 *   ④ driver.js 与 ui-controller.js 都 require 同一个模块，且不残留内联硬编码表。
 *
 * 全离线（不启 Electron、不联网）。用法：node _probe/test-scene-lines.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LINES = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'scene-lines.js');
const ENTRY = path.join(ROOT, 'pet-runtime', 'desktop', 'petbody-entry.mjs');
const DRIVER = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'avatar', 'petbody', 'driver.js');
const UICTL = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'ui', 'ui-controller.js');

const mod = require(LINES);
const { SCENE_LINES, SCENE_LINE_KEYS, sceneLine } = mod;

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); }
  else { fail += 1; failures.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('场景台词单一真源');
console.log('');

// ── ① 与 SCENES 键对齐 ────────────────────────────────────────────────
const entrySrc = fs.readFileSync(ENTRY, 'utf8');
const sceneStart = entrySrc.indexOf('const SCENES = {');
const sceneEnd = sceneStart < 0 ? -1 : entrySrc.indexOf('\n};', sceneStart);
const sceneBlock = sceneStart >= 0 && sceneEnd > sceneStart ? entrySrc.slice(sceneStart, sceneEnd) : '';
const sceneKeys = [...sceneBlock.matchAll(/^  ([^\s:']+): \[/gm)].map((m) => m[1]);

check('petbody-entry.mjs 里解析出 12 段 SCENES', sceneKeys.length === 12, 'count=' + sceneKeys.length);
check('scene-lines 有 12 个键', SCENE_LINE_KEYS.length === 12, 'count=' + SCENE_LINE_KEYS.length);
check('12 个键与 SCENES 完全一致（顺序也一致）',
  JSON.stringify(SCENE_LINE_KEYS) === JSON.stringify(sceneKeys),
  JSON.stringify(SCENE_LINE_KEYS));

// ── ② 内容质量 ────────────────────────────────────────────────────────
const values = SCENE_LINE_KEYS.map((k) => SCENE_LINES[k]);
check('每句都是非空字符串', values.every((v) => typeof v === 'string' && v.length > 0));
check('没有纯空白台词', values.every((v) => typeof v === 'string' && v.trim() === v && v.trim().length > 0));
check('台词没有重复', new Set(values).size === values.length, 'unique=' + new Set(values).size);
check('台词都没有首尾空格', values.every((v) => v === v.trim()));

// ── ③ 与 SCENES 的 hint 一致（不许两份说法）───────────────────────────
// 顺序扫描：遇到「两空格 + 段名 + : [」就切当前段，遇到 hint: '...' 就记给当前段。
const hints = {};
{
  let current = null;
  const re = /^  ([^\s:']+): \[|hint: '([^']*)'/gm;
  let m;
  while ((m = re.exec(sceneBlock)) !== null) {
    if (m[1]) current = m[1];
    else if (current && !(current in hints)) hints[current] = m[2];
  }
}
const hintedKeys = Object.keys(hints);
check('SCENES 里 12 段都带 hint（死数据已全部启用）', hintedKeys.length === 12, 'count=' + hintedKeys.length);
const mismatched = SCENE_LINE_KEYS.filter((k) => hints[k] !== undefined && hints[k] !== SCENE_LINES[k]);
check('台词与 SCENES.hint 逐字一致', mismatched.length === 0, JSON.stringify(mismatched));

// ── ④ 两个消费者 require 同一模块 ────────────────────────────────────
const driverSrc = fs.readFileSync(DRIVER, 'utf8');
const uictlSrc = fs.readFileSync(UICTL, 'utf8');
const driverRequire = driverSrc.match(/require\(['"]([^'"]*scene-lines\.js)['"]\)/);
const uictlRequire = uictlSrc.match(/require\(['"]([^'"]*scene-lines\.js)['"]\)/);

check('driver.js require 了 scene-lines', Boolean(driverRequire), driverRequire && driverRequire[1]);
check('ui-controller.js require 了 scene-lines', Boolean(uictlRequire), uictlRequire && uictlRequire[1]);
const driverResolved = driverRequire ? path.resolve(path.dirname(DRIVER), driverRequire[1]) : '';
const uictlResolved = uictlRequire ? path.resolve(path.dirname(UICTL), uictlRequire[1]) : '';
check('两处解析到同一个绝对路径', driverResolved === path.resolve(LINES) && uictlResolved === path.resolve(LINES),
  driverResolved + ' | ' + uictlResolved);

check('driver.js 保留 SCENE_HINT 变量名指向导入表', /SCENE_LINES: SCENE_HINT/.test(driverSrc));
check('ui-controller.js 保留 SCENE_HINT 变量名指向导入表', /SCENE_LINES: SCENE_HINT/.test(uictlSrc));
check('driver.js 用 SCENE_HINT[msg.name] 取字幕', /SCENE_HINT\[msg\.name\]/.test(driverSrc));
check('ui-controller.js 用 SCENE_HINT[pick] 取字幕', /SCENE_HINT\[pick\]/.test(uictlSrc));
check('driver.js 不再内联台词表（找不到「哟，来了。」）', !driverSrc.includes('哟，来了。'));
check('ui-controller.js 不再内联台词表（找不到「哟，来了。」）', !uictlSrc.includes('哟，来了。'));

// ── ⑤ 取值接口 ───────────────────────────────────────────────────────
check('sceneLine(打招呼) 返回台词', sceneLine('打招呼') === SCENE_LINES['打招呼'], sceneLine('打招呼'));
check('未知段返回空串（调用方据此不显示字幕）', sceneLine('不存在的段') === '');
check('null/undefined 不抛错并返回空串', sceneLine(null) === '' && sceneLine(undefined) === '');

console.log('');
console.log(`PASS ${pass} / FAIL ${fail}`);
if (failures.length) console.log('失败项：' + failures.join(', '));
if (pass === 0) { console.error('PASS=0：没有任何断言真正执行，视为失败'); process.exitCode = 1; }
else process.exitCode = fail === 0 ? 0 : 1;
