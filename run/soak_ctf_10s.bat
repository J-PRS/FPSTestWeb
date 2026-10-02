@echo off
rem 10s warp soak — a full 16-bot CTF room stepped flat-out for the wall
rem budget (minutes of honest sim-time in seconds of wall-time).
rem Quiet by default: only warn+ plus the KPI block print. Pass --verbose
rem (or set FPS_SOAK_VERBOSE=1) for the full INFO stream.
rem Override the map: set FPS_SOAK_MAP=<maps/*.json name> before calling.
setlocal
cd /d "%~dp0..\server_bun"
set PATH=%PATH%;%USERPROFILE%\.bun\bin
set FPS_SOAK_MS=10000
set FPS_SOAK_MODE=ctf
if /i "%1"=="--verbose" set FPS_SOAK_VERBOSE=1
if not defined FPS_SOAK_VERBOSE set LOG_LEVEL=warn
bun test tests/scenarios/fastSoak.test.ts
endlocal
