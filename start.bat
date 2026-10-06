@echo off
cd /d "%~dp0"
echo Starting PhysioNotes...
where node >nul 2>nul && (start "" http://localhost:8080 & node serve.mjs 8080 & goto :eof)
where python >nul 2>nul && (start "" http://localhost:8080 & python -m http.server 8080 --bind 127.0.0.1 & goto :eof)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
