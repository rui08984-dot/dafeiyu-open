# restart-loop-audit.ps1 —— 重启循环审计（可复跑）
#
# 目的：反复「退出→重开」后不留尸体实例，且每次重启确实换成新代码。
# 每轮做：
#   1) 快照：相关进程（electron / node launcher / pet-core / 本项目 py 服务）、
#      14 个端口的监听归属、.state 与临时目录大小；
#   2) 真跑 pet-runtime/tools/restart-pet.ps1；
#   3) 等 8004/bounds 与 8103/state 都通；
#   4) 断言 8004/8103 的 pid 相对上一轮必须变化（不变 = 旧实例还占着端口）；
#   5) 再快照，输出新增/消失进程、端口归属变化、内存/磁盘变化；
#   6) 点名异常：同端口多 pid、electron 主进程 != 1、无窗口 electron、
#      某服务解释器实例数 > services.json 声明、孤儿进程（父 pid 已死）。
#
# 用法：
#   pwsh -NoProfile -File _probe/restart-loop-audit.ps1                 # 默认 3 轮
#   pwsh -NoProfile -File _probe/restart-loop-audit.ps1 -Rounds 5
#   pwsh -NoProfile -File _probe/restart-loop-audit.ps1 -ContinueOnFail # 失败也跑完
# 退出码：0 = 全部轮次 PASS；1 = 至少一轮 FAIL。
#
# 判进程一律用 pid + 命令行 + 端口，不按进程名一把抓（避免误杀其它 electron 应用）。

param(
    [int]$Rounds = 3,
    [string]$RestartScript = '',
    [int]$RestartTimeoutSec = 360,
    [int]$ReadyTimeoutSec = 150,
    [switch]$ContinueOnFail
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $RestartScript) { $RestartScript = Join-Path $root 'pet-runtime\tools\restart-pet.ps1' }
$rootLower = $root.ToLower()
$manifestPath = Join-Path $root 'pet-runtime\tools\services.json'
$logDir = Join-Path $env:TEMP 'pet-restart-audit-logs'

if (-not (Test-Path -LiteralPath $RestartScript)) { Write-Output "FAIL 找不到重启脚本: $RestartScript"; exit 1 }
if (-not (Test-Path -LiteralPath $manifestPath)) { Write-Output "FAIL 找不到服务清单: $manifestPath"; exit 1 }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
$services = @($manifest.services)
$AuditPorts = @($services | ForEach-Object { [int]$_.port })
# 任务要求的端口清单，与清单合并（清单缺项也照样盯）
foreach ($p in @(8004, 8103, 8102, 9883, 1000, 1001, 8020, 8003, 3003, 3004, 8120, 8104, 8106)) {
    if (-not ($AuditPorts -contains $p)) { $AuditPorts += $p }
}
$AuditPorts = @($AuditPorts | Sort-Object -Unique)

$scriptProfiles = @(
    (Join-Path $root 'pet-runtime\.state'),
    (Join-Path $env:TEMP 'pet-wgc'),
    (Join-Path $env:APPDATA 'combined-project')
)

# 本项目自己的服务脚本绝对路径（小写）。_probe\soak 的隔离实例也带同名脚本，
# 只按「项目根 + 文件名」会把 soak 的 python 也算进「相关进程」，污染内存/差异表。
$script:OurServiceScripts = @()
foreach ($s in $services) {
    if ($s.start -and $s.start.script) {
        $script:OurServiceScripts += (Join-Path $root ([string]$s.start.script)).ToLowerInvariant()
    }
    if ($s.start -and $s.start.venvPython) {
        $script:OurServiceScripts += (Join-Path $root ([string]$s.start.venvPython)).ToLowerInvariant()
    }
}
$script:OurServiceScripts = @($script:OurServiceScripts | Sort-Object -Unique)

# ── 工具函数 ───────────────────────────────────────────────────────────────
function Get-DirStat([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) {
        return [pscustomobject]@{ Path = $path; Exists = $false; Bytes = 0; Files = 0; Newest = $null; Oldest = $null }
    }
    $files = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue)
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    if (-not $bytes) { $bytes = 0 }
    $newest = if ($files.Count -gt 0) { ($files | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime } else { $null }
    $oldest = if ($files.Count -gt 0) { ($files | Sort-Object LastWriteTime | Select-Object -First 1).LastWriteTime } else { $null }
    return [pscustomobject]@{ Path = $path; Exists = $true; Bytes = [int64]$bytes; Files = $files.Count; Newest = $newest; Oldest = $oldest }
}

