@echo off
cd /d "%~dp0"
title Claude Web Agent
echo Claude Web Agent - keep this window open. Phone: open https://YOUR_SERVER_IP:8765
echo.
node agent.js
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Agent exited with code: %errorlevel%
    pause
    exit /b %errorlevel%
)
pause
