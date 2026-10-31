@echo off
setlocal
set "APP=%~dp0build\dev-win-x64\hello-world-dev\bin\launcher.exe"

if not exist "%APP%" (
  echo Native dev build not found. Run _build.bat first.
  exit /b 1
)

rem Server UDP lane port (FPS_UDP_PORT on the box) - docs say 9898.
set "UDP_TARGET_PORT=9898"

pushd "%~dp0"
start "" /wait "%APP%"
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
