#Requires -Version 5.1
<#
.SYNOPSIS
    以管理员身份完成「稀疏 MSIX 包身份」的最后一步：启用旁载 → 注册 → 验证。

.DESCRIPTION
    为什么需要这个脚本（2026-11-18 §81 实测）：
      · 证书信任已经做好（DaFeiyu-Dev.cer 已在 CurrentUser\Root + TrustedPeople），
        签名校验能过；
      · 但紧接着卡在 **0x80073CFF：需要 Windows 开发者许可证或启用旁载** ——
        开发者模式 / 旁载策略都在 HKLM（AllowDevelopmentWithoutDevLicense / AllowAllTrustedApps），
        **必须提权**才能改。当前会话未提权，所以注册没成（Get-AppxPackage 查不到）。

    本脚本做的事（每一步都验证，不谎报）：
      ① 检查是否管理员（不是就直接失败退出，别让人以为跑过了）；
      ② 记录当前策略值（用于回滚提示）；
      ③ 开开发者模式（AllowDevelopmentWithoutDevLicense=1，幂等）；
      ④ Add-AppxPackage -Register（用解开目录的清单，dev 模式路径，不需要机器级证书信任）；
      ⑤ Get-AppxPackage 复查；查不到就说失败；
      ⑥ 打印回滚命令（移除包 / 关回开发者模式 / 删证书）。

.PARAMETER PackageDir
    解开的应用目录（含 AppxManifest.xml）。默认 out\electron-builder\win-unpacked。

.PARAMETER ManifestPath
    可选：直接指定 AppxManifest.xml 路径（默认在 PackageDir 下找）。

.EXAMPLE
    # 右键「以管理员身份运行 PowerShell」，然后：
    pwsh -NoProfile -File .\register-identity-admin.ps1
#>
param(
    [string]$PackageDir = (Join-Path $PSScriptRoot '..\out\electron-builder\win-unpacked'),
    [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'
function Say($m) { Write-Output $m }

# ① 提权检查 —— 没提权就别假装在干活
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Say '[失败] 当前不是管理员。注册需要的策略在 HKLM，必须提权。'
    Say '       做法：开始菜单搜 PowerShell → 右键「以管理员身份运行」→ 再跑这行：'
    Say ('       pwsh -NoProfile -File "' + (Join-Path $PSScriptRoot 'register-identity-admin.ps1') + '"')
    exit 1
}

$unlockKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
$prevDev = $null
try { $prevDev = (Get-ItemProperty -Path $unlockKey -ErrorAction Stop).AllowDevelopmentWithoutDevLicense } catch { $prevDev = $null }
Say ('[现状] AllowDevelopmentWithoutDevLicense = ' + $(if ($null -eq $prevDev) { '<未设置>' } else { $prevDev }))

# ② 解析包目录 / 清单
$dir = (Resolve-Path $PackageDir).Path
if (-not $ManifestPath) { $ManifestPath = Join-Path $dir 'AppxManifest.xml' }
if (-not (Test-Path $ManifestPath)) {
    Say ('[失败] 找不到清单：' + $ManifestPath)
    Say '       先跑一次 _packaging\build-installer.ps1 -Appx（它会把 SxS 身份清单注入到 win-unpacked）'
    exit 1
}
Say ('[清单] ' + $ManifestPath)

# ③ 开开发者模式（幂等）
if ($prevDev -ne 1) {
    if (-not (Test-Path $unlockKey)) { New-Item -Path $unlockKey -Force | Out-Null }
    New-ItemProperty -Path $unlockKey -Name 'AllowDevelopmentWithoutDevLicense' -Value 1 -PropertyType DWord -Force | Out-Null
    Say '[策略] 已开启 AllowDevelopmentWithoutDevLicense=1'
} else {
    Say '[策略] 开发者模式本来就是开的，不动'
}

# ④ 注册（dev 模式路径：用解开目录的清单；不需要机器级证书信任）
#    ⚠ Add-AppxPackage 失败时是**非终止错误**：try/catch 抓不到，必须复查包状态才知道成没成。
#      这是 2026-11-18 踩到的假成功（脚本打印「Register 成功」但 Get-AppxPackage 查不到）。
Say '[注册] Add-AppxPackage -Register ...'
Add-AppxPackage -Register $ManifestPath -ExternalLocation $dir -ErrorAction Continue

# ⑤ 复查（唯一的成功判据）
$pkg = Get-AppxPackage -Name '*dafeiyu*'
if (-not $pkg) {
    Say '[失败] 注册后 Get-AppxPackage 查不到 —— 没有包身份。'
    Say '       排查：Get-AppxPackageLog -ActivityID <上面报的 ActivityId>；或看事件查看器 AppxDeployment-Server'
    Say '       如果还报 0x800B0109（根证书不受信任），把 out\identity\DaFeiyu-Dev.cer 也导进 LocalMachine\Root：'
    Say '         Import-Certificate -FilePath .\out\identity\DaFeiyu-Dev.cer -CertStoreLocation Cert:\LocalMachine\Root'
    exit 2
}

Say ''
Say '[成功] 包身份已注册：'
$pkg | Select-Object Name, PackageFullName, InstallLocation, IsDevelopmentMode, SignatureKind, Status |
    Format-List | Out-String -Width 220 | Write-Output

Say ''
Say '下一步验证（可选）：在应用里调用 WinRT，确认通知监听能力可用：'
Say '  [Windows.UI.Notifications.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null'
Say '  $l = [Windows.UI.Notifications.UserNotificationListener]::Current'
Say '  $l.RequestAccessAsync()   # 会弹一次用户授权；返回 Allowed 才真正能读通知'
Say ''
Say '回滚：'
Say '  Get-AppxPackage *dafeiyu* | Remove-AppxPackage'
Say ('  Set-ItemProperty -Path ''' + $unlockKey + ''' -Name AllowDevelopmentWithoutDevLicense -Value ' + $(if ($null -eq $prevDev) { 0 } else { $prevDev }))
Say '  Get-ChildItem Cert:\CurrentUser\My, Cert:\CurrentUser\Root, Cert:\CurrentUser\TrustedPeople | ? Subject -like "*MyNeuro*" | Remove-Item'
