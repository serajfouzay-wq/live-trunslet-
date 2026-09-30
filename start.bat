@echo off
title Live Translate
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing dependencies...
  call npm install --omit=dev
)
node server\index.js --open
pause
