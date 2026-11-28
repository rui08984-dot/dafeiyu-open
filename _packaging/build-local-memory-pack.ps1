#Requires -Version 5.1
<#
.SYNOPSIS
    local-memory 组件（本地 4B 记忆模型）包构建脚本（v0.5.0）。

.DESCRIPTION
    与 build-component-packs.ps1 的分工：local-memory **不打 zip、不碰 manifest.fragments.json**。
    它只产出/校验一个独立 fragment：_packaging/out/packs/fragments/local-memory.json，
    内容是「外部模型直链 + 真实 sha256/size + 复用 memory 组件 llama-server 的 service 定义」。

    模型：MemOperator-4B（MemTensor/MemOperator-4B 的 Qwen3-4B 微调，Apache-2.0）。
    上游 safetensors 仓库（MemTensor/MemOperator-4B）已从 HF 下架（404），
    公开可下的是 mradermacher/MemOperator-4B-GGUF 的静态量化（同 Apache-2.0）。
    本脚本不做替代型号：本机 D:/llm/models/MemOperator-4B.Q4_K_M.gguf 的
    SHA256 已与 HF 仓库 LFS OID 逐位核对一致（255580fb…44a6f），清单即用真实值。

    llama-server 复用 memory 组件的 CPU 版（components/memory/bin/llama-server.exe，
    llama.cpp b12809 mainline），不在本组件重复打包（requires=["memory"]）。

    注意：本文件 UTF-8 无 BOM，与 build-component-packs.ps1 同风格；
    含中文字面量，请用 pwsh 7 运行（powershell 5.1 会把无 BOM UTF-8 按 GBK 读）。

.PARAMETER ModelPath
    本地已有 GGUF 的路径。不给时按 out/packs-cache → D:/llm/models（本机 dev 兼容）查找。

.PARAMETER Download
    找不到模型时从清单源下载到 <out>/packs-cache/（约 2.33GB，走 hf-mirror）。

.PARAMETER WhatIfFragment
    只打印将写入的 fragment JSON，不写文件。

.EXAMPLE
    pwsh -NoProfile -File _packaging/build-local-memory-pack.ps1
#>
[CmdletBinding()]
param(
    [string]$ModelPath = '',
    [switch]$Download,
    [switch]$WhatIfFragment
)
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$outPacks = Join-Path $here 'out\packs'
$fragDir = Join-Path $outPacks 'fragments'
$cache = Join-Path $here 'out\packs-cache'
$GGUF_NAME = 'MemOperator-4B.Q4_K_M.gguf'
$COMPONENT_VERSION = '0.5.0'
$MODEL_ALIAS = 'MemOperator-4B'

# HF 仓库（mradermacher/MemOperator-4B-GGUF）发布的 LFS sha256 —— 与本机文件逐位一致。
# 若换模型/换量化，必须重新计算并用 /props 核对架构，别沿用这行。
$EXPECTED_SHA = '255580fb5c305ca296a1e21530a8efd727a42619352c4dba03944c54e9d44a6f'
$EXPECTED_SIZE = 2497280768
$SOURCES = @(
    'https://hf-mirror.com/mradermacher/MemOperator-4B-GGUF/resolve/main/MemOperator-4B.Q4_K_M.gguf',
    'https://huggingface.co/mradermacher/MemOperator-4B-GGUF/resolve/main/MemOperator-4B.Q4_K_M.gguf'
)

function Write-Step([string]$t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan }
function Fail([string]$t) { throw $t }
function Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function MB([long]$n) { [math]::Round($n / 1MB, 1) }

# ── 1. 模型文件就位 ──────────────────────────────────────────────────────
Write-Step '模型文件（MemOperator-4B Q4_K_M，Apache-2.0）'
# v0.5.1（P0-3）：默认不再写死本机路径。查找顺序：
#   1) 显式 -ModelPath（最高优先）
#   2) out/packs-cache/（构建缓存，公开树自前的标准位置）
#   3) 兼容本机 dev：D:/llm/models/...（存在就用，不重复下载）
# 都没有时：加 -Download 才下载；否则给出可执行的两条路。
$legacyDevModel = 'D:/llm/models/MemOperator-4B.Q4_K_M.gguf'
if (-not $ModelPath) {
    $cacheModel = Join-Path $cache $GGUF_NAME
    if (Test-Path -LiteralPath $cacheModel) { $ModelPath = $cacheModel }
    elseif (Test-Path -LiteralPath $legacyDevModel) { $ModelPath = $legacyDevModel }
    else { $ModelPath = $cacheModel }
}
if (-not (Test-Path -LiteralPath $ModelPath)) {
    if (-not $Download) {
        Fail "找不到 $ModelPath ；加 -Download 从 hf-mirror 下载到 packs-cache，或用 -ModelPath 指向已有 GGUF"
    }
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $ModelPath = Join-Path $cache $GGUF_NAME
    if (-not (Test-Path -LiteralPath $ModelPath)) {
        $ok = $false
        foreach ($u in $SOURCES) {
            Write-Host "  下载 $u"
            & curl.exe -L --retry 2 --max-time 3600 -o "$ModelPath.part" $u
            if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath "$ModelPath.part") -and (Get-Item -LiteralPath "$ModelPath.part").Length -ge $EXPECTED_SIZE) {
                Move-Item -LiteralPath "$ModelPath.part" -Destination $ModelPath -Force
                $ok = $true; break
            }
            try { Remove-Item -LiteralPath "$ModelPath.part" -Force } catch { $null = $_ }
        }
        if (-not $ok) { Fail '所有下载源都失败（hf-mirror / huggingface）' }
    }
}
$modelSize = (Get-Item -LiteralPath $ModelPath).Length
$modelSha = Sha $ModelPath
Write-Host ("  {0}" -f $ModelPath)
Write-Host ("  size = {0} bytes ({1} MB)  sha256 = {2}" -f $modelSize, (MB $modelSize), $modelSha)

