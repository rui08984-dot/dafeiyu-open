#!/usr/bin/env node
/**
 * _probe/test-key-routing.cjs — act key 的游戏/非游戏路由（2026-11-25 P1-1）
 *
 * 病根：通用 press_key 先发 SendInput，但 GLFW 游戏（Minecraft）实测丢弃 SendInput，
 * 只认 PostMessage（js/core/game-loop.js:648-662）。本测试只打纯函数路由，不真按键。
 *
 * 判定：0 = 全过；非 0 = 有失败。
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

const PROFILES = [
    { game: 'elden-ring', window: 'ELDEN RING' },
    { game: 'minecraft-1.21.1', window: 'Minecraft' },
];

// ① 游戏识别：标题 / 进程 / profile 三路
ok('Minecraft 标题 → 游戏', GC.detectGameWindow({ title: 'Minecraft* 1.21.1' }, PROFILES).isGame === true);
ok('我的世界标题 → 游戏', GC.detectGameWindow({ title: '我的世界 1.20' }, PROFILES).game === '我的世界');
ok('大小写不敏感', GC.detectGameWindow({ title: 'MINECRAFT' }, PROFILES).isGame === true);
ok('javaw 进程 → 游戏', GC.detectGameWindow({ title: 'Some Window', app: 'javaw' }, PROFILES).via === 'process');
ok('javaw.exe 归一化后仍命中', GC.detectGameWindow({ title: 'X', app: 'javaw.exe' }, PROFILES).isGame === true);
ok('profile.window 命中 → 游戏', GC.detectGameWindow({ title: 'ELDEN RING™' }, PROFILES).via === 'profile');
ok('原神标题 → 游戏', GC.detectGameWindow({ title: '原神' }, []).game === '原神');
ok('CS2 标题 → 反恐精英', GC.detectGameWindow({ title: 'Counter-Strike 2' }, []).game === '反恐精英');

// ② 非游戏：不能被误判（否则按键会错误走 PostMessage）
ok('记事本 → 非游戏', GC.detectGameWindow({ title: 'a.txt - Notepad', app: 'notepad' }, PROFILES).isGame === false);
ok('空目标 → 非游戏', GC.detectGameWindow({}, PROFILES).isGame === false);
ok('浏览器里的 Minecraft 攻略 → 非游戏', GC.detectGameWindow({ title: 'Minecraft 攻略 - Google Chrome', app: 'chrome' }, PROFILES).isGame === false);
ok('编辑器里的 Minecraft 文件 → 非游戏', GC.detectGameWindow({ title: 'minecraft.js - Visual Studio Code', app: 'code' }, PROFILES).isGame === false);

// ③ 路由决策
const gameRoute = GC.decideKeyRoute({ title: 'Minecraft', app: 'javaw', hwnd: 12345 }, PROFILES);
ok('游戏 → postmessage', gameRoute.method === 'postmessage', gameRoute.method);
ok('游戏路由带 hwnd', gameRoute.hwnd === 12345);
const deskRoute = GC.decideKeyRoute({ title: 'a.txt - Notepad', app: 'notepad', hwnd: 88 }, PROFILES);
ok('非游戏 → sendinput', deskRoute.method === 'sendinput', deskRoute.method);
ok('非游戏路由不带 hwnd', deskRoute.hwnd === undefined);
const noHwnd = GC.decideKeyRoute({ title: 'Minecraft', app: 'javaw', hwnd: 0 }, PROFILES);
ok('游戏缺 hwnd → postmessage + error（不回退）', noHwnd.method === 'postmessage' && !!noHwnd.error, noHwnd.error);

// ④ PostMessage 的字符键映射（postKeysTo 用的同一套 vkFor）
ok('字符键 w → VK 0x57', GC.vkFor('w') === 0x57, String(GC.vkFor('w')));
ok('space → VK 0x20', GC.vkFor('space') === 0x20);
ok('F5 → VK 0x74', GC.vkFor('f5') === 0x74);
ok('大写 W 先归一化成 w', GC.normalizeKeyName('W') === 'w');
ok('数字键 1 → VK 0x31', GC.vkFor('1') === 0x31);

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
