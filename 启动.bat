@echo off
title Aike-FBclaw
cd /d "G:\Aike-FBclaw"
set "NODE=C:\Users\UR\.workbuddy\binaries\node\versions\22.22.2\node.exe"
set "NPX=C:\Users\UR\.workbuddy\binaries\node\versions\22.22.2\npx.cmd"
REM 填入你的 DeepSeek API Key（请勿提交真实 key 到 git；建议改用系统环境变量 DEEPSEEK_API_KEY）
set "DEEPSEEK_API_KEY=在此填入你的_DeepSeek_API_Key"

echo Starting OpenClaw Gateway...
start "OpenClaw-Gateway" %NPX% openclaw gateway

echo Waiting for Gateway...
timeout /t 5 /nobreak >nul

echo Starting Aike-FBclaw Dashboard (via Supervisor)...
start "Aike-FBclaw-Supervisor" %NPX% tsx src/supervisor.ts

timeout /t 3 /nobreak >nul

echo Opening desktop window...
start "" chrome --app=http://localhost:18991 --window-size=1400,900

echo All systems started.
echo Dashboard: http://localhost:18991
echo OpenClaw: http://localhost:18789
