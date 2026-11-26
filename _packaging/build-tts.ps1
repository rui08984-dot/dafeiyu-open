#Requires -Version 5.1
<#
.SYNOPSIS
    构建随包语音：把 edge-tts/tts_server.py 冻成单文件 exe（约 11MB）。

.DESCRIPTION
    为什么单独一个脚本：
      * PyInstaller 依赖本机的 Python 环境；直接用系统 Python 会把 pandas/scipy
        之类无关大包带进来（实测体积失控）。这里固定用一个干净 venv（out\tts-venv），
        只装 aiohttp + edge-tts + pyinstaller。
      * 产物 out\tts\dafeiyu-tts.exe 会被 build-installer.ps1 的 Prepare-ExtraResources
        复制到 resources/tts/；宿主启动时由 js/services/local-tts.js 拉起（端口 9883）。

    需要联网（pip 装依赖 + edge-tts 运行时访问微软语音端点）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\build-tts.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$venv = Join-Path $here 'out\tts-venv'
$vpy = Join-Path $venv 'Scripts\python.exe'
$script = [IO.Path]::GetFullPath((Join-Path $here '..\edge-tts\tts_server.py'))
$dist = Join-Path $here 'out\tts'
$work = Join-Path $here 'out\tts-build'

if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "找不到 TTS 服务脚本：$script"
}

if (-not (Test-Path -LiteralPath $vpy -PathType Leaf)) {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
    if (-not $py) { throw '找不到 Python（py / python 都不在 PATH）' }
    Write-Host "==> 创建干净 venv：$venv"
    & $py.Source -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "创建 venv 失败，退出码 $LASTEXITCODE" }
}

Write-Host '==> 安装依赖（aiohttp / edge-tts / pyinstaller）'
& $vpy -m pip install --disable-pip-version-check --no-cache-dir -q 'aiohttp>=3.9' 'edge-tts>=6.1' pyinstaller
if ($LASTEXITCODE -ne 0) { throw "pip install 失败，退出码 $LASTEXITCODE" }

Write-Host '==> PyInstaller 冻结（onefile）'
& $vpy -m PyInstaller --onefile --name dafeiyu-tts `
    --distpath $dist --workpath $work --specpath $work `
    --clean --noconfirm --log-level=WARN $script
if ($LASTEXITCODE -ne 0) { throw "PyInstaller 失败，退出码 $LASTEXITCODE" }

$exe = Join-Path $dist 'dafeiyu-tts.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "构建返回 0 但没有产物：$exe" }
$mb = [math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 2)
Write-Host ''
Write-Host "[成功] $exe（$mb MB）" -ForegroundColor Green
Write-Host '提示：用 _packaging/build-installer.ps1 -Nsis 重新打包即可随包。'
