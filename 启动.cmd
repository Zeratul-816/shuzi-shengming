@echo off
setlocal
chcp 65001 >nul
title ShuZi ShengMing - Digital Life
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

if exist "node_modules\zod" goto RUN
echo First run - installing dependencies ...
call npm install --no-fund --no-audit
if errorlevel 1 goto NODEPS

:RUN
node src/cli/main.ts
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" goto FAILED
exit /b 0

:FAILED
echo.
echo  [Exited with code %EXITCODE%]
echo  Tip: use the DEBUG launcher to see per-turn intent/emotion/latency.
echo.
pause
exit /b %EXITCODE%

:NONODE
echo.
echo  [ERROR] Node.js not found in PATH.
echo  Install Node.js 22.6 or newer from https://nodejs.org, then run this again.
echo.
pause
exit /b 1

:NODEPS
echo.
echo  [ERROR] npm install failed. Check your network and retry.
echo.
pause
exit /b 1
