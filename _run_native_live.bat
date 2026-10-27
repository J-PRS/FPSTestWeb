@echo off
REM Electrobun native shell against the LIVE server (play.jprice.app).
REM Local :5500 preview serves the bundle; the relay targets the box's
REM real UDP lane. Do NOT also run _tools/udpShim.ts — same port.
cd /d C:\TEMP\_WEB\FPSWebTest\native
set CLIENT_URL=http://localhost:5500/?server=https%%3A%%2F%%2Fplay.jprice.app
set UDP_TARGET_HOST=92.5.61.55
set UDP_TARGET_PORT=9898
set FULLSCREEN=1
C:\Users\JPrice\.hutch\bin\hutch.exe electrobun dev
