@echo off
REM Compare local HEAD vs the deployed box's /health build stamp.
REM "DRIFT" only counts if server_bun/ or shared/ changed since the
REM deployed commit — docs/client commits don't ship to the box.
setlocal
for /f "tokens=*" %%h in ('git rev-parse --short HEAD') do set "LOCAL=%%h"
for /f "usebackq delims=" %%j in (`powershell -NoProfile -Command "try {(irm -TimeoutSec 8 'https://play.jprice.app/health').build} catch {''}"`) do set "REMOTE=%%j"
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "try {(irm -TimeoutSec 8 'https://play.jprice.app/health').version} catch {''}"`) do set "VER=%%v"
echo.
echo   local  : %LOCAL%
if "%REMOTE%"=="" (echo   remote : ^<unreachable or no stamp^> & endlocal & exit /b 2)
echo   remote : %REMOTE%  (version %VER%)
echo.
if /i "%LOCAL%"=="%REMOTE%" (echo   MATCH - box runs HEAD & endlocal & exit /b 0)
REM Hash differs — is it a server-side diff or just docs/client?
git cat-file -e %REMOTE% 2>nul
if errorlevel 1 (echo   DRIFT - box runs a commit not in local history & endlocal & exit /b 1)
git diff --quiet %REMOTE%..HEAD -- server_bun shared 2>nul
if errorlevel 1 (
  echo   DRIFT - server_bun/shared changed since %REMOTE% - redeploy
  for /f "delims=" %%c in ('git log --oneline %REMOTE%..HEAD -- server_bun shared') do echo          %%c
  endlocal & exit /b 1
)
echo   EQUIV - no server_bun/shared changes since %REMOTE% - box is current
endlocal
