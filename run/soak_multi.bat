@echo off
rem Multi-seed warp soak — runs the CTF soak N times back to back with
rem different room seeds, one heatmap + log set per seed, so a wall
rem minute buys several match samples instead of one roll.
rem Usage: soak_multi.bat [count]   (default 3 seeds from 4242)
rem Override the map: set FPS_SOAK_MAP=<maps/*.json name> before calling.
setlocal enabledelayedexpansion
cd /d "%~dp0..\server_bun"
set PATH=%PATH%;%USERPROFILE%\.bun\bin
set FPS_SOAK_MS=10000
set FPS_SOAK_MODE=ctf
set COUNT=%1
if "%COUNT%"=="" set COUNT=3
set SEED=4242
for /l %%i in (1,1,%COUNT%) do (
  set /a S=SEED+%%i-1
  set FPS_SOAK_SEED=!S!
  set FPS_TRAIL=%~dp0soak_map_s!S!
  set LOG_LEVEL=warn
  echo === soak seed !S! ===
  bun test tests/scenarios/fastSoak.test.ts
)
endlocal
