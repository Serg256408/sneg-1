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

const { loadAiCache, saveAiCache } = require('../core/cache');
const { extractTranscription } = require('../core/transcription');
const { calculateSalaryScore } = require('../core/scoring');
const { pf, getTaskComments, getContactComments } = require('../api/planfix');
const { openaiChat } = require('../api/deepseek');
const { transcribeCallIfNeeded } = require('../api/whisper');
const { aiDealFullAssessment } = require('./assessment');
const { aiDaySummary, aiManagerSummary } = require('./manager-report');
const { loadPreviousSnapshot, saveSnapshot, computeFunnelChanges } = require('./funnel');
const { loadHistory, saveHistory, ensureDeal } = require('./history');

// ============ ВОССТАНОВЛЕНИЕ ДНЯ ИЗ ИСТОРИИ ============

function buildDayFromHistory(history, dateDMY, dealTasksMap, mgrPfName) {
  const result = [];
  for (const [dealId, dealHist] of Object.entries(history.deals)) {
    const comments = (dealHist.comments || []).filter(c => c.date === dateDMY);
    if (!comments.length) continue;
    // Только если менеджер имел активность
    const hasMgrActivity = comments.some(c => c.owner && c.owner.includes(mgrPfName));
    if (!hasMgrActivity) continue;

    const task = dealTasksMap[Number(dealId)];
    const cf = {};
    if (task) for (const c of (task.customFieldData || [])) cf[c.field.id] = { value: c.value };
    const deal = task ? {
      id: task.id, name: task.name, status: task.status?.name || '?',
      counterparty: task.counterparty?.name || '—',
      dealSum: parseFloat(cf[67906]?.value || 0) || 0,
      workDesc: extractWorkDesc(task.name),
    } : {
      id: Number(dealId), name: dealHist.name || '?', status: dealHist.status || '?',
      counterparty: dealHist.counterparty || '—', dealSum: 0, workDesc: '',
    };

    const actions = comments.map(c => ({
      type: c.type, time: c.time, text: c.text,
      owner: c.owner, transcription: c.transcription,
      source: c.source || 'deal', files: c.files || [],
    }));
    actions.sort((a, b) => timeToMinNode(a.time) - timeToMinNode(b.time));

    // ИИ-оценка из истории
    const isSnow = (deal.name || '').toLowerCase().startsWith('вывоз снега');
    const assessKey = `assess_${dealId}_${dateDMY}_${isSnow ? 'v20' : 'v20a'}`;
    const aiAssessment = dealHist.assessments?.[assessKey] || null;

    result.push({
      deal, isNew: false, actions,
      dayCalls: actions.filter(a => a.type === 'outCall' || a.type === 'inCall').length,
      planfixScript: null,
      scriptHistory: { total: 0, everHowWeWork: false, everCallToAction: false, everSentInvoice: false, everAllFour: false, bestScore: 0, customerKnowsCompany: false },
      aiAssessment,
    });
  }
  return result;
}

// ============ ОБРАБОТКА СДЕЛОК ============

