# scripts/start-local-memory-llm.ps1
#
# 本地记忆模型（llama.cpp server + MemOperator-4B）启动/停止脚本。
# ADR-014 轨道 2（2026-11-24 修订）：片段卡 / MemOS 抽取走本地；画像已回云端
# （本地 4B 把已有画像整份重抄、category 错分、one_off 漏标）；反思仍走云端。
#
# 为什么手动脚本而不是 services.json：
#   · llama-server 独占 ~5GiB 显存；宿主/门禁/游戏同时跑会 OOM，必须人工决定何时开；
#   · 本地不在时所有本地任务安静跳过（不回退云端），所以「没开」是合法状态。
#
# 2026-11-24 本机实测（RTX 8GB，全 GPU 卸载；别再凭感觉猜）：
#   · Daily（28K / q8_0）：短文本 52–58 t/s；8K prefill ≈2100 t/s；decode 31 t/s —— 唯一质量可用档。
#   · Batch（48K / turbo3 KV + YaRN）：8K decode ≈22 t/s，且**结构化 JSON 输出不可用**
#     （片段卡坏 JSON、事实抽取 `</think>` 复读；即使不开 YaRN 也坏）。
#   · 结论：片段卡 / 画像 / MemOS 抽取只用 Daily；Batch/Long 仅实验用途。
#
# 用法：
#   pwsh -NoProfile -File scripts/start-local-memory-llm.ps1            # = -Daily（默认；28K/q8，唯一质量可用档，长文请切块 ≤8–12K）
#   pwsh -NoProfile -File scripts/start-local-memory-llm.ps1 -Batch     # 长文批处理 48K（turbo3+YaRN）——仅实验，JSON 输出不可用
#   pwsh -NoProfile -File scripts/start-local-memory-llm.ps1 -Long      # 64K（turbo3+YaRN，实验）——仅实验，JSON 输出不可用
#   pwsh -NoProfile -File scripts/start-local-memory-llm.ps1 -Status    # 看健康/上下文/显存
#   pwsh -NoProfile -File scripts/start-local-memory-llm.ps1 -Stop      # 停掉监听端口的进程（并写 pause：不再自动拉起；-Daily 手动启动会删掉它）
#
# 三档的由来（2026-11-24 实测，别再凭感觉改）：
#   · Qwen3-4B 原生上下文 **32768**（HF 卡明确）；GGUF 里 context_length=40960 是预留位。
#     超过 32K 必须 YaRN，否则质量塌；llama-server b8671 还会把 -c **静默截到 n_ctx_train**，
#     所以 >32768 时必须配 --override-kv qwen3.context_length=int:<ctx>，启动后还要核对一次。
#   · KV 实测：q8_0=76.5KiB/token（32K=2.39GiB）、turbo3=28.1KiB、turbo2=19.1KiB。
#     本机 8GB（宿主占 2.3GB）：24K q8 剩 ~964MiB、32K q8 剩 ~352MiB（紧）、
#     64K 只有 turbo3 剩 ~1000MiB、128K 物理不可行。
#   · -ctk q5_1 在 CUDA 没有 FA 核（退 CPU/报错）；-ctk q4_0 质量崩（KLD 5.51 / PPL ×200）。
#     K 必须 ≥ q8_0 —— 脚本对这类参数**直接拒绝启动**，不靠人记。
#   · -fa on 必须；--swa 对 Qwen3 是 no-op；--context-shift 会静默丢最老内容（长文档禁用）。
#
# 可用环境变量覆盖（默认值见下）：
#   PET_LOCAL_LLM_EXE      默认 D:/llm/llama-cpp-turboquant/llama-server.exe
#   PET_LOCAL_LLM_MODEL    默认 D:/llm/models/MemOperator-4B.Q4_K_M.gguf
#   PET_LOCAL_LLM_CTX      覆盖当前档的上下文（仍受 1024..65536 与 KV 规则约束）
#   PET_LOCAL_LLM_NGL      默认 999（全 GPU；不够就 20/24 部分卸载）
#   PET_LOCAL_LLM_PORT     默认 11435
#   PET_LOCAL_LLM_THREADS  默认 8
#   PET_LOCAL_LLM_THREADS_BATCH 默认 8
#   PET_LOCAL_LLM_LOG_DIR  默认 D:/llm/logs

