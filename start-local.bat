@echo off
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8787
echo Starting cf-local-sub on http://127.0.0.1:%PORT% ...
start "" http://127.0.0.1:%PORT%
node src/server.mjs
pause
