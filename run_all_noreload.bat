@echo off

REM === Paths ===
set "PROJECT_DIR=C:\TEMP\_WEB\FPSWebTest"
set "SERVER_DIR=%PROJECT_DIR%\server_bun"
set "CLIENT_DIR=%PROJECT_DIR%\client"
set "BUN_BIN=%USERPROFILE%\.bun\bin"

echo Reaping stale dev processes...
node "%PROJECT_DIR%\_tools\reap.mjs" --kill

echo Killing old server processes...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { \$_.CommandLine -match 'dev-watch\.ts' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { \$_.CommandLine -match 'src[\\\\/]server\.ts' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo Killing old client processes...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5400.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1

timeout /t 2 /nobreak >nul

echo Starting server and noreload client...

REM Try to use Windows Terminal with tabs if available
where wt.exe >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Using Windows Terminal with tabs...
    wt.exe powershell -NoExit -Command "$env:PATH = '%BUN_BIN%;' + $env:PATH; cd '%SERVER_DIR%'; bun run dev" ; new-tab powershell -NoExit -Command "cd '%CLIENT_DIR%'; npm run dev:noreload"
) else (
    echo Windows Terminal not found, using separate windows...
    powershell -Command "Start-Process powershell -ArgumentList '-NoExit', '-Command', '$env:PATH = ''%BUN_BIN%;'' + $env:PATH; cd ''%SERVER_DIR%''; bun run dev'"
    timeout /t 2 /nobreak >nul
    start powershell -NoExit -Command "cd '%CLIENT_DIR%'; npm run dev:noreload"
)

echo Both processes started (client in noreload mode - Ctrl+R when you want new code).