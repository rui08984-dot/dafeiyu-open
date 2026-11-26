#Requires -Version 5.1
<#
.SYNOPSIS
    大肥鱼桌面伴侣的一键打包入口。三档互斥：
      -DryRun  只出解开的应用目录（electron-builder --dir），验证“能不能打包”
      -Nsis    出 NSIS 安装器（可分发，但没有 Windows 包身份）
      -Appx    出稀疏 MSIX 包身份（不搬应用文件，只发身份）

.DESCRIPTION
    设计约束：
      * 她的应用目录 live-2d 是构建输入，本脚本不回写、不 npm install、不改她的代码；
      * electron-builder 只装在 _packaging\node_modules；
      * 任何一步失败都抛错并带退出码，绝不静默跳过。

    为什么 NSIS 和 AppX 是两条路：
      * NSIS 解决“怎么装到用户机器上”，不提供包身份 → 通知监听不可用；
      * MSIX 稀疏包解决“怎么让 Windows 认这个应用是打包应用”，
        应用仍从原目录跑，可写目录不变；
      * 想两者兼得，常规做法是 NSIS 装应用 + 安装器里注册稀疏身份包（本期未做）。

.PARAMETER DryRun
    执行 electron-builder --dir，产物在 out\electron-builder\win-unpacked。

.PARAMETER Nsis
    执行 electron-builder --win nsis，产物 DaFeiyu-Setup-<version>.exe。

.PARAMETER Appx
    调用 identity\make-identity-package.ps1：生成 AppxManifest、注入 SxS 清单、
    MakeAppx 打包、自签名、可选注册（-Register）。

.PARAMETER Register
    配合 -Appx：注册（Add-AppxPackage -ExternalLocation）到当前用户。
    会先移除同名旧包，并自动把自签名证书加入 CurrentUser\TrustedPeople。

.PARAMETER TrustCert
    配合 -Appx：只导入证书到 TrustedPeople，不注册。

.PARAMETER PackDir
    配合 -Appx：指定外部位置目录，默认 out\electron-builder\win-unpacked。

.PARAMETER CertPath
    配合 -Appx：已有 PFX 证书路径；不给则自动创建自签名开发证书。

.PARAMETER CertPassword
    配合 -Appx：PFX 密码。仅为本地开发证书使用，默认 dafeiyu-dev。

.PARAMETER SkipNpmInstall
    工具未安装时直接报错，不自动 npm install（离线/审计场景用）。

.PARAMETER BinariesMirror
    可选：electron-builder 二进制制品的镜像根 URL。
    本机到 GitHub Releases 会超时，-Nsis 首次构建会卡在下载 nsis-3.0.4.1.7z。
    镜像目录结构必须是 <镜像根>/<name>/<name>.7z，例如：
      http://127.0.0.1:8765/nsis-3.0.4.1/nsis-3.0.4.1.7z
      http://127.0.0.1:8765/nsis-resources-3.4.1/nsis-resources-3.4.1.7z
    本机已有缓存时，可照文档第 8 节的 10 行脚本起一个本地静态服务器。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\build-installer.ps1 -DryRun

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\build-installer.ps1 -Nsis -BinariesMirror 'http://127.0.0.1:8765/'

.EXAMPLE
    # 先 -DryRun 出目录，再发身份并注册
    powershell -NoProfile -ExecutionPolicy Bypass -File .\build-installer.ps1 -Appx -Register
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Nsis,
    [switch]$Appx,
    [switch]$Register,
    [switch]$TrustCert,
    [string]$PackDir,
    [string]$CertPath,
    [string]$CertPassword = 'dafeiyu-dev',
    [string]$BinariesMirror,
    [switch]$SkipNpmInstall,
    # 产品版本号（安装包文件名/程序版本）。应用自身的 package.json 版本与产品线无关，
    # 公开版按 release tag 走：v0.3.1 → DaFeiyu-Setup-0.3.1.exe。
    [string]$Version = '0.3.1',
    # 不随包 edge-tts 单文件 exe（体积敏感时用；默认随包，开箱有语音）
    [switch]$SkipTts
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
        Fail "$What 失败，退出码 $LASTEXITCODE。完整命令与输出见上方。"
    }
}

