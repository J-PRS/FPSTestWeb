@echo off
rem _netbots.bat [count] [extra bot.ts flags]
rem   Spawns COUNT networked test bots (default 8), each quick-joining the
rem   emptiest live room on localhost:8000 -- during testing that's the one
rem   room you're in.
rem   Examples:
rem     _netbots.bat            - 8 fighters in your room
rem     _netbots.bat 3          - 3 fighters
rem     _netbots.bat 4 --park   - 4 parked targets
setlocal
set COUNT=%1
if "%COUNT%"=="" set COUNT=8
shift

set "BUN=bun"
if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUN=%USERPROFILE%\.bun\bin\bun.exe"

cd /d "%~dp0_tools\pvptest"
set "FLAGS=--fighter --orbit --quick"
rem Pass-through flags (after the count) replace the defaults.
if not "%~1"=="" set "FLAGS=%*"
for /l %%i in (1,1,%COUNT%) do (
  start "netbot-%%i" /min "%BUN%" bot.ts NETBOT-%%i %FLAGS%
)
echo spawned %COUNT% netbots (%FLAGS%) — close the netbot-* windows to stop them
