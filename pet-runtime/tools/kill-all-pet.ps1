# kill-all-pet.ps1 —— 大肥鱼 · 全清脚本（2026-11-22 端口收窄）
#
# 本轮改动（与 restart-pet.ps1 同一套精确匹配口径）：
#   旧实现按 services.json 的端口**无条件 Stop-Process**：任何程序只要占了同名端口
#   （8001/3003/8103 等）都会被误杀。现在先做归属判定，只有能确认属于本安装的才杀：
#     a) 进程可执行文件路径在项目根 <project-root> 之下；
#     b) 命令行包含本项目的绝对脚本/应用路径（launcher / 各服务脚本 / live-2d）；
#     c) 是上述进程的后代（例如 launcher 拉起的 py.exe，解释器本身不在项目里）。
#   非本项目的端口占用者只报告（[foreign]），绝不 Stop-Process。
#
# 契约：
#   · 端口清单**只从 services.json 读**（与 launch-my-neuro / restart-pet / doctor 共用）。
#   · 8090（llama.cpp 嵌入，共用基础设施）绝不会出现在清单里。
#   · -DryRun 只列出「会杀谁 / 为什么」和「谁占了端口但不属于本项目」，零 kill。
#   · 杀完逐项复核：本项目残留 → exit 1；端口被外部程序占着 → 报告并 exit 1（不杀）。
#
# 注意：8090 是 llama.cpp 嵌入服务，属于**共用基础设施**（可能还有别的项目在用），
# 这里刻意不动它。
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'SilentlyContinue'
$root = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSScriptRoot))).TrimEnd('\')
$rootPrefix = $root + '\'
$manifestPath = Join-Path $PSScriptRoot 'services.json'
$selfPid = [int]$PID

if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    Write-Output '[net] 缺 Get-NetTCPConnection（NetTCPIP 模块不可用），无法检查端口'
    exit 2
}
if (-not (Test-Path $manifestPath)) {
    Write-Output ("[manifest] 缺服务清单: " + $manifestPath)
    exit 2
}
try {
    $manifest = Get-Content -Raw -Encoding UTF8 -Path $manifestPath | ConvertFrom-Json
} catch {
    Write-Output ("[manifest] 解析失败: " + $_.Exception.Message)
    exit 2
}

$services = @($manifest.services)
$ports = @($services | ForEach-Object { [int]$_.port })
if ($ports.Count -eq 0) { Write-Output '[manifest] 清单里没有服务'; exit 2 }
# 防呆：共用基础设施绝不能进 kill 清单
foreach ($guard in @($manifest.sharedInfra)) {
    if ($guard -and ($ports -contains [int]$guard.port)) {
        Write-Output ("[manifest] 清单包含共用基础设施端口 " + $guard.port + "（" + $guard.name + "），拒绝执行")
        exit 2
    }
}

Write-Output ("[manifest] services.json v" + $manifest.version + " · " + $services.Count + " 项: " + ($ports -join ', '))

