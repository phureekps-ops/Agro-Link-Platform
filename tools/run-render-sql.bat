@echo off
rem Run one SQL migration file on the Render database.
rem Usage (from the repo folder):  tools\run-render-sql.bat backend\db\FILE.sql
rem Asks for the External Database URL, clears the screen so the password is not left visible,
rem runs psql, then forgets the URL. Nothing is saved to disk.
setlocal
if "%~1"=="" (
  echo Usage: tools\run-render-sql.bat backend\db\FILE.sql
  exit /b 1
)
if not exist "%~1" (
  echo File not found: %~1
  exit /b 1
)
set "PATH=%PATH%;C:\Program Files\PostgreSQL\18\bin"
set "PGCLIENTENCODING=UTF8"
set "DBURL="
echo.
echo Paste the External Database URL from Render (right-click), then press Enter:
set /p "DBURL=> "
cls
if not defined DBURL (
  echo No URL was pasted - cancelled. Nothing was run.
  exit /b 1
)
if /i not "%DBURL:~0,8%"=="postgres" (
  set "DBURL="
  echo The URL must start with postgresql:// - cancelled. Nothing was run.
  exit /b 1
)
echo Running %~1 on Render ...
echo.
psql "%DBURL%" -v ON_ERROR_STOP=1 -f "%~1"
set "RC=%ERRORLEVEL%"
set "DBURL="
echo.
if "%RC%"=="0" (echo ===== DONE - no errors =====) else (echo ===== FAILED - see the ERROR line above =====)
endlocal