function Test-RelatedProcess([string]$name, [string]$cmd) {
    if (-not $cmd) { return $false }
    $c = $cmd.ToLowerInvariant()
    $n = $name.ToLowerInvariant()
    # 只认本项目宿主（app 路径含 live-2d）。同机可能有 _probe\soak 的隔离实例，
    # 它也用 productName=combined-project —— 用 combined-project 会把它也算进来。
    if ($n -eq 'electron.exe') { return $c.Contains('live-2d') }
    if ($n -eq 'node.exe') { return $c.Contains('launch-my-neuro') }
    # pet-core 只认本项目精确路径：_probe\soak 的隔离实例也有 pet-core.exe。
    if ($n -eq 'pet-core.exe') { return $c.Contains($rootLower + '\pet-core\target\release\pet-core.exe') }
    if ($n -match '^(py|python|pythonw)\.exe$') {
        foreach ($sp in $script:OurServiceScripts) { if ($c.Contains($sp)) { return $true } }
        return $false
    }
    if ($n -match '^(pwsh|powershell)\.exe$') { return ($c.Contains('send-input.ps1') -or $c.Contains('uia-service.ps1')) }
    return $false
}

function Get-Snapshot {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $allPids = @{}
    $ppidMap = @{}
    foreach ($p in $all) {
        $allPids[[int]$p.ProcessId] = $true
        $ppidMap[[int]$p.ProcessId] = [int]$p.ParentProcessId
    }
    $byPid = @{}
    foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }

    $related = @()
    foreach ($p in $all) {
        $name = [string]$p.Name
        $cmd = [string]$p.CommandLine
        if (-not (Test-RelatedProcess $name $cmd)) { continue }
        $mainHandle = 0
        $title = ''
        try {
            $gp = Get-Process -Id $p.ProcessId -ErrorAction Stop
            $mainHandle = [int64]$gp.MainWindowHandle
            $title = [string]$gp.MainWindowTitle
        } catch { }
        $created = $null
        try { $created = [Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate) } catch { }
        $related += [pscustomobject]@{
            Pid       = [int]$p.ProcessId
            PPid      = [int]$p.ParentProcessId
            Name      = $name
            Cmd       = $cmd
            MemMB     = [math]::Round(($p.WorkingSetSize / 1MB), 1)
            Created   = $created
            MainHwnd  = $mainHandle
            Title     = $title
            ParentAlive = ($allPids.ContainsKey([int]$p.ParentProcessId))
            IsElectronMain = ($name.ToLowerInvariant() -eq 'electron.exe' -and -not $cmd.Contains('--type=') -and
                # 排除用 electron 跑辅助脚本的进程（如 idle-detect.cjs）：它们不是第二个宿主实例。
                $cmd -notmatch '\.(cjs|mjs|js)"?\s*$')
        }
    }

    $portMap = [ordered]@{}
    foreach ($port in $AuditPorts) {
        $conns = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
        $pids = @($conns | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 } | Sort-Object)
        $owners = @()
        foreach ($ownerPid in $pids) {
            $nm = '?'
            $cm = ''
            if ($byPid.ContainsKey([int]$ownerPid)) {
                $nm = [string]$byPid[[int]$ownerPid].Name
                $cm = [string]$byPid[[int]$ownerPid].CommandLine
            }
            $owners += [pscustomobject]@{ Pid = [int]$ownerPid; Name = $nm; Cmd = $cm }
        }
        $portMap[[string]$port] = [pscustomobject]@{ Pids = $pids; Owners = $owners }
    }

    $dirs = @()
    foreach ($d in $scriptProfiles) { $dirs += Get-DirStat $d }

    # 每个 start.script 对应的「服务实例」数。
    # 注意 Windows 的 venv python.exe 是引导器，会再起一个同名解释器进程；
    # 因此不能按解释器个数算（会把 1 个服务误报成 2 个）。这里数的是
    # **直接挂在 launcher 下的服务进程**（py 包装器或 venv 引导器），一个脚本一份。
    $launcherPids = @($related | Where-Object { $_.Name -ieq 'node.exe' -and $_.Cmd.ToLowerInvariant().Contains('launch-my-neuro') } | ForEach-Object { $_.Pid })
    $svcCounts = [ordered]@{}
    foreach ($s in $services) {
        if (-not $s.start -or -not $s.start.script) { continue }
        $scriptLeaf = Split-Path -Leaf ([string]$s.start.script)
        $scriptLeaf = $scriptLeaf.ToLowerInvariant()
        $instances = @($related | Where-Object {
            $_.Cmd.ToLowerInvariant().Contains($scriptLeaf) -and ($launcherPids -contains $_.PPid)
        })
        $listeners = @($portMap[[string]$s.port].Pids)
        $svcCounts[[string]$s.id] = [pscustomobject]@{
            Port = [int]$s.port; Script = $scriptLeaf; Count = $instances.Count
            Pids = @($instances | ForEach-Object { $_.Pid }); Listeners = $listeners
            LaunchBy = [string]$s.launchBy
        }
    }

    $memMB = [math]::Round((($related | Measure-Object -Property MemMB -Sum).Sum), 1)
    if (-not $memMB) { $memMB = 0 }
    $electronMain = @($related | Where-Object { $_.IsElectronMain })

    return [pscustomobject]@{
        TakenAt     = (Get-Date).ToString('HH:mm:ss')
        Related     = $related
        PortMap     = $portMap
        Dirs        = $dirs
        SvcCounts   = $svcCounts
        MemMB       = $memMB
        ElectronMain = $electronMain
        PpidMap     = $ppidMap
        LauncherPids = $launcherPids
    }
}