# ── 归属判据：项目路径 / 项目命令行 ───────────────────────────────────────
# 每条 marker 绑定它应该出现的宿主进程名（正则）：launcher 只可能由 node/cmd 拉起，
# electron 应用目录只可能由 electron.exe 使用，.py/.ps1 各归 py/python 与 pwsh。
# 这样「命令行文本里恰好含有项目路径」的 shell/编辑器不会被误判。
$cmdRules = New-Object System.Collections.ArrayList
function Add-CmdRule([string]$p, [string]$hostPattern) {
    if ([string]::IsNullOrWhiteSpace($p)) { return }
    $full = $p
    try { $full = [IO.Path]::GetFullPath($p) } catch { }
    foreach ($r in $cmdRules) {
        if ($r.Path -eq $full -and $r.HostPattern -eq $hostPattern) { return }
    }
    [void]$cmdRules.Add([pscustomobject]@{ Path = $full; HostPattern = $hostPattern })
}
$launcherMarker = Join-Path $root 'pet-runtime\tools\launch-my-neuro.mjs'
Add-CmdRule $launcherMarker '^(node|cmd)([0-9.]*)?\.exe$'
Add-CmdRule (Join-Path $root '_incoming\my-neuro\live-2d') '^electron\.exe$'
foreach ($s in $services) {
    if ($s.start) {
        if ($s.start.script) {
            $scriptRel = [string]$s.start.script
            $scriptPath = Join-Path $root $scriptRel
            $ext = [IO.Path]::GetExtension($scriptRel).ToLowerInvariant()
            if ($ext -eq '.py') {
                Add-CmdRule $scriptPath '^(py|python|pythonw|python[0-9.]*)\.exe$'
            } elseif ($ext -eq '.ps1') {
                Add-CmdRule $scriptPath '^(pwsh|powershell)\.exe$'
            } elseif ($ext -eq '.mjs' -or $ext -eq '.js' -or $ext -eq '.cjs') {
                Add-CmdRule $scriptPath '^node\.exe$'
            } else {
                Add-CmdRule $scriptPath '^(node|py|python|pythonw|pwsh|powershell|cmd)([0-9.]*)?\.exe$'
            }
        }
        if ($s.start.venvPython) {
            Add-CmdRule (Join-Path $root ([string]$s.start.venvPython)) '^(python|pythonw|python[0-9.]*)\.exe$'
        }
    }
}

function Test-UnderProjectRoot([string]$exePath) {
    if ([string]::IsNullOrWhiteSpace($exePath)) { return $false }
    $full = $exePath
    try { $full = [IO.Path]::GetFullPath($exePath) } catch { }
    if ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
}

# 命令行判据：marker 必须出现在“该 marker 的合法宿主进程”里，避免 shell/编辑器误判。
function Test-ProjectCommandLine([string]$cmd, [string]$procName) {
    if ([string]::IsNullOrWhiteSpace($cmd) -or [string]::IsNullOrWhiteSpace($procName)) { return $false }
    foreach ($r in $cmdRules) {
        if ($procName -notmatch $r.HostPattern) { continue }
        if ($cmd.IndexOf($r.Path, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
}

function Short-Cmd([string]$cmd, [int]$max = 160) {
    if ([string]::IsNullOrWhiteSpace($cmd)) { return '' }
    if ($cmd.Length -le $max) { return $cmd }
    return $cmd.Substring(0, $max) + '...'
}

function Get-ListenPids([int]$port) {
    @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        Where-Object { $_ -gt 0 })
}

function Get-Snapshot {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $map = @{}
    foreach ($p in $all) { $map[[int]$p.ProcessId] = $p }
    return [pscustomobject]@{ All = $all; Map = $map }
}

# 快照与端口枚举之间可能有进程重启：PID 不在快照里时按需补查一次。
# 仍然查不到 = 该监听记录已过期（进程已退出），调用方应跳过而不是当成 foreign。
function Get-ProcFromSnapshot($snap, [int]$procId) {
    $p = $snap.Map[$procId]
    if ($p) { return $p }
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $procId) -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) { $snap.Map[$procId] = $p }
    return $p
}

