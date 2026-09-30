@echo off
title Live Translate
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed yet.
  echo  1. Go to https://nodejs.org and download the LTS version.
  echo  2. Install it with the default options.
  echo  3. Double-click start.bat again.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo.
  echo  Your Node.js is too old. Please install the current LTS version from https://nodejs.org
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing what the app needs, please wait...
  call npm install --omit=dev
)

echo.
echo  Starting Live Translate. Keep this window open while you use the app.
echo  (If Windows Firewall asks, click "Allow access" for Private networks.)
echo.
node server\index.js --open
echo.
echo  Live Translate stopped.
pause