[CmdletBinding()]
param(
    [switch]$Daily,
    [switch]$Batch,
    [switch]$Long,
    [switch]$Stop,
    [switch]$Status,
    # 只打印将要执行的命令行并退出（不占显存、不启动服务；排查参数/档位用）
    [switch]$DryRun,
    [int]$Ctx = 0,
    [int]$Ngl = 0,
    [int]$Port = 0,
    # KV 类型覆盖（默认按档给；非法值拒绝启动，见 Assert-KvType）
    [string]$Ctk = '',
    [string]$Ctv = '',
    # 显存不足（游戏/渲染占用）时仍强制启动；默认 <5000MiB 直接跳过
    [switch]$Force,
    # -PrintArgs：不启动进程，把最终启动参数打印成一行 JSON 给 launcher 直接 spawn
    # （让 llama-server 成为 launcher 的**直接子进程**，跟随 launcher 生命周期 —— 2026-11-25 用户拍板）
    [switch]$PrintArgs
)

$ErrorActionPreference = 'Stop'

function EnvOr([string]$Name, $Default) {
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ($null -ne $v -and "$v".Trim() -ne '') { return $v }
    return $Default
}

$Exe     = EnvOr 'PET_LOCAL_LLM_EXE'     'D:/llm/llama-cpp-turboquant/llama-server.exe'
$Model   = EnvOr 'PET_LOCAL_LLM_MODEL'   'D:/llm/models/MemOperator-4B.Q4_K_M.gguf'
$LogDir  = EnvOr 'PET_LOCAL_LLM_LOG_DIR' 'D:/llm/logs'

# ── 手动暂停（pause 文件，2026-11-25 用户拍板）───────────────────────────
# 门禁/手动停掉模型后，launcher 的显存 watchdog 会在冷却期（10 分钟）后自动把它拉回来，
# 抢走显存。pause 文件就是「人说的话」：存在 = 不自动拉起、也不自动杀掉。
#   · -Stop 成功停掉 → 创建（"我停了，别再自己起来"）
#   · 真实启动（-Daily/-Batch/-Long 真正 spawn 前）→ 删除（手动启动 = 恢复自动管理）
#   · -PrintArgs 遇到 pause → 输出 {skip:true,reason:"paused-by-user"}（-Force 也不绕过）
$PauseFile = EnvOr 'PET_LOCAL_LLM_PAUSE_FILE' '<project-root>/pet-runtime/.state/local-llm.pause'

function Test-Pause { return (Test-Path -LiteralPath $PauseFile) }
function Set-Pause {
    try {
        $dir = Split-Path -Parent $PauseFile
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Set-Content -LiteralPath $PauseFile -Value ("paused at {0}" -f (Get-Date).ToString('o')) -Encoding utf8 -Force
        return $true
    } catch {
        Write-Host ("⚠️ 写 pause 文件失败：{0}（{1}）—— watchdog 仍会自动拉起" -f $PauseFile, $_.Exception.Message)
        return $false
    }
}
function Clear-Pause {
    if (-not (Test-Pause)) { return }
    try {
        Remove-Item -LiteralPath $PauseFile -Force
        Write-Host ("手动启动：已恢复自动管理（删除 {0}）" -f $PauseFile)
    } catch {
        Write-Host ("⚠️ 删除 pause 文件失败：{0}（{1}）" -f $PauseFile, $_.Exception.Message)
    }
}
if ($Ngl -le 0)  { $Ngl  = [int](EnvOr 'PET_LOCAL_LLM_NGL' 999) }
if ($Port -le 0) { $Port = [int](EnvOr 'PET_LOCAL_LLM_PORT' 11435) }
$Threads      = [int](EnvOr 'PET_LOCAL_LLM_THREADS' 8)
$ThreadsBatch = [int](EnvOr 'PET_LOCAL_LLM_THREADS_BATCH' 8)
$Alias        = 'MemOperator-4B'

$HealthUrl = "http://127.0.0.1:$Port/health"
$PropsUrl  = "http://127.0.0.1:$Port/props"
$ModelsUrl = "http://127.0.0.1:$Port/v1/models"

