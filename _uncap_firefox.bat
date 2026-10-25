@echo off
rem Launches a NEW Firefox window uncapped — layout.frame_rate=999,
rem vsync-agnostic the same way Chrome's --disable-frame-rate-limit works.
rem Separate -profile so your normal Firefox is unaffected.
rem Usage: _uncap_firefox.bat [url]   (default: prod preview on :5500)
set URL=%~1
if "%URL%"=="" set URL=http://localhost:5500/?mode=headhunt^&map=rimrock^&bots=10^&noballs=1^&nocreatures=1
set PROF=%TEMP%\firefox-uncap
if not exist "%PROF%" mkdir "%PROF%"
rem Write a user.js so the profile boots with vsync+rate-limit off:
rem  layout.frame_rate=999 unlocks the compositor cap;
rem  gfx.webrender.software=false keeps it on the real GPU.
(
  echo user_pref("layout.frame_rate", 0);
  echo user_pref("gfx.webrender.software", false);
  echo user_pref("layers.acceleration.disabled", false);
  echo user_pref("browser.shell.checkDefaultBrowser", false);
) > "%PROF%\user.js"
set FF="C:\Program Files\Mozilla Firefox\firefox.exe"
if not exist %FF% set FF="C:\Program Files (x86)\Mozilla Firefox\firefox.exe"
%FF% -profile "%PROF%" -new-window "%URL%"
