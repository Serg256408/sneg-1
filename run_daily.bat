@echo off
setlocal
chcp 65001 >nul

set "ROOT=%~dp0"
set "LOG=%ROOT%daily_log.txt"
set "NODE=node"

if exist "%ROOT%.tools\node-v24.14.0-win-x64\node.exe" (
    set "NODE=%ROOT%.tools\node-v24.14.0-win-x64\node.exe"
)

cd /d "%ROOT%"

for /f "tokens=1-3 delims=." %%a in ("%date%") do (
    set "DAY=%%a"
    set "MONTH=%%b"
    set "YEAR=%%c"
)
set "TODAY=%DAY%-%MONTH%-%YEAR%"

echo [%date% %time%] Запуск отчета за %TODAY% >> "%LOG%"
"%NODE%" analytics.js borovaya %TODAY% >> "%LOG%" 2>&1
set "REPORT_EXIT=%ERRORLEVEL%"

if not "%REPORT_EXIT%"=="0" (
    echo [%date% %time%] Ошибка отчета, код %REPORT_EXIT% >> "%LOG%"
    exit /b %REPORT_EXIT%
)

echo [%date% %time%] Отчет собран >> "%LOG%"
call deploy.bat >> "%LOG%" 2>&1
set "DEPLOY_EXIT=%ERRORLEVEL%"

if not "%DEPLOY_EXIT%"=="0" (
    echo [%date% %time%] Ошибка deploy, код %DEPLOY_EXIT% >> "%LOG%"
    exit /b %DEPLOY_EXIT%
)

echo [%date% %time%] Завершено >> "%LOG%"