# ── 档位 ────────────────────────────────────────────────────────────────
# 默认档 = Daily（保持默认行为）：28K + q8_0 KV，留 ~964MiB 余量给宿主。
# 32K q8 只剩 ~352MiB，宿主一抖就掉 WDDM 共享内存，所以默认不再用 32K。
$ModeFlags = @()
if ($Daily) { $ModeFlags += 'Daily' }
if ($Batch) { $ModeFlags += 'Batch' }
if ($Long)  { $ModeFlags += 'Long' }
if ($ModeFlags.Count -gt 1) {
    throw ("拒绝启动：-Daily / -Batch / -Long 只能选一个（收到 {0}）" -f ($ModeFlags -join ' + '))
}
$Mode = if ($ModeFlags.Count -eq 1) { $ModeFlags[0] } else { 'Daily' }

switch ($Mode) {
    'Daily' { $defCtx = 28672; $defK = 'q8_0';   $defV = 'q8_0' }
    'Batch' { $defCtx = 49152; $defK = 'turbo3'; $defV = 'turbo3' }
    'Long'  { $defCtx = 65536; $defK = 'turbo3'; $defV = 'turbo3' }
}

if ($Ctx -le 0) { $Ctx = [int](EnvOr 'PET_LOCAL_LLM_CTX' $defCtx) }
$CtkEff = if ($Ctk.Trim()) { $Ctk.Trim().ToLower() } else { $defK }
$CtvEff = if ($Ctv.Trim()) { $Ctv.Trim().ToLower() } else { $defV }

# KV 合法集：q8_0/f16 两条永远安全；turbo3/turbo2 是本机 fork 的量化类型（需该 exe）。
# V 额外允许 q4_0（K 不行：KLD 5.51 / PPL ×200）。
$AllowedK = @('q8_0', 'f16', 'bf16', 'turbo3', 'turbo2')
$AllowedV = @('q8_0', 'q4_0', 'f16', 'bf16', 'turbo3', 'turbo2')
# 已知的坑：给出准确原因，而不是只说「不认识」。
$KvRejectReason = @{
    'q5_1' = 'CUDA 没有 q5_1 的 FA 核（会退 CPU 或直接报错）'
    'q5_0' = 'CUDA 没有 q5_0 的 FA 核'
    'q4_1' = 'q4_1 做 K 质量崩（KLD 5.51 / PPL ×200 量级）'
    'q4_k' = 'K 必须是 ≥ q8_0 的精度'
    'q3_k' = 'K 必须是 ≥ q8_0 的精度'
    'q2_k' = 'K 必须是 ≥ q8_0 的精度'
    'iq4_nl' = 'iq4_nl 做 K 没有 FA 核'
}

function Assert-KvType([string]$Which, [string]$Value, [string[]]$Allowed, [bool]$IsK) {
    if (-not $Value) { return }
    $v = $Value.ToLower()
    if ($Allowed -contains $v) { return }
    $why = $KvRejectReason[$v]
    if (-not $why) { $why = '不在允许集内' }
    if ($IsK -and $v -eq 'q4_0') { $why = 'q4_0 做 K 质量崩（KLD 5.51 / PPL ×200）—— K 必须 ≥ q8_0' }
    throw ("拒绝启动：-{0} {1} —— {2}。允许：{3}" -f $Which, $v, $why, ($Allowed -join ' / '))
}
Assert-KvType 'ctk' $CtkEff $AllowedK $true
Assert-KvType 'ctv' $CtvEff $AllowedV $false

if ($Ctx -lt 1024) {
    throw ("拒绝启动：-c {0} 太小（<1024）。默认档 28672，长文档 49152/65536" -f $Ctx)
}
if ($Ctx -gt 65536) {
    throw ("拒绝启动：-c {0} 超过 65536 —— 128K 在本机物理不可行（8GB 显存：64K turbo3 已只剩约 1000MiB）" -f $Ctx)
}

$UseTurbo = ($CtkEff -like 'turbo*') -or ($CtvEff -like 'turbo*')
$UseYarn = $Ctx -gt 32768
$RopeScale = if ($UseYarn) { [math]::Round($Ctx / 32768.0, 3) } else { 0 }

