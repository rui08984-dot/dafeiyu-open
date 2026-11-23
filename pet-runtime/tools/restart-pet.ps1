# restart-pet.ps1 —— 干净重启她的宿主（2026-11-22 尸体实例根因重写）
#
# 本轮实测到并修掉的根因（不是猜的）：
#   ① 旧版只杀 launcher/electron/pet-core，**不杀已经脱离 launcher 的服务**。
#      launcher 崩溃后 9883 上可能留着孤儿 TTS；新 launcher 又 spawn 一份，
#      于是每 2 秒 bind 失败一次、无限重试（my-neuro.out.log 里连续 OSError 10048）。
#      现在按 services.json（launchBy=launcher/electron）**按端口 + 脚本命令行**清服务残留。
#   ② 旧版只按端口判「服务 ok」——孤儿占着 9883 也报 ok（假绿）。
#      现在启动后校验：8004/8103 必须是同一个新主进程，且它的父链必须走到本次新 launcher。
#   ③ 旧版「还有 N 个实例没退掉」用 CIM 计数，WMI 晚一拍就误报。
#      现在用 Get-Process + 创建时间复核（区分真残留 vs WMI 延迟），并多轮重试清理，
#      防止清理窗口里有别的入口（Run 键/手动/看门狗）又拉起一套。
#   ④ %TEMP%\pet-wgc 的 shot-*.bmp 从不清理（实测 563MB/91 文件）。
#      现在重启时按白名单清理：只删该目录下 shot-*.bmp，保留最新 24 个、10 分钟内不动。
#   ⑤ 按需服务（8104 SendInput / 8106 UIA）不在 svcManaged 里，旧实例曾是「管不到」的孤儿：
#      宿主崩过一次后残留的 8106 /health 正常、InvokePattern 却全失败，新宿主复用它 → 静默全红。
#      现在按 start.script 绝对路径精确识别本项目的按需实例并清掉（外部同名服务绝不误杀）。
#
# 仍保留 -NoLauncher 应急路径（没有崩溃自愈），默认走 launcher。
#
# 用法：pwsh -NoProfile -File pet-runtime/tools/restart-pet.ps1
#      pwsh -NoProfile -File pet-runtime/tools/restart-pet.ps1 -KeepRunning    # 只清不启
#      pwsh -NoProfile -File pet-runtime/tools/restart-pet.ps1 -NoLauncher     # 应急：直起 electron

param(
    [switch]$KeepRunning,
    [switch]$NoLauncher
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$appDir = Join-Path $root '_incoming\my-neuro\live-2d'
$exe = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
$launcher = Join-Path $root 'pet-runtime\tools\launch-my-neuro.mjs'
$manifestPath = Join-Path $root 'pet-runtime\tools\services.json'
$launcherLog = Join-Path $root 'pet-runtime\.state\my-neuro.out.log'
$petCoreExe = Join-Path $root 'pet-core\target\release\pet-core.exe'
$restartStart = Get-Date

function Get-Manifest {
    if (-not (Test-Path $manifestPath)) { return $null }
    try { return (Get-Content -Raw -Encoding UTF8 -Path $manifestPath | ConvertFrom-Json) } catch { return $null }
}
$manifest = Get-Manifest
if (-not $manifest) { Write-Error ("缺服务清单: " + $manifestPath); exit 1 }
$services = @($manifest.services)
# 本脚本负责清理/校验的服务：launcher 或 electron 拉起的那批。
$svcManaged = @($services | Where-Object { $_.launchBy -in @('launcher', 'electron') })
# 按需服务（launchBy=external 且有本项目 start.script：8104 SendInput / 8106 UIA）。
# 平时不常驻，但**宿主重启后旧实例可能留成孤儿**：2026-11-22 实测旧的 8106 UIA 实例
# /health 正常、InvokePattern 却全失败（门禁「后台操控」时红时绿，且失败是静默的）。
# 只认本项目脚本绝对路径 —— 用户自己起的同名/同端口服务绝不误杀。
$svcOnDemand = @($services | Where-Object {
    $_.launchBy -eq 'external' -and $_.start -and $_.start.script -and
    ((Join-Path $root ([string]$_.start.script)) -like ($root + '\*'))
})
$svcRequired = @($services | Where-Object { $_.required })
$sharedPorts = @($manifest.sharedInfra | ForEach-Object { [int]$_.port })

function Get-OnDemandScript($s) {
    if (-not $s.start -or -not $s.start.script) { return $null }
    return (Join-Path $root ([string]$s.start.script))
}

function Test-LocalPort([int]$port) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $port)
        $c.Close()
        return $true
    } catch { return $false }
}

