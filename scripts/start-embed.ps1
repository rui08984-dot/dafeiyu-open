# start-embed.ps1 —— 启动 8090 嵌入服务（llama.cpp + Qwen3-Embedding-0.6B）
#
# 为什么需要它：MemOS 8003 和记忆召回都依赖 http://127.0.0.1:8090/v1，
# 但它是**共用基础设施**，不在 services.json 里，也不会被 kill-all 杀掉。
# clone 下来的机器必须自己把它拉起来一次；之后 restart=unless-stopped 会跟着 Docker 自启。
#
# 用法：
#   pwsh -NoProfile -File scripts/start-embed.ps1
#   pwsh -NoProfile -File scripts/start-embed.ps1 -ModelsDir D:\models
#   pwsh -NoProfile -File scripts/start-embed.ps1 -CheckOnly   # 只检查，不启动
#
# 不会下载模型、不会安装 Docker。缺什么会明确说缺什么。

[CmdletBinding()]
param(
    [string]$ModelsDir = "",
    [int]$Port = 8090,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $RepoRoot 'docker-compose.embed.yml'
$ModelFile = 'Qwen3-Embedding-0.6B-Q8_0.gguf'

function Write-Ok([string]$msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Miss([string]$msg) { Write-Host "  [缺] $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "[start-embed] ✗ $msg" -ForegroundColor Red; exit 1 }

function Test-EmbedHealth {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
        return ($r.status -eq 'ok')
    } catch { return $false }
}

if (-not $ModelsDir) {
    if ($env:EMBED_MODELS_DIR) { $ModelsDir = $env:EMBED_MODELS_DIR }
    else { $ModelsDir = Join-Path $RepoRoot 'models' }
}
$ModelsDir = [IO.Path]::GetFullPath($ModelsDir)
# Compose 的短语法卷挂载对 Windows 反斜杠/盘符冒号敏感；统一成正斜杠。
$ModelsDirCompose = $ModelsDir -replace '\\', '/'

Write-Host "大肥鱼 · 8090 嵌入服务"
Write-Host "  模型目录：$ModelsDir"
Write-Host "  容器名：  llama-embed（launcher 会自动 docker start 它）"

if (Test-EmbedHealth) {
    Write-Ok "8090 已在运行，无需启动"
    exit 0
}

$gguf = Join-Path $ModelsDir $ModelFile
if (-not (Test-Path -LiteralPath $gguf -PathType Leaf)) {
    Write-Miss "模型不存在：$gguf"
    Write-Host "  获取方式（二选一）："
    Write-Host "    · Hugging Face: Qwen/Qwen3-Embedding-0.6B-GGUF 的 $ModelFile"
    Write-Host "    · 或把已有模型目录用 -ModelsDir 指过来"
    if ($CheckOnly) { exit 1 }
    Fail "先放好模型，再运行本脚本；本脚本不会自动下载"
}
Write-Ok "模型就位（$([math]::Round((Get-Item -LiteralPath $gguf).Length / 1MB)) MB）"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    if ($CheckOnly) { Write-Miss 'docker 不在 PATH'; exit 1 }
    Fail '找不到 docker。先装 Docker Desktop 并启动它'
}
if ($CheckOnly) {
    Write-Ok 'docker 可用'
    exit 0
}

# 已有容器：优先 start（保留原来的挂载/参数，不重建）。
$exists = $false
try {
    $names = @(& docker ps -a --filter 'name=llama-embed' --format '{{.Names}}' 2>$null)
    $exists = $names -contains 'llama-embed'
} catch { $exists = $false }

if ($exists) {
    $running = (& docker inspect -f '{{.State.Running}}' llama-embed 2>$null)
    if ($running -eq 'true') {
        Write-Ok '容器已在运行，等待健康检查…'
    } else {
        Write-Host '  [..] 容器存在但未运行，docker start llama-embed'
        & docker start llama-embed | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail 'docker start llama-embed 失败（Docker Desktop 起了吗？）' }
    }
} else {
    if (-not (Test-Path -LiteralPath $ComposeFile -PathType Leaf)) { Fail "缺 $ComposeFile" }
    Write-Host '  [..] 首次创建容器：docker compose -f docker-compose.embed.yml up -d'
    $env:EMBED_MODELS_DIR = $ModelsDirCompose
    & docker compose -f $ComposeFile up -d
    if ($LASTEXITCODE -ne 0) { Fail 'docker compose up 失败（看上面的输出；国内拉镜像慢可设 EMBED_IMAGE=ghcr.nju.edu.cn/ggml-org/llama.cpp:server）' }
}

# 冷启动要加载 640MB 模型，给足 90 秒。
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    if (Test-EmbedHealth) {
        Write-Ok "8090 健康（用时约 $($i + 1)s）"
        Write-Host '  下一步：node scripts/bootstrap.mjs 应显示「嵌入服务 8090」通过'
        exit 0
    }
}

Fail "容器起了但 8090 一直不健康。排查：docker logs llama-embed --tail 50"
