@echo off
rem install.cmd - one-click setup for Windows (double-click). Runs install.ps1, which checks Node.js and runs tools/setup.mjs.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
