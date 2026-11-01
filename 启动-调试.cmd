@echo off
setlocal
chcp 65001 >nul
title ShuZi ShengMing - DEBUG
cd /d "%~dp0"

rem DEBUG mode: prints intent / drive / emotion / recalled count / latency each turn
set DH_DEBUG=1

where node >nul 2>nul
if errorlevel 1 goto NONODE

if exist "node_modules\zod" goto RUN
echo First run - installing dependencies ...
call npm install --no-fund --no-audit

:RUN
node src/cli/main.ts
if errorlevel 1 pause
exit /b 0

:NONODE
echo  [ERROR] Node.js not found in PATH.
pause
exit /b 1