# 应急回退路径用：端口没起才拉服务（已在跑就直接跳过，不重复 spawn）。
function Ensure-Svc([string]$name, [int]$port, [string]$scriptRel, [int]$WaitSec = 20, [string]$FailHint = '不影响宿主，但没有声音/语音输入') {
    if (Test-LocalPort $port) { Write-Output ("[svc] " + $name + " 已在跑 (" + $port + ")"); return }
    $script = Join-Path $root $scriptRel
    if (-not (Test-Path $script)) { Write-Output ("[svc] 缺 " + $name + " 脚本，跳过: " + $script); return }
    Start-Process -FilePath 'py' -ArgumentList @($script, '--port', "$port") -WorkingDirectory (Split-Path $script) -WindowStyle Hidden
    for ($k = 0; $k -lt $WaitSec; $k++) {
        Start-Sleep -Seconds 1
        if (Test-LocalPort $port) { Write-Output ("[svc] " + $name + " 已就绪 (" + $port + ")"); return }
    }
    Write-Output ("[svc] 警告：" + $name + " (" + $port + ") 没起来 —— " + $FailHint)
}

function Get-ListenerPids([int]$port) {
    @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        Where-Object { $_ -gt 0 } | Sort-Object)
}

# 一次枚举所有 LISTEN，再按端口查表。反复按端口调 Get-NetTCPConnection 在连接多时
# 会把一次重启拖到 2 分钟（2026-11-22 实测：soak 测试并行时 -KeepRunning 118s）。
function Get-ListenMap {
    $map = @{}
    foreach ($c in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
        $p = [int]$c.LocalPort
        $procId = [int]$c.OwningProcess
        if ($p -le 0 -or $procId -le 0) { continue }
        if (-not $map.ContainsKey($p)) { $map[$p] = New-Object System.Collections.ArrayList }
        if (-not $map[$p].Contains($procId)) { [void]$map[$p].Add($procId) }
    }
    return $map
}

function Get-PidsFromMap($map, [int]$port) {
    if ($map -and $map.ContainsKey($port)) { return @($map[$port] | Sort-Object) }
    return @()
}

function Get-ProcCreation($p) {
    try { return [Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate) } catch { return $null }
}

# 真存活 = 内核里 Get-Process 还在，且创建时间与 CIM 记录一致（防 pid 复用）。
# CIM 里还在、Get-Process 已没有 → WMI 延迟/假残留，不算残留。
function Test-ProcAlive($p) {
    if (-not $p) { return $false }
    try { $gp = Get-Process -Id ([int]$p.ProcessId) -ErrorAction Stop } catch { return $false }
    $cd = Get-ProcCreation $p
    if ($cd) {
        try { if ([math]::Abs(($gp.StartTime - $cd).TotalSeconds) -gt 5) { return $false } } catch { }
    }
    return $true
}

function Get-ProcCmd([int]$procId) {
    try {
        $x = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $procId) -ErrorAction Stop
        return [string]$x.CommandLine
    } catch { return '' }
}