function Get-Health {
    try {
        $r = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 2 -UseBasicParsing
        return @{ ok = ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300); body = $r.Content }
    } catch {
        return @{ ok = $false; body = "$($_.Exception.Message)" }
    }
}

function Get-Json([string]$Url, [int]$TimeoutSec = 3) {
    try {
        return ((Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing).Content | ConvertFrom-Json)
    } catch { return $null }
}

# 实际生效的 n_ctx：先 /props，再 /v1/models。拿不到返回 0（不猜）。
# b8671 会把 -c 静默截到 n_ctx_train —— 这一步就是把「静默」变成可见。
function Get-ActualCtx {
    $props = Get-Json $PropsUrl
    if ($props) {
        if ($props.n_ctx) { return [int]$props.n_ctx }
        if ($props.default_generation_settings -and $props.default_generation_settings.n_ctx) {
            return [int]$props.default_generation_settings.n_ctx
        }
    }
    $models = Get-Json $ModelsUrl
    if ($models -and $models.data -and @($models.data).Count -gt 0) {
        $m = @($models.data)[0]
        foreach ($k in @('n_ctx', 'n_ctx_train')) {
            if ($m.meta -and $m.meta.$k) { return [int]$m.meta.$k }
            if ($m.$k) { return [int]$m.$k }
        }
    }
    return 0
}

function Write-CtxCheck([int]$Requested) {
    $actual = Get-ActualCtx
    if ($actual -le 0) {
        Write-Host '⚠️ 拿不到 n_ctx（/props 与 /v1/models 都没有），无法核对是否被截断'
        return
    }
    if ($actual -ne $Requested) {
        Write-Host ("⚠️ 上下文被截断：请求 {0} 实际 {1}（llama-server b8671 会静默截到 n_ctx_train；>32K 需 --override-kv qwen3.context_length=int:<ctx>）" -f $Requested, $actual)
    } else {
        Write-Host ("上下文核对 OK：n_ctx = {0}" -f $actual)
    }
}

function Get-ListeningPid {
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        return [int]$c.OwningProcess
    } catch { return 0 }
}

# -PrintArgs 的第一道闸：pause 文件存在就直接告诉 launcher「不要起」。
# 放在 -Status / -Stop 之前，是因为 pause 时不关心模型文件在不在（不需要 -Daily 那边的一堆校验）。
# -Force 只覆盖显存守门，**不覆盖** pause（人明确说了别开）。
if ($PrintArgs -and (Test-Pause)) {
    Write-Output (@{ skip = $true; reason = 'paused-by-user' } | ConvertTo-Json -Compress)
    exit 0
}

if ($Status) {
    $h = Get-Health
    Write-Host ("健康 {0}  {1}" -f $HealthUrl, $(if ($h.ok) { '✅ 在线' } else { '❌ 不可用' }))
    Write-Host ("手动暂停: {0}（pause 文件 {1}）" -f $(if (Test-Pause) { '是 —— 不会自动拉起' } else { '否' }), $PauseFile)
    if ($h.ok) {
        $actual = Get-ActualCtx
        Write-Host ("档位（本脚本默认）: {0}；实际 n_ctx: {1}" -f $Mode, $(if ($actual -gt 0) { $actual } else { '未知' }))
        try { (Invoke-WebRequest -Uri $ModelsUrl -TimeoutSec 3 -UseBasicParsing).Content | Write-Host } catch { }
    } else {
        Write-Host ("  详情: {0}" -f $h.body)
    }
    $pidOnPort = Get-ListeningPid
    Write-Host ("监听 PID: {0}" -f $(if ($pidOnPort) { $pidOnPort } else { '（无）' }))
    try { $mem = nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader; Write-Host "显存 used/free: $mem" } catch { }
    exit $(if ($h.ok) { 0 } else { 1 })
}

