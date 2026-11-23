#Requires -Version 5.1
<#
.SYNOPSIS
    给已解开的 Electron 目录发一个稀疏 MSIX「包身份」（external location / sparse package）。

.DESCRIPTION
    核心事实（微软文档 + 本机 SDK 校验）：
      * 稀疏包只装“身份”，不搬应用文件；注册时 Add-AppxPackage -ExternalLocation 指向应用目录；
      * 应用目录保持可写，config.json / 日志 / HKCU 写入行为不变；
      * AppxManifest 声明：
            rescap:Capability  Name="runFullTrust"
            rescap:Capability  Name="unvirtualizedResources"
            uap3:Capability    Name="userNotificationListener"
      * exe 自身要带 SxS 清单（urn:schemas-microsoft-com:msix.v1），
        否则注册会 0x80073D54 或运行期拿不到身份。本脚本用 mt.exe 把 <msix>
        节点合并进 Electron 原有清单，保留 dpiAware 与兼容性 GUID。

    工具全部来自 Windows SDK（MakeAppx / signtool / mt），本机已确认存在：
      C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\

    不会修改应用源码；只会修改构建产物里的 exe（win-unpacked 可重新生成）。

.PARAMETER PackDir
    外部位置：包含 DaFeiyu.exe 与 resources\ 的应用目录（通常是 win-unpacked 的绝对路径）。

.PARAMETER Register
    注册到当前用户。会先移除同名旧包（同版本重复注册会 0x80073CF9），
    并把自签名证书导入 CurrentUser\TrustedPeople（否则 0x800B0109）。

