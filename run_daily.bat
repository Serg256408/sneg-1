@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "ROOT=%~dp0"
set "LOG=%ROOT%daily_log.txt"
set "NODE=node"
set "BRANCH=main"

if exist "%ROOT%.tools\node-v24.14.0-win-x64\node.exe" (
    set "NODE=%ROOT%.tools\node-v24.14.0-win-x64\node.exe"
)

cd /d "%ROOT%" || exit /b 1

for /f %%i in ('powershell -NoProfile -Command "(Get-Date).ToString(\"dd-MM-yyyy\")"') do set "TODAY=%%i"
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).ToString(\"dd.MM.yyyy HH:mm\")"') do set "STAMP=%%i"

if not defined TODAY (
    echo [%date% %time%] Failed to resolve report date>>"%LOG%"
    exit /b 1
)

echo [%date% %time%] Start daily report for %TODAY%>>"%LOG%"

git diff --quiet --ignore-submodules HEAD --
if errorlevel 1 (
    set "SKIP_GIT_SYNC=1"
    echo [%date% %time%] Working tree is dirty, skip git pull/push>>"%LOG%"
) else (
    git pull --ff-only origin %BRANCH% >> "%LOG%" 2>&1
    if errorlevel 1 (
        echo [%date% %time%] git pull failed>>"%LOG%"
        exit /b 1
    )
)

"%NODE%" analytics.js --all %TODAY% >> "%LOG%" 2>&1
set "REPORT_EXIT=%ERRORLEVEL%"

if not "%REPORT_EXIT%"=="0" (
    echo [%date% %time%] Report build failed, code %REPORT_EXIT%>>"%LOG%"
    exit /b %REPORT_EXIT%
)

echo [%date% %time%] Reports generated>>"%LOG%"

if defined SKIP_GIT_SYNC (
    echo [%date% %time%] GitHub sync skipped because repo has local changes>>"%LOG%"
    echo [%date% %time%] Finished>>"%LOG%"
    exit /b 0
)

git config user.name "Transcom Daily Report"
git config user.email "actions@github.com"
git add ai_cache.json deal_history.json latest_data.json funnel_snapshot.json daily_log.txt report.html data reports deploy managers.json transcriptions_cache.json
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Report %STAMP%" >> "%LOG%" 2>&1
    if errorlevel 1 (
        echo [%date% %time%] git commit failed>>"%LOG%"
        exit /b 1
    )

    git push origin %BRANCH% >> "%LOG%" 2>&1
    if errorlevel 1 (
        echo [%date% %time%] git push failed>>"%LOG%"
        exit /b 1
    )

    echo [%date% %time%] GitHub updated>>"%LOG%"
) else (
    echo [%date% %time%] No git changes to push>>"%LOG%"
)

echo [%date% %time%] Finished>>"%LOG%"
