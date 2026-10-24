@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS first.
  pause
  exit /b 1
)
node --input-type=module -e "import('ws').catch(() => process.exit(1))" >nul 2>nul
if errorlevel 1 (
  echo Installing dependencies using this project's local npm cache...
  call npm ci
  if errorlevel 1 (
    echo Dependency installation failed. See README.md for troubleshooting.
    pause
    exit /b 1
  )
)
echo Starting UNO. The management page will open in your default browser.
node server\index.js
pause