# pid 是否是某祖先的后代（沿 ParentProcessId 上溯；防环）
function Test-DescendantOf($snap, [int]$targetPid, [int]$ancestorPid) {
    $cur = $targetPid
    for ($i = 0; $i -lt 12; $i++) {
        if ($cur -eq $ancestorPid) { return $true }
        if (-not $snap.PpidMap.ContainsKey($cur)) { return $false }
        $next = [int]$snap.PpidMap[$cur]
        if ($next -le 0 -or $next -eq $cur) { return $false }
        $cur = $next
    }
    return $false
}

function Get-PortPidsText($snap, [int]$port) {
    $e = $snap.PortMap[[string]$port]
    if (-not $e -or $e.Pids.Count -eq 0) { return '-' }
    return ($e.Pids -join ',')
}

function Format-Mem([double]$mb) {
    if ($mb -ge 1024) { return ('{0:N2} GB' -f ($mb / 1024)) }
    return ('{0:N0} MB' -f $mb)
}

function Compare-Snapshot($before, $after) {
    $beforeKey = @{}
    foreach ($p in $before.Related) { $beforeKey["$($p.Pid)"] = $p }
    $afterKey = @{}
    foreach ($p in $after.Related) { $afterKey["$($p.Pid)"] = $p }

    $new = @()
    foreach ($p in $after.Related) {
        if (-not $beforeKey.ContainsKey("$($p.Pid)")) { $new += $p; continue }
        # pid 被复用（创建时间不同）也算新实例
        $old = $beforeKey["$($p.Pid)"]
        if ($old.Created -and $p.Created -and $old.Created -ne $p.Created) { $new += $p }
    }
    $gone = @()
    foreach ($p in $before.Related) {
        if (-not $afterKey.ContainsKey("$($p.Pid)")) { $gone += $p; continue }
        $now = $afterKey["$($p.Pid)"]
        if ($p.Created -and $now.Created -and $p.Created -ne $now.Created) { $gone += $p }
    }

    $portDiffs = @()
    foreach ($port in $AuditPorts) {
        $b = @($before.PortMap[[string]$port].Pids)
        $a = @($after.PortMap[[string]$port].Pids)
        if (($b -join ',') -ne ($a -join ',')) {
            $portDiffs += [pscustomobject]@{ Port = $port; Before = ($b -join ','); After = ($a -join ',') }
        }
    }

    $dirDiffs = @()
    foreach ($d in $after.Dirs) {
        $old = $before.Dirs | Where-Object { $_.Path -eq $d.Path } | Select-Object -First 1
        $oldBytes = if ($old) { [int64]$old.Bytes } else { 0 }
        $dirDiffs += [pscustomobject]@{
            Path = $d.Path; Exists = $d.Exists; Files = $d.Files
            BeforeMB = [math]::Round(($oldBytes / 1MB), 1); AfterMB = [math]::Round(($d.Bytes / 1MB), 1)
            DeltaMB = [math]::Round((($d.Bytes - $oldBytes) / 1MB), 1)
        }
    }

    return [pscustomobject]@{
        New = $new; Gone = $gone; PortDiffs = $portDiffs; DirDiffs = $dirDiffs
        MemBefore = $before.MemMB; MemAfter = $after.MemMB
    }
}

