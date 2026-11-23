// idle-detect.cjs —— 用户活跃度检测（2026-11-09 三十轮）
//
// 为什么需要：她主动说话时最尴尬的情形是「用户正在专注干活/开会/打游戏」。
// 现在系统只知道「有没有在玩游戏」，不知道「用户是不是在忙」。加这一层后：
//   · 用户 5 分钟没动键鼠 → 大概在发呆/离开 → 可以主动说句话
//   · 用户正在持续输入（打字/点击密集）→ 在专注 → 别打扰
//   · 全屏应用 + 高频输入 → 会议/游戏 → 更该闭嘴
//
// 实现：Win32 GetLastInputInfo（系统级最后一次输入时间，含键盘鼠标触摸），
// 只读、极轻（一次调用 <1ms）、零权限要求。
// 输出：{ idleMs, busy: bool, state: 'active'|'idle'|'away' }
//   active  = 30 秒内有输入（在忙/在用）
//   idle    = 30 秒-5 分钟无输入（可能在想事）
//   away    = >5 分钟无输入（大概率离开了）

const { spawn } = require('child_process');

function runPs(script, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const wrapped = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + script;
      const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', wrapped], { windowsHide: true });
      child.stdout.setEncoding('utf8');
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', (e) => resolve({ ok: false, error: e.message }));
      child.on('close', (code) => resolve({ ok: code === 0, out: out.trim() }));
      setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

/**
 * 读系统最后一次输入距今多久（毫秒）。
 * @returns {Promise<{idleMs:number, busy:boolean, state:string}>}
 */
async function detectIdle() {
  const ps = [
    "$sig = @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
    'public class IDLE {',
    '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO lii);',
    '  [DllImport("kernel32.dll")] public static extern uint GetTickCount();',
    '}',
    "'@",
    'Add-Type -TypeDefinition $sig',
    '$lii = New-Object LASTINPUTINFO',
    '$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)',
    '[void][IDLE]::GetLastInputInfo([ref]$lii)',
    '$tick = [IDLE]::GetTickCount()',
    '$idle = $tick - $lii.dwTime',
    '[string]$idle',
  ].join('\n');
  const r = await runPs(ps, 3000);
  if (!r.ok || !r.out) return { idleMs: 0, busy: true, state: 'unknown' };
  const idleMs = Number(String(r.out).replace(/[^0-9]/g, '')) || 0;
  let state = 'active';
  if (idleMs > 300000) state = 'away';        // >5 分钟
  else if (idleMs > 30000) state = 'idle';    // 30 秒-5 分钟
  return { idleMs, busy: state === 'active', state };
}

module.exports = { detectIdle };

// CLI：node idle-detect.cjs → 单行 JSON
if (require.main === module) {
  detectIdle()
    .then((r) => { process.stdout.write(JSON.stringify(r)); })
    .catch((e) => { process.stdout.write(JSON.stringify({ idleMs: 0, busy: true, state: 'error:' + (e && e.message || e) })); })
    .finally(() => { process.exit(0); });
}
