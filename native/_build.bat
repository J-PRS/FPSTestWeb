@echo off
setlocal
pushd "%~dp0"

where hutch >nul 2>nul
if errorlevel 1 (
  echo Hutch CLI is not on PATH. Install/enable Hutch, then run this again.
  popd
  exit /b 1
)

call hutch run build
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%