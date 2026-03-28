# ТрансКом — Аналитика продаж (Planfix CRM)

## Что это
Приложение для ежедневной аналитики продаж компании ТрансКом (вывоз снега, асфальтирование).
Модульная структура в `src/` (~13 файлов) генерирует self-contained HTML-отчёт с ИИ-оценкой каждой сделки.

## Владелец
Сергей (spezavtoteh@gmail.com) — владелец компании ТрансКом.

## Архитектура
```
analytics.js              — обёртка (require('./src/index'))
src/
  utils/
    config.js    (~65)    — env vars, константы, менеджеры
    helpers.js   (~100)   — sleep, pad2, parsePfDate, stripHtml, utcToMsk
  api/
    planfix.js   (~140)   — httpPost/Get, pf(), getAllTasks, getComments
    whisper.js   (~85)    — downloadFile, transcribe, rate limiting
    deepseek.js  (~75)    — openaiChat с fallback (DeepSeek → Polza.ai)
  core/
    cache.js     (~30)    — load/save AI + transcription кэш
    transcription.js (~15) — extractTranscription
    scoring.js   (~60)    — calculateSalaryScore (баллы ЗП)
    deals.js     (~1280)  — AI-оценка, buildDealCards, воронка
  report/
    html.js      (~2320)  — generateHtml (CSS + клиентский JS встроены)
    dashboard.js (~140)   — мульти-менеджерский дашборд
  index.js       (~220)   — CLI, runForManager, main()
```
- **Planfix API** — источник данных: сделки, комментарии, звонки
- **DeepSeek AI** — оценка качества работы менеджера, nextStep, отчёт руководителя
- **OpenAI Whisper** — транскрибация звонков
- **GitHub Actions** — автоматический запуск каждый день в 18:00 МСК
- **GitHub Pages** — публикация отчёта: https://serg256408.github.io/sneg-1/

## Файлы данных (хранятся в репо, обновляются автоматически)
- `ai_cache.json` — кэш всех ИИ-оценок (ключ: `assess_{dealId}_{date}_v{N}`)
- `latest_data.json` — данные последнего отчёта
- `funnel_snapshot.json` — снимок воронки для отслеживания изменений
- `daily_log.txt` — лог запусков
- `report.html` — последний сгенерированный отчёт
- `deploy/index.html` — копия отчёта для GitHub Pages

## Как запускать
```bash
# Полный отчёт за сегодня (с отправкой в Planfix)
.tools/node-v24.14.0-win-x64/node.exe analytics.js borovaya 16-03-2026

# Без отправки в Planfix
.tools/node-v24.14.0-win-x64/node.exe analytics.js borovaya 16-03-2026 --no-send

# Только перегенерация HTML из кэша (без API)
.tools/node-v24.14.0-win-x64/node.exe analytics.js borovaya --html
```
Node.js портативный: `.tools/node-v24.14.0-win-x64/node.exe` (не в PATH).

## Два типа сделок
- **"Вывоз снега"** — определяется по `deal.name.startsWith('вывоз снега')`, кэш v18
- **"Сделка" (асфальт)** — все остальные, кэш v18a
- Разные критерии устной презентации для каждого типа

## Вкладки отчёта
0. **День** — обзор дня: ИИ-итог, метрики, карточки сделок с оценками
1. **Все сделки** — полный список с фильтрами
2. **Качество** — анализ качества звонков
3. **Ежедневные** — сравнение дней
4. **Воронка** — визуализация воронки продаж
5. **Статистика** — графики и тренды
6. **Руководитель** — AI-выжимка за день/неделю/месяц для РОПа

## ИИ-оценка сделки включает
- `overallVerdict` — общий вердикт
- `salaryScore` — баллы за работу (из 12)
- `recommendations` — рекомендации менеджеру
- `nextStep` — конкретный следующий шаг
- `dealType` — тип сделки ('snow' / 'asphalt')
- Подитоги: приветствие, потребности, презентация, возражения, закрытие

## Воронка сделок
Новая → Обработка → В работе → КП → Вывезли/Нашли поставщика → Дожим → Договор и оплата

## GitHub Actions
- Workflow: `.github/workflows/daily-report.yml`
- Расписание: ежедневно в 16:00 UTC (19:00 МСК)
- Секреты: PLANFIX_URL, PLANFIX_TOKEN, OPENAI_API_KEY, DEEPSEEK_API_KEY, GROK_API_KEY
- После генерации коммитит данные и деплоит на GitHub Pages

## Git
- Ветки: `master` (рабочая), `main` (синхронизирована с master для GitHub Actions/Pages)
- После изменений: коммит в master → `git branch -f main master && git push origin main`
- Или просто пушить в обе ветки

## Правила работы при доработке

### Трекинг задач
- Файл `TASKS.md` — единый лог задач для ВСЕХ чатов
- Перед началом работы — прочитать `TASKS.md`, посмотреть что сделано и что в очереди
- При начале задачи — перенести в "В работе"
- При завершении — перенести в "Выполнено" с датой
- Новые задачи — добавлять в "Очередь"

### Процесс (микрозадачи)
1. **Задача** — получить задачу от пользователя
2. **Уточнение** — задать вопросы если что-то неясно (не додумывать)
3. **План** — написать короткий план (3-5 шагов), согласовать
4. **Декомпозиция** — разбить на микрозадачи (TodoWrite), каждая — минимальное изменение
5. **Выполнение** — по одной задаче за раз:
   - Изменить код (минимально, только то что нужно)
   - Запустить тесты: `.tools/node-v24.14.0-win-x64/node.exe test.js`
   - Перегенерировать HTML: `analytics.js borovaya --html`
   - Проверить в браузере через Playwright (если UI изменился)
   - Отметить задачу выполненной
6. **Показать результат** — показать что изменилось, дождаться подтверждения
7. **Следующая задача** — только после подтверждения пользователя

### Запреты
- НЕ менять несколько файлов одновременно без проверки между ними
- НЕ делать большие рефакторинги без согласования
- НЕ удалять существующую функциональность без спроса
- НЕ пропускать тесты после изменений
- НЕ додумывать требования — спрашивать

### Тестирование
- `node test.js` — 36 проверок (синтаксис, данные, HTML, шаблоны, deploy, навигация)
- Хук автоматически запускает тесты после Edit/Write в `analytics.js` или `src/`
- `watch-test.js` — следит за файлами и запускает тесты из любого чата/IDE
- Все тесты должны быть зелёными перед показом результата

### Структура проекта (v9.0 модульная)
```
analytics.js              — обёртка: require('./src/index')
src/
  utils/config.js         — константы, ALLOWED_TEMPLATES, DEAL_FIELDS
  utils/helpers.js        — утилиты
  api/planfix.js          — Planfix API, getAllTasks
  api/whisper.js          — транскрибация
  api/deepseek.js         — ИИ-оценка
  core/cache.js           — кэш
  core/deals.js           — buildDealCards, фильтрация по шаблонам
  core/scoring.js         — баллы ЗП
  core/transcription.js   — транскрибация
  report/html.js          — генерация HTML
  report/dashboard.js     — дашборд
  index.js                — CLI, main()
test.js                   — тесты
watch-test.js             — file watcher для автотестов
```

### Общие правила
- Все долгие команды запускать в фоне (run_in_background)
- При изменении кода — проверить синтаксис, перегенерировать HTML, протестировать
- Локальный сервер для проверки: `npx http-server deploy -p 8766`