.PARAMETER CertPath
    使用已有 PFX。选这个时必须同时存在同名 .cer（公钥）用于导入信任；否则只能签名不能注册。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\make-identity-package.ps1 `
      -PackDir '<project-root>\_packaging\out\electron-builder\win-unpacked' -Register
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackDir,
    [string]$IdentityName = 'com.myneuro.dafeiyu',
    [string]$Publisher = 'CN=MyNeuro',
    [string]$Version = '1.0.0.0',
    [string]$DisplayName = '大肥鱼桌面伴侣',
    [string]$PublisherDisplayName = 'MyNeuro',
    [string]$Executable = 'DaFeiyu.exe',
    [string]$ApplicationId = 'DaFeiyu',
    [string]$OutputDir,
    [string]$CertPath,
    [string]$CertPassword = 'dafeiyu-dev',
    [switch]$TrustCert,
    [switch]$Register,
    [switch]$SkipSign
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Fail([string]$Text) {
    Write-Host ''
    Write-Host "[失败] $Text" -ForegroundColor Red
    exit 1
}

function Assert-LastExit([string]$What) {
    if ($LASTEXITCODE -ne 0) {
        Fail "$What 失败，退出码 $LASTEXITCODE。完整输出见上方。"
    }
}

# ── 0. 参数校验 ────────────────────────────────────────────────────
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    Fail "MSIX 版本必须是四段数字（如 1.0.0.0），当前：$Version"
}
if ($IdentityName -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{1,48}[A-Za-z0-9]$') {
    Fail "IdentityName 只允许字母数字点横线，且不能以点/横线开头结尾，当前：$IdentityName"
}

$packAbs = [IO.Path]::GetFullPath($PackDir)
$exePath = Join-Path $packAbs $Executable
if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
    Fail "外部位置缺少可执行文件：$exePath。先跑 build-installer.ps1 -DryRun。"
}

$packagingRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) {
    $OutputDir = Join-Path $packagingRoot 'out\identity'
}
$outRoot = [IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Path $outRoot -Force | Out-Null
$workDir = Join-Path $outRoot 'work'
New-Item -ItemType Directory -Path $workDir -Force | Out-Null
$stageDir = Join-Path $outRoot 'stage'

# ── 1. 定位 Windows SDK 工具 ──────────────────────────────────────
Write-Step '定位 MakeAppx / signtool / mt'
$sdk = $null
$sdkRoots = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'),
    (Join-Path $env:ProgramFiles 'Windows Kits\10\bin')
)
foreach ($root in $sdkRoots) {
    if (-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    $dirs = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
        Sort-Object -Descending { try { [version]$_.Name } catch { [version]'0.0.0.0' } }
    foreach ($d in $dirs) {
        $x64 = Join-Path $d.FullName 'x64'
        $tryMakeAppx = Join-Path $x64 'makeappx.exe'
        $trySignTool = Join-Path $x64 'signtool.exe'
        $tryMt = Join-Path $x64 'mt.exe'
        if ((Test-Path -LiteralPath $tryMakeAppx) -and (Test-Path -LiteralPath $trySignTool) -and (Test-Path -LiteralPath $tryMt)) {
            $sdk = [pscustomobject]@{
                Version  = $d.Name
                MakeAppx = $tryMakeAppx
                SignTool = $trySignTool
                Mt       = $tryMt
            }
            break
        }
    }
    if ($sdk) { break }
}
if (-not $sdk) {
    Fail '找不到 Windows SDK 的 makeappx.exe / signtool.exe / mt.exe。请安装 Windows 10/11 SDK（含 “MSIX Packaging Tools” 与 “Signing Tools”），或手动指定路径后重试。'
}
Write-Host "SDK $($sdk.Version)：$($sdk.MakeAppx)"

# ── 2. 生成身份包暂存目录 ─────────────────────────────────────────
Write-Step '生成 AppxManifest 与占位图标'
if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $stageDir 'Assets') -Force | Out-Null

$manifestTemplate = Join-Path $PSScriptRoot 'AppxManifest.xml.template'
if (-not (Test-Path -LiteralPath $manifestTemplate -PathType Leaf)) {
    Fail "缺少清单模板：$manifestTemplate"
}
$manifestText = [IO.File]::ReadAllText($manifestTemplate)
$replacements = @{
    '__IDENTITY_NAME__'          = $IdentityName
    '__PUBLISHER__'              = $Publisher
    '__VERSION__'                = $Version
    '__DISPLAY_NAME__'           = $DisplayName
    '__PUBLISHER_DISPLAY_NAME__' = $PublisherDisplayName
    '__APPLICATION_ID__'         = $ApplicationId
    '__EXECUTABLE__'             = $Executable
}
foreach ($k in $replacements.Keys) {
    $manifestText = $manifestText.Replace($k, [string]$replacements[$k])
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $stageDir 'AppxManifest.xml'), $manifestText, $utf8NoBom)

# 占位图标：纯色 PNG，保证 makeappx 与“设置 → 应用”不报缺图。
# 真正发布前请换成 fake_neuro.ico 导出的多尺寸 PNG。
$assets = @{
    'Square44x44Logo.png'   = 'iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAIAAACR5s1WAAAANUlEQVR42u3OMQ0AAAgDsElB9ARjgY+nSQU0076LhISEhISEhISEhISEhISEhISEhISExN0CffqxCJeTi9UAAAAASUVORK5CYII='
    'Square150x150Logo.png' = 'iVBORw0KGgoAAAANSUhEUgAAAJYAAACWCAIAAACzY+a1AAAA80lEQVR42u3RAQkAAAzDsEm56Am+jHMIVEGTafW6WIBQCIUQoQsIhVAIEQqhEAohQiEUQiFEKIRCKIQIhVAIhRChEAqhECIUQiEUQoRCKIRCiFAIhVAIEQqhEAohQiEUQiFEKIRCKIQIhVAIhRChEAqhECIUQiEUQoRCKIRCiFAIhVAIEQqhEAohQiEUQiFEKIRCKIQIhVAIhRChEAqhECIUQiEUQoRCKIRCiFAIhVAIEQqhEAohQiEUQiFEKIRCKIQIhVAIhRChEAqhECIUQiEUQoRCKIQIXUAohEKIUAiFUAgRCqEQCiFCIRRCIUQohLppAdcdorFPBwbDAAAAAElFTkSuQmCC'
    'StoreLogo.png'         = 'iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAIAAACRXR/mAAAAO0lEQVR42u3OAQkAAAgDsEcx9ANbQ2GwAMu0B0VLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0vrV2sBFYaD1awZrKoAAAAASUVORK5CYII='
}
foreach ($name in $assets.Keys) {
    [IO.File]::WriteAllBytes((Join-Path $stageDir "Assets\$name"), [Convert]::FromBase64String($assets[$name]))
}

# ── 3. 把 <msix> 身份节点注入 exe 的 SxS 清单 ────────────────────
Write-Step '注入 SxS 身份清单（mt.exe）'
$exeBackup = Join-Path $outRoot "$Executable.pre-msix.bak"
if (-not (Test-Path -LiteralPath $exeBackup -PathType Leaf)) {
    Copy-Item -LiteralPath $exePath -Destination $exeBackup -Force
    Write-Host "已备份原 exe：$exeBackup"
}

$existingManifest = Join-Path $workDir 'app.existing.manifest'
if (Test-Path -LiteralPath $existingManifest) { Remove-Item -LiteralPath $existingManifest -Force }
& $sdk.Mt -nologo "-inputresource:$exePath;#1" "-out:$existingManifest" | Out-Null
$mtExtractExit = $LASTEXITCODE

$nsMsix = 'urn:schemas-microsoft-com:msix.v1'
$mergedManifest = Join-Path $workDir 'app.merged.manifest'
$useTemplate = ($mtExtractExit -ne 0) -or (-not (Test-Path -LiteralPath $existingManifest -PathType Leaf)) -or
               ((Get-Item -LiteralPath $existingManifest).Length -eq 0)

if ($useTemplate) {
    Write-Host '[警告] exe 里抽不到原有清单，退回模板整体写入。' -ForegroundColor Yellow
    Write-Host '       注意：这会丢失 Electron 原有的 dpiAware / 兼容性声明，仅作兜底。' -ForegroundColor Yellow
    $templateText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'app.manifest.template'))
    foreach ($k in $replacements.Keys) {
        $templateText = $templateText.Replace($k, [string]$replacements[$k])
    }
    [IO.File]::WriteAllText($mergedManifest, $templateText, $utf8NoBom)
} else {
    try {
        $doc = New-Object System.Xml.XmlDocument
        $doc.PreserveWhitespace = $true
        $doc.Load($existingManifest)
        if (-not $doc.DocumentElement) { throw '清单没有根节点' }

        # 移除旧 msix 节点（重复跑时避免重复）
        $old = $doc.DocumentElement.SelectSingleNode("*[local-name()='msix' and namespace-uri()='$nsMsix']")
        if ($old) { [void]$doc.DocumentElement.RemoveChild($old) }

        $msixNode = $doc.CreateElement('msix', $nsMsix)
        $msixNode.SetAttribute('publisher', $Publisher)
        $msixNode.SetAttribute('packageName', $IdentityName)
        $msixNode.SetAttribute('applicationId', $ApplicationId)
        [void]$doc.DocumentElement.AppendChild($msixNode)

        $doc.Save($mergedManifest)
        Write-Host "已合并到原有清单：publisher=$Publisher packageName=$IdentityName applicationId=$ApplicationId"
    } catch {
        Fail "解析/合并 exe 原有清单失败：$($_.Exception.Message)。可删掉 $exeBackup 后重跑 --dir 生成干净产物。"
    }
}

& $sdk.Mt -nologo -manifest $mergedManifest "-outputresource:$exePath;#1"
if ($LASTEXITCODE -ne 0) {
    Fail "mt.exe 写回清单失败，退出码 $LASTEXITCODE。常见原因：DaFeiyu.exe 正在运行导致文件被占用（先完全退出应用），或清单 XML 不合法（看上一行 mt 的具体报错）。"
}

# 回读校验：确保 <msix> 真的写进去了
$verifyManifest = Join-Path $workDir 'app.verify.manifest'
if (Test-Path -LiteralPath $verifyManifest) { Remove-Item -LiteralPath $verifyManifest -Force }
& $sdk.Mt -nologo "-inputresource:$exePath;#1" "-out:$verifyManifest" | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Select-String -LiteralPath $verifyManifest -SimpleMatch "packageName=`"$IdentityName`"" -Quiet)) {
    Fail "回读校验失败：$exePath 的清单里没有 packageName=$IdentityName。不要继续打包。"
}
Write-Host '回读校验通过：exe 内已带 msix 身份节点。'

