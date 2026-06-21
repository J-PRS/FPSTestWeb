@echo off
echo Starting server and client...
start "Server" cmd /k "cd server && npm run dev"
timeout /t 2 /nobreak >nul
start "Client" cmd /k "cd client && npm run dev"
echo Both processes started in separate windows.
