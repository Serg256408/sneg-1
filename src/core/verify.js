// ============================================================
// verify.js — Верификатор отчёта: сверка данных с Planfix API
// ============================================================
// Независимо проверяет: все ли сделки, звонки, комментарии,
// подзадачи, контрагенты попали в отчёт. Отправляет результат в Telegram.

const { fs, path, ROOT_DIR, MANAGERS, MANAGERS_LIST, ALLOWED_TEMPLATES, SKIP_STATUSES } = require('../utils/config');
const {
  sleep, stripHtml, utcToMsk, timeToMinNode, normalizePhone,
} = require('../utils/helpers');
const { pf } = require('../api/planfix');
const { isMangoConfigured, loadMangoCallsForDate } = require('../api/mango');
const { loadAiCache } = require('./cache');
const { getManagerDeals, getDealComments, parseComment } = require('./deals');
const { extractTranscription, hasCallRecordingFile } = require('./transcription');
const { sendTelegramMessage, isTelegramConfigured } = require('../api/telegram');

const TELEGRAM_DISABLED = process.argv.includes('--no-telegram') ||
  /^(1|true|yes|on)$/i.test(String(process.env.REPORT_VERIFY_NO_TELEGRAM || '').trim());

// ============ Утилиты ============

function todayDMY() {
  const d = new Date(); d.setHours(d.getHours() + 3); // MSK
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

function loadReportData(alias) {
  const file = path.join(ROOT_DIR, 'data', `${alias}_latest.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function checkReportDataFreshness(reportData, reportDate) {
  const actualDate = String(reportData?.reportDate || '').trim();
  const status = actualDate === reportDate ? 'pass' : 'fail';
  return {
    name: 'dataFreshness',
    status,
    expectedDate: reportDate,
    actualDate,
    generated: reportData?.generated || '',
  };
}

function isCallType(type) {
  return type === 'outCall' || type === 'inCall' || type === 'ndz';
}

function isAiGeneratedComment(desc) {
  const t = String(desc || '').toLowerCase();
  return t.includes('ии-оценка сделки') ||
    t.includes('🤖 ии-оценка') ||
    t.includes('ии-рекомендаци') ||
    t.includes('ai-рекомендаци') ||
    t.includes('рекомендации ии') ||
    t.includes('баллы зп:');
}

// ============ Проверка 1: Полнота сделок ============

async function loadTaskBriefForVerification(taskId) {
  try {
    const d = await pf('/task/list', {
      offset: 0,
      pageSize: 1,
      filters: [{ type: 57, operator: 'equal', value: Number(taskId) }],
      fields: 'id,name,parent,status,template',
    });
    return (d.tasks || [])[0] || null;
  } catch {
    return null;
  }
}

function isReportableDealTask(task) {
  if (!task) return false;
  if (task.parent?.id) return false;
  if (SKIP_STATUSES.includes(task.status?.name || '')) return false;
  const tplName = task.template?.name || '';
  if (!tplName) return true;
  return ALLOWED_TEMPLATES.some(at => tplName.toLowerCase().includes(at.toLowerCase()));
}

async function checkDealCompleteness(userId, reportDate, reportData) {
  console.log('  🔍 Проверка 1: Полнота сделок...');
  const rawPfDealIds = await getManagerDeals(userId, reportDate);

  const reportDealIds = (reportData.dailyDealActivity || [])
    .filter(d => !d.isUnlinkedCalls)
    .map(d => d.deal?.id)
    .filter(Boolean);
  const reportSet = new Set(reportDealIds);
  const rawMissingFromReport = rawPfDealIds.filter(id => !reportSet.has(id));
  const unloadableFromPlanfix = [];
  const nonReportableFromPlanfix = [];
  const missingFromReport = [];

  for (const id of rawMissingFromReport) {
    const task = await loadTaskBriefForVerification(id);
    if (!task) {
      unloadableFromPlanfix.push(id);
    } else if (!isReportableDealTask(task)) {
      nonReportableFromPlanfix.push({
        id,
        name: task.name || '',
        status: task.status?.name || '',
        template: task.template?.name || '',
        parentId: task.parent?.id || null,
      });
    } else {
      missingFromReport.push(id);
    }
  }

  const pfDealIds = rawPfDealIds.filter(id =>
    !unloadableFromPlanfix.includes(id) &&
    !nonReportableFromPlanfix.some(item => item.id === id)
  );
  const pfSet = new Set(pfDealIds);
  const extraInReport = reportDealIds.filter(id => !pfSet.has(id));

  let status = missingFromReport.length === 0
    ? (extraInReport.length > 0 || unloadableFromPlanfix.length > 0 || nonReportableFromPlanfix.length > 0 ? 'warn' : 'pass')
    : 'fail';
  let reason = '';
  if (rawPfDealIds.length === 0 && reportDealIds.length > 0) {
    status = 'fail';
    reason = 'planfix-empty-report-has-data';
  }
  return {
    name: 'dealCompleteness',
    status,
    planfixCount: pfDealIds.length,
    rawPlanfixCount: rawPfDealIds.length,
    reportCount: reportDealIds.length,
    missingFromReport,
    unloadableFromPlanfix,
    nonReportableFromPlanfix,
    extraInReport,
    reason,
  };
}

// ============ Проверка 2: Полнота комментариев и звонков ============

async function getSubtaskIds(taskId) {
  const ids = [];
  let offset = 0;
  while (true) {
    let d;
    try {
      d = await pf('/task/list', { offset, pageSize: 100, filters: [{ type: 58, operator: 'equal', value: taskId }], fields: 'id,name,parent' });
    } catch { break; }
    const tasks = d.tasks || [];
    for (const t of tasks) ids.push(t.id);
    if (tasks.length < 100) break;
    offset += 100;
    await sleep(300);
  }
  return ids;
}

function classifyComment(c) {
  const desc = stripHtml(c.description || '');
  const descLow = desc.toLowerCase();
  let type = 'note';
  if (!isAiGeneratedComment(desc)) {
    if (descLow.startsWith('исходящий звонок')) type = 'outCall';
    else if (descLow.startsWith('входящий звонок')) type = 'inCall';
    else if (descLow.startsWith('ндз')) type = 'ndz';
    else if (descLow.includes('входящий звонок') || descLow.includes('исходящий звонок')) {
      type = descLow.includes('исходящий звонок') ? 'outCall' : 'inCall';
    }
  }
  if (type === 'note' && !isAiGeneratedComment(desc)) {
    const hasTranscription = desc.includes('----------') && (/[🔴🔵●]/.test(desc) || /A:.*B:/s.test(desc));
    const hasRecording = (c.files || []).some(f => (f.name || '').toLowerCase().includes('запись звонка'));
    if (hasTranscription || hasRecording) type = 'inCall';
  }
  const dt = utcToMsk(c.dateTime?.date, c.dateTime?.time);
  const transcription = extractTranscription(c.description || '');
  const hasAudioFile = hasCallRecordingFile(c.files || []);
  return { id: c.id, date: dt.date, time: dt.time, type, owner: c.owner?.name || '', transcription, hasAudioFile };
}

async function checkDealCallsCompleteness(reportData) {
  console.log('  🔍 Проверка 2: Полнота комментариев и звонков...');
  const dealResults = [];
  const dailyDeals = (reportData.dailyDealActivity || []).filter(item => !item.isUnlinkedCalls);
  const reportDate = reportData.reportDate || '';

  for (const item of dailyDeals) {
    const dealId = item.deal?.id;
    const dealName = item.deal?.name || '';
    if (!dealId) continue;

    // 1. Загружаем комментарии сделки из Planfix
    const rawDealComments = await getDealComments(dealId);
    const pfDealParsed = rawDealComments.map(classifyComment);
    const pfDealCalls = pfDealParsed.filter(c => isCallType(c.type));

    // 2. Загружаем комментарии подзадач
    const subtaskIds = await getSubtaskIds(dealId);
    let pfSubtaskCalls = [];
    for (const stId of subtaskIds) {
      const rawSt = await getDealComments(stId);
      const parsed = rawSt.map(classifyComment);
      pfSubtaskCalls.push(...parsed.filter(c => isCallType(c.type)));
      await sleep(200);
    }

    // 3. Загружаем комментарии контрагента
    let pfContactCalls = [];
    const dealCard = (reportData.dealCards || []).find(dc => dc.id === dealId);
    const cpId = dealCard?.counterpartyId || '';
    if (cpId) {
      try {
        const rawContact = [];
        let offset = 0;
        while (true) {
          const d = await pf(`/contact/${cpId}/comments/list`, { offset, pageSize: 100, fields: 'id,description,dateTime,owner,files' });
          rawContact.push(...(d.comments || []));
          if ((d.comments || []).length < 100) break;
          offset += 100;
        }
        pfContactCalls = rawContact.map(classifyComment).filter(c => isCallType(c.type));
      } catch {}
    }

    // 4. Собираем ВСЕ звонки из Planfix (с дедупликацией)
    const allPfCalls = [...pfDealCalls].filter(call => !reportDate || call.date === reportDate);
    for (const call of [...pfSubtaskCalls, ...pfContactCalls]) {
      if (reportDate && call.date !== reportDate) continue;
      const isDupe = allPfCalls.some(e =>
        isCallType(e.type) && e.date === call.date && Math.abs(timeToMinNode(e.time) - timeToMinNode(call.time)) < 5,
      );
      if (!isDupe) allPfCalls.push(call);
    }

    // 5. Считаем звонки в отчёте
    const reportComments = item.allComments || dealCard?.comments || [];
    const reportCalls = reportComments.filter(c => isCallType(c.type) && (!reportDate || c.date === reportDate));

    // 6. Находим пропущенные
    const missingCalls = [];
    for (const pfCall of allPfCalls) {
      const found = reportCalls.some(rc =>
        rc.date === pfCall.date && Math.abs(timeToMinNode(rc.time) - timeToMinNode(pfCall.time)) < 5,
      );
      if (!found) {
        const source = pfDealCalls.includes(pfCall) ? 'deal' : pfSubtaskCalls.includes(pfCall) ? 'subtask' : 'contact';
        missingCalls.push({ date: pfCall.date, time: pfCall.time, type: pfCall.type, source });
      }
    }

    // 7. Нетранскрибированные звонки
    const untranscribed = allPfCalls.filter(c =>
      (c.type === 'outCall' || c.type === 'inCall') && !c.transcription && c.hasAudioFile,
    );

    dealResults.push({
      dealId, dealName,
      planfix: {
        comments: pfDealParsed.length,
        calls: pfDealCalls.filter(c => !reportDate || c.date === reportDate).length,
        subtaskCalls: pfSubtaskCalls.filter(c => !reportDate || c.date === reportDate).length,
        contactCalls: pfContactCalls.filter(c => !reportDate || c.date === reportDate).length,
      },
      report: { comments: reportComments.length, calls: reportCalls.length },
      totalPfCalls: allPfCalls.length,
      missingCalls,
      untranscribedCalls: untranscribed.map(c => ({ date: c.date, time: c.time, hasAudioFile: c.hasAudioFile })),
    });

    await sleep(300);
  }

  const totalMissing = dealResults.reduce((s, d) => s + d.missingCalls.length, 0);
  const status = totalMissing === 0 ? 'pass' : 'fail';
  return { name: 'callCompleteness', status, dealResults, totalMissing };
}

// ============ Проверка 3: Транскрибации ============

const TRANSCRIPTION_COVER_WINDOW_MIN = 7;
const TRANSCRIPTION_REASON_LABELS = {
  noAudioFile: 'нет аудиофайла',
  noPlanfixFileMangoNoRecord: 'нет файла Planfix и записи в Mango',
  noPlanfixFileMangoNotFound: 'нет файла Planfix, Mango не нашёл звонок',
  planfixFileMangoNoRecord: 'файл Planfix есть, в Mango записи нет',
  planfixFileMangoNotFound: 'файл Planfix есть, Mango не нашёл звонок',
  mangoRecordNotAttached: 'запись Mango есть, но не прикрепилась',
  planfixFileNoText: 'файл есть, текст не получен',
  unknown: 'причина не определена',
};

function isReportCallAction(action) {
  return action && (action.type === 'outCall' || action.type === 'inCall');
}

function hasReportTranscription(action) {
  return String(action?.transcription || '').trim().length > 0;
}

function actionTimeMinutes(action) {
  const times = String(action?.time || '').match(/\d{1,2}:\d{2}/g) || [];
  const minutes = times.map(timeToMinNode).filter(Number.isFinite);
  if (minutes.length) return minutes;
  return [timeToMinNode(action?.time)].filter(Number.isFinite);
}

function actionTimeDiff(a, b) {
  const left = actionTimeMinutes(a);
  const right = actionTimeMinutes(b);
  if (!left.length || !right.length) return Infinity;
  let best = Infinity;
  for (const l of left) {
    for (const r of right) best = Math.min(best, Math.abs(l - r));
  }
  return best;
}

function findCoveredTranscription(actions, action) {
  return (actions || []).find(other =>
    other !== action &&
    isReportCallAction(other) &&
    hasReportTranscription(other) &&
    actionTimeDiff(other, action) <= TRANSCRIPTION_COVER_WINDOW_MIN);
}

function addTranscriptionReason(reasons, reasonKey) {
  const key = reasonKey || 'unknown';
  reasons[key] = (reasons[key] || 0) + 1;
}

function formatTranscriptionReasons(reasons) {
  return Object.entries(reasons || {})
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${TRANSCRIPTION_REASON_LABELS[key] || key}`)
    .join(', ');
}

function extractPhonesFromText(text) {
  const phones = new Set();
  const matches = String(text || '').matchAll(/(?:\+?7|8)?[\s\-()]*(?:\d[\s\-()]*){10,}/g);
  for (const match of matches) {
    const phone = normalizePhone(match[0]);
    if (phone && phone.length >= 10) phones.add(phone);
  }
  return [...phones];
}

function actionPhones(item, action) {
  const phones = new Set();

  for (const file of (action.files || [])) {
    extractPhonesFromText(file.name || file.fileName || '').forEach(phone => phones.add(phone));
  }
  extractPhonesFromText(`${action.text || ''} ${item.deal?.name || ''}`).forEach(phone => phones.add(phone));

  const relatedCalls = (item.allCalls || [])
    .map(call => ({ call, diff: actionTimeDiff({ time: call.time }, action) }))
    .filter(row => row.diff <= TRANSCRIPTION_COVER_WINDOW_MIN)
    .sort((a, b) => a.diff - b.diff || (b.call.duration || 0) - (a.call.duration || 0));

  for (const { call } of relatedCalls) {
    const phone = normalizePhone(call.phone || '');
    if (phone) phones.add(phone);
  }

  return [...phones];
}

function mangoCallMatchesPhones(call, phones) {
  const wanted = new Set((phones || []).map(normalizePhone).filter(Boolean));
  if (!wanted.size) return false;
  return wanted.has(call.fromNumber) || wanted.has(call.toNumber) || wanted.has(call.lineNumber);
}

function findMangoCallForAction(mangoCalls, phones, action) {
  return (mangoCalls || [])
    .filter(call => mangoCallMatchesPhones(call, phones))
    .map(call => ({ call, diff: actionTimeDiff({ time: call.time }, action) }))
    .filter(row => row.diff <= TRANSCRIPTION_COVER_WINDOW_MIN)
    .sort((a, b) => a.diff - b.diff || (b.call.duration || 0) - (a.call.duration || 0))[0]?.call || null;
}

function classifyUntranscribedAction(item, action, mangoCalls, mangoEnabled) {
  const hasPlanfixAudio = hasCallRecordingFile(action.files || []);
  if (!mangoEnabled) return hasPlanfixAudio ? 'planfixFileNoText' : 'noAudioFile';

  const phones = actionPhones(item, action);
  const mangoCall = phones.length ? findMangoCallForAction(mangoCalls, phones, action) : null;
  const hasMangoRecord = !!mangoCall?.recordingIds?.length;

  if (hasMangoRecord) return 'mangoRecordNotAttached';
  if (hasPlanfixAudio && mangoCall) return 'planfixFileMangoNoRecord';
  if (!hasPlanfixAudio && mangoCall) return 'noPlanfixFileMangoNoRecord';
  if (hasPlanfixAudio && phones.length) return 'planfixFileMangoNotFound';
  if (!hasPlanfixAudio && phones.length) return 'noPlanfixFileMangoNotFound';
  return hasPlanfixAudio ? 'planfixFileNoText' : 'noAudioFile';
}

async function checkTranscriptions(reportData, aiCache) {
  console.log('  🔍 Проверка 3: Транскрибации...');
  const dailyDeals = (reportData.dailyDealActivity || []).filter(item => !item.isUnlinkedCalls);
  let totalCalls = 0, transcribed = 0, ndz = 0, coveredByTranscription = 0, untranscribed = 0;
  const untranscribedList = [];
  const coveredList = [];
  const untranscribedReasons = {};
  const mangoEnabled = isMangoConfigured();
  let mangoCalls = null;

  async function getMangoCalls() {
    if (!mangoEnabled) return [];
    if (!mangoCalls) mangoCalls = await loadMangoCallsForDate(reportData.reportDate || '');
    return mangoCalls;
  }

  for (const item of dailyDeals) {
    const actions = item.actions || [];
    for (const a of actions) {
      if (a.type === 'ndz') { ndz++; totalCalls++; continue; }
      if (!isReportCallAction(a)) continue;
      totalCalls++;
      if (hasReportTranscription(a)) { transcribed++; continue; }

      const coveredBy = findCoveredTranscription(actions, a);
      if (coveredBy) {
        coveredByTranscription++;
        coveredList.push({
          dealId: item.deal?.id,
          dealName: item.deal?.name,
          date: a.date,
          time: a.time,
          coveredByTime: coveredBy.time,
        });
        continue;
      }

      untranscribed++;
      const calls = await getMangoCalls();
      const reason = classifyUntranscribedAction(item, a, calls, mangoEnabled);
      addTranscriptionReason(untranscribedReasons, reason);
      untranscribedList.push({
        dealId: item.deal?.id,
        dealName: item.deal?.name,
        date: a.date,
        time: a.time,
        reason,
        reasonLabel: TRANSCRIPTION_REASON_LABELS[reason] || reason,
      });
    }
  }

  const status = untranscribed === 0 ? 'pass' : untranscribed <= Math.ceil(totalCalls * 0.2) ? 'warn' : 'fail';
  return {
    name: 'transcriptions',
    status,
    totalCalls,
    transcribed,
    ndz,
    coveredByTranscription,
    untranscribed,
    untranscribedReasons,
    untranscribedReasonText: formatTranscriptionReasons(untranscribedReasons),
    untranscribedList,
    coveredList,
  };
}

// ============ Проверка 4: ИИ-оценки ============

function checkAiAssessments(reportData) {
  console.log('  🔍 Проверка 4: ИИ-оценки...');
  const dailyDeals = (reportData.dailyDealActivity || []).filter(item => !item.isUnlinkedCalls);
  const missing = [];
  const invalid = [];
  let assessed = 0;

  for (const item of dailyDeals) {
    const a = item.aiAssessment;
    if (!a) { missing.push({ dealId: item.deal?.id, dealName: item.deal?.name }); continue; }
    if (!a.overallVerdict || !a.salaryScore) {
      invalid.push({ dealId: item.deal?.id, dealName: item.deal?.name, reason: !a.overallVerdict ? 'нет вердикта' : 'нет баллов' });
      continue;
    }
    assessed++;
  }

  const status = missing.length === 0 && invalid.length === 0 ? 'pass' : missing.length > 0 ? 'fail' : 'warn';
  return { name: 'aiAssessments', status, total: dailyDeals.length, assessed, missing, invalid };
}

// ============ Проверка 5: Автоотправка ============

function reportDateToIso(reportDate) {
  const m = String(reportDate || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function checkAutoSend(reportData, aiCache, reportDate) {
  console.log('  🔍 Проверка 5: Автоотправка в Planfix...');
  const dailyDeals = (reportData.dailyDealActivity || []).filter(item => !item.isUnlinkedCalls);
  const shouldSendDeals = dailyDeals.filter(d => d.aiAssessment?.missing?.length > 0);
  const notSent = [];
  let sentCount = 0;

  for (const item of shouldSendDeals) {
    const key = `sent_${item.deal?.id}_${reportDate}`;
    if (aiCache[key]) { sentCount++; } else {
      notSent.push({ dealId: item.deal?.id, dealName: item.deal?.name });
    }
  }

  const alias = reportData.managerAlias || '';
  const mgrKey = `sent_manager_${alias}_${reportDate}`;
  const managerSummaryAvailable = !!(reportData.aiDaySummaryText || reportData.managerSummaries?.day);
  const reportTaskDate = reportDateToIso(reportDate);
  const managerSummaryTarget = (reportData.dailyReports || []).find(r => r.date === reportTaskDate);
  const shouldSendManager = managerSummaryAvailable && !!managerSummaryTarget;
  const managerSummarySkippedNoTask = managerSummaryAvailable && !managerSummaryTarget;
  const managerSummarySent = !!aiCache[mgrKey];

  const status = notSent.length === 0 && (!shouldSendManager || managerSummarySent) ? 'pass' : 'fail';
  return {
    name: 'autoSend',
    status,
    shouldSend: shouldSendDeals.length,
    sent: sentCount,
    notSent,
    shouldSendManager,
    managerSummarySent,
    managerSummarySkippedNoTask,
  };
}

// ============ Проверка 6: HTML-файлы ============

function checkHtmlFiles(alias, reportDate) {
  console.log('  🔍 Проверка 6: HTML-файлы...');
  const files = [
    { path: `reports/${alias}.html`, label: 'Отчёт' },
    { path: `deploy/${alias}/index.html`, label: 'Deploy' },
    { path: `data/${alias}_latest.json`, label: 'Данные' },
  ];

  const results = [];
  for (const f of files) {
    const fullPath = path.join(ROOT_DIR, f.path);
    const exists = fs.existsSync(fullPath);
    let sizeKb = 0, valid = false;
    if (exists) {
      const stat = fs.statSync(fullPath);
      sizeKb = Math.round(stat.size / 1024);
      if (f.path.endsWith('.html')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        valid = sizeKb > 10 && (content.includes('const D=') || content.includes('var D='));
      } else if (f.path.endsWith('.json')) {
        try {
          const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          valid = data.reportDate === reportDate;
        } catch { valid = false; }
      }
    }
    results.push({ path: f.path, label: f.label, exists, sizeKb, valid });
  }

  const allOk = results.every(r => r.exists && r.valid);
  return { name: 'htmlFiles', status: allOk ? 'pass' : 'fail', files: results };
}

// ============ Форматирование для Telegram ============

function statusIcon(s) { return s === 'pass' ? '✅' : s === 'warn' ? '⚠️' : '❌'; }

function normalizeCallType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'outcall' || t.includes('исход')) return 'out';
  if (t === 'incall' || t.includes('вход')) return 'in';
  return 'other';
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}ч ${String(mins).padStart(2, '0')}м`;
  }
  return `${minutes}м ${String(rest).padStart(2, '0')}с`;
}

function idSet(items, pickId) {
  const ids = new Set();
  for (const item of items || []) {
    const id = pickId(item);
    if (id) ids.add(String(id));
  }
  return ids;
}

function getReportDayDeals(reportData, reportDate) {
  const fromMultiDay = reportData.multiDayActivity?.[reportDate];
  if (Array.isArray(fromMultiDay) && fromMultiDay.length) return fromMultiDay;
  if (reportData.reportDate === reportDate && Array.isArray(reportData.dailyDealActivity)) return reportData.dailyDealActivity;
  return [];
}

function addActionCallStats(calls, action) {
  const seconds = Number(action.duration || action.seconds || 0) || 0;
  calls.totalSeconds += seconds;
  if (action.type === 'outCall') {
    calls.outCount += 1;
    calls.outSeconds += seconds;
  } else if (action.type === 'inCall') {
    calls.inCount += 1;
    calls.inSeconds += seconds;
  } else if (action.type === 'ndz') {
    calls.otherCount += 1;
  }
}

function buildProductivitySummary(reportData, reportDate) {
  if (!reportData) return null;

  const calls = { outCount: 0, inCount: 0, otherCount: 0, outSeconds: 0, inSeconds: 0, totalSeconds: 0 };
  for (const card of (reportData.dealCards || [])) {
    for (const call of (card.calls || [])) {
      if (call.date && call.date !== reportDate) continue;
      const seconds = Number(call.duration || 0) || 0;
      const type = normalizeCallType(call.type);
      calls.totalSeconds += seconds;
      if (type === 'out') {
        calls.outCount += 1;
        calls.outSeconds += seconds;
      } else if (type === 'in') {
        calls.inCount += 1;
        calls.inSeconds += seconds;
      } else {
        calls.otherCount += 1;
      }
    }
  }

  const todayDeals = getReportDayDeals(reportData, reportDate);
  if (!calls.outCount && !calls.inCount && todayDeals.length) {
    for (const dayDeal of todayDeals) {
      for (const action of (dayDeal.actions || [])) {
        addActionCallStats(calls, action);
      }
    }
  }

  const daily = reportData.dailyActivity || {};
  let newIds = idSet(daily.newDeals, d => d.id);
  let workedIds = idSet([...(daily.newDeals || []), ...(daily.workedDeals || [])], d => d.id);
  let newDeals = newIds.size;
  let workedDeals = workedIds.size;
  let oldDeals = [...workedIds].filter(id => !newIds.has(id)).length;

  if (!workedDeals && todayDeals.length) {
    newIds = idSet(todayDeals.filter(d => d.isNew), d => d.deal?.id);
    workedIds = idSet(todayDeals, d => d.deal?.id);
    newDeals = newIds.size;
    workedDeals = workedIds.size;
    oldDeals = [...workedIds].filter(id => !newIds.has(id)).length;
  }

  if (!workedDeals && (reportData.dailyDealActivity || []).length) {
    newIds = idSet((reportData.dailyDealActivity || []).filter(d => d.isNew), d => d.deal?.id);
    workedIds = idSet(reportData.dailyDealActivity, d => d.deal?.id);
    newDeals = newIds.size;
    workedDeals = workedIds.size;
    oldDeals = [...workedIds].filter(id => !newIds.has(id)).length;
  }

  const movement = { total: 0, forward: 0, backward: 0, unknown: 0 };
  for (const change of (reportData.funnelChanges || [])) {
    movement.total += 1;
    if (change.direction === 'forward') movement.forward += 1;
    else if (change.direction === 'backward') movement.backward += 1;
    else movement.unknown += 1;
  }

  return { calls, workedDeals, newDeals, oldDeals, movement };
}

function formatProductivityBlock(reportData, reportDate) {
  const p = buildProductivitySummary(reportData, reportDate);
  if (!p) return [];

  const lines = ['<b>Результативность за день</b>'];
  lines.push(`Сделки: обработано ${p.workedDeals}, новые ${p.newDeals}, старые ${p.oldDeals}`);
  lines.push(`Звонки: исходящие ${p.calls.outCount} (${formatDuration(p.calls.outSeconds)}), входящие ${p.calls.inCount} (${formatDuration(p.calls.inSeconds)})`);
  if (p.calls.otherCount > 0) lines.push(`НДЗ/прочие звонки: ${p.calls.otherCount}`);
  lines.push(`Время разговоров: ${formatDuration(p.calls.totalSeconds)}`);
  lines.push(`Продвижение сделок: ${p.movement.total} изменений, вперёд ${p.movement.forward}, назад ${p.movement.backward}, прочее ${p.movement.unknown}`);
  return lines;
}

function checkByName(checks, name) {
  return (checks || []).find(c => c.name === name) || null;
}

function overallStatus(checks) {
  if ((checks || []).some(c => c.status === 'fail')) return 'fail';
  if ((checks || []).some(c => c.status === 'warn')) return 'warn';
  if ((checks || []).some(c => c.status === 'pending')) return 'pending';
  return 'pass';
}

function statusWord(status) {
  const map = {
    pass: 'OK',
    warn: 'WARN',
    fail: 'FAIL',
    skip: 'OFF',
    pending: 'WAIT',
  };
  return map[status] || String(status || 'WAIT').toUpperCase();
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function charLength(value) {
  return [...String(value ?? '')].length;
}

function truncateCell(value, max = 42) {
  const text = String(value ?? '-');
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 3)).join('')}...`;
}

