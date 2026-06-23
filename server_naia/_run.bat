@echo off
cd /d "%~dp0"
echo Starting FPS Naia Server...
set RUST_LOG=info
if exist "target\release\fps_server.exe" (
    target\release\fps_server.exe
) else (
    echo Server binary not found. Please run _build.bat first.
)