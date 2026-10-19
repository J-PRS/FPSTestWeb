@echo off

REM === Paths ===
set "PROJECT_DIR=C:\TEMP\_WEB\FPSWebTest"
set "SERVER_DIR=%PROJECT_DIR%\server_bun"
set "BUN_BIN=%USERPROFILE%\.bun\bin"

echo Killing old process on port 8000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1

echo Starting server...
set "PATH=%BUN_BIN%;%PATH%"
REM Demo capture lands in demos_out\server — the authoritative half of
REM the dual-demo desync oracle (client .demo + this = wire-truth diff).
set "FPS_DEMO=%PROJECT_DIR%\demos_out\server"
set "FPS_ADMIN_TOKEN=devdemo"
cd /d "%SERVER_DIR%"
bun run dev
