@echo off
cd /d "%~dp0"
if not exist node_modules call npm.cmd install
echo Open http://127.0.0.1:4318 in your browser.
node server.js
pause
