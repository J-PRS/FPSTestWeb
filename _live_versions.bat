@echo off
REM One-shot deploy audit: backend (OCI /health) + frontend (CF build.txt).
REM Exit code = worst of the two (0 ok, 1 drift, 2 unreachable).
setlocal
set "RC=0"

echo === server (OCI) ===
call "%~dp0_server_version.bat"
if errorlevel 2 (set "RC=2") else if errorlevel 1 (if %RC%==0 set "RC=1")

echo.
echo === client (anabatic.gg) ===
for /f "tokens=1" %%l in ('type "%~dp0client\dist\build.txt" 2^>nul') do set "LOCAL=%%l"
for /f "tokens=2" %%l in ('type "%~dp0client\dist\build.txt" 2^>nul') do set "LT=%%l"
for /f "usebackq tokens=1" %%r in (`powershell -NoProfile -Command "try {(irm -TimeoutSec 8 'https://anabatic.gg/build.txt') -split ' ' | select -f 1} catch {''}"`) do set "REMOTE=%%r"
for /f "usebackq tokens=1" %%r in (`powershell -NoProfile -Command "try {((irm -TimeoutSec 8 'https://anabatic.gg/build.txt') -split ' ')[1]} catch {''}"`) do set "RT=%%r"
echo.
if "%LOCAL%"=="" (echo   local  : ^<no dist build - run __BUILD.bat^>) else echo   local  : %LOCAL%  (built %LT%)
if "%REMOTE%"=="" (echo   remote : ^<unreachable or no stamp^> & if %RC%==0 set "RC=2" & goto :summary)
echo   remote : %REMOTE%  (built %RT%)
echo.
if "%LOCAL%"=="%REMOTE%" (echo   MATCH - site serves local dist & goto :summary)
if "%LOCAL%"=="" (echo   UNKNOWN - cannot compare without a local build & if %RC%==0 set "RC=1" & goto :summary)
echo   DRIFT - site serves a different dist than your last local build
echo          (if remote is newer: dist is stale, harmless - if local is newer: run _deploy_cf.bat)
if %RC%==0 set "RC=1"

:summary
echo.
echo   === %RC% (0 ok / 1 drift / 2 unreachable) ===
endlocal & exit /b %RC%
