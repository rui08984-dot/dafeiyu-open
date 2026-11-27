@echo off
rem Keep this file ASCII-only + CRLF. cmd.exe parses batch files with the OEM code page;
rem UTF-8 Chinese echo lines merge with the next line and break the launcher (v0.4.0 bug,
rem found in 0.5.0 acceptance: 'RUn_AS_nODE' / '"DaFeiyu.exe"' are not recognized).
rem The node CLI prints its own Chinese banner/usage, so no banner is needed here.
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "ELECTROn_RUn_AS_nODE=1"
"%ROOT%DaFeiyu.exe" "%ROOT%resources\app\js\components\cli.cjs" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%
