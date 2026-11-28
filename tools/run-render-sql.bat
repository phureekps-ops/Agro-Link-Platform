@echo off
rem Run one SQL migration file on the Render database.
rem Usage (from the repo folder):  tools\run-render-sql.bat backend\db\FILE.sql
rem Copy the External Database URL in Render first (copy button) - this script reads it
rem from the clipboard (no pasting), checks it, runs psql without putting the password on
rem the command line, then clears the clipboard. Nothing is saved to disk.
rem The work is done by tools\run-render-sql.ps1 (same folder).
if "%~1"=="" (
  echo Usage: tools\run-render-sql.bat backend\db\FILE.sql
  exit /b 1
)
if not exist "%~1" (
  echo File not found: %~1
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-render-sql.ps1" "%~1"
exit /b %ERRORLEVEL%
