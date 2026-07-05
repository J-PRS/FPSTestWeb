@echo off
echo Starting FPS Bun Server...
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
bun install
bun --watch run src/server.ts
pause

