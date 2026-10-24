@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 or newer first.
  pause
  exit /b 1
)
node --input-type=module -e "import('ws').catch(() => process.exit(1))" >nul 2>nul
if errorlevel 1 (
  call npm ci
  if errorlevel 1 (
    echo Dependency installation failed. See README.md.
    pause
    exit /b 1
  )
)
node scripts\start-internet.mjs
pause
