#Requires -Version 5.1
<#
.SYNOPSIS
    构建大肥鱼 v0.4.0 组件包（python / voice-asr / cowatch / memory / lumen）。

.DESCRIPTION
    输出：_packaging/out/packs/<id>-0.4.0.zip + manifest.fragments.json
    大模型不重复打包：ASR/嵌入/LumenAct 用国内镜像直链（hf-mirror / ModelScope），
    只有「Python 运行时 + 依赖 + 代码 + CPU llama-server」由我们发。

    为什么用 uv：它的 managed CPython 是独立可搬运的；pip --target 装到独立目录，
    靠 PYTHONPATH 拼，不依赖目标机 Python/venv（安装版机器上什么都没有）。
#>
[CmdletBinding()]
param(
    [switch]$SkipVoiceprint
)
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$root = [IO.Path]::GetFullPath((Join-Path $here '..'))
$outDir = Join-Path $here 'out\packs'
$stageRoot = Join-Path $outDir 'stage'
$cache = Join-Path $here 'out\packs-cache'
$uvCmd = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uvCmd) { throw '找不到 uv：请先 pip install uv，或把 uv.exe 所在目录加进 PATH' }
$uv = $uvCmd.Source
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$BUILD_PY = ''   # 由复制出来的独立 Python 赋值；所有 pip --target 都用它
$index = 'https://mirrors.aliyun.com/pypi/simple/'

if (-not (Test-Path -LiteralPath $uv)) { throw "找不到 uv：$uv" }
if (-not (Test-Path -LiteralPath $tar)) { throw "找不到 bsdtar：$tar" }
New-Item -ItemType Directory -Force -Path $outDir, $stageRoot, $cache | Out-Null

function Write-Step([string]$t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan }
function Fail([string]$t) { throw $t }
function Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function MB([long]$n) { [math]::Round($n / 1MB, 1) }
function ZipDir([string]$stage, [string]$zipName) {
    $zip = Join-Path $outDir $zipName
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    # zip 根 = 组件根（不带顶层目录），安装器解压到 components/<id> 后路径才对
    & $tar -a -c -f $zip -C $stage .
    if ($LASTEXITCODE -ne 0) { Fail "打包失败：$zipName" }
    return $zip
}
function UvInstall([string]$target, [string[]]$pkgs) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    & $uv pip install --python $BUILD_PY --target $target --index-url $index @pkgs
    if ($LASTEXITCODE -ne 0) { Fail "pip install 失败：$($pkgs -join ' ')" }
}
function FileEntry([string]$name, [string]$dest, [string]$zip, [string]$extractTo) {
    return [ordered]@{
        name = $name; dest = $dest; extractTo = $extractTo
        sha256 = (Sha $zip); sizeBytes = (Get-Item -LiteralPath $zip).Length
        sources = @(
            [ordered]@{ url = "https://github.com/rui08984-dot/dafeiyu-open/releases/download/v0.4.0/$name"; priority = 1 },
            [ordered]@{ url = "https://ghproxy.net/https://github.com/rui08984-dot/dafeiyu-open/releases/download/v0.4.0/$name"; priority = 2 }
        )
    }
}
function ModelEntry([string]$name, [string]$dest, [string]$localPath, $sources) {
    if (-not (Test-Path -LiteralPath $localPath)) { Fail "缺本地模型：$localPath" }
    return [ordered]@{
        name = $name; dest = $dest
        sha256 = (Sha $localPath); sizeBytes = (Get-Item -LiteralPath $localPath).Length
        sources = $sources
    }
}

