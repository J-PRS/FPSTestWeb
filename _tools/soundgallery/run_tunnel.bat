@echo off
C:\Users\JPrice\bin\cloudflared.exe tunnel --url http://127.0.0.1:8791 --no-autoupdate > "%~dp0tunnel.log" 2>&1
