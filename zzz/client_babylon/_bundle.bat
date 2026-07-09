@echo off
cd /d "%~dp0"
call npm install
call npm run build
echo.
echo Bundle complete. Output is in the dist/ folder.
pause
