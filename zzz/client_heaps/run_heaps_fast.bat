@echo off
cd /d "%~dp0"

echo Compiling Heaps to JS...
haxe build.hxml
if %ERRORLEVEL% NEQ 0 (
    echo Compilation FAILED
    exit /b 1
)

echo Compile OK
netstat -ano | findstr ":5200" >nul
if %ERRORLEVEL% NEQ 0 (
    echo Starting server on http://localhost:5200
    start "HeapsServer" python serve.py
    timeout /t 1 /nobreak >nul
) else (
    echo Server already running on port 5200
)
start http://localhost:5200