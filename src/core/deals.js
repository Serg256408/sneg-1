// ============================================================
// deals.js — Новая логика загрузки сделок
// Старая логика: deals.old.js
// ============================================================

const { pf, pfGet } = require('../api/planfix');
const {
  sleep, parallelMap, utcToMsk, stripHtml, timeToMinNode, extractWorkDesc, normalizePhone,
} = require('../utils/helpers');
const { extractTranscription } = require('./transcription');
const { CONCURRENCY, SKIP_STATUSES, DEAL_FIELDS, DEEPSEEK_KEY, POLZA_KEY, OPENAI_KEY, isTimeUp } = require('../utils/config');
const { transcribeCallIfNeeded } = require('../api/whisper');
const { aiDealFullAssessment } = require('./assessment');
const { aiDaySummary, aiManagerSummary } = require('./manager-report');
const { loadAiCache, saveAiCache } = require('./cache');
const { loadHistory, saveHistory, ensureDeal } = require('./history');

// Справочник "Реестр активности"
const DIRECTORY_ID = 16572;
const FIELD_DATE = 34134;       // Дата
const FIELD_EMPLOYEE = 34136;   // Сотрудник
const FIELD_TASK_ID = 34138;    // Id Задачи
const FIELD_TASK_NAME = 34140;  // Название задачи

const DIR_FIELDS = `key,${FIELD_DATE},${FIELD_EMPLOYEE},${FIELD_TASK_ID},${FIELD_TASK_NAME}`;

// ============ ШАГ 1: Сделки из реестра активности ============

async function getManagerDeals(userId, reportDate) {
  const seenIds = new Set();
  const all = [];
  let offset = 0;

  while (true) {
    process.stdout.write(`  Реестр активности offset=${offset}...`);
    let d;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        d = await pf(`/directory/${DIRECTORY_ID}/entry/list`, { offset, pageSize: 100, fields: DIR_FIELDS });
        break;
      } catch (e) {
        if (attempt < 3) { await sleep(2000 * attempt); continue; }
        console.log(` ⚠️ ${e.message}`);
        return all;
      }
    }
    const entries = d.directoryEntries || [];
    console.log(` ${entries.length}`);

    let olderCount = 0;
    for (const entry of entries) {
      const fields = {};
      for (const cf of (entry.customFieldData || [])) fields[cf.field?.id] = cf;
      const date = fields[FIELD_DATE]?.stringValue || '';
      if (date !== reportDate) { olderCount++; continue; }
      olderCount = 0; // сбрасываем — нашли запись за нужную дату
      const empId = (fields[FIELD_EMPLOYEE]?.value?.id || '').replace('user:', '');
      if (empId !== String(userId)) continue;
      const taskId = fields[FIELD_TASK_ID]?.value?.id;
      if (taskId && !seenIds.has(taskId)) { seenIds.add(taskId); all.push(taskId); }
    }

    // Ранний выход: вся страница — записи не за нашу дату (старше)
    if (olderCount >= entries.length && entries.length > 0) {
      console.log(`  ⏭ Пропуск: ${olderCount} записей не за ${reportDate}, выход`);
      break;
    }
    if (entries.length < 100) break;
    offset += 100;
    await sleep(300);
  }

  console.log(`  ✅ Уникальных сделок: ${all.length}`);
  return all;
}

// ============ ШАГ 2: Комментарии задачи ============

async function getDealComments(taskId) {
  const all = [];
  let offset = 0;
  while (true) {
    let d;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        d = await pf(`/task/${taskId}/comments/list`, {
          offset, pageSize: 100,
          fields: 'id,description,dateTime,owner,type,isPinned,files',
        });
        break;
      } catch (e) {
        if (attempt < 3) { await sleep(2000 * attempt); continue; }
        console.log(`    ⚠️ Комментарии #${taskId}: ${e.message}`);
        return all;
      }
    }
    const comments = d.comments || [];
    all.push(...comments);
    if (comments.length < 100) break;
    offset += 100;
    await sleep(300);
  }
  return all;
}

