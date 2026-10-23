@echo off
REM _tools/install-sweep.bat - register the 2-hourly zombie/hygiene sweep
REM as a Windows Scheduled Task. Run once per clone (or after moving the repo).
setlocal
set "REPO=%~dp0.."
for %%I in ("%REPO%") do set "REPO=%%~fI"
schtasks /Create /TN "FPSWebTest-sweep" /SC HOURLY /MO 2 ^
  /TR "cmd /c \"\"%REPO%\_tools\sweep.bat\"\"" /F
if %ERRORLEVEL%==0 (
  echo installed: FPSWebTest-sweep runs every 2h ^(log: %%TEMP%%\fps_sweep.log^)
  echo remove with: schtasks /Delete /TN FPSWebTest-sweep /F
)