# ── 0. 参数互斥检查 ────────────────────────────────────────────────
$modeCount = @(@($DryRun, $Nsis, $Appx) | Where-Object { $_ }).Count
$modes = @()
if ($DryRun) { $modes += '-DryRun' }
if ($Nsis)   { $modes += '-Nsis' }
if ($Appx)   { $modes += '-Appx' }
if ($modes.Count -eq 0) {
    Write-Host '用法：build-installer.ps1 -DryRun | -Nsis | -Appx [-Register]' -ForegroundColor Yellow
    Write-Host '  -DryRun  只出可运行目录，做可行性检查'
    Write-Host '  -Nsis    出 NSIS 安装器（无包身份）'
    Write-Host '  -Appx    出稀疏 MSIX 包身份（可选 -Register 注册）'
    exit 1
}
if ($modes.Count -gt 1) {
    Fail "三档互斥，一次只能选一个。当前选了：$($modes -join ', ')"
}

# ── 1. 路径与前置条件 ──────────────────────────────────────────────
$here = $PSScriptRoot
$herDir = [IO.Path]::GetFullPath((Join-Path $here '..\_incoming\my-neuro\live-2d'))
$builderCli = Join-Path $here 'node_modules\electron-builder\cli.js'
$outDir = Join-Path $here 'out\electron-builder'
$unpackedDir = Join-Path $outDir 'win-unpacked'
$appStageDir = Join-Path $here 'out\appstage'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

Write-Host "打包工作区：$here"
Write-Host "应用源码：  $herDir"
Write-Host "模式：      $($modes -join ', ')"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Fail '找不到 node。请确认 Node.js 已装且在当前 PATH；本机 PATH 里的 python 是商店占位符不代表 node 也如此，用 `Get-Command node` 自查。'
}
$nodeExe = $nodeCmd.Source

foreach ($required in @('package.json', 'main.js', 'node_modules\electron\dist\electron.exe')) {
    $p = Join-Path $herDir $required
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
        Fail "她的应用缺少必需文件：$p。请先确认 live-2d 完整（含 node_modules\electron），本脚本不会替你 npm install。"
    }
}

# 工具缺失才安装，且只装到 _packaging
if (-not (Test-Path -LiteralPath $builderCli -PathType Leaf)) {
    if ($SkipNpmInstall) {
        Fail "electron-builder 未安装：$builderCli。去掉 -SkipNpmInstall 或手动在 $here 执行 npm install。"
    }
    Write-Step 'electron-builder 未安装，正在安装到 _packaging（不碰 live-2d）'
    Push-Location -LiteralPath $here
    try {
        & npm.cmd install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Fail "npm install 失败，退出码 $LASTEXITCODE。若网络被墙，见 docs\打包-安装器与包身份-2026-11-18.md 的离线方案。"
        }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path -LiteralPath $builderCli -PathType Leaf)) {
        Fail "npm install 返回 0 但 electron-builder\cli.js 仍不存在：$builderCli"
    }
}

