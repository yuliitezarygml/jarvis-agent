@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title Jarvis - Development
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-project.ps1" -Task dev %*
set "JARVIS_RESULT=%ERRORLEVEL%"
echo.
if not "%JARVIS_RESULT%"=="0" echo [ERROR] Development launch failed. See the message above.
if not defined JARVIS_NO_PAUSE pause
exit /b %JARVIS_RESULT%
