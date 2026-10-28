@echo off
setlocal
cd /d "%~dp0"

where bash >nul 2>nul
if errorlevel 1 (
  echo Git Bash was not found on PATH. Install Git for Windows or add its bin folder to PATH.
  exit /b 1
)

bash -c "FPS_DEPLOY_HOST=opc@92.5.61.55 bash _tools/deploy_server.sh"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo.
  echo OCI deploy failed with exit code %RESULT%.
)
exit /b %RESULT%