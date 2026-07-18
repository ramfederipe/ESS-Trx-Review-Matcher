@echo off
setlocal
schtasks /Create /TN "ESS Matcher" /SC ONLOGON /TR "\"%~dp0start.cmd\"" /RL LIMITED /F
if errorlevel 1 (
  echo Could not create the startup task.
  exit /b 1
)
echo ESS Txn Review Checker will start when you log in to Windows.
