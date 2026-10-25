@echo off
rem Launches a NEW Chrome window with vsync/frame-rate limits OFF and
rem opens the game — real uncapped FPS like Quake's fps_max 500.
rem Flags are per-process: your normal Chrome is unaffected.
rem Usage: _uncap_chrome.bat [url]   (default: prod preview on :5500)
set URL=%~1
if "%URL%"=="" set URL=http://localhost:5500/?mode=headhunt&map=rimrock&bots=10&noballs=1&nocreatures=1
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
%CHROME% --user-data-dir="%TEMP%\chrome-uncap" --disable-gpu-vsync --disable-frame-rate-limit --max-gum-fps=999 --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --no-first-run --no-default-browser-check --new-window %URL%
