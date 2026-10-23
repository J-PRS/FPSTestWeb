@echo off
REM _tools/sweep.bat - periodic box hygiene: kill repo zombies.
REM Silent, non-interactive — safe for Scheduled Tasks. Log goes to
REM %TEMP% so the repo stays clean. procs.mjs is the only killer here:
REM it's port-aware (:5400/:8000 always protected) — reap.mjs's
REM age-only policy can't tell a live dev stack from a zombie and
REM killed the noreload vite at 27h once. devup keeps its own reaper.
cd /d "%~dp0.."
node _tools\procs.mjs --kill >> "%TEMP%\fps_sweep.log" 2>&1
REM health report (knip + jscpd) — regenerates only if latest.md is >24h old.
node _tools\health.mjs --if-stale 24 >> "%TEMP%\fps_sweep.log" 2>&1
REM shot compaction — PNGs older than 7d become 80% webp in place.
node _tools\shotwebp.mjs >> "%TEMP%\fps_sweep.log" 2>&1
