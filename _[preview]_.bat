@echo off

REM === Paths ===
set "PROJECT_DIR=C:\TEMP\_WEB\FPSWebTest"
set "CLIENT_DIR=%PROJECT_DIR%\client"

REM Only LOCAL binds block vite preview: listeners on Tailscale/VPN IPs
REM (tailscaled owns :5500 there and can't be killed) don't stop a
REM 0.0.0.0 bind, and killing foreign-IP owners loops forever.
echo Killing old process on port 5500...
set "TRIES=0"
:free5500
set "HELD=0"
for /f "tokens=2,5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr /r "0\.0\.0\.0:5500 127\.0\.0\.1:5500 \[::\]:5500"') do (
  set "HELD=1"
  taskkill /F /PID %%b >nul 2>&1
)
if "%HELD%"=="1" (
  set /a TRIES+=1
  if %TRIES% GEQ 15 (
    echo WARN: a process still owns :5500 on a local address after 15 tries - continuing anyway
    goto built
  )
  timeout /t 1 /nobreak >nul
  goto free5500
)

:built
echo Building client...
cd /d "%CLIENT_DIR%"
call npm run build || exit /b 1

echo Starting production preview on :5500 (dev stays on :5400)...
npm run preview -- --port 5500
