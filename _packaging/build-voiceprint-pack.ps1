#Requires -Version 5.1
<#
.SYNOPSIS
    构建大肥鱼 v0.5.0 声纹组件包（voiceprint：resemblyzer + CPU torch，8020 嵌入服务）。

.DESCRIPTION
    输出：_packaging/out/packs/voiceprint-0.5.0.zip + out/packs/fragments/voiceprint.json
    zip 根 = 组件根：audio_common/voiceprint_server.py + site-packages/（含 resemblyzer 内置
    pretrained.pt 权重，离线可构造 VoiceEncoder）。

    为什么独立 site-packages：resemblyzer 依赖 torch 与它自己一套 numpy/librosa，
    绝不能混进 python 组件的 site-packages-base（numpy 冲突 0xC0000005 前车之鉴）。
    服务侧靠 PYTHONPATH='{dir}/site-packages;{pythonDir}/site-packages-base' 隔离。

    torch 只装 CPU wheel（--index-url https://download.pytorch.org/whl/cpu）；
    失败时回退 aliyun 的 PyPI torch（Windows 版 PyPI torch 本身就是 CPU 构建，
    无 CUDA 依赖，装完仍校验 torch.version.cuda 必须为空）。
    resemblyzer 及其余依赖用 --no-deps + 显式清单装，保证 uv 不会重新解析 torch。
#>
[CmdletBinding()]
param(
    [string]$TorchSpec = 'torch==2.15.0'   # venv-voice 实测可用版本；cpu 索引里解析为 +cpu wheel
)
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$root = [IO.Path]::GetFullPath((Join-Path $here '..'))
$outDir = Join-Path $here 'out\packs'
$stageRoot = Join-Path $outDir 'stage'
$stage = Join-Path $stageRoot 'voiceprint'
$uvCmd = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uvCmd) { throw '找不到 uv：请先 pip install uv，或把 uv.exe 所在目录加进 PATH' }
$uv = $uvCmd.Source
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$index = 'https://mirrors.aliyun.com/pypi/simple/'
$torchCpuIndex = 'https://download.pytorch.org/whl/cpu'
$VERSION = '0.5.0'

if (-not (Test-Path -LiteralPath $tar)) { throw "找不到 bsdtar：$tar" }
New-Item -ItemType Directory -Force -Path $outDir, $stageRoot, (Join-Path $outDir 'fragments') | Out-Null

function Write-Step([string]$t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan }
function Fail([string]$t) { throw $t }
function Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function MB([long]$n) { [math]::Round($n / 1MB, 1) }

# ── 1. 独立 CPython（复用 python 组件的 stage，不重复分发） ────────────────
Write-Step '独立 CPython 3.13.3（stage/python）'
$BUILD_PY = Join-Path $stageRoot 'python\python.exe'
if (-not (Test-Path -LiteralPath $BUILD_PY)) {
    Write-Host '  stage/python 缺失，用 uv 重新装 3.13.3 并复制……'
    & $uv python install 3.13.3
    if ($LASTEXITCODE -ne 0) { Fail 'uv python install 3.13.3 失败' }
    $managed = Join-Path $env:APPDATA 'uv\python\cpython-3.13.3-windows-x86_64-none'
    if (-not (Test-Path -LiteralPath (Join-Path $managed 'python.exe'))) {
        $found = (& $uv python find 3.13.3 2>$null | Select-Object -First 1)
        if ($found) { $managed = Split-Path -Parent ([string]$found) }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $managed 'python.exe'))) { Fail "找不到 uv 的 3.13.3 运行时（$managed）" }
    New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot 'python') | Out-Null
    Copy-Item -Path (Join-Path $managed '*') -Destination (Join-Path $stageRoot 'python') -Recurse -Force
}
& $BUILD_PY -c "import sys; print('python-ok', sys.version.split()[0])"
if ($LASTEXITCODE -ne 0) { Fail '独立 Python 跑不起来' }

# ── 2. stage：清空重建，放组件根文件 ─────────────────────────────────────
Write-Step "stage：$stage"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'audio_common') | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'audio_common\voiceprint_server.py') -Destination (Join-Path $stage 'audio_common\voiceprint_server.py') -Force
$sp = Join-Path $stage 'site-packages'
New-Item -ItemType Directory -Force -Path $sp | Out-Null

function UvInstall([string[]]$pkgs, [string]$indexUrl, [switch]$NoDeps) {
    $uvArgs = @('pip', 'install', '--python', $BUILD_PY, '--target', $sp, '--index-url', $indexUrl)
    if ($NoDeps) { $uvArgs += '--no-deps' }
    $uvArgs += $pkgs
    & $uv @uvArgs
    if ($LASTEXITCODE -ne 0) { Fail "uv pip install 失败：$($pkgs -join ' ')" }
}

# ── 3. torch CPU（PyTorch 官方 cpu 索引优先，失败回退 aliyun） ─────────────
Write-Step 'torch CPU wheel'
$torchFrom = 'pytorch-cpu'
& $uv pip install --python $BUILD_PY --target $sp --index-url $torchCpuIndex $TorchSpec 2>&1 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) {
    Write-Host '  pytorch cpu 索引失败，回退 aliyun（Windows PyPI torch 本身是 CPU 构建）……' -ForegroundColor Yellow
    & $uv pip install --python $BUILD_PY --target $sp --index-url $index $TorchSpec 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { Fail 'torch 安装失败（pytorch-cpu 与 aliyun 都失败）' }
    $torchFrom = 'aliyun-pypi'
}

