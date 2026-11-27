@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "ELECTRON_RUN_AS_NODE=1"
echo 大肥鱼 · 组件管理（命令行）
echo 用法：安装组件.cmd status ^| install --all ^| install --id=voice-asr ^| remove --id=...
echo 图形入口：控制中心 → 组件（推荐）
echo.
"%ROOT%DaFeiyu.exe" "%ROOT%resources\app\js\components\cli.cjs" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%