function padCell(value, width) {
  const text = String(value ?? '-');
  return `${text}${' '.repeat(Math.max(0, width - charLength(text)))}`;
}

function sumCallCheck(callCheck, pick) {
  return (callCheck?.dealResults || []).reduce((sum, row) => sum + (Number(pick(row)) || 0), 0);
}

function countBrokenHtmlFiles(htmlCheck) {
  return (htmlCheck?.files || []).filter(f => !f.exists || !f.valid).length;
}

function buildTelegramControlState(telegramState = {}) {
  if (telegramState.disabled) return { status: 'skip', value: 'отключено', detail: '--no-telegram/env' };
  if (telegramState.configured === false) return { status: 'warn', value: 'нет настроек', detail: 'токен/chat_id не заданы' };
  if (telegramState.checked && telegramState.sent === true) return { status: 'pass', value: 'отправлен', detail: '' };
  if (telegramState.checked && telegramState.sent === false) return { status: 'fail', value: 'ошибка', detail: 'Telegram API не принял сообщение' };
  if (telegramState.configured) return { status: 'pending', value: 'отправка', detail: 'проверяется после отправки' };
  return { status: 'pending', value: 'не проверено', detail: '' };
}

function buildControlSummary(manager, reportDate, checks, reportData = null, telegramState = {}) {
  const freshness = checkByName(checks, 'dataFreshness');
  const deals = checkByName(checks, 'dealCompleteness');
  const calls = checkByName(checks, 'callCompleteness');
  const transcriptions = checkByName(checks, 'transcriptions');
  const ai = checkByName(checks, 'aiAssessments');
  const autoSend = checkByName(checks, 'autoSend');
  const html = checkByName(checks, 'htmlFiles');
  const productivity = freshness?.status === 'fail' ? null : buildProductivitySummary(reportData, reportDate);
  const telegram = buildTelegramControlState(telegramState);

  const planfixCalls = calls ? sumCallCheck(calls, row => row.totalPfCalls) : null;
  const reportCalls = calls ? sumCallCheck(calls, row => row.report?.calls) : null;
  const htmlTotal = html?.files?.length || 0;
  const htmlOk = (html?.files || []).filter(f => f.exists && f.valid).length;
  const aiMissing = (ai?.missing || []).length;
  const aiInvalid = (ai?.invalid || []).length;
  const autoSendManagerMissing = autoSend?.shouldSendManager && !autoSend?.managerSummarySent ? 1 : 0;

  const unresolved = {
    data: freshness?.status === 'fail' ? 1 : 0,
    deals: (deals?.missingFromReport || []).length +
      (deals?.unloadableFromPlanfix || []).length +
      (deals?.reason === 'planfix-empty-report-has-data' ? 1 : 0),
    calls: calls?.totalMissing || 0,
    transcriptions: transcriptions?.untranscribed || 0,
    ai: aiMissing + aiInvalid,
    autoSend: (autoSend?.notSent || []).length + autoSendManagerMissing,
    html: countBrokenHtmlFiles(html),
    telegram: telegram.status === 'fail' ? 1 : 0,
  };
  unresolved.total = Object.values(unresolved).reduce((sum, value) => sum + (Number(value) || 0), 0);

  const rows = [
    {
      key: 'dataFreshness',
      item: 'Дата данных',
      status: freshness?.status || 'pending',
      value: `${freshness?.actualDate || '-'} / ${freshness?.expectedDate || reportDate}`,
      detail: freshness?.generated ? `generated ${freshness.generated}` : '',
    },
    {
      key: 'dealCompleteness',
      item: 'Сделки',
      status: deals?.status || 'pending',
      value: deals ? `${deals.reportCount}/${deals.planfixCount}` : '-',
      detail: deals ? `нет ${deals.missingFromReport.length}, лишн ${deals.extraInReport.length}, недост ${deals.unloadableFromPlanfix.length}` : '',
    },
    {
      key: 'callCompleteness',
      item: 'Звонки',
      status: calls?.status || 'pending',
      value: calls ? `${reportCalls}/${planfixCalls}` : (productivity ? `${productivity.calls.outCount + productivity.calls.inCount + productivity.calls.otherCount}` : '-'),
      detail: calls ? `пропущено ${calls.totalMissing}` : '',
    },
    {
      key: 'transcriptions',
      item: 'Расшифровки',
      status: transcriptions?.status || 'pending',
      value: transcriptions ? `${transcriptions.transcribed}/${transcriptions.totalCalls}` : '-',
      detail: transcriptions ? `НДЗ ${transcriptions.ndz}, покрыто ${transcriptions.coveredByTranscription}, нереш ${transcriptions.untranscribed}` : '',
    },
    {
      key: 'aiAssessments',
      item: 'ИИ-оценки',
      status: ai?.status || 'pending',
      value: ai ? `${ai.assessed}/${ai.total}` : '-',
      detail: ai ? `нет ${aiMissing}, битых ${aiInvalid}` : '',
    },
    {
      key: 'autoSend',
      item: 'Рекомендации',
      status: autoSend?.status || 'pending',
      value: autoSend ? `${autoSend.sent}/${autoSend.shouldSend}` : '-',
      detail: autoSend ? `не ушло ${(autoSend.notSent || []).length}, сводка ${autoSendManagerMissing ? 'нет' : 'ок'}` : '',
    },
    {
      key: 'htmlFiles',
      item: 'HTML/данные',
      status: html?.status || 'pending',
      value: html ? `${htmlOk}/${htmlTotal}` : '-',
      detail: html ? `ошибок ${countBrokenHtmlFiles(html)}` : '',
    },
    {
      key: 'telegram',
      item: 'Telegram',
      status: telegram.status,
      value: telegram.value,
      detail: telegram.detail,
    },
    {
      key: 'unresolved',
      item: 'Нерешено',
      status: unresolved.total === 0 ? 'pass' : 'fail',
      value: String(unresolved.total),
      detail: `data ${unresolved.data}, deals ${unresolved.deals}, calls ${unresolved.calls}, tr ${unresolved.transcriptions}, ai ${unresolved.ai}, send ${unresolved.autoSend}, html ${unresolved.html}`,
    },
  ];

  return {
    managerAlias: reportData?.managerAlias || '',
    managerName: manager?.name || '',
    reportDate,
    generated: reportData?.generated || '',
    checkedAt: new Date().toISOString(),
    overallStatus: overallStatus(checks),
    controlStatus: unresolved.total === 0 ? 'pass' : 'fail',
    rows,
    metrics: {
      deals: deals ? {
        report: deals.reportCount,
        planfix: deals.planfixCount,
        missing: deals.missingFromReport.length,
        extra: deals.extraInReport.length,
        unloadable: deals.unloadableFromPlanfix.length,
      } : null,
      calls: calls ? {
        report: reportCalls,
        planfix: planfixCalls,
        missing: calls.totalMissing,
      } : null,
      transcriptions: transcriptions ? {
        total: transcriptions.totalCalls,
        transcribed: transcriptions.transcribed,
        ndz: transcriptions.ndz,
        coveredByTranscription: transcriptions.coveredByTranscription,
        untranscribed: transcriptions.untranscribed,
        reasons: transcriptions.untranscribedReasons,
      } : null,
      ai: ai ? {
        total: ai.total,
        assessed: ai.assessed,
        missing: aiMissing,
        invalid: aiInvalid,
      } : null,
      autoSend: autoSend ? {
        sent: autoSend.sent,
        shouldSend: autoSend.shouldSend,
        notSent: (autoSend.notSent || []).length,
        managerSummarySent: !!autoSend.managerSummarySent,
        managerSummaryRequired: !!autoSend.shouldSendManager,
        managerSummarySkippedNoTask: !!autoSend.managerSummarySkippedNoTask,
      } : null,
      html: html ? {
        ok: htmlOk,
        total: htmlTotal,
        broken: countBrokenHtmlFiles(html),
      } : null,
      productivity,
      telegram: {
        disabled: !!telegramState.disabled,
        configured: !!telegramState.configured,
        checked: !!telegramState.checked,
        sent: telegramState.sent === true,
        status: telegram.status,
      },
      unresolved,
    },
  };
}