function Get-Anomalies($snap) {
    $issues = @()
    $notes = @()
    # 1) 同一端口多个 pid
    foreach ($port in $AuditPorts) {
        $e = $snap.PortMap[[string]$port]
        if ($e -and $e.Pids.Count -gt 1) {
            $issues += ("端口 $port 有 " + $e.Pids.Count + " 个监听 pid: " + ($e.Pids -join ','))
        }
    }
    # 2) electron 主进程必须恰好 1 个，且有窗口
    $mains = @($snap.ElectronMain)
    if ($mains.Count -gt 1) {
        $issues += ("electron 主进程有 " + $mains.Count + " 个（无窗口僵尸？）: " + (($mains | ForEach-Object { "$($_.Pid)[hwnd=$($_.MainHwnd)]" }) -join ' '))
    }
    foreach ($m in $mains) {
        if ($m.MainHwnd -eq 0) { $issues += ("electron 主进程 pid=$($m.Pid) 无主窗口（hwnd=0）") }
    }
    # 3) 服务实例数 > 清单声明（直接挂在 launcher 下的同脚本进程，每项应为 1）
    foreach ($id in $snap.SvcCounts.Keys) {
        $c = $snap.SvcCounts[$id]
        if ($c.Count -gt 1) {
            $issues += ("服务 $id 有 $($c.Count) 个实例（清单声明 1）: pid " + ($c.Pids -join ','))
        }
    }
    # 4) 端口监听者必须是当前 launcher 的后代（launcher/electron 负责的服务）。
    #    这就是「8103 归最早那个实例」的判据：pid 变了但监听者不是新 launcher 的树 → 旧实例/外部占用。
    if ($snap.LauncherPids.Count -gt 0) {
        foreach ($id in $snap.SvcCounts.Keys) {
            $c = $snap.SvcCounts[$id]
            if ($c.LaunchBy -notin @('launcher', 'electron')) { continue }
            foreach ($lp in $c.Listeners) {
                $owned = $false
                foreach ($launcherPid in $snap.LauncherPids) {
                    if (Test-DescendantOf $snap ([int]$lp) ([int]$launcherPid)) { $owned = $true; break }
                }
                if (-not $owned) {
                    $issues += ("端口 $($c.Port) ($id) 的监听 pid=$lp 不在当前 launcher 的进程树里（旧实例/外部占用）")
                }
            }
        }
    }
    # 5) 孤儿进程（父 pid 已死）。排除 launcher 自身：它按设计就是脱离父进程的监督者。
    $orphans = @($snap.Related | Where-Object {
        -not $_.ParentAlive -and $_.PPid -gt 0 -and
        -not ($_.Name -ieq 'node.exe' -and $_.Cmd.ToLowerInvariant().Contains('launch-my-neuro'))
    })
    foreach ($o in $orphans) {
        $issues += ("孤儿进程 pid=$($o.Pid) $($o.Name)（父 pid=$($o.PPid) 已退出）: " + $o.Cmd.Substring(0, [Math]::Min(120, $o.Cmd.Length)))
    }
    # 6) 真残留 vs WMI 延迟：CIM 快照里的关键 pid，用 Get-Process 复核。
    #    Get-Process 已不存在 → 说明是 WMI 延迟（假残留），只记录、不算异常。
    $keyPids = @($mains | ForEach-Object { $_.Pid })
    foreach ($port in $AuditPorts) { $keyPids += @($snap.PortMap[[string]$port].Pids) }
    foreach ($pidToCheck in @($keyPids | Sort-Object -Unique)) {
        $alive = $null -ne (Get-Process -Id $pidToCheck -ErrorAction SilentlyContinue)
        if (-not $alive) { $notes += ("WMI 延迟/假残留: pid=$pidToCheck 在 CIM 快照里但 Get-Process 已不存在") }
    }
    return [pscustomobject]@{ Issues = $issues; Notes = $notes }
}

