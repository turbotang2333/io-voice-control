@echo off
setlocal
"%~dp0runtime\node.exe" "%~dp0app\distribution\launch.mjs"
if errorlevel 1 pause
