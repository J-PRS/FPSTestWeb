@echo off
REM === Paths ===
set "PROJECT_DIR=C:\TEMP\_WEB\FPSWebTest"
set "SERVER_DIR=%PROJECT_DIR%\server_bun"
set "BUN_BIN=%USERPROFILE%\.bun\bin"

echo Killing old server processes...
REM Free the canonical port (child bun src/server.ts).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
REM Kill dev-watch parents (they are NOT on :8000 — they listen on :8001,
REM so the port-kill above misses them; they'd respawn a child on the
REM still-busy :8000 and spin a bind-fail loop).
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { \$_.CommandLine -match 'dev-watch\.ts' -and \$_.CommandLine -match 'FPSWebTest' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
REM Also reap any orphaned bun src/server.ts that survived.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { \$_.CommandLine -match 'src[\\\\/]server\.ts' -and \$_.CommandLine -match 'FPSWebTest' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

REM Give the OS a moment to release the port (TIME_WAIT / handle cleanup).
timeout /t 2 /nobreak >nul

echo Starting server...
set "PATH=%BUN_BIN%;%PATH%"
REM Demo capture lands in demos_out\server - the authoritative half of
REM the dual-demo desync oracle (client .demo + this = wire-truth diff).
set "FPS_DEMO=%PROJECT_DIR%\demos_out\server"
set "FPS_ADMIN_TOKEN=devdemo"
cd /d "%SERVER_DIR%"
bun run dev