// ============================================================
// deals.js — Обработка сделок, ИИ-оценка, воронка
// ============================================================

const {
  fs, path, CONCURRENCY, isCI, MAX_DAYS_CI, isTimeUp,
  CALL_TAG, ANALYSIS_TAG, ALLOWED_TEMPLATES, SKIP_STATUSES,
  FUNNEL_ORDER, POLZA_KEY, OPENAI_KEY, DEEPSEEK_KEY, ROOT_DIR,
} = require('../utils/config');

const {
  sleep, parallelMap, pad2, timeToMinNode, utcToMsk,
  parseCfd, stripHtml, parsePfDate, isSameDay, extractWorkDesc, normalizePhone,
} = require('../utils/helpers');

const { loadAiCache, saveAiCache, loadTranscriptionCache, saveTranscriptionCache } = require('../core/cache');
const { extractTranscription } = require('../core/transcription');
const { calculateSalaryScore } = require('../core/scoring');
const { pf, getTaskComments, getContactComments } = require('../api/planfix');
const { openaiChat } = require('../api/deepseek');
const { transcribeCallIfNeeded } = require('../api/whisper');

// ============ ИИ-ОЦЕНКА СДЕЛКИ ============

async function aiDealFullAssessment(dealActivity, reportDate, aiCache) {
  const deal = dealActivity.deal;
  const isSnow = (deal.name || '').toLowerCase().startsWith('вывоз снега');
  const cacheKey = `assess_${deal.id}_${reportDate}_${isSnow ? 'v20' : 'v20a'}`;
  if (aiCache[cacheKey]) return aiCache[cacheKey];

  // Собираем данные, ЧЁТКО разделяя ЗВОНКИ и ПЕРЕПИСКУ
  const allC = dealActivity.allComments || [];

  // ТРАНСКРИБАЦИИ — это единственное что доказывает устную речь в звонке
  const transcriptions = allC
    .filter(c => c.transcription)
    .map(c => `[ЗВОНОК ${c.date} ${c.time}] ${c.transcription.substring(0, 2000)}`)
    .join('\n---\n');

  // ЗВОНКИ БЕЗ ТРАНСКРИБАЦИИ — только факт, длительность. Текст НЕ показываем (чтобы ИИ не путал с транскрибацией)
  const callsWithoutTr = allC
    .filter(c => (c.type === 'outCall' || c.type === 'inCall') && !c.transcription)
    .map(c => {
      const dir = c.type === 'outCall' ? 'Исходящий' : 'Входящий';
      const dur = c.duration ? Math.round(c.duration / 60) + 'м' : '?';
      return `[ЗВОНОК БЕЗ ТРАНСКРИБАЦИИ ${c.date} ${c.time}] ${dir} ${dur} — СОДЕРЖАНИЕ НЕИЗВЕСТНО`;
    })
    .join('\n');

  // Предварительная классификация: сколько звонков с/без транскрибации
  const callsWithTrCount = allC.filter(c => c.transcription).length;
  const callsWithoutTrCount = allC.filter(c => (c.type === 'outCall' || c.type === 'inCall') && !c.transcription).length;
  const hasAnyTranscription = callsWithTrCount > 0;

  // ПЕРЕПИСКА/КОММЕНТАРИИ — заметки менеджера (НЕ звонки)
  const notes = allC
    .filter(c => c.type === 'note' && (c.text.length > 10 || (c.files && c.files.length)))
    .map(c => {
      let line = `[КОММЕНТАРИЙ ${c.date} ${c.time}] ${c.text.substring(0, 500)}`;
      if (c.files && c.files.length) line += ` [Файлы: ${c.files.join(', ')}]`;
      return line;
    })
    .join('\n');

  // Действия за ДЕНЬ — с чёткой маркировкой типа
  const todayActions = (dealActivity.actions || []).map(a => {
    const isCall = a.type === 'outCall' || a.type === 'inCall';
    const tag = isCall ? 'ЗВОНОК' : 'КОММЕНТАРИЙ';
    let line = `${a.time || '?'} [${tag}] ${a.text.substring(0, 200)}`;
    if (a.files && a.files.length) line += ` [Файлы: ${a.files.join(', ')}]`;
    if (a.transcription) line += `\n  ТРАНСКРИБАЦИЯ ЗВОНКА: ${a.transcription.substring(0, 1500)}`;
    return line;
  }).join('\n\n');

  // Все звонки из dataTags
  const callsInfo = (dealActivity.allCalls || [])
    .map(c => `[ЗВОНОК] ${c.date} ${c.time} ${c.type} ${c.duration}с ${c.contact}`)
    .join('\n');

  // Planfix анализы
  const pfAnalyses = (dealActivity.allAnalyses || [])
    .map(a => `${a.date}: Презентация:${a.howWeWork} Призыв:${a.callToAction} Счёт:${a.sentInvoice} Все4:${a.allFour} ${a.totalBalls}б ${a.verdict}`)
    .join('\n');

  // === ПРОГРАММНОЕ ПРЕДРАСПОЗНАВАНИЕ (Layer 1: надёжнее ИИ для файлов и ключевых слов) ===
  const allFiles = [];
  const allTexts = [];
  const allTrTexts = [];
  for (const c of allC) {
    if (c.files && c.files.length) allFiles.push(...c.files.map(f => ({ name: f, date: c.date, type: c.type })));
    if (c.type === 'note' || c.type === 'ndz') allTexts.push((c.text || '').toLowerCase());
    if (c.transcription) allTrTexts.push(c.transcription.toLowerCase());
  }
  const allTextJoined = allTexts.join(' ');
  const allTrJoined = allTrTexts.join(' ');

  // Файлы: КП, Презентация, Счёт
  const preDetect = {};
  preDetect.cpFile = allFiles.find(f => {
    const n = f.name.toLowerCase();
    return (n.includes('кп') || n.includes('к.п') || n.includes('коммерческое')) && (n.includes('.pdf') || n.includes('.xls') || n.includes('.doc'));
  });
  preDetect.presentationFile = allFiles.find(f => {
    const n = f.name.toLowerCase();
    return n.includes('презентация') || n.includes('транском') || n.includes('presentation') || n.includes('карточка компании');
  });
  preDetect.invoiceFile = allFiles.find(f => {
    const n = f.name.toLowerCase();
    return (n.includes('счет') || n.includes('счёт') || n.includes('shet') || n.includes('invoice')) && !n.includes('счёт-фактура') && !n.includes('счет-фактура');
  });

  // Ключевые слова устной презентации в комментариях
  const vpTextDetect = {};
  vpTextDetect.since2014 = allTextJoined.includes('2014') || allTextJoined.includes('с четырнадцатого');
  if (isSnow) {
    vpTextDetect.manyObjects = allTextJoined.includes('много объектов') || allTextJoined.includes('множество объектов');
    vpTextDetect.govClients = allTextJoined.includes('госдум') || allTextJoined.includes('госучрежд') || allTextJoined.includes('мосгордум');
    vpTextDetect.reliableInSnow = allTextJoined.includes('снегопад') || allTextJoined.includes('надёжн') || allTextJoined.includes('надежн');
    vpTextDetect.manyVehicles = allTextJoined.includes('парк техники') || allTextJoined.includes('много техники') || allTextJoined.includes('большой парк');
  } else {
    vpTextDetect.fiveBrigades = (allTextJoined.includes('5 бригад') || allTextJoined.includes('пять бригад')) && (allTextJoined.includes('геодезист') || allTextJoined.includes('проектировщик'));
    vpTextDetect.fullCycle = allTextJoined.includes('полный цикл') || allTextJoined.includes('от нуля') || allTextJoined.includes('от 0');
    vpTextDetect.bigProjects = allTextJoined.includes('микояновск') || allTextJoined.includes('рафинад') || allTextJoined.includes('западная долина');
    vpTextDetect.guarantee = (allTextJoined.includes('гарантия') || allTextJoined.includes('гарантию')) && (allTextJoined.includes('бригадир') || allTextJoined.includes('фото-отчет') || allTextJoined.includes('фото отчет'));
  }

  // Те же слова в транскрибациях
  const vpCallDetect = {};
  vpCallDetect.since2014 = allTrJoined.includes('2014') || allTrJoined.includes('четырнадцатого');
  if (isSnow) {
    vpCallDetect.manyObjects = allTrJoined.includes('много объектов') || allTrJoined.includes('множество объектов');
    vpCallDetect.govClients = allTrJoined.includes('госдум') || allTrJoined.includes('госучрежд') || allTrJoined.includes('мосгордум');
    vpCallDetect.reliableInSnow = allTrJoined.includes('снегопад') || allTrJoined.includes('надёжн') || allTrJoined.includes('надежн');
    vpCallDetect.manyVehicles = allTrJoined.includes('парк техники') || allTrJoined.includes('много техники') || allTrJoined.includes('большой парк');
  } else {
    vpCallDetect.fiveBrigades = (allTrJoined.includes('5 бригад') || allTrJoined.includes('пять бригад')) && (allTrJoined.includes('геодезист') || allTrJoined.includes('проектировщик'));
    vpCallDetect.fullCycle = allTrJoined.includes('полный цикл') || allTrJoined.includes('от нуля') || allTrJoined.includes('от 0');
    vpCallDetect.bigProjects = allTrJoined.includes('микояновск') || allTrJoined.includes('рафинад') || allTrJoined.includes('западная долина');
    vpCallDetect.guarantee = (allTrJoined.includes('гарантия') || allTrJoined.includes('гарантию')) && (allTrJoined.includes('бригадир') || allTrJoined.includes('фото-отчет') || allTrJoined.includes('фото отчет'));
  }

  // Формируем подсказку для ИИ
  const preDetectHints = [];
  if (preDetect.cpFile) preDetectHints.push(`📎 КП НАЙДЕНО: файл "${preDetect.cpFile.name}" (${preDetect.cpFile.date})`);
  if (preDetect.presentationFile) preDetectHints.push(`📎 ПРЕЗЕНТАЦИЯ НАЙДЕНА: файл "${preDetect.presentationFile.name}" (${preDetect.presentationFile.date})`);
  if (preDetect.invoiceFile) preDetectHints.push(`📎 СЧЁТ НАЙДЕН: файл "${preDetect.invoiceFile.name}" (${preDetect.invoiceFile.date})`);
  const vpItems = isSnow
    ? ['since2014', 'manyObjects', 'govClients', 'reliableInSnow', 'manyVehicles']
    : ['since2014', 'fiveBrigades', 'fullCycle', 'bigProjects', 'guarantee'];
  const vpLabels = isSnow
    ? { since2014: 'С 2014 года', manyObjects: 'Много объектов', govClients: 'Госучреждения', reliableInSnow: 'Надёжность в снегопады', manyVehicles: 'Много техники' }
    : { since2014: 'С 2014 года', fiveBrigades: '5 бригад + геодезист/проектировщик', fullCycle: 'Полный цикл работ', bigProjects: 'Крупные объекты', guarantee: 'Гарантия + бригадир + фото-отчёт' };
  for (const item of vpItems) {
    if (vpCallDetect[item]) preDetectHints.push(`🔊 ${vpLabels[item]}: НАЙДЕНО В ТРАНСКРИБАЦИИ (source=call)`);
    else if (vpTextDetect[item]) preDetectHints.push(`📝 ${vpLabels[item]}: НАЙДЕНО В КОММЕНТАРИЯХ (source=text)`);
  }
  const preDetectSection = preDetectHints.length
    ? '\n=== ПРОГРАММНЫЙ АНАЛИЗ (подтверждённые находки) ===\n' + preDetectHints.join('\n') + '\nИспользуй эти данные как ПОДТВЕРЖДЁННЫЕ — они найдены поиском по ключевым словам.\n'
    : '';

  // Предупреждение для ИИ если нет транскрибаций
  const noTrWarning = !hasAnyTranscription
    ? '\n⚠️ ВНИМАНИЕ: В этой сделке НЕТ НИ ОДНОЙ ТРАНСКРИБАЦИИ ЗВОНКОВ. Значит source="call" ЗАПРЕЩЁН для ВСЕХ пунктов без исключения.\n'
    : '';

  const prompt = `Проанализируй ВСЮ историю работы менеджера по сделке и действия за ${reportDate}.

СДЕЛКА: "${deal.name}"
Статус: ${deal.status}
Контрагент: ${deal.counterparty}
${dealActivity.isNew ? '(НОВАЯ)' : '(Старая)'}

=== СТАТИСТИКА ЗВОНКОВ ===
Звонков с транскрибацией: ${callsWithTrCount}
Звонков без транскрибации: ${callsWithoutTrCount}
${noTrWarning}${preDetectSection}
=== ПЕРЕПИСКА/КОММЕНТАРИИ (написано текстом, НЕ устно) ===
${notes || 'Нет'}

=== ЗВОНКИ (факт звонка) ===
${callsInfo || 'Нет'}
${callsWithoutTr || ''}

=== ТРАНСКРИБАЦИИ ЗВОНКОВ (что РЕАЛЬНО СКАЗАНО по телефону) ===
${transcriptions || 'Нет транскрибаций — source:"call" НЕВОЗМОЖЕН'}

=== АНАЛИЗЫ PLANFIX ===
${pfAnalyses || 'Нет'}

=== ДЕЙСТВИЯ ЗА ${reportDate} ===
${todayActions || 'Нет'}

АБСОЛЮТНЫЕ ПРАВИЛА (НАРУШЕНИЕ = ОШИБКА):

ПРАВИЛО №1 — НЕ ДОДУМЫВАЙ. Если конкретная информация (например "работаем с 2014 года") НЕ НАЙДЕНА ДОСЛОВНО в предоставленных данных — ставь done:false. НЕ предполагай что "наверное сказали в звонке". Оценивай ТОЛЬКО то что ВИДИШЬ в тексте выше.

ПРАВИЛО №2 — ИСТОЧНИК source:
- "call" — ТОЛЬКО если конкретные слова ДОСЛОВНО присутствуют в секции "ТРАНСКРИБАЦИИ ЗВОНКОВ". Пример: транскрибация содержит "мы работаем с 2014 года" → source="call".
- "text" — если информация найдена в секции "ПЕРЕПИСКА/КОММЕНТАРИИ" или в ЗАМЕТКАХ менеджера.
- "none" — если информация НЕ НАЙДЕНА нигде в данных → done:false, source:"none".
- ВНИМАНИЕ: Если в секции "ТРАНСКРИБАЦИИ ЗВОНКОВ" написано "Нет транскрибаций" — source="call" ЗАПРЕЩЁН для ВСЕХ пунктов.

ПРАВИЛО №3 — done:true ТОЛЬКО при наличии ДОКАЗАТЕЛЬСТВА:
- Для устной презентации: нужна ЦИТАТА из транскрибации или комментария.
- Для КП/Счёт/Файл: нужно КОНКРЕТНОЕ упоминание в [Файлы:] или тексте.
- Если доказательства нет — done:false. Лучше недооценить, чем выдумать.

ПРАВИЛО №4 — ЗАМЕТКА ≠ ЗВОНОК:
Если менеджер написал заметку "рассказала о компании", "обновила информацию", "сообщил клиенту" — это описание ДЕЙСТВИЯ в текстовой форме, а НЕ доказательство устной речи. Такие заметки = source:"text", НЕ source:"call".
Единственное доказательство устной речи = ТРАНСКРИБАЦИЯ, где видны конкретные СЛОВА менеджера.
Пример: заметка "позвонила и рассказала про компанию" → source:"text" (1.5 балла). Транскрибация "мы работаем с 2014 года, у нас много объектов" → source:"call" (3 балла).

ПРАВИЛО №5 — ВАЛИДАЦИЯ ПЕРЕД ОТВЕТОМ:
Перед тем как поставить source:"call" для ЛЮБОГО пункта, задай себе 2 вопроса:
1. Есть ли в секции "ТРАНСКРИБАЦИИ ЗВОНКОВ" реальный текст (не "Нет транскрибаций")?
2. Содержит ли этот текст КОНКРЕТНЫЕ слова, относящиеся к данному пункту?
Если хотя бы один ответ "нет" → source НЕ МОЖЕТ быть "call". Поставь "text" или "none".

${isSnow ? `ПРАВИЛА ОЦЕНКИ:
1. УСТНАЯ ПРЕЗЕНТАЦИЯ — подпункты: с 2014 года, много объектов, госучреждения, надёжность в снегопады, много техники. Каждый подпункт done:true ТОЛЬКО если конкретно упомянут в транскрибации (source="call") или комментарии (source="text"). В note укажи ЦИТАТУ.
2. КАК МЫ РАБОТАЕМ (ТЕХНОЛОГИЯ) — done:true ТОЛЬКО если менеджер продемонстрировал ГЛУБОКУЮ ЭКСПЕРТНОСТЬ в технологии вывоза снега, рассказав клиенту конкретные технические детали процесса.
   ПРИМЕР ХОРОШЕГО ОТВЕТА: "приезжает самосвал 20м3 и трактор-погрузчик JCB, чистит территорию шириной отвала 2.5м, грузит снег в самосвал, вывозим на лицензированный полигон, талоны утилизации предоставим, за ночь бригада может вывезти 200 кубов".
   СЧИТАЕТСЯ (минимум 3 технических детали): конкретная техника с характеристиками (самосвал 20м3, погрузчик JCB, трактор МТЗ), объёмы вывоза (кубометры, тонны), описание процесса (погрузка, транспортировка, утилизация), тип полигона, время работы бригады, количество техники и рейсов.
   НЕ СЧИТАЕТСЯ: "замерщик приедет", "работаем по договору", "всё вывезем", "бригадир будет на объекте", "выезжаем на оценку бесплатно", "составим смету" — это описание ПРОЦЕССА ЗАКАЗА, а не технологии работ. source="call" только из транскрибации.
3. ПРЕЗЕНТАЦИЯ (ФАЙЛ) — ищи в [Файлы:...]: "презентация", "карточка компании", "presentation".
4. КП — ищи в [Файлы:...] и тексте: "кп", "коммерческое предложение", "КП_", "К.П.".
5. СЧЁТ — ищи в [Файлы:...] и тексте: "счёт", "счет", "invoice".
6. ПРИЗЫВ К ДЕЙСТВИЮ — менеджер АКТИВНО подталкивает клиента к заказу конкретными словами. Примеры ПРАВИЛЬНОГО призыва: "давайте вывозить", "давайте я поставлю вас в график", "мы готовы работать, когда приезжать?", "давайте запланируем вывоз на эту неделю". НЕ СЧИТАЕТСЯ призывом: "жду вашего решения", "будем рады сотрудничеству", "обращайтесь если что" — это ПАССИВНОЕ ожидание.
7. ОТРАБОТКА ВОЗРАЖЕНИЙ — клиент говорит "дорого"/"сами"/"не нужен" → менеджер предлагает альтернативы, убеждает, не сдаётся.

СИСТЕМА БАЛЛОВ ДЛЯ ЗП:
- КП: 1 балл
- Счёт: 1 балл
- Презентация (файл/документ): 1 балл
- Устная презентация в ЗВОНКЕ (source=call): 3 балла, в ПЕРЕПИСКЕ (source=text): 1.5 балла
- Как мы работаем в ЗВОНКЕ (source=call): 3 балла, в ПЕРЕПИСКЕ (source=text): 1.5 балла
- Призыв к действию: 3 балла

Ответь СТРОГО в формате JSON (без markdown, без \`\`\`):
{
  "verbalPresentation": {
    "since2014": {"done": true/false, "note": "ЦИТАТА из транскрибации или комментария"},
    "manyObjects": {"done": true/false, "note": "ЦИТАТА"},
    "govClients": {"done": true/false, "note": "ЦИТАТА"},
    "reliableInSnow": {"done": true/false, "note": "ЦИТАТА"},
    "manyVehicles": {"done": true/false, "note": "ЦИТАТА"},
    "overall": true/false,
    "source": "call/text/none",
    "quality": "хорошо/средне/плохо"
  },
  "howWeWork": {"done": true/false, "source": "call/text/none", "note": "ЦИТАТА описания процесса работы"},
  "writtenPresentation": {"done": true/false, "note": "когда и как отправлена"},
  "cp": {"done": true/false, "note": "когда отправлено, название документа"},
  "invoice": {"done": true/false, "note": "когда отправлен, название документа"},
  "callToAction": {"done": true/false, "note": "ЦИТАТА призыва к действию"},
  "objectionHandling": {"done": true/false, "note": "какие возражения, как отработаны"},
  "todaySummary": "2-3 предложения: что произошло за ${reportDate}, результат",
  "missing": ["что НЕ выполнено из скрипта"],
  "recommendations": ["конкретные рекомендации менеджеру"],
  "nextStep": "ОДИН конкретный следующий шаг менеджеру — что именно сделать прямо сейчас, основываясь на всей истории сделки и текущем статусе",
  "overallVerdict": "краткий вердикт 1-2 предложения",
  "workSummary": "КРАТКОЕ описание работы: тип работ + объём + адрес. Пример: 'Асфальтирование 500 м², ул. Ленина 5' или 'Укладка бордюров 40 шт, Истринский р-н'. Извлеки из ВСЕХ данных (название, звонки, комментарии). Если не удалось определить — пустая строка."
}` : `ПРАВИЛА ОЦЕНКИ (шаблон "Сделка" — асфальтирование):
1. УСТНАЯ ПРЕЗЕНТАЦИЯ — 5 подпунктов компании ТрансКом для асфальта:
   - since2014: работаем с 2014 года / более 10 лет на рынке — любое упоминание длительного опыта
   - fiveBrigades: 5 бригад разной квалификации, геодезист и проектировщик в штате
   - fullCycle: беремся от нуля до полного цикла — стоянки, площадки, коммерческая недвижимость
   - bigProjects: крупные референсные объекты (Микояновский мясокомбинат, ЖК Рафинад 25 тыс м², Западная долина 20 тыс м²)
   - guarantee: даём гарантию на работы, личный менеджер, бригадир на объекте, фото-отчёт
   Каждый подпункт done:true ТОЛЬКО если конкретно упомянут в транскрибации (source="call") или комментарии (source="text"). В note укажи ЦИТАТУ.
2. КАК МЫ РАБОТАЕМ (ТЕХНОЛОГИЯ) — done:true ТОЛЬКО если менеджер продемонстрировал ГЛУБОКУЮ ЭКСПЕРТНОСТЬ в технологии работ, рассказав клиенту конкретные технические детали ОТ НАЧАЛА ДО КОНЦА в зависимости от запроса клиента. Менеджер должен показать что РЕАЛЬНО разбирается в асфальтировании, а не просто описать процесс заказа.
   ПРИМЕР ХОРОШЕГО ОТВЕТА: "вырезаем карты швонарезчиком, прямоугольные, отступаем 5 см от краёв, демонтаж экскаватором-погрузчиком с молотом, обрабатываем битумной эмульсией, укладываем мелкозернистый асфальт 30% щебня, горячий 120 градусов, уплотняем катком 8 тонн".
   СЧИТАЕТСЯ (минимум 3 технических детали): конкретная марка/тип асфальта (мелкозернистый, ЩМА-15, крупнозернистый), толщина слоя (5 см, 7 см), тип катка и его вес (8 тонн, 12 тонн), конкретное оборудование (швонарезчик, фреза, асфальтоукладчик), материалы с характеристиками (битумная эмульсия, щебень фракции 20-40, песок), температура укладки, описание подготовки основания (фрезеровка, выемка грунта, геотекстиль, щебёночная подушка), описание дренажа, уклонов, лотков.
   НЕ СЧИТАЕТСЯ (даже если звучит экспертно): "замерщик приедет и посчитает", "работаем по договору", "всё сделаем под ключ", "бригадир будет на объекте", "выезжаем на замеры бесплатно", "составим детальную смету", "проконсультируем на месте", "фиксированная цена" — это описание ПРОЦЕССА ЗАКАЗА, а не технологии работ. source="call" только из транскрибации.
3. ПРЕЗЕНТАЦИЯ (ФАЙЛ) — ищи в [Файлы:...]: "презентация", "карточка компании", "presentation".
4. КП — ищи в [Файлы:...] и тексте: "кп", "коммерческое предложение", "КП_", "К.П.".
5. СЧЁТ — ищи в [Файлы:...] и тексте: "счёт", "счет", "invoice".
6. ПРИЗЫВ К ДЕЙСТВИЮ — менеджер АКТИВНО подталкивает клиента к заказу. Примеры ПРАВИЛЬНОГО призыва для асфальта: "давайте сделаем замер", "давайте я пришлю геодезиста", "давайте обсудим ваш проект", "когда удобно приехать на объект?", "давайте составим смету". НЕ СЧИТАЕТСЯ призывом: "жду вашего решения", "будем рады сотрудничеству", "обращайтесь если что" — это ПАССИВНОЕ ожидание.
7. ОТРАБОТКА ВОЗРАЖЕНИЙ — клиент говорит "дорого"/"есть подрядчик"/"не сейчас" → менеджер предлагает альтернативы, убеждает, не сдаётся.

СИСТЕМА БАЛЛОВ ДЛЯ ЗП:
- КП: 1 балл
- Счёт: 1 балл
- Презентация (файл/документ): 1 балл
- Устная презентация в ЗВОНКЕ (source=call): 3 балла, в ПЕРЕПИСКЕ (source=text): 1.5 балла
- Как мы работаем в ЗВОНКЕ (source=call): 3 балла, в ПЕРЕПИСКЕ (source=text): 1.5 балла
- Призыв к действию: 3 балла

Ответь СТРОГО в формате JSON (без markdown, без \`\`\`):
{
  "verbalPresentation": {
    "since2014": {"done": true/false, "note": "ЦИТАТА из транскрибации или комментария"},
    "fiveBrigades": {"done": true/false, "note": "ЦИТАТА"},
    "fullCycle": {"done": true/false, "note": "ЦИТАТА"},
    "bigProjects": {"done": true/false, "note": "ЦИТАТА"},
    "guarantee": {"done": true/false, "note": "ЦИТАТА"},
    "overall": true/false,
    "source": "call/text/none",
    "quality": "хорошо/средне/плохо"
  },
  "howWeWork": {"done": true/false, "source": "call/text/none", "note": "ЦИТАТА описания процесса работы"},
  "writtenPresentation": {"done": true/false, "note": "когда и как отправлена"},
  "cp": {"done": true/false, "note": "когда отправлено, название документа"},
  "invoice": {"done": true/false, "note": "когда отправлен, название документа"},
  "callToAction": {"done": true/false, "note": "ЦИТАТА призыва к действию"},
  "objectionHandling": {"done": true/false, "note": "какие возражения, как отработаны"},
  "todaySummary": "2-3 предложения: что произошло за ${reportDate}, результат",
  "missing": ["что НЕ выполнено из скрипта"],
  "recommendations": ["конкретные рекомендации менеджеру"],
  "nextStep": "ОДИН конкретный следующий шаг менеджеру — что именно сделать прямо сейчас, основываясь на всей истории сделки и текущем статусе",
  "overallVerdict": "краткий вердикт 1-2 предложения",
  "workSummary": "КРАТКОЕ описание работы: тип работ + объём + адрес. Пример: 'Асфальтирование 500 м², ул. Ленина 5' или 'Вывоз снега, ТСЖ Андреевская'. Извлеки из ВСЕХ данных (название, звонки, комментарии). Если не удалось определить — пустая строка."
}`}`;

  const systemMsg = isSnow
    ? 'Ты аналитик отдела продаж компании ТрансКом (вывоз снега). Анализируй историю сделок и оценивай выполнение скрипта продаж. Отвечай строго в JSON.'
    : 'Ты аналитик отдела продаж компании ТрансКом (асфальтирование). Анализируй историю сделок и оценивай выполнение скрипта продаж по шаблону "Сделка". Отвечай строго в JSON.';
  const raw = await openaiChat(prompt, systemMsg, 2000, 'deepseek-chat');
  if (!raw) return null;
  try {
    const clean = raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(clean);

    // === ПРОГРАММНАЯ ПОСТ-ВАЛИДАЦИЯ (Layer 3: гарантированная защита) ===

    // 3a. Если НЕТ транскрибаций — source:"call" НЕВОЗМОЖЕН
    if (!hasAnyTranscription) {
      if (result.verbalPresentation && (result.verbalPresentation.source || '').toLowerCase() === 'call') {
        result.verbalPresentation.source = 'text';
        result.verbalPresentation._corrected = 'программно: нет транскрибаций';
      }
      if (result.howWeWork && (result.howWeWork.source || '').toLowerCase() === 'call') {
        result.howWeWork.source = 'text';
        result.howWeWork._corrected = 'программно: нет транскрибаций';
      }
      if (result.callToAction && (result.callToAction.source || '').toLowerCase() === 'call') {
        result.callToAction.source = 'text';
        result.callToAction._corrected = 'программно: нет транскрибаций';
      }
    }

    // 3b. Файлы: если программа нашла, а ИИ нет — принудительно ставим done:true
    if (preDetect.cpFile && result.cp && !result.cp.done) {
      result.cp = { done: true, note: `файл: ${preDetect.cpFile.name} (${preDetect.cpFile.date})`, _corrected: 'программно: найден файл КП' };
    }
    if (preDetect.presentationFile && result.writtenPresentation && !result.writtenPresentation.done) {
      result.writtenPresentation = { done: true, note: `файл: ${preDetect.presentationFile.name} (${preDetect.presentationFile.date})`, _corrected: 'программно: найден файл презентации' };
    }
    if (preDetect.invoiceFile && result.invoice && !result.invoice.done) {
      result.invoice = { done: true, note: `файл: ${preDetect.invoiceFile.name} (${preDetect.invoiceFile.date})`, _corrected: 'программно: найден файл счёта' };
    }

    // 3c. Устная презентация: если ИИ не нашёл, а программа нашла ключевые слова — исправляем
    if (result.verbalPresentation) {
      const vp = result.verbalPresentation;
      const vpKeys = isSnow
        ? ['since2014', 'manyObjects', 'govClients', 'reliableInSnow', 'manyVehicles']
        : ['since2014', 'fiveBrigades', 'fullCycle', 'bigProjects', 'guarantee'];
      let anyFixed = false;
      for (const key of vpKeys) {
        if (vp[key] && !vp[key].done) {
          if (vpCallDetect[key]) {
            vp[key] = { done: true, note: 'найдено программным поиском в транскрибации', _corrected: 'программно' };
            anyFixed = true;
          } else if (vpTextDetect[key]) {
            vp[key] = { done: true, note: 'найдено программным поиском в комментариях', _corrected: 'программно' };
            anyFixed = true;
          }
        }
      }
      if (anyFixed) {
        // Пересчитываем overall и source
        const anyDone = vpKeys.some(k => vp[k] && vp[k].done);
        vp.overall = anyDone;
        if (anyDone && (vp.source === 'none' || !vp.source)) {
          // Определяем source: если хоть один пункт из транскрибации — call, иначе text
          const anyFromCall = vpKeys.some(k => vpCallDetect[k] && vp[k] && vp[k].done);
          vp.source = anyFromCall ? 'call' : 'text';
        }
      }
    }

    // Синхронизируем missing с VP — убираем пункты где VP.done=true
    if (result.verbalPresentation && result.missing) {
      const vp = result.verbalPresentation;
      const vpLabelsSync = isSnow
        ? { since2014: 'С 2014 года', manyObjects: 'Много объектов', govClients: 'Госучреждения', reliableInSnow: 'Надёжность', manyVehicles: 'Много техники' }
        : { since2014: 'С 2014 года', fiveBrigades: '5 бригад', fullCycle: 'Полный цикл', bigProjects: 'Крупные', guarantee: 'Гарантия' };
      const doneLabels = Object.entries(vpLabelsSync).filter(([k]) => vp[k]?.done).map(([, v]) => v.toLowerCase());
      if (doneLabels.length) {
        result.missing = result.missing.filter(m => {
          const ml = m.toLowerCase();
          return !doneLabels.some(dl => ml.includes(dl));
        });
      }
    }

    // Рассчитываем баллы для ЗП (ПОСЛЕ всех валидаций)
    result.dealType = isSnow ? 'snow' : 'asphalt';
    result.salaryScore = calculateSalaryScore(result);
    aiCache[cacheKey] = result;
    saveAiCache(aiCache);
    return result;
  } catch {
    // Если не удалось разобрать JSON — сохраняем как текст
    const fallback = { overallVerdict: raw.substring(0, 500), missing: [], recommendations: [], nextStep: '', salaryScore: { total: 0, items: [] } };
    aiCache[cacheKey] = fallback;
    saveAiCache(aiCache);
    return fallback;
  }
}

// ============ ИИ ИТОГ ДНЯ ============

async function aiDaySummary(dailyDeals, reportDate, aiCache, mgrAlias) {
  const cacheKey = `day_${mgrAlias || 'default'}_${reportDate}_${dailyDeals.length}_v4`;
  if (aiCache[cacheKey]) return aiCache[cacheKey];

  const totalCalls = dailyDeals.reduce((s, d) => s + (d.dayCalls || 0), 0);
  const totalScore = dailyDeals.reduce((s, d) => { const ss = (d.aiAssessment || {}).salaryScore; return s + (ss ? ss.total : 0); }, 0);
  const maxScore = dailyDeals.length * 12;

  const dealsText = dailyDeals.map(d => {
    const a = d.aiAssessment;
    const verdict = a ? a.overallVerdict || '' : '';
    const score = a && a.salaryScore ? a.salaryScore.total + '/' + a.salaryScore.max : '';
    const calls = (d.actions || []).filter(x => x.type === 'outCall' || x.type === 'inCall').length;
    const callsList = (d.actions || []).filter(x => x.type === 'outCall' || x.type === 'inCall')
      .map(x => `${x.time} ${x.type === 'outCall' ? 'Исх' : 'Вх'}${x.transcription ? ' (с транскрибацией)' : ''}`).join(', ');
    const sum = d.deal.dealSum ? d.deal.dealSum + '₽' : '';
    let line = `- #${d.deal.id} "${d.deal.name}" (${d.deal.status}${sum ? ', ' + sum : ''}) ${d.deal.counterparty || ''}`;
    if (calls) line += `\n  Звонки (${calls}): ${callsList}`;
    if (score) line += `\n  Баллы: ${score}`;
    if (verdict) line += `\n  Вердикт: ${verdict}`;
    if (a && a.nextStep) line += `\n  След.шаг: ${a.nextStep}`;
    return line;
  }).join('\n');

  const prompt = `Резюмируй рабочий день менеджера по продажам (вывоз снега, асфальтирование) за ${reportDate}.

СТАТИСТИКА ДНЯ:
- Обработано сделок: ${dailyDeals.length} (новых: ${dailyDeals.filter(d => d.isNew).length}, старых: ${dailyDeals.filter(d => !d.isNew).length})
- Звонков: ${totalCalls}
- Баллы ЗП: ${totalScore}/${maxScore}

СДЕЛКИ ЗА ДЕНЬ:
${dealsText}

Напиши краткий итог дня (5-7 предложений):
1. Что менеджер сделал за день (звонки, КП, продвижения)
2. Ключевые сделки дня — какие продвинулись, с кем общался
3. Проблемы — где менеджер пассивен, какие сделки требуют внимания
4. Что нужно сделать завтра

КРИТИЧЕСКОЕ ПРАВИЛО: При каждом упоминании сделки ОБЯЗАТЕЛЬНО пиши "#ID название" (например: #31766 "Асфальтирование/4200м2"). НИКОГДА не упоминай сделку без #ID. Пиши конкретно, без воды.`;

  const result = await openaiChat(prompt, 'Ты аналитик отдела продаж компании ТрансКом. Пиши кратко, по-русски, с номерами сделок.', 1500, 'deepseek-chat');
  if (result) {
    aiCache[cacheKey] = result;
    saveAiCache(aiCache);
  }
  return result;
}

