# _probe/lib/win-fg.ps1 —— 读/设前台窗口 + 把窗口移出屏幕（后台操控验收用）
# 用法：
#   pwsh -NoProfile -File win-fg.ps1                 # 输出 "<hwnd>|<title>"
#   pwsh -NoProfile -File win-fg.ps1 -Set 123456     # 把前台设回 hwnd，再输出
#   pwsh -NoProfile -File win-fg.ps1 -MoveOff 123456 # 把窗口移到屏幕外（可见但看不见），再输出
param([long]$Set = 0, [long]$MoveOff = 0)

# 中文标题必须 UTF-8 输出：否则 Node 侧按 utf8 读会是乱码（CP936 老坑）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
'@

if ($MoveOff -ne 0) {
  # SWP_NOSIZE(0x1) | SWP_NOZORDER(0x4) | SWP_NOACTIVATE(0x10)
  try { [void][FgProbe]::SetWindowPos([IntPtr]$MoveOff, [IntPtr]::Zero, -4000, 0, 0, 0, 0x15) } catch { }
  Start-Sleep -Milliseconds 120
}
if ($Set -ne 0) {
  try { [void][FgProbe]::SetForegroundWindow([IntPtr]$Set) } catch { }
  Start-Sleep -Milliseconds 200
}
$h = [FgProbe]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[void][FgProbe]::GetWindowText($h, $sb, 256)
$procId = 0
[void][FgProbe]::GetWindowThreadProcessId($h, [ref]$procId)
"$($h.ToInt64())|$procId|$($sb.ToString())"