# 归属判定：exe 在项目根下 / 命令行含项目路径 / 是项目进程的后代。
# 只向上找父链，不把祖先（explorer 等）判成本项目，避免误杀。
function Get-Ownership($snap, [int]$procId) {
    $p = Get-ProcFromSnapshot $snap $procId
    if (-not $p) { return [pscustomobject]@{ Owned = $false; Reason = 'process-not-found（可能已退出）' } }
    if ($procId -eq $selfPid) { return [pscustomobject]@{ Owned = $false; Reason = 'self' } }

    $exe = [string]$p.ExecutablePath
    if (Test-UnderProjectRoot $exe) {
        return [pscustomobject]@{ Owned = $true; Reason = 'exe-under-project' }
    }
    $cmd = [string]$p.CommandLine
    if (Test-ProjectCommandLine $cmd ([string]$p.Name)) {
        return [pscustomobject]@{ Owned = $true; Reason = 'cmdline-project' }
    }

    $cur = [int]$p.ParentProcessId
    for ($i = 0; $i -lt 12; $i++) {
        if ($cur -le 0 -or $cur -eq $selfPid) { break }
        $anc = Get-ProcFromSnapshot $snap $cur
        if (-not $anc) { break }
        if (Test-UnderProjectRoot ([string]$anc.ExecutablePath)) {
            return [pscustomobject]@{ Owned = $true; Reason = ('descendant-of-project-exe(pid=' + $cur + ')') }
        }
        if (Test-ProjectCommandLine ([string]$anc.CommandLine) ([string]$anc.Name)) {
            return [pscustomobject]@{ Owned = $true; Reason = ('descendant-of-project-cmd(pid=' + $cur + ')') }
        }
        $next = [int]$anc.ParentProcessId
        if ($next -le 0 -or $next -eq $cur) { break }
        $cur = $next
    }
    $exeShort = if ($exe) { $exe } else { '(unknown)' }
    return [pscustomobject]@{ Owned = $false; Reason = ('not-project exe=' + $exeShort) }
}

function Add-Action($actions, $snap, [int]$procId, [string]$source, [string]$reason, [int]$port, [string]$serviceId) {
    if ($procId -le 0 -or $procId -eq $selfPid) { return }
    if (-not $actions.Contains($procId)) {
        $p = $snap.Map[$procId]
        $pname = if ($p) { [string]$p.Name } else { '?' }
        $pex = if ($p) { [string]$p.ExecutablePath } else { '' }
        $pcmd = if ($p) { [string]$p.CommandLine } else { '' }
        $actions[$procId] = [pscustomobject]@{
            ProcessId = $procId
            Name = $pname
            Exe = $pex
            Cmd = $pcmd
            Sources = New-Object System.Collections.ArrayList
            Reasons = New-Object System.Collections.ArrayList
            Ports = New-Object System.Collections.ArrayList
        }
    }
    $a = $actions[$procId]
    $srcTag = if ($serviceId) { $source + ':' + $serviceId } else { $source }
    if ($srcTag -and ($a.Sources -notcontains $srcTag)) { [void]$a.Sources.Add($srcTag) }
    if ($reason -and ($a.Reasons -notcontains $reason)) { [void]$a.Reasons.Add($reason) }
    if ($port -gt 0 -and ($a.Ports -notcontains $port)) { [void]$a.Ports.Add($port) }
}

# 一次扫描 → 杀谁（Actions）/ 谁占着端口但不属于本项目（Foreign）。只读。
function Get-Plan {
    $snap = Get-Snapshot
    # 注意：不要用 [ordered]@{} —— OrderedDictionary 的 int 索引器按“位置”取值，
    # $actions[$pid] 会越界返回 null。普通哈希表按 key 取值，int 键安全；输出前再排序。
    $actions = @{}
    $foreign = New-Object System.Collections.ArrayList

    foreach ($s in $services) {
        $port = [int]$s.port
        foreach ($procId in (Get-ListenPids $port)) {
            $p = Get-ProcFromSnapshot $snap ([int]$procId)
            if (-not $p) { continue }   # 监听记录已过期（进程刚退出/正在重启）
            $own = Get-Ownership $snap ([int]$procId)
            if ($own.Owned) {
                Add-Action $actions $snap ([int]$procId) 'port' $own.Reason $port ([string]$s.id)
            } else {
                $fname = [string]$p.Name
                $fex = [string]$p.ExecutablePath
                $fcmd = [string]$p.CommandLine
                [void]$foreign.Add([pscustomobject]@{
                    ProcessId = [int]$procId
                    Port = $port
                    ServiceId = [string]$s.id
                    Name = $fname
                    Exe = $fex
                    Cmd = $fcmd
                    Reason = $own.Reason
                })
            }
        }
    }

    # 兜底：按命令行找本项目进程（正在启动/退出、还没 bind 的也算）。
    # 只认本项目绝对路径 marker，或可执行文件确实在项目根下的 electron；
    # 不用裸 live-2d / 裸 launch-my-neuro（会误杀 _probe\soak 等隔离副本）。
    foreach ($p in $snap.All) {
        $procId = [int]$p.ProcessId
        if ($procId -le 0 -or $procId -eq $selfPid) { continue }
        $name = [string]$p.Name
        $cmd = [string]$p.CommandLine
        $exe = [string]$p.ExecutablePath
        if ($name -eq 'electron.exe' -and (Test-UnderProjectRoot $exe)) {
            Add-Action $actions $snap $procId 'fallback' 'electron-under-project' 0 ''
        } elseif (Test-ProjectCommandLine $cmd $name) {
            Add-Action $actions $snap $procId 'fallback' 'cmdline-project' 0 ''
        }
    }

    return [pscustomobject]@{ Actions = $actions; Foreign = $foreign; Snapshot = $snap }
}

