#!/usr/bin/env node
/**
 * _probe/test-quiet-perception.cjs —— 静默模式不能掐掉「按需感知」（2026-11-23 根因回归）
 *
 * 要防的回归（真机事故）：
 *   用户在静默模式(cost.quiet=true)下问「你在看/听什么」，她回「画面没接到、声音没接到」。
 *   根因不是模型/插件没启用，而是三处闸门把**零成本本地感知**也一起关了：
 *     ① vision-organ._record 静默即 return null → keyframes=0
 *     ② index._probeMedia 静默即 return → _winTitlesAt=0 → 状态机恒 idle
 *     ③ index._coWatchContext 先过 coWatchStateAllows → idle 时直接空串
 *   正确语义：静默只抑制「花钱的摘要」与「主动开口」，不抑制「用户按需的看/听」。
 *
 * 本测试是静态结构断言 + 纯函数行为断言（不启动 Electron）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUG = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'watch-screen');
const ORGAN = fs.readFileSync(path.join(PLUG, 'vision-organ.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(PLUG, 'index.js'), 'utf8');

let pass = 0; let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ① vision-organ：静默期必须写本地关键帧，不能 return null
{
  const hasLocalRecord = /if \(quiet\) return this\._recordLocal\(/.test(ORGAN);
  ok('vision-organ 静默期写本地关键帧（_recordLocal）', hasLocalRecord);
  const badNull = /if \(quiet\) return null/.test(ORGAN);
  ok('vision-organ 静默期不再直接 return null', !badNull);
  ok('_recordLocal 存在且不发网络请求', /_recordLocal\s*\(/.test(ORGAN)
    && !/async _recordLocal[\s\S]{0,800}(fetch|axios|http\.request)/.test(ORGAN));
}

// ② index._probeMedia：不能因静默早退
{
  const probeStart = INDEX.indexOf('async _probeMedia()');
  const probeBody = INDEX.slice(probeStart, probeStart + 1600);
  ok('_probeMedia 不再静默早退', !/if \(global\.__petQuiet\) return;/.test(probeBody));
  ok('_probeMedia 仍写窗口标题快照', /this\._winTitlesAt = Date\.now\(\)/.test(probeBody));
}

// ③ index._classifyScreenState：静默期本地帧(kind=quiet)下也能用窗口标题判 video/working
{
  const clsStart = INDEX.indexOf('_classifyScreenState(now)');
  const clsBody = INDEX.slice(clsStart, clsStart + 3200);
  ok('_classifyScreenState 有 titles→video 兜底', /via:\s*'titles'/.test(clsBody));
  ok('兜底在 idle 之前（先 titles 再 idle）',
    clsBody.indexOf("via: 'titles'") < clsBody.lastIndexOf("state: 'idle'"));
}

// ④ index._coWatchContext：按需豁免必须是**显式 opt-in**（默认仍严格）
{
  const ctxStart = INDEX.indexOf('_coWatchContext(seconds');
  const ctxBody = INDEX.slice(ctxStart, ctxStart + 1600);
  ok('_coWatchContext 支持显式 userAsked 豁免', /userAsked/.test(ctxBody));
  ok('默认（未 userAsked）仍走状态门返回空', /if \(!asked\) return ''/.test(ctxBody));
  ok('_coWatchContext 仍保留状态门调用', /coWatchStateAllows\(/.test(ctxBody));
  const callers = INDEX.match(/_coWatchContext\([^)]*\)/g) || [];
  ok('按需路径（cowatch_now）显式传 userAsked:true',
    /cowatch_now[\s\S]{0,400}_coWatchContext\([^)]*userAsked:\s*true/.test(INDEX), String(callers.length) + ' 个调用点');
}

// ⑤ 主动开口闸门必须保留（静默语义不能被改坏）
{
  const commentGate = /_commentOn\([\s\S]{0,400}?if \(global\.__petQuiet\) return false/.test(INDEX);
  ok('_commentOn 静默期仍拒绝主动开口', commentGate);
  const patchGate = /_refreshCoWatchPatch\(\)[\s\S]{0,2600}?if \(global\.__petQuiet\) \{ this\.context\.removeSystemPromptPatch/.test(INDEX);
  ok('静默期仍摘掉一起看系统补丁（不注入主动语境）', patchGate);
}

console.log('\n静默感知：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