function formatControlTable(summary, options = {}) {
  const { html = false, includeTelegram = true } = options;
  const headers = ['Пункт', 'Статус', 'Итого', 'Деталь'];
  const rows = (summary?.rows || [])
    .filter(row => includeTelegram || row.key !== 'telegram')
    .map(row => [
      truncateCell(row.item, 18),
      statusWord(row.status),
      truncateCell(row.value, 34),
      truncateCell(row.detail, 56),
    ]);
  const tableRows = [headers, ...rows];
  const widths = headers.map((_, index) => Math.max(...tableRows.map(row => charLength(row[index]))));
  const line = values => values.map((value, index) => padCell(value, widths[index])).join(' | ');
  const separator = widths.map(width => '-'.repeat(width)).join('-+-');
  const table = [line(headers), separator, ...rows.map(line)].join('\n');
  return html ? `<pre>${htmlEscape(table)}</pre>` : table;
}

function safeReportDate(reportDate) {
  return String(reportDate || 'unknown').replace(/[^0-9A-Za-z_-]+/g, '-');
}

function writeVerificationArtifacts(alias, summary, checks) {
  const payload = {
    ...summary,
    checks,
  };
  const safeDate = safeReportDate(summary.reportDate);
  const targets = [
    path.join(ROOT_DIR, 'reports', `verification_${alias}_${safeDate}.json`),
    path.join(ROOT_DIR, 'reports', `verification_${alias}_latest.json`),
    path.join(ROOT_DIR, 'data', `${alias}_verification_latest.json`),
  ];
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
  return targets;
}

