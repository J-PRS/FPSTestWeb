@echo off
echo Starting server and client...

REM Try to use Windows Terminal with tabs if available
where wt.exe >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Using Windows Terminal with tabs...
    REM Both server and client run in PowerShell windows
    wt.exe powershell -NoExit -Command "cd C:\TEMP\_WEB\FPSWebTest\server; npm run dev" ; new-tab powershell -NoExit -Command "cd C:\TEMP\_WEB\FPSWebTest\client; npm run dev"
) else (
    echo Windows Terminal not found, using separate windows...
    powershell -Command "Start-Process powershell -ArgumentList '-NoExit', '-Command', 'cd C:\TEMP\_WEB\FPSWebTest\server; npm run dev'"
    timeout /t 2 /nobreak >nul
    start powershell -NoExit -Command "cd C:\TEMP\_WEB\FPSWebTest\client; npm run dev"
)

echo Both processes started.
