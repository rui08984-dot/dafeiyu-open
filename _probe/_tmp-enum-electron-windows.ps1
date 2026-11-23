# 列出宿主 Electron 主进程的所有可见顶层窗口（物理像素 + exstyle）
# 用途：拖动预览窗验收（真实窗不动 / 预览窗跟随且 WS_EX_TRANSPARENT）
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$main = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
  Select-Object -First 1
if (-not $main) { Write-Output '{"error":"no electron main"}'; exit 1 }
$TargetPid = [int]$main.ProcessId

$out = New-Object System.Collections.ArrayList
$cb = [WinEnum+EnumProc]{
  param($h, $l)
  $p = 0
  [void][WinEnum]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -ne $TargetPid) { return $true }
  if (-not [WinEnum]::IsWindowVisible($h)) { return $true }
  $r = New-Object WinEnum+RECT
  [void][WinEnum]::GetWindowRect($h, [ref]$r)
  $sb = New-Object System.Text.StringBuilder 512
  [void][WinEnum]::GetWindowText($h, $sb, 512)
  $ex = [WinEnum]::GetWindowLongPtr($h, -20).ToInt64()
  [void]$out.Add([pscustomobject]@{
    hwnd = $h.ToInt64();
    left = $r.Left; top = $r.Top;
    w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top);
    title = $sb.ToString();
    exstyle = ('0x{0:X}' -f $ex);
    transparent = (($ex -band 0x20) -ne 0)
  })
  return $true
}
[void][WinEnum]::EnumWindows($cb, [IntPtr]::Zero)

$doc = [pscustomobject]@{ pid = $TargetPid; scaleHint = 'Electron bounds 是 DIP；本清单是物理像素（×1.5）'; windows = $out }
$doc | ConvertTo-Json -Depth 4
