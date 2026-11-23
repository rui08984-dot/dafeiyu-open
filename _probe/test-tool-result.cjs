#!/usr/bin/env node
/**
 * _probe/test-tool-result.cjs — 工具回执统一判据（A3，2026-11-21）
 *
 * 要防的回归：
 *   ① 用真值判成败（`{ok:false}` 是真值 → 失败被当成功）
 *   ② 失败却没有原因（backfilled）—— 模型不知道是重试还是换方法
 *   ③ 审计计数不区分「形状违规」与「失败无原因」
 */
'use strict';

const path = require('path');
const TR = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'tool-result.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ① parse：形状归一
ok('JSON 字符串解析成对象', TR.parse('{"ok":true,"x":1}').ok === true);
ok('普通文本不强行当 JSON', TR.parse('hello').text === 'hello');
ok('空字符串判失败且不编原因', TR.isFailure('') === true && TR.detailOf('') === '');
ok('null 判失败', TR.isFailure(null) === true);
ok('undefined 判失败', TR.isFailure(undefined) === true);
ok('数组原样返回（typeof object）', typeof TR.parse('[1,2]') === 'object' && Array.isArray(TR.parse('[1,2]')));
ok('数字包装成 value', TR.parse(42).value === 42);
ok('坏 JSON 当文本（不炸）', TR.parse('{oops').text === '{oops');

// ② isFailure：核心判据
ok('{ok:false} 判失败（旧实现在这里判成功）', TR.isFailure({ ok: false }) === true);
ok('{ok:false,detail} 判失败', TR.isFailure({ ok: false, detail: 'x' }) === true);
ok('{ok:true} 判成功', TR.isFailure({ ok: true }) === false);
ok('{error} 无 ok 判失败（历史形状）', TR.isFailure({ error: 'boom' }) === true);
ok('JSON 字符串里的 ok:false 判失败', TR.isFailure('{"ok":false,"error":"boom"}') === true);
ok('纯文本判成功', TR.isFailure('截图里有 3 个窗口') === false);

// ③ detailOf：失败必须能说出原因
ok('detail 优先', TR.detailOf({ ok: false, detail: 'D' }) === 'D');
ok('error 兜底', TR.detailOf({ ok: false, error: 'E' }) === 'E');
ok('message 兜底', TR.detailOf({ ok: false, message: 'M' }) === 'M');
ok('都没有时为空（会触发 backfilled）', TR.detailOf({ ok: false }) === '');

// ④ audit：计数与验收口径
TR.resetStats();
const a1 = TR.audit('see', { ok: true });
const a2 = TR.audit('act', { ok: false, detail: '窗口不存在' });
const a3 = TR.audit('game', { ok: false });          // 失败无原因 → backfilled
const a4 = TR.audit('file', undefined);              // 形状违规 + 失败无原因
const snap = TR.snapshot();
ok('成功回执 ok:true', a1.ok === true && a1.backfilled === false);
ok('失败且有 detail → ok:false 但不 backfilled', a2.ok === false && a2.backfilled === false && a2.detail === '窗口不存在');
ok('失败无 detail → backfilled=true', a3.backfilled === true);
ok('undefined → violation', snap.violations === 1, 'violations=' + snap.violations);
ok('checked 计数正确', snap.checked === 4, snap.checked);
ok('backfilled 计数正确', snap.backfilled === 2, snap.backfilled);
ok('byTool 分工具记账', snap.byTool.game && snap.byTool.game.failures === 1 && snap.byTool.game.backfilled === 1);
TR.resetStats();
ok('resetStats 清零', TR.snapshot().checked === 0 && TR.snapshot().violations === 0);

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