# ── 1. Python 运行时 ────────────────────────────────────────────────────
Write-Step 'Python 3.13.3 独立运行时'
& $uv python install 3.13.3
$managed = Join-Path $env:APPDATA 'uv\python\cpython-3.13.3-windows-x86_64-none'
if (-not (Test-Path -LiteralPath (Join-Path $managed 'python.exe'))) {
    $found = (& $uv python find 3.13.3 2>$null | Select-Object -First 1)
    if ($found) { $managed = Split-Path -Parent ([string]$found) }
}
if (-not (Test-Path -LiteralPath (Join-Path $managed 'python.exe'))) { Fail "找不到 uv 的 3.13.3 运行时（$managed）" }
$pyStage = Join-Path $stageRoot 'python'
if (Test-Path -LiteralPath $pyStage) { Remove-Item -LiteralPath $pyStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $pyStage | Out-Null
Copy-Item -Path (Join-Path $managed '*') -Destination $pyStage -Recurse -Force
$BUILD_PY = Join-Path $pyStage 'python.exe'
& $BUILD_PY -c "import sys; print('python-ok', sys.version.split()[0])" | Out-Null
if ($LASTEXITCODE -ne 0) { Fail '复制后的 Python 跑不起来' }
UvInstall (Join-Path $pyStage 'site-packages-base') @('numpy', 'scipy', 'pypinyin')
$zipPython = ZipDir $pyStage 'python-0.4.0.zip'
Write-Host "python-0.4.0.zip  $(MB (Get-Item $zipPython).Length)MB"

# ── 2. voice-asr ────────────────────────────────────────────────────────
Write-Step 'voice-asr（sherpa-onnx + SenseVoice）'
$asrStage = Join-Path $stageRoot 'voice-asr'
if (Test-Path -LiteralPath $asrStage) { Remove-Item -LiteralPath $asrStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $asrStage 'asr'), (Join-Path $asrStage 'models\silero'), (Join-Path $asrStage 'audio_common') | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'asr\asr_server.py') -Destination (Join-Path $asrStage 'asr') -Force
Copy-Item -LiteralPath (Join-Path $root 'asr\README.md') -Destination (Join-Path $asrStage 'asr') -Force
Get-ChildItem -LiteralPath (Join-Path $root 'audio_common') -Filter '*.py' -File | Copy-Item -Destination (Join-Path $asrStage 'audio_common') -Force
$silero = Join-Path $HOME '.dsh\speech-to-text\sensevoice\models\silero\silero_vad.onnx'
if (-not (Test-Path -LiteralPath $silero)) { Fail "缺 silero：$silero" }
Copy-Item -LiteralPath $silero -Destination (Join-Path $asrStage 'models\silero\silero_vad.onnx') -Force
UvInstall (Join-Path $asrStage 'site-packages') @('aiohttp', 'sherpa-onnx', 'soundfile')
$zipAsr = ZipDir $asrStage 'voice-asr-0.4.0.zip'
Write-Host "voice-asr-0.4.0.zip  $(MB (Get-Item $zipAsr).Length)MB"

# ── 3. cowatch ──────────────────────────────────────────────────────────
Write-Step 'cowatch（一起看：音频回环）'
$cowStage = Join-Path $stageRoot 'cowatch'
if (Test-Path -LiteralPath $cowStage) { Remove-Item -LiteralPath $cowStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $cowStage 'audio-loop'), (Join-Path $cowStage 'audio_common') | Out-Null
Get-ChildItem -LiteralPath (Join-Path $root 'audio-loop') -Filter '*.py' -File | Copy-Item -Destination (Join-Path $cowStage 'audio-loop') -Force
Get-ChildItem -LiteralPath (Join-Path $root 'audio_common') -Filter '*.py' -File | Copy-Item -Destination (Join-Path $cowStage 'audio_common') -Force
UvInstall (Join-Path $cowStage 'site-packages') @('soundcard')
$zipCow = ZipDir $cowStage 'cowatch-0.4.0.zip'
Write-Host "cowatch-0.4.0.zip  $(MB (Get-Item $zipCow).Length)MB"

