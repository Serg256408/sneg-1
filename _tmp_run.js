// ============================================================
// ТрансКом — Аналитика v8.0
// Дневной отчёт с ИИ-анализом, транскрибации, скрипт
// Запуск: node analytics.js "Боровая"              (сегодня)
//         node analytics.js "Боровая" 11-03-2026   (конкретный день)
//         node analytics.js "Боровая" 7            (дней назад для dataTags)
// ============================================================

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const os = require('os');

const API_URL = (process.env.PLANFIX_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.PLANFIX_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const TRANSCRIPTION_CACHE_FILE = path.join(__dirname, 'transcriptions_cache.json');
const AI_CACHE_FILE = path.join(__dirname, 'ai_cache.json');
const MANAGERS = {
  'Боровая': { userId: 41, name: 'Ия Боровая', pfName: 'Боровая' },
};

let useAxios = true, axios;
try { axios = require('axios'); } catch { useAxios = false; }

async function httpPost(url, body, headers) {
  if (useAxios) {
    try { return (await axios.post(url, body, { headers, timeout: 30000, maxRedirects: 10 })).data; }
    catch (e) { if (e.message?.includes('redirect')) { useAxios = false; return httpPost(url, body, headers); } throw e; }
  }
  const { execFileSync } = require('child_process');
  const tmp = path.join(os.tmpdir(), 'pf_' + Date.now() + '.json');
  try {
    fs.writeFileSync(tmp, JSON.stringify(body));
    const a = ['-s', '-L', '-X', 'POST', url];
    for (const [k, v] of Object.entries(headers || {})) a.push('-H', `${k}: ${v}`);
    a.push('-d', `@${tmp}`);
    return JSON.parse(execFileSync('curl', a, { encoding: 'utf8', timeout: 30000 }));
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
async function httpGet(url, headers) {
  if (useAxios) return (await axios.get(url, { headers, timeout: 30000 })).data;
  const { execFileSync } = require('child_process');
  const a = ['-s', '-L', url];
  for (const [k, v] of Object.entries(headers || {})) a.push('-H', `${k}: ${v}`);
  return JSON.parse(execFileSync('curl', a, { encoding: 'utf8', timeout: 30000 }));
}

const AUTH = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const pf = (ep, body) => httpPost(API_URL + ep, body, AUTH);
const pfGet = (ep) => httpGet(API_URL + ep, AUTH);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

function timeToMinNode(t) {
  const m = (t || '').match(/(\d+):(\d+)/);
  return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 0;
}

const CALL_TAG = 15900;
const ANALYSIS_TAG = 15920;
const DEAL_FIELDS = 'id,name,parent,status,dateCreated,counterparty,dataTags,67906,76880,76866,76868,76872,76874,76876,76878';
// Статусы которые НЕ анализируем (деньги уже поступили или завершена)
const SKIP_STATUSES = ['Выполнение Работы', 'Сделанная', 'Завершённая', 'Сделка завершена'];
const NEW_STATUSES = ['Новая', 'Обработка'];
const FUNNEL_ORDER = [
  'Новая','Обработка','В работе','Коммерческое предложение',
  'Вывезли/Нашли поставщика','Дожим','Договор и оплата',
  'Выполнение Работы','Сделанная','Сделка завершена'
];

function parseCfd(entry) {
  const r = {};
  for (const cf of (entry.customFieldData || []))
    r[cf.field.name] = cf.stringValue || (typeof cf.value === 'object' ? '' : String(cf.value ?? ''));
  return r;
}

function stripHtml(h) {
  return (h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»').replace(/&mdash;/g, '—').replace(/\n{3,}/g, '\n\n').trim();
}

// Извлечение транскрибации из комментария звонка
function extractTranscription(description) {
  const text = stripHtml(description);
  const sepIdx = text.indexOf('----------');
  if (sepIdx === -1) return null;
  const after = text.substring(sepIdx + 10).trim();
  if (!after || after.length < 10) return null;
  return after;
}

// ============ ТРАНСКРИБАЦИЯ ЧЕРЕЗ WHISPER ============

function loadTranscriptionCache() {
  try { return JSON.parse(fs.readFileSync(TRANSCRIPTION_CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveTranscriptionCache(cache) {
  fs.writeFileSync(TRANSCRIPTION_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function downloadPlanfixFile(fileId) {
  const { execFileSync } = require('child_process');
  const tmpFile = path.join(os.tmpdir(), `pf_audio_${fileId}.mp3`);
  try {
    execFileSync('curl', [
      '-s', '-L', '--ssl-no-revoke', '-o', tmpFile,
      `${API_URL}/file/${fileId}/download`,
      '-H', `Authorization: Bearer ${TOKEN}`,
    ], { timeout: 60000 });
    const stat = fs.statSync(tmpFile);
    if (stat.size < 100) { try { fs.unlinkSync(tmpFile); } catch {} return null; }
    return tmpFile;
  } catch { return null; }
}

async function whisperTranscribe(audioPath) {
  if (!OPENAI_KEY) return null;
  const { execFileSync } = require('child_process');
  try {
    const result = execFileSync('curl', [
      '-s', '-L', '--ssl-no-revoke',
      'https://api.openai.com/v1/audio/transcriptions',
      '-H', `Authorization: Bearer ${OPENAI_KEY}`,
      '-F', `file=@${audioPath}`,
      '-F', 'model=whisper-1',
      '-F', 'language=ru',
      '-F', 'response_format=text',
    ], { encoding: 'utf8', timeout: 120000 });
    return result.trim() || null;
  } catch { return null; }
}

async function transcribeCallIfNeeded(comment, cache) {
  // Already has transcription
  if (comment.transcription) return comment.transcription;
  // No audio files
  const files = comment.files || [];
  const audioFile = files.find(f => (f.name || '').toLowerCase().endsWith('.mp3'));
  if (!audioFile) return null;
  // Check cache
  const cacheKey = String(audioFile.id);
  if (cache[cacheKey]) return cache[cacheKey];
  // Download and transcribe
  const audioPath = downloadPlanfixFile(audioFile.id);
  if (!audioPath) return null;
  try {
    const text = await whisperTranscribe(audioPath);
    if (text) {
      cache[cacheKey] = text;
      saveTranscriptionCache(cache);
    }
    return text;
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }
}

// ============ OPENAI CHAT (GPT) ============

function loadAiCache() {
  try { return JSON.parse(fs.readFileSync(AI_CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveAiCache(cache) {
  fs.writeFileSync(AI_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

async function openaiChat(prompt, systemPrompt, maxTokens, model) {
  // Определяем провайдера по модели
  const isDeepSeek = model && model.startsWith('deepseek');
  const apiKey = isDeepSeek ? DEEPSEEK_KEY : OPENAI_KEY;
  const apiUrl = isDeepSeek ? 'https://api.deepseek.com/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
  if (!apiKey) return null;
  const { execFileSync } = require('child_process');
  const body = JSON.stringify({
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt || 'Ты аналитик отдела продаж компании по вывозу снега ТрансКом. Отвечай кратко, по-русски.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: maxTokens || 1000,
  });
  const tmp = path.join(os.tmpdir(), 'oai_' + Date.now() + '.json');
  const maxRetries = 3;
  try {
    fs.writeFileSync(tmp, body);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const r = execFileSync('curl', [
          '-s', '-L', '--ssl-no-revoke', '--connect-timeout', '15', '--max-time', '90', '-X', 'POST',
          apiUrl,
          '-H', `Authorization: Bearer ${apiKey}`,
          '-H', 'Content-Type: application/json',
          '-d', `@${tmp}`,
        ], { encoding: 'utf8', timeout: 120000 });
        const parsed = JSON.parse(r);
        if (parsed.error) {
          console.error(`    ⚠️ API error: ${parsed.error.message}`);
          if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
          return null;
        }
        return (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || null;
      } catch (e) {
        if (attempt < maxRetries) {
          process.stdout.write(`⟳`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
          continue;
        }
        console.error(`    ⚠️ ${isDeepSeek ? 'DeepSeek' : 'OpenAI'} error (${maxRetries} attempts): ${e.message.substring(0, 100)}`);
        return null;
      }
    }
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Комплексная оценка сделки ИИ — вся история + расширенные критерии скрипта
async function aiDealFullAssessment(dealActivity, reportDate, aiCache) {
  const deal = dealActivity.deal;
  const cacheKey = `assess_${deal.id}_${reportDate}_v17`;
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
  vpTextDetect.manyObjects = allTextJoined.includes('много объектов') || allTextJoined.includes('множество объектов');
  vpTextDetect.govClients = allTextJoined.includes('госдум') || allTextJoined.includes('госучрежд') || allTextJoined.includes('мосгордум');
  vpTextDetect.reliableInSnow = allTextJoined.includes('снегопад') || allTextJoined.includes('надёжн') || allTextJoined.includes('надежн');
  vpTextDetect.manyVehicles = allTextJoined.includes('парк техники') || allTextJoined.includes('много техники') || allTextJoined.includes('большой парк');

  // Те же слова в транскрибациях
  const vpCallDetect = {};
  vpCallDetect.since2014 = allTrJoined.includes('2014') || allTrJoined.includes('четырнадцатого');
  vpCallDetect.manyObjects = allTrJoined.includes('много объектов') || allTrJoined.includes('множество объектов');
  vpCallDetect.govClients = allTrJoined.includes('госдум') || allTrJoined.includes('госучрежд') || allTrJoined.includes('мосгордум');
  vpCallDetect.reliableInSnow = allTrJoined.includes('снегопад') || allTrJoined.includes('надёжн') || allTrJoined.includes('надежн');
  vpCallDetect.manyVehicles = allTrJoined.includes('парк техники') || allTrJoined.includes('много техники') || allTrJoined.includes('большой парк');

  // Формируем подсказку для ИИ
  const preDetectHints = [];
  if (preDetect.cpFile) preDetectHints.push(`📎 КП НАЙДЕНО: файл "${preDetect.cpFile.name}" (${preDetect.cpFile.date})`);
  if (preDetect.presentationFile) preDetectHints.push(`📎 ПРЕЗЕНТАЦИЯ НАЙДЕНА: файл "${preDetect.presentationFile.name}" (${preDetect.presentationFile.date})`);
  if (preDetect.invoiceFile) preDetectHints.push(`📎 СЧЁТ НАЙДЕН: файл "${preDetect.invoiceFile.name}" (${preDetect.invoiceFile.date})`);
  const vpItems = ['since2014', 'manyObjects', 'govClients', 'reliableInSnow', 'manyVehicles'];
  const vpLabels = { since2014: 'С 2014 года', manyObjects: 'Много объектов', govClients: 'Госучреждения', reliableInSnow: 'Надёжность в снегопады', manyVehicles: 'Много техники' };
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

ПРАВИЛА ОЦЕНКИ:
1. УСТНАЯ ПРЕЗЕНТАЦИЯ — подпункты: с 2014 года, много объектов, госучреждения, надёжность в снегопады, много техники. Каждый подпункт done:true ТОЛЬКО если конкретно упомянут в транскрибации (source="call") или комментарии (source="text"). В note укажи ЦИТАТУ.
2. КАК МЫ РАБОТАЕМ — done:true ТОЛЬКО если менеджер ДЕТАЛЬНО описал клиенту весь процесс работы на объекте: какая техника приедет, что будут делать рабочие, как будет выглядеть результат. Пример для вывоза снега: "приезжает самосвал 20м3 и трактор-погрузчик, чистит территорию, грузит снег, вывозим на свалку, талоны дадим". НЕ считается: общие фразы "работаем по договору", "у нас договор с Мосводоканалом", просто упоминание техники без описания процесса. source="call" только из транскрибации.
3. ПРЕЗЕНТАЦИЯ (ФАЙЛ) — ищи в [Файлы:...]: "презентация", "карточка компании", "presentation".
4. КП — ищи в [Файлы:...] и тексте: "кп", "коммерческое предложение", "КП_", "К.П.".
5. СЧЁТ — ищи в [Файлы:...] и тексте: "счёт", "счет", "invoice".
6. ПРИЗЫВ К ДЕЙСТВИЮ — менеджер АКТИВНО подталкивает клиента к заказу конкретными словами. Примеры ПРАВИЛЬНОГО призыва: "давайте вывозить", "давайте я поставлю вас в график", "мы готовы работать, когда приезжать?", "давайте сделаем, у вас всё будет хорошо", "давайте запланируем вывоз на эту неделю". НЕ СЧИТАЕТСЯ призывом: "жду вашего решения", "будем рады сотрудничеству", "обращайтесь если что", "пишите если понадобится" — это ПАССИВНОЕ ожидание, а не призыв.
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
  "overallVerdict": "краткий вердикт 1-2 предложения"
}`;

  const raw = await openaiChat(prompt, 'Ты аналитик отдела продаж компании ТрансКом (вывоз снега). Анализируй историю сделок и оценивай выполнение скрипта продаж. Отвечай строго в JSON.', 2000, 'deepseek-chat');
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
      const vpKeys = ['since2014', 'manyObjects', 'govClients', 'reliableInSnow', 'manyVehicles'];
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

    // Рассчитываем баллы для ЗП (ПОСЛЕ всех валидаций)
    result.salaryScore = calculateSalaryScore(result);
    aiCache[cacheKey] = result;
    saveAiCache(aiCache);
    return result;
  } catch {
    // Если не удалось разобрать JSON — сохраняем как текст
    const fallback = { overallVerdict: raw.substring(0, 500), missing: [], recommendations: [], salaryScore: { total: 0, items: [] } };
    aiCache[cacheKey] = fallback;
    saveAiCache(aiCache);
    return fallback;
  }
}

// Баллы для ЗП по сделке
function calculateSalaryScore(aa) {
  const items = [];
  let total = 0;

  // КП: 1 балл
  if (aa.cp && aa.cp.done) {
    items.push({ name: 'КП', score: 1, note: aa.cp.note || '' });
    total += 1;
  }

  // Счёт: 1 балл
  if (aa.invoice && aa.invoice.done) {
    items.push({ name: 'Счёт', score: 1, note: aa.invoice.note || '' });
    total += 1;
  }

  // Презентация (файл): 1 балл
  if (aa.writtenPresentation && aa.writtenPresentation.done) {
    items.push({ name: 'Презентация (файл)', score: 1, note: aa.writtenPresentation.note || '' });
    total += 1;
  }

  // Устная презентация: в звонке 3 балла, в переписке 1.5 балла
  const vp = aa.verbalPresentation;
  if (vp && vp.overall) {
    const src = (vp.source || '').toLowerCase();
    if (src === 'call' || src === 'звонок') {
      items.push({ name: 'Устная презентация (звонок)', score: 3, note: vp.quality || '' });
      total += 3;
    } else {
      items.push({ name: 'Устная презентация (переписка)', score: 1.5, note: vp.quality || '' });
      total += 1.5;
    }
  }

  // Как мы работаем: в звонке 3 балла, в переписке 1.5 балла
  const hw = aa.howWeWork;
  if (hw && hw.done) {
    const src = (hw.source || '').toLowerCase();
    if (src === 'call' || src === 'звонок') {
      items.push({ name: 'Как мы работаем (звонок)', score: 3, note: hw.note || '' });
      total += 3;
    } else {
      items.push({ name: 'Как мы работаем (переписка)', score: 1.5, note: hw.note || '' });
      total += 1.5;
    }
  }

  // Призыв к действию: 3 балла
  if (aa.callToAction && aa.callToAction.done) {
    items.push({ name: 'Призыв к действию', score: 3, note: aa.callToAction.note || '' });
    total += 3;
  }

  return { total, max: 12, items };
}

async function aiDaySummary(dailyDeals, reportDate, aiCache) {
  const cacheKey = `day_${reportDate}_${dailyDeals.length}_v3`;
  if (aiCache[cacheKey]) return aiCache[cacheKey];

  const dealsText = dailyDeals.map(d => {
    const a = d.aiAssessment;
    const verdict = a ? a.overallVerdict || '' : '';
    const acts = (d.actions || []).map(x => `${x.time} ${x.type}`).join(', ');
    return `- "${d.deal.name}" (${d.deal.status}): ${acts || 'нет действий'}${verdict ? '\n  ' + verdict : ''}`;
  }).join('\n');

  const prompt = `Резюмируй рабочий день менеджера по продажам (вывоз снега) за ${reportDate}.

Обработано сделок: ${dailyDeals.length}
Новых: ${dailyDeals.filter(d => d.isNew).length}
Старых: ${dailyDeals.filter(d => !d.isNew).length}

Сделки:
${dealsText}

Кратко (3-5 предложений): ключевые результаты дня, сильные стороны, что можно улучшить, рекомендации.`;

  const result = await openaiChat(prompt);
  if (result) {
    aiCache[cacheKey] = result;
    saveAiCache(aiCache);
  }
  return result;
}

// Парсим дату DD-MM-YYYY в объект Date
function parsePfDate(dateStr) {
  if (!dateStr) return null;
  const m1 = dateStr.match(/(\d{2})-(\d{2})-(\d{4})/);
  const m2 = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(dateStr);
  if (m1) return new Date(`${m1[3]}-${m1[2]}-${m1[1]}`);
  return null;
}

// Формат даты для сегодня
function todayStr() {
  const now = new Date();
  return `${pad2(now.getDate())}-${pad2(now.getMonth()+1)}-${now.getFullYear()}`;
}

function isSameDay(dateStr, refDate) {
  const d = parsePfDate(dateStr);
  if (!d) return false;
  return d.getFullYear() === refDate.getFullYear() &&
    d.getMonth() === refDate.getMonth() &&
    d.getDate() === refDate.getDate();
}

// ============ СНИМКИ ВОРОНКИ ============

const SNAPSHOT_FILE = path.join(__dirname, 'funnel_snapshot.json');

function loadPreviousSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch { return null; }
}

function saveSnapshot(dealCards) {
  const snapshot = {
    date: new Date().toISOString(),
    deals: {}
  };
  for (const d of dealCards) {
    snapshot.deals[d.id] = { name: d.name, status: d.status };
  }
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
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

// ============ СБОР ============

async function getAllTasks(userId) {
  const all = [];
  let offset = 0;
  while (true) {
    process.stdout.write(`  Сделки offset=${offset}...`);
    const d = await pf('/task/list', { offset, pageSize: 100,
      filters: [{ type: 97, operator: 'equal', value: `user:${userId}` }],
      fields: DEAL_FIELDS,
    });
    const tasks = d.tasks || [];
    console.log(` ${tasks.length}`);
    if (!tasks.length) break;
    all.push(...tasks);
    if (tasks.length < 100) break;
    offset += 100;
  }
  return all;
}

async function getTaskComments(taskId) {
  try {
    const d = await pf(`/task/${taskId}/comments/list`, {
      offset: 0, pageSize: 100, fields: 'id,description,type,dateTime,owner,files',
    });
    return d.comments || [];
  } catch { return []; }
}

async function getContactComments(contactId) {
  try {
    const id = String(contactId).replace('contact:', '');
    const d = await pf(`/contact/${id}/comments/list`, {
      offset: 0, pageSize: 100, fields: 'id,description,type,dateTime,owner,files',
    });
    return d.comments || [];
  } catch (e) {
    console.error(`    ⚠️ Contact ${contactId} error: ${e.message}`);
    return [];
  }
}

// ============ ОБРАБОТКА ============

async function buildDealCards(tasks, mgrPfName, reportDate) {
  const reportTasks = tasks.filter(t => (t.name || '').startsWith('Отчет'));
  // Разделяем: родительские сделки и подзадачи
  const subtasks = tasks.filter(t => t.parent && t.parent.id && !(t.name || '').startsWith('Отчет'));
  const dealTasks = tasks.filter(t => !(t.name || '').startsWith('Отчет') && !(t.parent && t.parent.id));
  // Карта: subtaskId -> parentId
  const subtaskToParent = {};
  for (const st of subtasks) subtaskToParent[st.id] = st.parent.id;
  // Активные = от "Новая" до "Договор и оплата" (без "Выполнение Работы" и далее)
  const activeTasks = dealTasks.filter(t => !SKIP_STATUSES.includes(t.status?.name || ''));
  if (subtasks.length) console.log(`  📎 Подзадачи: ${subtasks.length} шт → данные мёржатся в родителя`);
  console.log(`  📋 Сделок: ${dealTasks.length}, активных: ${activeTasks.length} (исключены: Выполнение Работы и завершённые)`);

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
  const recentActive = [...priorityTasks, ...otherTasks].slice(0, Math.max(80, priorityTasks.length));
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
      const dt = c.dateTime || {};
      let type = 'note';
      if (desc.toLowerCase().startsWith('исходящий звонок')) type = 'outCall';
      else if (desc.toLowerCase().startsWith('входящий звонок')) type = 'inCall';
      else if (desc.toLowerCase().startsWith('ндз')) type = 'ndz';

      let transcription = null;
      if (type === 'outCall' || type === 'inCall') {
        transcription = extractTranscription(c.description);
        if (!transcription && OPENAI_KEY) {
          transcription = await transcribeCallIfNeeded({ transcription, files: c.files || [] }, transcriptionCache);
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

  let loadIdx = 0;
  for (const t of recentActive) {
    if (loadIdx % 10 === 0) process.stdout.write(`\r    [${loadIdx + 1}/${totalToLoad}]`);
    const comments = await getTaskComments(t.id);
    commentsByTask[t.id] = await parseComments(comments);
    loadIdx++;
    await sleep(30);

    // Загружаем комментарии подзадач → мёржим в родителя
    for (const stId of (parentToSubtasks[t.id] || [])) {
      if (loadIdx % 10 === 0) process.stdout.write(`\r    [${loadIdx + 1}/${totalToLoad}]`);
      const stComments = await getTaskComments(stId);
      const stParsed = await parseComments(stComments);
      if (stParsed.length) {
        if (!commentsByTask[t.id]) commentsByTask[t.id] = [];
        commentsByTask[t.id].push(...stParsed);
      }
      loadIdx++;
      await sleep(30);
    }
  }
  console.log('');
  if (whisperCount) console.log(`  🎤 Whisper транскрибировал: ${whisperCount} звонков`);

  // === Звонки из контактов (контрагентов) ===
  // Собираем уникальных контрагентов из активных сделок
  const contactToTasks = {}; // contactId -> [taskId, ...]
  for (const t of recentActive) {
    const cpId = (t.counterparty?.id || '').replace('contact:', '');
    if (!cpId) continue;
    if (!contactToTasks[cpId]) contactToTasks[cpId] = [];
    contactToTasks[cpId].push(t.id);
  }
  const uniqueContacts = Object.keys(contactToTasks);
  console.log(`  👤 Звонки из ${uniqueContacts.length} контактов...`);

  const contactCallsByTask = {}; // taskId -> [{...call}]
  let contactCallsTotal = 0;
  for (let i = 0; i < uniqueContacts.length; i++) {
    const cpId = uniqueContacts[i];
    if (i % 10 === 0 && i > 0) process.stdout.write(`\r    [${i}/${uniqueContacts.length}]`);
    const comments = await getContactComments(cpId);
    for (const c of comments) {
      const desc = stripHtml(c.description);
      const dt = c.dateTime || {};
      let type = null;
      if (desc.toLowerCase().startsWith('исходящий звонок')) type = 'outCall';
      else if (desc.toLowerCase().startsWith('входящий звонок')) type = 'inCall';
      if (!type) continue;

      let transcription = extractTranscription(c.description);
      if (!transcription && OPENAI_KEY) {
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

      // Привязываем к связанным сделкам
      for (const taskId of contactToTasks[cpId]) {
        if (!contactCallsByTask[taskId]) contactCallsByTask[taskId] = [];
        // Дедупликация: не добавляем если уже есть звонок с таким же временем ±5мин в комментариях сделки
        const existing = (commentsByTask[taskId] || []);
        const isDupe = existing.some(e =>
          (e.type === 'outCall' || e.type === 'inCall') &&
          e.date === callData.date &&
          Math.abs(timeToMinNode(e.time) - timeToMinNode(callData.time)) < 5
        );
        if (!isDupe) {
          contactCallsByTask[taskId].push(callData);
          contactCallsTotal++;
        }
      }
    }
    await sleep(30);
  }
  if (uniqueContacts.length > 10) console.log('');
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
      // Исключаем комментарии с ИИ-рекомендациями (шаблон для будущих автоотчётов)
      if (txt.includes('ии-рекомендаци') || txt.includes('ии рекомендаци') || txt.includes('ai-рекомендаци') || txt.includes('рекомендации ии')) return false;
      return true;
    });
    const contactCalls = (contactCallsByTask[t.id] || []).filter(c => c.owner.includes(mgrPfName));
    // Мёржим комментарии: задача (от всех) + звонки из контакта (только от менеджера)
    const comments = [...taskComments, ...contactCalls];
    const totalDur = calls.reduce((s, c) => s + c.duration, 0);

    // Определяем "новая" ли сделка (по статусу)
    const isNew = NEW_STATUSES.includes(t.status?.name || '');

    return {
      id: t.id, name: t.name, status: t.status?.name || '?',
      counterparty: t.counterparty?.name || '—',
      dateCreated: t.dateCreated?.date || '',
      dealSum: parseFloat(cf[67906]?.value || 0) || 0,
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
    const hasActivity = card.comments.some(c => c.date === reportDMY) ||
      card.calls.some(c => c.date === reportDMY);

    if (createdOnDate) {
      dailyActivity.newDeals.push({ id: card.id, name: card.name, status: card.status, counterparty: card.counterparty });
    } else if (hasActivity) {
      const dayActions = [];
      for (const c of card.comments.filter(c => c.date === reportDMY)) {
        dayActions.push({ type: c.type, text: c.text.substring(0, 100), time: c.time });
      }
      dailyActivity.workedDeals.push({
        id: card.id, name: card.name, status: card.status,
        counterparty: card.counterparty, actions: dayActions,
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
      const dayComments = card.comments.filter(c => c.date === dateDMY);
      const dayCalls = card.calls.filter(c => c.date === dateDMY);
      if (!dayComments.length && !dayCalls.length && !createdOnDate) continue;

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
        deal: { id: card.id, name: card.name, status: card.status, counterparty: card.counterparty },
        isNew: createdOnDate || card.isNew,
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

  daysList.splice(2); for (const dayDMY of daysList) {
    const dayDeals = buildDayActivityServer(dayDMY);
    if (!dayDeals.length) continue;

    // ИИ-оценка каждой сделки за этот день
    if (OPENAI_KEY) {
      const cached = dayDeals.filter(da => aiCache[`assess_${da.deal.id}_${dayDMY}_v17`]).length;
      const needAi = dayDeals.length - cached;
      if (needAi > 0) {
        console.log(`  🤖 ИИ-оценка ${dayDeals.length} сделок за ${dayDMY} (${cached} из кэша)...`);
      } else {
        process.stdout.write(`  🤖 ${dayDMY}: ${dayDeals.length} сделок (кэш) `);
      }
      for (let i = 0; i < dayDeals.length; i++) {
        const da = dayDeals[i];
        if (needAi > 0) process.stdout.write(`\r    [${i + 1}/${dayDeals.length}] #${da.deal.id}`);
        da.aiAssessment = await aiDealFullAssessment(da, dayDMY, aiCache);
        await sleep(100);
      }
      if (needAi > 0) console.log('\n    ✅');
      else console.log('✅');

      // ИИ итог дня
      multiDaySummary[dayDMY] = await aiDaySummary(dayDeals, dayDMY, aiCache);
    }

    // Не сохраняем allComments/allCalls/allAnalyses в multiDay (экономим размер)
    multiDayActivity[dayDMY] = dayDeals.map(da => ({
      deal: da.deal, isNew: da.isNew, actions: da.actions,
      dayCalls: da.dayCalls, planfixScript: da.planfixScript,
      scriptHistory: da.scriptHistory, aiAssessment: da.aiAssessment,
    }));
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
  const prevSnapshot = loadPreviousSnapshot();
  const funnelChanges = computeFunnelChanges(prevSnapshot, dealCards);
  const currentSnapshot = saveSnapshot(dealCards);

  console.log(`  📊 Дневная активность: ${dailyActivity.newDeals.length} новых, ${dailyActivity.workedDeals.length} обработано`);
  console.log(`  🔄 Изменения воронки: ${funnelChanges.length}`);
  console.log(`  📝 Скрипт новых: ${scriptCompliance.total} анализов`);

  const allCalls = dealCards.flatMap(d => d.calls);
  const allAnalyses = dealCards.flatMap(d => d.analyses);

  return {
    dealCards, dailyReports, allCalls, allAnalyses,
    dailyActivity, funnelChanges, scriptCompliance,
    dailyDealActivity, aiDaySummaryText,
    multiDayActivity, multiDaySummary,
    snapshotDate: prevSnapshot?.date || null,
  };
}

// ============ HTML ============

function generateHtml(managerName, data) {
  // Безопасная сериализация JSON для встраивания в <script>
  const json = JSON.stringify(data)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--');
  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ТрансКом — ${managerName}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Manrope',system-ui,sans-serif;background:#0a0e1a;color:#e2e8f0;min-height:100vh}
.hdr{background:linear-gradient(135deg,#1e293b,#0f172a);border-bottom:1px solid rgba(59,130,246,.15);padding:14px 20px}
.hdr-in{max-width:1200px;margin:0 auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff}
.pbar{display:flex;gap:5px;margin-left:auto;flex-wrap:wrap}
.pbtn{padding:6px 12px;border-radius:7px;border:none;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;background:rgba(30,41,59,.8);color:#94a3b8;transition:.2s}
.pbtn.on{background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;box-shadow:0 2px 10px rgba(59,130,246,.3)}
.cnt{max-width:1200px;margin:0 auto;padding:16px}
.mets{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-bottom:14px}
.met{background:rgba(15,23,42,.7);border:1px solid rgba(255,255,255,.04);border-radius:12px;padding:10px;text-align:center}
.met-v{font-size:20px;font-weight:800;margin:2px 0}
.met-l{font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.tabs{display:flex;gap:0;border-bottom:1px solid rgba(255,255,255,.05);margin-bottom:14px;flex-wrap:wrap}
.tab{padding:8px 14px;cursor:pointer;color:#64748b;font-size:13px;font-weight:600;border-bottom:2px solid transparent;transition:.2s}
.tab.on{color:#60a5fa;border-color:#3b82f6;background:rgba(59,130,246,.05)}
.sec{background:rgba(15,23,42,.7);border:1px solid rgba(255,255,255,.04);border-radius:14px;padding:16px;margin-bottom:12px}
.sec h3{font-size:14px;font-weight:700;color:#f1f5f9;margin-bottom:10px}
.sec h4{font-size:13px;font-weight:600;color:#94a3b8;margin:10px 0 6px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:5px 8px;color:#64748b;font-weight:600;border-bottom:1px solid rgba(255,255,255,.08);font-size:11px;white-space:nowrap}
td{padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:top}
tr:hover td{background:rgba(59,130,246,.03)}
.bg{padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;white-space:nowrap}
.bg-g{background:rgba(52,211,153,.12);color:#34d399}
.bg-y{background:rgba(251,191,36,.12);color:#fbbf24}
.bg-r{background:rgba(248,113,113,.12);color:#f87171}
.bg-b{background:rgba(96,165,250,.12);color:#60a5fa}
.bg-p{background:rgba(167,139,250,.12);color:#a78bfa}
.yes{color:#34d399;font-weight:700}.no{color:#64748b}
.bar-bg{height:5px;background:rgba(30,41,59,.8);border-radius:3px;overflow:hidden;margin-top:2px}
.bar-f{height:100%;border-radius:3px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:700px){.grid2{grid-template-columns:1fr}.mets{grid-template-columns:repeat(3,1fr)}}
.deal-hdr{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px}
.deal-meta{font-size:11px;color:#64748b;display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
.deal-stat{display:flex;gap:12px;flex-wrap:wrap}
.deal-stat span{font-size:12px;font-weight:700}
.cmt{font-size:11px;color:#94a3b8;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.02)}
.cmt-type{font-size:10px;font-weight:700;margin-right:4px}
.no-data{text-align:center;padding:30px;color:#475569;font-size:14px}
.transcript{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.05);border-radius:8px;padding:10px;margin:6px 0;font-size:11px;line-height:1.6;color:#94a3b8;max-height:200px;overflow-y:auto;white-space:pre-wrap}
.toggle-btn{background:none;border:1px solid rgba(255,255,255,.08);color:#64748b;padding:2px 8px;border-radius:5px;cursor:pointer;font-size:10px;font-family:inherit}
.toggle-btn:hover{color:#60a5fa;border-color:rgba(59,130,246,.3)}
.act-card{background:rgba(15,23,42,.5);border:1px solid rgba(255,255,255,.04);border-radius:10px;padding:12px;margin-bottom:8px}
.act-card h4{margin:0 0 6px;font-size:13px;color:#f1f5f9}
.act-tag{display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;margin:2px}
.change-fwd{color:#34d399}.change-bwd{color:#f87171}
.ai-box{margin-top:10px;padding:10px;background:rgba(139,92,246,.06);border:1px solid rgba(139,92,246,.15);border-radius:8px}
.ai-label{font-size:11px;font-weight:700;color:#a78bfa;margin-bottom:4px}
.script-box{margin-top:10px;padding:10px;background:rgba(59,130,246,.04);border:1px solid rgba(59,130,246,.1);border-radius:8px}
/* Collapsible sections */
.coll{border-radius:10px;margin-top:10px;overflow:hidden;border:1px solid rgba(255,255,255,.06)}
.coll-hdr{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;user-select:none;transition:background .2s;font-size:12px;font-weight:700}
.coll-hdr:hover{filter:brightness(1.2)}
.coll-hdr .arr{font-size:10px;color:#64748b;transition:transform .25s;display:inline-block}
.coll-hdr.open .arr{transform:rotate(90deg)}
.coll-body{max-height:0;overflow:hidden;transition:max-height .3s ease-out}
.coll-body.open{max-height:5000px;transition:max-height .5s ease-in}
.coll-inner{padding:10px 14px 14px}
/* Card header redesign */
.card{background:rgba(15,23,42,.8);border:1px solid rgba(255,255,255,.06);border-radius:16px;margin-bottom:14px;overflow:hidden}
.card-top{padding:16px 18px 12px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;border-bottom:1px solid rgba(255,255,255,.04)}
.card-title{font-size:14px;font-weight:800;color:#f1f5f9;margin-bottom:4px}
.card-tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px}
.card-body{padding:0 4px 8px}
/* Result block */
.result-block{margin:12px 14px;padding:12px 16px;background:linear-gradient(135deg,rgba(96,165,250,.08),rgba(139,92,246,.06));border:1px solid rgba(96,165,250,.15);border-radius:12px}
.result-block .res-title{font-size:11px;font-weight:700;color:#60a5fa;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.result-block .res-text{font-size:13px;line-height:1.7;color:#e2e8f0}
.result-block .res-verdict{font-size:12px;line-height:1.5;color:#fbbf24;margin-top:6px;font-weight:700;padding-top:6px;border-top:1px solid rgba(255,255,255,.05)}
/* Score pill */
.score-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:800}
</style>
</head><body>
<div class="hdr"><div class="hdr-in">
  <div class="logo">T</div>
  <div><div style="font-size:17px;font-weight:800;color:#f1f5f9">${managerName}</div><div style="font-size:12px;color:#64748b" id="upd"></div></div>
  <div class="pbar" id="pbar"></div>
</div></div>
<div class="cnt">
  <div class="mets" id="mets"></div>
  <div class="tabs" id="tabs"></div>
  <div id="out"></div>
</div>
<script>
const D=${json};
const PF_URL='${API_URL}';
const PF_TOKEN='${TOKEN}';
const PERIODS=[{l:'Сегодня',d:0},{l:'3 дня',d:3},{l:'7 дн',d:7},{l:'14 дн',d:14},{l:'30 дн',d:30},{l:'Всё',d:9999}];

function buildRecommendationText(taskId){
  var da=(D.dailyDealActivity||[]).find(function(x){return x.deal.id===taskId});
  if(!da||!da.aiAssessment)return null;
  var aa=da.aiAssessment;
  var ss=aa.salaryScore||{};
  var t='🤖 ИИ-оценка сделки за '+D.reportDate+'\\n\\n';
  if(aa.todaySummary) t+='📅 Итог дня: '+aa.todaySummary+'\\n\\n';
  if(aa.overallVerdict) t+='📊 Вердикт: '+aa.overallVerdict+'\\n\\n';
  t+='📋 Скрипт продаж:\\n';
  var vp=aa.verbalPresentation;
  if(vp) t+='  Устная презентация: '+(vp.overall?'✅ ('+vp.source+')':'❌')+'\\n';
  var hw=aa.howWeWork;
  if(hw) t+='  Как мы работаем: '+(hw.done?'✅ ('+hw.source+')':'❌')+'\\n';
  if(aa.writtenPresentation) t+='  Презентация (файл): '+(aa.writtenPresentation.done?'✅':'❌')+'\\n';
  if(aa.cp) t+='  КП: '+(aa.cp.done?'✅':'❌')+(aa.cp.note?' — '+aa.cp.note:'')+'\\n';
  if(aa.invoice) t+='  Счёт: '+(aa.invoice.done?'✅':'❌')+(aa.invoice.note?' — '+aa.invoice.note:'')+'\\n';
  if(aa.callToAction) t+='  Призыв к действию: '+(aa.callToAction.done?'✅':'❌')+'\\n';
  if(aa.objectionHandling) t+='  Отработка возражений: '+(aa.objectionHandling.done?'✅':'❌')+'\\n';
  t+='\\n💰 Баллы ЗП: '+ss.total+'/'+ss.max+'\\n';
  var miss=aa.missing||[];
  if(miss.length){t+='\\n❗ Не выполнено:\\n';miss.forEach(function(m){t+='  • '+m+'\\n'});}
  var recs=aa.recommendations||[];
  if(recs.length){t+='\\n💡 Рекомендации:\\n';recs.forEach(function(r){t+='  • '+r+'\\n'});}
  return t;
}
async function copyRecommendation(taskId){
  var text=buildRecommendationText(taskId);
  if(!text)return alert('Нет ИИ-оценки для этой сделки');
  var btn=document.getElementById('pf_btn_'+taskId);
  try{
    await navigator.clipboard.writeText(text);
    if(btn){btn.textContent='✅ Скопировано!';btn.style.background='rgba(52,211,153,.15)';btn.style.color='#34d399';}
    setTimeout(function(){if(btn){btn.textContent='📋 Копировать';btn.style.background='';btn.style.color='';}},3000);
  }catch(e){
    var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
    if(btn){btn.textContent='✅ Скопировано!';btn.style.background='rgba(52,211,153,.15)';btn.style.color='#34d399';}
    setTimeout(function(){if(btn){btn.textContent='📋 Копировать';btn.style.background='';btn.style.color='';}},3000);
  }
}
async function sendToPlanfix(taskId){
  var text=buildRecommendationText(taskId);
  if(!text)return alert('Нет ИИ-оценки для этой сделки');
  if(!confirm('Отправить ИИ-рекомендации в Planfix в задачу #'+taskId+'?'))return;
  var btn=document.getElementById('pf_send_'+taskId);
  if(btn){btn.disabled=true;btn.textContent='Отправка...';}
  var h=text.replace(/\\n/g,'<br>').replace(/  /g,'&nbsp;&nbsp;');
  try{
    var resp=await fetch(PF_URL+'/task/'+taskId+'/comments/',{
      method:'POST',
      headers:{'Authorization':'Bearer '+PF_TOKEN,'Content-Type':'application/json'},
      body:JSON.stringify({description:h})
    });
    if(!resp.ok){var t=await resp.text();throw new Error(t);}
    if(btn){btn.textContent='✅ Отправлено!';btn.style.background='rgba(52,211,153,.15)';btn.style.color='#34d399';}
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='📤 Planfix';}
    alert('Ошибка: '+e.message+'\\n\\nТокен не имеет прав на создание комментариев.\\nОбновите права токена в Planfix: Управление аккаунтом → API → Токен → Разрешения → Комментарии задач: Добавление.\\n\\nПока можно скопировать текст кнопкой 📋.');
  }
}
let selectedDate=D.reportDate||'';
function getTabName(){return 'День '+selectedDate}
const TABS_BASE=['','Все сделки','Качество','Ежедневные','Воронка'];
let period=7,tab=0;

// Все уникальные даты с активностью из dealCards
function getAllDates(){
  const ds=new Set();
  for(const c of D.dealCards){
    for(const x of (c.comments||[]))if(x.date)ds.add(x.date);
    for(const x of (c.calls||[]))if(x.date)ds.add(x.date);
  }
  return [...ds].sort((a,b)=>{
    const pa=a.split('-'),pb=b.split('-');
    const da=new Date(pa[2]+'-'+pa[1]+'-'+pa[0]),db=new Date(pb[2]+'-'+pb[1]+'-'+pb[0]);
    return db-da;
  });
}

function timeToMin(t){if(!t)return 0;const p=(t||'').split(':');return(parseInt(p[0])||0)*60+(parseInt(p[1])||0)}

// Пересчитать dailyDealActivity на клиенте для любой даты
function buildDayActivity(dateStr){
  // Если есть предрасчитанные данные с ИИ — обогащаем историей из dealCards
  const multiDay=D.multiDayActivity&&D.multiDayActivity[dateStr];
  if(multiDay){
    for(const da of multiDay){
      if(!da.allComments){
        const card=D.dealCards.find(c=>c.id===da.deal.id);
        if(card){da.allComments=card.comments;da.allCalls=card.calls;da.allAnalyses=card.analyses}
      }
    }
    return multiDay;
  }
  if(dateStr===D.reportDate&&D.dailyDealActivity&&D.dailyDealActivity.length) return D.dailyDealActivity;
  const result=[];
  for(const card of D.dealCards){
    if(!card.isActive)continue;
    const dayComments=(card.comments||[]).filter(c=>c.date===dateStr);
    const dayCalls=(card.calls||[]).filter(c=>c.date===dateStr);
    // dateCreated может быть в формате YYYY-MM-DD или DD-MM-YYYY
    const dc=card.dateCreated||'';
    let createdDMY='';
    if(dc.match(/^\\d{4}-/)){const p=dc.split(/[-T ]/);createdDMY=p[2]+'-'+p[1]+'-'+p[0]}
    else if(dc.match(/^\\d{2}-\\d{2}-\\d{4}/)){createdDMY=dc.substring(0,10)}
    const isCreatedToday=createdDMY===dateStr;
    if(!dayComments.length&&!dayCalls.length&&!isCreatedToday)continue;
    const actions=dayComments.map(c=>({type:c.type,time:c.time,text:c.text,owner:c.owner,transcription:c.transcription,source:c.source||'deal',files:c.files||[]}));
    for(const call of dayCalls){
      const isDupe=actions.some(a=>(a.type==='outCall'||a.type==='inCall')&&Math.abs(timeToMin(a.time)-timeToMin(call.time))<5);
      if(!isDupe){
        actions.push({type:call.type==='Входящий'?'inCall':'outCall',time:call.time,text:(call.type+' '+(call.contact||'')+' '+(call.phone||'')).trim(),owner:call.employee,transcription:null,source:'datatag',duration:call.duration});
      }
    }
    actions.sort((a,b)=>timeToMin(a.time)-timeToMin(b.time));
    const dayAnalyses=(card.analyses||[]).filter(a=>a.date===dateStr);
    const scriptHistory={
      total:(card.analyses||[]).length,
      everHowWeWork:(card.analyses||[]).some(a=>a.howWeWork==='Да'),
      everCallToAction:(card.analyses||[]).some(a=>a.callToAction==='Да'),
      everSentInvoice:(card.analyses||[]).some(a=>a.sentInvoice==='Да'),
      everAllFour:(card.analyses||[]).some(a=>a.allFour==='Да'),
      bestScore:(card.analyses||[]).length?Math.max(...card.analyses.map(a=>a.totalBalls)):0,
      customerKnowsCompany:(card.analyses||[]).some(a=>a.howWeWork==='Да'),
    };
    result.push({
      deal:{id:card.id,name:card.name,status:card.status,counterparty:card.counterparty},
      isNew:isCreatedToday||card.isNew,
      actions,
      dayCalls:actions.filter(a=>a.type==='outCall'||a.type==='inCall').length,
      planfixScript:dayAnalyses.length?dayAnalyses[0]:null,
      allComments:card.comments,
      allCalls:card.calls,
      allAnalyses:card.analyses,
      scriptHistory,
      aiAssessment:null,
    });
  }
  return result;
}

function setDate(d){selectedDate=d;rT();upd()}

function init(){document.getElementById('upd').textContent='Обновлено: '+new Date(D.generated).toLocaleString('ru-RU');rP();rT();upd()}
function rP(){document.getElementById('pbar').innerHTML=PERIODS.map(p=>'<button class="pbtn'+(p.d===period?' on':'')+'" onclick="period='+p.d+';rP();upd()">'+p.l+'</button>').join('')}
function rT(){
  const tabs=[getTabName(),...TABS_BASE.slice(1)];
  document.getElementById('tabs').innerHTML=tabs.map((t,i)=>'<div class="tab'+(i===tab?' on':'')+'" onclick="tab='+i+';rT();upd()">'+t+'</div>').join('');
}

function inPeriod(dateStr){
  if(period>=9999||!dateStr)return true;
  const now=new Date();now.setHours(23,59,59);
  const from=new Date(now);from.setDate(from.getDate()-(period||0));from.setHours(0,0,0);
  let d;
  const m1=dateStr.match(/(\\d{2})-(\\d{2})-(\\d{4})/);
  const m2=dateStr.match(/(\\d{4})-(\\d{2})-(\\d{2})/);
  if(m2) d=new Date(dateStr);
  else if(m1) d=new Date(m1[3]+'-'+m1[2]+'-'+m1[1]);
  else return true;
  return d>=from&&d<=now;
}

function filterCalls(calls){return calls.filter(c=>inPeriod(c.date))}
function filterAnalyses(analyses){return analyses.filter(a=>inPeriod(a.date))}

function upd(){
  const cards=D.dealCards.map(d=>({
    ...d,
    fCalls:filterCalls(d.calls),
    fAnalyses:filterAnalyses(d.analyses),
    fComments:d.comments.filter(c=>inPeriod(c.date)),
  })).filter(d=>d.fCalls.length||d.fAnalyses.length||d.fComments.filter(c=>c.type!=='note').length);

  const allC=cards.flatMap(d=>d.fCalls);
  const allA=cards.flatMap(d=>d.fAnalyses);
  const reports=D.dailyReports.filter(r=>inPeriod(r.date));
  renderMets(allC,allA,reports,cards);
  if(tab===0)renderDay();
  else if(tab===1)renderDeals(cards);
  else if(tab===2)renderQuality(allA,cards);
  else if(tab===3)renderDaily(reports);
  else renderFunnel();
}

function renderMets(calls,analyses,reports,cards){
  const sum=(a,f)=>a.reduce((s,r)=>s+(r[f]||0),0);
  const rev=sum(reports,'revenue');
  const durSec=calls.reduce((s,c)=>s+c.duration,0);
  const avgB=analyses.length?Math.round(analyses.reduce((s,a)=>s+a.totalBalls,0)/analyses.length*10)/10:0;
  const fwd=D.funnelChanges.filter(c=>c.direction==='forward').length;
  const items=[
    {v:D.dailyActivity.newDeals.length,l:'Новых сегодня',c:'#a78bfa'},
    {v:D.dailyActivity.workedDeals.length,l:'Обработано',c:'#818cf8'},
    {v:fwd,l:'Продвинуто',c:'#34d399'},
    {v:calls.length,l:'Звонков',c:'#60a5fa'},
    {v:Math.round(durSec/60)+'м',l:'Время звонков',c:'#818cf8'},
    {v:analyses.length,l:'С анализом',c:'#f472b6'},
    {v:avgB,l:'Ср. балл',c:avgB>=15?'#34d399':avgB>=10?'#fbbf24':'#f87171'},
    {v:sum(reports,'contract'),l:'Договор/оплата',c:'#34d399'},
    {v:rev?fmt(rev)+'₽':'—',l:'Поступило',c:'#fbbf24'},
    {v:sum(reports,'kpSent'),l:'КП',c:'#f472b6'},
  ];
  document.getElementById('mets').innerHTML=items.map(i=>'<div class="met"><div class="met-l">'+i.l+'</div><div class="met-v" style="color:'+i.c+'">'+i.v+'</div></div>').join('');
}

// === ДЕНЬ (главная вкладка) ===
function renderDay(){
  const deals=buildDayActivity(selectedDate);
  const isOriginalDate=selectedDate===D.reportDate;
  let h='';

  // Выбор даты
  const dates=getAllDates();
  h+='<div style="margin-bottom:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
  h+='<span style="font-size:12px;color:#64748b;font-weight:600">📅 Дата:</span>';
  h+='<select id="datePicker" onchange="setDate(this.value)" style="padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:#1e293b;color:#e2e8f0;font-size:13px;font-family:inherit;cursor:pointer">';
  for(const dt of dates){
    const hasAi=D.multiDayActivity&&D.multiDayActivity[dt];
    h+='<option value="'+dt+'"'+(dt===selectedDate?' selected':'')+'>'+dt+(hasAi?' (ИИ)':'')+'</option>';
  }
  h+='</select>';
  const hasAiData=D.multiDayActivity&&D.multiDayActivity[selectedDate];
  if(!hasAiData&&!isOriginalDate){
    h+='<span style="font-size:11px;color:#fbbf24">⚠️ ИИ-оценка недоступна за эту дату</span>';
  }
  h+='</div>';

  // ИИ итог дня
  const daySummary=(D.multiDaySummary&&D.multiDaySummary[selectedDate])||(isOriginalDate?D.aiDaySummaryText:null);
  if(daySummary){
    h+='<div class="sec" style="border-left:3px solid #8b5cf6;background:rgba(139,92,246,.06)">';
    h+='<h3>🤖 ИИ-итог дня ('+esc(selectedDate)+')</h3>';
    h+='<div style="font-size:13px;line-height:1.7;color:#cbd5e1;white-space:pre-wrap">'+esc(daySummary)+'</div>';
    h+='</div>';
  }

  // Метрики дня
  const newD=deals.filter(d=>d.isNew).length;
  const oldD=deals.filter(d=>!d.isNew).length;
  const totalCalls=deals.reduce((s,d)=>(d.actions||[]).filter(a=>a.type==='outCall'||a.type==='inCall').length+s,0);
  const totalSalaryScore=deals.reduce((s,d)=>{const ss=(d.aiAssessment||{}).salaryScore;return s+(ss?ss.total:0)},0);
  const maxSalaryScore=deals.length*12;
  h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:14px">';
  h+='<div class="met"><div class="met-l">Обработано</div><div class="met-v" style="color:#60a5fa">'+deals.length+'</div></div>';
  h+='<div class="met"><div class="met-l">Новых</div><div class="met-v" style="color:#a78bfa">'+newD+'</div></div>';
  h+='<div class="met"><div class="met-l">Старых</div><div class="met-v" style="color:#818cf8">'+oldD+'</div></div>';
  h+='<div class="met"><div class="met-l">Звонков</div><div class="met-v" style="color:#34d399">'+totalCalls+'</div></div>';
  h+='<div class="met"><div class="met-l">Баллы ЗП</div><div class="met-v" style="color:#fbbf24">'+totalSalaryScore+'/'+maxSalaryScore+'</div></div>';
  h+='</div>';

  if(!deals.length){
    h+='<div class="no-data">Нет активности за '+esc(selectedDate||'сегодня')+'</div>';
    document.getElementById('out').innerHTML=h;return;
  }

  // Карточки сделок за день
  for(let di=0;di<deals.length;di++){
    const da=deals[di];
    const d=da.deal;
    const aa=da.aiAssessment||{};
    const uid=d.id+'_'+di;
    const borderCol=da.isNew?'#a78bfa':'#3b82f6';
    const dss=(aa.salaryScore||{});
    const dsCol=dss.total>=7?'#34d399':dss.total>=4?'#fbbf24':'#f87171';
    const acts=da.actions||[];
    const callCount=acts.filter(a=>a.type==='outCall'||a.type==='inCall').length;

    // === CARD WRAPPER ===
    h+='<div class="card" style="border-left:3px solid '+borderCol+'">';

    // === CARD HEADER (always visible) ===
    h+='<div class="card-top">';
    h+='<div style="flex:1;min-width:200px">';
    h+='<div class="card-title">#'+d.id+' '+esc((d.name||'').substring(0,70))+'</div>';
    h+='<div class="card-tags">';
    h+='<span style="font-size:11px;color:#94a3b8">'+esc(d.counterparty)+'</span>';
    h+='<span class="bg bg-b">'+esc(d.status)+'</span>';
    if(da.isNew)h+='<span class="bg bg-p">Новая</span>';
    else h+='<span class="bg bg-y">Старая</span>';
    if(callCount)h+='<span class="bg" style="background:rgba(52,211,153,.12);color:#34d399">📞 '+callCount+'</span>';
    h+='</div>';
    h+='</div>';
    // Score pill
    if(dss.total!==undefined){
      h+='<div class="score-pill" style="background:rgba(251,191,36,.1);color:'+dsCol+'">💰 '+dss.total+'/'+dss.max+'</div>';
    }
    h+='</div>';

    // === РЕЗУЛЬТАТ ЗА ДЕНЬ (always visible, prominent) ===
    if(aa.todaySummary){
      h+='<div class="result-block">';
      h+='<div class="res-title">📊 Результат за день</div>';
      h+='<div class="res-text">'+esc(aa.todaySummary)+'</div>';
      if(aa.overallVerdict){
        h+='<div class="res-verdict">→ '+esc(aa.overallVerdict)+'</div>';
      }
      h+='</div>';
    }

    h+='<div class="card-body">';

    // === ДЕЙСТВИЯ ЗА ДЕНЬ (collapsible, open by default) ===
    if(acts.length){
      const cid='acts_'+uid;
      h+='<div class="coll" style="background:rgba(15,23,42,.4)">';
      h+='<div class="coll-hdr open" id="hdr_'+cid+'" onclick="toggleColl(&#39;'+cid+'&#39;)" style="color:#60a5fa;background:rgba(96,165,250,.06)">';
      h+='<span class="arr">▶</span> 📅 Действия за '+esc(selectedDate||'')+' <span style="color:#64748b;font-weight:500;margin-left:4px">('+acts.length+')</span></div>';
      h+='<div class="coll-body open" id="body_'+cid+'"><div class="coll-inner">';
      for(let ai=0;ai<acts.length;ai++){
        const a=acts[ai];
        const isCall=a.type==='outCall'||a.type==='inCall';
        const icon=a.type==='outCall'?'📤':a.type==='inCall'?'📥':a.type==='ndz'?'⏰':'📝';
        const lbl=a.type==='outCall'?'Исходящий':a.type==='inCall'?'Входящий':a.type==='ndz'?'НДЗ':'Заметка';
        const src=a.source==='contact'?' <span class="bg bg-p" style="font-size:9px">контакт</span>':'';
        const durMin=a.duration?Math.round(a.duration/60):0;
        const durCol=durMin>=3?'#34d399':durMin>=1?'#fbbf24':'#f87171';
        h+='<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04)">';
        h+='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
        h+='<span style="color:#60a5fa;font-weight:700;font-size:13px">'+esc(a.time||'?')+'</span>';
        h+='<span style="font-size:12px;font-weight:600;color:#e2e8f0">'+icon+' '+lbl+'</span>'+src;
        if(a.duration)h+='<span style="font-size:12px;font-weight:700;color:'+durCol+'">'+durMin+'м</span>';
        h+='</div>';
        if(isCall){
          const nextNote=acts.slice(ai+1).find(n=>n.type==='note'&&n.text&&Math.abs(timeToMin(n.time)-timeToMin(a.time))<5);
          if(nextNote&&nextNote.text){
            h+='<div style="margin-top:6px;padding:8px 12px;background:rgba(251,191,36,.06);border-left:3px solid #fbbf24;border-radius:0 8px 8px 0;font-size:12px;color:#e2e8f0;line-height:1.6">'+esc(nextNote.text.substring(0,300))+'</div>';
          }
        }
        if(a.text&&!isCall){
          h+='<div style="margin-top:6px;padding:8px 12px;background:rgba(148,163,184,.05);border-left:3px solid #475569;border-radius:0 8px 8px 0;font-size:12px;color:#cbd5e1;line-height:1.6">'+esc(a.text.substring(0,400))+'</div>';
        }
        if(a.transcription){
          const tid='tr_day_'+d.id+'_'+ai;
          h+='<button class="toggle-btn" style="margin-top:6px" onclick="toggleTr(&#39;'+tid+'&#39;)">🎙 Транскрибация</button>';
          h+='<div id="'+tid+'" class="transcript" style="display:none">'+esc(a.transcription)+'</div>';
        }
        h+='</div>';
      }
      h+='</div></div></div>';
    }

    // === ИСТОРИЯ СДЕЛКИ (collapsible, closed by default) ===
    const hist=(da.allComments||[]).filter(c=>c.date!==selectedDate&&c.text.length>5);
    if(hist.length){
      const cid='hist_'+uid;
      h+='<div class="coll" style="background:rgba(100,116,139,.04)">';
      h+='<div class="coll-hdr" id="hdr_'+cid+'" onclick="toggleColl(&#39;'+cid+'&#39;)" style="color:#94a3b8;background:rgba(100,116,139,.06)">';
      h+='<span class="arr">▶</span> 📜 История сделки <span style="color:#64748b;font-weight:500;margin-left:4px">('+hist.length+' записей)</span></div>';
      h+='<div class="coll-body" id="body_'+cid+'"><div class="coll-inner" style="max-height:350px;overflow-y:auto">';
      for(const c of hist.slice(0,30)){
        const icon=c.type==='outCall'?'📤':c.type==='inCall'?'📥':c.type==='ndz'?'⏰':'📝';
        h+='<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03)">';
        h+='<span style="color:#475569;font-size:10px;font-weight:600">'+esc(c.date)+' '+esc(c.time)+'</span> '+icon+' ';
        h+='<span style="font-size:11px;color:#94a3b8">'+esc(c.text.substring(0,150))+'</span>';
        if(c.transcription){
          const tid='tr_hist_'+d.id+'_'+c.id;
          h+=' <button class="toggle-btn" onclick="toggleTr(&#39;'+tid+'&#39;)" style="font-size:9px">транскр.</button>';
          h+='<div id="'+tid+'" class="transcript" style="display:none;max-height:150px">'+esc(c.transcription)+'</div>';
        }
        h+='</div>';
      }
      h+='</div></div></div>';
    }

    // === СКРИПТ ПРОДАЖ (collapsible, closed by default) ===
    const vp=aa.verbalPresentation;
    const wp=aa.writtenPresentation;
    const hasAssessment=vp||wp||aa.cp||aa.invoice||aa.callToAction||aa.objectionHandling;
    if(hasAssessment){
      const cid='script_'+uid;
      h+='<div class="coll" style="background:rgba(59,130,246,.03)">';
      h+='<div class="coll-hdr" id="hdr_'+cid+'" onclick="toggleColl(&#39;'+cid+'&#39;)" style="color:#60a5fa;background:rgba(59,130,246,.06)">';
      h+='<span class="arr">▶</span> 📋 Скрипт продаж (ИИ-оценка по всей истории)';
      // Mini score in header
      if(dss.total!==undefined)h+=' <span style="margin-left:auto;color:'+dsCol+';font-size:11px">'+dss.total+'/'+dss.max+'б</span>';
      h+='</div>';
      h+='<div class="coll-body" id="body_'+cid+'"><div class="coll-inner">';

      // Устная презентация
      if(vp){
        const qual=vp.quality||'';
        const vpSrc=(vp.source||'').toLowerCase();
        const isCall=vpSrc==='call'||vpSrc==='звонок';
        const qCol=qual.includes('хорошо')?'#34d399':qual.includes('средне')?'#fbbf24':'#f87171';
        const vpIsCall=isCall;
        const vpBorderCol=vp.overall?(vpIsCall?'rgba(52,211,153,.3)':'rgba(251,191,36,.3)'):'rgba(248,113,113,.2)';
        const vpTitleCol=vp.overall?(vpIsCall?'#34d399':'#fbbf24'):'#f87171';
        h+='<div style="margin-bottom:10px;padding:10px 12px;background:'+(vpIsCall?'rgba(52,211,153,.04)':'rgba(251,191,36,.04)')+';border:1px solid '+vpBorderCol+';border-radius:8px">';
        h+='<div style="font-size:12px;font-weight:700;color:'+vpTitleCol+';margin-bottom:6px">🎙 Устная презентация';
        if(vp.overall)h+=' <span class="bg" style="font-size:9px;background:'+(isCall?'rgba(52,211,153,.15);color:#34d399':'rgba(251,191,36,.15);color:#fbbf24')+'">'+(isCall?'звонок 3б':'переписка 1.5б')+'</span>';
        if(qual)h+=' — <span style="color:'+qCol+'">'+esc(qual)+'</span>';
        h+='</div>';
        const prItems=[
          {k:'since2014',l:'Работаем с 2014 года'},
          {k:'manyObjects',l:'Много объектов по Москве'},
          {k:'govClients',l:'Госдума и госучреждения'},
          {k:'reliableInSnow',l:'Надежность в снегопады'},
          {k:'manyVehicles',l:'Много техники'},
        ];
        for(const it of prItems){
          const v=vp[it.k];
          if(!v)continue;
          const vpItemCol=v.done?(vpIsCall?'#34d399':'#fbbf24'):'#f87171';
          h+='<div style="font-size:11px;margin:3px 0;margin-left:12px"><span style="color:'+vpItemCol+'">'+(v.done?(vpIsCall?'✅':'☑️'):'❌')+'</span> '+it.l;
          if(v.note)h+=' <span style="color:#64748b;font-size:10px">— '+esc(v.note)+'</span>';
          h+='</div>';
        }
        h+='</div>';
      }

      // Чек-лист items
      const checkItems=[];
      const hw=aa.howWeWork;
      if(hw){
        const hwSrc=hw.source==='call'||hw.source==='звонок';
        checkItems.push({done:hw.done,label:'Как мы работаем',badge:hw.done?(hwSrc?'звонок 3б':'переписка 1.5б'):'',badgeCall:hwSrc,isText:hw.done&&!hwSrc,note:hw.note});
      }
      if(wp) checkItems.push({done:wp.done,label:'Презентация (файл)',badge:wp.done?'1б':'',note:wp.note});
      if(aa.cp) checkItems.push({done:aa.cp.done,label:'КП',badge:aa.cp.done?'1б':'',note:aa.cp.note});
      if(aa.invoice) checkItems.push({done:aa.invoice.done,label:'Счёт',badge:aa.invoice.done?'1б':'',note:aa.invoice.note});
      const ctaSrc=aa.callToAction&&aa.callToAction.source;
      const ctaIsCall=ctaSrc==='call'||ctaSrc==='звонок';
      if(aa.callToAction) checkItems.push({done:aa.callToAction.done,label:'Призыв к действию',badge:aa.callToAction.done?(ctaIsCall?'звонок 3б':'переписка 3б'):'',badgeCall:ctaIsCall,isText:aa.callToAction.done&&!ctaIsCall,note:aa.callToAction.note});
      if(aa.objectionHandling) checkItems.push({done:aa.objectionHandling.done,label:'Отработка возражений',badge:'',note:aa.objectionHandling.note});

      if(checkItems.length){
        h+='<div style="display:grid;gap:4px;margin-bottom:10px">';
        for(const ci of checkItems){
          const ciBorderCol=ci.done?(ci.isText?'#fbbf24':'#34d399'):'rgba(248,113,113,.4)';
          h+='<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,.02);border-radius:6px;border-left:3px solid '+ciBorderCol+'">';
          h+='<span style="font-size:14px">'+(ci.done?(ci.isText?'☑️':'✅'):'❌')+'</span>';
          h+='<span style="font-size:12px;font-weight:600;color:'+(ci.done?'#e2e8f0':'#94a3b8')+'">'+ci.label+'</span>';
          if(ci.badge){
            const bgCol=ci.badgeCall?'rgba(52,211,153,.15)':'rgba(251,191,36,.15)';
            const txCol=ci.badgeCall?'#34d399':'#fbbf24';
            h+='<span class="bg" style="font-size:9px;background:'+bgCol+';color:'+txCol+'">'+ci.badge+'</span>';
          }
          if(ci.note)h+='<span style="color:#64748b;font-size:10px;margin-left:auto">'+esc(ci.note)+'</span>';
          h+='</div>';
        }
        h+='</div>';
      }

      // === БАЛЛЫ ДЛЯ ЗП ===
      const ss=aa.salaryScore;
      if(ss){
        const pct=ss.max?Math.round(ss.total/ss.max*100):0;
        const col=pct>=70?'#34d399':pct>=40?'#fbbf24':'#f87171';
        h+='<div style="padding:10px 12px;background:rgba(251,191,36,.05);border:1px solid rgba(251,191,36,.12);border-radius:8px">';
        h+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">';
        h+='<span style="font-size:12px;font-weight:700;color:'+col+'">💰 Баллы для ЗП</span>';
        h+='<span style="font-size:16px;font-weight:800;color:'+col+'">'+ss.total+' / '+ss.max+'</span>';
        h+='</div>';
        h+='<div style="background:rgba(255,255,255,.06);border-radius:4px;height:8px;margin-bottom:8px"><div style="background:'+col+';height:100%;border-radius:4px;width:'+pct+'%;transition:width .3s"></div></div>';
        if(ss.items&&ss.items.length){
          for(const it of ss.items){
            h+='<div style="font-size:10px;color:#94a3b8;padding:2px 0">✅ '+esc(it.name)+': <strong style="color:'+col+'">+'+it.score+'</strong>';
            if(it.note)h+=' <span style="color:#64748b">— '+esc(it.note)+'</span>';
            h+='</div>';
          }
        }
        const missing=[];
        const textWarnings=[];
        if(!aa.cp||!aa.cp.done) missing.push('КП (1б)');
        if(!aa.invoice||!aa.invoice.done) missing.push('Счёт (1б)');
        if(!aa.writtenPresentation||!aa.writtenPresentation.done) missing.push('Презентация-файл (1б)');
        const vpDone=aa.verbalPresentation&&aa.verbalPresentation.overall;
        if(!vpDone) missing.push('Устная презентация (до 3б)');
        else if(vp&&vp.source!=='call'&&vp.source!=='звонок') textWarnings.push('Устная презентация — 1.5б вместо 3б (переписка, не звонок)');
        const hwDone=aa.howWeWork&&aa.howWeWork.done;
        if(!hwDone) missing.push('Как мы работаем (до 3б)');
        else if(hw&&hw.source!=='call'&&hw.source!=='звонок') textWarnings.push('Как мы работаем — 1.5б вместо 3б (переписка, не звонок)');
        const ctaDone=aa.callToAction&&aa.callToAction.done;
        if(!ctaDone) missing.push('Призыв к действию (3б)');
        if(missing.length){
          h+='<div style="font-size:10px;color:#f87171;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.04)">Не набрано: '+esc(missing.join(', '))+'</div>';
        }
        if(textWarnings.length){
          h+='<div style="font-size:10px;color:#fbbf24;margin-top:4px">⚠️ Балл снижен: '+esc(textWarnings.join('; '))+'. Рекомендуем проговаривать по телефону!</div>';
        }
        h+='</div>';
      }

      // Planfix анализ за сегодня
      const pf=da.planfixScript;
      if(pf){
        h+='<div style="margin-top:8px;padding:6px 10px;background:rgba(100,116,139,.06);border-radius:6px;font-size:10px;color:#64748b">';
        h+='Planfix ('+esc(D.reportDate||'')+'): '+pf.totalBalls+'б | '+esc((pf.verdict||'').split('(')[0].trim());
        h+=' | Презент:'+yn(pf.howWeWork)+' Призыв:'+yn(pf.callToAction)+' Счёт:'+yn(pf.sentInvoice);
        h+='</div>';
      }

      h+='</div></div></div>'; // end coll-inner, coll-body, coll
    }

    // === ЧТО НЕ ХВАТАЕТ + РЕКОМЕНДАЦИИ (collapsible, open if has missing) ===
    if(aa.missing||aa.recommendations){
      const miss=aa.missing||[];
      const recs=aa.recommendations||[];
      const cid='recs_'+uid;
      const hasImportant=miss.length>0;
      h+='<div class="coll" style="background:rgba(139,92,246,.03)">';
      h+='<div class="coll-hdr'+(hasImportant?' open':'')+'" id="hdr_'+cid+'" onclick="toggleColl(&#39;'+cid+'&#39;)" style="color:#a78bfa;background:rgba(139,92,246,.06)">';
      h+='<span class="arr">▶</span>';
      if(miss.length)h+=' ❗ Что не выполнено ('+miss.length+')';
      if(recs.length)h+=(miss.length?' + ':' ')+'💡 Рекомендации ('+recs.length+')';
      h+='</div>';
      h+='<div class="coll-body'+(hasImportant?' open':'')+'" id="body_'+cid+'"><div class="coll-inner">';

      if(miss.length){
        h+='<div style="margin-bottom:8px">';
        for(const m of miss){
          h+='<div style="font-size:11px;color:#fca5a5;padding:3px 0;padding-left:8px;border-left:2px solid rgba(248,113,113,.3)">• '+esc(m)+'</div>';
        }
        h+='</div>';
      }

      if(recs.length){
        h+='<div>';
        for(const r of recs){
          h+='<div style="font-size:11px;color:#6ee7b7;padding:3px 0;padding-left:8px;border-left:2px solid rgba(52,211,153,.3)">• '+esc(r)+'</div>';
        }
        h+='</div>';
      }

      h+='<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">';
      h+='<button id="pf_btn_'+d.id+'" onclick="copyRecommendation('+d.id+')" style="padding:6px 14px;font-size:11px;font-weight:600;color:#60a5fa;background:rgba(96,165,250,.1);border:1px solid rgba(96,165,250,.25);border-radius:6px;cursor:pointer;transition:.2s">📋 Копировать</button>';
      h+='<button id="pf_send_'+d.id+'" onclick="sendToPlanfix('+d.id+')" style="padding:6px 14px;font-size:11px;font-weight:600;color:#818cf8;background:rgba(129,140,248,.1);border:1px solid rgba(129,140,248,.25);border-radius:6px;cursor:pointer;transition:.2s">📤 Planfix</button>';
      h+='</div>';

      h+='</div></div></div>'; // end coll
    }

    h+='</div>'; // end card-body
    h+='</div>'; // end card
  }

  document.getElementById('out').innerHTML=h;
}

// === СДЕЛКИ + ЗВОНКИ ===
function renderDeals(cards){
  if(!cards.length){document.getElementById('out').innerHTML='<div class="no-data">Нет данных за период</div>';return}
  const sorted=[...cards].sort((a,b)=>b.fCalls.length-a.fCalls.length||b.id-a.id);
  let h='';
  for(const d of sorted){
    const durM=Math.round(d.fCalls.reduce((s,c)=>s+c.duration,0)/60);
    const avgB=d.fAnalyses.length?Math.round(d.fAnalyses.reduce((s,a)=>s+a.totalBalls,0)/d.fAnalyses.length*10)/10:null;
    h+='<div class="sec"><div class="deal-hdr"><div><h3>#'+d.id+' '+esc(d.name.substring(0,55))+'</h3>';
    h+='<div class="deal-meta"><span>'+esc(d.counterparty)+'</span>';
    h+='<span class="bg bg-b">'+esc(d.status)+'</span>';
    if(d.isNew)h+=' <span class="bg bg-p">Новая</span>';
    h+='</div></div>';
    h+='<div class="deal-stat">';
    h+='<span style="color:#60a5fa">📞 '+d.fCalls.length+'</span>';
    h+='<span style="color:#818cf8">⏱ '+durM+'м</span>';
    if(d.fAnalyses.length)h+='<span style="color:#f472b6">📊 '+d.fAnalyses.length+'</span>';
    if(avgB!==null){
      const ac=avgB>=15?'#34d399':avgB>=10?'#fbbf24':'#f87171';
      h+='<span style="color:'+ac+'">'+avgB+'б</span>';
    }
    h+='</div></div>';

    // Таблица звонков
    if(d.fCalls.length){
      h+='<table style="margin-top:10px"><tr><th>Дата</th><th>Время</th><th>Тип</th><th>Длит.</th><th>Контакт</th><th>Как раб.</th><th>Призыв</th><th>Счёт</th><th>Баллы</th><th>Вердикт</th></tr>';
      const sortedCalls=[...d.fCalls].sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
      for(const c of sortedCalls){
        const dur=c.duration>=60?Math.round(c.duration/60)+'м':c.duration+'с';
        const cMin=timeToMin(c.time);
        const matchA=d.fAnalyses.find(a=>{
          if(a.date!==c.date)return false;
          return Math.abs(timeToMin(a.time)-cMin)<10;
        });
        h+='<tr><td style="white-space:nowrap;font-size:11px">'+esc(c.date)+'</td>';
        h+='<td>'+esc((c.time||'').split('-')[0].trim())+'</td>';
        h+='<td>'+(c.type==='Входящий'?'📥':'📤')+'</td>';
        h+='<td>'+dur+'</td>';
        h+='<td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(c.contact.substring(0,20))+'</td>';
        if(matchA){
          h+='<td>'+yn(matchA.howWeWork)+'</td><td>'+yn(matchA.callToAction)+'</td><td>'+yn(matchA.sentInvoice)+'</td>';
          const vc=matchA.verdict.includes('Эксперт')?'bg-b':matchA.verdict.includes('Хорошо')?'bg-g':matchA.verdict.includes('Средне')?'bg-y':'bg-r';
          h+='<td><strong>'+matchA.totalBalls+'</strong></td>';
          h+='<td><span class="bg '+vc+'">'+esc(matchA.verdict.split('(')[0].trim())+'</span></td>';
        } else {
          h+='<td colspan="5" style="color:#475569;font-size:11px">'+(c.duration<30?'Короткий':'Нет анализа')+'</td>';
        }
        h+='</tr>';
      }
      h+='</table>';
    }

    // Транскрибации звонков
    const callsWithTranscript=d.fComments.filter(c=>(c.type==='outCall'||c.type==='inCall')&&c.transcription);
    if(callsWithTranscript.length){
      h+='<h4>🎙 Транскрибации ('+callsWithTranscript.length+')</h4>';
      for(const c of callsWithTranscript.slice(0,5)){
        const tid='tr_'+d.id+'_'+c.id;
        const src=c.source==='contact'?' <span class="bg bg-p">👤 контакт</span>':'';
        h+='<div style="margin-bottom:6px"><button class="toggle-btn" onclick="toggleTr(&#39;'+tid+'&#39;)">'+(c.type==='outCall'?'📤':'📥')+' '+esc(c.date)+' '+esc(c.time)+'</button>'+src+' <span style="font-size:10px;color:#475069">показать/скрыть</span>';
        h+='<div id="'+tid+'" class="transcript" style="display:none">'+esc(c.transcription)+'</div></div>';
      }
    }

    // Заметки
    const notes=d.fComments.filter(c=>c.type==='note'&&c.text.length>5).slice(0,5);
    if(notes.length){
      h+='<h4>💬 Заметки</h4>';
      for(const n of notes){
        h+='<div class="cmt"><span style="color:#64748b;font-size:10px">'+esc(n.date)+' '+esc(n.time)+'</span> '+esc(n.text.substring(0,120))+'</div>';
      }
    }
    h+='</div>';
  }
  document.getElementById('out').innerHTML=h;
}

// === КАЧЕСТВО ===
function renderQuality(analyses,cards){
  let h='';

  // Скрипт новых сделок
  const sc=D.scriptCompliance;
  if(sc.total>0){
    h+='<div class="sec"><h3>🆕 Скрипт новых сделок ('+sc.total+' анализов)</h3>';
    h+='<div class="grid2"><div>';
    const criteria=[
      {l:'Рассказал как работаем',v:sc.howWeWork,t:sc.total},
      {l:'Призыв к действию',v:sc.callToAction,t:sc.total},
      {l:'Скинул счёт',v:sc.sentInvoice,t:sc.total},
      {l:'Все 4 момента',v:sc.allFour,t:sc.total},
    ];
    for(const cr of criteria){
      const pct=cr.t?Math.round(cr.v/cr.t*100):0;
      const col=pct>=50?'#34d399':pct>=25?'#fbbf24':'#f87171';
      h+='<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span>'+cr.l+'</span><span style="color:'+col+';font-weight:700">'+cr.v+'/'+cr.t+' ('+pct+'%)</span></div><div class="bar-bg" style="height:8px"><div class="bar-f" style="width:'+pct+'%;background:'+col+'"></div></div></div>';
    }
    h+='</div><div style="text-align:center;padding:20px">';
    const sc_col=sc.avgScore>=15?'#34d399':sc.avgScore>=10?'#fbbf24':'#f87171';
    h+='<div style="font-size:36px;font-weight:800;color:'+sc_col+'">'+sc.avgScore+'</div>';
    h+='<div style="font-size:12px;color:#64748b">Ср. балл новых</div>';
    h+='</div></div>';

    // Детали по сделкам
    if(sc.details.length){
      h+='<h4>Детали</h4><table><tr><th>Сделка</th><th>Тема</th><th>Как раб.</th><th>Призыв</th><th>Счёт</th><th>Все 4</th><th>Баллы</th><th>Вердикт</th></tr>';
      for(const a of sc.details){
        const vc=a.verdict.includes('Эксперт')?'bg-b':a.verdict.includes('Хорошо')?'bg-g':a.verdict.includes('Средне')?'bg-y':'bg-r';
        h+='<tr><td style="font-size:11px">#'+a.dealId+'</td>';
        h+='<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.topic.substring(0,30))+'</td>';
        h+='<td>'+yn(a.howWeWork)+'</td><td>'+yn(a.callToAction)+'</td><td>'+yn(a.sentInvoice)+'</td><td>'+yn(a.allFour)+'</td>';
        h+='<td><strong>'+a.totalBalls+'</strong></td>';
        h+='<td><span class="bg '+vc+'">'+esc(a.verdict.split('(')[0].trim())+'</span></td></tr>';
      }
      h+='</table>';
    }
    h+='</div>';
  }

  // Общее качество
  const sorted=[...analyses].sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
  h+='<div class="sec"><h3>📊 Общее качество ('+analyses.length+')</h3><div style="overflow-x:auto"><table>';
  h+='<tr><th>Дата</th><th>Тема</th><th>Как раб.</th><th>Призыв</th><th>Счёт</th><th>Все 4</th><th>Баллы</th><th>Вердикт</th></tr>';
  for(const a of sorted){
    const vc=a.verdict.includes('Эксперт')?'bg-b':a.verdict.includes('Хорошо')?'bg-g':a.verdict.includes('Средне')?'bg-y':'bg-r';
    h+='<tr><td style="white-space:nowrap;font-size:11px">'+esc(a.date)+'</td>';
    h+='<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(a.topic)+'">'+esc(a.topic.substring(0,35))+'</td>';
    h+='<td>'+yn(a.howWeWork)+'</td><td>'+yn(a.callToAction)+'</td><td>'+yn(a.sentInvoice)+'</td><td>'+yn(a.allFour)+'</td>';
    h+='<td><strong>'+a.totalBalls+'</strong></td>';
    h+='<td><span class="bg '+vc+'">'+esc(a.verdict.split('(')[0].trim())+'</span></td></tr>';
  }
  h+='</table></div></div>';

  // Вердикты + Критерии
  const verdicts={};analyses.forEach(a=>{const v=a.verdict.split('(')[0].trim()||'?';verdicts[v]=(verdicts[v]||0)+1});
  h+='<div class="sec grid2"><div><h3>Вердикты</h3>';
  for(const[v,n]of Object.entries(verdicts).sort((a,b)=>b[1]-a[1])){
    const pct=Math.round(n/analyses.length*100);
    const col=v.includes('Эксперт')?'#60a5fa':v.includes('Хорошо')?'#34d399':v.includes('Средне')?'#fbbf24':'#f87171';
    h+='<div style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span>'+v+'</span><span style="color:'+col+';font-weight:700">'+n+' ('+pct+'%)</span></div><div class="bar-bg"><div class="bar-f" style="width:'+pct+'%;background:'+col+'"></div></div></div>';
  }
  h+='</div><div><h3>Критерии</h3>';
  [{l:'Как работаем',f:'howWeWork'},{l:'Призыв',f:'callToAction'},{l:'Счёт',f:'sentInvoice'},{l:'Все 4',f:'allFour'}].forEach(yr=>{
    const yes=analyses.filter(a=>a[yr.f]==='Да').length;const pct=analyses.length?Math.round(yes/analyses.length*100):0;
    const col=pct>=50?'#34d399':pct>=25?'#fbbf24':'#f87171';
    h+='<div style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span>'+yr.l+'</span><span style="color:'+col+';font-weight:700">'+pct+'%</span></div><div class="bar-bg"><div class="bar-f" style="width:'+pct+'%;background:'+col+'"></div></div></div>';
  });
  h+='</div></div>';
  document.getElementById('out').innerHTML=h;
}

// === ЕЖЕДНЕВНЫЕ ===
function renderDaily(reports){
  const sorted=[...reports].sort((a,b)=>b.date.localeCompare(a.date));
  let h='<div class="sec"><h3>📅 Ежедневные</h3><div style="overflow-x:auto"><table>';
  h+='<tr><th>Дата</th><th>Оплаты</th><th>Исх.</th><th>Мин</th><th>КП</th><th>Дожим</th><th>Договор</th><th>Выполн.</th></tr>';
  for(const r of sorted){
    h+='<tr><td><strong>'+fmtD(r.date)+'</strong></td>';
    h+='<td>'+(r.revenue?'<span style="color:#fbbf24;font-weight:700">'+fmt(r.revenue)+'₽</span>':'—')+'</td>';
    h+='<td>'+(r.outCalls||'—')+'</td><td>'+(r.callMinutes||'—')+'</td><td>'+(r.kpSent||'—')+'</td><td>'+(r.dozhim||'—')+'</td>';
    h+='<td>'+(r.contract?'<span class="bg bg-g">'+r.contract+'</span>':'—')+'</td>';
    h+='<td>'+(r.workDone||'—')+'</td></tr>';
  }
  h+='</table></div></div>';
  document.getElementById('out').innerHTML=h;
}

// === ВОРОНКА ===
function renderFunnel(){
  const funnel={};D.dealCards.forEach(d=>{funnel[d.status]=(funnel[d.status]||0)+1});
  const order=['Новая','Обработка','В работе','Коммерческое предложение','Вывезли/Нашли поставщика','Дожим','Договор и оплата','Выполнение Работы','Сделанная','Сделка завершена'];
  const max=Math.max(...Object.values(funnel),1);

  let h='<div class="sec"><h3>📊 Воронка ('+D.dealCards.length+')</h3>';
  [...order,...Object.keys(funnel).filter(k=>!order.includes(k))].forEach(s=>{
    const n=funnel[s]||0;if(!n)return;
    const pct=Math.round(n/max*100);const good=['Договор и оплата','Выполнение Работы','Сделка завершена','Сделанная'].includes(s);
    h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px"><span style="width:180px;font-size:12px;color:#94a3b8;text-align:right;flex-shrink:0">'+s+'</span><div class="bar-bg" style="flex:1;height:18px"><div class="bar-f" style="width:'+pct+'%;background:'+(good?'#34d399':'#60a5fa')+'"></div></div><span style="width:30px;font-size:13px;font-weight:700;text-align:right">'+n+'</span></div>';
  });
  h+='</div>';

  // Изменения воронки
  if(D.funnelChanges.length){
    h+='<div class="sec"><h3>🔄 Изменения с прошлого запуска ('+D.funnelChanges.length+')</h3>';
    h+='<table><tr><th>Сделка</th><th>Контрагент</th><th>Было</th><th></th><th>Стало</th></tr>';
    for(const c of D.funnelChanges){
      const cls=c.direction==='forward'?'change-fwd':'change-bwd';
      const arrow=c.direction==='forward'?'→ ✅':'→ ⬅️';
      h+='<tr><td style="font-size:11px">#'+c.dealId+' '+esc(c.dealName.substring(0,40))+'</td>';
      h+='<td style="font-size:11px;color:#64748b">'+esc(c.counterparty.substring(0,25))+'</td>';
      h+='<td><span class="bg bg-y">'+esc(c.from)+'</span></td>';
      h+='<td class="'+cls+'" style="font-size:14px">'+arrow+'</td>';
      h+='<td><span class="bg '+(c.direction==='forward'?'bg-g':'bg-r')+'">'+esc(c.to)+'</span></td></tr>';
    }
    h+='</table></div>';
  }

  document.getElementById('out').innerHTML=h;
}

function toggleTr(id){const el=document.getElementById(id);if(el)el.style.display=el.style.display==='none'?'block':'none'}
function toggleColl(id){
  const hdr=document.getElementById('hdr_'+id);
  const body=document.getElementById('body_'+id);
  if(!body)return;
  const isOpen=body.classList.contains('open');
  if(isOpen){body.classList.remove('open');hdr.classList.remove('open')}
  else{body.classList.add('open');hdr.classList.add('open')}
}
function fmt(n){return n?n.toLocaleString('ru-RU'):'0'}
function fmtD(iso){if(!iso)return'?';const d=new Date(iso);return isNaN(d)?iso:d.toLocaleDateString('ru-RU',{day:'2-digit',month:'short'})}
function yn(v){return v==='Да'?'<span class="yes">✓</span>':'<span class="no">✗</span>'}
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')}
function timeToMin(t){const m=(t||'').match(/(\\d+):(\\d+)/);return m?parseInt(m[1])*60+parseInt(m[2]):0}
init();
</script></body></html>`;
}

// ============ MAIN ============
async function main() {
  const filterName = process.argv[2] || 'Боровая';
  const mgr = MANAGERS[filterName];
  if (!mgr) { console.error('❌ Менеджер не найден'); process.exit(1); }
  if (!TOKEN) { console.error('❌ PLANFIX_TOKEN не задан'); process.exit(1); }

  // Определяем дату отчёта
  const arg3 = process.argv[3] || '';
  let reportDate; // DD-MM-YYYY формат
  if (/^\d{2}-\d{2}-\d{4}$/.test(arg3)) {
    reportDate = arg3; // конкретная дата
  } else {
    const now = new Date();
    reportDate = `${pad2(now.getDate())}-${pad2(now.getMonth()+1)}-${now.getFullYear()}`;
  }

  console.log(`🚀 ТрансКом v8.0 — ${mgr.name} — ${reportDate}\n`);

  const tasks = await getAllTasks(mgr.userId);
  console.log(`  ✅ Сделок: ${tasks.length}\n`);

  const result = await buildDealCards(tasks, mgr.pfName, reportDate);
  const { dealCards, dailyReports, allCalls, allAnalyses, dailyActivity, funnelChanges, scriptCompliance, dailyDealActivity, aiDaySummaryText, multiDayActivity, multiDaySummary } = result;

  console.log(`\n  📊 Сделок с звонками: ${dealCards.filter(d => d.totalCalls > 0).length}`);
  console.log(`  📞 Всего звонков: ${allCalls.length}`);
  console.log(`  🔍 Всего анализов: ${allAnalyses.length}`);
  console.log(`  📅 Ежедневных отчётов: ${dailyReports.length}`);
  console.log(`  🆕 Новых сделок за день: ${dailyActivity.newDeals.length}`);
  console.log(`  ⚡ Обработано за день: ${dailyActivity.workedDeals.length}`);
  console.log(`  🔄 Изменений воронки: ${funnelChanges.length}`);
  console.log(`  📝 Анализов новых сделок: ${scriptCompliance.total}`);
  console.log(`  🤖 ИИ-сделок за день: ${dailyDealActivity.length}`);

  const outData = {
    generated: new Date().toISOString(),
    manager: mgr.name,
    reportDate,
    dealCards, dailyReports, dailyActivity, funnelChanges, scriptCompliance,
    dailyDealActivity, aiDaySummaryText,
    multiDayActivity, multiDaySummary,
    snapshotDate: result.snapshotDate,
  };

  fs.writeFileSync(path.join(__dirname, 'latest_data.json'), JSON.stringify(outData, null, 2), 'utf8');
  const htmlPath = path.join(__dirname, 'report.html');
  fs.writeFileSync(htmlPath, generateHtml(mgr.name, outData), 'utf8');

  console.log(`\n🌐 ${htmlPath}`);
  try {
    const { exec } = require('child_process');
    exec(process.platform === 'win32' ? `start "" "${htmlPath}"` : `xdg-open "${htmlPath}"`);
  } catch {}
  console.log('✅ Готово!');
}

// === Отправка рекомендаций в Planfix ===
async function sendRecommendations(taskIdFilter) {
  const dataFile = path.join(__dirname, 'latest_data.json');
  if (!fs.existsSync(dataFile)) { console.error('❌ latest_data.json не найден. Сначала запустите отчёт.'); return; }
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const deals = data.dailyDealActivity || [];
  if (!deals.length) { console.log('Нет сделок с дневной активностью.'); return; }

  const toSend = taskIdFilter === 'all'
    ? deals.filter(d => d.aiAssessment)
    : deals.filter(d => d.deal.id === Number(taskIdFilter) && d.aiAssessment);

  if (!toSend.length) { console.log(`Нет сделок для отправки${taskIdFilter !== 'all' ? ' (ID: ' + taskIdFilter + ')' : ''}`); return; }

  console.log(`📤 Отправка ИИ-рекомендаций в Planfix для ${toSend.length} сделок...\n`);

  for (const da of toSend) {
    const aa = da.aiAssessment;
    const ss = aa.salaryScore || {};
    let h = `<b>🤖 ИИ-оценка сделки за ${data.reportDate}</b><br><br>`;
    if (aa.todaySummary) h += `📅 <b>Итог дня:</b> ${aa.todaySummary}<br><br>`;
    if (aa.overallVerdict) h += `📊 <b>Вердикт:</b> ${aa.overallVerdict}<br><br>`;
    h += '<b>📋 Скрипт продаж:</b><br>';
    const vp = aa.verbalPresentation;
    if (vp) h += `&nbsp;&nbsp;Устная презентация: ${vp.overall ? '✅ (' + vp.source + ')' : '❌'}<br>`;
    const hw = aa.howWeWork;
    if (hw) h += `&nbsp;&nbsp;Как мы работаем: ${hw.done ? '✅ (' + hw.source + ')' : '❌'}<br>`;
    if (aa.writtenPresentation) h += `&nbsp;&nbsp;Презентация (файл): ${aa.writtenPresentation.done ? '✅' : '❌'}<br>`;
    if (aa.cp) h += `&nbsp;&nbsp;КП: ${aa.cp.done ? '✅' : '❌'}${aa.cp.note ? ' — ' + aa.cp.note : ''}<br>`;
    if (aa.invoice) h += `&nbsp;&nbsp;Счёт: ${aa.invoice.done ? '✅' : '❌'}${aa.invoice.note ? ' — ' + aa.invoice.note : ''}<br>`;
    if (aa.callToAction) h += `&nbsp;&nbsp;Призыв к действию: ${aa.callToAction.done ? '✅' : '❌'}<br>`;
    if (aa.objectionHandling) h += `&nbsp;&nbsp;Отработка возражений: ${aa.objectionHandling.done ? '✅' : '❌'}<br>`;
    h += `<br><b>💰 Баллы ЗП: ${ss.total}/${ss.max}</b><br>`;
    const miss = aa.missing || [];
    if (miss.length) { h += '<br><b>❗ Не выполнено:</b><br>'; for (const m of miss) h += `&nbsp;&nbsp;• ${m}<br>`; }
    const recs = aa.recommendations || [];
    if (recs.length) { h += '<br><b>💡 Рекомендации:</b><br>'; for (const r of recs) h += `&nbsp;&nbsp;• ${r}<br>`; }

    try {
      const result = await pf(`/task/${da.deal.id}/comments/`, { description: h });
      console.log(`  ✅ #${da.deal.id} ${da.deal.name.substring(0, 40)} — отправлено`);
    } catch (e) {
      console.error(`  ❌ #${da.deal.id} — ошибка: ${e.message || JSON.stringify(e)}`);
    }
    await sleep(300);
  }
  console.log('\n✅ Готово!');
}

// Роутинг команд
const cmd = process.argv[3] || '';
if (cmd === '--send' || cmd === '--send-all') {
  const target = process.argv[4] || 'all';
  sendRecommendations(target).catch(e => { console.error('❌', e.message || e); process.exit(1); });
} else {
  main().catch(e => { console.error('❌', e.message || e); process.exit(1); });
}
