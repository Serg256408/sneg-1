// ============================================================
// ТрансКом — Аналитика v8.0
// Дневной отчёт с ИИ-анализом, транскрибации, скрипт
// Запуск: node analytics.js "Боровая"              (сегодня)
//         node analytics.js "Боровая" 11-03-2026   (конкретный день)
//         node analytics.js "Боровая" 7            (дней назад для dataTags)
//         node analytics.js borovaya 11-03-2026    (ASCII alias for batch/scheduler)
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
// Загрузка менеджеров из managers.json (фоллбэк на хардкод)
const MANAGERS_FILE = path.join(__dirname, 'managers.json');
let MANAGERS_LIST = [{ alias: 'borovaya', userId: 41, name: 'Ия Боровая', pfName: 'Боровая' }];
try { MANAGERS_LIST = JSON.parse(fs.readFileSync(MANAGERS_FILE, 'utf8')); } catch {}
const MANAGERS = {};
for (const m of MANAGERS_LIST) {
  MANAGERS[m.pfName] = m;
  MANAGERS[m.alias] = m;
  if (m.pfName) MANAGERS[m.pfName.toLowerCase()] = m;
}

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
const CONCURRENCY = 10; // параллельных запросов к API
async function parallelMap(items, fn, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
const pad2 = (n) => String(n).padStart(2, '0');

function timeToMinNode(t) {
  const m = (t || '').match(/(\d+):(\d+)/);
  return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 0;
}

// ПРАВИЛО: Planfix API возвращает dateTime комментариев в UTC.
// Все времена в отчёте ОБЯЗАНЫ быть в МСК (UTC+3).
// Эта функция конвертирует дату/время из UTC в МСК.
function utcToMsk(dateStr, timeStr) {
  if (!timeStr) return { date: dateStr || '', time: '' };
  const tm = (timeStr || '').match(/(\d+):(\d+)/);
  if (!tm) return { date: dateStr || '', time: timeStr || '' };
  let h = parseInt(tm[1]) + 3; // UTC+3
  let date = dateStr || '';
  if (h >= 24) {
    h -= 24;
    // Переносим дату на +1 день если формат DD-MM-YYYY
    const dp = date.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (dp) {
      const d = new Date(`${dp[3]}-${dp[2]}-${dp[1]}`);
      d.setDate(d.getDate() + 1);
      date = `${pad2(d.getDate())}-${pad2(d.getMonth()+1)}-${d.getFullYear()}`;
    }
  }
  return { date, time: `${pad2(h)}:${tm[2]}` };
}

const CALL_TAG = 15900;
const ANALYSIS_TAG = 15920;
const DEAL_FIELDS = 'id,name,parent,status,dateTime,counterparty,dataTags,67906,76880,76866,76868,76872,76874,76876,76878';
// Статусы которые НЕ анализируем (деньги уже поступили или завершена)
const SKIP_STATUSES = ['Сделанная', 'Завершённая', 'Сделка завершена'];
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
  return (h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<hr\s*\/?>/gi, '\n----------\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/-{5,}/g, '----------').replace(/\n{3,}/g, '\n\n').trim();
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
      'https://polza.ai/api/v1/audio/transcriptions',
      '-H', `Authorization: Bearer ${OPENAI_KEY}`,
      '-F', `file=@${audioPath}`,
      '-F', 'model=openai/whisper-1',
      '-F', 'language=ru',
      '-F', 'response_format=text',
    ], { encoding: 'utf8', timeout: 120000 });
    const trimmed = result.trim();
    if (!trimmed) return null;
    // Polza.ai может вернуть JSON вместо текста — извлекаем text
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        return parsed.text || parsed.transcription || null;
      } catch {}
    }
    return trimmed;
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
  // Определяем провайдера по модели (с fallback на Polza.ai)
  const isDeepSeek = model && model.startsWith('deepseek');
  let apiKey = isDeepSeek ? DEEPSEEK_KEY : OPENAI_KEY;
  let apiUrl = isDeepSeek ? 'https://api.deepseek.com/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
  const polzaFallback = isDeepSeek && OPENAI_KEY; // Polza.ai через OPENAI_KEY
  if (!apiKey && polzaFallback) {
    apiKey = OPENAI_KEY;
    apiUrl = 'https://polza.ai/api/v1/chat/completions';
    model = 'deepseek/deepseek-chat';
  }
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
          // Fallback на Polza.ai при ошибке DeepSeek (auth failed, rate limit и т.д.)
          if (isDeepSeek && OPENAI_KEY && apiUrl.includes('deepseek.com')) {
            console.log('    🔄 DeepSeek недоступен, переключаюсь на Polza.ai...');
            apiKey = OPENAI_KEY;
            apiUrl = 'https://polza.ai/api/v1/chat/completions';
            model = 'deepseek/deepseek-chat';
            const newBody = JSON.stringify({ ...JSON.parse(body), model });
            fs.writeFileSync(tmp, newBody);
            continue;
          }
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
  const isSnow = (deal.name || '').toLowerCase().startsWith('вывоз снега');
  const cacheKey = `assess_${deal.id}_${reportDate}_${isSnow ? 'v19' : 'v19a'}`;
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
2. КАК МЫ РАБОТАЕМ (ТЕХНОЛОГИЯ) — done:true если менеджер показал ЭКСПЕРТНОЕ знание технологии работы: описал этапы, оборудование, материалы, технические детали. Менеджер должен продемонстрировать что РАЗБИРАЕТСЯ в процессе.
   ПРИМЕР для снега: "приезжает самосвал 20м3 и трактор-погрузчик, чистит территорию, грузит снег, вывозим на полигон, талоны дадим".
   СЧИТАЕТСЯ: описание процесса с конкретикой (техника, объёмы, этапы), экспертные знания ("под ключ" с деталями), описание оборудования. Также считается если менеджер объясняет как делается подушка, щебень, дренаж — любые технические подробности.
   НЕ считается: "замерщик приедет", "работаем по договору", "всё сделаем", общие фразы без технических деталей. source="call" только из транскрибации.
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
2. КАК МЫ РАБОТАЕМ (ТЕХНОЛОГИЯ) — done:true если менеджер показал ЭКСПЕРТНОЕ знание технологии работы: описал этапы, оборудование, материалы, технические характеристики. Менеджер должен продемонстрировать что РАЗБИРАЕТСЯ в асфальтировании.
   ПРИМЕР: "вырезаем карты швонарезчиком, прямоугольные, отступаем 5 см от краёв, демонтаж экскаватором-погрузчиком с молотом, обрабатываем битумной эмульсией, укладываем мелкозернистый асфальт 30% щебня, горячий 120 градусов".
   СЧИТАЕТСЯ: описание этапов работ (разметка, фрезеровка, подготовка основания, укладка), упоминание техники (каток, швонарезчик, экскаватор, асфальтоукладчик), материалов (крошка, щебень, битум, эмульсия, мелкозернистый/крупнозернистый асфальт), технических параметров (температура, толщина слоя, состав). Также считается описание подушки, дренажа, уклонов — любые экспертные технические подробности.
   НЕ считается: "замерщик приедет", "работаем по договору", "всё сделаем под ключ" без технических деталей. source="call" только из транскрибации.
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
      const vpLabels = isSnow
        ? { since2014: 'С 2014 года', manyObjects: 'Много объектов', govClients: 'Госучреждения', reliableInSnow: 'Надёжность', manyVehicles: 'Много техники' }
        : { since2014: 'С 2014 года', fiveBrigades: '5 бригад', fullCycle: 'Полный цикл', bigProjects: 'Крупные', guarantee: 'Гарантия' };
      const doneLabels = Object.entries(vpLabels).filter(([k]) => vp[k]?.done).map(([, v]) => v.toLowerCase());
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

let SNAPSHOT_FILE = path.join(__dirname, 'funnel_snapshot.json');

function setSnapshotFile(alias) {
  const perMgr = path.join(__dirname, 'data', `${alias}_funnel.json`);
  // Миграция: если per-manager файла нет, но старый есть — копируем
  if (!fs.existsSync(perMgr) && fs.existsSync(path.join(__dirname, 'funnel_snapshot.json'))) {
    try { fs.copyFileSync(path.join(__dirname, 'funnel_snapshot.json'), perMgr); } catch {}
  }
  SNAPSHOT_FILE = perMgr;
}

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

async function discoverEmployees() {
  const users = new Map();
  // Собираем из первых 500 задач
  for (let off = 0; off < 500; off += 100) {
    try {
      const r = await pf('/task/list', { offset: off, pageSize: 100, fields: 'id,assignees' });
      for (const t of (r.tasks || [])) {
        for (const u of (t.assignees?.users || [])) {
          const numId = parseInt((u.id || '').replace('user:', ''));
          if (numId && u.name) users.set(numId, u.name);
        }
      }
      if ((r.tasks || []).length < 100) break;
    } catch { break; }
  }
  // Добавляем текущих менеджеров из managers.json (на случай если не найдены)
  for (const m of MANAGERS_LIST) users.set(m.userId, m.name);
  return [...users.entries()].map(([id, name]) => {
    const existing = MANAGERS_LIST.find(m => m.userId === id);
    const lastName = name.split(' ').pop();
    return {
      userId: id, name,
      alias: existing?.alias || lastName.toLowerCase().replace(/[^a-zа-яё]/gi, ''),
      pfName: existing?.pfName || lastName,
    };
  });
}

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