# ── 4. memory ───────────────────────────────────────────────────────────
Write-Step 'memory（MemOS + Qdrant 本地 + CPU llama-server）'
$memStage = Join-Path $stageRoot 'memory'
if (Test-Path -LiteralPath $memStage) { Remove-Item -LiteralPath $memStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $memStage 'bin'), (Join-Path $memStage 'config') | Out-Null
# 4a. MemOS 子树（排除 data/__pycache__）
$memosSrc = Join-Path $root '_incoming\my-neuro\plugins-dlc\memos'
$memosDst = Join-Path $memStage 'memos'
New-Item -ItemType Directory -Force -Path $memosDst | Out-Null
& robocopy.exe $memosSrc $memosDst /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /XD data __pycache__ scripts /XF memos_config.json memos_config.json.bak* *.pyc | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "robocopy memos 失败：$LASTEXITCODE" }
# 4b. memos 依赖
$memosReq = Join-Path $memosSrc 'memos_system\requirements.txt'
UvInstall (Join-Path $memStage 'site-packages') @('-r', $memosReq)
# 4c. llama.cpp CPU（b12809）
$llamaZip = Join-Path $cache 'llama-b12809-bin-win-cpu-x64.zip'
if (-not (Test-Path -LiteralPath $llamaZip) -or (Get-Item -LiteralPath $llamaZip).Length -lt 1000000) {
    $llamaUrl = 'https://github.com/ggml-org/llama.cpp/releases/download/b12809/llama-b12809-bin-win-cpu-x64.zip'
    $ok = $false
    foreach ($u in @($llamaUrl, ('https://gh-proxy.com/' + $llamaUrl), ('https://ghproxy.net/' + $llamaUrl))) {
        Write-Host "  下载 llama.cpp：$u"
        & curl.exe -L --retry 2 --max-time 600 -o $llamaZip $u
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $llamaZip) -and (Get-Item -LiteralPath $llamaZip).Length -gt 1000000) { $ok = $true; break }
        try { Remove-Item -LiteralPath $llamaZip -Force } catch { $null = $_ }
    }
    if (-not $ok) { Fail '下载 llama.cpp CPU 失败（直连与镜像都失败）' }
}
$llamaTmp = Join-Path $cache 'llama-cpu'
if (Test-Path -LiteralPath $llamaTmp) { Remove-Item -LiteralPath $llamaTmp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $llamaTmp | Out-Null
& $tar -xf $llamaZip -C $llamaTmp
$llamaBin = Get-ChildItem -LiteralPath $llamaTmp -Recurse -Filter 'llama-server.exe' -File | Select-Object -First 1
if (-not $llamaBin) { Fail 'llama zip 里没有 llama-server.exe' }
Copy-Item -LiteralPath $llamaBin.FullName -Destination (Join-Path $memStage 'bin\llama-server.exe') -Force
Get-ChildItem -LiteralPath $llamaBin.DirectoryName -Filter '*.dll' -File | Copy-Item -Destination (Join-Path $memStage 'bin') -Force
# 4d. memos_config.json（llm 留空，安装时 setup 写用户 key）
& $BUILD_PY (Join-Path $here 'build-memos-config.py') (Join-Path $memStage 'memos\memos_system\config\memos_config.json')
if ($LASTEXITCODE -ne 0) { Fail '生成 memos_config.json 失败' }
$leakFiles = Get-ChildItem -LiteralPath (Join-Path $memStage 'memos') -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 2097152 } | ForEach-Object {
    try { if (Select-String -LiteralPath $_.FullName -Pattern 'sk-[A-Za-z0-9]{20,}' -Quiet) { $_.FullName } } catch { }
}
if ($leakFiles) { Fail ("memory 组件里发现疑似真实 key，构建中止：`n  " + (($leakFiles | Select-Object -First 5) -join "`n  ")) }
$zipMem = ZipDir $memStage 'memory-0.4.0.zip'
Write-Host "memory-0.4.0.zip  $(MB (Get-Item $zipMem).Length)MB"

# ── 5. lumen ────────────────────────────────────────────────────────────
Write-Step 'lumen（LumenAct 语义选择器）'
$lumStage = Join-Path $stageRoot 'lumen'
if (Test-Path -LiteralPath $lumStage) { Remove-Item -LiteralPath $lumStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $lumStage 'tools'), (Join-Path $lumStage 'models'), (Join-Path $lumStage 'assets') | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'pet-runtime\tools\lumen-semantic-server.py') -Destination (Join-Path $lumStage 'tools') -Force
# selector.onnx / tokenizer.json 走外部下载（清单里的 LumenAct 源），不重复塞进 zip
Copy-Item -LiteralPath (Join-Path $root '_research\lumenact\assets\semantic-config.json') -Destination (Join-Path $lumStage 'assets') -Force
UvInstall (Join-Path $lumStage 'site-packages') @('onnxruntime', 'transformers')
$zipLum = ZipDir $lumStage 'lumen-0.4.0.zip'
Write-Host "lumen-0.4.0.zip  $(MB (Get-Item $zipLum).Length)MB"