# ── 4. MakeAppx 打包 ─────────────────────────────────────────────
Write-Step 'MakeAppx 打包（稀疏包，不含应用文件）'
$msixPath = Join-Path $outRoot "$IdentityName.$Version.msix"
if (Test-Path -LiteralPath $msixPath) { Remove-Item -LiteralPath $msixPath -Force }
& $sdk.MakeAppx pack /o /d $stageDir /nv /p $msixPath
Assert-LastExit 'MakeAppx pack'
if (-not (Test-Path -LiteralPath $msixPath -PathType Leaf)) {
    Fail "MakeAppx 返回 0 但没有产物：$msixPath"
}
Write-Host "已生成：$msixPath（$([math]::Round((Get-Item -LiteralPath $msixPath).Length / 1KB, 1)) KB）"

# ── 5. 证书与签名 ────────────────────────────────────────────────
$pfxPath = $null
$cerPath = $null
$certSubject = $null

if ($CertPath) {
    $pfxPath = [IO.Path]::GetFullPath($CertPath)
    if (-not (Test-Path -LiteralPath $pfxPath -PathType Leaf)) {
        Fail "证书不存在：$pfxPath"
    }
    $maybeCer = [IO.Path]::ChangeExtension($pfxPath, '.cer')
    if (Test-Path -LiteralPath $maybeCer -PathType Leaf) { $cerPath = $maybeCer }
    Write-Host "使用已有证书：$pfxPath"
} else {
    Write-Step '准备自签名开发证书（CN 必须与 Publisher 完全一致）'
    $pfxPath = Join-Path $outRoot 'DaFeiyu-Dev.pfx'
    $cerPath = Join-Path $outRoot 'DaFeiyu-Dev.cer'
    $securePwd = ConvertTo-SecureString -String $CertPassword -AsPlainText -Force

    $cert = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq $Publisher -and $_.FriendlyName -eq 'DaFeiyu MSIX Dev' -and $_.NotAfter -gt (Get-Date) } |
        Select-Object -First 1
    if (-not $cert) {
        Write-Host "创建证书：$Publisher"
        $cert = New-SelfSignedCertificate `
            -Type Custom `
            -Subject $Publisher `
            -KeyUsage DigitalSignature `
            -FriendlyName 'DaFeiyu MSIX Dev' `
            -CertStoreLocation 'Cert:\CurrentUser\My' `
            -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}') `
            -NotAfter (Get-Date).AddYears(3)
    } else {
        Write-Host "复用已有证书：$($cert.Thumbprint)"
    }
    $certSubject = $cert.Subject
    if ($certSubject -ne $Publisher) {
        Fail "证书 Subject（$certSubject）与清单 Publisher（$Publisher）不一致，注册会失败。"
    }
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePwd | Out-Null
    Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT | Out-Null
    Write-Host "PFX：$pfxPath"
    Write-Host "CER：$cerPath"
}

