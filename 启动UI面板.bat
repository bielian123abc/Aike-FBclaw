@echo off
cd /d "G:\Aike-FBclaw"
set "NODE=C:\Users\UR\.workbuddy\binaries\node\versions\22.22.2\node.exe"
set "NPX=C:\Users\UR\.workbuddy\binaries\node\versions\22.22.2\npx.cmd"
title Aike-FBclaw UI Panel

cls
echo ==========================================
echo   Aike-FBclaw - UI Panel
echo   Opening http://localhost:5173
echo ==========================================
echo.

%NPX% vite

pause
