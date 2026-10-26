@echo off
REM Electrobun native shell: remote-URL window + loopback ws->UDP relay.
REM Needs: dev client (:5400) + dev server (:8000, FPS_UDP_PORT=9898 via
REM _run_server.bat). Do NOT also run _tools/udpShim.ts — same port.
cd /d C:\TEMP\_WEB\FPSWebTest\native
set CLIENT_URL=http://localhost:5400/?server=ws%%3A%%2F%%2Flocalhost%%3A8000%%2Fws
set UDP_TARGET_HOST=127.0.0.1
set UDP_TARGET_PORT=9898
set FULLSCREEN=1
C:\Users\JPrice\.hutch\bin\hutch.exe electrobun dev
