@echo off
REM devup.bat - Windows entry point. Delegates to the cross-platform
REM orchestrator _tools\devup.mjs (reap, free ports, launch, readiness,
REM prefixed output, Ctrl+C teardown). Pass flags through, e.g.
REM   devup.bat --no-reap
REM   devup.bat --no-logs
node "%~dp0_tools\devup.mjs" %*
if errorlevel 1 exit /b %errorlevel%