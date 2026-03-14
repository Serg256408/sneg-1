---
name: html
description: Перегенерация HTML-отчёта из кэшированных данных (без обращения к Planfix API)
allowed-tools: Bash
---

# Перегенерация HTML

Перегенерируй report.html из уже сохранённых данных в latest_data.json (без загрузки с Planfix).

## Команда

```bash
.tools/node-v24.14.0-win-x64/node.exe analytics.js --html
```

После успешного завершения сообщи пользователю и предложи открыть через `/open`.
