// probe: 用真实 pet-core 输出跑 assertTargetFocused 的数字匹配谓词（不注入任何输入）
const { execFileSync } = require('child_process');
const BIN = '<project-root>/pet-core/target/release/pet-core.exe';
const run = (obj) => JSON.parse(execFileSync(BIN, [], { input: JSON.stringify(obj), timeout: 8000 }).toString());
const fg = run({ cmd: 'fg' });
const wins = run({ cmd: 'windows', max: 20 }).windows;
console.log('pet-core fg =', JSON.stringify(fg));
const target = wins.find((w) => w.title === fg.title) || wins[0];
console.log('要看的目标窗口 =', JSON.stringify({ title: target.title, pid: target.pid, hwnd: target.hwnd }));

// 复刻 game-control.js:574-577 的谓词
const match = (num) => num === Number(fg.pid || 0) || num === Number(fg.hwnd || 0);
console.log('focus=hwnd(' + target.hwnd + ') → match =', match(target.hwnd));
console.log('focus=pid(' + target.pid + ')   → match =', match(target.pid), '  ← list_windows 展示的 #号就是 pid');
