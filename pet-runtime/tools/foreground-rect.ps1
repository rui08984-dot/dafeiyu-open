$ErrorActionPreference = "SilentlyContinue"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PetWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
while ($true) {
  $h = [PetWin]::GetForegroundWindow()
  $r = New-Object PetWin+RECT
  [void][PetWin]::GetWindowRect($h, [ref]$r)
  Write-Output ("$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)")
  Start-Sleep -Milliseconds 2000
}