async function buildDealCards(tasks, mgrPfName, reportDate, mgrAlias, mgr, lightTasks) {
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

  // === Загрузка истории сделок ===
  const history = loadHistory();

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

  // Догрузка родителей подзадач, если их нет в dealTasks
  const dealTaskIds = new Set(dealTasks.map(t => t.id));
  const missingParentIds = [...new Set(subtasks.map(st => st.parent.id).filter(pid => !dealTaskIds.has(pid)))];
  if (missingParentIds.length) {
    console.log(`  📥 Догрузка ${missingParentIds.length} родительских сделок...`);
    // Загружаем пачкой через /task/list с фильтром по ID
    for (const pid of missingParentIds) {
      try {
        const d = await pf('/task/list', {
          offset: 0, pageSize: 1,
          filters: [{ type: 57, operator: 'equal', value: pid }],
          fields: DEAL_FIELDS,
        });
        const task = (d.tasks || [])[0];
        if (task) { dealTasks.push(task); dealTaskIds.add(pid); }
      } catch (e) {
        console.log(`    ⚠️ Не удалось загрузить #${pid}: ${e.message}`);
      }
      await sleep(100);
    }
    console.log(`    ✅ Догружено: ${missingParentIds.length}`);
  }

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

  // Загружаем записи ТОЛЬКО за день отчёта (не за 60 дней!)
  const dateFrom = reportDate;
  const dateTo = reportDate;

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

  console.log(`  📞 Звонки за ${reportDate}...`);
  const allCallEntries = await loadFilteredEntries(CALL_TAG, 58528, '58528,58530,58532,58534,58536,58538,58542');
  console.log(`    ✅ ${Object.keys(allCallEntries).length}`);

  console.log(`  🔍 Анализы за ${reportDate}...`);
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

  // Все переданные сделки уже активные (getActiveTasks отфильтровал по дате)
  // Все они — приоритетные, комментарии грузим из API
  console.log(`  💬 Комментарии ${activeTasks.length} активных сделок...`);
  // Карта parentId -> [subtaskId, ...]
  const parentToSubtasks = {};
  for (const st of subtasks) {
    const pid = st.parent.id;
    if (!parentToSubtasks[pid]) parentToSubtasks[pid] = [];
    parentToSubtasks[pid].push(st.id);
  }

  const commentsByTask = {};
  // Заполняем кэш транскрибаций из ai_cache (whisper_* ключи) — один раз, не на каждый вызов
  const aiCachePreload = loadAiCache();
  const transcriptionCache = {};
  for (const [k, v] of Object.entries(aiCachePreload)) {
    if (k.startsWith('whisper_')) transcriptionCache[k.replace('whisper_', '')] = v;
  }
  console.log(`  📝 Кэш транскрибаций: ${Object.keys(transcriptionCache).length} записей (из ai_cache)`);
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
          const allowNew = dt.date === reportDate; // Whisper только за день отчёта
          transcription = await transcribeCallIfNeeded({ transcription, files: c.files || [] }, transcriptionCache, allowNew);
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
          const allowNew = dt.date === reportDate;
          transcription = await transcribeCallIfNeeded({ transcription: null, files: cFiles }, transcriptionCache, allowNew);
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

  // === Загрузка комментариев для всех активных сделок из API ===
  const commentJobs = [];
  const subtaskIdsForComments = new Set();
  for (const t of activeTasks) {
    if (!(t.parent && t.parent.id)) { // только родительские
      commentJobs.push({ taskId: t.id, parentId: t.id });
      for (const stId of (parentToSubtasks[t.id] || [])) {
        commentJobs.push({ taskId: stId, parentId: t.id });
        subtaskIdsForComments.add(stId);
      }
    }
  }
  const totalToLoad = commentJobs.length;
  console.log(`  💬 Загрузка из API: ${totalToLoad} задач (${dealTasks.length} сделок + подзадачи)...`);

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
  if (totalToLoad > 0) console.log(`\r    [${totalToLoad}/${totalToLoad}]`);
  if (whisperCount) console.log(`  🎤 Whisper транскрибировал: ${whisperCount} звонков`);

  // === Звонки из контактов (контрагентов) ===
  // Только для активных сделок за reportDate
  const contactToTasks = {}; // contactId -> [taskId, ...]
  let skippedNoId = 0;
  for (const t of dealTasks) {
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
        const allowNew = dt.date === reportDate; // Whisper только за день отчёта
        transcription = await transcribeCallIfNeeded({ transcription, files: c.files || [] }, transcriptionCache, allowNew);
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
        for (const t of dealTasks) taskMap[t.id] = t;
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

  // === Сохраняем комментарии и звонки контактов в историю ===
  for (const [taskId, comments] of Object.entries(commentsByTask)) {
    const deal = ensureDeal(history, taskId);
    deal.comments = comments;
    deal.commentsLoaded = true; // маркер: комментарии загружены (даже если 0)
  }
  for (const [taskId, calls] of Object.entries(contactCallsByTask)) {
    const deal = ensureDeal(history, taskId);
    deal.contactCalls = calls;
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
    totalActive: lightTasks ? lightTasks.length : activeTasks.length,
  };

  for (const card of dealCards) {
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

  // === ИИ-оценка ТОЛЬКО за день отчёта (reportDate) ===
  const aiCache = loadAiCache(); // только day_*, mgr_*, sent_* — НЕ оценки сделок
  const multiDayActivity = {}; // { "DD-MM-YYYY": [ dealActivity, ... ] }
  const multiDaySummary = {};  // { "DD-MM-YYYY": "summary text" }

  // --- reportDate: полная обработка из API ---
  const reportDayDeals = buildDayActivityServer(reportDMY);
  console.log(`  🤖 День отчёта ${reportDMY}: ${reportDayDeals.length} сделок`);

  if (reportDayDeals.length && (DEEPSEEK_KEY || POLZA_KEY)) {
    const isSnow = n => (n || '').toLowerCase().startsWith('вывоз снега');
    const cached = reportDayDeals.filter(da => {
      const dh = history.deals[String(da.deal.id)];
      const key = `assess_${da.deal.id}_${reportDMY}_${isSnow(da.deal.name) ? 'v20' : 'v20a'}`;
      return dh && dh.assessments && dh.assessments[key];
    }).length;
    const needAi = reportDayDeals.length - cached;
    if (needAi > 0) {
      console.log(`  🤖 ИИ-оценка ${reportDayDeals.length} сделок за ${reportDMY} (${cached} из истории)...`);
    } else {
      process.stdout.write(`  🤖 ${reportDMY}: ${reportDayDeals.length} сделок (история) `);
    }
    let aiIdx = 0;
    await parallelMap(reportDayDeals, async (da) => {
      if (!isTimeUp()) da.aiAssessment = await aiDealFullAssessment(da, reportDMY, history, true);
      aiIdx++;
      if (needAi > 0) process.stdout.write(`\r    [${aiIdx}/${reportDayDeals.length}]`);
    }, CONCURRENCY);
    if (needAi > 0) console.log('\n    ✅');
    else console.log('✅');

    multiDaySummary[reportDMY] = await aiDaySummary(reportDayDeals, reportDMY, aiCache, mgrAlias, true);
    saveHistory(history, reportDMY);
  }

  multiDayActivity[reportDMY] = reportDayDeals.map(da => ({
    deal: da.deal, isNew: da.isNew, actions: da.actions,
    dayCalls: da.dayCalls, planfixScript: da.planfixScript,
    scriptHistory: da.scriptHistory, aiAssessment: da.aiAssessment,
  }));

  // --- Прошлые дни: из deal_history.json (не из API) ---
  // Собираем уникальные даты из истории за последние 30 дней
  const dealTasksMap = {};
  for (const t of dealTasks) dealTasksMap[t.id] = t;

  const historyDatesSet = new Set();
  for (const [, dealHist] of Object.entries(history.deals)) {
    for (const c of (dealHist.comments || [])) {
      if (!c.date || c.date === reportDMY) continue;
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
    const dayDeals = buildDayFromHistory(history, dayDMY, dealTasksMap, mgrPfName);
    if (!dayDeals.length) continue;
    multiDayActivity[dayDMY] = dayDeals;
    // Итог дня из кэша (или генерируем если нет)
    if (DEEPSEEK_KEY || POLZA_KEY) {
      multiDaySummary[dayDMY] = await aiDaySummary(dayDeals, dayDMY, aiCache, mgrAlias);
    }
  }

  // === Входящие обращения по дням (не от менеджера, не от роботов) ===
  // Из dealCards (reportDate) + из истории (прошлые дни)
  const incomingByDate = {};

  // Хелпер: добавить входящие из массива комментариев
  function addIncoming(dealId, dealName, dealStatus, dealCounterparty, dealSum, comments) {
    for (const c of comments) {
      if (!c.owner || c.owner.includes(mgrPfName) || c.owner.toLowerCase().includes('robot')) continue;
      if ((c.text||'').includes('целевое действие') || (c.text||'').includes('Статус изменён')) continue;
      if (!incomingByDate[c.date]) incomingByDate[c.date] = [];
      const existing = incomingByDate[c.date].find(d => d.id === dealId);
      if (existing) {
        existing.actions.push({ type: c.type, text: (c.text||'').substring(0, 100), time: c.time, owner: c.owner });
      } else {
        incomingByDate[c.date].push({
          id: dealId, name: dealName, status: dealStatus,
          counterparty: dealCounterparty, dealSum: dealSum || 0,
          actions: [{ type: c.type, text: (c.text||'').substring(0, 100), time: c.time, owner: c.owner }],
        });
      }
    }
  }

  // Из dealCards (reportDate — загружены из API)
  for (const card of dealCards) {
    if (!card.isActive) continue;
    addIncoming(card.id, card.name, card.status, card.counterparty, card.dealSum, card.comments);
  }
  // Из истории (прошлые дни, до 30)
  for (const [dealId, dealHist] of Object.entries(history.deals)) {
    const pastComments = (dealHist.comments || []).filter(c => c.date && c.date !== reportDMY);
    if (!pastComments.length) continue;
    const task = dealTasksMap[Number(dealId)];
    const name = task?.name || dealHist.name || '?';
    const status = task?.status?.name || dealHist.status || '?';
    const cp = task?.counterparty?.name || dealHist.counterparty || '—';
    const cf = {};
    if (task) for (const c of (task.customFieldData || [])) cf[c.field.id] = { value: c.value };
    const sum = task ? (parseFloat(cf[67906]?.value || 0) || 0) : 0;
    addIncoming(Number(dealId), name, status, cp, sum, pastComments);
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

  // === Снимки воронки (lightTasks для полного снимка, dealCards как fallback) ===
  const prevSnapshot = loadPreviousSnapshot(snapshotFile);
  const activeCardIds = new Set(dealCards.map(d => d.id));
  const funnelCards = lightTasks
    ? [
        ...dealCards,
        ...lightTasks
          .filter(t => !activeCardIds.has(t.id) && !(t.parent && t.parent.id))
          .filter(t => {
            const tplName = t.template && t.template.name ? t.template.name : '';
            if (!tplName) return true;
            return ALLOWED_TEMPLATES.some(at => tplName.toLowerCase().includes(at.toLowerCase()));
          })
          .map(t => ({
            id: t.id, name: t.name, status: t.status?.name || '?',
            counterparty: t.counterparty?.name || '—',
          })),
      ]
    : dealCards;
  const funnelChanges = computeFunnelChanges(prevSnapshot, funnelCards);
  const currentSnapshot = saveSnapshot(funnelCards, snapshotFile);

  console.log(`  📊 Дневная активность: ${dailyActivity.newDeals.length} новых, ${dailyActivity.workedDeals.length} обработано`);
  console.log(`  🔄 Изменения воронки: ${funnelChanges.length}`);
  console.log(`  📝 Скрипт новых: ${scriptCompliance.total} анализов`);

  const allCalls = dealCards.flatMap(d => d.calls);
  const allAnalyses = dealCards.flatMap(d => d.analyses);

  // === Итоги для руководителя (день / неделя / месяц) ===
  const managerSummaries = { day: null, week: null, month: null };
  if (DEEPSEEK_KEY || POLZA_KEY) {
    console.log(`\n👔 Генерация отчёта для руководителя...`);
    managerSummaries.day = await aiManagerSummary(multiDayActivity, multiDaySummary, dealCards, funnelChanges, 1, reportDMY, aiCache, mgrAlias, true);
    if (managerSummaries.day) process.stdout.write('  ✅ День ');
    managerSummaries.week = await aiManagerSummary(multiDayActivity, multiDaySummary, dealCards, funnelChanges, 7, reportDMY, aiCache, mgrAlias, true);
    if (managerSummaries.week) process.stdout.write('✅ Неделя ');
    managerSummaries.month = await aiManagerSummary(multiDayActivity, multiDaySummary, dealCards, funnelChanges, 30, reportDMY, aiCache, mgrAlias, true);
    if (managerSummaries.month) console.log('✅ Месяц');
    saveAiCache(aiCache);
  }

  // === Сохраняем историю сделок ===
  saveHistory(history, reportDMY);

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
