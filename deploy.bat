@echo off
setlocal
cd /d "%~dp0"
set "PATH=%~dp0.tools\node;%PATH%"
echo Registering slash commands...
node "src\deploy-commands.js"
echo.
echo Done. Press any key to close.
pause >nul
