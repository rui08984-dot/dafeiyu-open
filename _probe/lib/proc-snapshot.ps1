# proc-snapshot.ps1 —— mem-soak.cjs 的进程快照助手（只读）
# 输出一行压缩 JSON：{t, freeMB, procs:[{pid,ppid,name,ws,priv,handles,threads,start,cmd}]}
# ws/priv 单位字节；cmd 原样（分类交给调用方 Node）。
$ErrorActionPreference = 'SilentlyContinue'
# 中文路径必须按 UTF-8 输出，否则命令行里的 <project-root> 会被 GBK 替换成 U+FFFD
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$byId = @{}
Get-Process | ForEach-Object { $byId[[int]$_.Id] = $_ }
$list = [System.Collections.Generic.List[object]]::new()
foreach ($p in (Get-CimInstance Win32_Process)) {
  if ($p.Name -notmatch '^(node|electron|python|pythonw|pet-core|crashpad_handler)\.exe$') { continue }
  $gp = $byId[[int]$p.ProcessId]
  $ws = 0L; $priv = 0L; $hc = 0; $tc = 0; $st = ''
  if ($gp) {
    $ws = [long]$gp.WorkingSet64
    $priv = [long]$gp.PrivateMemorySize64
    $hc = [int]$gp.HandleCount
    try { $tc = [int]$gp.Threads.Count } catch { $tc = 0 }
    try { if ($gp.StartTime) { $st = $gp.StartTime.ToUniversalTime().ToString('o') } } catch { $st = '' }
  } else {
    $ws = [long]$p.WorkingSetSize
  }
  $list.Add([pscustomobject]@{
    pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = $p.Name;
    ws = $ws; priv = $priv; handles = $hc; threads = $tc; start = $st;
    cmd = [string]$p.CommandLine
  })
}
$os = Get-CimInstance Win32_OperatingSystem
$free = 0
if ($os) { $free = [int]($os.FreePhysicalMemory / 1024) }
[pscustomobject]@{ t = $now; freeMB = $free; procs = $list } | ConvertTo-Json -Depth 3 -Compress