# ── 相关进程候选：launcher / electron / pet-core / 清单内服务 ──────────────
function Get-RelatedCandidates {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $listenMap = Get-ListenMap
    $map = @{}
    $add = {
        param($p, [string]$tag, $port)
        $procId = [int]$p.ProcessId
        if ($procId -le 0) { return }
        if (-not $map.ContainsKey($procId)) {
            $map[$procId] = [pscustomobject]@{
                ProcessId = $procId; Name = [string]$p.Name; Tag = $tag
                Cmd = [string]$p.CommandLine; CreationDate = $p.CreationDate
                Ports = @(); TagList = @($tag)
            }
        } else {
            if ($map[$procId].TagList -notcontains $tag) { $map[$procId].TagList += $tag }
        }
        if ($port -and ($map[$procId].Ports -notcontains [int]$port)) { $map[$procId].Ports += [int]$port }
    }
    foreach ($p in $all) {
        $cmd = [string]$p.CommandLine
        if ($p.Name -eq 'node.exe' -and $cmd -like '*launch-my-neuro*') { & $add $p 'launcher' $null }
        # 只认本项目宿主（app 路径含 live-2d）。**不要**用 productName(combined-project)：
        # 机器上可能同时跑 _probe\soak 的隔离实例（同 productName、不同 app 路径），
        # 用 combined-project 会误杀它的 crashpad/utility 子进程。
        elseif ($p.Name -eq 'electron.exe' -and $cmd -like '*live-2d*') { & $add $p 'electron' $null }
        # pet-core 只认**本项目**精确路径。_probe\soak 的隔离实例也有 pet-core.exe，
        # 且它的 renderer 会自动补拉 —— 用 '*pet-core*' 会把 soak 的当成残留，永远杀不完。
        elseif ($p.Name -eq 'pet-core.exe' -and $cmd -like ('*' + $petCoreExe + '*')) { & $add $p 'pet-core' $null }
    }
    foreach ($s in $svcManaged) {
        $port = [int]$s.port
        $fullScript = if ($s.start -and $s.start.script) { Join-Path $root ([string]$s.start.script) } else { $null }
        foreach ($owner in Get-PidsFromMap $listenMap $port) {
            $op = $all | Where-Object { [int]$_.ProcessId -eq [int]$owner } | Select-Object -First 1
            if (-not $op) { continue }
            $ocmd = [string]$op.CommandLine
            # 只杀「能确认是本项目」的端口占用者：本项目 electron，或**本服务脚本绝对路径**。
            # 其它软件/soak 副本恰好占用同名端口/同名脚本时绝不误杀 —— 留给后面的 foreign 报错。
            $isOurElectron = ($op.Name -eq 'electron.exe' -and $ocmd -like '*live-2d*')
            $isOurPython = ($op.Name -match '^(py|python|pythonw)\.exe$' -and $fullScript -and $ocmd -like ('*' + $fullScript + '*'))
            if ($isOurElectron -or $isOurPython) { & $add $op ("svc:" + $s.id) $port }
        }
        if ($fullScript) {
            foreach ($p in $all) {
                $cmd = [string]$p.CommandLine
                if ($p.Name -match '^(py|python|pythonw)\.exe$' -and $cmd -like ('*' + $fullScript + '*')) {
                    & $add $p ("svc:" + $s.id) $port
                }
            }
        }
    }
    # 按需服务孤儿（8104/8106）：命令行里带本项目脚本绝对路径就认。
    # 不看进程名（pwsh/powershell/python 都可能是启动器），路径本身就是强判据。
    foreach ($s in $svcOnDemand) {
        $script = Get-OnDemandScript $s
        if (-not $script) { continue }
        foreach ($p in $all) {
            $cmd = [string]$p.CommandLine
            if ($cmd -and $cmd -like ('*' + $script + '*')) { & $add $p ("ondemand:" + $s.id) ([int]$s.port) }
        }
    }
    return @($map.Values)
}

function Stop-Tree([int]$procId) {
    if ($procId -le 0) { return }
    try { & taskkill /F /T /PID $procId 2>&1 | Out-Null } catch { }
}

