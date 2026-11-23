// game-watch.js —— 游戏/全屏应用感知（2026-11-09）
//
// 目的：她在你玩游戏时应该**让出 GPU/CPU**，不玩游戏时保持满帧。
//   用户实测反馈：「待机的帧数可能太小了看起来卡多加点吧」→ 平时必须满帧；
//   而满帧一次 _model.update() 要 7ms（Cubism5 硬成本），游戏时不该跟游戏抢资源。
//
// 判定「在玩游戏」的三条依据（任一成立）：
//   ① 前台窗口是独占全屏（尺寸 ≈ 显示器尺寸）
//   ② 前台进程名在黑名单里（常见游戏平台/引擎/模拟器）
//   ③ 前台窗口标题命中游戏关键词（League of Legends / 原神 / Steam 等）
//
// 只读，零副作用；检测失败一律当「没在玩游戏」（宁可满帧，不可误降）。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── pet-core 快路径（2026-11-10 三十六轮）────────────────────────────────
// 为什么加它：原来只有 pwsh 一条路，实测单次 1450-2310ms，而 `runPs` 超时 4000ms
//   → **机器一忙就 detect-failed**（本机实测返回过 `{"gaming":false,"reason":"detect-failed"}`）。
//   而 main.js 每 3 秒调一次 = 一直养着一个 pwsh 进程，纯浪费。
//   pet-core 的 fg / windows 各 4ms，快了 400 倍，且它 DPI-aware（物理坐标），
//   和 pwsh 那条 DPI-unaware（逻辑坐标 1707×1067）不是一套坐标系 —— 用 core 之后
//   「全屏判定」才和实际屏幕尺寸对得上。
// pwsh 那条保留为兜底（pet-core 二进制不存在时）。
const CORE_EXE = path.join(__dirname, '..', '..', 'pet-core', 'target', 'release', 'pet-core.exe');

function runCore(obj, timeoutMs = 1500) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        try {
            if (!fs.existsSync(CORE_EXE)) return finish(null);
            const child = spawn(CORE_EXE, [], { windowsHide: true });
            let out = '';
            child.stdout.on('data', (c) => { out += c; });
            child.on('error', () => finish(null));
            child.on('close', () => {
                try { finish(JSON.parse(out)); } catch (e) { finish(null); }
            });
            child.stdin.write(JSON.stringify(obj));
            child.stdin.end();
            setTimeout(() => { try { child.kill(); } catch (e) { /* 忽略 */ } finish(null); }, timeoutMs);
        } catch (e) { finish(null); }
    });
}

/**
 * pet-core 快路径：fg 拿前台 hwnd+标题，windows 拿矩形和屏幕尺寸。
 * 返回 null 表示这条路径不可用（交给 pwsh 兜底）。
 */
async function detectViaCore(extraProcesses) {
    const list0 = DEFAULT_GAME_PROCESSES.concat(
        (extraProcesses || []).map((s) => String(s || '').toLowerCase()).filter(Boolean)
    );
    const fg = await runCore({ cmd: 'fg' });
    if (!fg || !fg.ok) return null;
    const wins = await runCore({ cmd: 'windows', filter: '', max: 80 });
    if (!wins || !wins.ok || !Array.isArray(wins.windows)) return null;

    const self = wins.windows.find((w) => Number(w.hwnd) === Number(fg.hwnd));
    // 屏幕尺寸：Program Manager（Progman）永远是全屏尺寸，且它是 DPI-aware 进程读出来的物理像素
    const desk = wins.windows.find((w) => /^Program Manager$/i.test(String(w.title || '')))
        || wins.windows.reduce((a, b) => (!a || (b.w * b.h > a.w * a.h) ? b : a), null);
    if (!self || !desk) return null;

    const title = String(fg.title || self.title || '');
    // ⚠ pet-core 的 windows 不返回进程名，只有 pid。进程名这条判据在这里拿不到，
    //   所以 core 路径只靠「全屏 + 标题关键词」，确定性比 pwsh 那条弱一点点 ——
    //   但 pwsh 那条在机器忙时整条挂掉（detect-failed），两条相比 core 明显更可靠。
    const fullscreen = self.w >= desk.w - 8 && self.h >= desk.h - 8;
    const titleHit = GAME_TITLE_HINTS.test(title);

    if (fullscreen && titleHit) return { gaming: true, reason: 'core:fullscreen+title', app: title.slice(0, 40), fullscreen, via: 'core' };
    if (fullscreen) return { gaming: false, reason: 'core:fullscreen-no-game', app: title.slice(0, 40), fullscreen: true, via: 'core' };
    // 非全屏：标题命中游戏词也算（原代码的 procHit/titleHit 单独成立就判 gaming）
    if (titleHit) return { gaming: true, reason: 'core:title', app: title.slice(0, 40), fullscreen, via: 'core' };
    return { gaming: false, reason: 'core:none', app: title.slice(0, 40), fullscreen, via: 'core' };
}

