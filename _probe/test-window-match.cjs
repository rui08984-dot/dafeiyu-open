#!/usr/bin/env node
/**
 * _probe/test-window-match.cjs — 短标题解析与绑定共用同一个 matcher（2026-11-25 P1-2）
 *
 * 病根：`see window=QQ` 用子串解析到「QQ音乐」成功，`act click window=QQ` 的绑定层
 * 却要求短标题精确 → 永远 STALE。现在两层都走 titleMatchKind：
 *   exact → prefix+boundary（短侧 ≥4）→ substring（短针 ≥2）；
 *   多命中一律 AMBIGUOUS，列候选，不猜。
 *
 * 纯函数测试，不需要真窗口。
 */
'use strict';

const path = require('path');
const GC = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'game-control.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const W = (hwnd, title, pid) => ({ hwnd, title, pid: pid || hwnd * 10, class: '', iconic: false });

// ① matcher 三档
ok('完全相同 → exact', GC.titleMatchKind('QQ', 'QQ') === 'exact');
ok('前缀 + 空格分隔 → prefix', GC.titleMatchKind('Visual Studio Code - main.js', 'Visual Studio Code') === 'prefix');
ok('前缀无分隔符 → 退到 substring（不判 prefix）', GC.titleMatchKind('Photoshop2024', 'Photoshop') === 'substring');
ok('短针（2 字）唯一子串 → substring', GC.titleMatchKind('QQ音乐', 'QQ') === 'substring');
ok('1 字针不做子串（防全命中）', GC.titleMatchKind('QQ音乐', 'Q') === null);
ok('无关标题 → null', GC.titleMatchKind('QQ音乐', '微信') === null);

// ② 解析器：唯一命中
const exact = GC.pickWindowForTarget([W(1, 'QQ'), W(2, 'QQ音乐')], 'QQ');
ok('exact 优先于 substring', exact.ok === true && exact.win.hwnd === 1 && exact.matchedBy === 'exact', exact.matchedBy);

const prefix = GC.pickWindowForTarget([W(1, 'Visual Studio Code - a.js'), W(2, 'Visual Studio Code - b.js'), W(3, 'Notepad')], 'Visual Studio Code - a.js');
ok('完整标题 → exact 唯一', prefix.ok === true && prefix.win.hwnd === 1);

const pref2 = GC.pickWindowForTarget([W(1, 'Visual Studio Code - a.js'), W(2, 'Notepad')], 'Visual Studio Code');
ok('前缀命中唯一窗口', pref2.ok === true && pref2.win.hwnd === 1 && pref2.matchedBy === 'prefix', pref2.matchedBy);

const sub = GC.pickWindowForTarget([W(1, 'QQ音乐'), W(2, 'Notepad')], 'QQ');
ok('唯一子串命中 QQ音乐', sub.ok === true && sub.win.hwnd === 1 && sub.matchedBy === 'substring', sub.matchedBy);

// ③ 解析器：歧义（绝不猜）
const ambExact = GC.pickWindowForTarget([W(1, 'QQ'), W(2, 'QQ')], 'QQ');
ok('两个完全同名 → AMBIGUOUS', ambExact.ok === false && ambExact.code === 'AMBIGUOUS', ambExact.code);
ok('歧义错误列出 2 个候选', ambExact.candidates.length === 2 && /hwnd=1/.test(ambExact.error) && /hwnd=2/.test(ambExact.error));

const ambSub = GC.pickWindowForTarget([W(1, 'QQ音乐'), W(2, 'QQ浏览器'), W(3, 'Notepad')], 'QQ');
ok('子串多命中 → AMBIGUOUS', ambSub.ok === false && ambSub.code === 'AMBIGUOUS' && ambSub.candidates.length === 2, ambSub.code);

const ambPrefix = GC.pickWindowForTarget([W(1, 'Visual Studio Code - a'), W(2, 'Visual Studio Code - b')], 'Visual Studio Code');
ok('前缀多命中 → AMBIGUOUS', ambPrefix.ok === false && ambPrefix.code === 'AMBIGUOUS', ambPrefix.code);

const nf = GC.pickWindowForTarget([W(1, 'QQ音乐'), W(2, 'Notepad')], '微信');
ok('不存在 → NOT_FOUND', nf.ok === false && nf.code === 'NOT_FOUND' && nf.candidates.length === 0, nf.code);

// ④ pid 分支仍可打分（同一进程的 UWP 空壳 + 真窗）
const pidPick = GC.pickWindowForTarget([W(1, 'Calculator', 77), W(2, 'Calculator', 77)], '');
ok('pid 分支不报歧义（按打分挑真窗）', pidPick.ok === true && pidPick.matchedBy === 'pid-pick');

// ⑤ 绑定层与解析层同一个答案（see → click 不再 STALE）
const hooks = GC.__testHooks;
ok('绑定层接受 QQ → QQ音乐（与解析一致）', hooks.winTitleMatches('QQ音乐', 'QQ') === true);
ok('绑定层接受前缀 + 分隔符', hooks.winTitleMatches('Visual Studio Code - main.js', 'Visual Studio Code') === true);
ok('绑定层拒绝 1 字针', hooks.winTitleMatches('QQ音乐', 'Q') === false);
const seeRes = GC.pickWindowForTarget([W(1, 'QQ音乐'), W(2, 'Notepad')], 'QQ');
ok('see 解析结果 → click 绑定同窗', seeRes.ok === true && hooks.winTitleMatches(seeRes.win.title, 'QQ') === true);

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