# ── 清理循环（最多 3 轮；每轮重新抓，防止清理窗口里又有入口拉起新实例）──────
$prePids = @{}
$wmiGhosts = @()
$foreignRequired = @()
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $cands = @(Get-RelatedCandidates)
    foreach ($c in $cands) { $prePids[[int]$c.ProcessId] = $true }
    $alive = @($cands | Where-Object { Test-ProcAlive $_ })
    $ghosts = @($cands | Where-Object { -not (Test-ProcAlive $_) })
    foreach ($g in $ghosts) { $wmiGhosts += ("pid=" + $g.ProcessId + " " + $g.Name) }

    # 先把 launcher 清掉（它会补 electron），再清 electron 主进程树，再 pet-core/服务。
    $launchers = @($alive | Where-Object { $_.TagList -contains 'launcher' })
    foreach ($p in $launchers) { Write-Output ("[kill] launcher pid=" + $p.ProcessId); Stop-Tree $p.ProcessId }
    if ($launchers.Count -gt 0) { Start-Sleep -Milliseconds 800 }

    $electronMains = @($alive | Where-Object { $_.TagList -contains 'electron' -and $_.Cmd -notlike '*--type=*' -and $_.Cmd -notmatch '\.(cjs|mjs|js)"?\s*$' })
    foreach ($p in $electronMains) { Write-Output ("[kill] electron main pid=" + $p.ProcessId); Stop-Tree $p.ProcessId }
    Start-Sleep -Milliseconds 600
    $others = @($alive | Where-Object { ($_.TagList -contains 'electron' -or $_.TagList -contains 'pet-core' -or $_.TagList -contains 'launcher') })
    foreach ($p in $others) { if (Test-ProcAlive $p) { Stop-Tree $p.ProcessId } }

    # 服务残留：按清单端口/脚本命令行清（这是旧版漏掉的一类尸体）。
    $svcLeft = @($alive | Where-Object { @($_.TagList | Where-Object { $_ -like 'svc:*' }).Count -gt 0 })
    foreach ($p in $svcLeft) {
        Write-Output ("[kill] 服务残留 " + (($p.TagList | Where-Object { $_ -like 'svc:*' }) -join ',') + " pid=" + $p.ProcessId + " port=" + ($p.Ports -join ','))
        Stop-Tree $p.ProcessId
    }
    # 按需服务孤儿：宿主重启后旧 8104/8106 会被新宿主静默复用（/health 正常但 Invoke 全失败）。
    $onDemandLeft = @($alive | Where-Object { @($_.TagList | Where-Object { $_ -like 'ondemand:*' }).Count -gt 0 })
    foreach ($p in $onDemandLeft) {
        Write-Output ("[kill] 按需服务孤儿 " + (($p.TagList | Where-Object { $_ -like 'ondemand:*' }) -join ',') + " pid=" + $p.ProcessId + " port=" + ($p.Ports -join ','))
        Stop-Tree $p.ProcessId
    }
    Start-Sleep -Seconds 1

    # 复核：真实存活（Get-Process）+ 清单内服务端口
    $after = @(Get-RelatedCandidates)
    $aliveAfter = @($after | Where-Object { Test-ProcAlive $_ })
    $busy = @()
    $listenMap = Get-ListenMap
    foreach ($s in $svcManaged) {
        $pids = @(Get-PidsFromMap $listenMap ([int]$s.port))
        if ($pids.Count -gt 0) { $busy += ("$($s.id)(" + $s.port + ")=pid " + ($pids -join ',')) }
    }
    if ($aliveAfter.Count -eq 0 -and $busy.Count -eq 0) { break }
    if ($attempt -eq 3) {
        foreach ($p in $aliveAfter) {
            Write-Output ("[residual] pid=" + $p.ProcessId + " " + $p.Name + " tags=" + ($p.TagList -join ',') + " cmd=" + $p.Cmd.Substring(0, [Math]::Min(140, $p.Cmd.Length)))
        }
        foreach ($b in $busy) { Write-Output ("[residual-port] " + $b) }
    }
}

# 最终判定：先把「CIM 里在、内核里不在」的 WMI 延迟项说清楚（这不是残留）。
if ($wmiGhosts.Count -gt 0) {
    $uniqGhosts = @($wmiGhosts | Sort-Object -Unique)
    Write-Output ("[wmi] 以下 " + $uniqGhosts.Count + " 项在 CIM 快照里出现过、但 Get-Process 已不存在（WMI 延迟，不是真残留）: " + ($uniqGhosts -join '; '))
}

$leftCands = @(Get-RelatedCandidates)
$leftAlive = @($leftCands | Where-Object { Test-ProcAlive $_ })
if ($leftAlive.Count -gt 0) {
    $names = ($leftAlive | ForEach-Object { "$($_.Name)[pid=$($_.ProcessId),tags=$($_.TagList -join '+')]" }) -join ' '
    Write-Error ("还有 " + $leftAlive.Count + " 个真实存活的相关进程没退掉（3 轮清理后）: " + $names)
    exit 1
}

