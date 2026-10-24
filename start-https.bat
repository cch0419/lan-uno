@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS first.
  pause
  exit /b 1
)
node --input-type=module -e "import('ws').catch(() => process.exit(1))" >nul 2>nul
if errorlevel 1 (
  call npm ci
  if errorlevel 1 exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-voice-https.ps1
if errorlevel 1 (
  pause
  exit /b 1
)
set "UNO_TLS_KEY=%~dp0.certs\server.key"
set "UNO_TLS_CERT=%~dp0.certs\server.crt"
set "UNO_TLS_CA=%~dp0.certs\lan-uno-ca.crt"
if not defined PORT set "PORT=3443"
node server\index.js
pause
