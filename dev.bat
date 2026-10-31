@echo off
setlocal
cd /d "%~dp0"
set "PATH=%~dp0.tools\node;%PATH%"
echo Starting bot in watch mode (restarts on file changes)...
node --watch "src\boot.js"
echo.
echo Bot stopped. Press any key to close.
pause >nul