# 与 HF 发布值核对：不一致就是「同名不同文件」（改版/损坏/被换），拒绝出清单。
if ($modelSha -ne $EXPECTED_SHA) {
    Fail ("模型 sha256 与 HF 仓库发布值不一致：`n  期望 {0}`n  实得 {1}`n（文件被改版/损坏？重新核对来源后同步更新本脚本的 EXPECTED_* 与 fragment）" -f $EXPECTED_SHA, $modelSha)
}
if ($modelSize -ne $EXPECTED_SIZE) {
    Fail ("模型 size 与 HF 仓库发布值不一致：期望 {0}，实得 {1}" -f $EXPECTED_SIZE, $modelSize)
}

# ── 2. 组 fragment ──────────────────────────────────────────────────────
# services 复用 memory 组件的 CPU llama-server（b12809 mainline，help 已核对
# -fa/-ctk/-ctv/--jinja/--reasoning/--temp/--top-k/--min-p/--repeat-* 全部支持）。
# 参数对齐 dev 的 Daily 档（28672 + q8_0 KV，唯一质量可用档），两处按目标机调整：
#   · -t 4/-tb 8（目标机普遍 ≤8 核，dev 默认 8/8 是 28 核机）；
#   · 不带 -ngl（CPU 推理无 GPU 卸载）；-fa on 在 CPU 上同样成立（mainline 已核）。
# 上游 fork 的 turbo3/turbo2 KV 是本机私有量化类型，mainline 不认 —— 故意不带。
$fragment = @(
    [ordered]@{
        id = 'local-memory'
        name = '本地记忆模型（llama.cpp · MemOperator-4B）'
        version = $COMPONENT_VERSION
        extractTo = 'local-memory'
        requires = @('memory')   # 复用 {components}/memory/bin/llama-server.exe，不再打一份
        files = @(
            [ordered]@{
                name = $GGUF_NAME
                dest = "local-memory/models/$GGUF_NAME"
                sha256 = $modelSha
                sizeBytes = $modelSize
                sources = @(
                    [ordered]@{ url = $SOURCES[0]; priority = 1 },
                    [ordered]@{ url = $SOURCES[1]; priority = 2 }
                )
            }
        )
        config = [ordered]@{ 'cost.local_memory' = $true }
        services = @(
            [ordered]@{
                id = 'local-memory'
                name = '本地记忆模型（llama.cpp）'
                port = 11435
                order = 30
                startTimeoutMs = 120000   # CPU 冷加载 2.4GB 权重 + 28K KV，给足 2 分钟
                autoRestart = $true
                cmd = @(
                    '{components}/memory/bin/llama-server.exe',
                    '-m', "{dir}/models/$GGUF_NAME",
                    '-a', $MODEL_ALIAS,
                    '-c', '28672',
                    '-fa', 'on',
                    '-ctk', 'q8_0', '-ctv', 'q8_0',
                    '-b', '2048', '-ub', '512',
                    '-t', '4', '-tb', '8',
                    '-np', '1',
                    '--jinja',
                    '--reasoning', 'off',
                    '--temp', '0.2', '--top-p', '0.8', '--top-k', '20', '--min-p', '0',
                    '--repeat-penalty', '1.05', '--repeat-last-n', '256',
                    '--host', '127.0.0.1', '--port', '11435'
                )
                cwd = '{dir}'
                env = [ordered]@{}
                health = [ordered]@{ url = 'http://127.0.0.1:11435/health'; timeoutMs = 2000 }
            }
        )
        setup = 'js/components/setup/local-memory.js'
        sizeBytes = $modelSize
    }
)

# 保持「数组」形状（与 out/packs/manifest.fragments.json 一致，方便直接拼）
# -InputObject 而不是管道：PS 5.1 里单元素数组走管道会被展开成对象。
$json = ConvertTo-Json -InputObject ([object[]]$fragment) -Depth 30
if ($WhatIfFragment) {
    Write-Host '（-WhatIfFragment：只打印，不写文件）'
    Write-Output $json
    exit 0
}

# ── 3. 写 fragment（UTF-8 无 BOM；只写自己的文件，不碰 manifest.fragments.json）──
Write-Step '写 fragment'
New-Item -ItemType Directory -Force -Path $fragDir | Out-Null
$fragPath = Join-Path $fragDir 'local-memory.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($fragPath, $json, $utf8NoBom)
Write-Host ("  已写 {0}" -f $fragPath)

# ── 4. 自检：JSON 可解析 + 哈希/size 与真实文件一致 ────────────────────────
$check = Get-Content -LiteralPath $fragPath -Raw -Encoding UTF8 | ConvertFrom-Json
$f0 = $check[0].files[0]
if ($f0.sha256 -ne $modelSha -or $f0.sizeBytes -ne $modelSize) { Fail 'fragment 自检失败：哈希/size 与真实文件不一致' }
if ($check[0].services[0].health.url -ne 'http://127.0.0.1:11435/health') { Fail 'fragment 自检失败：health URL 不对' }
Write-Host '  自检 OK（sha256 / sizeBytes / health）'

Write-Host ''
Write-Host '=== 产物 ===' -ForegroundColor Green
Write-Host ("  fragment: {0}" -f $fragPath)
Write-Host ("  模型（外部下载，不打 zip）: {0}  {1}MB  {2}" -f $GGUF_NAME, (MB $modelSize), $modelSha)
Write-Host '  合入主清单（可选，本脚本不做）：node _packaging/build-components-manifest.cjs --fragments <合并后文件>'