async function buildDealCards(tasks, mgrPfName, reportDate, mgrAlias) {
  if (mgrAlias) setSnapshotFile(mgrAlias);
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
        const hasCallTranscription = desc.includes('----------') && (/[🔴🔵]/.test(desc) || /\bA:.*\bB:/s.test(desc));
        const hasCallRecording = (c.files || []).some(f => (f.name || '').toLowerCase().includes('запись звонка'));
        if (hasCallTranscription || hasCallRecording) {
          type = 'inCall'; // по умолчанию входящий, если направление неизвестно
        }
      }

      let transcription = null;
      if (type === 'outCall' || type === 'inCall') {
        transcription = extractTranscription(c.description);
        if (!transcription && OPENAI_KEY) {
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

      for (const taskId of contactToTasks[cpId]) {
        if (!contactCallsByTask[taskId]) contactCallsByTask[taskId] = [];
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
    contactIdx++;
    if (contactIdx % 10 === 0) process.stdout.write(`\r    [${contactIdx}/${uniqueContacts.length}]`);
  }, CONCURRENCY);
  console.log(`\r    [${uniqueContacts.length}/${uniqueContacts.length}]`);
  console.log(`    ✅ ${contactCallsTotal} звонков из контактов`);

  // Извлечение краткого описания работ из названия сделки
  function extractWorkDesc(name) {
    if (!name) return '';
    const n = name.toLowerCase();
    // Ключевые слова работ
    const workKeywords = [
      /асфальт\S*/i, /рем(?:онт)?\s+\S+/i, /вывоз\s+снега/i, /укладк\S*/i, /благоустройств\S*/i,
      /тротуар\S*/i, /дорог\S*/i, /площадк\S*/i, /парковк\S*/i, /бордюр\S*/i,
      /крошк\S*/i, /фрезеровк\S*/i, /разметк\S*/i, /щебен\S*/i, /грунтовк\S*/i,
    ];
    // Объём: число + единица измерения
    const volMatch = name.match(/(\d[\d\s.,]*)\s*(м2|м²|кв\.?\s*м|м\.п\.|п\.м\.|м\.кв|тонн|т\b|км|куб\.?\s*м|м3|м³|шт)/i);
    const vol = volMatch ? volMatch[0].trim() : '';
    // Тип работ из ключевых слов
    let workType = '';
    for (const re of workKeywords) {
      const m = name.match(re);
      if (m) { workType = m[0].trim(); break; }
    }
    if (!workType && !vol) return '';
    return [workType, vol].filter(Boolean).join(' ').trim();
  }

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
      const isManagerAction = c => c.owner && c.owner.includes(mgrPfName);
      const dayComments = card.comments.filter(c => c.date === dateDMY && isManagerAction(c));
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

  for (const dayDMY of daysList) {
    const dayDeals = buildDayActivityServer(dayDMY);
    if (!dayDeals.length) continue;

    // ИИ-оценка каждой сделки за этот день
    if (OPENAI_KEY) {
      const cached = dayDeals.filter(da => aiCache[`assess_${da.deal.id}_${dayDMY}_v18`] || aiCache[`assess_${da.deal.id}_${dayDMY}_v18a`]).length;
      const needAi = dayDeals.length - cached;
      if (needAi > 0) {
        console.log(`  🤖 ИИ-оценка ${dayDeals.length} сделок за ${dayDMY} (${cached} из кэша)...`);
      } else {
        process.stdout.write(`  🤖 ${dayDMY}: ${dayDeals.length} сделок (кэш) `);
      }
      let aiIdx = 0;
      await parallelMap(dayDeals, async (da) => {
        da.aiAssessment = await aiDealFullAssessment(da, dayDMY, aiCache);
        aiIdx++;
        if (needAi > 0) process.stdout.write(`\r    [${aiIdx}/${dayDeals.length}]`);
      }, CONCURRENCY);
      if (needAi > 0) console.log('\n    ✅');
      else console.log('✅');

      // ИИ итог дня
      multiDaySummary[dayDMY] = await aiDaySummary(dayDeals, dayDMY, aiCache, mgrAlias);
    }

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
  const prevSnapshot = loadPreviousSnapshot();
  const funnelChanges = computeFunnelChanges(prevSnapshot, dealCards);
  const currentSnapshot = saveSnapshot(dealCards);

  console.log(`  📊 Дневная активность: ${dailyActivity.newDeals.length} новых, ${dailyActivity.workedDeals.length} обработано`);
  console.log(`  🔄 Изменения воронки: ${funnelChanges.length}`);
  console.log(`  📝 Скрипт новых: ${scriptCompliance.total} анализов`);

  const allCalls = dealCards.flatMap(d => d.calls);
  const allAnalyses = dealCards.flatMap(d => d.analyses);

  // === Итоги для руководителя (день / неделя / месяц) ===
  const managerSummaries = { day: null, week: null, month: null };
  if (OPENAI_KEY) {
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

// ============ HTML ============

function buildStatsFromCache() {
  const cache = loadAiCache();
  const stats = {}; // { "DD-MM-YYYY": { deals: N, totalScore: N, maxScore: N, calls: N, texts: N, vpDone: N, hwDone: N, ctaDone: N, cpDone: N, invDone: N, presDone: N } }
  for (const [key, val] of Object.entries(cache)) {
    const m = key.match(/^assess_(\d+)_(\d{2}-\d{2}-\d{4})_v18a?$/);
    if (!m) continue;
    const date = m[2];
    if (!stats[date]) stats[date] = { deals: 0, totalScore: 0, maxScore: 0, scores: [], callSources: 0, textSources: 0, vpDone: 0, hwDone: 0, ctaDone: 0, cpDone: 0, invDone: 0, presDone: 0, objDone: 0 };
    const s = stats[date];
    s.deals++;
    const ss = val.salaryScore || {};
    s.totalScore += (ss.total || 0);
    s.maxScore += (ss.max || 12);
    s.scores.push(ss.total || 0);
    // VP
    if (val.verbalPresentation && val.verbalPresentation.overall) {
      s.vpDone++;
      if (val.verbalPresentation.source === 'call') s.callSources++; else s.textSources++;
    }
    if (val.howWeWork && val.howWeWork.done) {
      s.hwDone++;
      if (val.howWeWork.source === 'call') s.callSources++; else s.textSources++;
    }
    if (val.callToAction && val.callToAction.done) s.ctaDone++;
    if (val.cp && val.cp.done) s.cpDone++;
    if (val.invoice && val.invoice.done) s.invDone++;
    if (val.writtenPresentation && val.writtenPresentation.done) s.presDone++;
    if (val.objectionHandling && val.objectionHandling.done) s.objDone++;
  }
  // Сортируем по дате
  const sorted = Object.entries(stats).sort((a, b) => {
    const pa = a[0].split('-'), pb = b[0].split('-');
    return new Date(pa[2]+'-'+pa[1]+'-'+pa[0]) - new Date(pb[2]+'-'+pb[1]+'-'+pb[0]);
  });
  return sorted.map(([date, s]) => ({
    date, deals: s.deals,
    totalScore: s.totalScore, maxScore: s.maxScore,
    avgScore: s.deals ? Math.round(s.totalScore / s.deals * 10) / 10 : 0,
    scores: s.scores,
    callSources: s.callSources, textSources: s.textSources,
    vpDone: s.vpDone, hwDone: s.hwDone, ctaDone: s.ctaDone,
    cpDone: s.cpDone, invDone: s.invDone, presDone: s.presDone, objDone: s.objDone,
  }));
}

function generateHtml(managerName, data, allManagers) {
  // Статистика из кэша ИИ + операционные данные из dealCards
  const statsData = buildStatsFromCache();
  // Операционная статистика по дням из dealCards
  const opsStats = {};
  const mgrNameLow = (managerName || '').toLowerCase();
  for (const card of (data.dealCards || [])) {
    // Звонки по дням (уже фильтрованы по менеджеру из dataTags)
    for (const c of (card.calls || [])) {
      if (!c.date) continue;
      if (!opsStats[c.date]) opsStats[c.date] = { outCalls: 0, inCalls: 0, callDuration: 0, dealsWorked: new Set(), newDeals: new Set(), oldDeals: new Set(), statuses: {} };
      const os = opsStats[c.date];
      if (c.type === 'Исходящий') os.outCalls++; else os.inCalls++;
      os.callDuration += (c.duration || 0);
      os.dealsWorked.add(card.id);
      // isNew по дате дня, а не reportDate
      const isNewOnDay = card.dateCreated === c.date;
      if (isNewOnDay) os.newDeals.add(card.id); else os.oldDeals.add(card.id);
    }
    // Комментарии по дням — ТОЛЬКО от менеджера (не роботы, не клиенты)
    for (const c of (card.comments || [])) {
      if (!c.date) continue;
      const ownerLow = (c.owner || '').toLowerCase();
      if (!ownerLow || !mgrNameLow || !ownerLow.includes(mgrNameLow)) continue;
      if (!opsStats[c.date]) opsStats[c.date] = { outCalls: 0, inCalls: 0, callDuration: 0, dealsWorked: new Set(), newDeals: new Set(), oldDeals: new Set(), statuses: {} };
      opsStats[c.date].dealsWorked.add(card.id);
      const isNewOnDay = card.dateCreated === c.date;
      if (isNewOnDay) opsStats[c.date].newDeals.add(card.id); else opsStats[c.date].oldDeals.add(card.id);
    }
  }
  // Конвертируем Set в числа + мёржим с AI stats
  const opsArray = Object.entries(opsStats).map(([date, o]) => ({
    date, outCalls: o.outCalls, inCalls: o.inCalls,
    callDuration: o.callDuration, callMinutes: Math.round(o.callDuration / 60),
    dealsWorked: o.dealsWorked.size, newDeals: o.newDeals.size, oldDeals: o.oldDeals.size,
  })).sort((a, b) => {
    const pa = a.date.split('-'), pb = b.date.split('-');
    return new Date(pa[2]+'-'+pa[1]+'-'+pa[0]) - new Date(pb[2]+'-'+pb[1]+'-'+pb[0]);
  });
  data.statsData = statsData;
  data.opsStats = opsArray;
  // Статусы воронки для статистики
  const statusCounts = {};
  for (const card of (data.dealCards || [])) { statusCounts[card.status] = (statusCounts[card.status] || 0) + 1; }
  data.statusCounts = statusCounts;
  // Безопасная сериализация JSON для встраивания в <script>
  const json = JSON.stringify(data)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--')
    .replace(/`/g, '\\u0060');
  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ТрансКом — ${managerName}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%230f172a'/%3E%3Cpath d='M16 18h32v8H36v20h-8V26H16z' fill='%2360a5fa'/%3E%3C/svg%3E">
<style>
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter','Manrope',system-ui,-apple-system,sans-serif;background:#f7f7f8;color:#1a1a2e;min-height:100vh}
.hdr{background:#fff;border-bottom:1px solid #e5e5e5;padding:14px 20px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.hdr-in{max-width:1200px;margin:0 auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#d97706,#b45309);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#1a1a2e}
.pbar{display:flex;gap:5px;margin-left:auto;flex-wrap:wrap}
.pbtn{padding:6px 12px;border-radius:7px;border:1px solid #e5e5e5;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;background:#fff;color:#6b7280;transition:.2s}
.pbtn.on{background:#d97706;color:#1a1a2e;border-color:#d97706;box-shadow:0 2px 8px rgba(217,119,6,.2)}
.cnt{max-width:1200px;margin:0 auto;padding:16px}
.mets{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-bottom:14px}
.met{background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:10px;text-align:center}
.met-v{font-size:20px;font-weight:800;margin:2px 0;color:#1a1a2e}
.met-l{font-size:9px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.tabs{display:flex;gap:0;border-bottom:1px solid #e5e5e5;margin-bottom:14px;flex-wrap:wrap}
.tab{padding:8px 14px;cursor:pointer;color:#6b7280;font-size:13px;font-weight:600;border-bottom:2px solid transparent;transition:.2s}
.tab.on{color:#d97706;border-color:#d97706;background:rgba(217,119,6,.04)}
.sec{background:#fff;border:1px solid #e5e5e5;border-radius:14px;padding:16px;margin-bottom:12px}
.sec h3{font-size:14px;font-weight:700;color:#1a1a2e;margin-bottom:10px}
.sec h4{font-size:13px;font-weight:600;color:#6b7280;margin:10px 0 6px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:5px 8px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e5e5;font-size:11px;white-space:nowrap}
td{padding:5px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top;color:#374151}
tr:hover td{background:rgba(217,119,6,.03)}
.bg{padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;white-space:nowrap}
.bg-g{background:rgba(22,163,74,.1);color:#16a34a}
.bg-y{background:rgba(202,138,4,.1);color:#b45309}
.bg-r{background:rgba(220,38,38,.1);color:#dc2626}
.bg-b{background:rgba(37,99,235,.08);color:#2563eb}
.bg-p{background:rgba(124,58,237,.08);color:#7c3aed}
.yes{color:#16a34a;font-weight:700}.no{color:#9ca3af}
.bar-bg{height:5px;background:#f3f4f6;border-radius:3px;overflow:hidden;margin-top:2px}
.bar-f{height:100%;border-radius:3px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:700px){.grid2{grid-template-columns:1fr}.mets{grid-template-columns:repeat(3,1fr)}}
.deal-hdr{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px}
.deal-meta{font-size:11px;color:#6b7280;display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
.deal-stat{display:flex;gap:12px;flex-wrap:wrap}
.deal-stat span{font-size:12px;font-weight:700}
.cmt{font-size:11px;color:#6b7280;padding:4px 0;border-bottom:1px solid #f3f4f6}
.cmt-type{font-size:10px;font-weight:700;margin-right:4px}
.no-data{text-align:center;padding:30px;color:#9ca3af;font-size:14px}
.transcript{background:#f9fafb;border:1px solid #e5e5e5;border-radius:8px;padding:10px;margin:6px 0;font-size:11px;line-height:1.6;color:#374151;max-height:200px;overflow-y:auto;white-space:pre-wrap}
.toggle-btn{background:#fff;border:1px solid #d1d5db;color:#6b7280;padding:2px 8px;border-radius:5px;cursor:pointer;font-size:10px;font-family:inherit}
.toggle-btn:hover{color:#d97706;border-color:#d97706}
.act-card{background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:12px;margin-bottom:8px}
.act-card h4{margin:0 0 6px;font-size:13px;color:#1a1a2e}
.act-tag{display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;margin:2px}
.change-fwd{color:#16a34a}.change-bwd{color:#dc2626}
.ai-box{margin-top:10px;padding:10px;background:rgba(124,58,237,.04);border:1px solid rgba(124,58,237,.12);border-radius:8px}
.ai-label{font-size:11px;font-weight:700;color:#7c3aed;margin-bottom:4px}
.script-box{margin-top:10px;padding:10px;background:rgba(37,99,235,.03);border:1px solid rgba(37,99,235,.1);border-radius:8px}
/* Collapsible sections */
.coll{border-radius:10px;margin-top:10px;overflow:hidden;border:1px solid #e5e5e5}
.coll-hdr{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;user-select:none;transition:background .2s;font-size:12px;font-weight:700}
.coll-hdr:hover{background:#f9fafb}
.coll-hdr .arr{font-size:10px;color:#6b7280;transition:transform .25s;display:inline-block}
.coll-hdr.open .arr{transform:rotate(90deg)}
.coll-body{max-height:0;overflow:hidden;transition:max-height .3s ease-out}
.coll-body.open{max-height:5000px;transition:max-height .5s ease-in}
.coll-inner{padding:10px 14px 14px}
/* Card header redesign */
.card{background:#fff;border:1px solid #e5e5e5;border-radius:16px;margin-bottom:14px;overflow:hidden}
.card-top{padding:16px 18px 12px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;border-bottom:1px solid #f3f4f6;cursor:pointer;user-select:none;transition:background .2s}
.card-top:hover{background:#f9fafb}
.card-top .card-arrow{color:#6b7280;font-size:10px;transition:transform .2s;margin-right:4px}
.card-top.open .card-arrow{transform:rotate(90deg)}
.card-title{font-size:14px;font-weight:800;color:#1a1a2e;margin-bottom:4px}
.card-tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px}
.card-body{padding:0 4px 8px;display:none}
.card-body.open{display:block}
/* Result block */
.result-block{margin:12px 14px;padding:12px 16px;background:linear-gradient(135deg,rgba(37,99,235,.04),rgba(124,58,237,.03));border:1px solid rgba(37,99,235,.12);border-radius:12px}
.result-block .res-title{font-size:11px;font-weight:700;color:#2563eb;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.result-block .res-text{font-size:13px;line-height:1.7;color:#1a1a2e}
.result-block .res-verdict{font-size:12px;line-height:1.5;color:#b45309;margin-top:6px;font-weight:700;padding-top:6px;border-top:1px solid #f3f4f6}
/* Score pill */
.score-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:800}
.deal-tools{position:sticky;top:8px;z-index:4;background:rgba(255,255,255,.95);border:1px solid #e5e5e5;border-radius:16px;padding:14px 16px;margin-bottom:14px;backdrop-filter:blur(18px);box-shadow:0 4px 16px rgba(0,0,0,.06)}
.deal-tools-grid{display:grid;grid-template-columns:minmax(220px,2fr) repeat(3,minmax(150px,1fr));gap:10px}
.deal-field{display:flex;flex-direction:column;gap:6px}
.deal-label{font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px}
.deal-input,.deal-select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #d1d5db;background:#fff;color:#1a1a2e;font-size:13px;font-family:inherit;outline:none}
.deal-input:focus,.deal-select:focus{border-color:#d97706;box-shadow:0 0 0 3px rgba(217,119,6,.1)}
.deal-tools-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:12px}
.deal-chips{display:flex;gap:8px;flex-wrap:wrap}
.deal-chip{padding:7px 10px;border-radius:999px;background:#f3f4f6;border:1px solid #e5e5e5;font-size:12px;color:#374151}
.deal-chip strong{color:#1a1a2e}
.deal-card{background:#fff;border:1px solid #e5e5e5;border-radius:18px;margin-bottom:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.04)}
.deal-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:16px 18px;border-bottom:1px solid #f3f4f6;cursor:pointer;user-select:none;transition:background .2s}
.deal-card-top:hover{background:#f9fafb}
.deal-card-title{font-size:15px;font-weight:800;color:#1a1a2e;line-height:1.4}
.deal-card-top.open .card-arrow{transform:rotate(90deg)}
.deal-card-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px}
.deal-card-body{display:none;padding:16px 18px 18px}
.deal-card-body.open{display:block}
.deal-kpis{display:grid;grid-template-columns:repeat(4,minmax(88px,1fr));gap:8px;min-width:min(420px,100%)}
.deal-kpi{padding:10px 12px;border-radius:14px;background:#f9fafb;border:1px solid #e5e5e5;text-align:left}
.deal-kpi-v{display:block;font-size:18px;font-weight:800;color:#1a1a2e}
.deal-kpi-l{display:block;margin-top:3px;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.45px}
.deal-summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px;margin-bottom:14px}
.deal-summary-item{padding:10px 12px;border-radius:14px;background:#f9fafb;border:1px solid #e5e5e5}
.deal-summary-item b{display:block;font-size:11px;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px}
.deal-summary-item span{display:block;font-size:13px;font-weight:600;color:#1a1a2e;line-height:1.45}
.deal-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 8px}
.deal-section-title h4{margin:0}
.deal-empty{padding:18px;border-radius:14px;background:rgba(0,0,0,.03);border:1px dashed rgba(0,0,0,.08);color:#6b7280;text-align:center;font-size:13px}
.deal-table-wrap{overflow-x:auto;border:1px solid rgba(0,0,0,.03);border-radius:12px}
.deal-caption{font-size:11px;color:#6b7280}
@media(max-width:900px){
  .deal-tools-grid{grid-template-columns:repeat(2,minmax(160px,1fr))}
  .deal-kpis{grid-template-columns:repeat(2,minmax(88px,1fr));min-width:0;width:100%}
  .deal-summary{grid-template-columns:repeat(2,minmax(120px,1fr))}
}
@media(max-width:640px){
  .deal-tools{padding:12px}
  .deal-tools-grid{grid-template-columns:1fr}
  .deal-card-top{padding:14px}
  .deal-card-body{padding:14px}
  .deal-summary{grid-template-columns:1fr}
}
</style>
</head><body>
<div class="hdr"><div class="hdr-in">
  <div class="logo">T</div>
  <div><div style="font-size:17px;font-weight:800;color:#1a1a2e">${managerName}</div><div style="font-size:12px;color:#6b7280" id="upd"></div></div>
  ${allManagers ? `<div style="display:flex;gap:6px;margin-left:auto;margin-right:12px;flex-wrap:wrap">${allManagers.map(m =>
    m.name === managerName
      ? `<span style="padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;background:#3b82f6;color:#1a1a2e">${m.name}</span>`
      : `<a href="../${m.alias}/index.html" style="padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;background:#fff;color:#6b7280;text-decoration:none;border:1px solid #d1d5db">${m.name}</a>`
  ).join('')}<a href="../index.html" style="padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;background:#fff;color:#fbbf24;text-decoration:none;border:1px solid #d1d5db">Обзор</a></div>` : ''}
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
  // Если не нашли в dailyDealActivity — ищем в multiDayActivity для выбранной даты
  if(!da||!da.aiAssessment){
    var mda=D.multiDayActivity&&D.multiDayActivity[selectedDate];
    if(mda) da=mda.find(function(x){return x.deal.id===taskId});
  }
  if(!da||!da.aiAssessment)return null;
  var aa=da.aiAssessment;
  var ss=aa.salaryScore||{};
  var t='🤖 ИИ-оценка сделки за '+(selectedDate||D.reportDate)+'\\n\\n';
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
  if(aa.nextStep){t+='\\n▶ Следующий шаг: '+aa.nextStep+'\\n';}
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
const TABS_BASE=['','Все сделки','Качество','Ежедневные','Воронка','📊 Статистика','👔 Руководитель','📨 Входящие'];
let period=7,tab=0;
let currentCards=[];
let dealSearch='';
let dealStatus='all';
let dealFocus='all';
let dealSort='activity';
let dealFrom='';
let dealTo='';
const cardOpenState={};

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
function dateStamp(dateStr,timeStr){
  if(!dateStr)return 0;
  let year=0,month=0,day=0;
  const m1=dateStr.match(/(\\d{2})-(\\d{2})-(\\d{4})/);
  const m2=dateStr.match(/(\\d{4})-(\\d{2})-(\\d{2})/);
  if(m1){day=parseInt(m1[1],10);month=parseInt(m1[2],10)-1;year=parseInt(m1[3],10);}
  else if(m2){year=parseInt(m2[1],10);month=parseInt(m2[2],10)-1;day=parseInt(m2[3],10);}
  else{return 0;}
  const rawTime=(timeStr||'').split('-')[0].trim();
  const parts=rawTime.match(/(\\d{1,2}):(\\d{2})/);
  const hours=parts?parseInt(parts[1],10):0;
  const mins=parts?parseInt(parts[2],10):0;
  return new Date(year,month,day,hours,mins,0,0).getTime()||0;
}
function formatTouch(dateStr,timeStr){
  if(!dateStr)return 'Нет активности';
  const stamp=dateStamp(dateStr,timeStr);
  if(!stamp)return (dateStr||'')+(timeStr?' '+timeStr:'');
  return new Date(stamp).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
}
function getLastTouch(card){
  const items=[];
  (card.fCalls||[]).forEach(function(c){items.push({date:c.date,time:c.time,type:'call'});});
  (card.fAnalyses||[]).forEach(function(a){items.push({date:a.date,time:a.time,type:'analysis'});});
  (card.fComments||[]).forEach(function(c){items.push({date:c.date,time:c.time,type:c.type||'comment'});});
  items.sort(function(a,b){return dateStamp(b.date,b.time)-dateStamp(a.date,a.time);});
  return items[0]||null;
}
function getLastTouchAll(card){
  var items=[];
  (card.calls||[]).forEach(function(c){items.push({date:c.date,time:c.time});});
  (card.comments||[]).forEach(function(c){items.push({date:c.date,time:c.time});});
  items.sort(function(a,b){return dateStamp(b.date,b.time)-dateStamp(a.date,a.time);});
  return items[0]||null;
}
function getDaysSince(dateStr){
  if(!dateStr)return 999;
  var p=dateStr.split('-');
  if(p.length!==3)return 999;
  var d=new Date(p[2]+'-'+p[1]+'-'+p[0]);
  return Math.floor((Date.now()-d.getTime())/86400000);
}
function findLatestAiForDeal(id){
  var t=(D.dailyDealActivity||[]).find(function(da){return da.deal.id===id;});
  if(t&&t.aiAssessment)return t.aiAssessment;
  if(D.multiDayActivity){
    var dates=Object.keys(D.multiDayActivity).sort(function(a,b){
      var pa=a.split('-'),pb=b.split('-');
      return new Date(pb[2]+'-'+pb[1]+'-'+pb[0])-new Date(pa[2]+'-'+pa[1]+'-'+pa[0]);
    });
    for(var i=0;i<dates.length;i++){
      var da=(D.multiDayActivity[dates[i]]||[]).find(function(x){return x.deal.id===id;});
      if(da&&da.aiAssessment)return da.aiAssessment;
    }
  }
  return null;
}
function getScoreColor(avgB,maxB){
  if(avgB===null||avgB===undefined)return '#9ca3af';
  var max=maxB||12;
  var pct=avgB/max;
  return pct>=0.6?'#34d399':pct>=0.35?'#fbbf24':'#f87171';
}
function dealHasQuery(card,query){
  if(!query)return true;
  const hay=[card.id,card.name,card.counterparty,card.status].join(' ').toLowerCase();
  return hay.includes(query);
}
function setDealSearch(value,cursorPos){
  dealSearch=value||'';
  renderDealsV2(currentCards);
  requestAnimationFrame(function(){
    const el=document.getElementById('dealSearch');
    if(!el)return;
    el.focus();
    const pos=typeof cursorPos==='number'?cursorPos:dealSearch.length;
    try{el.setSelectionRange(pos,pos);}catch(e){}
  });
}
function setDealStatus(value){
  dealStatus=value||'all';
  renderDealsV2(currentCards);
}
function setDealFocus(value){
  dealFocus=value||'all';
  renderDealsV2(currentCards);
}
function setDealSort(value){
  dealSort=value||'activity';
  renderDealsV2(currentCards);
}
function resetDealFilters(){
  dealSearch='';
  dealStatus='all';
  dealFocus='all';
  dealSort='activity';
  dealFrom='';
  dealTo='';
  renderDealsV2(currentCards);
}

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
      deal:{id:card.id,name:card.name,status:card.status,counterparty:card.counterparty,dealSum:card.dealSum||0},
      isNew:isCreatedToday,
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
  })).filter(d=>d.fCalls.length||d.fAnalyses.length||d.fComments.length);
  currentCards=cards;

  const allC=cards.flatMap(d=>d.fCalls);
  const allA=cards.flatMap(d=>d.fAnalyses);
  const reports=D.dailyReports.filter(r=>inPeriod(r.date));
  if(tab===6){
    document.getElementById('mets').innerHTML='';
    renderManager();
    return;
  }
  if(tab===7){
    document.getElementById('mets').innerHTML='';
    renderIncoming();
    return;
  }
  renderMets(allC,allA,reports,cards);
  if(tab===0)renderDay();
  else if(tab===1)renderDealsV2(cards);
  else if(tab===2)renderQuality(allA,cards);
  else if(tab===3)renderDaily(reports);
  else if(tab===4)renderFunnel();
  else if(tab===5)renderStats();
}

function renderMets(calls,analyses,reports,cards){
  const sum=(a,f)=>a.reduce((s,r)=>s+(r[f]||0),0);
  const rev=sum(reports,'revenue');
  const durSec=calls.reduce((s,c)=>s+c.duration,0);
  const avgB=analyses.length?Math.round(analyses.reduce((s,a)=>s+a.totalBalls,0)/analyses.length*10)/10:0;
  const fwd=D.funnelChanges.filter(c=>c.direction==='forward').length;
  // Считаем новых, обработанных и звонков из multiDayActivity за выбранный период
  var newCount=0,workedCount=0,mdaCallCount=0,mdaCallDur=0;
  if(D.multiDayActivity){
    Object.keys(D.multiDayActivity).forEach(function(dt){
      if(!inPeriod(dt))return;
      var day=D.multiDayActivity[dt]||[];
      day.forEach(function(dd){
        if(dd.isNew)newCount++;
        workedCount++;
        (dd.actions||[]).forEach(function(a){
          if(a.type==='outCall'||a.type==='inCall'){mdaCallCount++;mdaCallDur+=(a.duration||0);}
        });
      });
    });
  } else {
    newCount=D.dailyActivity.newDeals.length;
    workedCount=D.dailyActivity.workedDeals.length;
  }
  var totalCalls=mdaCallCount||calls.length;
  var totalDurMin=mdaCallCount?Math.round(mdaCallDur/60):Math.round(durSec/60);
  const items=[
    {v:newCount,l:'Новых сегодня',c:'#a78bfa'},
    {v:workedCount,l:'Обработано',c:'#818cf8'},
    {v:fwd,l:'Продвинуто',c:'#34d399'},
    {v:totalCalls,l:'Звонков',c:'#60a5fa'},
    {v:totalDurMin+'м',l:'Время звонков',c:'#818cf8'},
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
  h+='<span style="font-size:12px;color:#6b7280;font-weight:600">📅 Дата:</span>';
  h+='<select id="datePicker" onchange="setDate(this.value)" style="padding:6px 10px;border-radius:8px;border:1px solid rgba(0,0,0,.1);background:#fff;color:#1a1a2e;font-size:13px;font-family:inherit;cursor:pointer">';
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
    h+='<div style="font-size:13px;line-height:1.7;color:#374151;white-space:pre-wrap">'+esc(daySummary)+'</div>';
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

  // Кнопка развернуть/свернуть
  h+='<div style="text-align:right;margin-bottom:8px"><button id="toggleAllBtn" onclick="toggleAllCards()" style="padding:4px 12px;font-size:11px;font-weight:600;color:#6b7280;background:rgba(0,0,0,.03);border:1px solid rgba(0,0,0,.08);border-radius:6px;cursor:pointer">📂 Развернуть всё</button></div>';

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

    // === CARD HEADER (always visible, click to expand) ===
    const cardId='card_'+uid;
    h+='<div class="card-top" id="chdr_'+cardId+'" onclick="toggleCard(&#39;'+cardId+'&#39;)">';
    h+='<div style="flex:1;min-width:200px">';
    h+='<div class="card-title"><span class="card-arrow">▶</span> #'+d.id+' '+esc((d.name||'').substring(0,70))+'</div>';
    h+='<div class="card-tags">';
    h+='<span style="font-size:11px;color:#6b7280">'+esc(d.counterparty)+'</span>';
    h+='<span class="bg bg-b">'+esc(d.status)+'</span>';
    var ws=(aa&&aa.workSummary)||d.workDesc||'';
    if(ws)h+='<span class="bg" style="background:rgba(147,197,253,.1);color:#93c5fd">'+esc(ws)+'</span>';
    if(d.dealSum)h+='<span class="bg" style="background:rgba(251,191,36,.12);color:#fbbf24">'+fmt(d.dealSum)+' ₽</span>';
    if(da.isNew)h+='<span class="bg bg-p">Новая</span>';
    else h+='<span class="bg bg-y">Старая</span>';
    var dcCard=D.dealCards.find(function(c){return c.id===d.id});
    if(dcCard&&dcCard.dateCreated)h+='<span style="font-size:10px;color:#6b7280;margin-left:2px">'+esc(dcCard.dateCreated)+'</span>';
    if(callCount)h+='<span class="bg" style="background:rgba(52,211,153,.12);color:#34d399">📞 '+callCount+'</span>';
    h+='</div>';
    h+='</div>';
    // Score pill
    if(dss.total!==undefined){
      h+='<div class="score-pill" style="background:rgba(251,191,36,.1);color:'+dsCol+'">💰 '+dss.total+'/'+dss.max+'</div>';
    }
    h+='</div>';

    h+='<div class="card-body" id="cbody_'+cardId+'">';

    // === РЕЗУЛЬТАТ ЗА ДЕНЬ ===
    if(aa.todaySummary){
      h+='<div class="result-block">';
      h+='<div class="res-title">📊 Результат за день</div>';
      h+='<div class="res-text">'+esc(aa.todaySummary)+'</div>';
      if(aa.overallVerdict){
        h+='<div class="res-verdict">→ '+esc(aa.overallVerdict)+'</div>';
      }
      h+='</div>';
    }

    // === ДЕЙСТВИЯ ЗА ДЕНЬ (collapsible, open by default) ===
    if(acts.length){
      const cid='acts_'+uid;
      h+='<div class="coll" style="background:#f9fafb">';
      h+='<div class="coll-hdr open" id="hdr_'+cid+'" onclick="toggleColl(&#39;'+cid+'&#39;)" style="color:#60a5fa;background:rgba(96,165,250,.06)">';
      h+='<span class="arr">▶</span> 📅 Действия за '+esc(selectedDate||'')+' <span style="color:#6b7280;font-weight:500;margin-left:4px">('+acts.length+')</span></div>';
      h+='<div class="coll-body open" id="body_'+cid+'"><div class="coll-inner">';
      for(let ai=0;ai<acts.length;ai++){
        const a=acts[ai];
        const isCall=a.type==='outCall'||a.type==='inCall';
        const icon=a.type==='outCall'?'📤':a.type==='inCall'?'📥':a.type==='ndz'?'⏰':'📝';
        const lbl=a.type==='outCall'?'Исходящий':a.type==='inCall'?'Входящий':a.type==='ndz'?'НДЗ':'Заметка';
        const src=a.source==='contact'?' <span class="bg bg-p" style="font-size:9px">контакт</span>':'';
        const durMin=a.duration?Math.round(a.duration/60):0;
        const durCol=durMin>=3?'#34d399':durMin>=1?'#fbbf24':'#f87171';
        h+='<div style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,.03)">';
        h+='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
        h+='<span style="color:#60a5fa;font-weight:700;font-size:13px">'+esc(a.time||'?')+'</span>';
        h+='<span style="font-size:12px;font-weight:600;color:#1a1a2e">'+icon+' '+lbl+'</span>'+src;
        if(a.duration)h+='<span style="font-size:12px;font-weight:700;color:'+durCol+'">'+durMin+'м</span>';
        h+='</div>';
        if(isCall){
          const nextNote=acts.slice(ai+1).find(n=>n.type==='note'&&n.text&&Math.abs(timeToMin(n.time)-timeToMin(a.time))<5);
          if(nextNote&&nextNote.text){
            h+='<div style="margin-top:6px;padding:8px 12px;background:rgba(251,191,36,.06);border-left:3px solid #fbbf24;border-radius:0 8px 8px 0;font-size:12px;color:#1a1a2e;line-height:1.6">'+esc(nextNote.text.substring(0,300))+'</div>';
          }
        }
        if(a.text&&!isCall){
          h+='<div style="margin-top:6px;padding:8px 12px;background:rgba(148,163,184,.05);border-left:3px solid #d1d5db;border-radius:0 8px 8px 0;font-size:12px;color:#374151;line-height:1.6">'+esc(a.text.substring(0,400))+'</div>';
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
      h+='<div class="coll-hdr" id="hdr_'+cid+'" onclick="toggleColl(&#39;'+cid+'&#39;)" style="color:#6b7280;background:rgba(100,116,139,.06)">';
      h+='<span class="arr">▶</span> 📜 История сделки <span style="color:#6b7280;font-weight:500;margin-left:4px">('+hist.length+' записей)</span></div>';
      h+='<div class="coll-body" id="body_'+cid+'"><div class="coll-inner" style="max-height:350px;overflow-y:auto">';
      for(const c of hist.slice(0,30)){
        const icon=c.type==='outCall'?'📤':c.type==='inCall'?'📥':c.type==='ndz'?'⏰':'📝';
        h+='<div style="padding:4px 0;border-bottom:1px solid rgba(0,0,0,.03)">';
        h+='<span style="color:#6b7280;font-size:10px;font-weight:600">'+esc(c.date)+' '+esc(c.time)+'</span> '+icon+' ';
        h+='<span style="font-size:11px;color:#6b7280">'+esc(c.text.substring(0,150))+'</span>';
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
        const prItems=aa.dealType==='asphalt'?[
          {k:'since2014',l:'С 2014 года'},
          {k:'fiveBrigades',l:'5 бригад + геодезист/проектировщик'},
          {k:'fullCycle',l:'Полный цикл работ'},
          {k:'bigProjects',l:'Крупные объекты'},
          {k:'guarantee',l:'Гарантия + бригадир + фото-отчёт'},
        ]:[
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
          if(v.note)h+=' <span style="color:#6b7280;font-size:10px">— '+esc(v.note)+'</span>';
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
          h+='<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(0,0,0,.02);border-radius:6px;border-left:3px solid '+ciBorderCol+'">';
          h+='<span style="font-size:14px">'+(ci.done?(ci.isText?'☑️':'✅'):'❌')+'</span>';
          h+='<span style="font-size:12px;font-weight:600;color:'+(ci.done?'#1a1a2e':'#9ca3af')+'">'+ci.label+'</span>';
          if(ci.badge){
            const bgCol=ci.badgeCall?'rgba(52,211,153,.15)':'rgba(251,191,36,.15)';
            const txCol=ci.badgeCall?'#34d399':'#fbbf24';
            h+='<span class="bg" style="font-size:9px;background:'+bgCol+';color:'+txCol+'">'+ci.badge+'</span>';
          }
          if(ci.note)h+='<span style="color:#6b7280;font-size:10px;margin-left:auto">'+esc(ci.note)+'</span>';
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
        h+='<div style="background:rgba(0,0,0,.05);border-radius:4px;height:8px;margin-bottom:8px"><div style="background:'+col+';height:100%;border-radius:4px;width:'+pct+'%;transition:width .3s"></div></div>';
        if(ss.items&&ss.items.length){
          for(const it of ss.items){
            h+='<div style="font-size:10px;color:#6b7280;padding:2px 0">✅ '+esc(it.name)+': <strong style="color:'+col+'">+'+it.score+'</strong>';
            if(it.note)h+=' <span style="color:#6b7280">— '+esc(it.note)+'</span>';
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
          h+='<div style="font-size:10px;color:#f87171;margin-top:6px;padding-top:6px;border-top:1px solid rgba(0,0,0,.03)">Не набрано: '+esc(missing.join(', '))+'</div>';
        }
        if(textWarnings.length){
          h+='<div style="font-size:10px;color:#fbbf24;margin-top:4px">⚠️ Балл снижен: '+esc(textWarnings.join('; '))+'. Рекомендуем проговаривать по телефону!</div>';
        }
        h+='</div>';
      }

      // Planfix анализ за сегодня
      const pf=da.planfixScript;
      if(pf){
        h+='<div style="margin-top:8px;padding:6px 10px;background:rgba(100,116,139,.06);border-radius:6px;font-size:10px;color:#6b7280">';
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

      if(aa.nextStep){
        h+='<div style="margin-top:8px;padding:8px 12px;background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.2);border-radius:8px">';
        h+='<div style="font-size:10px;font-weight:700;color:#60a5fa;margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px">▶ Следующий шаг</div>';
        h+='<div style="font-size:12px;color:#93c5fd;font-weight:600">'+esc(aa.nextStep)+'</div>';
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
          h+='<td colspan="5" style="color:#6b7280;font-size:11px">'+(c.duration<30?'Короткий':'Нет анализа')+'</td>';
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
        h+='<div class="cmt"><span style="color:#6b7280;font-size:10px">'+esc(n.date)+' '+esc(n.time)+'</span> '+esc(n.text.substring(0,120))+'</div>';
      }
    }
    h+='</div>';
  }
  document.getElementById('out').innerHTML=h;
}

// === КАЧЕСТВО ===
function renderDealsV2(cards){
  if(!cards.length){document.getElementById('out').innerHTML='<div class="no-data">Нет данных за период</div>';return}
  const query=(dealSearch||'').trim().toLowerCase();
  const statusOptions=[...new Set(cards.map(d=>d.status).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
  // Конвертация DD-MM-YYYY → YYYY-MM-DD для сравнения с date input
  function dmyToIso(d){if(!d)return '';var p=d.split('-');return p.length===3&&p[2].length===4?p[2]+'-'+p[1]+'-'+p[0]:d;}
  function inDealRange(dateStr){
    if(!dealFrom&&!dealTo)return true;
    var iso=dmyToIso(dateStr);
    if(dealFrom&&iso<dealFrom)return false;
    if(dealTo&&iso>dealTo)return false;
    return true;
  }
  var hasDealRange=!!(dealFrom||dealTo);
  const prepared=cards.map(d=>{
    // Фильтрация данных по выбранному периоду
    const fCalls=hasDealRange?d.fCalls.filter(c=>inDealRange(c.date)):d.fCalls;
    const fComments=hasDealRange?d.fComments.filter(c=>inDealRange(c.date)):d.fComments;
    const fAnalyses=hasDealRange?d.fAnalyses.filter(a=>inDealRange(a.date)):d.fAnalyses;
    const transcripts=fComments.filter(c=>(c.type==='outCall'||c.type==='inCall')&&c.transcription);
    const notes=fComments.filter(c=>c.type==='note'&&c.text.length>5);
    const durM=Math.round(fCalls.reduce((s,c)=>s+c.duration,0)/60);
    // ИИ salaryScore (из 12) — приоритет, иначе Planfix анализы
    const aiData=findLatestAiForDeal(d.id);
    const aiScore=aiData&&aiData.salaryScore?aiData.salaryScore:null;
    const avgB=aiScore?aiScore.total:fAnalyses.length?Math.round(fAnalyses.reduce((s,a)=>s+a.totalBalls,0)/fAnalyses.length*10)/10:null;
    const maxB=aiScore?aiScore.max:29;
    const lastTouch=getLastTouch(d);
    return {
      ...d,
      fCalls,fComments,fAnalyses,
      ui:{
        transcripts,
        notes,
        durM,
        avgB,
        maxB,
        lastTouch,
        lastStamp:lastTouch?dateStamp(lastTouch.date,lastTouch.time):0,
      }
    };
  }).filter(d=>{
    if(!dealHasQuery(d,query))return false;
    if(dealStatus!=='all'&&d.status!==dealStatus)return false;
    if(dealFocus==='new'&&!d.isNew)return false;
    if(dealFocus==='calls'&&!d.fCalls.length)return false;
    if(dealFocus==='analyses'&&!d.fAnalyses.length)return false;
    if(dealFocus==='transcripts'&&!d.ui.transcripts.length)return false;
    if(dealFocus==='notes'&&!d.ui.notes.length)return false;
    // Фильтр по периоду: показывать только сделки с активностью в диапазоне
    if(hasDealRange&&!d.fCalls.length&&!d.fComments.length&&!d.fAnalyses.length)return false;
    return true;
  });

  prepared.sort((a,b)=>{
    if(dealSort==='latest')return b.ui.lastStamp-a.ui.lastStamp||b.id-a.id;
    if(dealSort==='score')return (b.ui.avgB??-1)-(a.ui.avgB??-1)||b.ui.lastStamp-a.ui.lastStamp;
    if(dealSort==='sum')return (b.dealSum||0)-(a.dealSum||0)||b.ui.lastStamp-a.ui.lastStamp;
    if(dealSort==='name')return (a.name||'').localeCompare(b.name||'','ru');
    return b.fCalls.length-a.fCalls.length||b.fAnalyses.length-a.fAnalyses.length||b.ui.lastStamp-a.ui.lastStamp||b.id-a.id;
  });

  const visibleCalls=prepared.reduce((s,d)=>s+d.fCalls.length,0);
  const visibleAnalyses=prepared.reduce((s,d)=>s+d.fAnalyses.length,0);
  const visibleTranscripts=prepared.reduce((s,d)=>s+d.ui.transcripts.length,0);
  const visibleNew=prepared.filter(d=>d.isNew).length;
  const anyOpen=prepared.some(d=>cardOpenState['deal_'+d.id]);
  const hasFilters=!!dealSearch||dealStatus!=='all'||dealFocus!=='all'||dealSort!=='activity'||!!dealFrom||!!dealTo;

  let h='<div class="deal-tools">';
  h+='<div class="deal-tools-grid">';
  h+='<div class="deal-field"><span class="deal-label">Поиск</span><input id="dealSearch" class="deal-input" type="text" placeholder="ID, название, контрагент, статус" value="'+esc(dealSearch)+'" oninput="setDealSearch(this.value,this.selectionStart)"></div>';
  h+='<div class="deal-field"><span class="deal-label">Статус</span><select class="deal-select" onchange="setDealStatus(this.value)">';
  h+='<option value="all"'+(dealStatus==='all'?' selected':'')+'>Все статусы</option>';
  for(const status of statusOptions){
    h+='<option value="'+esc(status)+'"'+(dealStatus===status?' selected':'')+'>'+esc(status)+'</option>';
  }
  h+='</select></div>';
  h+='<div class="deal-field"><span class="deal-label">Фокус</span><select class="deal-select" onchange="setDealFocus(this.value)">';
  h+='<option value="all"'+(dealFocus==='all'?' selected':'')+'>Все сделки</option>';
  h+='<option value="new"'+(dealFocus==='new'?' selected':'')+'>Только новые</option>';
  h+='<option value="calls"'+(dealFocus==='calls'?' selected':'')+'>Есть звонки</option>';
  h+='<option value="analyses"'+(dealFocus==='analyses'?' selected':'')+'>Есть анализы</option>';
  h+='<option value="transcripts"'+(dealFocus==='transcripts'?' selected':'')+'>Есть транскрипции</option>';
  h+='<option value="notes"'+(dealFocus==='notes'?' selected':'')+'>Есть заметки</option>';
  h+='</select></div>';
  h+='<div class="deal-field"><span class="deal-label">Сортировка</span><select class="deal-select" onchange="setDealSort(this.value)">';
  h+='<option value="activity"'+(dealSort==='activity'?' selected':'')+'>По активности</option>';
  h+='<option value="latest"'+(dealSort==='latest'?' selected':'')+'>Последнее касание</option>';
  h+='<option value="score"'+(dealSort==='score'?' selected':'')+'>Средний балл</option>';
  h+='<option value="sum"'+(dealSort==='sum'?' selected':'')+'>Сумма сделки</option>';
  h+='<option value="name"'+(dealSort==='name'?' selected':'')+'>По названию</option>';
  h+='</select></div>';
  h+='</div>';
  // Фильтр по периоду (от — до)
  h+='<div style="display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap">';
  h+='<span style="font-size:11px;color:#6b7280">с</span>';
  h+='<input type="date" id="dealFrom" value="'+(dealFrom||'')+'" onchange="dealFrom=this.value;renderDealsV2(currentCards)" style="background:#fff;border:1px solid rgba(0,0,0,.1);color:#1a1a2e;padding:4px 8px;border-radius:6px;font-size:11px;font-family:inherit">';
  h+='<span style="font-size:11px;color:#6b7280">по</span>';
  h+='<input type="date" id="dealTo" value="'+(dealTo||'')+'" onchange="dealTo=this.value;renderDealsV2(currentCards)" style="background:#fff;border:1px solid rgba(0,0,0,.1);color:#1a1a2e;padding:4px 8px;border-radius:6px;font-size:11px;font-family:inherit">';
  if(dealFrom||dealTo)h+='<button class="toggle-btn" onclick="dealFrom=\\'\\';dealTo=\\'\\';renderDealsV2(currentCards)" style="font-size:11px;padding:3px 8px">✕</button>';
  h+='</div>';
  h+='<div class="deal-tools-row"><div class="deal-chips">';
  h+='<div class="deal-chip">Показано <strong>'+prepared.length+'</strong> из '+cards.length+'</div>';
  h+='<div class="deal-chip">Звонки <strong>'+visibleCalls+'</strong></div>';
  h+='<div class="deal-chip">Анализы <strong>'+visibleAnalyses+'</strong></div>';
  h+='<div class="deal-chip">Транскрипции <strong>'+visibleTranscripts+'</strong></div>';
  h+='<div class="deal-chip">Новые <strong>'+visibleNew+'</strong></div>';
  h+='</div><div style="display:flex;gap:8px;flex-wrap:wrap">';
  h+='<button id="toggleAllBtn" class="toggle-btn" onclick="toggleAllCards()">'+(anyOpen?'📁 Свернуть всё':'📂 Развернуть всё')+'</button>';
  if(hasFilters)h+='<button class="toggle-btn" onclick="resetDealFilters()">Сбросить фильтры</button>';
  h+='</div></div></div>';

  if(!prepared.length){
    h+='<div class="deal-empty">Ничего не найдено. Попробуйте изменить поиск, статус или фокус.</div>';
    document.getElementById('out').innerHTML=h;
    return;
  }

  for(const d of prepared){
    const avgB=d.ui.avgB;
    const scoreColor=getScoreColor(avgB,d.ui.maxB);
    const transcripts=d.ui.transcripts;
    const notes=d.ui.notes;
    const topNote=notes[0]?notes[0].text.substring(0,160):'';
    const cardId='deal_'+d.id;
    const isOpen=!!cardOpenState[cardId];
    const lastTouchLabel=d.ui.lastTouch?formatTouch(d.ui.lastTouch.date,d.ui.lastTouch.time):'Нет касаний';
    const statusClass=(d.status||'').includes('Договор')||(d.status||'').includes('Выполнение')||(d.status||'').includes('Сделка')?'bg-g':(d.status||'').includes('Коммерческое')||(d.status||'').includes('Дожим')?'bg-b':(d.status||'').includes('Новая')||(d.status||'').includes('Обработка')?'bg-y':'bg-p';
    const borderColor=d.isNew?'#a78bfa':avgB!==null?scoreColor:(d.fCalls.length?'#2563eb':'#d1d5db');
    h+='<div class="deal-card" style="border-left:3px solid '+borderColor+'">';
    h+='<div class="deal-card-top'+(isOpen?' open':'')+'" id="chdr_'+cardId+'" onclick="toggleCard(&#39;'+cardId+'&#39;)">';
    h+='<div style="flex:1;min-width:220px">';
    h+='<div class="deal-card-title"><span class="card-arrow">▸</span> #'+d.id+' '+esc((d.name||'').substring(0,80))+'</div>';
    h+='<div class="deal-card-meta">';
    h+='<span style="font-size:12px;color:#6b7280">'+esc((d.counterparty||'Без контрагента').substring(0,60))+'</span>';
    h+='<span class="bg '+statusClass+'">'+esc(d.status||'Без статуса')+'</span>';
    if(d.isNew)h+='<span class="bg bg-p">Новая</span>';
    if(transcripts.length)h+='<span class="bg bg-b">🎙 '+transcripts.length+'</span>';
    if(notes.length)h+='<span class="bg bg-y">💬 '+notes.length+'</span>';
    h+='</div></div>';
    h+='<div class="deal-kpis">';
    h+='<div class="deal-kpi"><span class="deal-kpi-v" style="color:#60a5fa">'+d.fCalls.length+'</span><span class="deal-kpi-l">Звонков</span></div>';
    h+='<div class="deal-kpi"><span class="deal-kpi-v" style="color:#818cf8">'+d.ui.durM+'м</span><span class="deal-kpi-l">Время</span></div>';
    h+='<div class="deal-kpi"><span class="deal-kpi-v" style="color:'+scoreColor+'">'+(avgB===null?'—':avgB+'/'+d.ui.maxB)+'</span><span class="deal-kpi-l">Средний балл</span></div>';
    h+='<div class="deal-kpi"><span class="deal-kpi-v" style="color:#1a1a2e">'+(d.dealSum?fmt(d.dealSum):'—')+'</span><span class="deal-kpi-l">Сумма</span></div>';
    h+='</div></div>';

    h+='<div class="deal-card-body'+(isOpen?' open':'')+'" id="cbody_'+cardId+'">';
    h+='<div class="deal-summary">';
    h+='<div class="deal-summary-item"><b>Последнее касание</b><span>'+esc(lastTouchLabel)+'</span></div>';
    h+='<div class="deal-summary-item"><b>Контрагент</b><span>'+esc(d.counterparty||'Не указан')+'</span></div>';
    h+='<div class="deal-summary-item"><b>Сигналы по сделке</b><span>Звонки: '+d.fCalls.length+' · Анализы: '+d.fAnalyses.length+' · Заметки: '+notes.length+'</span></div>';
    h+='<div class="deal-summary-item"><b>Последняя заметка</b><span>'+(topNote?esc(topNote):'Нет заметок в периоде')+'</span></div>';
    h+='</div>';

    if(d.fCalls.length){
      h+='<div class="deal-section-title"><h4>📞 Звонки</h4><span class="deal-caption">'+d.fCalls.length+' за выбранный период</span></div>';
      h+='<div class="deal-table-wrap"><table><tr><th>Дата</th><th>Время</th><th>Тип</th><th>Длит.</th><th>Контакт</th><th>Как работаем</th><th>Призыв</th><th>Счёт</th><th>Баллы</th><th>Вердикт</th></tr>';
      const sortedCalls=[...d.fCalls].sort((a,b)=>dateStamp(b.date,b.time)-dateStamp(a.date,a.time));
      for(const c of sortedCalls){
        const dur=c.duration>=60?Math.round(c.duration/60)+'м':c.duration+'с';
        const cMin=timeToMin(c.time);
        const matchA=d.fAnalyses.find(a=>{
          if(a.date!==c.date)return false;
          return Math.abs(timeToMin(a.time)-cMin)<10;
        });
        h+='<tr><td style="white-space:nowrap;font-size:11px">'+esc(c.date)+'</td>';
        h+='<td>'+esc((c.time||'').split('-')[0].trim())+'</td>';
        h+='<td>'+(c.type==='Р’С…РѕРґСЏС‰РёР№'?'📥':'📤')+'</td>';
        h+='<td>'+dur+'</td>';
        h+='<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((c.contact||'').substring(0,26))+'</td>';
        if(matchA){
          h+='<td>'+yn(matchA.howWeWork)+'</td><td>'+yn(matchA.callToAction)+'</td><td>'+yn(matchA.sentInvoice)+'</td>';
          const vc=matchA.verdict.includes('Р­РєСЃРїРµСЂС‚')?'bg-b':matchA.verdict.includes('РҐРѕСЂРѕС€Рѕ')?'bg-g':matchA.verdict.includes('РЎСЂРµРґРЅРµ')?'bg-y':'bg-r';
          h+='<td><strong>'+matchA.totalBalls+'</strong></td>';
          h+='<td><span class="bg '+vc+'">'+esc(matchA.verdict.split('(')[0].trim())+'</span></td>';
        } else {
          h+='<td colspan="5" style="color:#6b7280;font-size:11px">'+(c.duration<30?'Короткий звонок':'Нет анализа')+'</td>';
        }
        h+='</tr>';
      }
      h+='</table></div>';
    } else {
      h+='<div class="deal-empty">По этой сделке нет звонков в выбранном периоде.</div>';
    }

    if(transcripts.length){
      h+='<div class="deal-section-title"><h4>🎙 Транскрипции</h4><span class="deal-caption">'+transcripts.length+' записей</span></div>';
      for(const c of transcripts.slice(0,6)){
        const tid='tr_'+d.id+'_'+c.id;
        const src=c.source==='contact'?' <span class="bg bg-p">контакт</span>':'';
        h+='<div style="margin-bottom:8px"><button class="toggle-btn" onclick="toggleTr(&#39;'+tid+'&#39;)">'+(c.type==='outCall'?'📤':'📥')+' '+esc(c.date)+' '+esc(c.time)+'</button>'+src+' <span class="deal-caption">показать / скрыть</span>';
        h+='<div id="'+tid+'" class="transcript" style="display:none">'+esc(c.transcription)+'</div></div>';
      }
    }

    if(notes.length){
      h+='<div class="deal-section-title"><h4>💬 Заметки</h4><span class="deal-caption">'+notes.length+' записей</span></div>';
      for(const n of notes.slice(0,8)){
        h+='<div class="cmt"><span style="color:#6b7280;font-size:10px">'+esc(n.date)+' '+esc(n.time)+'</span> '+esc(n.text.substring(0,220))+'</div>';
      }
    }
    h+='</div></div>';
  }
  document.getElementById('out').innerHTML=h;
}

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
    h+='<div style="font-size:12px;color:#6b7280">Ср. балл новых</div>';
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
    h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px"><span style="width:180px;font-size:12px;color:#6b7280;text-align:right;flex-shrink:0">'+s+'</span><div class="bar-bg" style="flex:1;height:18px"><div class="bar-f" style="width:'+pct+'%;background:'+(good?'#34d399':'#60a5fa')+'"></div></div><span style="width:30px;font-size:13px;font-weight:700;text-align:right">'+n+'</span></div>';
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
      h+='<td style="font-size:11px;color:#6b7280">'+esc(c.counterparty.substring(0,25))+'</td>';
      h+='<td><span class="bg bg-y">'+esc(c.from)+'</span></td>';
      h+='<td class="'+cls+'" style="font-size:14px">'+arrow+'</td>';
      h+='<td><span class="bg '+(c.direction==='forward'?'bg-g':'bg-r')+'">'+esc(c.to)+'</span></td></tr>';
    }
    h+='</table></div>';
  }

  document.getElementById('out').innerHTML=h;
}

// === СТАТИСТИКА ===
let statFrom='',statTo='';
function parseDMY(d){const p=d.split('-');return new Date(p[2]+'-'+p[1]+'-'+p[0])}
function toISO(d){const p=d.split('-');return p[2]+'-'+p[1]+'-'+p[0]}
function setStatPeriod(days){
  const now=new Date();
  const from=new Date(now);from.setDate(from.getDate()-days);
  statTo=now.toISOString().split('T')[0];
  statFrom=from.toISOString().split('T')[0];
  document.getElementById('sf').value=statFrom;
  document.getElementById('st').value=statTo;
  renderStats();
}
function statDateChanged(){
  statFrom=document.getElementById('sf').value;
  statTo=document.getElementById('st').value;
  renderStats();
}
function inStatRange(dateStr){
  if(!statFrom&&!statTo)return true;
  const d=parseDMY(dateStr);
  if(statFrom&&d<new Date(statFrom))return false;
  if(statTo&&d>new Date(statTo+'T23:59:59'))return false;
  return true;
}
function renderStats(){
  const stAll=D.statsData||[];
  const opsAll=D.opsStats||[];
  // Фильтрация по выбранному периоду
  const st=stAll.filter(s=>inStatRange(s.date));
  const ops=opsAll.filter(o=>inStatRange(o.date));

  let h='';

  // === ФИЛЬТР ПЕРИОДА ===
  h+='<div class="sec" style="padding:10px 14px">';
  h+='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
  h+='<span style="font-size:12px;font-weight:700;color:#6b7280">Период:</span>';
  h+='<button class="pbtn" onclick="setStatPeriod(3)">3 дня</button>';
  h+='<button class="pbtn" onclick="setStatPeriod(7)">7 дней</button>';
  h+='<button class="pbtn" onclick="setStatPeriod(14)">14 дней</button>';
  h+='<button class="pbtn" onclick="setStatPeriod(30)">30 дней</button>';
  h+='<button class="pbtn" onclick="statFrom=\\'\\';statTo=\\'\\';document.getElementById(\\'sf\\').value=\\'\\';document.getElementById(\\'st\\').value=\\'\\';renderStats()">Всё</button>';
  h+='<span style="margin-left:8px;font-size:11px;color:#6b7280">с</span>';
  h+='<input type="date" id="sf" value="'+(statFrom||'')+'" onchange="statDateChanged()" style="background:#fff;border:1px solid rgba(0,0,0,.1);color:#1a1a2e;padding:4px 8px;border-radius:6px;font-size:11px;font-family:inherit">';
  h+='<span style="font-size:11px;color:#6b7280">по</span>';
  h+='<input type="date" id="st" value="'+(statTo||'')+'" onchange="statDateChanged()" style="background:#fff;border:1px solid rgba(0,0,0,.1);color:#1a1a2e;padding:4px 8px;border-radius:6px;font-size:11px;font-family:inherit">';
  h+='</div></div>';

  if(!ops.length&&!st.length){
    h+='<div class="no-data">Нет данных за выбранный период</div>';
    document.getElementById('out').innerHTML=h;return;
  }

  // === СВОДКА ЗА ПЕРИОД ===
  const totalOutC=ops.reduce((a,o)=>a+o.outCalls,0);
  const totalInC=ops.reduce((a,o)=>a+o.inCalls,0);
  const totalCallMin=ops.reduce((a,o)=>a+o.callMinutes,0);
  const totalWorked=ops.reduce((a,o)=>a+o.dealsWorked,0);
  const totalNewD=ops.reduce((a,o)=>a+o.newDeals,0);
  const totalOldD=ops.reduce((a,o)=>a+o.oldDeals,0);
  const totalAiDeals=st.reduce((a,s)=>a+s.deals,0);
  const totalScore=st.reduce((a,s)=>a+s.totalScore,0);
  const maxScore=st.reduce((a,s)=>a+s.maxScore,0);
  const avgScore=totalAiDeals>0?Math.round(totalScore/totalAiDeals*10)/10:0;
  const scCol=avgScore>=7?'#34d399':avgScore>=4?'#fbbf24':'#f87171';

  h+='<div class="sec"><h3>📋 Сводка за период ('+ops.length+' дней)</h3>';
  h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px">';
  const mets=[
    {l:'Рабочих дней',v:ops.length,c:'#60a5fa'},
    {l:'Обработано сделок',v:totalWorked,c:'#a78bfa'},
    {l:'Новых',v:totalNewD,c:'#c084fc'},
    {l:'Старых',v:totalOldD,c:'#818cf8'},
    {l:'Исходящих',v:totalOutC,c:'#34d399'},
    {l:'Входящих',v:totalInC,c:'#60a5fa'},
    {l:'Время звонков',v:totalCallMin+'м',c:'#818cf8'},
    {l:'Ср. балл ЗП',v:avgScore+'/12',c:scCol},
  ];
  for(const m of mets) h+='<div class="met"><div class="met-l">'+m.l+'</div><div class="met-v" style="color:'+m.c+'">'+m.v+'</div></div>';
  h+='</div></div>';

  // === РАСПРЕДЕЛЕНИЕ СДЕЛОК ПО СТАТУСАМ (все сделки из Planfix) ===
  var statusOrder2=['Новая','Обработка','В работе','Коммерческое предложение','Вывезли/Нашли поставщика','Дожим','Договор и оплата','Выполнение Работы','Сделанная','Сделка завершена'];
  // Фильтруем сделки по периоду: те у которых была активность (звонки/комментарии) в диапазоне
  var periodDeals=D.dealCards.filter(function(d){
    // Проверяем звонки
    if((d.calls||[]).some(function(c){return inStatRange(c.date);}))return true;
    // Проверяем комментарии
    if((d.comments||[]).some(function(c){return inStatRange(c.date);}))return true;
    // Проверяем создание в периоде
    if(d.dateCreated && inStatRange(d.dateCreated))return true;
    return false;
  });
  var statusData={};
  periodDeals.forEach(function(d){
    var s=d.status||'?';
    if(!statusData[s])statusData[s]={count:0,sum:0,deals:[]};
    statusData[s].count++;
    statusData[s].sum+=(d.dealSum||0);
    statusData[s].deals.push(d);
  });
  var allStatuses=[...statusOrder2,...Object.keys(statusData).filter(function(k){return statusOrder2.indexOf(k)<0;})].filter(function(k){return statusData[k];});
  var totalDealsAll=periodDeals.length;
  var totalSumAll=periodDeals.reduce(function(s,d){return s+(d.dealSum||0);},0);
  var maxStCount=Math.max.apply(null,allStatuses.map(function(s){return statusData[s].count;}))||1;

  h+='<div class="sec"><h3>📊 Сделки по статусам за период ('+totalDealsAll+' из '+D.dealCards.length+')</h3>';
  h+='<p style="color:#6b7280;font-size:12px;margin-bottom:10px">Сделки с активностью за выбранный период</p>';
  h+='<div style="overflow-x:auto"><table>';
  h+='<tr><th>Статус</th><th style="text-align:center">Сделок</th><th style="text-align:right">Сумма</th><th style="text-align:right">%</th><th style="width:30%"></th></tr>';
  for(var si=0;si<allStatuses.length;si++){
    var st2=allStatuses[si];
    var sd=statusData[st2];
    var pct2=totalDealsAll?Math.round(sd.count/totalDealsAll*100):0;
    var barPct=Math.round(sd.count/maxStCount*100);
    var isWork=st2==='Выполнение Работы';
    var isDone=['Договор и оплата','Выполнение Работы','Сделанная','Сделка завершена'].indexOf(st2)>=0;
    var rowStyle=isWork?'background:rgba(52,211,153,.12);':'';
    var nameCol=isWork?'#16a34a':isDone?'#16a34a':'#1a1a2e';
    var barCol=isWork?'#34d399':isDone?'#34d399':'#60a5fa';
    h+='<tr style="'+rowStyle+'">';
    h+='<td style="font-weight:700;color:'+nameCol+';white-space:nowrap">'+(isWork?'🏗 ':'')+esc(st2)+'</td>';
    h+='<td style="text-align:center;font-weight:700">'+sd.count+'</td>';
    h+='<td style="text-align:right;font-weight:700;color:#fbbf24">'+(sd.sum?fmt(sd.sum)+' ₽':'—')+'</td>';
    h+='<td style="text-align:right;color:#6b7280">'+pct2+'%</td>';
    h+='<td><div class="bar-bg"><div class="bar-f" style="width:'+barPct+'%;background:'+barCol+'"></div></div></td>';
    h+='</tr>';
    // Раскрываем список для ключевых статусов
    if(isWork||st2==='Договор и оплата'||st2==='Дожим'){
      sd.deals.sort(function(a,b){return(b.dealSum||0)-(a.dealSum||0);});
      for(var di2=0;di2<sd.deals.length;di2++){
        var deal=sd.deals[di2];
        h+='<tr style="background:rgba(0,0,0,.02)">';
        h+='<td style="padding-left:24px;font-size:11px;color:#6b7280">↳ #'+deal.id+' '+esc((deal.name||'').substring(0,45))+'</td>';
        h+='<td style="text-align:center;font-size:11px;color:#6b7280">'+esc(deal.counterparty||'')+'</td>';
        h+='<td style="text-align:right;font-size:11px;color:#fbbf24">'+(deal.dealSum?fmt(deal.dealSum)+' ₽':'—')+'</td>';
        h+='<td colspan="2"></td></tr>';
      }
    }
  }
  h+='<tr style="border-top:2px solid rgba(0,0,0,.1);font-weight:800">';
  h+='<td>Итого</td><td style="text-align:center">'+totalDealsAll+'</td>';
  h+='<td style="text-align:right;color:#fbbf24">'+fmt(totalSumAll)+' ₽</td>';
  h+='<td style="text-align:right">100%</td><td></td></tr>';
  h+='</table></div>';

  // Переходы за период (из комментариев "Статус изменён на ...")
  var movedTo={};
  D.dealCards.forEach(function(card){
    (card.comments||[]).forEach(function(c){
      if(!inStatRange(c.date))return;
      var txt=(c.text||'');
      var m=txt.match(/Статус изменён на (.+)/);
      if(!m)return;
      var newStatus=m[1].replace(/<[^>]*>/g,'').trim();
      if(!newStatus)return;
      if(!movedTo[newStatus])movedTo[newStatus]={count:0,sum:0,deals:[]};
      if(!movedTo[newStatus].deals.some(function(d){return d.id==card.id;})){
        movedTo[newStatus].count++;
        movedTo[newStatus].sum+=(card.dealSum||0);
        movedTo[newStatus].deals.push({id:card.id,name:card.name,sum:card.dealSum||0});
      }
    });
  });
  var mvStatuses=statusOrder2.filter(function(s){return movedTo[s]&&movedTo[s].count>0;});
  // Также добавляем статусы не в основном списке
  Object.keys(movedTo).forEach(function(s){if(mvStatuses.indexOf(s)<0&&movedTo[s].count>0)mvStatuses.push(s);});
  if(mvStatuses.length){
    h+='<div style="margin-top:14px"><h4 style="color:#a78bfa">🔄 Переходы по воронке за выбранный период</h4>';
    h+='<table><tr><th>Перешли в статус</th><th style="text-align:center">Сделок</th><th style="text-align:right">Сумма</th></tr>';
    for(var mi=0;mi<mvStatuses.length;mi++){
      var ms=mvStatuses[mi];
      var mv=movedTo[ms];
      var isW=ms==='Выполнение Работы';
      var isDn=['Договор и оплата','Выполнение Работы','Сделанная','Сделка завершена'].indexOf(ms)>=0;
      h+='<tr style="'+(isW?'background:rgba(52,211,153,.12);':'')+'"><td style="font-weight:700;color:'+(isW?'#16a34a':isDn?'#16a34a':'#1a1a2e')+'">'+(isW?'🏗 ':'')+esc(ms)+'</td>';
      h+='<td style="text-align:center;font-weight:700">'+mv.count+'</td>';
      h+='<td style="text-align:right;color:#fbbf24">'+(mv.sum?fmt(mv.sum)+' ₽':'—')+'</td></tr>';
      mv.deals.sort(function(a,b){return(b.sum||0)-(a.sum||0);});
      for(var di3=0;di3<mv.deals.length;di3++){
        var dd=mv.deals[di3];
        h+='<tr style="background:rgba(0,0,0,.02)"><td style="padding-left:24px;font-size:11px;color:#6b7280">↳ #'+dd.id+' '+esc((dd.name||'').substring(0,45))+'</td>';
        h+='<td></td><td style="text-align:right;font-size:11px;color:#fbbf24">'+(dd.sum?fmt(dd.sum)+' ₽':'—')+'</td></tr>';
      }
    }
    h+='</table></div>';
  }
  h+='</div>';

  // === АКТИВНОСТЬ ПО ДНЯМ — большая таблица ===
  h+='<div class="sec"><h3>📅 Активность менеджера по дням</h3>';
  h+='<div style="overflow-x:auto"><table>';
  h+='<tr><th>Дата</th><th>Сделок</th><th>Новых</th><th>Старых</th><th>📤 Исх.</th><th>📥 Вх.</th><th>⏱ Мин</th><th>Ср.балл</th></tr>';
  // Merge ops and st by date
  const allDates=[...new Set([...ops.map(o=>o.date),...st.map(s=>s.date)])].sort((a,b)=>{
    const pa=a.split('-'),pb=b.split('-');
    return new Date(pa[2]+'-'+pa[1]+'-'+pa[0])-new Date(pb[2]+'-'+pb[1]+'-'+pb[0]);
  });
  let totDeals=0,totNew=0,totOld=0,totOut=0,totIn=0,totMin=0,totScore=0,totScoreDays=0;
  for(const date of allDates){
    const o=ops.find(x=>x.date===date)||{outCalls:0,inCalls:0,callMinutes:0,dealsWorked:0,newDeals:0,oldDeals:0};
    const s=st.find(x=>x.date===date);
    const avg=s?s.avgScore:'-';
    const col=s?(s.avgScore>=7?'#34d399':s.avgScore>=4?'#fbbf24':'#f87171'):'#64748b';
    totDeals+=o.dealsWorked;totNew+=o.newDeals;totOld+=o.oldDeals;
    totOut+=o.outCalls;totIn+=o.inCalls;totMin+=o.callMinutes;
    if(s){totScore+=s.avgScore;totScoreDays++;}
    h+='<tr>';
    h+='<td style="white-space:nowrap;font-weight:600">'+date+'</td>';
    h+='<td style="font-weight:700">'+o.dealsWorked+'</td>';
    h+='<td style="color:#c084fc">'+o.newDeals+'</td>';
    h+='<td style="color:#818cf8">'+o.oldDeals+'</td>';
    h+='<td style="color:#34d399;font-weight:700">'+o.outCalls+'</td>';
    h+='<td style="color:#60a5fa">'+o.inCalls+'</td>';
    h+='<td style="color:#818cf8">'+o.callMinutes+'</td>';
    h+='<td style="color:'+col+';font-weight:700">'+avg+'</td>';
    h+='</tr>';
  }
  const totAvg=totScoreDays?+(totScore/totScoreDays).toFixed(1):'-';
  const totAvgCol=totScoreDays?(totAvg>=7?'#34d399':totAvg>=4?'#fbbf24':'#f87171'):'#64748b';
  h+='<tr style="border-top:2px solid rgba(0,0,0,.1);font-weight:800;background:rgba(0,0,0,.03)">';
  h+='<td>Итого</td>';
  h+='<td>'+totDeals+'</td>';
  h+='<td style="color:#c084fc">'+totNew+'</td>';
  h+='<td style="color:#818cf8">'+totOld+'</td>';
  h+='<td style="color:#34d399">'+totOut+'</td>';
  h+='<td style="color:#60a5fa">'+totIn+'</td>';
  h+='<td style="color:#818cf8">'+totMin+'</td>';
  h+='<td style="color:'+totAvgCol+'">'+totAvg+'</td>';
  h+='</tr>';
  h+='</table></div></div>';

  // === ЗВОНКИ ПО ДНЯМ — гистограмма ===
  h+='<div class="sec"><h3>📞 Исходящие звонки по дням</h3>';
  const maxCalls=Math.max(...ops.map(o=>o.outCalls),1);
  for(const o of ops){
    const pct=Math.round(o.outCalls/maxCalls*100);
    h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">';
    h+='<span style="width:80px;font-size:11px;color:#6b7280;text-align:right;flex-shrink:0">'+o.date+'</span>';
    h+='<div class="bar-bg" style="flex:1;height:18px"><div class="bar-f" style="width:'+pct+'%;background:#34d399"></div></div>';
    h+='<span style="width:40px;font-size:12px;font-weight:700;color:#34d399;text-align:right">'+o.outCalls+'</span>';
    h+='<span style="width:40px;font-size:10px;color:#6b7280">'+o.callMinutes+'м</span>';
    h+='</div>';
  }
  h+='</div>';

  // === СРЕДНИЙ БАЛЛ ЗП ПО ДНЯМ ===
  if(st.length){
    h+='<div class="sec"><h3>📈 Средний балл ЗП по дням</h3>';
    for(const s of st){
      const pct=Math.round(s.avgScore/12*100);
      const col=s.avgScore>=7?'#34d399':s.avgScore>=4?'#fbbf24':'#f87171';
      h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">';
      h+='<span style="width:80px;font-size:11px;color:#6b7280;text-align:right;flex-shrink:0">'+s.date+'</span>';
      h+='<div class="bar-bg" style="flex:1;height:18px"><div class="bar-f" style="width:'+pct+'%;background:'+col+'"></div></div>';
      h+='<span style="width:70px;font-size:12px;font-weight:700;color:'+col+';text-align:right">'+s.avgScore+'/12</span>';
      h+='<span style="width:50px;font-size:10px;color:#6b7280">'+s.deals+' сд.</span>';
      h+='</div>';
    }
    h+='</div>';
  }

  // === ВЫПОЛНЕНИЕ СКРИПТА ===
  if(st.length){
    const totalDeals=st.reduce((a,s)=>a+s.deals,0);
    h+='<div class="sec"><h3>✅ Выполнение скрипта продаж</h3>';
    h+='<div style="overflow-x:auto"><table><tr><th>Пункт</th><th>Выполнено</th><th>%</th><th></th></tr>';
    const items=[
      {l:'Устная презентация',v:st.reduce((a,s)=>a+s.vpDone,0)},
      {l:'Как мы работаем',v:st.reduce((a,s)=>a+s.hwDone,0)},
      {l:'Призыв к действию',v:st.reduce((a,s)=>a+s.ctaDone,0)},
      {l:'КП отправлено',v:st.reduce((a,s)=>a+s.cpDone,0)},
      {l:'Счёт отправлен',v:st.reduce((a,s)=>a+s.invDone,0)},
      {l:'Презентация (файл)',v:st.reduce((a,s)=>a+s.presDone,0)},
      {l:'Отработка возражений',v:st.reduce((a,s)=>a+s.objDone,0)},
    ];
    for(const it of items){
      const pct=totalDeals?Math.round(it.v/totalDeals*100):0;
      const col=pct>=60?'#34d399':pct>=30?'#fbbf24':'#f87171';
      h+='<tr><td style="font-weight:600">'+it.l+'</td><td>'+it.v+'/'+totalDeals+'</td>';
      h+='<td style="color:'+col+';font-weight:700">'+pct+'%</td>';
      h+='<td style="width:200px"><div class="bar-bg"><div class="bar-f" style="width:'+pct+'%;background:'+col+'"></div></div></td></tr>';
    }
    h+='</table></div>';

    // Звонок vs переписка
    const totalCall=st.reduce((a,s)=>a+s.callSources,0);
    const totalText=st.reduce((a,s)=>a+s.textSources,0);
    const totalSrc=totalCall+totalText||1;
    h+='<div style="margin-top:12px;display:flex;gap:20px;align-items:center;flex-wrap:wrap">';
    h+='<div style="text-align:center"><div style="font-size:24px;font-weight:800;color:#34d399">'+totalCall+'</div><div style="font-size:10px;color:#6b7280">По телефону (3б)</div></div>';
    h+='<div style="text-align:center"><div style="font-size:24px;font-weight:800;color:#fbbf24">'+totalText+'</div><div style="font-size:10px;color:#6b7280">Переписка (1.5б)</div></div>';
    h+='<div style="flex:1;min-width:200px"><div class="bar-bg" style="height:20px;display:flex;overflow:hidden">';
    h+='<div style="width:'+Math.round(totalCall/totalSrc*100)+'%;background:#34d399"></div>';
    h+='<div style="width:'+Math.round(totalText/totalSrc*100)+'%;background:#fbbf24"></div>';
    h+='</div></div></div></div>';
  }

  // === ВОРОНКА СДЕЛОК ===
  const sc=D.statusCounts||{};
  const order=['Новая','Обработка','В работе','Коммерческое предложение','Вывезли/Нашли поставщика','Дожим','Договор и оплата','Выполнение Работы','Сделанная','Сделка завершена'];
  const allSt=[...order,...Object.keys(sc).filter(k=>!order.includes(k))].filter(k=>sc[k]);
  if(allSt.length){
    const maxSt=Math.max(...Object.values(sc),1);
    h+='<div class="sec"><h3>📊 Воронка — текущее распределение ('+D.dealCards.length+' сделок)</h3>';
    for(const s of allSt){
      const n=sc[s]||0;
      const pct=Math.round(n/maxSt*100);
      const good=['Договор и оплата','Выполнение Работы','Сделка завершена','Сделанная'].includes(s);
      h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">';
      h+='<span style="width:180px;font-size:11px;color:#6b7280;text-align:right;flex-shrink:0">'+s+'</span>';
      h+='<div class="bar-bg" style="flex:1;height:18px"><div class="bar-f" style="width:'+pct+'%;background:'+(good?'#34d399':'#60a5fa')+'"></div></div>';
      h+='<span style="width:30px;font-size:12px;font-weight:700;text-align:right">'+n+'</span>';
      h+='</div>';
    }
    h+='</div>';
  }

  document.getElementById('out').innerHTML=h;
}

function toggleCard(id){
  const hdr=document.getElementById('chdr_'+id);
  const body=document.getElementById('cbody_'+id);
  if(!body)return;
  const isOpen=body.classList.contains('open');
  if(isOpen){
    body.classList.remove('open');
    if(hdr)hdr.classList.remove('open');
    cardOpenState[id]=false;
  }
  else{
    body.classList.add('open');
    if(hdr)hdr.classList.add('open');
    cardOpenState[id]=true;
  }
}
function toggleAllCards(){
  const bodies=document.querySelectorAll('.card-body, .deal-card-body');
  const anyOpen=[...bodies].some(b=>b.classList.contains('open'));
  bodies.forEach(b=>{
    const id=b.id.replace('cbody_','');
    const hdr=document.getElementById('chdr_'+id);
    if(anyOpen){
      b.classList.remove('open');
      if(hdr)hdr.classList.remove('open');
      cardOpenState[id]=false;
    }
    else{
      b.classList.add('open');
      if(hdr)hdr.classList.add('open');
      cardOpenState[id]=true;
    }
  });
  const btn=document.getElementById('toggleAllBtn');
  if(btn)btn.textContent=anyOpen?'📂 Развернуть всё':'📁 Свернуть всё';
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
// ============ ВКЛАДКА ВХОДЯЩИЕ ============
function renderIncoming(){
  var h='';
  var ibd=D.incomingByDate||{};
  var dates=Object.keys(ibd).sort(function(a,b){
    var pa=a.split('-'),pb=b.split('-');
    return new Date(pb[2]+'-'+pb[1]+'-'+pb[0])-new Date(pa[2]+'-'+pa[1]+'-'+pa[0]);
  });

  // Фильтр по периоду
  var now=new Date();
  var cutoff=new Date(now);
  cutoff.setDate(cutoff.getDate()-period);
  dates=dates.filter(function(d){
    var p=d.split('-');
    return new Date(p[2]+'-'+p[1]+'-'+p[0])>=cutoff;
  });

  var totalDeals=0,totalActions=0;
  dates.forEach(function(d){totalDeals+=(ibd[d]||[]).length;(ibd[d]||[]).forEach(function(dd){totalActions+=(dd.actions||[]).length;});});

  h+='<div class="sec"><h3 style="color:#93c5fd">📨 Входящие обращения</h3>';
  h+='<div style="font-size:12px;color:#6b7280;margin-bottom:12px">Сделки где написал клиент или другой сотрудник, но менеджер не взаимодействовал</div>';

  // Метрики
  h+='<div class="mets" style="margin-bottom:14px">';
  h+='<div class="met"><div class="met-v" style="color:#60a5fa">'+totalDeals+'</div><div class="met-l">Сделок</div></div>';
  h+='<div class="met"><div class="met-v" style="color:#fbbf24">'+totalActions+'</div><div class="met-l">Сообщений</div></div>';
  h+='<div class="met"><div class="met-v" style="color:#6b7280">'+dates.length+'</div><div class="met-l">Дней</div></div>';
  h+='</div>';

  if(!dates.length){
    h+='<div style="color:#6b7280;padding:20px;text-align:center">Нет входящих обращений за выбранный период</div>';
  }

  for(var di=0;di<dates.length;di++){
    var dt=dates[di];
    var deals=ibd[dt]||[];
    if(!deals.length) continue;
    h+='<div style="margin-bottom:16px">';
    h+='<div style="font-weight:700;color:#6b7280;font-size:13px;margin-bottom:8px;border-bottom:1px solid rgba(148,163,184,.15);padding-bottom:4px">'+esc(dt)+' — '+deals.length+' сделок</div>';
    for(var i=0;i<deals.length;i++){
      var dd=deals[i];
      h+='<div style="background:rgba(96,165,250,.06);border:1px solid rgba(96,165,250,.12);border-radius:8px;padding:10px 14px;margin-bottom:6px">';
      h+='<div style="display:flex;justify-content:space-between;align-items:center">';
      h+='<div style="font-weight:700;color:#1a1a2e;font-size:13px">#'+dd.id+' '+esc(dd.name.substring(0,60))+'</div>';
      if(dd.dealSum) h+='<span style="font-size:12px;font-weight:700;color:#fbbf24">'+fmt(dd.dealSum)+' ₽</span>';
      h+='</div>';
      h+='<div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">';
      if(dd.status) h+='<span class="tag">'+esc(dd.status)+'</span>';
      if(dd.counterparty) h+='<span style="font-size:11px;color:#6b7280">'+esc(dd.counterparty)+'</span>';
      h+='</div>';
      var acts=dd.actions||[];
      for(var ai=0;ai<Math.min(acts.length,3);ai++){
        var a=acts[ai];
        h+='<div style="font-size:12px;color:#6b7280;margin-top:4px">'+esc(a.time||'')+' <b style="color:#60a5fa">'+esc(a.owner||'')+'</b>: '+esc(a.text||'')+'</div>';
      }
      if(acts.length>3) h+='<div style="font-size:11px;color:#6b7280;margin-top:2px">...ещё '+(acts.length-3)+' сообщений</div>';
      h+='</div>';
    }
    h+='</div>';
  }
  h+='</div>';
  document.getElementById('out').innerHTML=h;
}

// ============ ВКЛАДКА РУКОВОДИТЕЛЯ ============
var mgrPeriod='day';
function setMgrPeriod(p){mgrPeriod=p;renderManager();}
function parsePfDateClient(s){
  if(!s)return null;
  var m=s.match(/(\d{2})-(\d{2})-(\d{4})/);
  if(m)return new Date(m[3]+'-'+m[2]+'-'+m[1]);
  return new Date(s);
}
function mgrDealPopup(id){
  var el=document.getElementById('mgr_inline_'+id);
  if(el){el.style.display=el.style.display==='none'?'block':'none';return;}
  var card=D.dealCards.find(function(c){return c.id===id;});
  if(!card)return;
  var ai=findLatestAiForDeal(id);
  var h2='<div id="mgr_inline_'+id+'" style="margin:4px 0 8px 18px;padding:8px 12px;border-radius:6px;background:#f9fafb;border:1px solid rgba(148,163,184,.12);font-size:12px">';
  h2+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">';
  h2+='<span class="bg bg-b">'+esc(card.status)+'</span>';
  h2+='<span style="color:#6b7280">'+esc(card.counterparty||'')+'</span>';
  if(card.dealSum)h2+='<span style="color:#fbbf24;font-weight:700">'+fmt(card.dealSum)+' ₽</span>';
  h2+='<span style="color:#6b7280">создана '+esc(card.dateCreated||'')+'</span>';
  h2+='</div>';
  if(ai&&ai.overallVerdict)h2+='<div style="color:#374151;margin-bottom:3px">'+esc(ai.overallVerdict)+'</div>';
  if(ai&&ai.missing&&ai.missing.length)h2+='<div style="color:#f87171"><b>Не хватает:</b> '+esc(ai.missing.join(', '))+'</div>';
  if(ai&&ai.nextStep)h2+='<div style="color:#34d399;margin-top:2px"><b>След.шаг:</b> '+esc(ai.nextStep)+'</div>';
  h2+='</div>';
  var btn=document.getElementById('mgr_btn_'+id);
  if(btn)btn.insertAdjacentHTML('afterend',h2);
}
function linkifyDealIds(text){
  return text.replace(/#(\d{4,6})/g,function(m,id){
    return '<span id="mgr_btn_'+id+'" onclick="mgrDealPopup('+id+')" style="color:#60a5fa;cursor:pointer;text-decoration:underline;text-decoration-style:dotted">'+m+' ▾</span>';
  });
}
function renderManager(){
  var h='';
  var ms=D.managerSummaries||{};

  // === Переключатель периода ===
  h+='<div style="display:flex;gap:5px;margin-bottom:14px">';
  var periods=[{k:'day',l:'📅 День'},{k:'week',l:'📆 Неделя'},{k:'month',l:'🗓 Месяц'}];
  for(var i=0;i<periods.length;i++){
    var p=periods[i];
    var isOn=mgrPeriod===p.k;
    h+='<button onclick="setMgrPeriod(&#39;'+p.k+'&#39;)" class="pbtn'+(isOn?' on':'')+'" style="font-size:13px;padding:8px 16px">'+p.l+'</button>';
  }
  h+='</div>';

  // === AI ВЫЖИМКА ===
  var text=ms[mgrPeriod]||null;
  var periodLabel=mgrPeriod==='day'?'день':mgrPeriod==='week'?'неделю':'месяц';
  if(text){
    // Иконки и цвета для секций
    var secStyles={
      'КРАТКИЙ ИТОГ':{icon:'📋',color:'#60a5fa',bg:'rgba(96,165,250,.06)'},
      'УСПЕХИ И ПРОГРЕСС':{icon:'🏆',color:'#34d399',bg:'rgba(52,211,153,.06)'},
      'УСПЕХИ':{icon:'🏆',color:'#34d399',bg:'rgba(52,211,153,.06)'},
      'ПРОБЛЕМЫ':{icon:'⚠️',color:'#f87171',bg:'rgba(248,113,113,.06)'},
      'БЛИЖАЙШИЕ ОПЛАТЫ':{icon:'💰',color:'#fbbf24',bg:'rgba(251,191,36,.06)'},
      'РЕКОМЕНДАЦИИ РУКОВОДИТЕЛЮ':{icon:'🎯',color:'#a78bfa',bg:'rgba(167,139,250,.06)'},
      'РЕКОМЕНДАЦИИ':{icon:'🎯',color:'#a78bfa',bg:'rgba(167,139,250,.06)'},
    };
    // Разбиваем на секции по заголовкам (1. ТЕКСТ, 2. ТЕКСТ, **ТЕКСТ**)
    var lines=text.split('\\n');
    var sections=[];
    var curSec={title:'Отчёт для руководителя за '+periodLabel,lines:[]};
    for(var i=0;i<lines.length;i++){
      var line=lines[i].trim();
      if(!line)continue;
      // Убираем ** и ### обёртку для проверки заголовка
      var clean=line.replace(/^#{1,4}\\s*/, '').replace(/^\\*\\*/, '').replace(/\\*\\*$/, '');
      // Заголовок секции: "1. КРАТКИЙ ИТОГ" или "КРАТКИЙ ИТОГ" (4+ заглавных букв)
      var secMatch=clean.match(/^(?:\\d+\\.\\s*)([А-ЯЁA-Z][А-ЯЁA-Z\\s]{3,})$/);
      if(secMatch){
        if(curSec.lines.length||sections.length===0)sections.push(curSec);
        curSec={title:secMatch[1].trim(),lines:[]};
        continue;
      }
      // Пропуск служебных строк
      if(clean.match(/^ОТЧЁТ О РАБОТЕ/)||clean.match(/^Компания/)||clean.match(/^Период/)||clean==='---')continue;
      curSec.lines.push(line);
    }
    if(curSec.lines.length)sections.push(curSec);

    // Рендерим каждую секцию отдельной карточкой
    for(var si=0;si<sections.length;si++){
      var sec=sections[si];
      if(!sec.lines.length&&si>0)continue;
      var st=null;
      for(var sk in secStyles){if(sec.title.indexOf(sk)>=0){st=secStyles[sk];break;}}
      if(!st)st={icon:'📄',color:'#6b7280',bg:'rgba(107,114,128,.04)'};
      h+='<div style="background:'+st.bg+';border-left:3px solid '+st.color+';border-radius:8px;padding:14px 18px;margin-bottom:10px">';
      h+='<div style="font-size:14px;font-weight:700;color:'+st.color+';margin-bottom:8px">'+st.icon+' '+esc(sec.title)+'</div>';
      h+='<div style="font-size:13px;line-height:1.8;color:#374151">';
      for(var li=0;li<sec.lines.length;li++){
        var ln=sec.lines[li];
        // Жирный текст **xxx**
        ln=ln.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong style="color:#1a1a2e">$1</strong>');
        // Денежные суммы выделяем
        ln=ln.replace(/(\\d[\\d\\s.,]*\\s*(?:₽|руб|Р))/g,'<span style="color:#fbbf24;font-weight:600">$1</span>');
        // Номера сделок #XXXXX → кликабельные с раскрытием
        ln=linkifyDealIds(ln);
        // Нумерованные пункты
        if(ln.match(/^\\d+\\./)){
          ln='<div style="padding:6px 0 6px 8px;border-bottom:1px solid rgba(148,163,184,.08)">'+ln+'</div>';
        }
        // Вложенные маркеры (    *   текст)
        else if(ln.match(/^\\s{2,}[*•\\-]\\s+/)){
          ln='<div style="padding:4px 0 4px 34px;position:relative;color:#6b7280"><span style="position:absolute;left:18px;color:'+st.color+';opacity:.5">◦</span>'+ln.replace(/^\\s*[*•\\-]\\s+/,'')+'</div>';
        }
        // Маркеры * или - (включая "*   текст")
        else if(ln.match(/^[*•\\-]\\s+/)){
          ln='<div style="padding:6px 0 6px 18px;position:relative"><span style="position:absolute;left:2px;color:'+st.color+'">•</span>'+ln.replace(/^[*•\\-]\\s+/,'')+'</div>';
        }
        else{
          ln='<div style="margin:3px 0">'+ln+'</div>';
        }
        h+=ln;
      }
      h+='</div>';
      // Собираем все #ID из текста секции и показываем карточки сделок
      var secText=sec.lines.join(' ');
      var idMatches=secText.match(/#(\d{4,6})/g);
      if(idMatches&&idMatches.length){
        var uniqueIds=[...new Set(idMatches.map(function(m){return parseInt(m.substring(1))}))];
        var secDeals=uniqueIds.map(function(id){return D.dealCards.find(function(c){return c.id===id})}).filter(Boolean);
        if(secDeals.length){
          var secSum=secDeals.reduce(function(s,d){return s+(d.dealSum||0)},0);
          h+='<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(0,0,0,.06)">';
          h+='<div style="font-size:11px;color:#6b7280;margin-bottom:6px">📊 Сделки в блоке: <b>'+secDeals.length+'</b>'+(secSum?' · Сумма: <b style="color:#b45309">'+fmt(secSum)+' ₽</b>':'')+'</div>';
          for(var sdi=0;sdi<secDeals.length;sdi++){
            var sd2=secDeals[sdi];
            var ai4=findLatestAiForDeal(sd2.id);
            var ss4=ai4&&ai4.salaryScore?ai4.salaryScore:{};
            var sc4=ss4.total||0;
            var mx4=ss4.max||12;
            var scCol4=sc4>=7?'#16a34a':sc4>=4?'#b45309':'#dc2626';
            var secCardId='mgr_sec_'+si+'_'+sd2.id;
            h+='<div style="border:1px solid rgba(0,0,0,.06);border-radius:6px;margin-bottom:3px;overflow:hidden">';
            h+='<div onclick="var b=document.getElementById(&#39;'+secCardId+'&#39;);b.style.display=b.style.display===&#39;none&#39;?&#39;block&#39;:&#39;none&#39;" style="display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;background:rgba(0,0,0,.01)">';
            h+='<span style="color:#6b7280;font-size:11px;min-width:46px">#'+sd2.id+'</span>';
            h+='<span style="flex:1;font-size:12px;color:#1a1a2e;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((sd2.name||'').substring(0,50))+'</span>';
            if(sd2.dealSum)h+='<span style="font-size:11px;font-weight:700;color:#b45309">'+fmt(sd2.dealSum)+' ₽</span>';
            h+='<span style="font-size:11px;font-weight:700;color:'+scCol4+'">'+sc4+'/'+mx4+'</span>';
            h+='<span style="color:#9ca3af;font-size:9px">▼</span>';
            h+='</div>';
            h+='<div id="'+secCardId+'" style="display:none;padding:6px 10px 8px;border-top:1px solid rgba(0,0,0,.04);background:#f9fafb;font-size:12px">';
            h+='<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:4px">';
            h+='<span class="bg bg-b">'+esc(sd2.status||'')+'</span>';
            if(sd2.counterparty)h+='<span style="color:#6b7280;font-size:11px">'+esc(sd2.counterparty)+'</span>';
            h+='<span style="color:#6b7280;font-size:11px">создана '+esc(sd2.dateCreated||'')+'</span>';
            h+='</div>';
            if(ai4&&ai4.overallVerdict)h+='<div style="color:#374151;margin-bottom:3px">'+esc(ai4.overallVerdict)+'</div>';
            if(ai4&&ai4.missing&&ai4.missing.length)h+='<div style="color:#dc2626"><b>Не хватает:</b> '+esc(ai4.missing.join(', '))+'</div>';
            if(ai4&&ai4.nextStep)h+='<div style="color:#16a34a;margin-top:2px"><b>След.шаг:</b> '+esc(ai4.nextStep)+'</div>';
            h+='</div></div>';
          }
          h+='</div>';
        }
      }
      h+='</div>';
    }
  }else{
    h+='<div class="sec" style="border-left:3px solid #a78bfa;min-height:100px"><h3>👔 Отчёт для руководителя за '+periodLabel+'</h3>';
    h+='<div class="no-data">Нет данных за '+periodLabel+'. Запустите полный отчёт чтобы сгенерировать.</div></div>';
  }

  // === СДЕЛКИ ЗА ПЕРИОД (раскрывающиеся карточки) ===
  var periodDays=mgrPeriod==='day'?1:mgrPeriod==='week'?7:30;
  var refDate=parsePfDateClient(D.reportDate);
  var periodDeals=[];
  if(D.multiDayActivity&&refDate){
    var workedMap={};
    Object.keys(D.multiDayActivity).forEach(function(dt){
      var pd=parsePfDateClient(dt);
      if(!pd)return;
      var diff=Math.floor((refDate-pd)/86400000);
      if(diff<0||diff>=periodDays)return;
      var dayActs=D.multiDayActivity[dt]||[];
      dayActs.forEach(function(da){
        if(!workedMap[da.deal.id]){
          workedMap[da.deal.id]={deal:da.deal,ai:null,days:[],calls:0,score:0,maxScore:0};
        }
        workedMap[da.deal.id].days.push(dt);
        workedMap[da.deal.id].calls+=(da.dayCalls||0);
        if(da.aiAssessment){
          workedMap[da.deal.id].ai=da.aiAssessment;
          var ss=da.aiAssessment.salaryScore||{};
          workedMap[da.deal.id].score=ss.total||0;
          workedMap[da.deal.id].maxScore=ss.max||12;
        }
      });
    });
    periodDeals=Object.values(workedMap).sort(function(a,b){return(b.deal.dealSum||0)-(a.deal.dealSum||0);});
  }
  if(periodDeals.length){
    // Разделяем на проблемные (score <= 3 или нет звонков) и остальные
    var problemDeals=periodDeals.filter(function(d){return d.score<=3||d.calls===0;});
    var goodDeals=periodDeals.filter(function(d){return d.score>3&&d.calls>0;});

    if(problemDeals.length){
      h+='<div class="sec" style="border-left:3px solid #f87171"><h3>⚠️ Проблемные сделки ('+problemDeals.length+')</h3>';
      h+='<div style="font-size:11px;color:#6b7280;margin-bottom:8px">Низкие баллы или нет звонков. Нажмите для подробностей.</div>';
      for(var i=0;i<problemDeals.length;i++){
        var pd2=problemDeals[i];
        var cardId='mgr_prob_'+pd2.deal.id;
        var ai2=pd2.ai||{};
        var scoreCol=pd2.score>=7?'#34d399':pd2.score>=4?'#fbbf24':'#f87171';
        h+='<div style="border:1px solid rgba(248,113,113,.15);border-radius:8px;margin-bottom:4px;overflow:hidden">';
        h+='<div onclick="var b=document.getElementById(&#39;'+cardId+'&#39;);b.style.display=b.style.display===&#39;none&#39;?&#39;block&#39;:&#39;none&#39;" style="display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;background:rgba(248,113,113,.04)">';
        h+='<span style="color:#6b7280;font-size:11px;min-width:50px">#'+pd2.deal.id+'</span>';
        h+='<span style="flex:1;font-size:13px;color:#1a1a2e;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((pd2.deal.name||'').substring(0,55))+'</span>';
        if(pd2.deal.dealSum)h+='<span style="font-size:12px;font-weight:700;color:#fbbf24;white-space:nowrap">'+fmt(pd2.deal.dealSum)+' ₽</span>';
        h+='<span style="font-size:12px;font-weight:700;color:'+scoreCol+';min-width:40px;text-align:right">'+pd2.score+'/'+pd2.maxScore+'</span>';
        h+='<span style="color:#6b7280;font-size:10px">▼</span>';
        h+='</div>';
        h+='<div id="'+cardId+'" style="display:none;padding:8px 12px 10px;border-top:1px solid rgba(248,113,113,.1);background:#f9fafb">';
        h+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">';
        h+='<span class="bg bg-b">'+esc(pd2.deal.status||'')+'</span>';
        if(pd2.deal.counterparty)h+='<span style="font-size:11px;color:#6b7280">'+esc(pd2.deal.counterparty)+'</span>';
        h+='<span style="font-size:11px;color:#6b7280">📞 '+pd2.calls+' зв.</span>';
        h+='<span style="font-size:11px;color:#6b7280">'+pd2.days.length+' дн.</span>';
        h+='</div>';
        if(ai2.overallVerdict)h+='<div style="font-size:12px;color:#374151;margin-bottom:4px">'+esc(ai2.overallVerdict)+'</div>';
        if(ai2.missing&&ai2.missing.length){
          h+='<div style="font-size:11px;color:#f87171;margin-bottom:4px"><b>Не хватает:</b> '+esc(ai2.missing.join(', '))+'</div>';
        }
        if(ai2.nextStep)h+='<div style="font-size:11px;color:#34d399"><b>След.шаг:</b> '+esc(ai2.nextStep)+'</div>';
        h+='</div></div>';
      }
      h+='</div>';
    }

    if(goodDeals.length){
      h+='<div class="sec" style="border-left:3px solid #34d399"><h3>✅ Обработанные сделки ('+goodDeals.length+')</h3>';
      for(var i=0;i<goodDeals.length;i++){
        var gd=goodDeals[i];
        var cardId2='mgr_good_'+gd.deal.id;
        var ai3=gd.ai||{};
        var scoreCol2=gd.score>=7?'#34d399':gd.score>=4?'#fbbf24':'#f87171';
        h+='<div style="border:1px solid rgba(52,211,153,.12);border-radius:8px;margin-bottom:4px;overflow:hidden">';
        h+='<div onclick="var b=document.getElementById(&#39;'+cardId2+'&#39;);b.style.display=b.style.display===&#39;none&#39;?&#39;block&#39;:&#39;none&#39;" style="display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;background:rgba(52,211,153,.04)">';
        h+='<span style="color:#6b7280;font-size:11px;min-width:50px">#'+gd.deal.id+'</span>';
        h+='<span style="flex:1;font-size:13px;color:#1a1a2e;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((gd.deal.name||'').substring(0,55))+'</span>';
        if(gd.deal.dealSum)h+='<span style="font-size:12px;font-weight:700;color:#fbbf24;white-space:nowrap">'+fmt(gd.deal.dealSum)+' ₽</span>';
        h+='<span style="font-size:12px;font-weight:700;color:'+scoreCol2+';min-width:40px;text-align:right">'+gd.score+'/'+gd.maxScore+'</span>';
        h+='<span style="color:#6b7280;font-size:10px">▼</span>';
        h+='</div>';
        h+='<div id="'+cardId2+'" style="display:none;padding:8px 12px 10px;border-top:1px solid rgba(52,211,153,.1);background:#f9fafb">';
        h+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">';
        h+='<span class="bg bg-b">'+esc(gd.deal.status||'')+'</span>';
        if(gd.deal.counterparty)h+='<span style="font-size:11px;color:#6b7280">'+esc(gd.deal.counterparty)+'</span>';
        h+='<span style="font-size:11px;color:#6b7280">📞 '+gd.calls+' зв.</span>';
        h+='</div>';
        if(ai3.overallVerdict)h+='<div style="font-size:12px;color:#374151;margin-bottom:4px">'+esc(ai3.overallVerdict)+'</div>';
        if(ai3.nextStep)h+='<div style="font-size:11px;color:#34d399"><b>След.шаг:</b> '+esc(ai3.nextStep)+'</div>';
        h+='</div></div>';
      }
      h+='</div>';
    }
  }

  // === КЛЮЧЕВЫЕ ЦИФРЫ ===
  var active=D.dealCards.filter(function(d){return d.isActive;});
  var totalSum=active.reduce(function(s,d){return s+(d.dealSum||0);},0);
  var closingStatuses=['Дожим','Договор и оплата'];
  var closingDeals=active.filter(function(d){return closingStatuses.indexOf(d.status)>=0;});
  var closingSum=closingDeals.reduce(function(s,d){return s+(d.dealSum||0);},0);
  var activeWithTouch=active.map(function(d){
    var lt=getLastTouchAll(d);
    var days=lt?getDaysSince(lt.date):999;
    return {card:d,daysSince:days};
  });
  var stalling=activeWithTouch.filter(function(x){return x.daysSince>=3;}).length;

  h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:14px">';
  var mets=[
    {v:active.length,l:'Активных сделок',c:'#60a5fa'},
    {v:fmt(totalSum)+' ₽',l:'Сумма пайплайна',c:'#fbbf24'},
    {v:closingDeals.length,l:'Дожим / Договор',c:'#34d399'},
    {v:fmt(closingSum)+' ₽',l:'Сумма к оплате',c:'#34d399'},
    {v:stalling,l:'Без контакта >3д',c:stalling>0?'#f87171':'#34d399'},
  ];
  for(var i=0;i<mets.length;i++){
    h+='<div class="met"><div class="met-v" style="color:'+mets[i].c+'">'+mets[i].v+'</div><div class="met-l">'+mets[i].l+'</div></div>';
  }
  h+='</div>';

  // === БЛИЖЕ К ОПЛАТЕ (компакт) ===
  var nearPayment=active.filter(function(d){
    return closingStatuses.indexOf(d.status)>=0;
  }).sort(function(a,b){return(b.dealSum||0)-(a.dealSum||0);});
  if(nearPayment.length){
    h+='<div class="sec" style="border-left:3px solid #34d399"><h3>🎯 Ближе к оплате ('+nearPayment.length+')</h3>';
    h+='<table><tr><th>Сделка</th><th>Статус</th><th style="text-align:right">Сумма</th><th>След. шаг</th></tr>';
    for(var i=0;i<nearPayment.length;i++){
      var d=nearPayment[i];
      var ai=findLatestAiForDeal(d.id);
      h+='<tr>';
      h+='<td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((d.name||'').substring(0,50))+'<br><span style="font-size:10px;color:#6b7280">'+esc(d.counterparty||'')+'</span></td>';
      h+='<td><span class="bg bg-g">'+esc(d.status)+'</span></td>';
      h+='<td style="text-align:right;font-weight:700;color:#fbbf24">'+(d.dealSum?fmt(d.dealSum)+' ₽':'—')+'</td>';
      h+='<td style="font-size:11px;color:#93c5fd">'+(ai&&ai.nextStep?esc(ai.nextStep).substring(0,80):'—')+'</td>';
      h+='</tr>';
    }
    h+='</table></div>';
  }

  // === ВОРОНКА ПО ДЕНЬГАМ ===
  var funnelMoney={};
  active.forEach(function(d){
    if(!funnelMoney[d.status])funnelMoney[d.status]={count:0,sum:0};
    funnelMoney[d.status].count++;
    funnelMoney[d.status].sum+=(d.dealSum||0);
  });
  var fOrder=['Новая','Обработка','В работе','Коммерческое предложение','Вывезли/Нашли поставщика','Дожим','Договор и оплата'];
  var maxFSum=Math.max.apply(null,fOrder.map(function(s){return(funnelMoney[s]||{}).sum||0;}))||1;
  h+='<div class="sec"><h3>📊 Воронка по деньгам</h3>';
  h+='<table><tr><th>Статус</th><th style="text-align:center">Сделок</th><th style="text-align:right">Сумма</th><th style="width:40%"></th></tr>';
  for(var i=0;i<fOrder.length;i++){
    var s=fOrder[i];
    var f=funnelMoney[s]||{count:0,sum:0};
    var pct=Math.round(f.sum/maxFSum*100);
    var barCol=i>=5?'#16a34a':i>=3?'#2563eb':'#9ca3af';
    h+='<tr><td style="font-weight:600;white-space:nowrap">'+esc(s)+'</td>';
    h+='<td style="text-align:center">'+f.count+'</td>';
    h+='<td style="text-align:right;font-weight:700;color:#fbbf24">'+(f.sum?fmt(f.sum)+' ₽':'—')+'</td>';
    h+='<td><div class="bar-bg"><div class="bar-f" style="width:'+pct+'%;background:'+barCol+'"></div></div></td>';
    h+='</tr>';
  }
  h+='</table></div>';

  // === ТРЕБУЮТ ДОЖИМА: КП отправлено, но нет звонка давно ===
  var staleDeals=[];
  var now=new Date();
  D.dealCards.forEach(function(c){
    if(!c.isActive) return;
    if(c.status!=='Коммерческое предложение'&&c.status!=='Дожим') return;
    // Последний звонок менеджера
    var lastCall=null;
    (c.calls||[]).forEach(function(cl){
      var p=cl.date.split('-');
      var d=new Date(p[2]+'-'+p[1]+'-'+p[0]);
      if(!lastCall||d>lastCall)lastCall=d;
    });
    var daysSince=lastCall?Math.floor((now-lastCall)/(1000*60*60*24)):999;
    if(daysSince>=3){
      staleDeals.push({id:c.id,name:c.name,status:c.status,dealSum:c.dealSum||0,counterparty:c.counterparty,daysSince:daysSince,lastCall:lastCall?lastCall.toLocaleDateString('ru-RU'):'никогда'});
    }
  });
  staleDeals.sort(function(a,b){return (b.dealSum||0)-(a.dealSum||0);});
  if(staleDeals.length){
    h+='<div class="sec" style="margin-top:18px"><h3 style="color:#f59e0b">🔔 Требуют дожима ('+staleDeals.length+')</h3>';
    h+='<div style="font-size:12px;color:#6b7280;margin-bottom:10px">Сделки в статусе КП/Дожим без звонка 3+ дней</div>';
    h+='<table style="width:100%;font-size:13px"><tr style="color:#6b7280;font-size:11px"><th style="text-align:left">Сделка</th><th>Статус</th><th>Сумма</th><th>Дней без звонка</th><th>Посл. звонок</th></tr>';
    for(var si=0;si<Math.min(staleDeals.length,30);si++){
      var sd=staleDeals[si];
      var urgColor=sd.daysSince>=14?'#dc2626':sd.daysSince>=7?'#b45309':'#9ca3af';
      h+='<tr>';
      h+='<td style="font-weight:600;color:#1a1a2e;padding:6px 0">#'+sd.id+' '+esc(sd.name.substring(0,40))+'</td>';
      h+='<td style="text-align:center"><span class="tag">'+esc(sd.status)+'</span></td>';
      h+='<td style="text-align:right;font-weight:700;color:#fbbf24">'+(sd.dealSum?fmt(sd.dealSum)+' ₽':'—')+'</td>';
      h+='<td style="text-align:center;font-weight:700;color:'+urgColor+'">'+sd.daysSince+'</td>';
      h+='<td style="text-align:center;color:#6b7280;font-size:12px">'+sd.lastCall+'</td>';
      h+='</tr>';
    }
    if(staleDeals.length>30) h+='<tr><td colspan="5" style="color:#6b7280;font-size:12px">...ещё '+(staleDeals.length-30)+'</td></tr>';
    h+='</table></div>';
  }

  // === ВХОДЯЩИЕ ОБРАЩЕНИЯ (клиенты/другие сотрудники) ===
  var inc=D.dailyActivity.incomingDeals||[];
  if(inc.length){
    h+='<div class="sec" style="margin-top:18px"><h3 style="color:#93c5fd">📨 Входящие обращения ('+inc.length+')</h3>';
    h+='<div style="font-size:12px;color:#6b7280;margin-bottom:10px">Сделки где написал клиент или другой сотрудник, но менеджер не взаимодействовал</div>';
    for(var ii=0;ii<inc.length;ii++){
      var dd=inc[ii];
      h+='<div style="background:rgba(96,165,250,.06);border:1px solid rgba(96,165,250,.15);border-radius:8px;padding:10px 14px;margin-bottom:6px">';
      h+='<div style="font-weight:700;color:#1a1a2e">#'+dd.id+' '+esc(dd.name)+'</div>';
      h+='<div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">';
      if(dd.status) h+='<span class="tag">'+esc(dd.status)+'</span>';
      if(dd.dealSum) h+='<span class="tag" style="background:#854d0e;color:#fbbf24">'+fmt(dd.dealSum)+' ₽</span>';
      h+='</div>';
      var acts=dd.actions||[];
      for(var ai=0;ai<acts.length;ai++){
        var a=acts[ai];
        h+='<div style="font-size:12px;color:#6b7280;margin-top:4px">'+esc(a.owner||'')+': '+esc(a.text||'')+'</div>';
      }
      h+='</div>';
    }
    h+='</div>';
  }

  document.getElementById('out').innerHTML=h;
}
function fmt(n){return n?n.toLocaleString('ru-RU'):'0'}
function fmtD(iso){if(!iso)return'?';const d=new Date(iso);return isNaN(d)?iso:d.toLocaleDateString('ru-RU',{day:'2-digit',month:'short'})}
function yn(v){return v==='Да'?'<span class="yes">✓</span>':'<span class="no">✗</span>'}
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')}
function timeToMin(t){const m=(t||'').match(/(\\d+):(\\d+)/);return m?parseInt(m[1])*60+parseInt(m[2]):0}
init();
</script></body></html>`;
}

// ============ Пути файлов для менеджера ============
function mgrDataFile(alias) { return path.join(__dirname, 'data', `${alias}_latest.json`); }
function mgrFunnelFile(alias) { return path.join(__dirname, 'data', `${alias}_funnel.json`); }
function mgrReportFile(alias) { return path.join(__dirname, 'reports', `${alias}.html`); }
function mgrDeployDir(alias) { return path.join(__dirname, 'deploy', alias); }

// ============ Один менеджер ============
async function runForManager(mgr, reportDate) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 ${mgr.name} — ${reportDate}\n`);

  // Обеспечиваем директории
  for (const d of [path.join(__dirname, 'data'), path.join(__dirname, 'reports'), mgrDeployDir(mgr.alias)])
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

  const tasks = await getAllTasks(mgr.userId);
  console.log(`  ✅ Сделок: ${tasks.length}\n`);

  const result = await buildDealCards(tasks, mgr.pfName, reportDate, mgr.alias);
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
    managerAlias: mgr.alias,
    reportDate,
    dealCards, dailyReports, dailyActivity, funnelChanges, scriptCompliance,
    dailyDealActivity, aiDaySummaryText,
    multiDayActivity, multiDaySummary,
    managerSummaries: result.managerSummaries || {},
    snapshotDate: result.snapshotDate,
  };

  // Сохраняем данные (per-manager + совместимость со старым latest_data.json)
  fs.writeFileSync(mgrDataFile(mgr.alias), JSON.stringify(outData, null, 2), 'utf8');
  fs.writeFileSync(path.join(__dirname, 'latest_data.json'), JSON.stringify(outData, null, 2), 'utf8');

  // HTML
  const html = generateHtml(mgr.name, outData, MANAGERS_LIST);
  const htmlPath = mgrReportFile(mgr.alias);
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(path.join(__dirname, 'report.html'), html, 'utf8');
  fs.writeFileSync(path.join(mgrDeployDir(mgr.alias), 'index.html'), html, 'utf8');

  console.log(`\n🌐 ${htmlPath}`);

  // === Автоотправка ИИ-рекомендаций в Planfix за текущий день ===
  if (dailyDealActivity.length && !process.argv.includes('--no-send')) {
    const toSend = dailyDealActivity.filter(da => da.aiAssessment && da.aiAssessment.missing && da.aiAssessment.missing.length > 0);
    if (toSend.length) {
      console.log(`\n📤 Автоотправка ИИ-рекомендаций в Planfix (${toSend.length} сделок за ${reportDate})...`);
      let sent = 0, failed = 0;
      for (const da of toSend) {
        const aa = da.aiAssessment;
        const ss = aa.salaryScore || {};
        let h = `<b>🤖 ИИ-оценка сделки за ${reportDate}</b><br><br>`;
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
        if (aa.nextStep) { h += `<br><b>▶ Следующий шаг:</b> ${aa.nextStep}<br>`; }
        try {
          await pf(`/task/${da.deal.id}/comments/`, { description: h });
          sent++;
          process.stdout.write(`  ✅ #${da.deal.id} `);
        } catch (e) {
          failed++;
          process.stdout.write(`  ❌ #${da.deal.id} `);
        }
        await sleep(300);
      }
      console.log(`\n  📤 Отправлено: ${sent}, ошибок: ${failed}`);
    }
  }

  console.log(`✅ ${mgr.name} — готово!`);
  return outData;
}

