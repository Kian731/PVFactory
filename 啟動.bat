@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
echo Starting image tool... close this window to stop.
node server.js
pause
exit /b
:nonode
echo Node.js not found. Install from https://nodejs.org (LTS), or just double-click index.html instead.
pause