// ============ Парсинг комментариев ============

// allowWhisper: true = сделка активна за день, транскрибируем все звонки (даже старые)
async function parseComment(c, reportDate, transcriptionCache, allowWhisper) {
  const desc = stripHtml(c.description);
  const dt = utcToMsk(c.dateTime?.date, c.dateTime?.time);
  let type = 'note';
  const descLow = desc.toLowerCase();

  if (descLow.startsWith('исходящий звонок')) type = 'outCall';
  else if (descLow.startsWith('входящий звонок')) type = 'inCall';
  else if (descLow.startsWith('ндз')) type = 'ndz';
  else if (descLow.includes('входящий звонок') || descLow.includes('исходящий звонок')) {
    type = descLow.includes('исходящий звонок') ? 'outCall' : 'inCall';
  }

  if (type === 'note') {
    const hasTranscription = desc.includes('----------') && (/[🔴🔵●]/.test(desc) || /A:.*B:/s.test(desc));
    const hasRecording = (c.files || []).some(f => (f.name || '').toLowerCase().includes('запись звонка'));
    if (hasTranscription || hasRecording) type = 'inCall';
  }

  let transcription = null;
  if (type === 'outCall' || type === 'inCall') {
    transcription = extractTranscription(c.description);
    // Whisper: сделка активна за день → транскрибируем любой звонок (и старый тоже)
    if (!transcription && (POLZA_KEY || OPENAI_KEY) && transcriptionCache) {
      transcription = await transcribeCallIfNeeded({ transcription, files: c.files || [] }, transcriptionCache, !!allowWhisper);
    }
  }
  // note с mp3 "Запись звонка" — тоже транскрибируем
  if (!transcription && type === 'note' && (POLZA_KEY || OPENAI_KEY) && transcriptionCache) {
    const cFiles = c.files || [];
    const hasCallRecording = cFiles.some(f => {
      const fn = (f.name || f.fileName || '').toLowerCase();
      return fn.endsWith('.mp3') && fn.includes('запись звонка');
    });
    if (hasCallRecording) {
      type = 'inCall';
      transcription = await transcribeCallIfNeeded({ transcription: null, files: cFiles }, transcriptionCache, !!allowWhisper);
    }
  }

  const files = (c.files || []).map(f => f.name || f.fileName || '').filter(Boolean);
  return {
    id: c.id, date: dt.date || '', time: dt.time || '',
    type, text: desc.substring(0, 800),
    owner: c.owner?.name || '',
    transcription, files,
  };
}

function isAiComment(text) {
  const t = (text || '').toLowerCase();
  return t.includes('ии-рекомендаци') || t.includes('ии рекомендаци') ||
    t.includes('ai-рекомендаци') || t.includes('рекомендации ии') ||
    t.includes('ии-оценка сделки') || t.includes('🤖 ии-оценка') || t.includes('баллы зп:');
}

// ============ RED-ФЛАГИ ============

const NO_KP_STATUSES = ['Обработка', 'Коммерческое предложение'];
const FORGOTTEN_STATUSES = ['Обработка', 'Коммерческое предложение', 'Замер', 'Клиент принимает решение', 'Договор и Оплата'];
const HIGH_PRIORITY_SUM = 1000000;