if (-not $SkipSign) {
    Write-Step 'signtool 签名'
    & $sdk.SignTool sign /fd SHA256 /f $pfxPath /p $CertPassword $msixPath
    if ($LASTEXITCODE -ne 0) {
        Fail "签名失败，退出码 $LASTEXITCODE。若是 -CertPath 提供的 PFX，请确认 -CertPassword 正确、PFX 内含私钥。"
    }
    Write-Host '签名完成。'
} else {
    Write-Host '[提示] -SkipSign：未签名，Add-AppxPackage 会拒绝安装，仅用于检查 MakeAppx 是否通过。' -ForegroundColor Yellow
}

# ── 6. 导入信任证书 ─────────────────────────────────────────────
if ($TrustCert -or $Register) {
    Write-Step '把公钥证书导入 CurrentUser\TrustedPeople'
    if (-not $cerPath -or -not (Test-Path -LiteralPath $cerPath -PathType Leaf)) {
        Fail "缺少公钥证书（.cer）。注册自签名包前必须把 CER 导入 TrustedPeople。请用 -CertPath 指向 PFX 时同时提供同名 .cer，或让脚本自动创建证书。"
    }
    $trusted = Get-ChildItem Cert:\CurrentUser\TrustedPeople -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq (Get-PfxCertificate -FilePath $cerPath).Thumbprint }
    if ($trusted) {
        Write-Host '证书已在 TrustedPeople，跳过导入。'
    } else {
        Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\CurrentUser\TrustedPeople' | Out-Null
        Write-Host '证书已导入。'
    }
}