async function sendVerificationTelegram(manager, reportDate, checks, reportData) {
  const configured = isTelegramConfigured();
  if (TELEGRAM_DISABLED) return { disabled: true, configured, checked: true, sent: null };
  if (!configured) return { disabled: false, configured: false, checked: true, sent: null };
  const msg = formatTelegram(manager, reportDate, checks, reportData, { configured: true });
  const sent = await sendTelegramMessage(msg);
  return { disabled: false, configured: true, checked: true, sent };
}

function finalizeVerificationConsole(alias, manager, reportDate, checks, reportData, telegramState) {
  const summary = buildControlSummary(manager, reportDate, checks, reportData, telegramState);
  const artifactPaths = writeVerificationArtifacts(alias, summary, checks);
  console.log(`  Verification JSON: ${path.relative(ROOT_DIR, artifactPaths[1])}`);
  return { summary, artifactPaths };
}

function logTelegramDelivery(telegramState) {
  if (telegramState.disabled) {
    console.log('  Telegram: disabled');
  } else if (!telegramState.configured) {
    console.log('  Telegram: not configured');
  } else {
    console.log(`  Telegram: ${telegramState.sent ? 'sent' : 'failed'}`);
  }
}

function formatTelegram(manager, reportDate, checks, reportData = null, telegramState = {}) {
  const lines = [`<b>📊 Верификация: ${manager.name} (${reportDate})</b>`, ''];
  const freshness = checks.find(c => c.name === 'dataFreshness');

  const controlSummary = buildControlSummary(manager, reportDate, checks, reportData, telegramState);
  lines.push('<b>Контрольная таблица</b>');
  lines.push(formatControlTable(controlSummary, { html: true, includeTelegram: false }), '');

  const productivityLines = freshness?.status === 'fail' ? [] : formatProductivityBlock(reportData, reportDate);
  if (productivityLines.length) {
    lines.push(...productivityLines, '');
  }

  if (freshness && freshness.status === 'fail') {
    lines.push(`${statusIcon(freshness.status)} Данные: в файле ${freshness.actualDate || 'нет даты'}, нужно ${freshness.expectedDate}`);
    if (freshness.generated) lines.push(`  Сгенерировано: ${freshness.generated}`);
  }

  // 1. Сделки
  const dc = checks.find(c => c.name === 'dealCompleteness');
  if (dc) {
    lines.push(`${statusIcon(dc.status)} Сделки: ${dc.reportCount}/${dc.planfixCount}`);
    if (dc.rawPlanfixCount && dc.rawPlanfixCount !== dc.planfixCount) {
      lines.push(`  Реестр Planfix всего: ${dc.rawPlanfixCount}, проверяемых сделок: ${dc.planfixCount}`);
    }
    if (dc.reason === 'planfix-empty-report-has-data') lines.push('  Planfix вернул 0 сделок при непустом отчете');
    if (dc.missingFromReport.length > 0) {
      lines.push(`  Пропущены: ${dc.missingFromReport.map(id => `#${id}`).join(', ')}`);
    }
    if (dc.unloadableFromPlanfix?.length > 0) {
      lines.push(`  Не загружаются как задача Planfix: ${dc.unloadableFromPlanfix.map(id => `#${id}`).join(', ')}`);
    }
    if (dc.nonReportableFromPlanfix?.length > 0) {
      lines.push(`  Не сделки/служебные: ${dc.nonReportableFromPlanfix.map(item => `#${item.id}`).join(', ')}`);
    }
  }

  // 2. Звонки по сделкам
  const cc = checks.find(c => c.name === 'callCompleteness');
  if (cc) {
    if (cc.totalMissing === 0) {
      lines.push(`${statusIcon(cc.status)} Звонки: все в отчёте`);
    } else {
      lines.push(`${statusIcon(cc.status)} Звонки: пропущено ${cc.totalMissing}`);
      for (const d of cc.dealResults.filter(d => d.missingCalls.length > 0)) {
        const sources = d.missingCalls.map(mc => `${mc.type} ${mc.time} (${mc.source})`).join(', ');
        lines.push(`  #${d.dealId} ${d.dealName.substring(0, 30)}: ${sources}`);
      }
    }
  }

  // 3. Транскрибации
  const tr = checks.find(c => c.name === 'transcriptions');
  if (tr) {
    let detail = `${tr.transcribed} транскр.`;
    if (tr.ndz > 0) detail += `, ${tr.ndz} НДЗ`;
    if (tr.coveredByTranscription > 0) detail += `, ${tr.coveredByTranscription} уже есть в сделке`;
    if (tr.untranscribed > 0) detail += `, ${tr.untranscribed} без расшифровки`;
    lines.push(`${statusIcon(tr.status)} Транскрибации: ${detail}`);
    if (tr.untranscribedReasonText) lines.push(`  Причины: ${tr.untranscribedReasonText}`);
  }

  // 4. ИИ-оценки
  const ai = checks.find(c => c.name === 'aiAssessments');
  if (ai) {
    lines.push(`${statusIcon(ai.status)} ИИ-оценки: ${ai.assessed}/${ai.total}`);
    if (ai.missing.length > 0) {
      lines.push(`  Нет: ${ai.missing.map(m => `#${m.dealId}`).join(', ')}`);
    }
  }

  // 5. Автоотправка
  const as = checks.find(c => c.name === 'autoSend');
  if (as) {
    lines.push(`${statusIcon(as.status)} Автоотправка: ${as.sent}/${as.shouldSend}`);
    if (as.shouldSendManager && !as.managerSummarySent) lines.push('  Сводка менеджера не отправлена');
    if (as.managerSummarySkippedNoTask) lines.push('  Сводка менеджера пропущена: задача ежедневного отчета не найдена');
  }

  // 6. HTML
  const hf = checks.find(c => c.name === 'htmlFiles');
  if (hf) {
    const allOk = hf.files.every(f => f.exists && f.valid);
    lines.push(`${statusIcon(hf.status)} HTML: ${allOk ? 'OK' : hf.files.filter(f => !f.exists || !f.valid).map(f => f.label).join(', ')}`);
  }

  // Итого
  const overall = checks.some(c => c.status === 'fail') ? 'fail' : checks.some(c => c.status === 'warn') ? 'warn' : 'pass';
  lines.push('');
  if (overall === 'pass') lines.push('Итого: ✅ <b>ВСЁ ОК</b>');
  else if (overall === 'warn') lines.push('Итого: ⚠️ <b>ЕСТЬ ЗАМЕЧАНИЯ</b>');
  else lines.push('Итого: ❌ <b>ЕСТЬ ОШИБКИ</b>');

  return lines.join('\n');
}

// ============ Форматирование для консоли ============

function formatConsole(manager, reportDate, checks, reportData = null, telegramState = {}) {
  const lines = [`\n=== Верификация: ${manager.name} (${reportDate}) ===\n`];

  const controlSummary = buildControlSummary(manager, reportDate, checks, reportData, telegramState);
  lines.push(formatControlTable(controlSummary), '');

  for (const c of checks) {
    lines.push(`${statusIcon(c.status)} ${c.name}`);
    if (c.name === 'dataFreshness') {
      lines.push(`  expected: ${c.expectedDate}, data: ${c.actualDate || 'missing'}, generated: ${c.generated || 'unknown'}`);
    }
    if (c.name === 'dealCompleteness') {
      lines.push(`  Planfix: ${c.planfixCount}, отчёт: ${c.reportCount}`);
      if (c.rawPlanfixCount && c.rawPlanfixCount !== c.planfixCount) {
        lines.push(`  Реестр Planfix всего: ${c.rawPlanfixCount}, проверяемых сделок: ${c.planfixCount}`);
      }
      if (c.reason === 'planfix-empty-report-has-data') lines.push('  Planfix returned 0 deals while report has data');
      if (c.missingFromReport.length) lines.push(`  Пропущены: ${c.missingFromReport.join(', ')}`);
      if (c.unloadableFromPlanfix?.length) lines.push(`  Не загружаются как задача Planfix: ${c.unloadableFromPlanfix.join(', ')}`);
      if (c.nonReportableFromPlanfix?.length) lines.push(`  Не сделки/служебные: ${c.nonReportableFromPlanfix.map(item => item.id).join(', ')}`);
    }
    if (c.name === 'callCompleteness' && c.totalMissing > 0) {
      for (const d of c.dealResults.filter(d => d.missingCalls.length > 0)) {
        lines.push(`  #${d.dealId} ${d.dealName}: пропущено ${d.missingCalls.length} звонков`);
      }
    }
    if (c.name === 'transcriptions') {
      const covered = c.coveredByTranscription ? `, уже есть в сделке: ${c.coveredByTranscription}` : '';
      lines.push(`  Всего: ${c.totalCalls}, транскр: ${c.transcribed}, НДЗ: ${c.ndz}${covered}, без: ${c.untranscribed}`);
      if (c.untranscribedReasonText) lines.push(`  Причины: ${c.untranscribedReasonText}`);
    }
    if (c.name === 'aiAssessments') {
      lines.push(`  Оценено: ${c.assessed}/${c.total}`);
    }
    if (c.name === 'autoSend') {
      lines.push(`  Отправлено: ${c.sent}/${c.shouldSend}`);
      if (c.shouldSendManager && !c.managerSummarySent) lines.push('  Сводка менеджера не отправлена');
      if (c.managerSummarySkippedNoTask) lines.push('  Сводка менеджера пропущена: задача ежедневного отчета не найдена');
    }
  }

  const overall = checks.some(c => c.status === 'fail') ? 'fail' : checks.some(c => c.status === 'warn') ? 'warn' : 'pass';
  lines.push(`\nИтого: ${statusIcon(overall)} ${overall === 'pass' ? 'ВСЁ ОК' : overall === 'warn' ? 'ЕСТЬ ЗАМЕЧАНИЯ' : 'ЕСТЬ ОШИБКИ'}\n`);
  return lines.join('\n');
}

// ============ Главная функция ============

async function verifyManagerReport(alias, reportDate) {
  const manager = MANAGERS[alias];
  if (!manager) { console.error(`❌ Менеджер "${alias}" не найден`); return null; }

  console.log(`\n📊 Верификация: ${manager.name} (${reportDate})`);

  const reportData = loadReportData(alias);
  if (!reportData) { console.error(`  ❌ Нет данных: data/${alias}_latest.json`); return null; }
  const pendingTelegramState = {
    disabled: TELEGRAM_DISABLED,
    configured: !TELEGRAM_DISABLED && isTelegramConfigured(),
    checked: false,
    sent: null,
  };

  const aiCache = loadAiCache();
  const checks = [];
  const freshness = checkReportDataFreshness(reportData, reportDate);
  checks.push(freshness);

  if (freshness.status === 'fail') {
    checks.push(checkHtmlFiles(alias, reportDate));
    console.log(formatConsole(manager, reportDate, checks, reportData, pendingTelegramState));
    const telegramState = await sendVerificationTelegram(manager, reportDate, checks, reportData);
    logTelegramDelivery(telegramState);
    const { summary, artifactPaths } = finalizeVerificationConsole(alias, manager, reportDate, checks, reportData, telegramState);
    return { manager, reportDate, checks, summary, telegramSent: telegramState.sent === true, artifactPaths };
  }

  // 1. Полнота сделок
  checks.push(await checkDealCompleteness(manager.userId, reportDate, reportData));

  // 2. Полнота звонков (главная проверка — идёт в Planfix)
  checks.push(await checkDealCallsCompleteness(reportData));

  // 3. Транскрибации
  checks.push(await checkTranscriptions(reportData, aiCache));

  // 4. ИИ-оценки
  checks.push(checkAiAssessments(reportData));

  // 5. Автоотправка
  checks.push(checkAutoSend(reportData, aiCache, reportDate));

  // 6. HTML-файлы
  checks.push(checkHtmlFiles(alias, reportDate));

  // Вывод в консоль
  console.log(formatConsole(manager, reportDate, checks, reportData, pendingTelegramState));

  // Отправка в Telegram и сохранение итогового JSON
  const telegramState = await sendVerificationTelegram(manager, reportDate, checks, reportData);
  logTelegramDelivery(telegramState);
  const { summary, artifactPaths } = finalizeVerificationConsole(alias, manager, reportDate, checks, reportData, telegramState);

  return { manager, reportDate, checks, summary, telegramSent: telegramState.sent === true, artifactPaths };
}

module.exports = {
  verifyManagerReport,
  formatTelegram,
  formatConsole,
  buildControlSummary,
  formatControlTable,
  writeVerificationArtifacts,
};
