@echo off
cd /d c:\transcom

:: Получаем текущую дату в формате DD-MM-YYYY
for /f "tokens=1-3 delims=." %%a in ("%date%") do (
    set DAY=%%a
    set MONTH=%%b
    set YEAR=%%c
)
set TODAY=%DAY%-%MONTH%-%YEAR%

echo [%date% %time%] Запуск отчёта за %TODAY% >> c:\transcom\daily_log.txt
node analytics.js "Боровая" %TODAY% >> c:\transcom\daily_log.txt 2>&1
echo [%date% %time%] Завершено >> c:\transcom\daily_log.txt

:: Деплой на Vercel (через GitHub)
call deploy.bat >> c:\transcom\daily_log.txt 2>&1
