@echo off
REM Clean-bundle deploy: like _surge_deploy but strips assets that can't
REM ship publicly (Unity Asset Store class_* rigs + their anim bakes,
REM and any T2-derived payload that leaked into public/). The server
REM must run with FPS_PUBLIC_BETA=1 so _t2 map specs drop out of the
REM catalog too. Missing class rigs fall back to mannequin/knight at
REM runtime. Usage:
REM   _clean_deploy.bat [tunnel-host] [domain]
setlocal
set "PROJECT_DIR=%~dp0"
set "CLIENT_DIR=%PROJECT_DIR%client"
set "TUNNEL_HOST=%~1"
set "DOMAIN=%~2"
if "%DOMAIN%"=="" set "DOMAIN=testfps.surge.sh"

echo Writing server.json (server="%TUNNEL_HOST%")...
> "%CLIENT_DIR%\public\server.json" echo { "server": "%TUNNEL_HOST%" }
powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()" > "%CLIENT_DIR%\public\version.txt"

cd /d "%CLIENT_DIR%"
call npm run build || (echo Build failed & pause & exit /b 1)

REM Strip rights-restricted assets from the bundle about to be uploaded.
del /q "dist\assets\models\class_*.glb" 2>nul
for %%m in (cybersoldier scifisoldier vexa polyart) do del /q "dist\assets\anims\%%m.glb" 2>nul
if exist "dist\maps\t2" rmdir /s /q "dist\maps\t2"

call npx surge dist %DOMAIN% || (echo Surge deploy failed & pause & exit /b 1)

echo.
echo Deployed CLEAN bundle to https://%DOMAIN%
if not "%TUNNEL_HOST%"=="" echo Backend: %TUNNEL_HOST% (run the server with FPS_PUBLIC_BETA=1)
endlocal