if ($Stop) {
    $pidOnPort = Get-ListeningPid
    if (-not $pidOnPort) {
        Write-Host "端口 $Port 没有监听进程（可能本来就没开）"
        [void](Set-Pause)
        Write-Host ("已暂停自动拉起（删除 {0} 或 -Daily 恢复）" -f $PauseFile)
        exit 0
    }
    $p = Get-Process -Id $pidOnPort -ErrorAction SilentlyContinue
    if (-not $p) {
        Write-Host "端口 $Port 的 PID $pidOnPort 已不存在（残留 socket）"
        [void](Set-Pause)
        Write-Host ("已暂停自动拉起（删除 {0} 或 -Daily 恢复）" -f $PauseFile)
        exit 0
    }
    if ($p.ProcessName -notmatch 'llama') {
        Write-Host "⚠️ 端口 $Port 的进程是 $($p.ProcessName)（PID $pidOnPort），不是 llama-server；不自动杀。"
        exit 2
    }
    Stop-Process -Id $pidOnPort -Force
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
        if (-not (Get-ListeningPid)) { break }
    }
    Write-Host "已停止 llama-server（PID $pidOnPort），端口 $Port 已释放"
    [void](Set-Pause)
    Write-Host ("已暂停自动拉起（删除 {0} 或 -Daily 恢复）" -f $PauseFile)
    exit 0
}

# ── 启动前检查 ──────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $Exe))   { throw "找不到 llama-server.exe：$Exe（可用 PET_LOCAL_LLM_EXE 覆盖）" }
if (-not (Test-Path -LiteralPath $Model)) { throw "找不到模型：$Model（可用 PET_LOCAL_LLM_MODEL 覆盖）" }
$modelBytes = (Get-Item -LiteralPath $Model).Length
if ($modelBytes -lt 2000000000) {
    throw ("模型只有 {0:N0} 字节（期望 ≈2.4GB）——下载未完成，先续传再启动" -f $modelBytes)
}

$existingPid = Get-ListeningPid
if ($existingPid) {
    $h = Get-Health
    if ($h.ok) {
        Write-Host "已在运行（PID $existingPid，$HealthUrl 在线），不重复启动"
        # 手动启动 = 恢复自动管理（即使这次是「已在跑」，用户意图也是「让它归 watchdog 管」）
        Clear-Pause
        # 已在跑的那份未必是本次请求的档：核对一次，避免「以为切了档其实没切」。
        Write-CtxCheck $Ctx
        exit 0
    }
    Write-Host "⚠️ 端口 $Port 已被 PID $existingPid 占用但 /health 不通；先 -Stop 再启动"
    exit 2
}

