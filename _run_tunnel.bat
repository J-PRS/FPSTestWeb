@echo off
REM Cloudflare quick tunnel -> local game server (port 8000).
REM Prints the public https URL; deploy the client against it with:
REM   _surge_deploy.bat <host>.trycloudflare.com

setlocal EnableDelayedExpansion
set "LOG=%TEMP%\fps_tunnel.log"

REM C:\Windows\System32\cloudflared.exe is a 0-byte stub on this machine that
REM shadows PATH - use the real install explicitly.
set "CLOUDFLARED=C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist "%CLOUDFLARED%" set "CLOUDFLARED=cloudflared"

"%CLOUDFLARED%" --version >nul 2>&1
if errorlevel 1 (
  echo cloudflared not working. Install: winget install cloudflare.cloudflared
  pause
  exit /b 1
)

netstat -ano | findstr ":8000.*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo WARNING: nothing listening on port 8000 - start _run_server.bat first
  echo or the tunnel will point at nothing.
  echo.
)

echo Starting tunnel to http://localhost:8000 ...
echo.

REM Run cloudflared with output tee'd to console AND log (output must stay
REM visible for review; the log feeds the URL parser below).
del "%LOG%" 2>nul
start "cloudflared" cmd /k "powershell -NoProfile -Command ""& '%CLOUDFLARED%' tunnel --url http://localhost:8000 2>&1 | Tee-Object -FilePath '%LOG%'"""

set "URL="
for /l %%i in (1,1,60) do (
  timeout /t 1 /nobreak >nul
  for /f "delims=" %%u in ('powershell -NoProfile -Command "if (Test-Path '%LOG%') { $m = [regex]::Match((Get-Content '%LOG%' -Raw), 'https://[a-z0-9-]+\.trycloudflare\.com'); if ($m.Success) { $m.Value } }"') do set "URL=%%u"
  if defined URL goto :got
)
echo Timed out waiting for tunnel URL. Log:
type "%LOG%" 2>nul
pause
exit /b 1

:got
if "%URL%"=="" (
  echo Tunnel URL parsed empty. Log:
  type "%LOG%" 2>nul
  pause
  exit /b 1
)
set "HOST=%URL:https://=%"
echo.
echo ============================================
echo  Tunnel up:  %URL%
echo  Host:       %HOST%
echo.
echo  Deploy client against it:
echo    _surge_deploy.bat %HOST%
echo ============================================
REM Persist the resolved URL next to this script so it survives clipboard/log loss.
> "%~dp0_tunnel_url.txt" echo %URL%
echo (saved to _tunnel_url.txt)
echo %HOST%
set "SHORT=%HOST:.trycloudflare.com=%"
echo %SHORT%
echo %HOST%| clip
echo (host copied to clipboard)
echo.
echo Cloudflared is running in a separate window - close it to stop the tunnel.
pause
endlocal
