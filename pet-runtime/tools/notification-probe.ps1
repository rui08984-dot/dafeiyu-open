<#
  notification-probe.ps1 — 大肥鱼 · Windows 通知监听探针（世界感知 Phase 3 前置）

  为什么需要它：UserNotificationListener 要求进程有「包身份」。我们的 Electron 宿主
  是普通 exe（稀疏 MSIX 只发身份、不搬文件），所以：
    ① 先查当前进程有没有包身份（GetCurrentPackageFullName）
    ② 没有 → 用 Invoke-CommandInDesktopPackage 在身份包内重跑自己
    ③ 在包内调 RequestAccessAsync（首次会弹「允许读取通知」系统对话框）
    ④ 允许后再 GetNotificationsAsync 读一批，打印数量与少量样本

  用法（从普通 shell 跑即可，脚本自己进包）：
    powershell -NoProfile -ExecutionPolicy Bypass -File pet-runtime\tools\notification-probe.ps1
    powershell ... -File ... -Status        # 只查授权状态，不弹框、不读通知
    powershell ... -File ... -Limit 5 -Json # 读 5 条，输出单行 JSON（给脚本/门禁用）
    powershell ... -File ... -Collect       # 采集最近 50 条 → data/notifications.jsonl
    powershell ... -File ... -Collect -FromFile in.json -OutJsonl out.jsonl  # 离线处理（测试/补采）

  Collect 口径（Phase 3 缺口 1）：
    · 默认读最近 50 条；按 (AUMID, creationTime, title) 去重；文件保留最近 200 条。
    · **title 默认不采集**（只记 app 与条数）—— 通知里常有验证码/私信。
      只有 config.json 的 world.notifications.include_title === true 才记标题（截 60 字）。
    · 后台定时器调用时**绝不弹授权框**：未授权直接返回 not-allowed（先手动跑一次允许）。

  退出码：0 成功（且已授权）；2 未授权/被拒；3 无包身份（进包失败）；4 WinRT 不可用
#>
[CmdletBinding()]
param(
    [switch]$InPackage,
    [switch]$Status,
    [switch]$Collect,
    [int]$Limit = 5,
    [int]$Max = 50,
    [switch]$Json,
    # 进包子进程把结果写到这里，外层读回来。Invoke-CommandInDesktopPackage 是分离启动，
    # 子进程 stdout 回不到父进程；没有回传通道就只能靠人肉看窗口。
    [string]$OutFile,
    # Collect 专用：输出 jsonl / 输入 json / 配置路径（测试用覆盖；缺省按仓库结构推导）
    [string]$OutJsonl,
    [string]$FromFile,
    [string]$ConfigPath,
    [switch]$IncludeTitle
)

$ErrorActionPreference = 'Stop'

# ── 输出：Json 模式只允许一行 JSON 到 stdout；人读模式随意 ────────────────────
$script:notes = @()

function Say([string]$msg) {
    if (-not $Json) { Write-Host $msg }
}

function Emit([hashtable]$payload) {
    $line = $payload | ConvertTo-Json -Compress -Depth 6
    # 回传通道：进包子进程写文件，外层轮询读（无 OutFile 时行为不变）
    if ($OutFile) {
        try {
            $dir = Split-Path -Parent $OutFile
            if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            [System.IO.File]::WriteAllText($OutFile, $line, (New-Object System.Text.UTF8Encoding($false)))
        } catch { }
    }
    if ($Json) {
        Write-Output $line
    } else {
        foreach ($k in $payload.Keys) { Write-Host ("{0,-14} {1}" -f $k, $payload[$k]) }
    }
}

