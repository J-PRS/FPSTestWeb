@echo off
rem Build the client and deploy dist/ to the "anabatic" Worker (static assets, unmetered).
setlocal
call :now TOTAL0
call :now T0
cd /d "%~dp0client" || exit /b 1
call npm run build || exit /b 1
call :elapsed %T0% BUILD_MS
call :now T0
call npx wrangler deploy || exit /b 1
call :elapsed %T0% DEPLOY_MS
call :elapsed %TOTAL0% TOTAL_MS
call :fmt %BUILD_MS% "build"
call :fmt %DEPLOY_MS% "deploy"
call :fmt %TOTAL_MS% "total"
exit /b 0

:now
rem %1 -> var name; stores %TIME% as centiseconds-since-midnight
for /f "tokens=1-4 delims=:,. " %%a in ("%TIME%") do (
  set /a "%1=(((1%%a-100)*60+(1%%b-100))*60+(1%%c-100))*100+(1%%d-100)"
)
exit /b 0

:elapsed
rem %1 start cs, %2 out var (ms); handles midnight rollover
call :now NOW_CS
set /a D=NOW_CS-%1
if %D% lss 0 set /a D+=8640000
set /a %2=D*10
exit /b 0

:fmt
rem %1 ms, %2 label
set MS=%1
set /a S=MS/1000
set /a FR=MS%%1000+1000
set FR=%FR:~1%
if %S% geq 60 (set /a M=S/60 & set /a R=S%%60 & echo %~2: %M%m %R%s) else echo %~2: %S%.%FR%s
exit /b 0
