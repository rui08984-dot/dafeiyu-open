#Requires -Version 5.1
<#
.SYNOPSIS
    构建 ollama-0.5.0.zip（便携 Ollama 组件包）+ out/packs/fragments/ollama.json。

.DESCRIPTION
    为什么要单独一个脚本（2026-11-27）：
      看屏（qwen3-vl:8b-instruct）和 OCR（glm-ocr / paddleocr-vl）都打 Ollama API，
      但 Ollama 官方只有「安装器」和「portable zip」两种 Windows 分发。安装器会装服务、
      改 PATH、抢 11434，跟「组件化、可卸载、可复用用户自己的 Ollama」冲突；
      portable zip 解压即用（根目录 ollama.exe + lib/ollama/），正好满足：
        components/ollama/ollama.exe serve + OLLAMA_MODELS 指到组件目录。

    分发选择（2026-11-27 实测 GitHub release v0.40.18）：
      ollama-windows-amd64.zip  1,717,307,988 B（1.60 GiB）< GitHub 单文件 2 GiB 上限
      sha256 ca97292ac1e9acc77fcf473bb2741fa6acd12e3798f261b419680068b7cc4c16
      → 用 portable zip，不用 OllamaSetup.exe（1.82 GiB 且要管理员/装服务）。

    关键决定：**不重新压缩**。上游 zip 根就是组件根（ollama.exe 在顶层），
    逐字节复制成 ollama-0.5.0.zip 即可；这样：
      · 哈希 == 官方 release digest，可交叉验证；
      · 省掉 2.26GB 解压 + 1.6GB 重新 deflate（本机 ~5 分钟）；
      · 清单里可以多挂一条「官方源」兜底（字节相同才允许）。
    只有上游布局变了（出现顶层目录）才回退到「解压 → 摊平 → 重打包」。

.OUTPUTS
    _packaging/out/packs/ollama-0.5.0.zip
    _packaging/out/packs/fragments/ollama.json
    缓存：_packaging/out/packs-cache/ollama/（重跑不重复下载）

.EXAMPLE
    pwsh -NoProfile -File _packaging/build-ollama-pack.ps1
    pwsh -NoProfile -File _packaging/build-ollama-pack.ps1 -SkipDownload   # 只用缓存
#>
[CmdletBinding()]
param(
    # 上游 Ollama 版本（决定下载 URL 与官方 digest）
    [string]$OllamaVersion = '0.40.18',
    # 我们自己的 release tag（清单里的主下载源）
    [string]$ReleaseTag = 'v0.5.0',
    # 组件版本（文件名 / manifest version）
    [string]$ComponentVersion = '0.5.0',
    # 官方资产哈希与体积（来自 GitHub release API 的 digest/size；换版本必须一起换）
    [string]$ExpectedSha256 = 'ca97292ac1e9acc77fcf473bb2741fa6acd12e3798f261b419680068b7cc4c16',
    [long]$ExpectedSize = 1717307988,
    [switch]$SkipDownload,
    [switch]$KeepStage
)
$ErrorActionPreference = 'Stop'
# 控制台按 UTF-8 输出（GBK 代码页下中文/✓ 会变问号）
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$here = $PSScriptRoot
$root = [IO.Path]::GetFullPath((Join-Path $here '..'))
$outDir = Join-Path $here 'out\packs'
$fragDir = Join-Path $outDir 'fragments'
$cacheDir = Join-Path $here 'out\packs-cache\ollama'
$stageDir = Join-Path $cacheDir 'stage'
$zipName = "ollama-$ComponentVersion.zip"
$packPath = Join-Path $outDir $zipName
$fragPath = Join-Path $fragDir 'ollama.json'

$assetName = 'ollama-windows-amd64.zip'
$assetUrl = "https://github.com/ollama/ollama/releases/download/v$OllamaVersion/$assetName"
$cachedZip = Join-Path $cacheDir "ollama-windows-amd64-$OllamaVersion.zip"
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step([string]$t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan }
function Fail([string]$t) { throw $t }
function Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function MB([long]$n) { [math]::Round($n / 1MB, 1) }

if (-not (Test-Path -LiteralPath $tar)) { Fail "找不到 bsdtar：$tar" }
$curlCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $curlCmd) { Fail '找不到 curl.exe（Windows 10 1803+ 自带；也可装 curl 后重试）' }
$curl = $curlCmd.Source
New-Item -ItemType Directory -Force -Path $outDir, $fragDir, $cacheDir | Out-Null