// ============ Дашборд для всех менеджеров ============
function generateDashboard(date) {
  const deployDir = path.join(__dirname, 'deploy');
  if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir, { recursive: true });

  const cards = [];
  for (const mgr of MANAGERS_LIST) {
    const dataPath = mgrDataFile(mgr.alias);
    if (!fs.existsSync(dataPath)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      const active = (d.dealCards || []).filter(c => c.isActive);
      const pipeline = active.reduce((s, c) => s + (c.dealSum || 0), 0);
      const dda = d.dailyDealActivity || [];
      const totalCalls = dda.reduce((s, dd) => s + (dd.actions || []).filter(a => a.type === 'outCall' || a.type === 'inCall').length, 0);
      const scores = dda.filter(dd => dd.ai?.salaryScore?.total).map(dd => dd.ai.salaryScore.total);
      const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—';
      const closing = active.filter(c => ['Дожим', 'Договор и оплата'].includes(c.status));
      const closingSum = closing.reduce((s, c) => s + (c.dealSum || 0), 0);
      cards.push({
        name: mgr.name, alias: mgr.alias,
        activeDealCount: active.length, pipeline,
        todayDeals: dda.length, totalCalls, avgScore,
        closingCount: closing.length, closingSum,
        reportDate: d.reportDate || date,
        aiSummary: (d.aiDaySummaryText || '').substring(0, 200),
      });
    } catch {}
  }

  const fmtMoney = n => { if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return Math.round(n / 1e3) + 'K'; return String(n); };

  let html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ТрансКом — Обзор менеджеров</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#f5f5f5;color:#1a1a2e;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:20px}