# ── 7. 注册（可选）──────────────────────────────────────────────
if ($Register) {
    Write-Step "注册稀疏包（ExternalLocation=$packAbs）"
    $existing = Get-AppxPackage -Name $IdentityName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "发现同身份旧包，先移除：$($existing.PackageFullName)"
        Remove-AppxPackage -Package $existing.PackageFullName -ErrorAction Stop
    }
    try {
        Add-AppxPackage -Path $msixPath -ExternalLocation $packAbs -ErrorAction Stop
    } catch {
        Fail @"
注册失败：$($_.Exception.Message)
排错顺序：
  1) 0x800B0109 → 证书没进 TrustedPeople，重跑并带 -TrustCert；
  2) 0x80073CF9 → 同版本已注册，先 Get-AppxPackage $IdentityName | Remove-AppxPackage；
  3) 0x80073CF6 → 清单不合法，看 makeappx 报错行号；
  4) 0x80073CFF / 需要开发者模式 → 设置 → 系统 → 开发者选项，开启“开发人员模式”；
  5) 事件查看器：Applications and Services Logs\Microsoft\Windows\AppxDeployment-Server。
"@
    }

    $pkg = Get-AppxPackage -Name $IdentityName -ErrorAction SilentlyContinue
    if (-not $pkg) {
        Fail "Add-AppxPackage 返回成功但 Get-AppxPackage 查不到 $IdentityName。"
    }
    Write-Host ''
    Write-Host '[成功] 包身份已注册' -ForegroundColor Green
    Write-Host "  Name:              $($pkg.Name)"
    Write-Host "  PackageFullName:   $($pkg.PackageFullName)"
    Write-Host "  PackageFamilyName: $($pkg.PackageFamilyName)"
    Write-Host "  InstallLocation:   $($pkg.InstallLocation)"
    Write-Host "  ExternalLocation:  $packAbs"
    Write-Host ''
    Write-Host '验证身份是否真的进了进程（在应用里执行，或看应用日志）：'
    Write-Host '  Windows.ApplicationModel.Package.Current.Id.Name 应等于 com.myneuro.dafeiyu'
    Write-Host '注意：光有身份还不够，UserNotificationListener 仍需要进程内用 WinRT 调用并 RequestAccessAsync。'
} else {
    Write-Host ''
    Write-Host '[完成] 已生成并签名稀疏包（未注册）'
    Write-Host "  MSIX: $msixPath"
    Write-Host "  CER:  $cerPath"
    Write-Host '注册命令：'
    Write-Host "  Add-AppxPackage -Path '$msixPath' -ExternalLocation '$packAbs'"
}

# ── 8. 记录参数，便于复现 ────────────────────────────────────────
$info = [ordered]@{
    generatedAt        = (Get-Date).ToString('s')
    identityName       = $IdentityName
    publisher          = $Publisher
    version            = $Version
    displayName        = $DisplayName
    publisherDisplayName = $PublisherDisplayName
    executable         = $Executable
    applicationId      = $ApplicationId
    externalLocation   = $packAbs
    msix               = $msixPath
    pfx                = $pfxPath
    cer                = $cerPath
    sdkVersion         = $sdk.Version
    signed             = (-not $SkipSign)
    registered         = [bool]$Register
    capabilities       = @('runFullTrust', 'unvirtualizedResources', 'userNotificationListener')
}
[IO.File]::WriteAllText((Join-Path $outRoot 'identity-info.json'), ($info | ConvertTo-Json -Depth 4), $utf8NoBom)

exit 0
