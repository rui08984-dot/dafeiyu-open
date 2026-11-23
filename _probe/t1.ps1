Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cache = New-Object System.Windows.Automation.CacheRequest
$cache.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
$cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsControlElementProperty, $true)
$cache.Activate()
$found = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$null = $cache.Pop()
Write-Output ("FOUND=" + $found.Count)
Write-Output "=== 不吞 Pop 返回值，看它吐不吐 ==="
$cache2 = New-Object System.Windows.Automation.CacheRequest
$cache2.Activate()
$res2 = @($cache2.Pop())
Write-Output ("POP_OUTPUT_COUNT=" + $res2.Count)
if ($res2.Count -gt 0) { Write-Output ("POP_TYPE=" + $res2[0].GetType().FullName) }
