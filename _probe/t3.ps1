Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$sig = @'
using System;using System.Text;using System.Runtime.InteropServices;
public class T3W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
}
'@
Add-Type -TypeDefinition $sig
$script:f = [IntPtr]::Zero
$cb = [T3W+EnumProc]{ param($h,$l)
  $sb = New-Object System.Text.StringBuilder 512
  [void][T3W]::GetWindowTextW($h, $sb, 512)
  if ($sb.ToString() -eq 'ZCode') { $script:f = $h; return $false }
  return $true }
[void][T3W]::EnumWindows($cb, [IntPtr]::Zero)
$root = [System.Windows.Automation.AutomationElement]::FromHandle($script:f)
$cache = New-Object System.Windows.Automation.CacheRequest
$cache.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
foreach ($p in @('NameProperty','ControlTypeProperty','BoundingRectangleProperty','IsOffscreenProperty','ProcessIdProperty','IsEnabledProperty')) {
  $cache.Add([System.Windows.Automation.AutomationElement]::$p)
}
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsControlElementProperty, $true)
[void]$cache.Activate()
$found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
[void]$cache.Pop()
Write-Output ("SCANNED=" + $found.Count)
# 只对「有名字 + 非离屏 + 尺寸够」的元素取 RuntimeId，最多 60 个
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$hit = 0
foreach ($el in $found) {
  if ($hit -ge 60) { break }
  try {
    $n = $el.Cached.Name
    if (-not $n) { continue }
    if ($el.Cached.IsOffscreen) { continue }
    $r = $el.Cached.BoundingRectangle
    if ($r.Width -le 2 -or $r.Height -le 2) { continue }
    $rid = $el.GetRuntimeId()   # 只有被选中的才付跨进程代价
    $hit++
  } catch { }
}
$sw.Stop()
Write-Output ("RID_FOR_60_MS=" + $sw.ElapsedMilliseconds + " hits=" + $hit)
