// ============================================================
// assessment.js — ИИ-оценка отдельной сделки (скрипт продаж)
// ============================================================

const { calculateSalaryScore } = require('./scoring');
const { openaiChat } = require('../api/deepseek');
const { ensureDeal } = require('./history');
const { hasCallRecordingFile } = require('./transcription');

async function aiDealFullAssessment(dealActivity, reportDate, history, forceRefresh) {
  const deal = dealActivity.deal;
  const isSnow = (deal.name || '').toLowerCase().startsWith('вывоз снега');
  const cacheKey = `assess_${deal.id}_${reportDate}_${isSnow ? 'v20' : 'v20a'}`;
  // Проверяем в истории сделки (для reportDate — всегда пересчёт)
  if (!forceRefresh) {
    const dealHist = history.deals[String(deal.id)];
    if (dealHist && dealHist.assessments && dealHist.assessments[cacheKey]) return dealHist.assessments[cacheKey];
  }

  // Собираем данные, ЧЁТКО разделяя ЗВОНКИ и ПЕРЕПИСКУ
  const allC = dealActivity.allComments || [];
  const isCallLike = c => c.type === 'outCall' || c.type === 'inCall' || c.type === 'ndz';
  const needsTranscript = c => {
    if (!isCallLike(c) || c.transcription) return false;
    const duration = parseInt(c.duration || 0, 10) || 0;
    return hasCallRecordingFile(c.files || []) || duration > 0;
  };

  // ТРАНСКРИБАЦИИ — это единственное что доказывает устную речь в звонке
  const transcriptions = allC
    .filter(c => isCallLike(c) && c.transcription)
    .map(c => `[ЗВОНОК ${c.date} ${c.time}] ${c.transcription.substring(0, 2000)}`)
    .join('\n---\n');

  // ЗВОНКИ БЕЗ ТРАНСКРИБАЦИИ — только факт, длительность. Текст НЕ показываем (чтобы ИИ не путал с транскрибацией)
  const callsWithoutTr = allC
    .filter(needsTranscript)
    .map(c => {
      const dir = c.type === 'outCall' ? 'Исходящий' : c.type === 'inCall' ? 'Входящий' : 'НДЗ';
      const dur = c.duration ? Math.round(c.duration / 60) + 'м' : '?';
      return `[ЗВОНОК БЕЗ ТРАНСКРИБАЦИИ ${c.date} ${c.time}] ${dir} ${dur} — СОДЕРЖАНИЕ НЕИЗВЕСТНО`;
    })
    .join('\n');

  // Предварительная классификация: сколько звонков с/без транскрибации
  const callsWithTrCount = allC.filter(c => isCallLike(c) && c.transcription).length;
  const callsWithoutTrCount = allC.filter(needsTranscript).length;
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
    const isCall = a.type === 'outCall' || a.type === 'inCall' || a.type === 'ndz';
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
  "dealSituation": "1-2 предложения СОЛЬ: что клиент хочет, на каком этапе сделка, что мешает закрыть. Пример: 'Клиент хочет заасфальтировать 500м2 парковки, КП отправлено, ждём решение. Цена устраивает, вопрос по срокам.'",
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
  "dealSituation": "1-2 предложения СОЛЬ: что клиент хочет, на каком этапе сделка, что мешает закрыть. Пример: 'Клиент хочет заасфальтировать 500м2 парковки, КП отправлено, ждём решение. Цена устраивает, вопрос по срокам.'",
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
    // Сохраняем в историю сделки
    const dh = ensureDeal(history, deal.id);
    dh.assessments[cacheKey] = result;
    return result;
  } catch {
    const fallback = { overallVerdict: raw.substring(0, 500), missing: [], recommendations: [], nextStep: '', salaryScore: { total: 0, items: [] } };
    const dh = ensureDeal(history, deal.id);
    dh.assessments[cacheKey] = fallback;
    return fallback;
  }
}


module.exports = { aiDealFullAssessment };
