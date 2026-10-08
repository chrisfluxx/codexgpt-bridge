@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0CodexGPT Bridge.exe" "%~dp0resources\app.asar\apps\cli\dist\main.js" %*
