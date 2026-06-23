@echo off
cd /d "%~dp0"
echo Building FPS Naia Server...
set PATH=C:\Users\JPrice\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;C:\Users\JPrice\.cargo\bin;%PATH%
C:\Users\JPrice\.cargo\bin\cargo.exe build --release
if %ERRORLEVEL% EQU 0 (
    echo Build successful!
    echo Binary location: target\release\fps_server.exe
) else (
    echo Build failed with error code %ERRORLEVEL%
)