# ── 2. 准备构建副本 ────────────────────────────────────────────────
# 为什么需要副本：electron-builder 硬性校验“electron 不许出现在 dependencies”，
# 而她的 package.json 恰好把 electron 写在 dependencies 里，且没有配置开关能跳过。
# 副本里只改这一处元数据；她的源码目录保持只读。
function Prepare-AppStage {
    Write-Step "准备构建副本（robocopy 增量镜像，不改她的 package.json）"
    New-Item -ItemType Directory -Path $appStageDir -Force | Out-Null

    $excludeFiles = @(
        'config.json', 'config.json.bak*',
        'llm_providers.json', 'llm_providers.json.bak*',
        'panel-bounds.json', 'avatar-loading-position.json',
        'character_backups*.json', '*.log', '*.log.*', '@AutomationLog.txt'
    )
    $excludeDirs = @(
        (Join-Path $herDir 'node_modules\electron'),   # 运行时由 electron-builder 注入，不复制 200MB
        (Join-Path $herDir 'crash-dumps'),
        (Join-Path $herDir '.runtime'),
        (Join-Path $herDir 'scripts\electron-ui-package')
    )

    $rcArgs = @($herDir, $appStageDir, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
    foreach ($f in $excludeFiles) { $rcArgs += '/XF'; $rcArgs += $f }
    foreach ($d in $excludeDirs) { $rcArgs += '/XD'; $rcArgs += $d }

    & robocopy.exe @rcArgs | Out-Null
    # robocopy 约定：0-7 都算成功（1=有复制，2=有额外文件，3=两者都有），>=8 才是失败
    if ($LASTEXITCODE -ge 8) {
        Fail "robocopy 准备构建副本失败，退出码 $LASTEXITCODE。源：$herDir 目标：$appStageDir"
    }

    # 修正副本里的 package.json：electron → devDependencies
    $stagePkgPath = Join-Path $appStageDir 'package.json'
    if (-not (Test-Path -LiteralPath $stagePkgPath -PathType Leaf)) {
        Fail "构建副本缺少 package.json：$stagePkgPath"
    }
    $pkg = [IO.File]::ReadAllText($stagePkgPath, [Text.Encoding]::UTF8) | ConvertFrom-Json

    $electronRange = '^28.0.0'
    $deps = [ordered]@{}
    foreach ($p in $pkg.dependencies.PSObject.Properties) {
        if ($p.Name -eq 'electron') { $electronRange = [string]$p.Value; continue }
        $deps[$p.Name] = $p.Value
    }

    $dev = [ordered]@{}
    $devProp = $pkg.PSObject.Properties['devDependencies']
    if ($devProp -and $devProp.Value) {
        foreach ($p in $devProp.Value.PSObject.Properties) { $dev[$p.Name] = $p.Value }
    }
    $dev['electron'] = $electronRange

    # 安装版入口分发（2026-11-26）：packaged Electron 不认「脚本路径」参数，
    # openControlCenter() 必须靠 --control-center 走入口分支，否则会再起一个桌宠。
    $entrySrc = Join-Path $here 'build-resources\control-entry.cjs'
    if (-not (Test-Path -LiteralPath $entrySrc -PathType Leaf)) {
        Fail "缺少安装版入口文件：$entrySrc"
    }
    Copy-Item -LiteralPath $entrySrc -Destination (Join-Path $appStageDir 'control-entry.cjs') -Force

    $stagePkg = [ordered]@{
        name         = $pkg.name
        # 产品版本走 -Version（公开版按 release tag）；应用自身版本 1.0.0 与产品线无关
        version      = $Version
        description  = $pkg.description
        # 只改安装版入口：源码树 package.json 仍是 main.js，开发/launcher 行为不变
        main         = 'control-entry.cjs'
        scripts      = $pkg.scripts
        dependencies = $deps
        devDependencies = $dev
    }
    foreach ($key in @('keywords', 'author', 'license')) {
        $prop = $pkg.PSObject.Properties[$key]
        if ($prop) { $stagePkg[$key] = $prop.Value }
    }
    [IO.File]::WriteAllText($stagePkgPath, ($stagePkg | ConvertTo-Json -Depth 8), $utf8NoBom)

    $stageMb = [math]::Round(((Get-ChildItem -LiteralPath $appStageDir -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum / 1MB), 1)
    Write-Host "构建副本就绪：$appStageDir（约 $stageMb MB；electron 已移入 devDependencies）"
}

Prepare-AppStage

# ── 2.5 安装版默认配置（公开包）──────────────────────────────────────
# 她的 config-loader 缺 config.json 会直接抛错（main.js loadConfigData），
# 所以安装包必须带一份「干净、无个人路径、无真实 key」的默认配置。
# 首启由宿主检测空 key → 自动打开控制中心「模型」页（js/core/first-run.js）。
function Write-PublicDefaults {
    Write-Step '生成安装版默认配置（空 key，首启引导填写）'
    $exCfg = Join-Path $appStageDir 'config.example.json'
    if (-not (Test-Path -LiteralPath $exCfg -PathType Leaf)) {
        Fail "构建副本缺少 config.example.json：$exCfg"
    }
    $cfg = [IO.File]::ReadAllText($exCfg, [Text.Encoding]::UTF8) | ConvertFrom-Json

    # 默认云端 provider：OpenAI 兼容空白（任何兼容网关都能改 url/model 直接用）
    $defaultPersona = '你是大肥鱼，住在用户桌面上的数字伙伴。说话自然、简短、有自己的脾气：会吐槽也会关心人，不端着、不说教。除非用户要求，不要长篇大论。'
    $cfg.llm.provider_id = 'cloud'
    $cfg.llm.model_id = 'gpt-4o-mini'
    $cfg.llm.system_prompt = $defaultPersona
    $cfg.vision.provider_id = 'cloud'
    $cfg.vision.model_id = 'gpt-4o-mini'

    # 公开版脱敏：个人工作区路径、屏幕感知同意、需要 Python/外部服务的开关
    $cfg.dispatch.workspaces = [pscustomobject]@{}
    $cfg.dispatch.defaultWorkspace = ''
    $cfg.privacy.PSObject.Properties.Remove('ack_screen_watch')
    $cfg.privacy.PSObject.Properties.Remove('acked_at')
    $cfg.asr.enabled = $false          # 薄装不带 ASR 服务；按 V 不再撞一个不存在的端口
    $cfg.rag.enabled = $false          # 8002 不在薄装里
    $cfg.cost.local_memory = $false    # 本地 4B 记忆模型按需自装（README 指引）
    $cfg.browser_ext_ids = @()
    $cfg | Add-Member -NotePropertyName 'memos' -NotePropertyValue ([pscustomobject]@{ enabled = $false }) -Force
    $cfg | Add-Member -NotePropertyName '_install' -NotePropertyValue ([pscustomobject]@{
        at = (Get-Date).ToString('o'); by = 'installer'; version = $Version
    }) -Force
    [IO.File]::WriteAllText((Join-Path $appStageDir 'config.json'), ($cfg | ConvertTo-Json -Depth 32), $utf8NoBom)

    $providers = [ordered]@{
        providers = @(
            [ordered]@{
                id = 'cloud'; name = '云端 API（OpenAI 兼容）'; api_key = ''
                api_url = 'https://api.openai.com/v1'; enabled = $true
                models = @([ordered]@{
                    model_id = 'gpt-4o-mini'; name = 'gpt-4o-mini'; enabled = $true
                    temperature = 0.85; temperature_enabled = $true
                })
            },
            [ordered]@{
                id = 'ollama'; name = '本地 Ollama（可选，免费离线）'; api_key = 'ollama'
                api_url = 'http://127.0.0.1:11434/v1'; enabled = $false
                models = @([ordered]@{ model_id = 'qwen3-vl:8b-instruct'; name = 'qwen3-vl:8b-instruct'; enabled = $true })
            }
        )
    }
    [IO.File]::WriteAllText((Join-Path $appStageDir 'llm_providers.json'), ($providers | ConvertTo-Json -Depth 16), $utf8NoBom)

    # 兜底自检：安装包默认配置里绝不能出现真实 key 形状
    foreach ($f in @('config.json', 'llm_providers.json')) {
        $p = Join-Path $appStageDir $f
        $txt = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
        if ($txt -match 'sk-[A-Za-z0-9]{20,}') {
            Fail "安装版默认配置疑似含真实 key：$p（构建中止）"
        }
    }
    Write-Host "默认配置已写入：config.json（人设占位 + provider=cloud）/ llm_providers.json（空 key + ollama 停用）"
}

# ── 2.6 随包运行时（pet-core / edge-tts）────────────────────────────
# extraResources 会被 electron-builder 放到 resources/ 下：
#   resources/pet-core/target/release/pet-core.exe  ← main.js resolvePetCore() 的打包后分支
#   resources/tts/dafeiyu-tts.exe                   ← 宿主启动时拉起（js/services/local-tts.js）
function Prepare-ExtraResources {
    Write-Step '准备随包运行时（pet-core / edge-tts）'
    $extraRoot = Join-Path $here 'out\extra'
    $petCoreDir = Join-Path $extraRoot 'pet-core\target\release'
    New-Item -ItemType Directory -Force -Path $petCoreDir | Out-Null
    $petCoreExe = [IO.Path]::GetFullPath((Join-Path $here '..\pet-core\target\release\pet-core.exe'))
    if (Test-Path -LiteralPath $petCoreExe -PathType Leaf) {
        Copy-Item -LiteralPath $petCoreExe -Destination (Join-Path $petCoreDir 'pet-core.exe') -Force
        $pcMb = [math]::Round((Get-Item -LiteralPath $petCoreExe).Length / 1MB, 2)
        Write-Host "pet-core：已随包（$pcMb MB，看屏/操控 Rust 快轨）"
    } else {
        Write-Host '[提示] 没找到 pet-core\target\release\pet-core.exe：安装版将退回 PowerShell 兜底（慢约 20 倍）' -ForegroundColor Yellow
    }

    $ttsDir = Join-Path $extraRoot 'tts'
    New-Item -ItemType Directory -Force -Path $ttsDir | Out-Null
    $ttsExe = [IO.Path]::GetFullPath((Join-Path $here 'out\tts\dafeiyu-tts.exe'))
    if (-not $SkipTts -and (Test-Path -LiteralPath $ttsExe -PathType Leaf)) {
        Copy-Item -LiteralPath $ttsExe -Destination (Join-Path $ttsDir 'dafeiyu-tts.exe') -Force
        $ttsMb = [math]::Round((Get-Item -LiteralPath $ttsExe).Length / 1MB, 2)
        Write-Host "edge-tts：已随包（$ttsMb MB，开箱有声；需要联网访问微软语音端点）"
    } else {
        Write-Host '[提示] 未随包 edge-tts：安装版首启没有语音。' -ForegroundColor Yellow
        Write-Host '       先跑 `powershell -NoProfile -ExecutionPolicy Bypass -File .\build-tts.ps1` 生成 out\tts\dafeiyu-tts.exe，再重跑 -Nsis。'
        Write-Host '       或保持 -SkipTts（用户可后配 OpenAI 兼容 TTS / 自装 Python 完整服务）。'
    }
}

Write-PublicDefaults
Prepare-ExtraResources

# 入口语法闸：2026-11-26 实测漏过一次重复声明（panelArgs），打包不报、启动才在
# Electron 错误框里炸。这里在构建期用 node --check 把入口文件先过一遍。
Write-Step '入口语法检查（node --check）'
foreach ($rel in @('main.js', 'control-entry.cjs', 'control-main.js')) {
    $p = Join-Path $appStageDir $rel
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Fail "构建副本缺少入口文件：$p" }
    & $nodeExe --check $p
    if ($LASTEXITCODE -ne 0) { Fail "入口语法错误：$rel（node --check 退出码 $LASTEXITCODE）" }
    Write-Host "  ✓ $rel"
}

if ($BinariesMirror) {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = $BinariesMirror
    Write-Host "二进制制品镜像：$BinariesMirror"
}

# ── 3. 执行 ────────────────────────────────────────────────────────
switch ($modes[0]) {

    '-DryRun' {
        Write-Step 'electron-builder --dir（只验证打包结构，不生成安装器）'
        Push-Location -LiteralPath $here
        try {
            & $nodeExe $builderCli --dir --config electron-builder.yml
            Assert-LastExit 'electron-builder --dir'
        } finally {
            Pop-Location
        }

        $exe = Join-Path $unpackedDir 'DaFeiyu.exe'
        $asar = Join-Path $unpackedDir 'resources\app.asar'
        $appDir = Join-Path $unpackedDir 'resources\app'
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
            Fail "构建返回 0，但没有 $exe。检查 electron-builder.yml 的 win.executableName 与 productName。"
        }
        if (Test-Path -LiteralPath $asar -PathType Leaf) {
            Write-Host "[提示] 产物里出现 app.asar；当前配置是 asar:false，若看到它说明配置被覆盖。" -ForegroundColor Yellow
        }
        if (-not (Test-Path -LiteralPath $appDir -PathType Container)) {
            Fail "缺少 $appDir。electron-builder 没有把应用目录复制进来。"
        }

        $sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $unpackedDir -Recurse -File -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum / 1MB), 1)
        Write-Host ''
        Write-Host "[成功] 可运行目录已生成：$unpackedDir（约 $sizeMb MB）" -ForegroundColor Green
        # 安装版三件套：配置在、pet-core 在、TTS 在（后两者可缺，缺了要明说）
        foreach ($item in @(
            @{ rel = 'resources\app\config.json'; what = '默认配置 config.json' },
            @{ rel = 'resources\app\llm_providers.json'; what = 'provider 通讯录' },
            @{ rel = 'resources\pet-core\target\release\pet-core.exe'; what = 'pet-core Rust 快轨' },
            @{ rel = 'resources\tts\dafeiyu-tts.exe'; what = '随包 edge-tts' }
        )) {
            $p = Join-Path $unpackedDir $item.rel
            if (Test-Path -LiteralPath $p -PathType Leaf) {
                Write-Host "  ✓ $($item.what)"
            } else {
                Write-Host "  ! 缺 $($item.what)（$($item.rel)）" -ForegroundColor Yellow
            }
        }
        Write-Host '验证方法（把 MY_NEURO_CONFIG_PATH 指向这份打包配置的可写副本）：'
        Write-Host "  `$env:MY_NEURO_CONFIG_PATH = '<config 副本路径>'; & '$exe'"
    }

    '-Nsis' {
        Write-Step 'electron-builder --win nsis（生成安装器）'
        Push-Location -LiteralPath $here
        try {
            & $nodeExe $builderCli --win nsis --x64 --config electron-builder.yml
            if ($LASTEXITCODE -ne 0) {
                Fail @"
electron-builder --win nsis 失败，退出码 $LASTEXITCODE。
若上方出现 Get "https://github.com/electron-userland/electron-builder-binaries/..." 并超时，
说明 NSIS 工具链下载被墙，不是配置错误。两条出路：
  1) 用镜像：-BinariesMirror '<镜像根>'（目录结构 <根>/<name>/<name>.7z）；
  2) 本机已有缓存时，用文档第 8 节的本地静态服务器 + -BinariesMirror http://127.0.0.1:8765/。
其余错误请按上方 electron-builder 原始输出排查（常见：图标路径、磁盘空间）。
"@
            }
        } finally {
            Pop-Location
        }

        $installer = Get-ChildItem -LiteralPath $outDir -Filter 'DaFeiyu-Setup-*.exe' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $installer) {
            Fail "构建返回 0，但 $outDir 下没有 DaFeiyu-Setup-*.exe。"
        }
        Write-Host ''
        Write-Host "[成功] 安装器：$($installer.FullName)（$([math]::Round($installer.Length / 1MB, 1)) MB）" -ForegroundColor Green
        Write-Host '注意：NSIS 安装不提供 Windows 包身份，userNotificationListener 仍不可用。'
        Write-Host '      要包身份请再跑 -Appx（稀疏包指向安装后的目录，或先指向 win-unpacked 做验证）。'
    }

    '-Appx' {
        if ($PackDir) {
            $packAbs = [IO.Path]::GetFullPath($PackDir)
        } else {
            $packAbs = $unpackedDir
        }

        if (-not (Test-Path -LiteralPath (Join-Path $packAbs 'DaFeiyu.exe') -PathType Leaf)) {
            Write-Step "外部位置没有 DaFeiyu.exe，先自动执行一次 --dir 构建"
            Push-Location -LiteralPath $here
            try {
                & $nodeExe $builderCli --dir --config electron-builder.yml
                Assert-LastExit 'electron-builder --dir（-Appx 前置）'
            } finally {
                Pop-Location
            }
        }
        if (-not (Test-Path -LiteralPath (Join-Path $packAbs 'DaFeiyu.exe') -PathType Leaf)) {
            Fail "外部位置仍缺少 DaFeiyu.exe：$packAbs。可用 -PackDir 显式指定。"
        }

        $identityScript = Join-Path $here 'identity\make-identity-package.ps1'
        if (-not (Test-Path -LiteralPath $identityScript -PathType Leaf)) {
            Fail "缺少身份包脚本：$identityScript"
        }

        $identityArgs = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', $identityScript,
            '-PackDir', $packAbs,
            '-CertPassword', $CertPassword
        )
        if ($CertPath) { $identityArgs += @('-CertPath', ([IO.Path]::GetFullPath($CertPath))) }
        if ($Register) { $identityArgs += '-Register' }
        if ($TrustCert -or $Register) { $identityArgs += '-TrustCert' }

        Write-Step '生成稀疏 MSIX 包身份（MakeAppx + 自签名）'
        & powershell.exe @identityArgs
        if ($LASTEXITCODE -ne 0) {
            Fail "身份包生成/注册失败，退出码 $LASTEXITCODE。常见原因见 docs 文档第 6 节排错表。"
        }
    }
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
exit 0
