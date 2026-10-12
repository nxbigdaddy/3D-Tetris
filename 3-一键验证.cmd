@echo off
rem ASCII-only wrapper on purpose (see 1-¿ªÊ¼ÓÎÏ·.cmd for why).
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is required: https://nodejs.org/
  pause
  exit /b 1
)
node scripts\verify-all.mjs
echo.
pause
exit /b 0
