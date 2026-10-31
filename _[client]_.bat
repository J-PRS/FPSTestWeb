@echo off

REM === Paths ===
set "PROJECT_DIR=C:\TEMP\_WEB\FPSWebTest"
set "CLIENT_DIR=%PROJECT_DIR%\client"

echo Reaping stale dev processes...
node "%PROJECT_DIR%\_tools\reap.mjs" --kill

echo Killing old process on port 5400...
REM Kill EVERY listener row (IPv4+IPv6 are separate rows; the old for-loop
REM only killed the first PID), then wait until the port is actually free —
REM a killed node's socket releases asynchronously, so a fixed 1s sleep
REM races and vite falls through to 5401.
:free5400
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5400.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
netstat -ano | findstr ":5400.*LISTENING" >nul && (timeout /t 1 /nobreak >nul & goto free5400)

echo Starting client (no auto-reload - Ctrl+R when you want new code)...
cd /d "%CLIENT_DIR%"
npm run dev:noreload