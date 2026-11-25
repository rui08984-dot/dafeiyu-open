#!/usr/bin/env node
/**
 * _probe/test-focus-verified.cjs — focus_window 假成功链收口（2026-11-25 P1-3）
 *
 * 上一批已让 focus_window 回读 GetForegroundWindow 并返回 verified；本测试守两件事：
 *   ① 所有 focus 调用方不得再只看 ok：launch_app 的「已切到前台」必须 verified===true；
 *   ② focusWindow 的每条成功返回都自带 verified:true，失败自带 verified:false。
 * 判定用纯函数 buildFocusVerdict + 源码 grep，不需要真窗口。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const GC_PATH = path.join(LIVE, 'plugins', 'community', 'dispatch', 'game-control.js');
const IDX_PATH = path.join(LIVE, 'plugins', 'community', 'dispatch', 'index.js');
const GC_SRC = fs.readFileSync(GC_PATH, 'utf8');
const IDX_SRC = fs.readFileSync(IDX_PATH, 'utf8');
const CV = require(path.join(LIVE, 'plugins', 'community', 'dispatch', 'control-verify.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ① 判定层：回读一致才算 confirmed
const good = CV.buildFocusVerdict(
    { ok: true, verified: true, hwnd: 100, title: '记事本' },
    { hwnd: 100, title: '记事本' }, '记事本',
);
ok('回读 hwnd 一致 → ok:true', good.ok === true);
ok('回读 hwnd 一致 → verified:true', good.verified === true);
ok('回读 hwnd 一致 → effect:confirmed', good.effect === 'confirmed', good.effect);

// ② 假成功：动作自报 ok，但前台没变 → 不得 confirmed
const fake = CV.buildFocusVerdict(
    { ok: true, verified: true, hwnd: 100, title: '记事本' },
    { hwnd: 200, title: 'ZCode' }, '记事本',
);
ok('自报 ok 但前台不匹配 → ok:false', fake.ok === false);
ok('自报 ok 但前台不匹配 → verified:false', fake.verified === false);
ok('自报 ok 但前台不匹配 → 不是 confirmed', fake.effect !== 'confirmed', fake.effect);
ok('假成功带真实前台', /ZCode/.test(String(fake.actual || fake.detail || '')), fake.actual);

// ③ 解析不到 → not_sent（动作没发出去，不能当成功）
const unresolved = CV.buildFocusVerdict({ ok: false, verified: false, unresolved: true, error: '没找到' }, null, '不存在');
ok('解析不到 → ok:false + effect:not_sent', unresolved.ok === false && unresolved.effect === 'not_sent', unresolved.effect);

// ④ focusWindow 每条成功/失败都带 verified（源码守卫）
const verifiedTrue = (GC_SRC.match(/ok: true, verified: true, via:/g) || []).length;
ok('focusWindow 成功路径 ≥2 条带 verified:true', verifiedTrue >= 2, 'count=' + verifiedTrue);
ok('focusWindow 失败路径带 verified:false', /ok: false, verified: false, via: 'rust'/.test(GC_SRC)
    && /ok: false, verified: false, via: 'uia-service'/.test(GC_SRC)
    && /ok: false, verified: false, via: 'pwsh-fallback'/.test(GC_SRC));

// ⑤ 调用方：launch_app 必须 verified===true，不能再看 fwInfo.ok
ok('launch_app 用 verified===true 判「已切到前台」', /const focused = !!\(fwInfo && fwInfo\.verified === true\)/.test(GC_SRC));
ok('launch_app 不再用 fwInfo.ok 判前台', !/const focused = !!\(fwInfo && fwInfo\.ok\)/.test(GC_SRC));
ok('dispatch/index 不把 focus 结果强改 confirmed', !/focus_window[\s\S]{0,200}VC\.confirmed/.test(IDX_SRC));

// ⑥ focusWindowRetry 只透传（不吞 verified）
ok('focusWindowRetry 返回 focusWindow 原对象', /last = await focusWindow\(titleOrPid, opts\)/.test(GC_SRC)
    && /return last;/.test(GC_SRC));

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
