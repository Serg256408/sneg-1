---
name: run
description: Запуск полного отчёта analytics.js для менеджера за указанную дату
argument-hint: "[менеджер] [дата DD-MM-YYYY] [флаги]"
allowed-tools: Bash
---

# Запуск отчёта ТрансКом

Запусти `analytics.js` с помощью портативного Node.js.

## Правила

1. Всегда используй `.tools/node-v24.14.0-win-x64/node.exe` для запуска
2. По умолчанию менеджер: `borovaya`, дата: сегодня
3. Если пользователь указал аргументы, подставь их: `$ARGUMENTS`
4. Всегда добавляй `--no-send` если пользователь не просит отправлять в Planfix
5. Запускай в фоне (run_in_background) — отчёт может занять 2-5 минут
6. После завершения сообщи результат и предложи открыть отчёт через `/open`

## Команда

```bash
.tools/node-v24.14.0-win-x64/node.exe analytics.js $ARGUMENTS --no-send
```

Если аргументы пустые, запусти:
```bash
.tools/node-v24.14.0-win-x64/node.exe analytics.js borovaya DD-MM-YYYY --no-send
```
где DD-MM-YYYY — сегодняшняя дата.
