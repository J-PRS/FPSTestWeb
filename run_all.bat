@echo off
echo Starting server and client...
powershell -Command "Start-Process cmd -ArgumentList '/k cd /d C:\TEMP\_WEB\FPSWebTest\server && npm run dev' -Verb RunAs"
timeout /t 2 /nobreak >nul
start "Client" cmd /k "cd /d C:\TEMP\_WEB\FPSWebTest\client && npm run dev"
echo Both processes started in separate windows.