# ── Collect（Phase 3 缺口 1）：路径 / 去重 / 轮转 / 隐私口径 ──────────────────
# 仓库结构：pet-runtime/tools → 上两级 = 项目根 → _incoming/my-neuro。
# -ConfigPath / -OutJsonl 可覆盖（测试用临时目录，绝不写真实 data）。
$script:repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:configPath = if ($ConfigPath) { $ConfigPath } else { Join-Path $script:repoRoot '_incoming\my-neuro\live-2d\config.json' }
$script:outJsonl = if ($OutJsonl) { $OutJsonl } else { Join-Path $script:repoRoot '_incoming\my-neuro\data\notifications.jsonl' }
$script:collectWithTitle = $false

function Get-AppShort([string]$aumid) {
    if (-not $aumid) { return '' }
    $s = $aumid
    # Win32 的 AUMID 常是 "{GUID}/Vendor/App/App.exe" → 先取文件名
    if ($s -match '[/\\]') {
        $leaf = ($s -split '[/\\]')[-1]
        if ($leaf) { $s = $leaf }
    }
    # UWP AUMID：PackageFamily!AppId；PackageFamily = Name_publisherId
    $i = $s.IndexOf('!'); if ($i -ge 0) { $s = $s.Substring(0, $i) }
    $i = $s.IndexOf('_'); if ($i -ge 0) { $s = $s.Substring(0, $i) }
    $parts = @($s.Split('.') | Where-Object { $_ })
    if ($parts.Count -eq 0) { return '' }
    $last = $parts[$parts.Count - 1]
    # 通用后缀（App.exe / dev.zcode.app）不是名字，取上一段
    if (($last -in @('exe', 'lnk', 'app', 'win32')) -and $parts.Count -ge 2) {
        $last = $parts[$parts.Count - 2]
    }
    if (-not $last) { return '' }
    if ($last.Length -gt 24) { $last = $last.Substring(0, 24) }
    return $last
}

function ConvertTo-Iso([string]$value) {
    if (-not $value) { return '' }
    try {
        $dt = [DateTimeOffset]::Parse($value, [Globalization.CultureInfo]::InvariantCulture)
        return $dt.UtcDateTime.ToString('o')
    } catch {
        $n = 0.0
        if ([double]::TryParse($value, [ref]$n)) {
            try { return ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$n)).UtcDateTime.ToString('o') } catch { return '' }
        }
        return ''
    }
}

function Read-IncludeTitleConfig([string]$p) {
    if (-not $p -or -not (Test-Path -LiteralPath $p)) { return $false }
    try {
        $cfg = [System.IO.File]::ReadAllText($p) | ConvertFrom-Json
        if ($cfg -and $cfg.world -and $cfg.world.notifications -and $cfg.world.notifications.include_title -eq $true) {
            return $true
        }
    } catch { }
    return $false
}