# 清单内服务端口必须全部空闲；被外部进程占着就明确报错（绝不假装成功继续用旧实例）。
$foreignListenMap = Get-ListenMap
foreach ($s in $svcManaged) {
    $pids = @(Get-PidsFromMap $foreignListenMap ([int]$s.port))
    if ($pids.Count -eq 0) { continue }
    $desc = @()
    foreach ($procId in $pids) {
        $cmd = Get-ProcCmd $procId
        $desc += ("pid=$procId " + $cmd.Substring(0, [Math]::Min(120, $cmd.Length)))
    }
    $line = ("端口 " + $s.port + " (" + $s.id + ") 仍被占用: " + ($desc -join ' | '))
    if ($s.required) { $foreignRequired += $line } else { Write-Output ("[warn] " + $line + " —— 非必需，启动后会跳过") }
}
# 按需服务端口（8104/8106）：本项目的孤儿上面已经清掉了；剩下的只可能是**用户自己的**
# 外部实例 —— 不阻断重启（不常驻、缺失时退化），但要明确说出来，别让人以为是我们起的那份。
foreach ($s in $svcOnDemand) {
    $script = Get-OnDemandScript $s
    foreach ($procId in @(Get-PidsFromMap $foreignListenMap ([int]$s.port))) {
        $cmd = Get-ProcCmd $procId
        $mine = ($script -and $cmd -like ('*' + $script + '*'))
        $desc = "pid=$procId " + $cmd.Substring(0, [Math]::Min(100, $cmd.Length))
        if ($mine) {
            # 走不到这里才正常：说明 3 轮 taskkill 后本项目的按需服务还活着。
            Write-Output ("[warn] 按需服务 " + $s.id + "(" + $s.port + ") 仍被本项目脚本占着（清理失败）: " + $desc)
        } else {
            Write-Output ("[warn] 端口 " + $s.port + " (" + $s.id + ") 被外部进程占用，不属本项目（不会误杀，也不保证是新的）: " + $desc)
        }
    }
}

if ($foreignRequired.Count -gt 0) {
    Write-Error ("必需端口被非本项目进程占用，拒绝继续（避免新实例被单实例锁挡掉却假装成功）: " + ($foreignRequired -join ' ; '))
    exit 1
}

Write-Output '已清空全部实例（launcher/electron/pet-core + 清单内服务残留）'

# ── 白名单清理 %TEMP%\pet-wgc：只删 shot-*.bmp，保留最新 24 个，10 分钟内不动 ──
function Clear-OwnTempShots {
    $dir = Join-Path $env:TEMP 'pet-wgc'
    if (-not (Test-Path -LiteralPath $dir)) { return }
    $files = @(Get-ChildItem -LiteralPath $dir -File -Filter 'shot-*.bmp' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending)
    if ($files.Count -le 24) { return }
    $now = Get-Date
    $freed = 0; $count = 0
    for ($i = 24; $i -lt $files.Count; $i++) {
        $f = $files[$i]
        if (($now - $f.LastWriteTime).TotalMinutes -lt 10) { continue }
        try { $sz = $f.Length; Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $freed += $sz; $count++ } catch { }
    }
    if ($count -gt 0) {
        Write-Output ("[clean] pet-wgc 清理 " + $count + " 个旧 shot-*.bmp，释放 " + [math]::Round(($freed / 1MB), 1) + " MB（保留最新 24 个）")
    }
}
Clear-OwnTempShots

if ($KeepRunning) { exit 0 }

# ── 后代判定（用于「8103 到底归谁」）─────────────────────────────────────
function Get-PpidMap {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $map = @{}
    foreach ($p in $all) { $map[[int]$p.ProcessId] = [int]$p.ParentProcessId }
    return $map
}

function Test-DescendantInMap($map, [int]$targetPid, [int]$ancestorPid) {
    $cur = $targetPid
    for ($i = 0; $i -lt 12; $i++) {
        if ($cur -eq $ancestorPid) { return $true }
        if (-not $map.ContainsKey($cur)) { return $false }
        $next = [int]$map[$cur]
        if ($next -le 0 -or $next -eq $cur) { return $false }
        $cur = $next
    }
    return $false
}

function Get-ProcStart($procId) {
    try { return (Get-Process -Id $procId -ErrorAction Stop).StartTime } catch { return $null }
}

# 启动后的硬校验：8004/8103 同一 pid、且是新 launcher 的后代、且启动时间晚于本次重启开始。
function Assert-NewInstance([int]$launcherPid, [string]$modeTag) {
    $lm = Get-ListenMap
    $p8103 = @(Get-PidsFromMap $lm 8103)
    $p8004 = @(Get-PidsFromMap $lm 8004)
    if ($p8103.Count -ne 1) { Write-Host ("[$modeTag] ✗ 8103 应有且仅有 1 个监听者，实际: " + ($p8103 -join ',')); return $false }
    $owner = [int]$p8103[0]
    if ($p8004.Count -ne 1 -or [int]$p8004[0] -ne $owner) {
        Write-Host ("[$modeTag] ✗ 8004/8103 不是同一个主进程（8004=" + ($p8004 -join ',') + " 8103=" + ($p8103 -join ',') + "）"); return $false
    }
    if ($prePids.ContainsKey($owner)) { Write-Host ("[$modeTag] ✗ 8103 仍归重启前就存在的旧 pid=" + $owner); return $false }
    $start = Get-ProcStart $owner
    if ($start -and $start -lt $restartStart.AddSeconds(-5)) {
        Write-Host ("[$modeTag] ✗ 8103 的 pid=" + $owner + " 启动于 " + $start + "，早于本次重启（旧实例没死）"); return $false
    }
    if (-not (Test-DescendantInMap (Get-PpidMap) $owner $launcherPid)) {
        $cmd = Get-ProcCmd $owner
        Write-Host ("[$modeTag] ✗ 8103 的 pid=" + $owner + " 不在本次 launcher(pid=" + $launcherPid + ") 的进程树里: " + $cmd.Substring(0, [Math]::Min(160, $cmd.Length)))
        return $false
    }
    Write-Host ("[$modeTag] 实例校验通过: 8004/8103 = pid=" + $owner + "（本次 launcher pid=" + $launcherPid + " 的后代）")
    return $true
}

