@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1" -Mode Lan
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%
