@echo off
chcp 65001 >nul
cd /d c:\transcom

:: Копируем report.html в deploy/index.html
copy /Y report.html deploy\index.html >nul 2>&1

:: Пушим в GitHub
cd deploy
git config http.sslBackend openssl
git add -A
git commit -m "Report %date% %time%" >nul 2>&1
git push >nul 2>&1

echo [%date% %time%] Deploy done >> c:\transcom\daily_log.txt