function Assert-ManagedListeners([int]$launcherPid, [string]$modeTag) {
    $bad = @()
    $badRequired = @()
    $map = Get-PpidMap          # 一次抓全量父链；每个端口都重抓会把重启拖慢 20s+
    $listenMap = Get-ListenMap  # 一次枚举全部 LISTEN；按端口反复查会慢到分钟级
    foreach ($s in $svcManaged) {
        $port = [int]$s.port
        $pids = @(Get-PidsFromMap $listenMap $port)
        if ($pids.Count -eq 0) { continue }
        foreach ($procId in $pids) {
            if (-not (Test-DescendantInMap $map ([int]$procId) $launcherPid)) {
                $cmd = Get-ProcCmd $procId
                $item = ("$($s.id)($port) pid=$procId 不在 launcher 树里: " + $cmd.Substring(0, [Math]::Min(120, $cmd.Length)))
                $bad += $item
                if ($s.required) { $badRequired += $item }
            }
        }
    }
    if ($bad.Count -gt 0) {
        Write-Host ("[$modeTag] [warn] 以下服务监听者不是本次 launcher 的后代（可能是旧实例/外部进程）：")
        foreach ($b in $bad) { Write-Host ("  !! " + $b) }
        if ($badRequired.Count -gt 0) { return $false }
        Write-Host ("[$modeTag] 以上均为非必需服务，宿主核心不受影响")
        return $true
    }
    Write-Host ("[$modeTag] 清单内服务监听者全部属于本次 launcher 的进程树")
    return $true
}