# 显存守门（2026-11-24）：Daily 档要 ~7GB；游戏/渲染占用时启动会挤到 WDDM 共享内存
# （表现为慢 10 倍，而不是 OOM）。默认 free <5000MiB 直接跳过并 exit 0（launcher 视为
# 「有意不启动」，不重试）；手动排查/强制可用 -Force。
# 阈值 5000：宿主 Live2D 常驻占 ~2.3GB 时 free≈5.7GB，仍可启动；开游戏后 free 通常 <2GB。
if (-not $Force -and -not $DryRun) {
    try {
        $freeRaw = (nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
        $freeMb = 0
        if ([int]::TryParse("$freeRaw".Trim(), [ref]$freeMb) -and $freeMb -gt 0 -and $freeMb -lt 5000) {
            Write-Host ("⚠️ 显存只剩 {0} MiB（<5000）——可能正在游戏/渲染；本次跳过启动（后台任务会按 local_down 跳过，不烧云）。要强制加 -Force" -f $freeMb)
            exit 0
        }
    } catch { /* 读不到显存就不拦（交给 llama-server 自己报 OOM） */ }
}

if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
$outLog = Join-Path $LogDir 'local-memory-llm.out.log'
$errLog = Join-Path $LogDir 'local-memory-llm.err.log'

# 参数：
#   · 每日档 28K + q8 KV + 小 batch（2048/512），留显存给宿主；
#   · 长文档 turbo3 KV + YaRN(scale=ctx/32768) + --override-kv（防静默截断）+ --no-context-shift（防丢最老内容）；
#   · 采样取「抽取类工程值」0.2 / 0.8 / 20 / min_p 0 / repeat 1.05（Qwen3 非思考档官方是 0.7/0.8/20）。
$llamaArgs = @(
    '-m', $Model,
    '-c', "$Ctx",
    '-ngl', "$Ngl",
    '-fa', 'on',
    '-ctk', $CtkEff,
    '-ctv', $CtvEff,
    '-b', '2048',
    '-ub', '512',
    '-t', "$Threads",
    '-tb', "$ThreadsBatch",
    '-np', '1',
    '--jinja',
    '--reasoning', 'off',
    '--temp', '0.2',
    '--top-p', '0.8',
    '--top-k', '20',
    '--min-p', '0',
    '--repeat-penalty', '1.05',
    '--repeat-last-n', '256'
)
if ($UseYarn) {
    $llamaArgs += @(
        '--rope-scaling', 'yarn',
        '--rope-scale', ("{0:0.###}" -f $RopeScale),
        '--yarn-orig-ctx', '32768',
        '--override-kv', ("qwen3.context_length=int:{0}" -f $Ctx),
        '--no-context-shift'
    )
}
$llamaArgs += @('-a', $Alias, '--host', '127.0.0.1', '--port', "$Port")

if ($Mode -ne 'Daily' -or $UseTurbo) {
    Write-Host '⚠️ 仅实验用途：Batch/Long 档（turbo3 KV + YaRN）会让结构化 JSON 输出复读/乱码，不要用于片段卡/画像/MemOS 抽取（Daily 28K/q8 才是唯一质量可用档）'
}
Write-Host ("启动本地记忆模型（档位 {0}）:" -f $Mode)
Write-Host ("  {0} {1}" -f $Exe, ($llamaArgs -join ' '))

# -PrintArgs（2026-11-25 用户拍板「随宿主启停」）：不 Start-Process，把最终参数打成一行 JSON。
# launcher 拿它**直接 spawn llama-server**，让模型成为 launcher 的直接子进程——
# launcher 退出时的 taskkill /T 会把它一起带走，不再出现「桌宠停了模型还占着 GPU」的孤儿。
# 显存守门在这里**重跑一次**（上面那段只拦真实启动；launcher 的自动启动决策也吃同一阈值）。
if ($PrintArgs) {
    $skip = $false; $why = ''
    try {
        $freeRaw2 = (nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
        $freeMb2 = 0
        if ([int]::TryParse("$freeRaw2".Trim(), [ref]$freeMb2) -and $freeMb2 -gt 0 -and $freeMb2 -lt 5000 -and -not $Force) {
            $skip = $true; $why = ("free={0}MiB<5000（可能游戏/渲染占用）" -f $freeMb2)
        }
    } catch { }
    $out = @{ exe = $Exe; args = $llamaArgs; skip = $skip; reason = $why }
    Write-Output ($out | ConvertTo-Json -Compress -Depth 3)
    exit 0
}

if ($DryRun) {
    Write-Host '（-DryRun：只打印命令行，未启动任何进程）'
    exit 0
}
# 真实启动 = 手动启动 = 恢复自动管理：清掉 pause，watchdog 才能重新管它。
Clear-Pause
$proc = Start-Process -FilePath $Exe -ArgumentList $llamaArgs -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
    -WindowStyle Hidden
Write-Host ("PID {0}，日志 {1} / {2}" -f $proc.Id, $outLog, $errLog)

# 冷加载（2.5GB 权重 + CUDA 上下文）30s 内正常，给 180s 上限
$deadline = (Get-Date).AddSeconds(180)
$ready = $false
while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) {
        Write-Host "❌ llama-server 已退出（exit $($proc.ExitCode)）。错误日志尾部："
        try { Get-Content -LiteralPath $errLog -Tail 40 | Write-Host } catch { }
        try { Get-Content -LiteralPath $outLog -Tail 40 | Write-Host } catch { }
        exit 1
    }
    if ((Get-Health).ok) { $ready = $true; break }
    Start-Sleep -Milliseconds 1000
}
if (-not $ready) {
    Write-Host "❌ 180s 内 /health 未就绪（PID $($proc.Id) 仍在？$(-not $proc.HasExited)）。显存不够时改用 -Ctx 24576 或 -Ngl 24。"
    exit 1
}

Write-Host ("✅ 本地记忆模型就绪：{0}（模型 {1}，请求上下文 {2}，ngl {3}，KV {4}/{5}）" -f $HealthUrl, $Alias, $Ctx, $Ngl, $CtkEff, $CtvEff)
# 健康检查第二段：/health 只说明「活着」，/props 才说明「上下文是多少」。
Write-CtxCheck $Ctx
try { $mem = nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader; Write-Host "显存 used/free: $mem" } catch { }
exit 0
