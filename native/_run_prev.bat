@echo off
setlocal
set "APP=%~dp0build\dev-win-x64\hello-world-dev\bin\launcher.exe"

if not exist "%APP%" (
  echo Native dev build not found. Run _build.bat first.
  exit /b 1
)

rem Preview build on :5500 (vite preview) - same local game server.
set "CLIENT_URL=http://localhost:5500/?server=ws%%3A%%2F%%2Flocalhost%%3A8000%%2Fws"

rem Server UDP lane port (FPS_UDP_PORT on the box) - docs say 9898.
set "UDP_TARGET_PORT=9898"

pushd "%~dp0"
start "" /wait "%APP%"
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
