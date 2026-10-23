@echo off
REM _tools/sweep.bat - periodic box hygiene: kill repo zombies.
REM Silent, non-interactive — safe for Scheduled Tasks. Log goes to
REM %TEMP% so the repo stays clean. procs.mjs is the only killer here:
REM it's port-aware (:5400/:8000 always protected) — reap.mjs's
REM age-only policy can't tell a live dev stack from a zombie and
REM killed the noreload vite at 27h once. devup keeps its own reaper.
cd /d "%~dp0.."
node _tools\procs.mjs --kill >> "%TEMP%\fps_sweep.log" 2>&1