.header{text-align:center;padding:20px 0 30px}
.header h1{font-size:24px;color:#1a1a2e}
.header .date{color:#6b7280;font-size:14px;margin-top:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px;max-width:1200px;margin:0 auto}
.card{background:#fff;border-radius:12px;padding:20px;border:1px solid #d1d5db;transition:transform .2s}
.card:hover{transform:translateY(-2px);border-color:#3b82f6}
.card-name{font-size:18px;font-weight:700;color:#1a1a2e;margin-bottom:12px}
.card-metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.met{background:#f5f5f5;border-radius:8px;padding:10px;text-align:center}
.met-v{font-size:20px;font-weight:700}
.met-l{font-size:10px;color:#6b7280;text-transform:uppercase;margin-top:2px}
.green{color:#4ade80}.yellow{color:#fbbf24}.blue{color:#60a5fa}.purple{color:#a78bfa}.cyan{color:#22d3ee}
.card-summary{margin-top:12px;font-size:12px;color:#6b7280;line-height:1.4}
.card-link{display:block;text-align:center;margin-top:16px;padding:10px;background:#d97706;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px}
.card-link:hover{background:#2563eb}
.footer{text-align:center;margin-top:30px;color:#6b7280;font-size:12px}
</style></head><body>
<div class="header"><h1>ТрансКом — Обзор менеджеров</h1><div class="date">${date}</div></div>
<div class="grid">`;

  for (const c of cards) {
    html += `<div class="card">
<div class="card-name">${c.name}</div>
<div class="card-metrics">
<div class="met"><div class="met-v blue">${c.activeDealCount}</div><div class="met-l">Активных сделок</div></div>
<div class="met"><div class="met-v green">${fmtMoney(c.pipeline)} ₽</div><div class="met-l">Пайплайн</div></div>
<div class="met"><div class="met-v cyan">${c.todayDeals}</div><div class="met-l">Сделок за день</div></div>
<div class="met"><div class="met-v purple">${c.totalCalls}</div><div class="met-l">Звонков за день</div></div>
<div class="met"><div class="met-v yellow">${c.avgScore}/12</div><div class="met-l">Ср. балл</div></div>
<div class="met"><div class="met-v green">${c.closingCount} / ${fmtMoney(c.closingSum)} ₽</div><div class="met-l">К оплате</div></div>
</div>
${c.aiSummary ? `<div class="card-summary">${c.aiSummary}...</div>` : ''}
<a class="card-link" href="${c.alias}/index.html">Открыть полный отчёт →</a>
</div>`;
  }

  // Кнопка "+ Менеджер"
  html += `<div style="text-align:center;margin-top:20px">
<button onclick="document.getElementById('addModal').style.display='flex'" style="padding:12px 24px;background:#fff;color:#d97706;border:2px dashed #d1d5db;border-radius:12px;font-size:16px;cursor:pointer;font-weight:600">+ Добавить менеджера</button>
</div>`;

  // Модалка добавления менеджера
  html += `<div id="addModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:100;align-items:center;justify-content:center">
<div style="background:#fff;border-radius:16px;padding:30px;max-width:450px;width:90%;border:1px solid #d1d5db">
<h2 style="color:#1a1a2e;margin-bottom:20px;font-size:20px">Добавить менеджера</h2>
<p style="color:#6b7280;font-size:13px;margin-bottom:16px">Введите данные нового менеджера. userId можно найти в Planfix: Сотрудники → Профиль → число в URL.</p>
<div style="margin-bottom:12px"><label style="color:#6b7280;font-size:12px">Имя и Фамилия</label><br>
<input id="mgrName" placeholder="Иван Иванов" style="width:100%;padding:10px;background:#f5f5f5;border:1px solid #d1d5db;border-radius:8px;color:#1a1a2e;font-size:14px;margin-top:4px"></div>
<div style="margin-bottom:12px"><label style="color:#6b7280;font-size:12px">userId из Planfix</label><br>
<input id="mgrId" type="number" placeholder="55" style="width:100%;padding:10px;background:#f5f5f5;border:1px solid #d1d5db;border-radius:8px;color:#1a1a2e;font-size:14px;margin-top:4px"></div>
<div id="addResult" style="display:none;margin-bottom:12px;padding:12px;border-radius:8px;font-size:12px"></div>
<div style="display:flex;gap:10px;margin-top:16px">
<button onclick="addManager()" style="flex:1;padding:10px;background:#d97706;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">Добавить</button>
<button onclick="document.getElementById('addModal').style.display='none'" style="flex:1;padding:10px;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:8px;font-size:14px;cursor:pointer">Отмена</button>
</div>
</div></div>

<script>
function addManager(){
  var name=document.getElementById('mgrName').value.trim();
  var id=parseInt(document.getElementById('mgrId').value);
  if(!name||!id){alert('Заполните имя и userId');return;}
  var alias=name.split(' ').pop().toLowerCase().replace(/[^a-zа-яё]/gi,'');
  var pfName=name.split(' ').pop();
  var entry={alias:alias,userId:id,name:name,pfName:pfName};
  // Сохраняем в localStorage
  var saved=JSON.parse(localStorage.getItem('transcom_managers')||'[]');
  if(saved.find(function(m){return m.userId===id})){alert('Менеджер с таким ID уже добавлен');return;}
  saved.push(entry);
  localStorage.setItem('transcom_managers',JSON.stringify(saved));
  // Показываем JSON для managers.json
  var res=document.getElementById('addResult');
  res.style.display='block';
  res.style.background='#f0fdf4';
  res.style.color='#16a34a';
  res.innerHTML='<b>Добавлено!</b> Чтобы отчёт генерировался автоматически, добавьте в <code>managers.json</code>:<br><br>'
    +'<code style="color:#fbbf24;word-break:break-all">'+JSON.stringify(entry)+'</code>'
    +'<br><br>После коммита и пуша — отчёт появится при следующем запуске в 19:00.';
  // Добавляем карточку на страницу
  var grid=document.querySelector('.grid');
  var div=document.createElement('div');
  div.className='card';
  div.innerHTML='<div class="card-name">'+name+'</div>'
    +'<div style="color:#6b7280;font-size:13px;padding:20px 0">Отчёт будет сгенерирован при следующем запуске после добавления в managers.json</div>'
    +'<div style="padding:8px 12px;background:#f5f5f5;border-radius:8px;font-size:11px;color:#fbbf24">userId: '+id+' | alias: '+alias+'</div>';
  grid.appendChild(div);
}
</script>`;

  html += `<div class="footer">Обновлено: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</div></body></html>`;

  fs.writeFileSync(path.join(deployDir, 'index.html'), html, 'utf8');
  console.log(`\n📊 Дашборд: deploy/index.html (${cards.length} менеджеров)`);
}

// ============ MAIN ============
async function main() {
  // Режим --html: перегенерация HTML из кэша
  if (process.argv.includes('--html')) {
    const rawName = process.argv.find(a => a !== '--html' && !a.endsWith('.js') && !a.startsWith('--') && a !== 'node');
    if (rawName && MANAGERS[rawName]) {
      // Один менеджер
      const mgr = MANAGERS[rawName];
      const dataPath = mgrDataFile(mgr.alias);
      const fallback = path.join(__dirname, 'latest_data.json');
      const dataFile = fs.existsSync(dataPath) ? dataPath : fallback;
      if (!fs.existsSync(dataFile)) { console.error('❌ Данные не найдены'); process.exit(1); }
      const outData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      const html = generateHtml(mgr.name, outData, MANAGERS_LIST);
      fs.writeFileSync(mgrReportFile(mgr.alias), html, 'utf8');
      fs.writeFileSync(path.join(__dirname, 'report.html'), html, 'utf8');
      if (!fs.existsSync(mgrDeployDir(mgr.alias))) fs.mkdirSync(mgrDeployDir(mgr.alias), { recursive: true });
      fs.writeFileSync(path.join(mgrDeployDir(mgr.alias), 'index.html'), html, 'utf8');
      console.log(`✅ HTML: ${mgrReportFile(mgr.alias)}`);
    } else {
      // Все менеджеры
      for (const mgr of MANAGERS_LIST) {
        const dataPath = mgrDataFile(mgr.alias);
        const fallback = path.join(__dirname, 'latest_data.json');
        const dataFile = fs.existsSync(dataPath) ? dataPath : fallback;
        if (!fs.existsSync(dataFile)) continue;
        const outData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        const html = generateHtml(mgr.name, outData, MANAGERS_LIST);
        fs.writeFileSync(mgrReportFile(mgr.alias), html, 'utf8');
        fs.writeFileSync(path.join(__dirname, 'report.html'), html, 'utf8');
        if (!fs.existsSync(mgrDeployDir(mgr.alias))) fs.mkdirSync(mgrDeployDir(mgr.alias), { recursive: true });
        fs.writeFileSync(path.join(mgrDeployDir(mgr.alias), 'index.html'), html, 'utf8');
        console.log(`✅ HTML: ${mgrReportFile(mgr.alias)}`);
      }
      const now = new Date();
      generateDashboard(`${pad2(now.getDate())}-${pad2(now.getMonth()+1)}-${now.getFullYear()}`);
    }
    return;
  }

  if (!TOKEN) { console.error('❌ PLANFIX_TOKEN не задан'); process.exit(1); }

  // Определяем дату отчёта
  const dateArg = process.argv.find(a => /^\d{2}-\d{2}-\d{4}$/.test(a));
  let reportDate;
  if (dateArg) {
    reportDate = dateArg;
  } else {
    const now = new Date();
    reportDate = `${pad2(now.getDate())}-${pad2(now.getMonth()+1)}-${now.getFullYear()}`;
  }

  // Режим --all: все менеджеры
  if (process.argv.includes('--all')) {
    console.log(`🚀 ТрансКом v9.0 — ВСЕ менеджеры — ${reportDate}`);
    console.log(`   Менеджеров: ${MANAGERS_LIST.length}\n`);
    for (const mgr of MANAGERS_LIST) {
      await runForManager(mgr, reportDate);
    }
    generateDashboard(reportDate);
    console.log('\n✅ Все отчёты готовы!');
    return;
  }

  // Один менеджер (обратная совместимость)
  const rawFilterName = (process.argv[2] || 'Боровая').trim();
  const mgr = MANAGERS[rawFilterName] || MANAGERS[rawFilterName.toLowerCase()];
  if (!mgr) { console.error('❌ Менеджер не найден'); process.exit(1); }

  await runForManager(mgr, reportDate);
  generateDashboard(reportDate);

  try {
    const { exec } = require('child_process');
    exec(process.platform === 'win32' ? `start "" "${path.join(__dirname, 'report.html')}"` : `xdg-open "${path.join(__dirname, 'report.html')}"`);
  } catch {}
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
    if (aa.nextStep) { h += `<br><b>▶ Следующий шаг:</b> ${aa.nextStep}<br>`; }

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