function Get-SortTime([string]$iso) {
    try { return [DateTimeOffset]::Parse($iso, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime }
    catch { return [DateTime]::MinValue }
}

<#
  Invoke-CollectItems —— 把一个通知数组落到 jsonl。
  输入项：{ app|aumid, at|ts, title? }
  去重键：(AUMID, creationTime, title)。title 关闭时第三段恒为空串 ——
  隐私模式下仍能按「应用 + 时间」去重，只是永远不会写入标题。
#>
function Invoke-CollectItems([object[]]$Items, [bool]$WithTitle) {
    $maxKeep = 200
    $existing = New-Object System.Collections.ArrayList
    $invalid = 0

    if (Test-Path -LiteralPath $script:outJsonl) {
        try {
            foreach ($line in [System.IO.File]::ReadAllLines($script:outJsonl)) {
                if (-not $line -or -not $line.Trim()) { continue }
                try {
                    $o = $line | ConvertFrom-Json
                    if ($o -and $o.app -and $o.ts) {
                        [void]$existing.Add(@{ entry = $o; ts = (Get-SortTime ([string]$o.ts)); idx = $existing.Count })
                    } else {
                        $invalid += 1
                    }
                } catch { $invalid += 1 }
            }
        } catch { }
    }

    $keys = @{}
    foreach ($x in $existing) {
        $e = $x.entry
        $keys[(([string]$e.app) + '|' + ([string]$e.ts) + '|' + ([string]$e.title))] = $true
    }

    $added = 0
    $dups = 0
    foreach ($it in @($Items)) {
        if (-not $it) { continue }
        $app = [string]$it.app
        if (-not $app) { $app = [string]$it.aumid }
        $tsRaw = [string]$it.at
        if (-not $tsRaw) { $tsRaw = [string]$it.ts }
        $ts = ConvertTo-Iso $tsRaw
        if (-not $ts) { $invalid += 1; continue }
        $title = ''
        if ($WithTitle) {
            $title = [string]$it.title
            if ($title.Length -gt 60) { $title = $title.Substring(0, 60) }
        }
        $key = $app + '|' + $ts + '|' + $title
        if ($keys.ContainsKey($key)) { $dups += 1; continue }
        $keys[$key] = $true
        $entry = [ordered]@{
            ts        = $ts
            app       = $app
            title     = $title
            app_short = (Get-AppShort $app)
        }
        [void]$existing.Add(@{ entry = $entry; ts = (Get-SortTime $ts); idx = $existing.Count })
        $added += 1
    }

    $totalBefore = $existing.Count
    $rotated = [Math]::Max(0, $totalBefore - $maxKeep)
    # 按时间升序保留最近 200 条（相同时间按写入顺序，稳定）
    $keep = @($existing | Sort-Object @{ Expression = { $_.ts } }, @{ Expression = { $_.idx } } | Select-Object -Last $maxKeep)
    $lines = @($keep | ForEach-Object { ($_.entry | ConvertTo-Json -Compress -Depth 4) })

    $dir = Split-Path -Parent $script:outJsonl
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    # 原子写：world-sense 每秒 stat/读这个文件，直接覆写会让它偶尔读到半截文件。
    # 先写同目录临时文件再 rename；rename 失败才退回直接写（宁可丢原子性，不可丢数据）。
    $tmpFile = $script:outJsonl + '.tmp-' + $PID
    $written = $false
    try {
        [System.IO.File]::WriteAllLines($tmpFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmpFile -Destination $script:outJsonl -Force
        $written = $true
    } catch { $written = $false }
    if (-not $written) {
        try { if (Test-Path -LiteralPath $tmpFile) { Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue } } catch { }
        [System.IO.File]::WriteAllLines($script:outJsonl, $lines, (New-Object System.Text.UTF8Encoding($false)))
    }

    return @{
        ok          = $true
        mode        = 'collect'
        file        = $script:outJsonl
        added       = $added
        duplicates  = $dups
        invalid     = $invalid
        total       = $keep.Count
        rotated     = $rotated
        includeTitle= $WithTitle
    }
}

if ($Collect) {
    $script:collectWithTitle = ($IncludeTitle -or (Read-IncludeTitleConfig $script:configPath))
}

# 离线模式（测试/补采）：不碰 WinRT、不需要包身份。
if ($Collect -and $FromFile) {
    if (-not (Test-Path -LiteralPath $FromFile)) {
        Emit @{ ok = $false; reason = 'from-file-missing'; file = $FromFile }
        exit 2
    }
    try {
        $obj = [System.IO.File]::ReadAllText($FromFile) | ConvertFrom-Json
    } catch {
        Emit @{ ok = $false; reason = 'from-file-bad-json'; error = $_.Exception.Message }
        exit 2
    }
    $items = @()
    if ($obj -is [System.Array]) { $items = @($obj) }
    elseif ($obj -and $obj.items) { $items = @($obj.items) }
    elseif ($obj) { $items = @($obj) }
    $rc = Invoke-CollectItems -Items $items -WithTitle $script:collectWithTitle
    if ($rc) { Emit $rc }
    exit $(if ($rc) { 0 } else { 1 })
}

$identityQueryType = $null
function Get-PackageIdentityName {
    if (-not ('PetPkg.Identity' -as [type])) {
        Add-Type -Namespace PetPkg -Name Identity -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetCurrentPackageFullName(ref int packageFullNameLength, System.Text.StringBuilder packageFullName);
'@
    }
    $len = 0
    $rc = [PetPkg.Identity]::GetCurrentPackageFullName([ref]$len, $null)
    if ($rc -eq 15700) { return $null }          # APPMODEL_ERROR_NO_PACKAGE
    if ($rc -ne 122) { return $null }            # ERROR_INSUFFICIENT_BUFFER 才算有包
    $sb = New-Object System.Text.StringBuilder $len
    $rc2 = [PetPkg.Identity]::GetCurrentPackageFullName([ref]$len, $sb)
    if ($rc2 -ne 0) { return $null }
    return $sb.ToString()
}

# ── 进包重跑 ────────────────────────────────────────────────────────────────
function ReEnterInPackage {
    $pkg = Get-AppxPackage -Name '*dafeiyu*' | Select-Object -First 1
    if (-not $pkg) {
        return @{ ok = $false; reason = 'no-package-registered'; hint = '先跑 _packaging/identity/register-identity-admin.ps1' }
    }
    $appId = 'DaFeiyu'
    $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path $exe)) { $exe = 'powershell.exe' }

    # 命令行编码坑（2026-11-21 实测）：Invoke-CommandInDesktopPackage 把 -Args 组进
    # CreateProcess 命令行时，本仓中文路径会被当成 UTF-8→GBK 二次解码
    # （<project-root> → D:\ai浜烘牸杞�浠禱），子进程直接报「文件不存在」。
    # 解法：用 -EncodedCommand 传一段 base64(UTF-16LE) 引导脚本 —— 命令行上全是 ASCII，
    # 中文路径只出现在编码后的字节里，不经过任何代码页转换。
    $boot = "& '" + ($PSCommandPath -replace "'", "''") + "' -InPackage"
    if ($Status) { $boot += ' -Status' }
    if ($Json) { $boot += ' -Json' }
    if ($Collect) {
        $boot += ' -Collect'
        $boot += (' -Max ' + $Max)
        # 子进程只负责读；标题是否提取必须由外层同一口径决定（隐私默认关）
        if ($script:collectWithTitle) { $boot += ' -IncludeTitle' }
    }
    if ($OutFile) { $boot += " -OutFile '" + ($OutFile -replace "'", "''") + "'" }
    $boot += (' -Limit ' + $Limit)
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($boot))

    Say ("[进包] {0}!{1}" -f $pkg.PackageFamilyName, $appId)
    try {
        & Invoke-CommandInDesktopPackage -PackageFamilyName $pkg.PackageFamilyName `
            -AppId $appId -Command $exe -Args ('-NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + $encoded) `
            -PreventBreakaway | Out-Null
        return @{ ok = $true; relaunched = $true; pfn = $pkg.PackageFamilyName }
    } catch {
        return @{ ok = $false; reason = 'relaunch-failed'; error = $_.Exception.Message }
    }
}

