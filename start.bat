@echo off
setlocal
cd /d "%~dp0"
title PhysioNotes - keep this window open while you use the app
set "PORT=8080"
set "MODE="

echo.
echo  Starting PhysioNotes...
echo.

rem Pick the first server that REALLY works (Windows ships fake "python" placeholders, so we test by running it).
where node >nul 2>nul && set "MODE=node"
if not defined MODE ( python -c "import sys" >nul 2>nul && set "MODE=python" )
if not defined MODE ( py -3 -c "import sys" >nul 2>nul && set "MODE=py" )
if not defined MODE set "MODE=powershell"

if "%MODE%"=="node" (
  echo  Using Node.js
  start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%"
  node serve.mjs %PORT%
  goto :stopped
)
if "%MODE%"=="python" (
  echo  Using Python
  start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%"
  python serve.py %PORT%
  goto :stopped
)
if "%MODE%"=="py" (
  echo  Using Python
  start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%"
  py -3 serve.py %PORT%
  goto :stopped
)

echo  Using built-in Windows PowerShell (nothing to install)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"

:stopped
echo.
echo  ----------------------------------------------------------------
echo  The PhysioNotes server has stopped.
echo   - If a message above says the address is "already in use", close any other
echo     PhysioNotes windows and run this file again.
echo   - If it says scripts are blocked or something is not allowed, this PC may
echo     be locked down. Skip this launcher and put the app online instead:
echo     see "Run it" in README.md (Netlify Drop - no install needed).
echo  ----------------------------------------------------------------
echo.
pause
