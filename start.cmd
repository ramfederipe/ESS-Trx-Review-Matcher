@echo off
setlocal
set NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
powershell -NoProfile -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:5177/api/status' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo ESS Txn Review Checker is already running.
  echo Dashboard: http://127.0.0.1:5177
  echo Use the dashboard Start and Stop buttons to control the checker.
  echo.
  pause
  exit /b 0
)
if not exist "%NODE_EXE%" (
  echo Bundled Node.js was not found at:
  echo %NODE_EXE%
  echo.
  pause
  exit /b 1
)
"%NODE_EXE%" --use-system-ca "%~dp0src\app.js"
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo ESS Txn Review Checker stopped with an error. Leave this window open and send a screenshot.
) else (
  echo ESS Txn Review Checker stopped.
)
pause
exit /b %EXIT_CODE%