// 常见游戏进程（可被 plugin_config.json 的 game_processes 覆盖/追加）
const DEFAULT_GAME_PROCESSES = [
  'league of legends', 'leagueclient', 'valorant', 'cs2', 'csgo', 'dota2',
  'genshinimpact', 'yuanshen', 'starrail', 'zenlesszonezero',
  'steam', 'steamwebhelper', 'epicgameslauncher', 'battle.net', 'origin',
  'minecraft', 'javaw', 'wow', 'overwatch', 'destiny2', 'apex_legends',
  'eldenring', 'sekiro', 'blackmythwukong', 'gta5', 'rdr2',
  'mumuplayer', 'nox', 'ldplayer', 'bluestacks', 'mumu',
  'osu', 'rhythia', 'ffxiv', 'ff14', 'lostark', 'pubg',
];
// 标题关键词（有些游戏进程名是通用的 javaw/unity）
const GAME_TITLE_HINTS = /(原神|崩坏|星穹|绝区零|王者荣耀|英雄联盟|永劫无间|黑神话|艾尔登|赛博朋克|守望先锋|绝地求生|穿越火线|三角洲|命运|最终幻想|游戏|Game|Genshin|Honkai|Zenless|League|Valorant|Counter-Strike|Dota|Overwatch|Minecraft|Steam|Epic|Battle\.net|模拟器|Emulator)/i;

function runPs(script, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const wrapped = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ' + script;
      const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', wrapped], { windowsHide: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      let out = '', err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.on('error', (e) => resolve({ ok: false, error: e.message }));
      child.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), error: err.trim() }));
      setTimeout(() => { try { child.kill(); } catch (e) { /* 忽略 */ } resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

/**
 * 检测当前是否在玩游戏 / 有全屏应用。
 * @param {string[]} extraProcesses 追加的游戏进程名（小写）
 * @returns {Promise<{gaming:boolean, reason:string, app?:string, fullscreen?:boolean}>}
 */
async function detectGaming(extraProcesses) {
  // ① 快路径：pet-core（两次 spawn，各 4ms）。拿不到就往下走。
  const viaCore = await detectViaCore(extraProcesses);
  if (viaCore) return viaCore;

  // ② 兜底：pwsh（实测 1450-2310ms，超时从 4000 → 8000：
  //    4 秒在机器忙时（同时跑 OCR / 编译 / 多个子代理）会被打穿，
  //    打穿就返回 detect-failed，等于陪玩模式静默失效。）
  const list = DEFAULT_GAME_PROCESSES.concat(
    (extraProcesses || []).map((s) => String(s || '').toLowerCase()).filter(Boolean)
  );
  // 一次 pwsh 拿到：前台窗口标题、进程名、窗口矩形、主屏尺寸
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);public struct RECT{public int L;public int T;public int R;public int B;}}'
$h = [W]::GetForegroundWindow()
$r = New-Object W+RECT
[void][W]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $hh = $r.B - $r.T
$p = Get-Process -Id (Get-Process | Where-Object { $_.MainWindowHandle -eq $h } | Select-Object -First 1 -ExpandProperty Id) -ErrorAction SilentlyContinue
$name = if ($p) { $p.ProcessName } else { '' }
$title = if ($p) { $p.MainWindowTitle } else { '' }
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
@{ proc = $name; title = $title; w = $w; h = $hh; sw = $scr.Width; sh = $scr.Height } | ConvertTo-Json -Compress
`;
  const r = await runPs(ps, 8000);
  if (!r.ok || !r.out) return { gaming: false, reason: 'detect-failed' };
  let d = {};
  try { d = JSON.parse(r.out); } catch (e) { return { gaming: false, reason: 'parse-failed' }; }

  const proc = String(d.proc || '').toLowerCase();
  const title = String(d.title || '');
  // ① 全屏（容差 8px：任务栏自动隐藏时高度会略差）
  const fullscreen = Number(d.w) >= Number(d.sw) - 8 && Number(d.h) >= Number(d.sh) - 8;
  // ② 进程名命中
  const procHit = list.some((p) => proc.includes(p));
  // ③ 标题关键词
  const titleHit = GAME_TITLE_HINTS.test(title);

  if (fullscreen && procHit) return { gaming: true, reason: 'fullscreen+proc', app: proc, fullscreen };
  if (fullscreen && titleHit) return { gaming: true, reason: 'fullscreen+title', app: title.slice(0, 40), fullscreen };
  if (procHit) return { gaming: true, reason: 'proc', app: proc, fullscreen };
  if (fullscreen) return { gaming: false, reason: 'fullscreen-no-game', app: proc, fullscreen: true };
  return { gaming: false, reason: 'none', app: proc, fullscreen };
}

module.exports = { detectGaming, DEFAULT_GAME_PROCESSES };

// CLI 用法（main.js 每 3 秒 execFile 调一次，输出单行 JSON）。
// 只读检测，绝不改系统状态。
if (require.main === module) {
  detectGaming()
    .then((r) => { process.stdout.write(JSON.stringify(r)); })
    .catch((e) => { process.stdout.write(JSON.stringify({ gaming: false, reason: 'error:' + (e && e.message || e) })); })
    .finally(() => { process.exit(0); });
}
