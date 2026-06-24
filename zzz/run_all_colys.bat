@echo off
echo Starting Colyseus server and client...

REM Try to use Windows Terminal with tabs if available
where wt.exe >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Using Windows Terminal with tabs...
    wt.exe powershell -NoExit -Command "cd C:\TEMP\_WEB\FPSWebTest\server_colyseus; npm start" ; new-tab powershell -NoExit -Command "cd C:\TEMP\_WEB\FPSWebTest\client; npm run dev"
) else (
    echo Windows Terminal not found, using separate windows...
    start "Colyseus Server" powershell -NoExit -Command "cd C:\TEMP\_WEB\FPSWebTest\server_colyseus; npm start"
    timeout /t 3 /nobreak >nul
    start "Client" powershell -NoExit -Command "cd C:\TEMP\_WEB\FPSWebTest\client; npm run dev"
)

echo Both processes started.