# ── 走 launcher（默认路径，恢复全部自愈能力）────────────────────────────
$launcherOk = $false
$verifyOk = $false
if (-not $NoLauncher) {
    if (-not (Test-Path $launcher)) {
        Write-Output ('[restart] ✗ 找不到 launcher: ' + $launcher + ' —— 回退到直起 electron')
    } else {
        $node = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $node) { $node = 'node' }
        Write-Output ('[restart] 启动 launcher: ' + $node + ' ' + $launcher)
        try {
            $launcherProc = Start-Process -FilePath $node -ArgumentList @($launcher) -WorkingDirectory $root -WindowStyle Hidden -PassThru
        } catch {
            Write-Output ('[restart] ✗ launcher 启动失败: ' + $_.Exception.Message)
            $launcherProc = $null
        }
        if ($launcherProc) {
            # launcher 先注入密钥 + 探模型端点（最多约 15s）再起宿主，这里给 90s。
            for ($i = 0; $i -lt 90; $i++) {
                Start-Sleep -Seconds 1
                if (Test-LocalPort 8103) { $launcherOk = $true; break }
            }
        }
        if ($launcherOk) {
            # 8103 开了不等于服务都活着：先按清单等必需项（最多 50s）再报告。
            $required = @($svcRequired)
            $waitUntil = (Get-Date).AddSeconds(50)
            $miss = @()
            do {
                $miss = @()
                foreach ($s in $required) {
                    if (-not (Test-LocalPort ([int]$s.port))) { $miss += ($s.id + '(' + $s.port + ')') }
                }
                if ($miss.Count -eq 0) { break }
                Start-Sleep -Seconds 2
            } while ((Get-Date) -lt $waitUntil)

            $verifyOk = Assert-NewInstance $launcherProc.Id 'launcher'
            if ($verifyOk) { $verifyOk = Assert-ManagedListeners $launcherProc.Id 'launcher' }

            Write-Output ('宿主已就绪（launcher 监督中，pid=' + $launcherProc.Id + '）')
            $reportMap = Get-PpidMap
            $reportListenMap = Get-ListenMap
            foreach ($s in $services) {
                $ok = Test-LocalPort ([int]$s.port)
                $flag = if ($ok) { 'ok  ' } elseif ($s.required) { 'MISS' } else { 'off ' }
                # 端口通不等于归我们：可选服务被外部进程占着时标 FRGN，别给假绿。
                # 注意 8120 等冷启动服务可能在快照之后才 bind —— 快照里没有就现场补查一次，
                # 不能因为「快照为空」就误标 FRGN（实测 8120 加载 11s，报告时刚好错过）。
                if ($ok -and ($s.launchBy -in @('launcher', 'electron'))) {
                    $lp = @(Get-PidsFromMap $reportListenMap ([int]$s.port))
                    if ($lp.Count -eq 0) { $lp = @(Get-ListenerPids ([int]$s.port)) }
                    if ($lp.Count -gt 0) {
                        $owned = $true
                        foreach ($procId in $lp) {
                            if (-not (Test-DescendantInMap $reportMap ([int]$procId) $launcherProc.Id)) { $owned = $false }
                        }
                        if (-not $owned) { $flag = 'FRGN' }
                    }
                }
                Write-Output ('[svc] {0} {1,-12} {2,5}' -f $flag, $s.id, $s.port)
            }
            if ($miss.Count -gt 0) {
                Write-Output ('[restart] ⚠ 必需服务仍未就绪: ' + ($miss -join ', ') + ' —— 看 launcher 日志（缺资产/端口占用/模型未下载）')
                $verifyOk = $false
            }
            if (-not $verifyOk) {
                Write-Error '[restart] 启动后校验失败：新实例归属/服务归属不对，不能算重启成功（详见上面点名项）'
                exit 1
            }
            exit 0
        }
        Write-Output '[restart] ✗ launcher 未在 90s 内拉起 8103'
        # 防双实例：launcher 可能还在慢启动（密钥注入/端点探测），直起 electron 前先清掉它。
        $lp = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*launch-my-neuro*' })
        if ($lp.Count -gt 0) {
            Write-Output ('[restart] 清理未就绪的 launcher: ' + (($lp | ForEach-Object { $_.ProcessId }) -join ','))
            foreach ($p in $lp) { Stop-Tree ([int]$p.ProcessId) }
            Start-Sleep -Seconds 2
        }
        if (Test-Path $launcherLog) {
            Write-Output ('[restart] ---- ' + $launcherLog + ' 末尾 ----')
            Get-Content -Tail 20 -Path $launcherLog | ForEach-Object { Write-Output ('[log] ' + $_) }
            Write-Output '[restart] ---- 日志末尾结束 ----'
        }
        # 主进程崩溃现场（2026-11-22）：偶发 ERR_UNKNOWN_FILE_EXTENSION 这类「进程直接死」
        # 的根因在栈里，不在 launcher 日志里。只在她本次启动之后有新条目时才打印。
        $crashLog = Join-Path $appDir 'crash-main.log'
        if (Test-Path $crashLog) {
            $crashMtime = (Get-Item -LiteralPath $crashLog).LastWriteTime
            if ($crashMtime -ge $restartStart.AddSeconds(-5)) {
                Write-Output ('[restart] ---- 主进程崩溃现场 ' + $crashLog + ' 末尾 ----')
                Get-Content -Tail 30 -Path $crashLog | ForEach-Object { Write-Output ('[crash] ' + $_) }
                Write-Output '[restart] ---- 崩溃现场结束 ----'
            }
        }
        Write-Output '[restart] 回退：直接启动 electron（**没有崩溃自愈/watchdog**，只作应急）'
    }
}

# ── 回退路径：直起 electron（-NoLauncher 或 launcher 失败）───────────────
$electronProc = Start-Process -FilePath $exe -ArgumentList $appDir -WorkingDirectory $appDir -WindowStyle Hidden -PassThru