# ── 4. resemblyzer 及依赖（显式清单 + --no-deps，杜绝 uv 重解析 torch） ────
# 注意：不能装 resemblyzer METADATA 里声明的 `typing` 回溯包——它在 py3.13 上会
# 以 site-packages/typing.py 遮蔽标准库 typing，torch 导入直接 AttributeError
# (_abc_registry)。标准库 typing 已够用，故显式清单里排除。
Write-Step 'resemblyzer + 依赖（aliyun，--no-deps 隔离 torch）'
# setuptools 必须 <81（80.10.2 与 venv-voice 同版）：webrtcvad.py 的 shim import
# pkg_resources，而 setuptools 81+ 已把 pkg_resources 移除。
UvInstall @('librosa', 'numpy', 'webrtcvad', 'scipy', 'setuptools==80.10.2') $index
UvInstall @('resemblyzer') $index -NoDeps

# ── 5. 校验：torch 无 CUDA、权重随包、VoiceEncoder 离线构造 ────────────────
Write-Step '校验（torch 版本 / pretrained.pt / VoiceEncoder 构造）'
$env:PYTHONPATH = "$sp"
$env:PYTHONIOENCODING = 'utf-8'
$check = @'
import json, os, sys
import typing
assert "site-packages" not in str(typing.__file__), "typing 回溯包遮蔽标准库：" + str(typing.__file__)
import torch
assert not torch.cuda.is_available(), "CUDA torch 不允许"
info = {"torch": torch.__version__, "torch_cuda": torch.version.cuda}
import resemblyzer, librosa, numpy, webrtcvad, scipy
info["resemblyzer"] = resemblyzer.__version__ if hasattr(resemblyzer, "__version__") else "0.1.4"
info["librosa"] = librosa.__version__; info["numpy"] = numpy.__version__; info["scipy"] = scipy.__version__
import webrtcvad as wv; info["webrtcvad"] = getattr(wv, "__version__", "?")
from pathlib import Path
pt = Path(resemblyzer.__file__).parent / "pretrained.pt"
info["pretrained_pt"] = str(pt); info["pretrained_pt_bytes"] = pt.stat().st_size
assert pt.stat().st_size > 10_000_000, "pretrained.pt 缺失或过小"
from resemblyzer import VoiceEncoder
enc = VoiceEncoder("cpu")
info["encoder_ok"] = True
info["embed_dims"] = len(enc.embed_utterance(numpy.zeros(16000, dtype=numpy.float32) + 0.1))
assert info["embed_dims"] == 256
print("CHECK-JSON " + json.dumps(info))
'@
$checkFile = Join-Path $env:TEMP 'voiceprint-check.py'
[IO.File]::WriteAllText($checkFile, $check, (New-Object System.Text.UTF8Encoding($false)))
& $BUILD_PY $checkFile
if ($LASTEXITCODE -ne 0) { Fail 'VoiceEncoder 离线构造校验失败' }
Remove-Item -LiteralPath $checkFile -Force

# ── 6. 打包（zip 根 = 组件根） ────────────────────────────────────────────
Write-Step '打包 voiceprint-0.5.0.zip'
$zip = Join-Path $outDir "voiceprint-$VERSION.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
& $tar -a -c -f $zip -C $stage .
if ($LASTEXITCODE -ne 0) { Fail "打包失败：$zip" }

# ── 7. fragment：out/packs/fragments/voiceprint.json ─────────────────────
Write-Step '写 fragments/voiceprint.json'
$sha = Sha $zip
$bytes = (Get-Item -LiteralPath $zip).Length
$relUrl = "https://github.com/rui08984-dot/dafeiyu-open/releases/download/v$VERSION/voiceprint-$VERSION.zip"
$fragment = @(
    [ordered]@{
        id = 'voiceprint'; name = '声纹（说话人向量）'; version = $VERSION
        extractTo = 'voiceprint'; requires = @('python')
        files = @([ordered]@{
            name = "voiceprint-$VERSION.zip"; dest = "voiceprint-$VERSION.zip"; extractTo = 'voiceprint'
            sha256 = $sha; sizeBytes = $bytes
            sources = @(
                [ordered]@{ url = $relUrl; priority = 1 },
                [ordered]@{ url = "https://gh-proxy.com/$relUrl"; priority = 2 },
                [ordered]@{ url = "https://ghproxy.net/$relUrl"; priority = 3 }
            )
        })
        config = [ordered]@{}
        services = @([ordered]@{
            id = 'voiceprint'; name = '声纹嵌入（说话人向量）'; port = 8020; order = 55
            startTimeoutMs = 30000; autoRestart = $true
            cmd = @('{python}', '{dir}/audio_common/voiceprint_server.py')
            cwd = '{dir}'
            env = [ordered]@{
                PYTHONPATH = '{dir}/site-packages;{pythonDir}/site-packages-base'
                PATH_PREPEND = '{pythonDir}'
            }
            health = [ordered]@{ url = 'http://127.0.0.1:8020/health'; timeoutMs = 1500 }
        })
        setup = ''
        sizeBytes = $bytes
        buildInfo = [ordered]@{ torchFrom = $torchFrom; torchSpec = $TorchSpec }
    }
)
$fragPath = Join-Path $outDir 'fragments\voiceprint.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($fragPath, ($fragment | ConvertTo-Json -Depth 30), $utf8NoBom)

Write-Host ''
Write-Host '=== 产物 ===' -ForegroundColor Green
Write-Host ("  voiceprint-$VERSION.zip  {0}MB  {1}" -f (MB $bytes), $sha)
Write-Host ("  stage 总大小（未压缩）   {0}MB" -f (MB ((Get-ChildItem -LiteralPath $stage -Recurse -File | Measure-Object Length -Sum).Sum)))
Write-Host "  fragment：$fragPath"
Write-Host "  torch 来源：$torchFrom"