function detectRedFlags(card, mgrPfName, reportDate) {
  const flags = [];
  const status = card.status || '';
  const comments = card.comments || [];

  // Парсим reportDate в объект для сравнения
  const rp = reportDate.split('-');
  const reportDateObj = new Date(rp[2], rp[1] - 1, rp[0]);

  // ⚠️ Не обработана >30 мин — сделка в статусе "Новая" больше 30 минут
  if (status === 'Новая' && card.dateCreated) {
    const cp = card.dateCreated.split('-');
    const created = new Date(cp[2], cp[1] - 1, cp[0]);
    const minutesAgo = (reportDateObj - created) / (1000 * 60);
    if (minutesAgo > 30) {
      const hoursAgo = Math.floor(minutesAgo / 60);
      const label = hoursAgo >= 24 ? `Не обработана (${Math.floor(hoursAgo / 24)} дн)` : `Не обработана (${hoursAgo}ч)`;
      flags.push({ type: 'warning', code: 'not_processed', label });
    }
  }

  // ⚠️ Нет КП >24ч (Обработка, Коммерческое предложение, НЕ на замере)
  if (NO_KP_STATUSES.includes(status)) {
    const hasKp = comments.some(c => {
      const t = (c.text || '').toLowerCase();
      const f = (c.files || []).join(' ').toLowerCase();
      return t.includes('кп') || t.includes('коммерческое предложение') ||
        f.includes('кп') || f.includes('к.п') || f.includes('коммерческое');
    });
    if (!hasKp) {
      // Найти первый комментарий клиента (не менеджер, не робот)
      const clientComment = comments.find(c =>
        c.owner && !c.owner.includes(mgrPfName) &&
        !c.owner.toLowerCase().includes('robot') &&
        c.date
      );
      if (clientComment) {
        const cp = clientComment.date.split('-');
        const clientDate = new Date(cp[2], cp[1] - 1, cp[0]);
        const hoursAgo = (reportDateObj - clientDate) / (1000 * 60 * 60);
        if (hoursAgo > 24) {
          flags.push({ type: 'warning', code: 'no_kp', label: 'Нет КП >24ч' });
        }
      }
    }
  }

  // ⚠️ Забыта — нет активности менеджера >10 дней
  // Хелпер: парсинг DD-MM-YYYY в Date
  function parseDMY(s) {
    if (!s) return null;
    const p = s.split('-');
    if (p.length !== 3) return null;
    return new Date(p[2], p[1] - 1, p[0]);
  }

  if (FORGOTTEN_STATUSES.includes(status)) {
    // Любой сотрудник (не робот) — потому что сделку могли передать, отпуск и т.д.
    const humanComments = comments.filter(c =>
      c.owner && c.date &&
      !c.owner.toLowerCase().includes('robot') &&
      !c.owner.toLowerCase().includes('робот')
    );
    if (humanComments.length) {
      let lastDate = null;
      for (const c of humanComments) {
        const d = parseDMY(c.date);
        if (d && (!lastDate || d > lastDate)) lastDate = d;
      }
      if (lastDate) {
        const daysAgo = (reportDateObj - lastDate) / (1000 * 60 * 60 * 24);
        if (daysAgo > 10) {
          flags.push({ type: 'warning', code: 'forgotten', label: `Забыта (${Math.floor(daysAgo)} дн)` });
        }
      }
    } else {
      flags.push({ type: 'warning', code: 'forgotten', label: 'Забыта (нет активности)' });
    }
  }

  // 💰 Высокий приоритет — сумма >1 000 000
  if (card.dealSum >= HIGH_PRIORITY_SUM && card.isActive) {
    flags.push({ type: 'priority', code: 'high_sum', label: `Приоритет (${Math.round(card.dealSum / 1000000 * 10) / 10}М ₽)` });
  }

  return flags;
}

// ============ ШАГ 3-6: Сборка карточек ============

