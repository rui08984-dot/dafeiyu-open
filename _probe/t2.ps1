Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$sig = @'
using System;using System.Text;using System.Runtime.InteropServices;
public class T2W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
}
'@
Add-Type -TypeDefinition $sig
$script:f = [IntPtr]::Zero
$cb = [T2W+EnumProc]{ param($h,$l)
  $sb = New-Object System.Text.StringBuilder 512
  [void][T2W]::GetWindowTextW($h, $sb, 512)
  if ($sb.ToString() -eq 'ZCode') { $script:f = $h; return $false }
  return $true }
[void][T2W]::EnumWindows($cb, [IntPtr]::Zero)
Write-Output ("HWND=" + $script:f)
$root = [System.Windows.Automation.AutomationElement]::FromHandle($script:f)
$cache = New-Object System.Windows.Automation.CacheRequest
$cache.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
$cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::RuntimeIdProperty)
[void]$cache.Activate()
$found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
[void]$cache.Pop()
Write-Output ("COUNT=" + $found.Count)
$i = 0
foreach ($el in $found) {
  if ($i -ge 3) { break }
  $i++
  Write-Output ("--- el " + $i + " name=[" + $el.Cached.Name + "]")
  try { $r = $el.Cached.RuntimeId; Write-Output ("  Cached.RuntimeId type=" + $r.GetType().FullName + " val=" + ($r -join '|')) } catch { Write-Output ("  Cached.RuntimeId ERR: " + $_.Exception.Message) }
  try { $r2 = $el.GetRuntimeId(); Write-Output ("  GetRuntimeId val=" + ($r2 -join '|')) } catch { Write-Output ("  GetRuntimeId ERR: " + $_.Exception.Message) }
}
