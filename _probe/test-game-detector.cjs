// _probe/test-game-detector.cjs —— game_detector.py 的回归（合成图，不需要真游戏）
//
// 为什么要有：血条检测算法踩过两个坑（ROI 比血条宽、每列阈值用绝对高度），
// 这两个坑都是「看着对但结果恒 0」。合成图能稳定复现，不依赖任何游戏窗口。
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function pythonBin() {
  try {
    const { resolvePython } = require(path.join(ROOT, '_incoming/my-neuro/live-2d/js/core/runtime-paths.js'));
    const p = resolvePython();
    if (p) return p;
  } catch (e) { /* 走下面的兜底 */ }
  return process.env.PET_PYTHON || 'python';
}

const script = path.join(ROOT, 'pet-runtime', 'tools', 'game_detector.py');
const r = spawnSync(pythonBin(), ['-X', 'utf8', script, '--selftest'], {
  encoding: 'utf8',
  timeout: 180000,
  windowsHide: true,
});
const out = String(r.stdout || '') + String(r.stderr || '');
process.stdout.write(out);
if (!out.endsWith('\n')) process.stdout.write('\n');

const m = out.match(/SELFTEST (PASS|FAIL)/);
if (m && m[1] === 'PASS') {
  // 断言条数从输出里数（原来写死 3，加了 motion 三条后门禁显示的数字就不对了）
  const n = out.split('\n').filter((l) => l.includes('PASS') && !l.includes('SELFTEST')).length;
  console.log('PASS ' + n + ' / FAIL 0');
  process.exit(0);
}
const fails = (out.match(/FAIL/g) || []).length;
console.log('PASS 0 / FAIL ' + Math.max(1, fails));
process.exit(1);
