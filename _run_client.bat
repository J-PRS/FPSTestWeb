@echo off

REM === Paths ===
set "PROJECT_DIR=C:\TEMP\_WEB\FPSWebTest"
set "CLIENT_DIR=%PROJECT_DIR%\client"

echo Killing old process on port 5400...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5400.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1

echo Starting client...
cd /d "%CLIENT_DIR%"
npm run dev