# ── WinRT 异步等待（PS 5.1 需要 System.Runtime.WindowsRuntime）──────────────
function Initialize-WinRtAwait {
    try { Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop } catch {
        return $false
    }
    $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
    return ($null -ne $script:asTaskGeneric)
}

function Await($op, [Type]$resultType) {
    $m = $script:asTaskGeneric.MakeGenericMethod($resultType)
    $task = $m.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    return $task.Result
}

# ── 主流程 ──────────────────────────────────────────────────────────────────
$identity = Get-PackageIdentityName
Say ("[身份] " + $(if ($identity) { $identity } else { '(无包身份)' }))

if (-not $identity) {
    if ($InPackage) {
        Emit @{ ok = $false; reason = 'no-identity-in-package-run' }
        exit 3
    }
    # 外层：给子进程一个结果文件，进包重跑后轮询它（默认等 45s；授权弹框需要人点）
    $waitSec = 45
    $tmp = $OutFile
    if (-not $tmp) { $tmp = Join-Path $env:TEMP ('notification-probe-' + [guid]::NewGuid().ToString('N') + '.json') }
    if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    $OutFile = $tmp

    $r = ReEnterInPackage
    if (-not $r.ok) {
        Emit @{ ok = $false; reason = $r.reason; error = $r.error; hint = $r.hint }
        exit 3
    }

    $deadline = (Get-Date).AddSeconds($waitSec)
    $got = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        if (Test-Path $tmp) {
            try {
                $txt = [System.IO.File]::ReadAllText($tmp)
                if ($txt -and $txt.Trim()) { $got = $txt.Trim(); break }
            } catch { }
        }
    }
    if ($got) {
        if ($Collect) {
            # 子进程只回传 items；去重/轮转/隐私落盘都在外层这一份代码里（只有一处口径）
            $child = $null
            try { $child = $got | ConvertFrom-Json } catch { $child = $null }
            try { Remove-Item $tmp -Force -ErrorAction SilentlyContinue } catch { }
            # 清掉回传通道：否则 Emit 会把 summary 又写回刚删掉的临时文件（留垃圾）
            $OutFile = $null
            if ($child -and $child.ok -eq $true -and $child.PSObject.Properties['items']) {
                $summary = Invoke-CollectItems -Items @($child.items) -WithTitle $script:collectWithTitle
                if ($summary) { Emit $summary }
                exit $(if ($summary) { 0 } else { 1 })
            }
            Write-Output $got
            exit 2
        }
        if ($Json) { Write-Output $got } else { Write-Host $got }
        try { Remove-Item $tmp -Force -ErrorAction SilentlyContinue } catch { }
        if ($got -match '"ok":true') { exit 0 } else { exit 2 }
    }
    Emit @{
        ok         = $false
        relaunched = $true
        pfn        = $r.pfn
        reason     = 'no-result'
        hint       = ('进包子进程 {0}s 内没有回传结果。可能：授权对话框在等你点「允许」；或包内 PowerShell 启动失败。' -f $waitSec)
    }
    exit 2
}