# ── 1. 下载（直连 → 镜像；支持断点续传）────────────────────────────────
Write-Step "Ollama v$OllamaVersion portable zip（$([math]::Round($ExpectedSize / 1GB, 2)) GiB）"
$needDownload = $true
if (Test-Path -LiteralPath $cachedZip) {
    $have = (Get-Item -LiteralPath $cachedZip).Length
    if ($have -eq $ExpectedSize) { Write-Host "  缓存命中：$cachedZip"; $needDownload = $false }
    else { Write-Host "  缓存体积不符（$have / $ExpectedSize），重下"; Remove-Item -LiteralPath $cachedZip -Force }
}
if ($SkipDownload -and $needDownload) { Fail "指定了 -SkipDownload，但缓存不完整：$cachedZip" }

if ($needDownload) {
    # 直连优先（网好时最快），失败再走公共镜像；GitHub 在部分网络会长时间连不上。
    $urls = @(
        $assetUrl,
        "https://gh-proxy.com/$assetUrl",
        "https://ghproxy.net/$assetUrl"
    )
    $ok = $false
    foreach ($u in $urls) {
        Write-Host "  下载：$u"
        # -C -：断点续传（镜像和 GitHub 都支持 Range）
        $curlArgs = @('-L', '--fail', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', '-C', '-', '-o', $cachedZip, $u)
        & $curl @curlArgs
        if ($LASTEXITCODE -ne 0) {
            # 本机 schannel 吊销服务器不可达（CRYPT_E_REVOCATION_OFFLINE）时 curl 会整体失败，
            # 关掉吊销检查重试一次（只影响本次下载的证书校验强度）。
            & $curl @($curlArgs[0..($curlArgs.Length - 2)] + @('--ssl-no-revoke', $u))
        }
        if (Test-Path -LiteralPath $cachedZip) {
            $sz = (Get-Item -LiteralPath $cachedZip).Length
            if ($sz -eq $ExpectedSize) { $ok = $true; break }
            Write-Host "  本次只拿到 $([math]::Round($sz / 1MB, 1))MB（期望 $([math]::Round($ExpectedSize / 1MB, 1))MB），换下一个源续传" -ForegroundColor Yellow
        }
    }
    if (-not $ok) { Fail "三个源都没下完：$cachedZip（可手动放到该路径后加 -SkipDownload）" }
}

# ── 2. 校验（体积 + SHA256，硬门）─────────────────────────────────────
Write-Step '校验官方哈希'
$size = (Get-Item -LiteralPath $cachedZip).Length
if ($size -ne $ExpectedSize) { Fail "体积不符：$size / 期望 $ExpectedSize" }
$got = Sha $cachedZip
if ($got -ne $ExpectedSha256.ToLower()) {
    Fail "SHA256 不符：`n  期望 $ExpectedSha256`n  实得 $got`n  → 源被篡改或版本参数抄错，拒绝打包"
}
Write-Host "  ✓ $size 字节  sha256=$got"

# ── 3. 解压探路：确认 zip 根就是组件根 ─────────────────────────────────
Write-Step '解压检查布局'
if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
& $tar -xf $cachedZip -C $stageDir
if ($LASTEXITCODE -ne 0) { Fail "解压失败：tar exit $LASTEXITCODE" }

$exeAtRoot = Test-Path -LiteralPath (Join-Path $stageDir 'ollama.exe')
$serverExe = Join-Path $stageDir 'lib\ollama\llama-server.exe'
$fileCount = (Get-ChildItem -LiteralPath $stageDir -Recurse -File).Count
if (-not (Test-Path -LiteralPath $serverExe)) { Fail "包里没有 lib\ollama\llama-server.exe（布局变了？）：$stageDir" }
$libSize = (Get-ChildItem -LiteralPath (Join-Path $stageDir 'lib') -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("  {0} 个文件，解压后 {1}MB（lib/ollama {2}MB）" -f $fileCount, (MB ((Get-ChildItem -LiteralPath $stageDir -Recurse -File | Measure-Object -Property Length -Sum).Sum)), (MB $libSize))

# ── 4. 出包 ────────────────────────────────────────────────────────────
Write-Step "生成 $zipName"
if ($exeAtRoot) {
    # 主流布局：根 = 组件根，逐字节复用（哈希保留官方 digest）
    Write-Host '  zip 根已是组件根 → 直接复制，不重新压缩'
    if (Test-Path -LiteralPath $packPath) { Remove-Item -LiteralPath $packPath -Force }
    Copy-Item -LiteralPath $cachedZip -Destination $packPath -Force
    $upstreamReusable = $true
} else {
    # 万一上游改成 <dir>/ollama.exe 布局：摊平后重打包（哈希会变，清单里不挂官方源）
    Write-Host '  上游带顶层目录 → 解压摊平后重打包（哈希不再等于官方 digest）' -ForegroundColor Yellow
    $inner = Get-ChildItem -LiteralPath $stageDir -Directory | Select-Object -First 1
    if (-not $inner -or -not (Test-Path -LiteralPath (Join-Path $inner.FullName 'ollama.exe'))) {
        Fail "无法确定组件根：$stageDir 下既没有 ollama.exe，也没有单一顶层目录"
    }
    if (Test-Path -LiteralPath $packPath) { Remove-Item -LiteralPath $packPath -Force }
    & $tar -a -c -f $packPath -C $inner.FullName .
    if ($LASTEXITCODE -ne 0) { Fail "重新打包失败：tar exit $LASTEXITCODE" }
    $upstreamReusable = $false
}

$packSize = (Get-Item -LiteralPath $packPath).Length
$packSha = Sha $packPath
Write-Host ("  {0}  {1}MB  {2}" -f $zipName, (MB $packSize), $packSha)

if (-not $KeepStage) {
    try { Remove-Item -LiteralPath $stageDir -Recurse -Force } catch { Write-Host "  （临时目录清理失败，可手动删：$stageDir）" -ForegroundColor Yellow }
}

# ── 5. fragments/ollama.json ───────────────────────────────────────────
Write-Step '写 fragments/ollama.json'
$sources = @(
    [ordered]@{ url = "https://github.com/rui08984-dot/dafeiyu-open/releases/download/$ReleaseTag/$zipName"; priority = 1 },
    [ordered]@{ url = "https://ghproxy.net/https://github.com/rui08984-dot/dafeiyu-open/releases/download/$ReleaseTag/$zipName"; priority = 2 }
)
if ($upstreamReusable) {
    # 字节与官方一致 → 多一条官方源兜底（我们自己的 release 还没传时也能装上）
    $sources += [ordered]@{ url = $assetUrl; priority = 3 }
}

$fileEntry = [ordered]@{
    name = $zipName
    dest = $zipName
    extractTo = 'ollama'
    sha256 = $packSha
    sizeBytes = $packSize
    sources = $sources
}

$component = [ordered]@{
    id = 'ollama'
    name = '本地视觉/OCR（Ollama + Qwen3-VL/GLM-OCR）'
    version = $ComponentVersion
    extractTo = 'ollama'
    requires = @()          # 纯原生 exe，不需要 python 组件
    files = @($fileEntry)
    config = [ordered]@{}   # 刻意不改 vision.tiers.enabled（见 setup/ollama.js 头注）
    services = @(
        [ordered]@{
            id = 'ollama'
            name = 'Ollama 本地视觉/OCR'
            port = 11434
            order = 30
            startTimeoutMs = 60000
            autoRestart = $true
            cmd = @('{dir}/ollama.exe', 'serve')
            cwd = '{dir}'
            env = [ordered]@{
                OLLAMA_MODELS = '{dir}/models'
                OLLAMA_HOST = '127.0.0.1:11434'
            }
            health = [ordered]@{ url = 'http://127.0.0.1:11434/api/tags'; timeoutMs = 2000 }
        }
    )
    setup = 'js/components/setup/ollama.js'
    sizeBytes = $packSize
}

# 单元素数组：PowerShell 5.1 的管道会拆包，这里手工拼方括号保证是数组
$json = '[' + ($component | ConvertTo-Json -Depth 30) + ']'
[IO.File]::WriteAllText($fragPath, $json + "`n", $utf8NoBom)

# ── 6. 汇总 ────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '=== 产物 ===' -ForegroundColor Green
Write-Host ("  {0}  {1}MB  {2}" -f $zipName, (MB $packSize), $packSha)
Write-Host "  清单：$fragPath"
Write-Host '下载源：'
foreach ($s in $sources) { Write-Host ("  [{0}] {1}" -f $s.priority, $s.url) }
Write-Host ''
Write-Host '上传后把 ollama-0.5.0.zip 放到 release 对应 tag 下，清单里的 priority=1 才可用；'
Write-Host '未上传时 priority=3 的官方源（字节相同）仍可兜底安装。'
