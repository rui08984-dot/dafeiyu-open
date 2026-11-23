# register-and-log.ps1 —— 带 transcript 日志的 MSIX 注册包装
# 为什么要它：register-identity-admin.ps1 失败时窗口会关掉，看不到原因。
# 这个包装把全程写进 %TEMP%\msix-register.log，失败也能回看。
# 用法（管理员）：pwsh -NoProfile -File "<project-root>\_packaging\identity\register-and-log.ps1"

$log = Join-Path $env:TEMP 'msix-register.log'
$ErrorActionPreference = 'Continue'

Start-Transcript -Path $log -Force | Out-Null
try {
    Write-Output ('[wrap] 开始 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    Write-Output ('[wrap] 是否管理员: ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
    & (Join-Path $PSScriptRoot 'register-identity-admin.ps1') `
        -PackageDir (Join-Path (Split-Path -Parent $PSScriptRoot) 'out\electron-builder\win-unpacked') `
        -ManifestPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'out\identity\stage\AppxManifest.xml')
    Write-Output ('[wrap] 子脚本结束, LASTEXITCODE=' + $LASTEXITCODE)
} catch {
    Write-Output ('[wrap] 异常: ' + $_.Exception.Message)
    Write-Output ('[wrap] 位置: ' + $_.InvocationInfo.PositionMessage)
} finally {
    Write-Output ('[wrap] 结束 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    Stop-Transcript | Out-Null
    Write-Output ('日志: ' + $log)
    Read-Host '按回车关闭'
}