if (-not (Initialize-WinRtAwait)) {
    Emit @{ ok = $false; reason = 'winrt-await-unavailable'; hint = '用 Windows PowerShell 5.1（powershell.exe）跑，别用 pwsh 7' }
    exit 4
}

$NS = 'Windows.UI.Notifications.Management'
try {
    [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
} catch {
    Emit @{ ok = $false; reason = 'winrt-type-unavailable'; error = $_.Exception.Message }
    exit 4
}

$accessType = [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]
# 注意：变量名不能叫 $status —— PowerShell 变量不分大小写，会覆盖 -Status 开关参数，
# 然后 'Allowed' 被强转成 SwitchParameter 直接抛 MetadataError（2026-11-21 实测过）。
$access = $listener.GetAccessStatus()

# ── Collect：在包内只读一批通知，把 items 交给外层落盘 ──────────────────────
# 后台定时器每 10 分钟跑一次，**绝不能弹授权框**：未授权直接返回 not-allowed。
if ($Collect) {
    if ($access.ToString() -ne 'Allowed') {
        Emit @{
            ok           = $false
            inPackage    = $true
            identity     = $identity
            accessStatus = $access.ToString()
            reason       = 'not-allowed'
            hint         = '先手动跑一次 notification-probe.ps1 并在系统对话框点「允许」；后台采集不会弹框'
        }
        exit 2
    }
    $items = @()
    $total = 0
    try {
        $notifType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
        $list = Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $notifType
        $total = $list.Count
        $n = [Math]::Max(0, [Math]::Min($Max, $total))
        for ($i = 0; $i -lt $n; $i++) {
            $item = $list[$i]
            $app = ''
            $title = ''
            try { $app = $item.AppInfo.AppUserModelId } catch { $app = '' }
            if ($IncludeTitle) {
                try {
                    $t = $item.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
                    $texts = $t.GetTextElements()
                    $arr = @($texts | ForEach-Object { [string]$_.Text } | Where-Object { $_ })
                    if ($arr.Count -gt 0) { $title = $arr[0] }
                } catch { $title = '' }
            }
            $at = ''
            try { $at = $item.CreationTime.ToString('o') } catch { $at = '' }
            $items += @{ app = $app; title = $title; at = $at }
        }
    } catch {
        Emit @{
            ok           = $false
            inPackage    = $true
            identity     = $identity
            accessStatus = $access.ToString()
            reason       = 'read-notifications-failed'
            error        = $_.Exception.Message
        }
        exit 4
    }
    Emit @{
        ok           = $true
        mode         = 'collect-read'
        inPackage    = $true
        identity     = $identity
        accessStatus = $access.ToString()
        total        = $total
        includeTitle = [bool]$IncludeTitle
        items        = $items
    }
    exit 0
}

if ($Status) {
    Emit @{
        ok          = ($access.ToString() -eq 'Allowed')
        inPackage   = $true
        identity    = $identity
        accessStatus= $access.ToString()
    }
    if ($access.ToString() -eq 'Allowed') { exit 0 } else { exit 2 }
}

if ($access.ToString() -ne 'Allowed') {
    Say '[授权] 当前状态 ' + $access.ToString() + ' → 请求授权（会弹系统对话框）'
    try {
        $access = Await ($listener.RequestAccessAsync()) $accessType
    } catch {
        Emit @{ ok = $false; reason = 'request-access-failed'; error = $_.Exception.Message; identity = $identity }
        exit 2
    }
    Say '[授权] 结果 ' + $access.ToString()
}

if ($access.ToString() -ne 'Allowed') {
    Emit @{
        ok            = $false
        inPackage     = $true
        identity      = $identity
        accessStatus  = $access.ToString()
        reason        = if ($access.ToString() -eq 'Denied') { 'user-denied' } else { 'not-allowed' }
        hint          = '系统设置 → 隐私和安全性 → 通知 → 允许应用读取通知（找不到就重装身份包/重启资源管理器）'
    }
    exit 2
}

# 读一批通知：只取时间 + app 的 AUMID + 标题前 80 字（正文不打印）
$samples = @()
$total = 0
try {
    $notifType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
    $list = Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $notifType
    $total = $list.Count
    $n = [Math]::Max(0, [Math]::Min($Limit, $total))
    for ($i = 0; $i -lt $n; $i++) {
        $item = $list[$i]
        $app = ''
        $title = ''
        try { $app = $item.AppInfo.AppUserModelId } catch { $app = '' }
        try {
            $t = $item.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
            $texts = $t.GetTextElements()
            # GetTextElements() 是 WinRT IReadOnlyList，PS 里 $texts[0].Text 会退化成
            # 「整列 Text 属性投影」（返回数组）。显式枚举再取第一个，保证 title 是字符串。
            $arr = @($texts | ForEach-Object { [string]$_.Text } | Where-Object { $_ })
            if ($arr.Count -gt 0) { $title = $arr[0] }
        } catch { $title = '' }
        if ($title.Length -gt 80) { $title = $title.Substring(0, 80) }
        $at = ''
        try { $at = $item.CreationTime.ToString('o') } catch { $at = '' }
        $samples += @{ app = $app; title = $title; at = $at }
    }
} catch {
    Emit @{
        ok           = $false
        inPackage    = $true
        identity     = $identity
        accessStatus = $access.ToString()
        reason       = 'read-notifications-failed'
        error        = $_.Exception.Message
    }
    exit 4
}

Emit @{
    ok           = $true
    inPackage    = $true
    identity     = $identity
    accessStatus = $access.ToString()
    total        = $total
    samples      = $samples
}
exit 0
