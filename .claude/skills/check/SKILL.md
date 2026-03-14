---
name: check
description: Проверка синтаксиса analytics.js на ошибки (syntax check)
allowed-tools: Bash
---

# Проверка синтаксиса

Проверь analytics.js на синтаксические ошибки.

## Команда

```bash
.tools/node-v24.14.0-win-x64/node.exe --check analytics.js
```

Если есть ошибки — покажи их и предложи исправление.
Если ошибок нет — сообщи что всё ОК.