function Invoke-Restart([int]$round) {
    $out = Join-Path $logDir ("round-$round.out.log")
    $err = Join-Path $logDir ("round-$round.err.log")
    Remove-Item -LiteralPath $out, $err -ErrorAction SilentlyContinue
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-File', $RestartScript) `
        -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
    $finished = $p.WaitForExit($RestartTimeoutSec * 1000)
    $sw.Stop()
    if (-not $finished) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
        return [pscustomobject]@{ ExitCode = 'timeout'; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); Out = $out; Err = $err }
    }
    return [pscustomobject]@{ ExitCode = $p.ExitCode; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); Out = $out; Err = $err }
}

function Wait-Ready([int]$TimeoutSec) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $bounds = $false
    $state = $false
    while ((Get-Date) -lt $deadline) {
        if (-not $bounds) {
            try {
                $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8004/bounds' -TimeoutSec 3 -ErrorAction Stop
                if ($null -ne $r.bounds) { $bounds = $true }
            } catch { }
        }
        if (-not $state) {
            try {
                $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8103/state' -TimeoutSec 3 -ErrorAction Stop
                if ($r.ok) { $state = $true }
            } catch { }
        }
        if ($bounds -and $state) { break }
        Start-Sleep -Milliseconds 1500
    }
    $sw.Stop()
    return [pscustomobject]@{ Ready = ($bounds -and $state); Bounds = $bounds; State = $state; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
}

