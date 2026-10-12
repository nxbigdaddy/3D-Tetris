@echo off
rem ASCII-only wrapper on purpose: this machine's cmd parses .cmd files in the
rem GBK code page, so non-ASCII text inside a batch file gets mangled.
chcp 65001 >nul
cd /d "%~dp0"
if exist "dist\3D俄罗斯方块.html" (
  start "" "dist\3D俄罗斯方块.html"
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is required: https://nodejs.org/
  pause
  exit /b 1
)
echo Building the single-file game for the first time...
node scripts\build-single-file.mjs
start "" "dist\3D俄罗斯方块.html"
exit /b 0