# 等 8103 起来（最多 30 秒）
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8103/state' -TimeoutSec 2 -UseBasicParsing
        if ($r.StatusCode -eq 200) {
            # 校验：8103/8004 必须归这个新 electron 主进程（不是旧实例）
            $p8103 = @(Get-ListenerPids 8103)
            if ($p8103.Count -ne 1 -or [int]$p8103[0] -ne [int]$electronProc.Id) {
                Write-Error ('[fallback] 8103 不是新起的 electron pid=' + $electronProc.Id + '（实际: ' + ($p8103 -join ',') + '）——旧实例/外部占用')
                exit 1
            }
            Write-Output ("宿主已就绪（electron pid=" + $electronProc.Id + "，**无 launcher 监督**）")
            # 旁路服务：不在就拉起来（否则「重启完没声音/没语音输入」）
            Ensure-Svc 'edge-tts' 9883 'edge-tts\tts_server.py'
            Ensure-Svc 'asr' 1000 'asr\asr_server.py'
            if (Test-LocalPort 1001) {
                Write-Output '[svc] 一起看耳朵 已在跑 (1001)'
            } else {
                $loopScript = Join-Path $root 'audio-loop\audio_loop_server.py'
                if (Test-Path $loopScript) {
                    Start-Process -FilePath 'py' -ArgumentList @($loopScript, '--port', '1001') -WorkingDirectory (Split-Path $loopScript) -WindowStyle Hidden
                    for ($k = 0; $k -lt 12; $k++) { Start-Sleep -Seconds 1; if (Test-LocalPort 1001) { break } }
                    if (Test-LocalPort 1001) { Write-Output '[svc] 一起看耳朵 已就绪 (1001)' } else { Write-Output '[svc] 警告：一起看耳朵 (1001) 未就绪（可能缺 WASAPI 回环设备）' }
                } else { Write-Output '[svc] 缺 audio_loop_server.py，跳过一起看' }
            }
            if (Test-LocalPort 8020) {
                Write-Output '[svc] 声纹嵌入 已在跑 (8020)'
            } else {
                $vpPython = Join-Path $root 'pet-runtime\venv-voice\Scripts\python.exe'
                $vpScript = Join-Path $root 'audio_common\voiceprint_server.py'
                if ((Test-Path $vpPython) -and (Test-Path $vpScript)) {
                    Start-Process -FilePath $vpPython -ArgumentList @($vpScript) -WorkingDirectory (Split-Path $vpScript) -WindowStyle Hidden
                    for ($k = 0; $k -lt 12; $k++) { Start-Sleep -Seconds 1; if (Test-LocalPort 8020) { break } }
                    if (Test-LocalPort 8020) { Write-Output '[svc] 声纹嵌入 已就绪 (8020)' } else { Write-Output '[svc] 警告：声纹嵌入 (8020) 未就绪' }
                } else { Write-Output '[svc] 缺 venv-voice/voiceprint_server.py，跳过声纹' }
            }
            if (Test-LocalPort 8003) {
                Write-Output '[svc] MemOS 已在跑 (8003)'
            } else {
                $memosDir = Join-Path $root '_incoming\my-neuro\plugins-dlc\memos\memos_system'
                $memosEntry = Join-Path $memosDir 'api\memos_api_server_v2.py'
                if (Test-Path $memosEntry) {
                    Start-Process -FilePath 'py' -ArgumentList @($memosEntry) -WorkingDirectory $memosDir -WindowStyle Hidden
                    $memosOk = $false
                    for ($k = 0; $k -lt 45; $k++) {
                        Start-Sleep -Seconds 1
                        if (Test-LocalPort 8003) { Write-Output '[svc] MemOS 已就绪 (8003)'; $memosOk = $true; break }
                    }
                    if (-not $memosOk) { Write-Output '[svc] 警告：MemOS (8003) 未在 45s 内就绪（记忆会先走待写队列）' }
                } else {
                    Write-Output '[svc] 缺 MemOS 后端，跳过'
                }
            }
            if (Test-Path (Join-Path $root '_research\lumenact\models\selector.onnx')) {
                Ensure-Svc 'lumen-semantic' 8120 'pet-runtime\tools\lumen-semantic-server.py' -WaitSec 45 -FailHint '渲染层语义兜底会静默失效（不影响宿主与语音）'
            } else {
                Write-Output '[svc] lumen-semantic 缺资产，跳过（见交接 §63）'
            }
            # 回退路径的服务没有 launcher 树可校验，至少确认必需端口都通。
            $miss = @()
            foreach ($s in $svcRequired) { if (-not (Test-LocalPort ([int]$s.port))) { $miss += ($s.id + '(' + $s.port + ')') } }
            if ($miss.Count -gt 0) {
                Write-Error ('[fallback] 必需服务未就绪: ' + ($miss -join ', '))
                exit 1
            }
            exit 0
        }
    } catch { }
}
Write-Error '等了 30 秒 8103 还没起来'; exit 1