# ── 主循环 ─────────────────────────────────────────────────────────────────
Write-Output ('审计开始 ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' · 轮数=' + $Rounds)
Write-Output ('清单: ' + $services.Count + ' 项 · 端口: ' + ($AuditPorts -join ','))
Write-Output ('日志目录: ' + $logDir)
Write-Output ''

$prev = Get-Snapshot
Write-Output ('=== 基线 ' + $prev.TakenAt + ' ===')
Write-Output ('  相关进程 ' + $prev.Related.Count + ' 个 · 合计 ' + (Format-Mem $prev.MemMB))
Write-Output ('  8004 pid=' + (Get-PortPidsText $prev 8004) + ' · 8103 pid=' + (Get-PortPidsText $prev 8103))
foreach ($d in $prev.Dirs) {
    Write-Output ('  磁盘 ' + $d.Path + ' = ' + [math]::Round(($d.Bytes / 1MB), 1) + ' MB / ' + $d.Files + ' files')
}
Write-Output ''

$roundResults = @()
$overallOk = $true

for ($round = 1; $round -le $Rounds; $round++) {
    Write-Output ('=== ROUND ' + $round + '/' + $Rounds + ' ===')
    $before = $prev
    $restart = Invoke-Restart $round
    Write-Output ('  restart-pet: exit=' + $restart.ExitCode + ' · ' + $restart.Seconds + 's')

    $ready = Wait-Ready $ReadyTimeoutSec
    Write-Output ('  就绪: ' + $ready.Ready + ' (8004/bounds=' + $ready.Bounds + ', 8103/state=' + $ready.State + ') · ' + $ready.Seconds + 's')

    if (-not $ready.Ready) {
        try {
            Write-Output '  ---- restart 输出末尾 ----'
            Get-Content -LiteralPath $restart.Out -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ('  [out] ' + $_) }
            Get-Content -LiteralPath $restart.Err -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ('  [err] ' + $_) }
            Write-Output '  ---- 结束 ----'
        } catch { }
    }

    $after = Get-Snapshot
    $diff = Compare-Snapshot $before $after

    $b8004 = Get-PortPidsText $before 8004
    $a8004 = Get-PortPidsText $after 8004
    $b8103 = Get-PortPidsText $before 8103
    $a8103 = Get-PortPidsText $after 8103
    $pidChanged = ($a8004 -ne '-' -and $a8103 -ne '-' -and ($a8004 -ne $b8004) -and ($a8103 -ne $b8103))
    $sameInstance = ($a8103 -eq $b8103)

    Write-Output ('  8004 pid: ' + $b8004 + ' -> ' + $a8004 + '  ' + $(if ($a8004 -ne $b8004) { 'CHANGED' } else { 'SAME!!' }))
    Write-Output ('  8103 pid: ' + $b8103 + ' -> ' + $a8103 + '  ' + $(if ($a8103 -ne $b8103) { 'CHANGED' } else { 'SAME!!' }))
    Write-Output ('  实例切换: ' + $(if ($pidChanged) { 'PASS' } else { 'FAIL（旧实例可能还占着端口/新实例被单实例锁挡掉）' }))
    Write-Output ('  内存: ' + (Format-Mem $diff.MemBefore) + ' -> ' + (Format-Mem $diff.MemAfter) + ' (Δ ' + ('{0:N0}' -f ($diff.MemAfter - $diff.MemBefore)) + ' MB)')

    Write-Output ('  新增进程 (' + $diff.New.Count + '):')
    foreach ($p in $diff.New) { Write-Output ('    + pid=' + $p.Pid + ' ' + $p.Name + ' mem=' + $p.MemMB + 'MB | ' + $p.Cmd.Substring(0, [Math]::Min(150, $p.Cmd.Length))) }
    Write-Output ('  消失进程 (' + $diff.Gone.Count + '):')
    foreach ($p in $diff.Gone) { Write-Output ('    - pid=' + $p.Pid + ' ' + $p.Name + ' mem=' + $p.MemMB + 'MB | ' + $p.Cmd.Substring(0, [Math]::Min(150, $p.Cmd.Length))) }

    Write-Output ('  端口归属变化 (' + $diff.PortDiffs.Count + '):')
    foreach ($d in $diff.PortDiffs) { Write-Output ('    ' + $d.Port + ': ' + $(if ($d.Before) { $d.Before } else { '-' }) + ' -> ' + $(if ($d.After) { $d.After } else { '-' })) }

    Write-Output '  磁盘变化:'
    foreach ($d in $diff.DirDiffs) {
        Write-Output ('    ' + $d.Path + ': ' + $d.BeforeMB + ' MB -> ' + $d.AfterMB + ' MB (Δ ' + $d.DeltaMB + ' MB, ' + $d.Files + ' files)')
    }

    $anomResult = Get-Anomalies $after
    $anoms = @($anomResult.Issues)
    if ($anomResult.Notes.Count -gt 0) {
        Write-Output ('  判据备注 (' + $anomResult.Notes.Count + '):')
        foreach ($n in $anomResult.Notes) { Write-Output ('    ~~ ' + $n) }
    }
    if ($restart.ExitCode -ne 0) { $anoms = @('restart-pet 退出码=' + $restart.ExitCode) + $anoms }
    if (-not $ready.Ready) { $anoms = @('就绪超时：8004/bounds=' + $ready.Bounds + ' 8103/state=' + $ready.State) + $anoms }
    if (-not $pidChanged) { $anoms = @('8004/8103 的 pid 未变化（重启没生效）') + $anoms }

    if ($anoms.Count -gt 0) {
        Write-Output ('  异常 (' + $anoms.Count + '):')
        foreach ($a in $anoms) { Write-Output ('    !! ' + $a) }
    } else {
        Write-Output '  异常: 无'
    }
    Write-Output ''

    $roundResults += [pscustomobject]@{
        Round = $round; Exit = $restart.ExitCode; Ready = $ready.Ready; ReadySec = $ready.Seconds
        P8004Before = $b8004; P8004After = $a8004; P8103Before = $b8103; P8103After = $a8103
        PidChanged = $pidChanged; New = $diff.New.Count; Gone = $diff.Gone.Count
        MemBefore = $diff.MemBefore; MemAfter = $diff.MemAfter
        Anomalies = $anoms
    }

    if ($anoms.Count -gt 0) { $overallOk = $false; if (-not $ContinueOnFail) { Write-Output '遇到异常，停止后续轮次（用 -ContinueOnFail 可跑完）'; break } }
    $prev = $after
}

Write-Output '=== 汇总 ==='
foreach ($r in $roundResults) {
    Write-Output ('  轮 {0}: exit={1} ready={2}({3}s) 8004 {4}->{5} 8103 {6}->{7} 切换={8} 新增={9} 消失={10} mem {11}->{12}MB 异常={13}' -f `
        $r.Round, $r.Exit, $r.Ready, $r.ReadySec, $r.P8004Before, $r.P8004After, $r.P8103Before, $r.P8103After, `
        $(if ($r.PidChanged) { 'PASS' } else { 'FAIL' }), $r.New, $r.Gone, $r.MemBefore, $r.MemAfter, $r.Anomalies.Count)
    foreach ($a in $r.Anomalies) { Write-Output ('      !! ' + $a) }
}
Write-Output ''
if ($overallOk) { Write-Output 'RESULT: PASS（全部轮次无尸体实例、pid 均切换）'; exit 0 }
Write-Output 'RESULT: FAIL（见上面点名项）'; exit 1