# ── 6. 外部模型（不打包，仅清单 + 哈希）────────────────────────────────
Write-Step '外部模型哈希（ASR / 嵌入 / LumenAct）'
$senseModel = Join-Path $HOME '.dsh\speech-to-text\sensevoice\models\sensevoice-onnx\model.int8.onnx'
$senseTokens = Join-Path $HOME '.dsh\speech-to-text\sensevoice\models\sensevoice-onnx\tokens.txt'
$embedModel = Join-Path $cache 'Qwen3-Embedding-0.6B-Q8_0.official.gguf'
if (-not (Test-Path -LiteralPath $embedModel)) {
    Write-Host '  下载官方 Qwen3-Embedding GGUF（ModelScope）'
    & curl.exe -L --retry 2 --max-time 900 -o $embedModel 'https://modelscope.cn/models/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/master/Qwen3-Embedding-0.6B-Q8_0.gguf'
    if ($LASTEXITCODE -ne 0) { Fail '下载官方嵌入模型失败' }
}
$lumenModel = Join-Path $root '_research\lumenact\models\selector.onnx'
$lumenTok = Join-Path $root '_research\lumenact\models\tokenizer.json'

$mSense = ModelEntry 'model.int8.onnx' 'voice-asr/models/sensevoice-onnx/model.int8.onnx' $senseModel @(
    [ordered]@{ url = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx'; priority = 1 }
)
$mTokens = ModelEntry 'tokens.txt' 'voice-asr/models/sensevoice-onnx/tokens.txt' $senseTokens @(
    [ordered]@{ url = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt'; priority = 1 }
)
$mEmbed = ModelEntry 'Qwen3-Embedding-0.6B-Q8_0.gguf' 'memory/models/Qwen3-Embedding-0.6B-Q8_0.gguf' $embedModel @(
    [ordered]@{ url = 'https://modelscope.cn/models/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/master/Qwen3-Embedding-0.6B-Q8_0.gguf'; priority = 1 },
    [ordered]@{ url = 'https://hf-mirror.com/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf'; priority = 2 }
)
$mLumen = ModelEntry 'selector.onnx' 'lumen/models/selector.onnx' $lumenModel @(
    [ordered]@{ url = 'https://hf-mirror.com/AaBbcoder/LumenAct/resolve/df8126a2a854735227ec81b7f12ab62d49a6d989/models/semantic/selector.onnx'; priority = 1 }
)
$mLumenTok = ModelEntry 'tokenizer.json' 'lumen/models/tokenizer.json' $lumenTok @(
    [ordered]@{ url = 'https://hf-mirror.com/AaBbcoder/LumenAct/resolve/df8126a2a854735227ec81b7f12ab62d49a6d989/models/semantic/tokenizer/tokenizer.json'; priority = 1 }
)

# ── 7. manifest.fragments.json ──────────────────────────────────────────
Write-Step '写 manifest.fragments.json'
$pyEntry = FileEntry 'python-0.4.0.zip' 'python-0.4.0.zip' $zipPython 'python'
$asrEntry = FileEntry 'voice-asr-0.4.0.zip' 'voice-asr-0.4.0.zip' $zipAsr 'voice-asr'
$cowEntry = FileEntry 'cowatch-0.4.0.zip' 'cowatch-0.4.0.zip' $zipCow 'cowatch'
$memEntry = FileEntry 'memory-0.4.0.zip' 'memory-0.4.0.zip' $zipMem 'memory'
$lumEntry = FileEntry 'lumen-0.4.0.zip' 'lumen-0.4.0.zip' $zipLum 'lumen'

$components = @(
    [ordered]@{
        id = 'python'; name = 'Python 运行时（服务共用）'; version = '0.4.0'; extractTo = 'python'; requires = @()
        files = @($pyEntry); config = [ordered]@{}; services = @(); setup = ''
    },
    [ordered]@{
        id = 'voice-asr'; name = '按住说话（SenseVoice ASR）'; version = '0.4.0'; extractTo = 'voice-asr'; requires = @('python')
        files = @($asrEntry, $mSense, $mTokens)
        config = [ordered]@{ 'asr.enabled' = $true }
        services = @([ordered]@{
            id = 'asr'; name = 'SenseVoice ASR'; port = 1000; order = 40; startTimeoutMs = 45000; autoRestart = $true
            cmd = @('{python}', '{dir}/asr/asr_server.py', '--port', '1000', '--model-dir', '{dir}/models')
            cwd = '{dir}'; env = [ordered]@{ PYTHONPATH = '{dir}/site-packages;{pythonDir}/site-packages-base'; PATH_PREPEND = '{pythonDir}' }
            health = [ordered]@{ url = 'http://127.0.0.1:1000/health'; timeoutMs = 1500 }
        })
        setup = ''
    },
    [ordered]@{
        id = 'cowatch'; name = '一起看（系统声音回环）'; version = '0.4.0'; extractTo = 'cowatch'; requires = @('python')
        files = @($cowEntry); config = [ordered]@{}; setup = ''
        services = @([ordered]@{
            id = 'cowatch'; name = '一起看耳朵'; port = 1001; order = 50; startTimeoutMs = 25000; autoRestart = $true
            cmd = @('{python}', '{dir}/audio-loop/audio_loop_server.py', '--port', '1001')
            cwd = '{dir}'; env = [ordered]@{ PYTHONPATH = '{dir}/site-packages;{pythonDir}/site-packages-base;{dir}'; PATH_PREPEND = '{pythonDir}' }
            health = $null
        })
    },
    [ordered]@{
        id = 'memory'; name = '长期记忆（MemOS + Qdrant + 嵌入）'; version = '0.4.0'; extractTo = 'memory'; requires = @('python')
        files = @($memEntry, $mEmbed)
        config = [ordered]@{ 'memos.enabled' = $true; 'memos.api_url' = 'http://127.0.0.1:8003'; 'cost.local_memory' = $false }
        services = @(
            [ordered]@{
                id = 'embed'; name = '嵌入服务（llama.cpp）'; port = 8090; order = 10; startTimeoutMs = 120000; autoRestart = $true
                cmd = @('{dir}/bin/llama-server.exe', '-m', '{dir}/models/Qwen3-Embedding-0.6B-Q8_0.gguf', '--embedding', '--pooling', 'last', '-c', '2048', '-b', '1024', '--host', '127.0.0.1', '--port', '8090', '-t', '4')
                cwd = '{dir}'; env = [ordered]@{}; health = [ordered]@{ url = 'http://127.0.0.1:8090/health'; timeoutMs = 2000 }
            },
            [ordered]@{
                id = 'memos'; name = 'MemOS 记忆后端'; port = 8003; order = 20; startTimeoutMs = 90000; autoRestart = $true
                cmd = @('{python}', '{dir}/memos/memos_system/api/memos_api_server_v2.py')
                cwd = '{dir}/memos/memos_system'; env = [ordered]@{ PYTHONPATH = '{dir}/site-packages;{pythonDir}/site-packages-base'; PATH_PREPEND = '{pythonDir}' }
                health = [ordered]@{ url = 'http://127.0.0.1:8003/health'; timeoutMs = 2000 }
            }
        )
        setup = 'js/components/setup/memory.js'
    },
    [ordered]@{
        id = 'lumen'; name = '语义表演（LumenAct）'; version = '0.4.0'; extractTo = 'lumen'; requires = @('python')
        files = @($lumEntry, $mLumen, $mLumenTok); config = [ordered]@{}; setup = ''
        services = @([ordered]@{
            id = 'semantic'; name = 'LumenAct 语义选择器'; port = 8120; order = 60; startTimeoutMs = 90000; autoRestart = $true
            cmd = @('{python}', '{dir}/tools/lumen-semantic-server.py', '--port', '8120')
            cwd = '{dir}'; env = [ordered]@{
                LUMENACT_MODELS = '{dir}/models'; LUMENACT_CFG = '{dir}/assets/semantic-config.json'
                PYTHONPATH = '{dir}/site-packages;{pythonDir}/site-packages-base'; PATH_PREPEND = '{pythonDir}'
            }
            health = [ordered]@{ url = 'http://127.0.0.1:8120/health'; timeoutMs = 2000 }
        })
    }
)
$fragPath = Join-Path $outDir 'manifest.fragments.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($fragPath, ($components | ConvertTo-Json -Depth 30), $utf8NoBom)

Write-Host ''
Write-Host '=== 产物 ===' -ForegroundColor Green
foreach ($z in @($zipPython, $zipAsr, $zipCow, $zipMem, $zipLum)) { Write-Host ("  {0}  {1}MB  {2}" -f (Split-Path -Leaf $z), (MB (Get-Item $z).Length), (Sha $z)) }
Write-Host "  清单：$fragPath"
Write-Host '外部模型（清单里，不进 zip）：'
Write-Host ("  SenseVoice int8  {0}MB  {1}" -f (MB $mSense.sizeBytes), $mSense.sha256)
Write-Host ("  Qwen3-Embedding  {0}MB  {1}" -f (MB $mEmbed.sizeBytes), $mEmbed.sha256)
Write-Host ("  LumenAct onnx    {0}MB  {1}" -f (MB $mLumen.sizeBytes), $mLumen.sha256)
