@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 需要 Node.js 20+：https://nodejs.org/
  echo     装好后重新运行本文件。
  pause
  exit /b 1
)

echo 大肥鱼 · 首启向导
echo 提示：API key 请先放到环境变量（例如 set COMAD_BUNNY_API_KEY=...），
echo       向导不会回显、也不会把 key 写进任何日志。
echo.

node scripts\install-wizard.mjs %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo 向导未全部通过（退出码 %RC%）。修好上面的红项后可重新运行本文件。
  pause
)
exit /b %RC%
