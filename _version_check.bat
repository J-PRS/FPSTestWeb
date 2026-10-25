@echo off
REM Compare local HEAD vs the deployed box's /health build stamp.
setlocal
for /f "tokens=*" %%h in ('git rev-parse --short HEAD') do set "LOCAL=%%h"
for /f "usebackq delims=" %%j in (`powershell -NoProfile -Command "try {(irm -TimeoutSec 8 'https://play.jprice.app/health').build} catch {''}"`) do set "REMOTE=%%j"
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "try {(irm -TimeoutSec 8 'https://play.jprice.app/health').version} catch {''}"`) do set "VER=%%v"
echo.
echo   local  : %LOCAL%
if "%REMOTE%"=="" (echo   remote : ^<unreachable or no stamp^> & endlocal & exit /b 2)
echo   remote : %REMOTE%  (version %VER%)
echo.
if /i "%LOCAL%"=="%REMOTE%" (echo   MATCH - box runs HEAD) else (echo   DRIFT - box is behind/different)
endlocal
