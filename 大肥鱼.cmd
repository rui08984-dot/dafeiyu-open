@echo off
chcp 65001 >nul
setlocal

rem ===== DaFeiYu single entry =====
rem Double-click = start. Subcommands: start|stop|restart|status|doctor|logs|plugins|cowatch|quiet|help
rem Dispatch only; backend logic lives in pet-runtime/tools:
rem   launch-my-neuro.mjs  orchestration (4 services + host window)
rem   petctl.mjs           control console
rem   kill-all-pet.ps1     stop by port
rem UTF-8 + chcp 65001. No tasklist/find/timeout: they can be shadowed by unix tools.
rem ================================

set "ROOT=%~dp0"
set "PET=%ROOT%pet-runtime"
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=start"

if /i "%ACTION%"=="start"   goto :start
if /i "%ACTION%"=="restart" goto :restart
if /i "%ACTION%"=="stop"    goto :stop
if /i "%ACTION%"=="kill"    goto :stop
if /i "%ACTION%"=="status"  goto :petctl
if /i "%ACTION%"=="doctor"  goto :petctl
if /i "%ACTION%"=="logs"    goto :petctl
if /i "%ACTION%"=="quiet"   goto :petctl
if /i "%ACTION%"=="verify"  goto :petctl
if /i "%ACTION%"=="probe"   goto :petctl
if /i "%ACTION%"=="emotion" goto :petctl
if /i "%ACTION%"=="plugins" goto :petctl
if /i "%ACTION%"=="cowatch" goto :petctl
if /i "%ACTION%"=="help"    goto :help
if /i "%ACTION%"=="-h"      goto :help
echo 不认识的命令: %ACTION%
goto :help

:help
echo.
echo   大肥鱼 · 用法
echo.
echo     大肥鱼                启动（等同 start）
echo     大肥鱼 start          启动
echo     大肥鱼 restart        重启
echo     大肥鱼 stop           全部停止
echo     大肥鱼 status         看状态
echo     大肥鱼 doctor         体检（出问题先跑这个）
echo     大肥鱼 logs 60        看日志
echo     大肥鱼 plugins        插件与工具清单
echo     大肥鱼 cowatch        一起看：对白 + 画面摘要
echo     大肥鱼 quiet on       省钱模式（不主动开口/不调视觉）
echo     大肥鱼 quiet off      恢复正常
echo.
exit /b 0

:stop
echo 正在停止大肥鱼...
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%PET%\tools\kill-all-pet.ps1"
exit /b 0

:restart
call "%~f0" stop
ping -n 4 127.0.0.1 >nul
goto :start

:start
powershell -NoProfile -Command "if (Get-Process electron -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if %errorlevel%==1 (
    echo 大肥鱼已经在跑了。要重启请用: 大肥鱼 restart
    ping -n 4 127.0.0.1 >nul
    exit /b 0
)
echo 正在启动大肥鱼（首次约 30-50 秒，含语音/识别/一起看/记忆四个服务）...
start "" /min cmd /c "cd /d ""%PET%"" && node tools\launch-my-neuro.mjs"
ping -n 26 127.0.0.1 >nul
echo.
echo 启动完成。看状态: 大肥鱼 status
ping -n 5 127.0.0.1 >nul
exit /b 0

:petctl
chcp 65001 >nul
shift
cd /d "%PET%"
node tools\petctl.mjs %ACTION% %1 %2 %3
exit /b %errorlevel%