// ============ ИТОГ ДЛЯ РУКОВОДИТЕЛЯ ============

// Итог для руководителя за период (день/неделя/месяц)
async function aiManagerSummary(multiDayActivity, multiDaySummary, dealCards, funnelChanges, periodDays, reportDate, aiCache, mgrAlias) {
  const cacheKey = `mgr_${mgrAlias || 'default'}_${periodDays}d_${reportDate}_v3`;
  if (aiCache[cacheKey]) return aiCache[cacheKey];

  // Собираем даты за период
  const refDate = parsePfDate(reportDate);
  if (!refDate) return null;
  const allDates = Object.keys(multiDayActivity).filter(d => {
    const pd = parsePfDate(d);
    if (!pd) return false;
    const diff = Math.floor((refDate - pd) / 86400000);
    return diff >= 0 && diff < periodDays;
  }).sort((a, b) => {
    const pa = parsePfDate(a), pb = parsePfDate(b);
    return pb - pa;
  });

  if (!allDates.length) return null;

  // Агрегация по всем дням периода
  const dealMap = {};
  let totalCalls = 0, totalDeals = 0, newDeals = 0;
  for (const dt of allDates) {
    const dayDeals = multiDayActivity[dt] || [];
    for (const da of dayDeals) {
      totalDeals++;
      if (da.isNew) newDeals++;
      totalCalls += da.dayCalls || 0;
      if (!dealMap[da.deal.id]) dealMap[da.deal.id] = { deal: da.deal, days: [], ai: null, bestScore: 0 };
      dealMap[da.deal.id].days.push(dt);
      if (da.aiAssessment) {
        dealMap[da.deal.id].ai = da.aiAssessment;
        const sc = (da.aiAssessment.salaryScore || {}).total || 0;
        if (sc > dealMap[da.deal.id].bestScore) dealMap[da.deal.id].bestScore = sc;
      }
    }
  }

  // Только сделки, обработанные менеджером за период (из dealMap)
  const workedIds = new Set(Object.keys(dealMap).map(Number));

  // Топ сделки по сумме — ТОЛЬКО обработанные за период
  const activeBig = dealCards.filter(d => workedIds.has(d.id) && d.dealSum > 0)
    .sort((a, b) => (b.dealSum || 0) - (a.dealSum || 0)).slice(0, 10);

  // Сделки ближе к оплате — ТОЛЬКО обработанные за период
  const closing = dealCards.filter(d => workedIds.has(d.id) && ['Дожим', 'Договор и оплата'].includes(d.status));

  // Движения воронки за период
  const fwdMoves = (funnelChanges || []).filter(c => c.direction === 'forward');
  const bwdMoves = (funnelChanges || []).filter(c => c.direction === 'backward');

  // Дневные итоги
  const daySummaries = allDates.map(d => `${d}: ${(multiDaySummary || {})[d] || 'нет итога'}`).join('\n');

  // Детали по ключевым сделкам — с номерами
  const dealDetails = Object.values(dealMap)
    .sort((a, b) => (b.deal.dealSum || 0) - (a.deal.dealSum || 0))
    .slice(0, 20)
    .map(d => {
      let line = `- #${d.deal.id} "${d.deal.name}" (${d.deal.status}, ${d.deal.dealSum ? d.deal.dealSum + '₽' : 'без суммы'})`;
      line += ` — работали ${d.days.length} дн.`;
      if (d.ai) {
        if (d.ai.nextStep) line += ` | След.шаг: ${d.ai.nextStep}`;
        if (d.ai.overallVerdict) line += ` | ${d.ai.overallVerdict}`;
      }
      return line;
    }).join('\n');

  const periodName = periodDays === 1 ? 'день' : periodDays <= 7 ? 'неделю' : 'месяц';

  const prompt = `Ты составляешь отчёт для РУКОВОДИТЕЛЯ компании ТрансКом (вывоз снега, асфальтирование).
Период: за ${periodName} (${allDates.length} рабочих дней, ${allDates[allDates.length - 1]} — ${allDates[0]}).
Отчёт об эффективности МЕНЕДЖЕРА ПО ПРОДАЖАМ за этот период.

ВАЖНО: Анализируй ТОЛЬКО сделки, с которыми менеджер реально работал за этот период (звонил, писал, продвигал). НЕ включай сделки, по которым не было активности менеджера за период.

СТАТИСТИКА ПЕРИОДА:
- Обработано обращений: ${totalDeals} (новых: ${newDeals})
- Уникальных сделок за период: ${Object.keys(dealMap).length}
- Звонков: ${totalCalls}
- Продвижений по воронке: ${fwdMoves.length}
- Откатов назад: ${bwdMoves.length}
- Обработанных сделок на стадии "Дожим"/"Договор и оплата": ${closing.length}${closing.length ? ' (сумма: ' + closing.reduce((s, d) => s + (d.dealSum || 0), 0) + '₽)' : ''}

ИТОГИ ПО ДНЯМ:
${daySummaries}

СДЕЛКИ, ОБРАБОТАННЫЕ ЗА ПЕРИОД (по сумме):
${dealDetails}

ТОП ОБРАБОТАННЫХ СДЕЛОК ПО ДЕНЬГАМ:
${activeBig.length ? activeBig.map(d => `- #${d.id} "${d.name}" ${d.status} — ${d.dealSum}₽`).join('\n') : 'Нет сделок с суммой'}

БЛИЗКО К ОПЛАТЕ (обработанные за период):
${closing.length ? closing.map(d => `- #${d.id} "${d.name}" — ${d.dealSum || 0}₽ (${d.status})`).join('\n') : 'Нет'}

Напиши отчёт для руководителя в формате:

1. **КРАТКИЙ ИТОГ** (3-4 предложения): главные результаты менеджера за ${periodName}, тон деловой
2. **УСПЕХИ И ПРОГРЕСС**: какие сделки продвинулись, кто может заплатить, конкретные достижения
3. **ПРОБЛЕМЫ**: где застряли, что буксует, какие сделки требуют внимания руководителя
4. **БЛИЖАЙШИЕ ОПЛАТЫ**: какие сделки ближе всего к оплате, суммы, что нужно дожать
5. **РЕКОМЕНДАЦИИ РУКОВОДИТЕЛЮ**: конкретные действия — кому позвонить, куда подключиться, что проконтролировать

КРИТИЧЕСКОЕ ПРАВИЛО: При КАЖДОМ упоминании сделки ОБЯЗАТЕЛЬНО пиши "#ID название" (например: #31766 "Асфальтирование/4200м2"). НИКОГДА не упоминай сделку без #ID. Пиши конкретно с именами, номерами и суммами.`;

  const result = await openaiChat(prompt, 'Ты бизнес-аналитик, составляешь отчёт для директора. Пиши по-русски, конкретно, с цифрами и именами.', 2000, 'deepseek-chat');
  if (result) {
    aiCache[cacheKey] = result;
    saveAiCache(aiCache);
  }
  return result;
}

// ============ СНИМКИ ВОРОНКИ ============

function loadPreviousSnapshot(snapshotFile) {
  try {
    return JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  } catch { return null; }
}

function saveSnapshot(dealCards, snapshotFile) {
  const snapshot = {
    date: new Date().toISOString(),
    deals: {}
  };
  for (const d of dealCards) {
    snapshot.deals[d.id] = { name: d.name, status: d.status };
  }
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2), 'utf8');
  return snapshot;
}

