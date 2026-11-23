$ErrorActionPreference='Stop'
# #14 WM_SETTEXT 后台填值实测 v3（2026-11-10 三十八轮）：递归找编辑控件 + 回读
# ⚠ 本文件必须 UTF-8 with BOM（铁律）；内容不要经命令行传（Windows 命令行是 GBK，中文会写坏——实测踩过）
$hwnd = 0
try { $hwnd = [int64]$env:PET_TEST_HWND } catch { }
if ($hwnd -eq 0) { '{"ok":false,"error":"缺 PET_TEST_HWND"}'; exit 1 }

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class W4 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")] public static extern IntPtr SendStr(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")] public static extern IntPtr SendBuf(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
  public static List<string> Kids(IntPtr root) {
    var list = new List<string>();
    EnumChildWindows(root, delegate(IntPtr h, IntPtr l) {
      var sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      var tb = new StringBuilder(128);
      GetWindowTextW(h, tb, 128);
      list.Add(h.ToInt64() + "|" + sb.ToString() + "|" + tb.ToString().Replace("|", " "));
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

$main = [IntPtr]$hwnd
if (-not [W4]::IsWindow($main)) { '{"ok":false,"error":"hwnd 无效"}'; exit 1 }
$fgBefore = [int64][W4]::GetForegroundWindow()

$kids = [W4]::Kids($main)
$edit = [IntPtr]::Zero; $editCls = ''
foreach ($k in $kids) {
  $parts = $k -split '\|'
  if ($parts[1] -match 'Edit') { $edit = [IntPtr][int64]$parts[0]; $editCls = $parts[1]; break }
}
if ($edit -eq [IntPtr]::Zero) {
  $o = [ordered]@{ ok=$false; error='没找到 Edit 类子窗口'; childCount=$kids.Count; children=$kids }
  # ⚠ 输出走 Base64（纯 ASCII）：pwsh stdout 在 GBK 代码页下会把 JSON 里的中文弄坏
#   ——实测：readbackCodes 全对但 readback 字符串在 Node 侧是「锟斤拷」。
#   繁体/中文数据一律 Base64 出，Node 侧 UTF-8 解码（本项目已验证范式）。
$json = $o | ConvertTo-Json -Compress
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
Write-Output ("B64:" + $b64); exit 2
}

# WM_SETTEXT = 0x000C（后台写入，不抢焦点）
$payload = [char]0x540E + [char]0x53F0 + [char]0x586B + [char]0x503C + ' WM_SETTEXT ' + [char]0x5B9E + [char]0x6D4B + ' ABC 123'
[void][W4]::SendStr($edit, 0x000C, [IntPtr]::Zero, $payload)

# WM_GETTEXT = 0x000D（回读：证明真的生效而不是"发出去了"）
$buf = New-Object System.Text.StringBuilder 512
[void][W4]::SendBuf($edit, 0x000D, [IntPtr]512, $buf)
$read = $buf.ToString()
$fgAfter = [int64][W4]::GetForegroundWindow()

# 逐字符 Unicode 码点也带出来（避免任何一层编码把中文弄坏后无法判断）
$codes = @()
foreach ($ch in $read.ToCharArray()) { $codes += [int][char]$ch }

$o = [ordered]@{
  ok = $true
  editClass = $editCls
  editHwnd = [int64]$edit
  readback = $read
  readbackCodes = $codes
  payloadCodes = @(($payload.ToCharArray() | ForEach-Object { [int][char]$_ }))
  fgBefore = $fgBefore
  fgAfter = $fgAfter
  foregroundUntouched = ($fgBefore -eq $fgAfter)
  childCount = $kids.Count
}
# ⚠ 输出走 Base64（纯 ASCII）：pwsh stdout 在 GBK 代码页下会把 JSON 里的中文弄坏
#   ——实测：readbackCodes 全对但 readback 字符串在 Node 侧是「锟斤拷」。
#   Node 侧解 B64 再 JSON.parse（本项目已验证范式）。
$json = $o | ConvertTo-Json -Compress
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
Write-Output ("B64:" + $b64)
