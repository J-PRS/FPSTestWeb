@echo off

REM === Paths ===
set "PROJECT_DIR=C:\TEMP\_WEB\FPSWebTest"
set "CLIENT_DIR=%PROJECT_DIR%\client"

echo Reaping stale dev processes...
node "%PROJECT_DIR%\_tools\reap.mjs" --kill

echo Killing old process on port 5400...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5400.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1

timeout /t 1 /nobreak >nul

echo Starting client...
cd /d "%CLIENT_DIR%"
npm run dev