function computeFunnelChanges(prevSnapshot, currentCards) {
  if (!prevSnapshot) return [];
  const changes = [];
  for (const card of currentCards) {
    const prev = prevSnapshot.deals[card.id];
    if (prev && prev.status !== card.status) {
      const fromIdx = FUNNEL_ORDER.indexOf(prev.status);
      const toIdx = FUNNEL_ORDER.indexOf(card.status);
      changes.push({
        dealId: card.id,
        dealName: card.name,
        counterparty: card.counterparty,
        from: prev.status,
        to: card.status,
        direction: (fromIdx !== -1 && toIdx !== -1) ? (toIdx > fromIdx ? 'forward' : 'backward') : 'unknown',
      });
    }
  }
  return changes;
}

// ============ ОБРАБОТКА СДЕЛОК ============

async function buildDealCards(tasks, mgrPfName, reportDate, mgrAlias, mgr) {
  // Вычисляем путь к файлу снимка воронки (вместо глобального setSnapshotFile)
  let snapshotFile = path.join(ROOT_DIR, 'funnel_snapshot.json');
  if (mgrAlias) {
    const perMgr = path.join(ROOT_DIR, 'data', `${mgrAlias}_funnel.json`);
    // Миграция: если per-manager файла нет, но старый есть — копируем
    if (!fs.existsSync(perMgr) && fs.existsSync(path.join(ROOT_DIR, 'funnel_snapshot.json'))) {
      try { fs.copyFileSync(path.join(ROOT_DIR, 'funnel_snapshot.json'), perMgr); } catch {}
    }
    snapshotFile = perMgr;
  }

  const reportTasks = tasks.filter(t => (t.name || '').startsWith('Отчет'));
  // Фильтрация по шаблону: только "Сделка" и "Вывоз снега"
  const nonReportTasks = tasks.filter(t => !(t.name || '').startsWith('Отчет'));
  const templateFiltered = nonReportTasks.filter(t => {
    const tplName = t.template && t.template.name ? t.template.name : '';
    if (!tplName) return true; // если шаблон не пришёл — не отсекаем (безопасный fallback)
    return ALLOWED_TEMPLATES.some(at => tplName.toLowerCase().includes(at.toLowerCase()));
  });
  const skippedByTemplate = nonReportTasks.length - templateFiltered.length;
  if (skippedByTemplate > 0) console.log(`  🚫 Отсечено по шаблону: ${skippedByTemplate} сделок (не "Сделка"/"Вывоз снега")`);
  // Разделяем: родительские сделки и подзадачи
  const subtasks = templateFiltered.filter(t => t.parent && t.parent.id);
  const dealTasks = templateFiltered.filter(t => !(t.parent && t.parent.id));
  // Карта: subtaskId -> parentId
  const subtaskToParent = {};
  for (const st of subtasks) subtaskToParent[st.id] = st.parent.id;
  // Все статусы для всех менеджеров (включая завершённые) — фильтрация по активности за день
  const activeTasks = dealTasks;
  if (subtasks.length) console.log(`  📎 Подзадачи: ${subtasks.length} шт → данные мёржатся в родителя`);
  console.log(`  📋 Сделок: ${dealTasks.length}, активных: ${activeTasks.length}`);

  // Ежедневные отчёты
  const dailyReports = reportTasks.map(t => {
    const cf = {};
    for (const c of (t.customFieldData || [])) cf[c.field.id] = { name: c.field.name, value: c.value, str: c.stringValue || '' };
    const m = (t.name || '').match(/(\d{2})-(\d{2})-(\d{4})/);
    return {
      id: t.id,
      date: m ? `${m[3]}-${m[2]}-${m[1]}` : null,
      revenue: parseFloat(String(cf[76880]?.str || cf[76880]?.value || 0).replace(/\s/g, '')) || 0,
      outCalls: parseInt(cf[76866]?.str || cf[76866]?.value || 0) || 0,
      callMinutes: parseInt(cf[76868]?.str || cf[76868]?.value || 0) || 0,
      kpSent: parseInt(cf[76872]?.value || 0) || 0,
      dozhim: parseInt(cf[76874]?.value || 0) || 0,
      contract: parseInt(cf[76876]?.value || 0) || 0,
      workDone: parseInt(cf[76878]?.value || 0) || 0,
    };
  }).filter(r => r.date);

  // Ключи дата-тегов (из сделок + подзадач → привязка к родителю)
  const callKeys = [];
  const analysisKeys = [];
  for (const t of [...dealTasks, ...subtasks]) {
    const parentId = subtaskToParent[t.id] || t.id; // подзадача → родитель
    for (const dt of (t.dataTags || [])) {
      if (dt.dataTag.id === CALL_TAG) callKeys.push({ taskId: parentId, key: dt.key });
      if (dt.dataTag.id === ANALYSIS_TAG) analysisKeys.push({ taskId: parentId, key: dt.key });
    }
  }
  console.log(`  🔑 Ключей: ${callKeys.length} звонков, ${analysisKeys.length} анализов`);

  // Загружаем записи с фильтром по дате
  const now = new Date();
  const daysBack = 60;
  const from = new Date(now.getTime() - daysBack * 86400000);
  const dateFrom = `${pad2(from.getDate())}-${pad2(from.getMonth()+1)}-${from.getFullYear()}`;
  const dateTo = `${pad2(now.getDate())}-${pad2(now.getMonth()+1)}-${now.getFullYear()}`;

  async function loadFilteredEntries(tagId, dateField, fields) {
    const result = {};
    let offset = 0;
    while (true) {
      const d = await pf(`/datatag/${tagId}/entry/list`, {
        offset, pageSize: 100, fields: `key,${fields}`,
        filters: [{ type: 3101, field: dateField, operator: 'equal', value: { dateType: 'otherRange', dateFrom, dateTo } }],
      });
      const entries = d.dataTagEntries || [];
      if (!entries.length) break;
      for (const e of entries) result[e.key] = parseCfd(e);
      if (entries.length < 100) break;
      offset += 100; await sleep(50);
    }
    return result;
  }

  console.log(`  📞 Звонки за ${daysBack} дней...`);
  const allCallEntries = await loadFilteredEntries(CALL_TAG, 58528, '58528,58530,58532,58534,58536,58538,58542');
  console.log(`    ✅ ${Object.keys(allCallEntries).length}`);

  console.log(`  🔍 Анализы за ${daysBack} дней...`);
  const allAnalysisEntries = await loadFilteredEntries(ANALYSIS_TAG, 58628, '58628,58630,58634,58646,58648,58650,58652,58654,58656');
  console.log(`    ✅ ${Object.keys(allAnalysisEntries).length}`);

  // Маппим звонки к сделкам
  const callsByTask = {};
  for (const { taskId, key } of callKeys) {
    const c = allCallEntries[key];
    if (!c) continue;
    if (!callsByTask[taskId]) callsByTask[taskId] = [];
    callsByTask[taskId].push({
      key, date: c['Дата'] || '', time: c['Время'] || '',
      type: c['Тип'] || '', duration: parseInt(c['Продолжительность (сек.)'] || '0') || 0,
      employee: c['Сотрудник'] || '', contact: c['Контакт'] || '', phone: c['Номер контакта'] || '',
      source: 'deal',
    });
  }

  // Маппим анализы к сделкам
  const analysisByTask = {};
  for (const { taskId, key } of analysisKeys) {
    const c = allAnalysisEntries[key];
    if (!c) continue;
    const ballsStr = c['Баллы'] || '';
    const scoreMatch = ballsStr.match(/=\s*(\d+)\s*\/\s*(\d+)/);
    const totalBalls = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    if (!analysisByTask[taskId]) analysisByTask[taskId] = [];
    analysisByTask[taskId].push({
      key, date: (c['Дата'] || '').substring(0, 10),
      time: (c['Дата'] || '').substring(11),
      employee: c['Сотрудник'] || '', topic: c['Тема звонка'] || '',
      howWeWork: c['Рассказал как работаем'] || '',
      callToAction: c['Призыв к действию'] || '',
      sentInvoice: c['Скинул счёт'] || '',
      allFour: c['Все 4 момента выполнены'] || '',
      ballsRaw: ballsStr, totalBalls, verdict: c['Вердикт'] || '',
    });
  }

  // Определяем сделки с активностью за ЛЮБОЙ день (из dataTags)
  const dealsWithAnyActivity = new Set();
  for (const [taskId, calls] of Object.entries(callsByTask)) {
    if (calls.length > 0) dealsWithAnyActivity.add(Number(taskId));
  }
  for (const [taskId, analyses] of Object.entries(analysisByTask)) {
    if (analyses.length > 0) dealsWithAnyActivity.add(Number(taskId));
  }
  // Сначала сделки с любой активностью (звонки/анализы), потом остальные по ID
  const priorityTasks = activeTasks.filter(t => dealsWithAnyActivity.has(t.id));
  const otherTasks = activeTasks.filter(t => !dealsWithAnyActivity.has(t.id))
    .sort((a, b) => b.id - a.id);
  const recentActive = [...priorityTasks, ...otherTasks];
  console.log(`  💬 Комментарии ${recentActive.length} сделок (${priorityTasks.length} приоритетных)...`);
  // Карта parentId -> [subtaskId, ...]
  const parentToSubtasks = {};
  for (const st of subtasks) {
    const pid = st.parent.id;
    if (!parentToSubtasks[pid]) parentToSubtasks[pid] = [];
    parentToSubtasks[pid].push(st.id);
  }

  const commentsByTask = {};
  const transcriptionCache = loadTranscriptionCache();
  let whisperCount = 0;

  // Хелпер: парсинг комментариев из API-ответа
  async function parseComments(comments) {
    const parsed = [];
    for (const c of comments) {
      const desc = stripHtml(c.description);
      const dtRaw = c.dateTime || {};
      const dt = utcToMsk(dtRaw.date, dtRaw.time); // Planfix API отдаёт UTC → конвертируем в МСК
      let type = 'note';
      const descLow = desc.toLowerCase();
      if (descLow.startsWith('исходящий звонок')) type = 'outCall';
      else if (descLow.startsWith('входящий звонок')) type = 'inCall';
      else if (descLow.startsWith('ндз')) type = 'ndz';
      // Робот Аргон: звонки внутри текста (не в начале)
      else if (descLow.includes('входящий звонок') || descLow.includes('исходящий звонок')) {
        type = descLow.includes('исходящий звонок') ? 'outCall' : 'inCall';
      }
      // Транскрибация в тексте (----------  🔴/🔵) или mp3 "Запись звонка" = звонок
      if (type === 'note') {
        const hasCallTranscription = desc.includes('----------') && (/[🔴🔵●]/.test(desc) || /A:.*B:/s.test(desc));
        const hasCallRecording = (c.files || []).some(f => (f.name || '').toLowerCase().includes('запись звонка'));
        if (hasCallTranscription || hasCallRecording) {
          type = 'inCall'; // по умолчанию входящий, если направление неизвестно
        }
      }

      let transcription = null;
      if (type === 'outCall' || type === 'inCall') {
        transcription = extractTranscription(c.description);
        if (!transcription) {
          const hasFiles = (c.files || []).length > 0;
          const descLen = (c.description || '').length;
          const hasSep = (c.description || '').includes('----------') || (c.description || '').includes('<hr');
          if (hasFiles || descLen > 200) console.log(`    ⚠️ Звонок без транскрибации: comment ${c.id}, desc=${descLen}б, sep=${hasSep}, files=${hasFiles}`);
        }
        if (!transcription && POLZA_KEY) {
          transcription = await transcribeCallIfNeeded({ transcription, files: c.files || [] }, transcriptionCache);
          if (transcription) whisperCount++;
        }
      }
      // note-комментарии с mp3-файлами "Запись звонка" — тоже транскрибируем
      if (!transcription && type === 'note' && OPENAI_KEY) {
        const cFiles = c.files || [];
        const hasCallRecording = cFiles.some(f => {
          const fn = (f.name || f.fileName || '').toLowerCase();
          return fn.endsWith('.mp3') && fn.includes('запись звонка');
        });
        if (hasCallRecording) {
          type = 'inCall'; // помечаем как звонок
          transcription = await transcribeCallIfNeeded({ transcription: null, files: cFiles }, transcriptionCache);
          if (transcription) whisperCount++;
        }
      }

      const files = (c.files || []).map(f => f.name || f.fileName || '').filter(Boolean);

      parsed.push({
        id: c.id, date: dt.date || '', time: dt.time || '',
        type, text: desc.substring(0, 800),
        owner: c.owner?.name || '',
        transcription, files,
      });
    }
    return parsed;
  }

  // Собираем ID подзадач для загрузки комментариев
  const subtaskIdsForComments = new Set();
  for (const t of recentActive) {
    for (const stId of (parentToSubtasks[t.id] || [])) subtaskIdsForComments.add(stId);
  }
  const totalToLoad = recentActive.length + subtaskIdsForComments.size;
  console.log(`  💬 Комментарии ${recentActive.length} сделок + ${subtaskIdsForComments.size} подзадач...`);

  // Собираем все задачи для загрузки: сделки + их подзадачи
  const commentJobs = [];
  for (const t of recentActive) {
    commentJobs.push({ taskId: t.id, parentId: t.id });
    for (const stId of (parentToSubtasks[t.id] || [])) {
      commentJobs.push({ taskId: stId, parentId: t.id });
    }
  }
  let loadIdx = 0;
  await parallelMap(commentJobs, async (job) => {
    const comments = await getTaskComments(job.taskId);
    const parsed = await parseComments(comments);
    // Мёржим: подзадачи → в родителя, основные → напрямую
    if (job.taskId === job.parentId) {
      commentsByTask[job.parentId] = parsed;
    } else if (parsed.length) {
      if (!commentsByTask[job.parentId]) commentsByTask[job.parentId] = [];
      commentsByTask[job.parentId].push(...parsed);
    }
    loadIdx++;
    if (loadIdx % 10 === 0) process.stdout.write(`\r    [${loadIdx}/${totalToLoad}]`);
  }, CONCURRENCY);
  console.log(`\r    [${totalToLoad}/${totalToLoad}]`);
  if (whisperCount) console.log(`  🎤 Whisper транскрибировал: ${whisperCount} звонков`);

  // === Звонки из контактов (контрагентов) ===
  // Собираем уникальных контрагентов из активных сделок (любой контрагент, даже без имени)
  const contactToTasks = {}; // contactId -> [taskId, ...]
  let skippedNoId = 0;
  for (const t of recentActive) {
    const cpId = (t.counterparty?.id || '').replace('contact:', '');
    if (!cpId) {
      if (t.counterparty?.name) skippedNoId++;
      continue;
    }
    if (!contactToTasks[cpId]) contactToTasks[cpId] = [];
    contactToTasks[cpId].push(t.id);
  }
  if (skippedNoId) console.log(`    ⚠️ ${skippedNoId} сделок с контрагентом без ID — звонки из контакта не загружены`);
  const uniqueContacts = Object.keys(contactToTasks);
  console.log(`  👤 Звонки из ${uniqueContacts.length} контактов...`);

  const contactCallsByTask = {}; // taskId -> [{...call}]
  let contactCallsTotal = 0;
  let contactIdx = 0;
  await parallelMap(uniqueContacts, async (cpId) => {
    const comments = await getContactComments(cpId);

    for (const c of comments) {
      const desc = stripHtml(c.description);
      const descLow = desc.toLowerCase();
      const dtRaw = c.dateTime || {};
      const dt = utcToMsk(dtRaw.date, dtRaw.time); // UTC → МСК
      let type = null;
      if (descLow.startsWith('исходящий звонок')) type = 'outCall';
      else if (descLow.startsWith('входящий звонок')) type = 'inCall';
      // Робот Аргон: звонки внутри текста (не в начале)
      else if (descLow.includes('исходящий звонок')) type = 'outCall';
      else if (descLow.includes('входящий звонок')) type = 'inCall';

      // note-комментарии с mp3 "Запись звонка" — тоже звонок
      if (!type) {
        const cFiles = c.files || [];
        const hasCallRecording = cFiles.some(f => {
          const fn = (f.name || f.fileName || '').toLowerCase();
          return fn.endsWith('.mp3') && fn.includes('запись звонка');
        });
        if (hasCallRecording) type = 'inCall';
      }
      if (!type) continue;

      let transcription = extractTranscription(c.description);
      if (!transcription && POLZA_KEY) {
        transcription = await transcribeCallIfNeeded({ transcription, files: c.files || [] }, transcriptionCache);
        if (transcription) whisperCount++;
      }
      const callData = {
        id: c.id, date: dt.date || '', time: dt.time || '',
        type, text: desc.substring(0, 800),
        owner: c.owner?.name || '',
        transcription,
        source: 'contact',
      };

      // Привязываем звонок только к ОДНОЙ сделке: самой свежей активной, иначе к любой свежей
      const taskIds = contactToTasks[cpId];
      let bestTaskId = null;
      if (taskIds.length === 1) {
        bestTaskId = taskIds[0];
      } else {
        // Функция: дата последнего действия в сделке (комментарий или звонок)
        const lastActivityDate = (tid) => {
          let latest = '';
          for (const c of (commentsByTask[tid] || [])) { if (c.date > latest) latest = c.date; }
          for (const c of (callsByTask[tid] || [])) { if (c.date > latest) latest = c.date; }
          return latest;
        };
        // Разделяем на активные и завершённые
        const taskMap = {};
        for (const t of recentActive) taskMap[t.id] = t;
        const activeTids = taskIds.filter(tid => {
          const t = taskMap[tid];
          return t && !SKIP_STATUSES.includes(t.status?.name || '');
        });
        const pool = activeTids.length > 0 ? activeTids : taskIds;
        // Выбираем с самым свежим действием
        let bestDate = '';
        for (const tid of pool) {
          const d = lastActivityDate(tid);
          if (d > bestDate) { bestDate = d; bestTaskId = tid; }
        }
        if (!bestTaskId) bestTaskId = taskIds[0]; // fallback
      }
      // Привязываем к одной сделке
      if (!contactCallsByTask[bestTaskId]) contactCallsByTask[bestTaskId] = [];
      const existing = (commentsByTask[bestTaskId] || []);
      const isDupe = existing.some(e =>
        (e.type === 'outCall' || e.type === 'inCall') &&
        e.date === callData.date &&
        Math.abs(timeToMinNode(e.time) - timeToMinNode(callData.time)) < 5
      );
      if (!isDupe) {
        contactCallsByTask[bestTaskId].push(callData);
        contactCallsTotal++;
      }
    }
    contactIdx++;
    if (contactIdx % 10 === 0) process.stdout.write(`\r    [${contactIdx}/${uniqueContacts.length}]`);
  }, 5); // меньше параллельных запросов к контактам — Planfix не справляется с 10
  console.log(`\r    [${uniqueContacts.length}/${uniqueContacts.length}]`);
  console.log(`    ✅ ${contactCallsTotal} звонков из контактов`);

  // Формируем карточки сделок
  const dealCards = dealTasks.map(t => {
    const cf = {};
    for (const c of (t.customFieldData || [])) cf[c.field.id] = { name: c.field.name, value: c.value, str: c.stringValue || '' };

    const calls = (callsByTask[t.id] || []).filter(c => c.employee.includes(mgrPfName));
    const analyses = (analysisByTask[t.id] || []).filter(a => a.employee.includes(mgrPfName));
    // Комментарии — от ВСЕХ (КП может отправить другой менеджер), но исключаем ИИ-рекомендации
    const taskComments = (commentsByTask[t.id] || []).filter(c => {
      const txt = (c.text || '').toLowerCase();
      // Исключаем комментарии с ИИ-рекомендациями и ИИ-оценками
      if (txt.includes('ии-рекомендаци') || txt.includes('ии рекомендаци') || txt.includes('ai-рекомендаци') || txt.includes('рекомендации ии') || txt.includes('ии-оценка сделки') || txt.includes('🤖 ии-оценка') || txt.includes('баллы зп:')) return false;
      return true;
    });
    const contactCalls = (contactCallsByTask[t.id] || []).filter(c => c.owner.includes(mgrPfName));
    // Мёржим комментарии: задача (от всех) + звонки из контакта (только от менеджера)
    const comments = [...taskComments, ...contactCalls];
    const totalDur = calls.reduce((s, c) => s + c.duration, 0);

    // "Новая" = создана в день отчёта + статус НЕ "Новая" (в "Новая" может быть спам)
    const createdDate = t.dateTime?.date || t.dateCreated?.date || '';
    const isNew = createdDate === reportDate && (t.status?.name || '') !== 'Новая';

    return {
      id: t.id, name: t.name, status: t.status?.name || '?',
      template: t.template?.name || '',
      counterparty: t.counterparty?.name || '—',
      dateCreated: t.dateTime?.date || t.dateCreated?.date || '',
      dealSum: parseFloat(cf[67906]?.value || 0) || 0,
      workDesc: extractWorkDesc(t.name),
      isActive: !SKIP_STATUSES.includes(t.status?.name || ''),
      isNew,
      calls, analyses, comments,
      totalCalls: calls.length,
      totalDuration: totalDur,
      totalAnalyses: analyses.length,
      avgBalls: analyses.length ? Math.round(analyses.reduce((s, a) => s + a.totalBalls, 0) / analyses.length * 10) / 10 : null,
    };
  });

  // === Дневная активность за reportDate ===
  const reportDMY = reportDate; // DD-MM-YYYY
  const reportDateObj = parsePfDate(reportDate);
  const dailyActivity = {
    newDeals: [],
    workedDeals: [],
    totalActive: activeTasks.length,
  };

  for (const card of dealCards) {
    if (!card.isActive) continue;
    const createdOnDate = isSameDay(card.dateCreated, reportDateObj);
    const isManagerAction = c => c.date === reportDMY && c.owner && c.owner.includes(mgrPfName);
    const hasActivity = card.comments.some(isManagerAction) ||
      card.calls.some(c => c.date === reportDMY);

    // Входящая активность (клиенты, другие сотрудники) — не робот, не менеджер
    const isOtherHuman = c => c.date === reportDMY && c.owner && !c.owner.includes(mgrPfName) && !c.owner.toLowerCase().includes('robot') && !(c.text||'').includes('целевое действие') && !(c.text||'').includes('Статус изменён');
    const hasOtherActivity = card.comments.some(isOtherHuman);

    if (createdOnDate) {
      dailyActivity.newDeals.push({ id: card.id, name: card.name, status: card.status, counterparty: card.counterparty });
    } else if (hasActivity) {
      const dayActions = [];
      for (const c of card.comments.filter(c => c.date === reportDMY && c.owner && c.owner.includes(mgrPfName))) {
        dayActions.push({ type: c.type, text: c.text.substring(0, 100), time: c.time });
      }
      dailyActivity.workedDeals.push({
        id: card.id, name: card.name, status: card.status,
        counterparty: card.counterparty, actions: dayActions,
      });
    }

    // Входящие (клиент/другие написали, но менеджер не взаимодействовал)
    if (!hasActivity && !createdOnDate && hasOtherActivity) {
      const otherActions = [];
      for (const c of card.comments.filter(isOtherHuman)) {
        otherActions.push({ type: c.type, text: c.text.substring(0, 100), time: c.time, owner: c.owner });
      }
      if (!dailyActivity.incomingDeals) dailyActivity.incomingDeals = [];
      dailyActivity.incomingDeals.push({
        id: card.id, name: card.name, status: card.status,
        counterparty: card.counterparty, actions: otherActions, dealSum: card.dealSum || 0,
      });
    }
  }

  // === Хелпер: собрать дневную активность для конкретной даты ===
  function buildDayActivityServer(dateDMY) {
    const dateObj = parsePfDate(dateDMY);
    const result = [];
    for (const card of dealCards) {
      if (!card.isActive) continue;
      const createdOnDate = isSameDay(card.dateCreated, dateObj);
      // ПРАВИЛО: сделка попадает в день ТОЛЬКО если МЕНЕДЖЕР имел активность (не робот)
      const isManagerAction = c => c.owner && c.owner.includes(mgrPfName);
      const dayMgrComments = card.comments.filter(c => c.date === dateDMY && isManagerAction(c));
      const dayCalls = card.calls.filter(c => c.date === dateDMY);
      const hasMgrActivity = dayMgrComments.length > 0 || dayCalls.length > 0;
      if (!hasMgrActivity && !createdOnDate) continue;
      // Если менеджер активен — берём ВСЕ комментарии за день (включая от контактов/роботов для контекста)
      const dayComments = hasMgrActivity ? card.comments.filter(c => c.date === dateDMY) : [];

      const actions = dayComments.map(c => ({
        type: c.type, time: c.time, text: c.text,
        owner: c.owner, transcription: c.transcription,
        source: c.source || 'deal', files: c.files || [],
      }));
      for (const call of dayCalls) {
        const isDupe = actions.some(a =>
          (a.type === 'outCall' || a.type === 'inCall') &&
          Math.abs(timeToMinNode(a.time) - timeToMinNode(call.time)) < 5
        );
        if (!isDupe) {
          actions.push({
            type: call.type === 'Входящий' ? 'inCall' : 'outCall',
            time: call.time, text: `${call.type} ${call.contact} ${call.phone}`.trim(),
            owner: call.employee, transcription: null, source: 'datatag',
            duration: call.duration,
          });
        }
      }
      actions.sort((a, b) => timeToMinNode(a.time) - timeToMinNode(b.time));
      const dayAnalyses = card.analyses.filter(a => a.date === dateDMY);
      const scriptHistory = {
        total: card.analyses.length,
        everHowWeWork: card.analyses.some(a => a.howWeWork === 'Да'),
        everCallToAction: card.analyses.some(a => a.callToAction === 'Да'),
        everSentInvoice: card.analyses.some(a => a.sentInvoice === 'Да'),
        everAllFour: card.analyses.some(a => a.allFour === 'Да'),
        bestScore: card.analyses.length ? Math.max(...card.analyses.map(a => a.totalBalls)) : 0,
        customerKnowsCompany: card.analyses.some(a => a.howWeWork === 'Да'),
      };
      result.push({
        deal: { id: card.id, name: card.name, status: card.status, counterparty: card.counterparty, dealSum: card.dealSum || 0, workDesc: card.workDesc || '' },
        isNew: createdOnDate,
        actions,
        dayCalls: actions.filter(a => a.type === 'outCall' || a.type === 'inCall').length,
        planfixScript: dayAnalyses.length ? dayAnalyses[0] : null,
        allComments: card.comments,
        allCalls: card.calls,
        allAnalyses: card.analyses,
        scriptHistory,
        aiAssessment: null,
      });
    }
    return result;
  }

  // === Формируем ИИ-оценку для ВСЕХ дней с активностью ===
  const aiCache = loadAiCache();
  const multiDayActivity = {}; // { "DD-MM-YYYY": [ dealActivity, ... ] }
  const multiDaySummary = {};  // { "DD-MM-YYYY": "summary text" }

  // Собираем уникальные даты с активностью МЕНЕДЖЕРА (звонки + анализы — они фильтруются по менеджеру)
  // Комментарии от всех людей не должны раздувать список дат
  const allDatesSet = new Set();
  for (const card of dealCards) {
    if (!card.isActive) continue;
    for (const c of card.calls) if (c.date) allDatesSet.add(c.date);
    // Из комментариев берём только даты за последние 30 дней (старые КП не создают "день активности")
    for (const c of card.comments) {
      if (!c.date) continue;
      const p = c.date.split('-');
      const d = new Date(p[2] + '-' + p[1] + '-' + p[0]);
      const daysAgo = (reportDateObj - d) / 86400000;
      if (daysAgo <= 30) allDatesSet.add(c.date);
    }
  }
  // Сортируем от новых к старым
  const daysList = [...allDatesSet].sort((a, b) => {
    const pa = a.split('-'), pb = b.split('-');
    const da = new Date(pa[2] + '-' + pa[1] + '-' + pa[0]);
    const db = new Date(pb[2] + '-' + pb[1] + '-' + pb[0]);
    return db - da;
  });
  console.log(`  🤖 Всего дней с активностью: ${daysList.length}`);

  // На CI ограничиваем количество дней для ИИ-оценки
  const daysToProcess = isCI ? daysList.slice(0, MAX_DAYS_CI) : daysList;
  if (isCI && daysList.length > MAX_DAYS_CI) {
    console.log(`  ⏱️ CI: обрабатываем ${MAX_DAYS_CI} из ${daysList.length} дней (остальные — из кэша)`);
  }

  let daysProcessed = 0;
  for (const dayDMY of daysToProcess) {
    // Проверка лимита времени
    if (isTimeUp()) {
      console.log(`\n  ⏱️ Лимит времени! Обработано ${daysProcessed} дней, сохраняю кэш...`);
      saveAiCache(aiCache);
      break;
    }

    const dayDeals = buildDayActivityServer(dayDMY);
    if (!dayDeals.length) continue;

    // ИИ-оценка каждой сделки за этот день
    if (DEEPSEEK_KEY || POLZA_KEY) {
      const cached = dayDeals.filter(da => aiCache[`assess_${da.deal.id}_${dayDMY}_v20`] || aiCache[`assess_${da.deal.id}_${dayDMY}_v20a`]).length;
      const needAi = dayDeals.length - cached;
      if (needAi > 0) {
        console.log(`  🤖 ИИ-оценка ${dayDeals.length} сделок за ${dayDMY} (${cached} из кэша)...`);
      } else {
        process.stdout.write(`  🤖 ${dayDMY}: ${dayDeals.length} сделок (кэш) `);
      }
      let aiIdx = 0;
      await parallelMap(dayDeals, async (da) => {
        if (!isTimeUp()) da.aiAssessment = await aiDealFullAssessment(da, dayDMY, aiCache);
        aiIdx++;
        if (needAi > 0) process.stdout.write(`\r    [${aiIdx}/${dayDeals.length}]`);
      }, CONCURRENCY);
      if (needAi > 0) console.log('\n    ✅');
      else console.log('✅');

      // ИИ итог дня
      multiDaySummary[dayDMY] = await aiDaySummary(dayDeals, dayDMY, aiCache, mgrAlias);

      // Сохраняем кэш после каждого дня (защита от таймаута)
      if (needAi > 0) saveAiCache(aiCache);
    }
    daysProcessed++;

    // Не сохраняем allComments/allCalls/allAnalyses в multiDay (экономим размер)
    multiDayActivity[dayDMY] = dayDeals.map(da => ({
      deal: da.deal, isNew: da.isNew, actions: da.actions,
      dayCalls: da.dayCalls, planfixScript: da.planfixScript,
      scriptHistory: da.scriptHistory, aiAssessment: da.aiAssessment,
    }));
  }

  // === Входящие обращения по дням (не от менеджера, не от роботов) ===
  const incomingByDate = {};
  for (const card of dealCards) {
    if (!card.isActive) continue;
    for (const c of card.comments) {
      if (!c.owner || c.owner.includes(mgrPfName) || c.owner.toLowerCase().includes('robot')) continue;
      if ((c.text||'').includes('целевое действие') || (c.text||'').includes('Статус изменён')) continue;
      if (!incomingByDate[c.date]) incomingByDate[c.date] = [];
      // Не дублировать сделку за один день
      const existing = incomingByDate[c.date].find(d => d.id === card.id);
      if (existing) {
        existing.actions.push({ type: c.type, text: (c.text||'').substring(0, 100), time: c.time, owner: c.owner });
      } else {
        incomingByDate[c.date].push({
          id: card.id, name: card.name, status: card.status,
          counterparty: card.counterparty, dealSum: card.dealSum || 0,
          actions: [{ type: c.type, text: (c.text||'').substring(0, 100), time: c.time, owner: c.owner }],
        });
      }
    }
  }

  // Для совместимости — reportDate
  const dailyDealActivity = multiDayActivity[reportDMY] || [];
  const aiDaySummaryText = multiDaySummary[reportDMY] || null;

  saveAiCache(aiCache);

  // === Проверка скрипта на новых сделках ===
  const newDealAnalyses = [];
  for (const card of dealCards) {
    if (!card.isNew) continue;
    for (const a of card.analyses) {
      newDealAnalyses.push({ ...a, dealId: card.id, dealName: card.name });
    }
  }
  const scriptCompliance = {
    total: newDealAnalyses.length,
    howWeWork: newDealAnalyses.filter(a => a.howWeWork === 'Да').length,
    callToAction: newDealAnalyses.filter(a => a.callToAction === 'Да').length,
    sentInvoice: newDealAnalyses.filter(a => a.sentInvoice === 'Да').length,
    allFour: newDealAnalyses.filter(a => a.allFour === 'Да').length,
    avgScore: newDealAnalyses.length
      ? Math.round(newDealAnalyses.reduce((s, a) => s + a.totalBalls, 0) / newDealAnalyses.length * 10) / 10
      : 0,
    details: newDealAnalyses,
  };

  // === Снимки воронки ===
  const prevSnapshot = loadPreviousSnapshot(snapshotFile);
  const funnelChanges = computeFunnelChanges(prevSnapshot, dealCards);
  const currentSnapshot = saveSnapshot(dealCards, snapshotFile);

  console.log(`  📊 Дневная активность: ${dailyActivity.newDeals.length} новых, ${dailyActivity.workedDeals.length} обработано`);
  console.log(`  🔄 Изменения воронки: ${funnelChanges.length}`);
  console.log(`  📝 Скрипт новых: ${scriptCompliance.total} анализов`);

  const allCalls = dealCards.flatMap(d => d.calls);
  const allAnalyses = dealCards.flatMap(d => d.analyses);

  // === Итоги для руководителя (день / неделя / месяц) ===
  const managerSummaries = { day: null, week: null, month: null };
  if (DEEPSEEK_KEY || POLZA_KEY) {
    console.log(`\n👔 Генерация отчёта для руководителя...`);
    managerSummaries.day = await aiManagerSummary(multiDayActivity, multiDaySummary, dealCards, funnelChanges, 1, reportDMY, aiCache, mgrAlias);
    if (managerSummaries.day) process.stdout.write('  ✅ День ');
    managerSummaries.week = await aiManagerSummary(multiDayActivity, multiDaySummary, dealCards, funnelChanges, 7, reportDMY, aiCache, mgrAlias);
    if (managerSummaries.week) process.stdout.write('✅ Неделя ');
    managerSummaries.month = await aiManagerSummary(multiDayActivity, multiDaySummary, dealCards, funnelChanges, 30, reportDMY, aiCache, mgrAlias);
    if (managerSummaries.month) console.log('✅ Месяц');
    saveAiCache(aiCache);
  }

  return {
    dealCards, dailyReports, allCalls, allAnalyses,
    dailyActivity, funnelChanges, scriptCompliance,
    dailyDealActivity, aiDaySummaryText,
    multiDayActivity, multiDaySummary,
    managerSummaries, incomingByDate,
    snapshotDate: prevSnapshot?.date || null,
  };
}

module.exports = {
  aiDealFullAssessment,
  aiDaySummary,
  aiManagerSummary,
  loadPreviousSnapshot,
  saveSnapshot,
  computeFunnelChanges,
  buildDealCards,
};
