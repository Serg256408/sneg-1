@echo off
setlocal
chcp 65001 >nul

set "ROOT=%~dp0"
set "LOG=%ROOT%daily_log.txt"

cd /d "%ROOT%"
copy /Y report.html deploy\index.html >nul 2>&1
if errorlevel 1 exit /b 1

pushd deploy
git config http.sslBackend openssl
git add -A
git diff --cached --quiet
if not errorlevel 1 (
    echo [%date% %time%] Deploy skipped: no changes >> "%LOG%"
    popd
    exit /b 0
)

git commit -m "Report %date% %time%" >nul 2>&1
if errorlevel 1 (
    popd
    exit /b 1
)

git push >nul 2>&1
set "PUSH_EXIT=%ERRORLEVEL%"
popd

if not "%PUSH_EXIT%"=="0" exit /b %PUSH_EXIT%
echo [%date% %time%] Deploy done >> "%LOG%"
