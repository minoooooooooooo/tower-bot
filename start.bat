@echo off
setlocal
cd /d "%~dp0"
set "PATH=%~dp0.tools\node;%PATH%"
echo Starting bot... press Ctrl+C to stop.
node "src\boot.js"
echo.
echo Bot stopped. Press any key to close.
pause >nul
