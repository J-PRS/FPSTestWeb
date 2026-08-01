@echo off

REM === Paths ===
set "PROJECT_DIR=C:\TEMP\_WEB\FPSWebTest"
set "SERVER_DIR=%PROJECT_DIR%\server_bun"
set "CLIENT_DIR=%PROJECT_DIR%\client"
set "BUN_BIN=%USERPROFILE%\.bun\bin"

echo Killing old processes on ports 5300 and 8000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5300.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1

echo Starting server and client...

REM Try to use Windows Terminal with tabs if available
where wt.exe >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Using Windows Terminal with tabs...
    wt.exe powershell -NoExit -Command "$env:PATH = '%BUN_BIN%;' + $env:PATH; cd '%SERVER_DIR%'; bun run dev" ; new-tab powershell -NoExit -Command "cd '%CLIENT_DIR%'; npm run dev"
) else (
    echo Windows Terminal not found, using separate windows...
    powershell -Command "Start-Process powershell -ArgumentList '-NoExit', '-Command', '$env:PATH = ''%BUN_BIN%;'' + $env:PATH; cd ''%SERVER_DIR%''; bun run dev'"
    timeout /t 2 /nobreak >nul
    start powershell -NoExit -Command "cd '%CLIENT_DIR%'; npm run dev"
)

echo Both processes started.