function Get-ActionRank($a) {
    $cmd = [string]$a.Cmd
    if ($cmd.IndexOf($launcherMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return 0 }
    if ([string]$a.Name -eq 'electron.exe') { return 1 }
    return 2
}

function Format-Action($a) {
    $portsText = if ($a.Ports.Count -gt 0) { $a.Ports -join ',' } else { '-' }
    return ('pid=' + $a.ProcessId + ' ' + $a.Name + ' ports=' + $portsText +
        ' sources=' + ($a.Sources -join '+') + ' reason=' + ($a.Reasons -join '+') +
        ' cmd=' + (Short-Cmd ([string]$a.Cmd)))
}

# ── 预检：CIM 枚举为空时拒绝假绿 ─────────────────────────────────────────
$probe = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
if ($probe.Count -eq 0) {
    Write-Output '[scan] 无法枚举进程（WMI/CIM 返回空），拒绝执行'
    exit 2
}

# ── DryRun：只报计划，不杀 ────────────────────────────────────────────────
if ($DryRun) {
    $plan = Get-Plan
    $actions = @($plan.Actions.Values | Sort-Object -Property @{ Expression = { Get-ActionRank $_ } })
    Write-Output ("[dry-run] 扫描 " + $services.Count + " 个清单端口 · 计划杀 " + $actions.Count +
        " 个本项目进程 · 非本项目占用 " + $plan.Foreign.Count + " 个")

    foreach ($a in $actions) {
        Write-Output ('[dry-run] would kill ' + (Format-Action $a))
    }
    foreach ($f in $plan.Foreign) {
        Write-Output ("[dry-run] would NOT kill foreign port=" + $f.Port + " (" + $f.ServiceId + ") pid=" + $f.ProcessId +
            " " + $f.Name + " · reason=" + $f.Reason + " · exe=" + $f.Exe + " · cmd=" + (Short-Cmd ([string]$f.Cmd)))
    }
    if ($plan.Foreign.Count -eq 0) {
        Write-Output '[dry-run] 清单端口没有非本项目占用者'
    }
    Write-Output '[dry-run] no process killed · 未杀任何进程（去掉 -DryRun 才真正执行）'
    exit 0
}

# ── 正常路径：多轮清理，只杀归属判定为本项目的进程 ────────────────────────
$killedPids = @{}
$foreignReported = @{}
$foreignOrder = New-Object System.Collections.ArrayList
$foreignFinal = 0

function Report-Foreign($f) {
    $key = ([string]$f.ProcessId + '/' + [string]$f.Port)
    if ($foreignReported.ContainsKey($key)) { return }
    $foreignReported[$key] = ('port=' + $f.Port + ' (' + $f.ServiceId + ') pid=' + $f.ProcessId + ' ' + $f.Name +
        ' · 不属于本项目，只报告不杀 · reason=' + $f.Reason + ' · exe=' + $f.Exe + ' · cmd=' + (Short-Cmd ([string]$f.Cmd)))
    [void]$foreignOrder.Add($key)
}

for ($attempt = 1; $attempt -le 3; $attempt++) {
    $plan = Get-Plan
    foreach ($f in $plan.Foreign) { Report-Foreign $f }
    $actions = @($plan.Actions.Values | Sort-Object -Property @{ Expression = { Get-ActionRank $_ } })
    if ($actions.Count -eq 0) { break }

    foreach ($a in $actions) {
        if ($a.ProcessId -eq $selfPid) { continue }
        Write-Output ('[kill] ' + (Format-Action $a))
        Stop-Process -Id $a.ProcessId -Force -ErrorAction SilentlyContinue
        $killedPids[[int]$a.ProcessId] = $true
    }
    Start-Sleep -Milliseconds 1200
}

Start-Sleep -Milliseconds 500

# ── 复核：本项目残留 vs 外部占用，分开报告 ───────────────────────────────
$snap = Get-Snapshot
$residual = New-Object System.Collections.ArrayList
$seenPortOwner = @{}

foreach ($s in $services) {
    $port = [int]$s.port
    foreach ($procId in (Get-ListenPids $port)) {
        $key = ([string]$procId + '/' + [string]$port)
        if ($seenPortOwner.ContainsKey($key)) { continue }
        $seenPortOwner[$key] = $true
        $p = Get-ProcFromSnapshot $snap ([int]$procId)
        if (-not $p) { continue }   # 监听记录已过期（进程刚退出/正在重启）
        $own = Get-Ownership $snap ([int]$procId)
        $name = [string]$p.Name
        $exe = [string]$p.ExecutablePath
        $cmd = [string]$p.CommandLine
        if ($own.Owned) {
            [void]$residual.Add('port=' + $port + ' (' + $s.id + ') pid=' + $procId + ' 本项目进程仍在监听 · exe=' + $exe + ' · cmd=' + (Short-Cmd $cmd))
        } else {
            $foreignFinal++
            $f = [pscustomobject]@{
                ProcessId = [int]$procId; Port = $port; ServiceId = [string]$s.id
                Name = $name; Exe = $exe; Cmd = $cmd; Reason = $own.Reason
            }
            Report-Foreign $f
        }
    }
}

# 兜底复核：本项目 launcher/electron/服务脚本进程是否还有活着的
foreach ($p in $snap.All) {
    $procId = [int]$p.ProcessId
    if ($procId -le 0 -or $procId -eq $selfPid) { continue }
    $name = [string]$p.Name
    $cmd = [string]$p.CommandLine
    $exe = [string]$p.ExecutablePath
    $owned = (($name -eq 'electron.exe' -and (Test-UnderProjectRoot $exe)) -or
        (Test-ProjectCommandLine $cmd $name))
    if ($owned) {
        [void]$residual.Add('pid=' + $procId + ' ' + $name + ' 仍在运行 · cmd=' + (Short-Cmd $cmd))
    }
}

foreach ($key in $foreignOrder) { Write-Output ('[foreign] ' + $foreignReported[$key]) }
foreach ($r in $residual) { Write-Output ('[residual] ' + $r) }

$foreignCount = $foreignFinal
if ($foreignCount -gt 0) {
    Write-Output ('NOT CLEAR · ' + $foreignCount + ' 个端口仍被非本项目进程占用（按契约未杀，只报告）')
}
if ($residual.Count -gt 0) {
    Write-Output ('NOT CLEAR · 仍有 ' + $residual.Count + ' 处本项目残留（可能需要管理员权限，或清理窗口内又被拉起）')
}
if ($foreignCount -gt 0 -or $residual.Count -gt 0) {
    exit 1
}
Write-Output ('all clear · ' + $services.Count + ' 个服务端口全部空闲（本次清理 ' + $killedPids.Count + ' 个本项目进程）')
exit 0
