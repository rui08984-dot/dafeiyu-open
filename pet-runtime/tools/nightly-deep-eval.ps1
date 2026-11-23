# nightly-deep-eval.ps1 —— 夜间深度评测（2026-11-22 用户拍板「做」）
#
# 每天 03:00 跑一次 `--deep`（15 条多步真机 + 恢复任务）。用户睡觉时机器空着，
# 正好用真机覆盖率换「早发现回归」。不 push、不改代码，只产出报告与日志。
#
# 退出码 = 评测退出码（门禁口径：--threshold 1 即零失败才算过）。
# 日志按天滚，保留最近 7 天。

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $root 'pet-runtime\.state'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 清 7 天前的夜间日志
Get-ChildItem $logDir -Filter 'nightly-deep-eval-*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
  Remove-Item -Force -ErrorAction SilentlyContinue

$log = Join-Path $logDir ('nightly-deep-eval-{0:yyyyMMdd}.log' -f (Get-Date))
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Write-Error '找不到 node（Get-Command node 为空）'; exit 1 }
$node = $nodeCmd.Source
$runner = Join-Path $root '_probe\agent-eval\runner.mjs'

"[{0:HH:mm:ss}] nightly deep eval start" -f (Get-Date) | Out-File -Append -Encoding utf8 $log
# 夜里没人用屏幕：不加 --quiet（需要前台的项照跑，覆盖率最高）
& $node $runner --deep --threshold 1 *>> $log
$code = $LASTEXITCODE
"[{0:HH:mm:ss}] nightly deep eval end exit={1}" -f (Get-Date), $code | Out-File -Append -Encoding utf8 $log
exit $code
