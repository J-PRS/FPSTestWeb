@echo off
REM devup.bat - clean-slate dev stack for Windows.
REM   1. reap abandoned FPSWebTest dev processes (older than 6h)
REM   2. free the canonical ports (:5400 / :8000)
REM   3. launch game server + client in two windows
REM
REM This is run_all.bat plus process hygiene: run_all only frees the two
REM canonical ports, so old vite/bun instances squatting other ports
REM (5416, 5199, ...) survive and steal CPU from soaks and tests.
REM Reaper: _tools\reap.mjs (dry-run by default, LSP/MCP never touched).
setlocal
set "PROJECT_DIR=C:\TEMP\_WEB\FPSWebTest"
set "SERVER_DIR=%PROJECT_DIR%\server_bun"
set "CLIENT_DIR=%PROJECT_DIR%\client"
set "BUN_BIN=%USERPROFILE%\.bun\bin"
cd /d "%PROJECT_DIR%"

echo [devup] reaping dev processes older than 6h...
node _tools\reap.mjs --kill

echo [devup] freeing ports 5400 and 8000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5400.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1

echo [devup] starting game server on :8000 ...
start "KRIBES-server" /D "%SERVER_DIR%" cmd /k "set PATH=%BUN_BIN%;%PATH% && bun run dev"
timeout /t 3 /nobreak >nul

echo [devup] starting client on :5400 ...
start "KRIBES-client" /D "%CLIENT_DIR%" cmd /k "npm run dev"

echo [devup] stack launching in two windows. Close them to stop.
echo [devup] no-reap launcher: run_all.bat
endlocal