async function buildDealCards(userId, reportDate, mgrPfName) {
  // Шаг 1: ID сделок из реестра
  const taskIds = await getManagerDeals(userId, reportDate);
  const emptyResult = {
    dealCards: [], dailyReports: [], allCalls: [], allAnalyses: [],
    dailyActivity: { newDeals: [], workedDeals: [], totalActive: 0 },
    funnelChanges: [], scriptCompliance: { total: 0 },
    dailyDealActivity: [], aiDaySummaryText: null,
    multiDayActivity: { [reportDate]: [] }, multiDaySummary: {},
    managerSummaries: {}, incomingByDate: {}, snapshotDate: null,
  };
  if (!taskIds.length) {
    console.log('  ⚠️ Нет сделок в реестре за этот день');
    // Но прошлые дни из истории всё равно собираем
    const history = loadHistory();
    const reportDateObj = new Date(reportDate.split('-').reverse().join('-'));
    const historyDatesSet = new Set();
    for (const [, dealHist] of Object.entries(history.deals || {})) {
      for (const c of (dealHist.comments || [])) {
        if (!c.date || c.date === reportDate) continue;
        const p = c.date.split('-');
        const d = new Date(p[2] + '-' + p[1] + '-' + p[0]);
        const daysAgo = (reportDateObj - d) / 86400000;
        if (daysAgo > 0 && daysAgo <= 30) historyDatesSet.add(c.date);
      }
    }
    const pastDays = [...historyDatesSet].sort((a, b) => {
      const pa = a.split('-'), pb = b.split('-');
      return new Date(pb[2]+'-'+pb[1]+'-'+pb[0]) - new Date(pa[2]+'-'+pa[1]+'-'+pa[0]);
    });
    if (pastDays.length) {
      console.log(`  📚 Прошлые дни из истории: ${pastDays.length}`);
      const multiDayActivity = { [reportDate]: [] };
      const multiDaySummary = {};
      const aiCache = loadAiCache();
      for (const dayDMY of pastDays) {
        const dayDeals = [];
        for (const [dealId, dealHist] of Object.entries(history.deals || {})) {
          const comments = (dealHist.comments || []).filter(c => c.date === dayDMY);
          if (!comments.length) continue;
          const hasMgr = comments.some(c => c.owner && c.owner.includes(mgrPfName));
          if (!hasMgr) continue;
          const actions = comments.map(c => ({
            type: c.type, time: c.time, text: c.text,
            owner: c.owner, transcription: c.transcription,
            source: c.source || 'deal', files: c.files || [],
          }));
          actions.sort((a, b) => timeToMinNode(a.time) - timeToMinNode(b.time));
          const isSnow = (dealHist.name || '').toLowerCase().startsWith('вывоз снега');
          const assessKey = `assess_${dealId}_${dayDMY}_${isSnow ? 'v20' : 'v20a'}`;
          dayDeals.push({
            deal: { id: Number(dealId), name: dealHist.name || '?', status: dealHist.status || '?', counterparty: dealHist.counterparty || '—', dealSum: 0, workDesc: '' },
            isNew: false, actions,
            dayCalls: actions.filter(a => a.type === 'outCall' || a.type === 'inCall').length,
            planfixScript: null, scriptHistory: { total: 0 },
            aiAssessment: dealHist.assessments?.[assessKey] || null,
          });
        }
        if (dayDeals.length) {
          multiDayActivity[dayDMY] = dayDeals;
          if (DEEPSEEK_KEY || POLZA_KEY) {
            multiDaySummary[dayDMY] = await aiDaySummary(dayDeals, dayDMY, aiCache, null);
          }
        }
      }
      emptyResult.multiDayActivity = multiDayActivity;
      emptyResult.multiDaySummary = multiDaySummary;
    }
    return emptyResult;
  }

  // Шаг 2: Загрузка данных сделок
  const API_CONCURRENCY = 3; // Planfix не выдерживает больше
  console.log(`  📋 Загрузка ${taskIds.length} сделок...`);
  const tasks = [];
  await parallelMap(taskIds, async (taskId) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const d = await pf('/task/list', {
          offset: 0, pageSize: 1,
          filters: [{ type: 57, operator: 'equal', value: taskId }],
          fields: DEAL_FIELDS,
        });
        const t = (d.tasks || [])[0];
        if (t) tasks.push(t);
        break;
      } catch (e) {
        if (attempt < 3) { await sleep(2000 * attempt); continue; }
        console.log(`    ⚠️ Не удалось загрузить #${taskId}: ${e.message}`);
      }
    }
  }, API_CONCURRENCY);
  console.log(`    ✅ Загружено: ${tasks.length}`);

  // Кэш транскрибаций из ai_cache
  const aiCachePreload = loadAiCache();
  const transcriptionCache = {};
  for (const [k, v] of Object.entries(aiCachePreload)) {
    if (k.startsWith('whisper_')) transcriptionCache[k.replace('whisper_', '')] = v;
  }
  console.log(`  📝 Кэш транскрибаций: ${Object.keys(transcriptionCache).length}`);

  // Хелпер: парсинг массива комментариев с Whisper
  async function parseAll(rawComments) {
    const parsed = [];
    for (const c of rawComments) {
      const p = await parseComment(c, reportDate, transcriptionCache, true); // активная сделка → Whisper для всех звонков
      if (!isAiComment(p.text)) parsed.push(p);
    }
    return parsed;
  }

  // Шаг 3: Комментарии сделок (сначала из deal_history.json, потом API)
  const history = loadHistory();
  console.log(`  💬 Загрузка комментариев...`);
  const commentsByTask = {};
  let fromCache = 0, fromApi = 0;
  let loadIdx = 0;
  await parallelMap(tasks, async (t) => {
    const dealHist = history.deals[String(t.id)];
    if (dealHist && dealHist.commentsLoaded && dealHist.comments && dealHist.comments.length) {
      // Есть в истории — берём оттуда
      const cached = dealHist.comments.filter(c => !isAiComment(c.text));
      // Догружаем из API только новые (по id)
      const cachedIds = new Set(cached.map(c => c.id));
      const raw = await getDealComments(t.id);
      const newComments = raw.filter(c => !cachedIds.has(c.id));
      if (newComments.length) {
        const newParsed = await parseAll(newComments);
        commentsByTask[t.id] = [...cached, ...newParsed];
        // Обновляем историю
        const dh = ensureDeal(history, t.id);
        dh.comments = commentsByTask[t.id];
        dh.commentsLoaded = true;
      } else {
        // Whisper для старых звонков без транскрибации (может появился кэш)
        const needWhisper = cached.filter(c => (c.type === 'outCall' || c.type === 'inCall') && !c.transcription && c.files?.some(f => f.toLowerCase().includes('.mp3')));
        if (needWhisper.length) {
          // Перепарсим из API чтобы Whisper отработал
          const reparsed = await parseAll(raw);
          commentsByTask[t.id] = reparsed;
          const dh = ensureDeal(history, t.id);
          dh.comments = reparsed;
        } else {
          commentsByTask[t.id] = cached;
        }
      }
      fromCache++;
    } else {
      // Нет в истории — грузим из API
      const raw = await getDealComments(t.id);
      commentsByTask[t.id] = await parseAll(raw);
      // Сохраняем в историю
      const dh = ensureDeal(history, t.id);
      dh.comments = commentsByTask[t.id];
      dh.commentsLoaded = true;
      fromApi++;
    }
    loadIdx++;
    if (loadIdx % 5 === 0) process.stdout.write(`\r    [${loadIdx}/${tasks.length}]`);
  }, API_CONCURRENCY);
  if (tasks.length > 0) console.log(`\r    [${tasks.length}/${tasks.length}] (кэш: ${fromCache}, API: ${fromApi}) ✅`);

  // Шаг 4: Подзадачи
  console.log(`  📎 Подзадачи...`);
  for (const t of tasks) {
    try {
      const d = await pf('/task/list', {
        offset: 0, pageSize: 100,
        filters: [{ type: 58, operator: 'equal', value: t.id }],
        fields: 'id,name',
      });
      const children = d.tasks || [];
      for (const ch of children) {
        const chRaw = await getDealComments(ch.id);
        const chParsed = await parseAll(chRaw);
        if (chParsed.length) {
          if (!commentsByTask[t.id]) commentsByTask[t.id] = [];
          commentsByTask[t.id].push(...chParsed);
        }
      }
    } catch {}
  }
  console.log(`    ✅`);

  // Шаг 5: Звонки из контрагентов (с поиском дублей по телефону)
  console.log(`  👤 Контрагенты...`);
  const contactCallsByTask = {};
  const seenContactIds = new Set(); // чтобы не грузить один контакт дважды

  // Загрузить звонки из одного контакта и привязать к сделке
  async function loadContactCalls(contactId, taskId) {
    if (seenContactIds.has(contactId)) return;
    seenContactIds.add(contactId);
    try {
      const d = await pf(`/contact/${contactId}/comments/list`, {
        offset: 0, pageSize: 100,
        fields: 'id,description,dateTime,owner,files',
      });
      for (const c of (d.comments || [])) {
        const parsed = await parseComment(c, reportDate, transcriptionCache, true); // активная сделка → Whisper
        if (parsed.type !== 'outCall' && parsed.type !== 'inCall') continue;
        parsed.source = 'contact';
        const existing = [...(commentsByTask[taskId] || []), ...(contactCallsByTask[taskId] || [])];
        const isDupe = existing.some(e =>
          (e.type === 'outCall' || e.type === 'inCall') &&
          e.date === parsed.date &&
          Math.abs(timeToMinNode(e.time) - timeToMinNode(parsed.time)) < 5
        );
        if (!isDupe) {
          if (!contactCallsByTask[taskId]) contactCallsByTask[taskId] = [];
          contactCallsByTask[taskId].push(parsed);
        }
      }
    } catch {}
  }

  for (const t of tasks) {
    const cpId = (t.counterparty?.id || '').replace('contact:', '');
    if (!cpId) continue;

    // Загружаем звонки основного контрагента
    await loadContactCalls(cpId, t.id);

    // Ищем дубли по телефону
    try {
      const contact = await pfGet(`/contact/${cpId}?fields=id,phones`);
      const phones = contact.contact?.phones || [];
      for (const p of phones) {
        const norm = normalizePhone(p.number);
        if (!norm || norm.length < 10) continue;
        // Ищем контакты с таким же нормализованным телефоном
        const search = await pf('/contact/list', {
          offset: 0, pageSize: 10,
          fields: 'id,phones',
          filters: [{ type: 61, operator: 'contain', value: norm.slice(-10) }],
        });
        for (const dup of (search.contacts || [])) {
          const dupId = String(dup.id);
          if (dupId === cpId) continue; // это сам контрагент
          // Проверяем что телефон реально совпадает
          const dupPhones = (dup.phones || []).map(dp => normalizePhone(dp.number));
          if (dupPhones.includes(norm)) {
            console.log(`    📞 Дубль: contact:${dupId} → сделка #${t.id}`);
            await loadContactCalls(dupId, t.id);
          }
        }
      }
    } catch {}
    await sleep(100);
  }
  console.log(`    ✅`);

  // Шаг 6: Сборка карточек
  const dealCards = tasks.map(t => {
    const cf = {};
    for (const c of (t.customFieldData || [])) cf[c.field.id] = { name: c.field.name, value: c.value, str: c.stringValue || '' };

    const allComments = commentsByTask[t.id] || [];
    const contactCalls = (contactCallsByTask[t.id] || []).filter(c => c.owner.includes(mgrPfName));
    const comments = [...allComments, ...contactCalls];

    const createdDate = t.dateTime?.date || t.dateCreated?.date || '';
    const isNew = createdDate === reportDate && (t.status?.name || '') !== 'Новая';

    const card = {
      id: t.id,
      name: t.name,
      status: t.status?.name || '?',
      template: t.template?.name || '',
      counterparty: t.counterparty?.name || '—',
      dateCreated: createdDate,
      dealSum: parseFloat(cf[67906]?.value || 0) || 0,
      workDesc: extractWorkDesc(t.name),
      isActive: !SKIP_STATUSES.includes(t.status?.name || ''),
      isNew,
      calls: [],
      analyses: [],
      comments,
      totalCalls: comments.filter(c => c.type === 'outCall' || c.type === 'inCall').length,
      totalDuration: 0,
      totalAnalyses: 0,
      avgBalls: null,
      redFlags: [],
    };
    card.redFlags = detectRedFlags(card, mgrPfName, reportDate);
    return card;
  });

  // Сохраняем метаданные сделок в историю (name, status, counterparty)
  for (const card of dealCards) {
    const dh = ensureDeal(history, card.id);
    dh.name = card.name;
    dh.status = card.status;
    dh.counterparty = card.counterparty;
  }

  // Шаг 7: Дневная активность (формат для assessment и HTML)
  const dailyDealActivity = dealCards.map(card => {
    const dayComments = card.comments.filter(c => c.date === reportDate);
    const actions = dayComments.map(c => ({
      type: c.type, time: c.time, text: c.text,
      owner: c.owner, transcription: c.transcription,
      source: c.source || 'deal', files: c.files || [],
    }));
    actions.sort((a, b) => timeToMinNode(a.time) - timeToMinNode(b.time));
    return {
      deal: { id: card.id, name: card.name, status: card.status, counterparty: card.counterparty, dealSum: card.dealSum, workDesc: card.workDesc },
      isNew: card.isNew,
      actions,
      dayCalls: actions.filter(a => a.type === 'outCall' || a.type === 'inCall').length,
      planfixScript: null,
      allComments: card.comments,
      allCalls: card.calls,
      allAnalyses: card.analyses,
      scriptHistory: { total: 0, everHowWeWork: false, everCallToAction: false, everSentInvoice: false, everAllFour: false, bestScore: 0, customerKnowsCompany: false },
      aiAssessment: null,
    };
  });

  // Шаг 8: dailyActivity (новые/обработанные за день)
  const dailyActivity = {
    newDeals: dealCards.filter(c => c.isNew).map(c => ({ id: c.id, name: c.name, status: c.status, counterparty: c.counterparty })),
    workedDeals: [],
    totalActive: dealCards.length,
  };
  for (const card of dealCards) {
    if (card.isNew) continue;
    const hasMgrAction = card.comments.some(c => c.date === reportDate && c.owner && c.owner.includes(mgrPfName));
    if (hasMgrAction) {
      const dayActions = card.comments
        .filter(c => c.date === reportDate && c.owner && c.owner.includes(mgrPfName))
        .map(c => ({ type: c.type, text: (c.text || '').substring(0, 100), time: c.time }));
      dailyActivity.workedDeals.push({ id: card.id, name: card.name, status: card.status, counterparty: card.counterparty, actions: dayActions });
    }
  }

  // Шаг 9: ИИ-оценка сделок
  const aiCache = loadAiCache();
  let aiDaySummaryText = null;
  let managerSummaries = {};

  if (dailyDealActivity.length && (DEEPSEEK_KEY || POLZA_KEY)) {
    console.log(`  🤖 ИИ-оценка ${dailyDealActivity.length} сделок...`);
    let aiIdx = 0;
    await parallelMap(dailyDealActivity, async (da) => {
      if (!isTimeUp()) da.aiAssessment = await aiDealFullAssessment(da, reportDate, history, true);
      aiIdx++;
      process.stdout.write(`\r    [${aiIdx}/${dailyDealActivity.length}]`);
    }, 3); // не больше 3 параллельных ИИ-запросов
    console.log(' ✅');

    // Шаг 10: Итог дня
    aiDaySummaryText = await aiDaySummary(dailyDealActivity, reportDate, aiCache, null, true);

    // Шаг 11: Отчёты руководителя (день / неделя / месяц)
    console.log(`  📋 Отчёты руководителя...`);
    const multiDayAct = { [reportDate]: dailyDealActivity };
    const multiDaySum = {};
    if (aiDaySummaryText) multiDaySum[reportDate] = aiDaySummaryText;
    for (const period of [1, 7, 30]) {
      const label = period === 1 ? 'день' : period === 7 ? 'неделя' : 'месяц';
      process.stdout.write(`    ${label}...`);
      const summary = await aiManagerSummary(multiDayAct, multiDaySum, dealCards, [], period, reportDate, aiCache, null, true);
      if (summary) managerSummaries[period] = summary;
      console.log(summary ? ' ✅' : ' пропуск');
    }

    saveHistory(history, reportDate);
    saveAiCache(aiCache);
  }

  console.log(`  ✅ Карточек: ${dealCards.length}, за день: ${dailyDealActivity.length}`);

  // Шаг 12: Прошлые дни из deal_history.json
  const multiDayActivity = { [reportDate]: dailyDealActivity };
  const multiDaySummary = aiDaySummaryText ? { [reportDate]: aiDaySummaryText } : {};

  const reportDateObj = new Date(reportDate.split('-').reverse().join('-'));
  const historyDatesSet = new Set();
  for (const [, dealHist] of Object.entries(history.deals || {})) {
    for (const c of (dealHist.comments || [])) {
      if (!c.date || c.date === reportDate) continue;
      const p = c.date.split('-');
      const d = new Date(p[2] + '-' + p[1] + '-' + p[0]);
      const daysAgo = (reportDateObj - d) / 86400000;
      if (daysAgo > 0 && daysAgo <= 30) historyDatesSet.add(c.date);
    }
  }
  const pastDays = [...historyDatesSet].sort((a, b) => {
    const pa = a.split('-'), pb = b.split('-');
    return new Date(pb[2]+'-'+pb[1]+'-'+pb[0]) - new Date(pa[2]+'-'+pa[1]+'-'+pa[0]);
  });
  console.log(`  📚 Прошлые дни из истории: ${pastDays.length}`);

  for (const dayDMY of pastDays) {
    const dayDeals = [];
    for (const [dealId, dealHist] of Object.entries(history.deals || {})) {
      const comments = (dealHist.comments || []).filter(c => c.date === dayDMY);
      if (!comments.length) continue;
      const hasMgr = comments.some(c => c.owner && c.owner.includes(mgrPfName));
      if (!hasMgr) continue;
      const actions = comments.map(c => ({
        type: c.type, time: c.time, text: c.text,
        owner: c.owner, transcription: c.transcription,
        source: c.source || 'deal', files: c.files || [],
      }));
      actions.sort((a, b) => timeToMinNode(a.time) - timeToMinNode(b.time));
      const isSnow = (dealHist.name || '').toLowerCase().startsWith('вывоз снега');
      const assessKey = `assess_${dealId}_${dayDMY}_${isSnow ? 'v20' : 'v20a'}`;
      const aiAssessment = dealHist.assessments?.[assessKey] || null;
      dayDeals.push({
        deal: { id: Number(dealId), name: dealHist.name || '?', status: dealHist.status || '?', counterparty: dealHist.counterparty || '—', dealSum: 0, workDesc: '' },
        isNew: false, actions,
        dayCalls: actions.filter(a => a.type === 'outCall' || a.type === 'inCall').length,
        planfixScript: null,
        scriptHistory: { total: 0, everHowWeWork: false, everCallToAction: false },
        aiAssessment,
      });
    }
    if (dayDeals.length) {
      multiDayActivity[dayDMY] = dayDeals;
      // Итог дня из кэша
      const aiCache = loadAiCache();
      if (DEEPSEEK_KEY || POLZA_KEY) {
        multiDaySummary[dayDMY] = await aiDaySummary(dayDeals, dayDMY, aiCache, null);
      }
    }
  }

  return {
    dealCards,
    dailyReports: [],
    allCalls: [],
    allAnalyses: [],
    dailyActivity,
    funnelChanges: [],
    scriptCompliance: { total: 0 },
    dailyDealActivity,
    aiDaySummaryText,
    multiDayActivity,
    multiDaySummary,
    managerSummaries,
    incomingByDate: {},
    snapshotDate: null,
  };
}

module.exports = { getManagerDeals, getDealComments, buildDealCards };

// === Тестовый вызов ===
if (require.main === module) {
  buildDealCards('1', '29-03-2026', 'Боровая').then(cards => {
    console.log('\n=== РЕЗУЛЬТАТ ===');
    console.log('Карточек:', cards.length);
    cards.forEach(c => {
      const dayCom = c.comments.filter(x => x.date === '29-03-2026');
      const calls = dayCom.filter(x => x.type === 'outCall' || x.type === 'inCall');
      console.log(`#${c.id} ${c.name} | ${c.status} | комм:${dayCom.length} звонки:${calls.length}`);
    });
  }).catch(e => console.error('Ошибка:', e));
}
