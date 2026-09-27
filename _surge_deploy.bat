@echo off
REM Deploy client to surge. Usage:
REM   _surge_deploy.bat [tunnel-host] [domain]
REM Example: _surge_deploy.bat abc-123.trycloudflare.com testfps.surge.sh
REM No args = empty server (offline mode) on testfps.surge.sh

setlocal
set "PROJECT_DIR=%~dp0"
set "CLIENT_DIR=%PROJECT_DIR%client"
set "TUNNEL_HOST=%~1"
set "DOMAIN=%~2"
if "%DOMAIN%"=="" set "DOMAIN=testfps.surge.sh"

echo Writing server.json (server="%TUNNEL_HOST%")...
> "%CLIENT_DIR%\public\server.json" echo { "server": "%TUNNEL_HOST%" }

REM Deploy stamp — clients poll this to auto-reload on a new version
powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()" > "%CLIENT_DIR%\public\version.txt"

cd /d "%CLIENT_DIR%"
call npm run build || (echo Build failed & pause & exit /b 1)

call npx surge dist %DOMAIN% || (echo Surge deploy failed & pause & exit /b 1)

echo.
echo Deployed to https://%DOMAIN%
if not "%TUNNEL_HOST%"=="" echo Backend: %TUNNEL_HOST%
endlocal
