const { pf, pfGet, getAllTasks, getLightTasks } = require('../api/planfix');
const {
  sleep, parallelMap, utcToMsk, stripHtml, timeToMinNode, extractWorkDesc, normalizePhone, parseCfd, parsePfDate, isSameDay,
} = require('../utils/helpers');
const { extractTranscription, isNoAnswerTranscription, getNoAnswerLabel, hasCallRecordingFile } = require('./transcription');
const {
  CONCURRENCY, SKIP_STATUSES, DEAL_FIELDS, DEEPSEEK_KEY, POLZA_KEY, OPENAI_KEY, isTimeUp,
  CALL_TAG, ANALYSIS_TAG, ALLOWED_TEMPLATES, ROOT_DIR, MANAGERS_LIST, fs, path,
} = require('../utils/config');
const {
  transcribeCallIfNeeded, transcribeExternalAudioIfNeeded, getCachedTranscription, findCallAudioFile, buildAudioSignature,
} = require('../api/whisper');
const { isMangoConfigured, findMangoRecordingForCall, downloadMangoRecording } = require('../api/mango');
const { aiDealFullAssessment } = require('./assessment');
const { aiDaySummary, aiManagerSummary } = require('./manager-report');
const { buildMeasurementsData, buildMeasurementsComparison, isMeasurementTaskLike } = require('./measurements');
const { loadAiCache, saveAiCache, loadTranscriptionCache } = require('./cache');
const { loadHistory, saveHistory, ensureDeal } = require('./history');
const { loadPreviousSnapshot, saveSnapshot, computeFunnelChanges } = require('./funnel');

const DIRECTORY_ID = 16572;
const FIELD_DATE = 34134;
const FIELD_EMPLOYEE = 34136;
const FIELD_TASK_ID = 34138;
const FIELD_TASK_NAME = 34140;
const DIR_FIELDS = `key,${FIELD_DATE},${FIELD_EMPLOYEE},${FIELD_TASK_ID},${FIELD_TASK_NAME}`;
const measurementRangeCache = new Map();
const companyMeasurementsCache = new Map();

async function taskListWithRetry(payload, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await pf('/task/list', payload);
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`    ⚠️ ${label}: ${e.message || e} (повтор ${attempt}/3)`);
      await sleep(1500 * attempt);
    }
  }
  return { tasks: [] };
}

function tagTaskComments(comments, task, source, parentId = null) {
  return (comments || []).map(comment => ({
    ...comment,
    source: comment.source || source,
    sourceTaskId: comment.sourceTaskId || task?.id || null,
    sourceTaskName: comment.sourceTaskName || task?.name || '',
    sourceParentId: comment.sourceParentId || parentId || null,
    sourceTaskTemplateId: comment.sourceTaskTemplateId || task?.template?.id || null,
  }));
}

function mergeCommentsById(baseComments, incomingComments) {
  const byId = new Map();
  for (const comment of baseComments || []) {
    if (comment?.id == null) continue;
    byId.set(String(comment.id), comment);
  }
  for (const comment of incomingComments || []) {
    if (comment?.id == null) continue;
    byId.set(String(comment.id), comment);
  }
  return [...byId.values()];
}

function firstDayOfYear(dateStr) {
  const d = parsePfDate(dateStr);
  if (!d || Number.isNaN(d.getTime())) return '01-01-1970';
  return `01-01-${d.getFullYear()}`;
}

function uniqTasksById(tasks) {
  const map = new Map();
  for (const task of tasks || []) {
    if (!task?.id) continue;
    const current = map.get(task.id) || {};
    map.set(task.id, { ...current, ...task });
  }
  return [...map.values()];
}

function getTaskCustomFieldText(task, fieldId) {
  const field = (task?.customFieldData || []).find(item => String(item.field?.id) === String(fieldId));
  if (!field) return '';
  if (field.stringValue) return String(field.stringValue).trim();
  if (field.value && typeof field.value === 'object') return String(field.value.name || field.value.text || field.value.value || '').trim();
  return String(field.value ?? '').trim();
}

function taskHasMeasurementSignal(task) {
  return !!(
    isMeasurementTaskLike(task) ||
    getTaskCustomFieldText(task, '76672') ||
    getTaskCustomFieldText(task, '76826') ||
    getTaskCustomFieldText(task, '67894') ||
    (task?.status?.name || '') === 'Замер'
  );
}

function isAllowedDealTask(task) {
  if (!task || task.parent?.id) return false;
  const tplName = task.template?.name || '';
  if (!tplName) return true;
  return ALLOWED_TEMPLATES.some(at => tplName.toLowerCase().includes(at.toLowerCase()));
}

function getTaskDealSum(task) {
  const cf = {};
  for (const c of (task?.customFieldData || [])) cf[c.field.id] = { value: c.value, str: c.stringValue || '' };
  return parseFloat(cf[67906]?.value || cf[67906]?.str || 0) || 0;
}

function makeFunnelCardFromTask(task) {
  return {
    id: task.id,
    name: task.name,
    status: task.status?.name || '?',
    template: task.template?.name || '',
    counterparty: task.counterparty?.name || '—',
    dateCreated: task.dateTime?.date || task.dateCreated?.date || '',
    dealSum: getTaskDealSum(task),
    isActive: !SKIP_STATUSES.includes(task.status?.name || ''),
  };
}

function upsertStatusSnapshot(dealHist, snapshot) {
  if (!snapshot?.date || !snapshot.status) return;
  if (!Array.isArray(dealHist.statusSnapshots)) dealHist.statusSnapshots = [];
  const sameDate = dealHist.statusSnapshots.find(item => item.date === snapshot.date);
  if (sameDate) {
    Object.assign(sameDate, snapshot);
  } else {
    dealHist.statusSnapshots.push(snapshot);
  }
  dealHist.statusSnapshots.sort((a, b) => itemStamp(a) - itemStamp(b));
}

function getStatusSnapshotForDate(dealHist, dateDMY) {
  const target = parsePfDate(dateDMY);
  if (!target || !Array.isArray(dealHist?.statusSnapshots)) return null;
  let best = null;
  for (const snapshot of dealHist.statusSnapshots) {
    const d = parsePfDate(snapshot.date);
    if (!d || d > target) continue;
    if (!best || d >= parsePfDate(best.date)) best = snapshot;
  }
  return best;
}

function rememberDealStatus(history, card, reportDate) {
  if (!card?.id) return;
  const deal = ensureDeal(history, card.id);
  deal.name = card.name || deal.name || '?';
  deal.status = card.status || deal.status || '?';
  deal.counterparty = card.counterparty || deal.counterparty || '—';
  deal.dateCreated = card.dateCreated || deal.dateCreated || '';
  deal.dealSum = card.dealSum || deal.dealSum || 0;
  upsertStatusSnapshot(deal, {
    date: reportDate,
    status: card.status || '?',
    name: card.name || deal.name || '?',
    counterparty: card.counterparty || deal.counterparty || '—',
    dateCreated: deal.dateCreated || '',
    dealSum: deal.dealSum || 0,
  });
}

function collectMeasurementRelevantDealIds({ multiDayActivity, dealTasks, allManagerTasks }) {
  const ids = new Set();

  for (const task of dealTasks || []) {
    const id = Number(task?.parent?.id || task?.id || 0);
    if (id) ids.add(id);
  }

  for (const task of allManagerTasks || []) {
    if (!taskHasMeasurementSignal(task)) continue;
    const id = Number(task?.parent?.id || task?.id || 0);
    if (id) ids.add(id);
  }

  for (const dayDeals of Object.values(multiDayActivity || {})) {
    for (const item of dayDeals || []) {
      const id = Number(item?.deal?.id || 0);
      if (id) ids.add(id);
    }
  }

  return ids;
}

async function loadTasksByIds(taskIds) {
  const uniqueIds = [...new Set((taskIds || []).map(id => Number(id)).filter(Boolean))];
  if (!uniqueIds.length) return [];

  const loaded = [];
  await parallelMap(uniqueIds, async (taskId) => {
    try {
      const d = await pf('/task/list', {
        offset: 0,
        pageSize: 1,
        filters: [{ type: 57, operator: 'equal', value: taskId }],
        fields: DEAL_FIELDS,
      });
      const task = (d.tasks || [])[0];
      if (task) loaded.push(task);
    } catch (e) {
      console.log(`    ⚠️ Не удалось загрузить задачу #${taskId}: ${e.message}`);
    }
  }, 3);

  return loaded;
}

async function getMeasurementTasksInRange(fromDate, toDate) {
  const cacheKey = `${fromDate}_${toDate}`;
  if (measurementRangeCache.has(cacheKey)) return measurementRangeCache.get(cacheKey);

  const all = [];
  let offset = 0;
  while (true) {
    const d = await taskListWithRetry({
      offset,
      pageSize: 100,
      filters: [{ type: 21, operator: 'equal', value: { dateType: 'otherRange', dateFrom: fromDate, dateTo: toDate } }],
      fields: DEAL_FIELDS,
    }, `Замеры ${fromDate}-${toDate} offset=${offset}`);
    const tasks = d.tasks || [];
    all.push(...tasks);
    if (tasks.length < 100) break;
    offset += 100;
  }

  const measurements = all.filter(task => task?.parent?.id && isMeasurementTaskLike(task));
  measurementRangeCache.set(cacheKey, measurements);
  return measurements;
}

async function buildMeasurementContextTasks({ reportDate, multiDayActivity, dealTasks, allManagerTasks }) {
  const relevantDealIds = collectMeasurementRelevantDealIds({ multiDayActivity, dealTasks, allManagerTasks });
  if (!relevantDealIds.size) return uniqTasksById([...(allManagerTasks || []), ...(dealTasks || [])]);

  const existingTasks = uniqTasksById([...(allManagerTasks || []), ...(dealTasks || [])]).filter(task => {
    const rootId = Number(task?.parent?.id || task?.id || 0);
    return rootId && relevantDealIds.has(rootId);
  });
  const existingDealIds = new Set(
    existingTasks
      .filter(task => !task?.parent?.id)
      .map(task => Number(task.id))
      .filter(Boolean),
  );

  const missingDealIds = [...relevantDealIds].filter(id => !existingDealIds.has(id));
  const extraDealTasks = missingDealIds.length ? await loadTasksByIds(missingDealIds) : [];
  const measurementTasks = await getMeasurementTasksInRange(firstDayOfYear(reportDate), reportDate);
  const relatedMeasurementTasks = measurementTasks.filter(task => relevantDealIds.has(Number(task?.parent?.id || 0)));

  console.log(`  📐 Контекст замеров: ${relatedMeasurementTasks.length} подзадач, ${extraDealTasks.length} сделок`);
  return uniqTasksById([...existingTasks, ...extraDealTasks, ...relatedMeasurementTasks]);
}

function buildTranscriptionCacheFromAiCache() {
  const aiCache = loadAiCache();
  const transcriptionCache = {};
  const persistedCache = loadTranscriptionCache();
  for (const [key, value] of Object.entries(persistedCache || {})) {
    transcriptionCache[key] = value;
  }
  for (const [key, value] of Object.entries(aiCache || {})) {
    if (key.startsWith('whisper_sig_')) transcriptionCache[`sig:${key.replace('whisper_sig_', '')}`] = value;
    else if (key.startsWith('whisper_')) transcriptionCache[key.replace('whisper_', '')] = value;
  }
  return transcriptionCache;
}

function getCommentFileName(file) {
  if (typeof file === 'string') return file.trim();
  return String(file?.name || file?.fileName || '').trim();
}

function normalizeCommentFile(file) {
  if (typeof file === 'string') {
    const name = file.trim();
    return name ? name : null;
  }

  const id = String(file?.id || file?.fileId || '').trim();
  const name = getCommentFileName(file);
  if (!id && !name) return null;

  const normalized = {};
  if (id) normalized.id = id;
  if (name) normalized.name = name;
  return normalized;
}

function commentFilesText(files) {
  return (files || []).map(getCommentFileName).filter(Boolean).join(' ');
}

async function tryMangoTranscriptionForComment(comment, reportDate, transcriptionCache, stats, context) {
  if (!isMangoConfigured() || !context?.phones?.length) return null;

  const dt = utcToMsk(comment?.dateTime?.date, comment?.dateTime?.time);
  if (!dt.time) return null;

  if (stats) stats.mangoTried += 1;
  const match = await findMangoRecordingForCall({
    reportDate,
    time: dt.time,
    phones: context.phones,
    managerAlias: context.managerAlias,
    managerName: context.managerName,
  });
  if (!match) return null;

  if (stats) stats.mangoMatched += 1;
  const cached = getCachedTranscription(transcriptionCache, match.audioFile);
  if (cached) {
    comment.mangoTranscription = cached;
    comment.mangoRecording = {
      recordingId: match.recordingId,
      time: match.call.time,
      duration: match.call.duration,
      phone: match.call.fromNumber || match.call.toNumber || '',
    };
    if (stats) stats.mangoCached += 1;
    return cached;
  }

  let audioPath = null;
  try {
    audioPath = await downloadMangoRecording(match.recordingId);
    if (!audioPath) {
      if (stats) stats.mangoFailed += 1;
      return null;
    }

    const text = await transcribeExternalAudioIfNeeded(match.audioFile, audioPath, transcriptionCache);
    if (text) {
      comment.mangoTranscription = text;
      comment.mangoRecording = {
        recordingId: match.recordingId,
        time: match.call.time,
        duration: match.call.duration,
        phone: match.call.fromNumber || match.call.toNumber || '',
      };
      if (stats) stats.mangoTranscribed += 1;
      return text;
    }

    if (stats) stats.mangoFailed += 1;
    return null;
  } catch (e) {
    if (stats) stats.mangoFailed += 1;
    console.log(`    Mango: fallback failed (${String(e.message || e).substring(0, 100)})`);
    return null;
  } finally {
    if (audioPath) {
      try { fs.unlinkSync(audioPath); } catch {}
    }
  }
}

async function preloadReportDayCallTranscriptions(rawComments, reportDate, transcriptionCache, stats = null, context = null) {
  const queue = new Map();
  const cachedKeys = new Set();

  for (const comment of rawComments || []) {
    const dt = utcToMsk(comment?.dateTime?.date, comment?.dateTime?.time);
    if (dt.date !== reportDate) continue;
    if (extractTranscription(comment.description)) continue;

    const audioFile = findCallAudioFile(comment.files || []);
    if (!audioFile) continue;

    const fileId = String(audioFile.id || '');
    const signature = buildAudioSignature(audioFile);
    const cacheKey = fileId || (signature ? `sig:${signature}` : '') || String(comment.id);
    if ((fileId && transcriptionCache[fileId]) || (signature && transcriptionCache[`sig:${signature}`])) {
      if (stats && !cachedKeys.has(cacheKey)) {
        stats.cached += 1;
        cachedKeys.add(cacheKey);
      }
      continue;
    }

    if (!fileId) {
      if (stats) stats.noFileId += 1;
      await tryMangoTranscriptionForComment(comment, reportDate, transcriptionCache, stats, context);
      continue;
    }

    const queueKey = fileId || (signature ? `sig:${signature}` : '') || String(comment.id);
    if (!queue.has(queueKey)) queue.set(queueKey, { audioFile, comment });
  }

  if (stats) stats.queued += queue.size;

  let transcribed = 0;
  for (const item of queue.values()) {
    if (isTimeUp()) break;
    const { audioFile, comment } = item;
    const text = await transcribeCallIfNeeded({ transcription: null, files: [audioFile] }, transcriptionCache, true);
    if (text) {
      transcribed += 1;
      continue;
    }

    const mangoText = await tryMangoTranscriptionForComment(comment, reportDate, transcriptionCache, stats, context);
    if (mangoText) {
      transcribed += 1;
    } else if (stats) {
      stats.failed += 1;
    }
  }

  if (stats) stats.transcribed += transcribed;
  return transcribed;
}

async function parseCommentsForMeasurementReport(rawComments, reportDate, transcriptionCache) {
  const parsed = [];
  for (const comment of rawComments || []) {
    const parsedComment = await parseComment(comment, reportDate, transcriptionCache, true);
    if (!isAiComment(parsedComment.text)) parsed.push(parsedComment);
  }
  return parsed;
}

async function loadRootDealCommentsForMeasurements(task, history, reportDate, transcriptionCache) {
  const deal = ensureDeal(history, task.id);
  const existing = Array.isArray(deal.comments)
    ? tagTaskComments(deal.comments.filter(comment => !isAiComment(comment.text)), task, 'deal')
    : [];
  const cached = deal.commentsLoaded && existing.length ? existing : null;
  const cachedIds = new Set((deal.comments || []).map(comment => String(comment.id)));
  const junkRe = /закончились ai-кредит|не могу выполнить операцию|добавить ai-кредит/i;

  let raw = [];
  let complete = true;
  try {
    const loaded = await getDealCommentsResult(task.id);
    raw = loaded.comments;
    complete = loaded.complete;
  } catch {}

  const needsWhisper = cached
    ? cached.filter(comment =>
      (comment.type === 'outCall' || comment.type === 'inCall') &&
      (!comment.transcription || junkRe.test(comment.transcription)) &&
      hasCallRecordingFile(comment.files || []))
    : [];

  if (cached && complete && raw.length && raw.every(comment => cachedIds.has(String(comment.id))) && !needsWhisper.length) {
    return cached;
  }

  if (!raw.length && (cached || existing.length)) return cached || existing;

  await preloadReportDayCallTranscriptions(raw, reportDate, transcriptionCache);
  const parsed = tagTaskComments(await parseCommentsForMeasurementReport(raw, reportDate, transcriptionCache), task, 'deal');
  deal.comments = complete ? parsed : mergeCommentsById(existing, parsed);
  deal.commentsLoaded = complete;
  deal.commentsPartial = !complete;
  return deal.comments;
}

async function mergeMeasurementSubtaskComments({ rootTask, subtask, commentsByTask, reportDate, transcriptionCache, history }) {
  let raw = [];
  let complete = true;
  try {
    const loaded = await getDealCommentsResult(subtask.id);
    raw = loaded.comments;
    complete = loaded.complete;
  } catch {}
  if (!raw.length) {
    if (!complete) {
      const deal = ensureDeal(history, rootTask.id);
      deal.commentsLoaded = false;
      deal.commentsPartial = true;
    }
    return;
  }

  await preloadReportDayCallTranscriptions(raw, reportDate, transcriptionCache);
  const parsed = tagTaskComments(
    await parseCommentsForMeasurementReport(raw, reportDate, transcriptionCache),
    subtask,
    'subtask',
    rootTask.id,
  );
  if (!parsed.length) return;

  if (!commentsByTask[rootTask.id]) commentsByTask[rootTask.id] = [];
  const parsedIds = new Set(parsed.map(comment => String(comment.id)));
  commentsByTask[rootTask.id] = commentsByTask[rootTask.id]
    .filter(comment => !parsedIds.has(String(comment.id)))
    .concat(parsed);

  const deal = ensureDeal(history, rootTask.id);
  deal.comments = commentsByTask[rootTask.id];
  if (!complete) deal.commentsPartial = true;
  deal.commentsLoaded = complete && deal.commentsLoaded !== false;
}

async function loadCompanyMeasurementSubtasks(rootTask, subtasksById, commentsByTask, reportDate, transcriptionCache, history) {
  const walkedParents = new Set();
  const loadedSubtaskIds = new Set();

  async function walk(parentId) {
    if (!parentId || walkedParents.has(parentId)) return;
    walkedParents.add(parentId);

    let offset = 0;
    while (true) {
      try {
        const d = await taskListWithRetry({
          offset,
          pageSize: 100,
          filters: [{ type: 58, operator: 'equal', value: parentId }],
          fields: DEAL_FIELDS,
        }, `Подзадачи замеров parent=${parentId} offset=${offset}`);

        const subtasks = d.tasks || [];
        for (const subtask of subtasks) {
          const current = subtasksById.get(subtask.id) || {};
          subtasksById.set(subtask.id, { ...current, ...subtask });
          if (!loadedSubtaskIds.has(subtask.id)) {
            loadedSubtaskIds.add(subtask.id);
            await mergeMeasurementSubtaskComments({
              rootTask,
              subtask: subtasksById.get(subtask.id),
              commentsByTask,
              reportDate,
              transcriptionCache,
              history,
            });
          }
          await walk(subtask.id);
        }

        if (subtasks.length < 100) break;
        offset += 100;
      } catch {
        return;
      }
    }
  }

  await walk(rootTask.id);
}

async function buildCompanyMeasurementsBundle(reportDate, history) {
  if (companyMeasurementsCache.has(reportDate)) return companyMeasurementsCache.get(reportDate);

  const transcriptionCache = buildTranscriptionCacheFromAiCache();
  const measurementTasks = await getMeasurementTasksInRange(firstDayOfYear(reportDate), reportDate);
  const measurementDealIds = [...new Set(
    measurementTasks
      .map(task => Number(task?.parent?.id || 0))
      .filter(Boolean),
  )];

  if (!measurementDealIds.length) {
    const empty = {
      measurements: [],
      measurementsSummary: {
        defaultDays: 30,
        ytdStart: '',
        managerNames: [],
        byManager: [],
        measurers: [],
        outcomeCounts: {},
        byMeasurer: [],
        daily: [],
        totals: { total: 0, scheduled: 0, progressed: 0, toContract: 0, toWork: 0, stalled: 0 },
        compare30d: buildMeasurementsComparison([], reportDate),
      },
    };
    companyMeasurementsCache.set(reportDate, empty);
    return empty;
  }

  const dealTasks = await loadTasksByIds(measurementDealIds);
  const commentsByTask = {};
  const subtasksById = new Map((measurementTasks || []).map(task => [task.id, task]));

  for (const task of dealTasks) {
    commentsByTask[task.id] = await loadRootDealCommentsForMeasurements(task, history, reportDate, transcriptionCache);
    await loadCompanyMeasurementSubtasks(task, subtasksById, commentsByTask, reportDate, transcriptionCache, history);
    commentsByTask[task.id] = (commentsByTask[task.id] || []).sort((a, b) => itemStamp(a) - itemStamp(b));
    const deal = ensureDeal(history, task.id);
    deal.comments = commentsByTask[task.id];
    deal.commentsLoaded = true;
  }

  const contextTasks = uniqTasksById([...dealTasks, ...measurementTasks, ...subtasksById.values()]);
  const measurementData = buildMeasurementsData({
    reportDate,
    managerName: '',
    managerAlias: '',
    history,
    allTasks: contextTasks,
    activeDealTasks: dealTasks,
    activeSubtasks: [...subtasksById.values()],
  });

  const cached = {
    measurements: measurementData.measurements,
    measurementsSummary: measurementData.measurementsSummary,
  };
  companyMeasurementsCache.set(reportDate, cached);
  return cached;
}

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
        if (attempt < 3) {
          await sleep(2000 * attempt);
          continue;
        }
        console.log(` ⚠️ ${e.message}`);
        return all;
      }
    }

    const entries = d.directoryEntries || [];
    console.log(` ${entries.length}`);

    for (const entry of entries) {
      const fields = {};
      for (const cf of (entry.customFieldData || [])) fields[cf.field?.id] = cf;
      const date = fields[FIELD_DATE]?.stringValue || '';
      if (date !== reportDate) continue;
      const empId = String(fields[FIELD_EMPLOYEE]?.value?.id || '').replace('user:', '');
      if (empId !== String(userId)) continue;
      const taskId = fields[FIELD_TASK_ID]?.value?.id;
      if (taskId && !seenIds.has(taskId)) {
        seenIds.add(taskId);
        all.push(taskId);
      }
    }

    if (entries.length < 100) break;
    offset += 100;
    await sleep(300);
  }

  console.log(`  ✅ Уникальных сделок: ${all.length}`);
  return all;
}

async function getDealCommentsResult(taskId) {
  const all = [];
  let offset = 0;
  while (true) {
    let d;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        d = await pf(`/task/${taskId}/comments/list`, {
          offset,
          pageSize: 100,
          fields: 'id,description,dateTime,owner,type,isPinned,files',
        });
        break;
      } catch (e) {
        if (attempt < 3) {
          await sleep(2000 * attempt);
          continue;
        }
        console.log(`    ⚠️ Комментарии #${taskId}: ${e.message}`);
        return { comments: all, complete: false };
      }
    }
    const comments = d.comments || [];
    all.push(...comments);
    if (comments.length < 100) break;
    offset += 100;
    await sleep(300);
  }
  return { comments: all, complete: true };
}

async function getDealComments(taskId) {
  return (await getDealCommentsResult(taskId)).comments;
}

async function parseComment(c, reportDate, transcriptionCache, allowWhisper) {
  const desc = stripHtml(c.description);
  const dt = utcToMsk(c.dateTime?.date, c.dateTime?.time);
  const allowNewTranscription = !!allowWhisper && dt.date === reportDate;
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
    const hasRecording = hasCallRecordingFile(c.files || []);
    if (hasTranscription || hasRecording) type = 'inCall';
  }

  let transcription = c.mangoTranscription || null;
  if (type === 'outCall' || type === 'inCall') {
    transcription = transcription || extractTranscription(c.description);
    if (!transcription && (POLZA_KEY || OPENAI_KEY) && transcriptionCache) {
      transcription = await transcribeCallIfNeeded({ transcription, files: c.files || [] }, transcriptionCache, allowNewTranscription);
    }
  }

  if (!transcription && type === 'note' && (POLZA_KEY || OPENAI_KEY) && transcriptionCache) {
    const cFiles = c.files || [];
    const hasCallRecording = !!findCallAudioFile(cFiles);
    if (hasCallRecording) {
      type = 'inCall';
      transcription = await transcribeCallIfNeeded({ transcription: null, files: cFiles }, transcriptionCache, allowNewTranscription);
    }
  }

  if (transcription && isNoAnswerTranscription(transcription)) {
    type = 'ndz';
  }

  const files = (c.files || []).map(normalizeCommentFile).filter(Boolean);
  const text = type === 'ndz' ? getNoAnswerLabel(transcription || desc) : desc.substring(0, 800);
  return {
    id: c.id,
    date: dt.date || '',
    time: dt.time || '',
    type,
    text,
    owner: c.owner?.name || '',
    transcription,
    transcriptionSource: c.mangoTranscription ? 'mango' : 'planfix',
    mangoRecording: c.mangoRecording || null,
    files,
  };
}

function isAiComment(text) {
  const t = (text || '').toLowerCase();
  return t.includes('ии-рекомендаци') || t.includes('ии рекомендаци') ||
    t.includes('ai-рекомендаци') || t.includes('рекомендации ии') ||
    t.includes('ии-оценка сделки') || t.includes('🤖 ии-оценка') || t.includes('баллы зп:');
}

const NO_KP_STATUSES = ['Обработка', 'Коммерческое предложение'];
const FORGOTTEN_STATUSES = ['Обработка', 'Коммерческое предложение', 'Замер', 'Клиент принимает решение', 'Договор и Оплата'];
const HIGH_PRIORITY_SUM = 1000000;

function detectRedFlags(card, mgrPfName, reportDate) {
  const flags = [];
  const status = card.status || '';
  const comments = card.comments || [];
  const reportDateObj = parsePfDate(reportDate);

  if (status === 'Новая' && card.dateCreated && reportDateObj) {
    const created = parsePfDate(card.dateCreated);
    if (created) {
      const minutesAgo = (reportDateObj - created) / (1000 * 60);
      if (minutesAgo > 30) {
        const hoursAgo = Math.floor(minutesAgo / 60);
        const label = hoursAgo >= 24 ? `Не обработана (${Math.floor(hoursAgo / 24)} дн)` : `Не обработана (${hoursAgo}ч)`;
        flags.push({ type: 'warning', code: 'not_processed', label });
      }
    }
  }

  if (NO_KP_STATUSES.includes(status)) {
    const hasKp = comments.some(c => {
      const t = (c.text || '').toLowerCase();
      const f = commentFilesText(c.files || []).toLowerCase();
      return t.includes('кп') || t.includes('коммерческое предложение') ||
        f.includes('кп') || f.includes('к.п') || f.includes('коммерческое');
    });
    if (!hasKp && reportDateObj) {
      const clientComment = comments.find(c =>
        c.owner &&
        !c.owner.includes(mgrPfName) &&
        !c.owner.toLowerCase().includes('robot') &&
        c.date,
      );
      if (clientComment) {
        const clientDate = parsePfDate(clientComment.date);
        if (clientDate) {
          const hoursAgo = (reportDateObj - clientDate) / (1000 * 60 * 60);
          if (hoursAgo > 24) {
            flags.push({ type: 'warning', code: 'no_kp', label: 'Нет КП >24ч' });
          }
        }
      }
    }
  }

  if (FORGOTTEN_STATUSES.includes(status) && reportDateObj) {
    const humanComments = comments.filter(c =>
      c.owner &&
      c.date &&
      !c.owner.toLowerCase().includes('robot') &&
      !c.owner.toLowerCase().includes('робот'),
    );
    if (humanComments.length) {
      let lastDate = null;
      for (const c of humanComments) {
        const d = parsePfDate(c.date);
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

  if (card.dealSum >= HIGH_PRIORITY_SUM && card.isActive) {
    flags.push({ type: 'priority', code: 'high_sum', label: `Приоритет (${Math.round(card.dealSum / 1000000 * 10) / 10}М ₽)` });
  }

  return flags;
}

function itemStamp(item) {
  const dt = parsePfDate(item?.date || '');
  if (!dt) return 0;
  return dt.getTime() + (timeToMinNode(item?.time || '') * 60000);
}

function buildDayFromHistory(history, dateDMY, dealTasksMap, mgrPfName) {
  const result = [];

  for (const [dealId, dealHist] of Object.entries(history.deals || {})) {
    const allComments = [
      ...(dealHist.comments || []),
      ...(dealHist.contactCalls || []),
    ].sort((a, b) => itemStamp(a) - itemStamp(b));

    const dayComments = allComments.filter(c => c.date === dateDMY);
    if (!dayComments.length) continue;

    const hasMgrActivity = dayComments.some(c => c.owner && c.owner.includes(mgrPfName));
    if (!hasMgrActivity) continue;

    const task = dealTasksMap[Number(dealId)];
    const cf = {};
    if (task) {
      for (const c of (task.customFieldData || [])) cf[c.field.id] = { value: c.value };
    }

    const statusSnapshot = getStatusSnapshotForDate(dealHist, dateDMY);
    const createdDate = task?.dateTime?.date || task?.dateCreated?.date || statusSnapshot?.dateCreated || dealHist.dateCreated || '';
    const deal = task ? {
      id: task.id,
      name: task.name,
      status: statusSnapshot?.status || task.status?.name || '?',
      counterparty: task.counterparty?.name || '—',
      dateCreated: createdDate,
      dealSum: statusSnapshot?.dealSum || parseFloat(cf[67906]?.value || 0) || 0,
      workDesc: extractWorkDesc(task.name),
    } : {
      id: Number(dealId),
      name: statusSnapshot?.name || dealHist.name || '?',
      status: statusSnapshot?.status || dealHist.status || '?',
      counterparty: statusSnapshot?.counterparty || dealHist.counterparty || '—',
      dateCreated: createdDate,
      dealSum: statusSnapshot?.dealSum || dealHist.dealSum || 0,
      workDesc: '',
    };

    const actions = dayComments.map(c => ({
      type: c.type,
      time: c.time,
      text: c.text,
      owner: c.owner,
      transcription: c.transcription,
      source: c.source || 'deal',
      files: c.files || [],
    }));

    const isSnow = (deal.name || '').toLowerCase().startsWith('вывоз снега');
    const assessKey = `assess_${dealId}_${dateDMY}_${isSnow ? 'v20' : 'v20a'}`;

    result.push({
      deal,
      isNew: !!(createdDate && createdDate === dateDMY),
      actions,
      dayCalls: actions.filter(a => a.type === 'outCall' || a.type === 'inCall' || a.type === 'ndz').length,
      planfixScript: null,
      allComments,
      allCalls: [],
      allAnalyses: [],
      scriptHistory: {
        total: 0,
        everHowWeWork: false,
        everCallToAction: false,
        everSentInvoice: false,
        everAllFour: false,
        bestScore: 0,
        customerKnowsCompany: false,
      },
      aiAssessment: dealHist.assessments?.[assessKey] || null,
    });
  }

  return result;
}

async function buildDealCards(userId, reportDate, mgrPfName) {
  const history = loadHistory();
  const reportDateObj = parsePfDate(reportDate);
  const managerMeta = MANAGERS_LIST.find(m => String(m.userId) === String(userId) || m.pfName === mgrPfName);
  const mgrAlias = managerMeta?.alias || null;
  const matchesCurrentMeasurementManager = (item) => {
    if (mgrAlias) return item?.managerAlias === mgrAlias;
    if (managerMeta?.name) return item?.manager === managerMeta.name;
    if (mgrPfName) return (item?.manager || '').includes(mgrPfName);
    return true;
  };

  const emptyResult = {
    dealCards: [],
    funnelCards: [],
    dailyReports: [],
    allCalls: [],
    allAnalyses: [],
    dailyActivity: { newDeals: [], workedDeals: [], incomingDeals: [], totalActive: 0 },
    funnelChanges: [],
    scriptCompliance: { total: 0 },
    dailyDealActivity: [],
    aiDaySummaryText: null,
    multiDayActivity: { [reportDate]: [] },
    multiDaySummary: {},
    managerSummaries: { day: null, week: null, month: null },
    incomingByDate: {},
    snapshotDate: null,
    measurements: [],
    measurementsSummary: {
      defaultDays: 30,
      ytdStart: '',
      managerNames: [],
      byManager: [],
      measurers: [],
      outcomeCounts: {},
      byMeasurer: [],
      daily: [],
      totals: { total: 0, scheduled: 0, progressed: 0, toContract: 0, toWork: 0, stalled: 0 },
      compare30d: {
        enteredMeasurement: 0,
        scheduledMeasurements: 0,
        progressed: 0,
        toContract: 0,
        toWork: 0,
        stalled: 0,
        contractRate: 0,
        workRate: 0,
      },
    },
    measurementsComparison: {
      enteredMeasurement: 0,
      scheduledMeasurements: 0,
      progressed: 0,
      toContract: 0,
      toWork: 0,
      stalled: 0,
      contractRate: 0,
      workRate: 0,
    },
  };

  const taskIds = await getManagerDeals(userId, reportDate);
  let allManagerTasks = [];
  try {
    allManagerTasks = await getAllTasks(userId);
  } catch (e) {
    console.log(`  ⚠️ Все сделки менеджера не удалось загрузить: ${e.message}`);
  }

  let lightTasks = [];
  try {
    lightTasks = await getLightTasks(userId);
  } catch (e) {
    console.log(`  ⚠️ Воронку не удалось загрузить полностью: ${e.message}`);
  }

  if (!taskIds.length) {
    console.log('  ⚠️ Нет сделок в реестре за этот день');
    const multiDayActivity = { [reportDate]: [] };
    const multiDaySummary = {};
    const managerSummaries = { day: null, week: null, month: null };
    const aiCache = loadAiCache();
    const historyDatesSet = new Set();

    for (const [, dealHist] of Object.entries(history.deals || {})) {
      for (const c of [...(dealHist.comments || []), ...(dealHist.contactCalls || [])]) {
        if (!c.date || c.date === reportDate || !reportDateObj) continue;
        const d = parsePfDate(c.date);
        if (!d) continue;
        const daysAgo = (reportDateObj - d) / 86400000;
        if (daysAgo > 0 && daysAgo <= 30) historyDatesSet.add(c.date);
      }
    }

    const pastDays = [...historyDatesSet].sort((a, b) => parsePfDate(b) - parsePfDate(a));
    if (pastDays.length) {
      console.log(`  📚 Прошлые дни из истории: ${pastDays.length}`);
      for (const dayDMY of pastDays) {
        const dayDeals = buildDayFromHistory(history, dayDMY, {}, mgrPfName);
        if (!dayDeals.length) continue;

        if ((DEEPSEEK_KEY || POLZA_KEY) && !isTimeUp()) {
          const needAi = dayDeals.filter(da => !da.aiAssessment);
          for (const da of needAi) {
            if (isTimeUp()) break;
            da.aiAssessment = await aiDealFullAssessment(da, dayDMY, history, true);
          }
          multiDaySummary[dayDMY] = await aiDaySummary(dayDeals, dayDMY, aiCache, mgrAlias);
        }

        multiDayActivity[dayDMY] = dayDeals;
      }
    }

    if ((DEEPSEEK_KEY || POLZA_KEY) && Object.keys(multiDayActivity).length > 1) {
      managerSummaries.week = await aiManagerSummary(multiDayActivity, multiDaySummary, [], [], 7, reportDate, aiCache, mgrAlias, true);
      managerSummaries.month = await aiManagerSummary(multiDayActivity, multiDaySummary, [], [], 30, reportDate, aiCache, mgrAlias, true);
      saveAiCache(aiCache);
    }

    const funnelSource = lightTasks.length ? lightTasks : allManagerTasks;
    const funnelCards = funnelSource.filter(isAllowedDealTask).map(makeFunnelCardFromTask);
    const snapshotRoot = path.join(ROOT_DIR, 'funnel_snapshot.json');
    let snapshotFile = snapshotRoot;
    if (mgrAlias) {
      const perManagerSnapshot = path.join(ROOT_DIR, 'data', `${mgrAlias}_funnel.json`);
      if (!fs.existsSync(perManagerSnapshot) && fs.existsSync(snapshotRoot)) {
        try { fs.copyFileSync(snapshotRoot, perManagerSnapshot); } catch {}
      }
      snapshotFile = perManagerSnapshot;
    }
    const prevSnapshot = loadPreviousSnapshot(snapshotFile);
    const funnelChanges = computeFunnelChanges(prevSnapshot, funnelCards);
    for (const card of funnelCards) rememberDealStatus(history, card, reportDate);
    saveSnapshot(funnelCards, snapshotFile);

    const measurementData = await buildCompanyMeasurementsBundle(reportDate, history);
    saveHistory(history, reportDate);
    return {
      ...emptyResult,
      funnelCards,
      funnelChanges,
      multiDayActivity,
      multiDaySummary,
      managerSummaries,
      snapshotDate: prevSnapshot?.date || null,
      ...measurementData,
      measurementsComparison: buildMeasurementsComparison(
        (measurementData.measurements || []).filter(matchesCurrentMeasurementManager),
        reportDate,
      ),
    };
  }

  const API_CONCURRENCY = 3;
  const rawTasks = [];
  console.log(`  📋 Загрузка ${taskIds.length} сделок...`);
  await parallelMap(taskIds, async (taskId) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const d = await pf('/task/list', {
          offset: 0,
          pageSize: 1,
          filters: [{ type: 57, operator: 'equal', value: taskId }],
          fields: DEAL_FIELDS,
        });
        const task = (d.tasks || [])[0];
        if (task) rawTasks.push(task);
        break;
      } catch (e) {
        if (attempt < 3) {
          await sleep(2000 * attempt);
          continue;
        }
        console.log(`    ⚠️ Не удалось загрузить #${taskId}: ${e.message}`);
      }
    }
  }, API_CONCURRENCY);
  console.log(`    ✅ Загружено: ${rawTasks.length}`);

  const dealTasksById = new Map();
  const subtasksById = new Map();
  for (const task of rawTasks) {
    if (task.parent?.id) subtasksById.set(task.id, task);
    else dealTasksById.set(task.id, task);
  }

  const missingParentIds = [...new Set(
    [...subtasksById.values()]
      .map(task => task.parent?.id)
      .filter(parentId => parentId && !dealTasksById.has(parentId)),
  )];

  if (missingParentIds.length) {
    console.log(`  📥 Догрузка ${missingParentIds.length} родительских сделок...`);
    for (const parentId of missingParentIds) {
      try {
        const d = await pf('/task/list', {
          offset: 0,
          pageSize: 1,
          filters: [{ type: 57, operator: 'equal', value: parentId }],
          fields: DEAL_FIELDS,
        });
        const task = (d.tasks || [])[0];
        if (task) dealTasksById.set(task.id, task);
      } catch (e) {
        console.log(`    ⚠️ Не удалось загрузить родителя #${parentId}: ${e.message}`);
      }
      await sleep(100);
    }
  }

  const dealTasks = [...dealTasksById.values()].filter(isAllowedDealTask);

  const dailyReports = allManagerTasks
    .filter(task => !(task.parent && task.parent.id) && (task.name || '').startsWith('Отчет'))
    .map(task => {
      const cf = {};
      for (const c of (task.customFieldData || [])) cf[c.field.id] = { value: c.value, str: c.stringValue || '' };
      const m = (task.name || '').match(/(\d{2})-(\d{2})-(\d{4})/);
      return {
        id: task.id,
        date: m ? `${m[3]}-${m[2]}-${m[1]}` : null,
        revenue: parseFloat(String(cf[76880]?.str || cf[76880]?.value || 0).replace(/\s/g, '')) || 0,
        outCalls: parseInt(cf[76866]?.str || cf[76866]?.value || 0, 10) || 0,
        callMinutes: parseInt(cf[76868]?.str || cf[76868]?.value || 0, 10) || 0,
        kpSent: parseInt(cf[76872]?.value || 0, 10) || 0,
        dozhim: parseInt(cf[76874]?.value || 0, 10) || 0,
        contract: parseInt(cf[76876]?.value || 0, 10) || 0,
        workDone: parseInt(cf[76878]?.value || 0, 10) || 0,
      };
    })
    .filter(report => report.date);

  const transcriptionCache = buildTranscriptionCacheFromAiCache();
  const transcriptionStats = {
    queued: 0,
    cached: 0,
    transcribed: 0,
    failed: 0,
    noFileId: 0,
    mangoTried: 0,
    mangoMatched: 0,
    mangoCached: 0,
    mangoTranscribed: 0,
    mangoFailed: 0,
  };
  console.log(`  📝 Кэш транскрибаций: ${Object.keys(transcriptionCache).length}`);

  const managerCfg = MANAGERS_LIST.find(m => String(m.userId) === String(userId) || (m.pfName && mgrPfName.includes(m.pfName))) || {};
  const contactInfoCache = {};

  async function getContactInfo(contactId) {
    const id = String(contactId || '').replace('contact:', '');
    if (!id) return { phones: [] };
    if (contactInfoCache[id]) return contactInfoCache[id];
    try {
      const contact = await pfGet(`/contact/${id}?fields=id,phones`);
      const info = {
        phones: (contact.contact?.phones || [])
          .map(p => p.number || '')
          .filter(Boolean),
      };
      contactInfoCache[id] = info;
      return info;
    } catch {
      contactInfoCache[id] = { phones: [] };
      return contactInfoCache[id];
    }
  }

  async function getTaskPhones(task) {
    const cpId = String(task?.counterparty?.id || '').replace('contact:', '');
    const info = await getContactInfo(cpId);
    return info.phones;
  }

  async function parseAll(rawComments) {
    const parsed = [];
    for (const c of rawComments) {
      const parsedComment = await parseComment(c, reportDate, transcriptionCache, true);
      if (!isAiComment(parsedComment.text)) parsed.push(parsedComment);
    }
    return parsed;
  }

  console.log('  💬 Загрузка комментариев...');
  const commentsByTask = {};
  let fromCache = 0;
  let fromApi = 0;
  let loadIdx = 0;

  await parallelMap(dealTasks, async (task) => {
    const dealHist = history.deals[String(task.id)];
    const taskPhones = await getTaskPhones(task);
    const transcriptionContext = {
      phones: taskPhones,
      managerAlias: managerCfg.alias,
      managerName: mgrPfName,
    };

    if (dealHist && dealHist.commentsLoaded && dealHist.comments && dealHist.comments.length) {
      const cached = tagTaskComments(dealHist.comments.filter(c => !isAiComment(c.text)), task, 'deal');
      const cachedIds = new Set(cached.map(c => String(c.id)));
      const loaded = await getDealCommentsResult(task.id);
      const raw = loaded.comments;
      const newComments = raw.filter(c => !cachedIds.has(String(c.id)));
      const junkRe = /закончились ai-кредит|не могу выполнить операцию|добавить ai-кредит/i;
      const needsWhisper = cached.filter(c =>
        (c.type === 'outCall' || c.type === 'inCall') &&
        (!c.transcription || junkRe.test(c.transcription)) &&
        hasCallRecordingFile(c.files || []),
      );

      if (newComments.length || needsWhisper.length || !loaded.complete) {
        await preloadReportDayCallTranscriptions(raw, reportDate, transcriptionCache, transcriptionStats, transcriptionContext);
        const parsed = tagTaskComments(await parseAll(raw), task, 'deal');
        commentsByTask[task.id] = loaded.complete ? parsed : mergeCommentsById(cached, parsed);
        const deal = ensureDeal(history, task.id);
        deal.comments = commentsByTask[task.id];
        deal.commentsLoaded = loaded.complete;
        deal.commentsPartial = !loaded.complete;
      } else {
        commentsByTask[task.id] = cached;
      }
      fromCache++;
    } else {
      const existing = dealHist?.comments
        ? tagTaskComments(dealHist.comments.filter(c => !isAiComment(c.text)), task, 'deal')
        : [];
      const loaded = await getDealCommentsResult(task.id);
      const raw = loaded.comments;
      await preloadReportDayCallTranscriptions(raw, reportDate, transcriptionCache, transcriptionStats, transcriptionContext);
      const parsed = tagTaskComments(await parseAll(raw), task, 'deal');
      commentsByTask[task.id] = loaded.complete ? parsed : mergeCommentsById(existing, parsed);
      const deal = ensureDeal(history, task.id);
      deal.comments = commentsByTask[task.id];
      deal.commentsLoaded = loaded.complete;
      deal.commentsPartial = !loaded.complete;
      fromApi++;
    }

    loadIdx++;
    if (loadIdx % 5 === 0) process.stdout.write(`\r    [${loadIdx}/${dealTasks.length}]`);
  }, API_CONCURRENCY);

  if (dealTasks.length > 0) {
    console.log(`\r    [${dealTasks.length}/${dealTasks.length}] (кэш: ${fromCache}, API: ${fromApi}) ✅`);
  }

  console.log('  📎 Подзадачи...');
  const loadedSubtaskIds = new Set();
  const walkedSubtaskParents = new Set();
  const partialSubtaskRootIds = new Set();

  async function mergeSubtaskComments(subtask) {
    const parentId = subtask.parent?.id;
    if (!parentId || !dealTasksById.has(parentId)) return;
    const loaded = await getDealCommentsResult(subtask.id);
    const raw = loaded.comments;
    const parentTask = dealTasksById.get(parentId);
    await preloadReportDayCallTranscriptions(raw, reportDate, transcriptionCache, transcriptionStats, {
      phones: await getTaskPhones(parentTask),
      managerAlias: managerCfg.alias,
      managerName: mgrPfName,
    });
    const parsed = tagTaskComments(await parseAll(raw), subtask, 'subtask', parentId);
    if (!commentsByTask[parentId]) commentsByTask[parentId] = [];
    if (!loaded.complete) {
      const priorSubtaskComments = (history.deals[String(parentId)]?.comments || [])
        .filter(c => String(c.sourceTaskId || '') === String(subtask.id));
      commentsByTask[parentId] = mergeCommentsById(commentsByTask[parentId], priorSubtaskComments);
      const deal = ensureDeal(history, parentId);
      deal.commentsLoaded = false;
      deal.commentsPartial = true;
    }
    if (!parsed.length) return;
    const parsedIds = new Set(parsed.map(c => String(c.id)));
    commentsByTask[parentId] = commentsByTask[parentId]
      .filter(c => !parsedIds.has(String(c.id)))
      .concat(parsed);
  }

  async function loadChildSubtasksRecursive(parentId, rootId = parentId) {
    if (!parentId || walkedSubtaskParents.has(parentId)) return;
    walkedSubtaskParents.add(parentId);

    let offset = 0;
    while (true) {
      let d;
      try {
        d = await pf('/task/list', {
          offset,
          pageSize: 100,
          filters: [{ type: 58, operator: 'equal', value: parentId }],
          fields: 'id,name,parent,status,dateTime,dataTags,template,assignees',
        });
      } catch {
        partialSubtaskRootIds.add(String(rootId));
        return;
      }

      const subtasks = d.tasks || [];
      for (const subtask of subtasks) {
        subtasksById.set(subtask.id, subtask);
        if (!loadedSubtaskIds.has(subtask.id)) {
          loadedSubtaskIds.add(subtask.id);
          await mergeSubtaskComments(subtask);
        }
        await loadChildSubtasksRecursive(subtask.id, rootId);
      }

      if (subtasks.length < 100) break;
      offset += 100;
    }
  }

  for (const task of dealTasks) {
    await loadChildSubtasksRecursive(task.id, task.id);
  }

  for (const subtask of subtasksById.values()) {
    if (!loadedSubtaskIds.has(subtask.id)) {
      loadedSubtaskIds.add(subtask.id);
      await mergeSubtaskComments(subtask);
    }
    await loadChildSubtasksRecursive(subtask.id, subtask.parent?.id || subtask.id);
  }

  for (const task of dealTasks) {
    if (partialSubtaskRootIds.has(String(task.id))) {
      const existing = history.deals[String(task.id)]?.comments || [];
      commentsByTask[task.id] = mergeCommentsById(existing, commentsByTask[task.id] || []);
    }
    commentsByTask[task.id] = (commentsByTask[task.id] || []).sort((a, b) => itemStamp(a) - itemStamp(b));
    if (partialSubtaskRootIds.has(String(task.id))) {
      const deal = ensureDeal(history, task.id);
      deal.commentsLoaded = false;
      deal.commentsPartial = true;
    }
  }
  console.log('    ✅');

  console.log('  👤 Контрагенты...');
  const contactCallsByTask = {};
  const contactCallCache = {};
  const partialContactTasks = new Set();

  async function getCachedContactCalls(contactId) {
    if (contactCallCache[contactId]) return contactCallCache[contactId];

    const rawComments = [];
    let offset = 0;
    let complete = true;

    while (true) {
      let d = null;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          d = await pf(`/contact/${contactId}/comments/list`, {
            offset,
            pageSize: 100,
            fields: 'id,description,dateTime,owner,files',
          });
          break;
        } catch (e) {
          if (attempt < 4) {
            await sleep(1500 * attempt);
            continue;
          }
          const msg = e?.message || e;
          if (!offset) {
            console.log(`    ⚠️ Contact ${contactId}: не удалось загрузить комментарии (${msg})`);
            complete = false;
          } else {
            console.log(`    ⚠️ Contact ${contactId}: остановка на offset=${offset} (${msg}), использую частичные данные`);
            complete = false;
          }
        }
      }

      if (!d) break;

      const comments = d.comments || [];
      rawComments.push(...comments);
      if (comments.length < 100) break;
      offset += 100;
      await sleep(250);
    }

    if (!rawComments.length) {
      contactCallCache[contactId] = { calls: [], complete };
      return contactCallCache[contactId];
    }

    const contactInfo = await getContactInfo(contactId);
    await preloadReportDayCallTranscriptions(rawComments, reportDate, transcriptionCache, transcriptionStats, {
      phones: contactInfo.phones,
      managerAlias: managerCfg.alias,
      managerName: mgrPfName,
    });
    const parsedCalls = [];
    for (const c of rawComments) {
      const parsed = await parseComment(c, reportDate, transcriptionCache, true);
      if (parsed.type !== 'outCall' && parsed.type !== 'inCall' && parsed.type !== 'ndz') continue;
      parsedCalls.push({ ...parsed, source: 'contact' });
    }

    contactCallCache[contactId] = { calls: parsedCalls, complete };
    return contactCallCache[contactId];
  }

  async function loadContactCalls(contactId, taskId) {
    const { calls: parsedCalls, complete } = await getCachedContactCalls(contactId);
    if (!complete) partialContactTasks.add(String(taskId));

    for (const parsedBase of parsedCalls) {
      const parsed = { ...parsedBase };
      const existing = [...(commentsByTask[taskId] || []), ...(contactCallsByTask[taskId] || [])];
      const isDupe = existing.some(e =>
        (e.type === 'outCall' || e.type === 'inCall' || e.type === 'ndz') &&
        e.date === parsed.date &&
        Math.abs(timeToMinNode(e.time) - timeToMinNode(parsed.time)) < 5,
      );

      if (!isDupe) {
        if (!contactCallsByTask[taskId]) contactCallsByTask[taskId] = [];
        contactCallsByTask[taskId].push(parsed);
      }
    }
  }

  for (const task of dealTasks) {
    const cpId = String(task.counterparty?.id || '').replace('contact:', '');
    if (!cpId) continue;

    await loadContactCalls(cpId, task.id);

    try {
      const contactInfo = await getContactInfo(cpId);
      for (const phone of contactInfo.phones) {
        const norm = normalizePhone(phone);
        if (!norm || norm.length < 10) continue;

        const search = await pf('/contact/list', {
          offset: 0,
          pageSize: 100,
          fields: 'id,phones',
          filters: [{ type: 61, operator: 'contain', value: norm.slice(-10) }],
        });

        for (const dup of (search.contacts || [])) {
          const dupId = String(dup.id);
          if (dupId === cpId) continue;
          const dupPhones = (dup.phones || []).map(dp => normalizePhone(dp.number));
          if (dupPhones.includes(norm)) {
            console.log(`    📞 Дубль: contact:${dupId} → сделка #${task.id}`);
            await loadContactCalls(dupId, task.id);
          }
        }
      }
    } catch {}

    await sleep(100);
  }

  for (const taskId of Object.keys(contactCallsByTask)) {
    contactCallsByTask[taskId].sort((a, b) => itemStamp(a) - itemStamp(b));
  }

  for (const taskId of partialContactTasks) {
    const deal = history.deals[String(taskId)];
    if (!deal?.contactCalls?.length) continue;
    contactCallsByTask[taskId] = mergeCommentsById(deal.contactCalls, contactCallsByTask[taskId] || [])
      .sort((a, b) => itemStamp(a) - itemStamp(b));
  }
  console.log('    ✅');
  console.log(`  🎤 Звонки дня без текста: ${transcriptionStats.queued} новых, ${transcriptionStats.transcribed} расшифровано, ${transcriptionStats.cached} взято из базы, ${transcriptionStats.failed} не получилось, ${transcriptionStats.noFileId} без file id`);
  if (transcriptionStats.mangoTried || transcriptionStats.mangoMatched || transcriptionStats.mangoTranscribed) {
    console.log(`  🥭 Mango fallback: ${transcriptionStats.mangoTried} проверено, ${transcriptionStats.mangoMatched} найдено, ${transcriptionStats.mangoTranscribed} расшифровано, ${transcriptionStats.mangoCached} из кэша, ${transcriptionStats.mangoFailed} не получилось`);
  }

  const dealTaskIdSet = new Set(dealTasks.map(task => task.id));
  const callKeys = [];
  const analysisKeys = [];
  for (const task of dealTasks) {
    for (const dt of (task.dataTags || [])) {
      if (dt.dataTag.id === CALL_TAG) callKeys.push({ taskId: task.id, key: dt.key });
      if (dt.dataTag.id === ANALYSIS_TAG) analysisKeys.push({ taskId: task.id, key: dt.key });
    }
  }
  for (const subtask of subtasksById.values()) {
    const parentId = subtask.parent?.id;
    if (!parentId || !dealTaskIdSet.has(parentId)) continue;
    for (const dt of (subtask.dataTags || [])) {
      if (dt.dataTag.id === CALL_TAG) callKeys.push({ taskId: parentId, key: dt.key });
      if (dt.dataTag.id === ANALYSIS_TAG) analysisKeys.push({ taskId: parentId, key: dt.key });
    }
  }

  async function loadFilteredEntries(tagId, dateField, fields) {
    const result = {};
    let offset = 0;

    while (true) {
      let d;
      try {
        d = await pf(`/datatag/${tagId}/entry/list`, {
          offset,
          pageSize: 100,
          fields: `key,${fields}`,
          filters: [{
            type: 3101,
            field: dateField,
            operator: 'equal',
            value: { dateType: 'otherRange', dateFrom: reportDate, dateTo: reportDate },
          }],
        });
      } catch (e) {
        console.log(`  ⚠️ DataTag ${tagId}: ${e.message}`);
        break;
      }

      const entries = d.dataTagEntries || [];
      if (!entries.length) break;
      for (const entry of entries) result[entry.key] = parseCfd(entry);
      if (entries.length < 100) break;
      offset += 100;
      await sleep(50);
    }

    return result;
  }

  console.log(`  📞 Звонки за ${reportDate}...`);
  const allCallEntries = await loadFilteredEntries(CALL_TAG, 58528, '58528,58530,58532,58534,58536,58538,58542');
  console.log(`    ✅ ${Object.keys(allCallEntries).length}`);

  console.log(`  🔍 Анализы за ${reportDate}...`);
  const allAnalysisEntries = await loadFilteredEntries(ANALYSIS_TAG, 58628, '58628,58630,58634,58646,58648,58650,58652,58654,58656');
  console.log(`    ✅ ${Object.keys(allAnalysisEntries).length}`);

  const callsByTask = {};
  for (const { taskId, key } of callKeys) {
    const call = allCallEntries[key];
    if (!call) continue;
    if (!callsByTask[taskId]) callsByTask[taskId] = [];
    callsByTask[taskId].push({
      key,
      date: call['Дата'] || '',
      time: call['Время'] || '',
      type: call['Тип'] || '',
      duration: parseInt(call['Продолжительность (сек.)'] || '0', 10) || 0,
      employee: call['Сотрудник'] || '',
      contact: call['Контакт'] || '',
      phone: call['Номер контакта'] || '',
      source: 'datatag',
    });
  }

  const analysisByTask = {};
  for (const { taskId, key } of analysisKeys) {
    const analysis = allAnalysisEntries[key];
    if (!analysis) continue;
    const ballsStr = analysis['Баллы'] || '';
    const scoreMatch = ballsStr.match(/=\s*(\d+)\s*\/\s*(\d+)/);
    const totalBalls = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
    if (!analysisByTask[taskId]) analysisByTask[taskId] = [];
    analysisByTask[taskId].push({
      key,
      date: (analysis['Дата'] || '').substring(0, 10),
      time: (analysis['Дата'] || '').substring(11),
      employee: analysis['Сотрудник'] || '',
      topic: analysis['Тема звонка'] || '',
      howWeWork: analysis['Рассказал как работаем'] || '',
      callToAction: analysis['Призыв к действию'] || '',
      sentInvoice: analysis['Скинул счёт'] || '',
      allFour: analysis['Все 4 момента выполнены'] || '',
      ballsRaw: ballsStr,
      totalBalls,
      verdict: analysis['Вердикт'] || '',
    });
  }

  const dealCards = dealTasks.map(task => {
    const cf = {};
    for (const c of (task.customFieldData || [])) cf[c.field.id] = { value: c.value, str: c.stringValue || '' };

    const calls = (callsByTask[task.id] || []).filter(c => (c.employee || '').includes(mgrPfName));
    const analyses = (analysisByTask[task.id] || []).filter(a => (a.employee || '').includes(mgrPfName));
    const taskComments = commentsByTask[task.id] || [];
    const contactCalls = contactCallsByTask[task.id] || [];
    const comments = [...taskComments, ...contactCalls].sort((a, b) => itemStamp(a) - itemStamp(b));
    const totalDuration = calls.reduce((sum, call) => sum + (call.duration || 0), 0);
    const createdDate = task.dateTime?.date || task.dateCreated?.date || '';
    const isNew = createdDate === reportDate && (task.status?.name || '') !== 'Новая';

    const card = {
      id: task.id,
      name: task.name,
      status: task.status?.name || '?',
      template: task.template?.name || '',
      counterparty: task.counterparty?.name || '—',
      dateCreated: createdDate,
      dealSum: parseFloat(cf[67906]?.value || 0) || 0,
      workDesc: extractWorkDesc(task.name),
      isActive: !SKIP_STATUSES.includes(task.status?.name || ''),
      isNew,
      calls,
      analyses,
      comments,
      totalCalls: calls.length,
      totalDuration,
      totalAnalyses: analyses.length,
      avgBalls: analyses.length
        ? Math.round((analyses.reduce((sum, analysis) => sum + analysis.totalBalls, 0) / analyses.length) * 10) / 10
        : null,
      redFlags: [],
    };

    card.redFlags = detectRedFlags(card, mgrPfName, reportDate);
    return card;
  });

  for (const card of dealCards) {
    const deal = ensureDeal(history, card.id);
    rememberDealStatus(history, card, reportDate);
    deal.comments = commentsByTask[card.id] || [];
    if (!deal.commentsPartial) deal.commentsLoaded = true;
    if (partialContactTasks.has(String(card.id))) {
      deal.contactCalls = mergeCommentsById(deal.contactCalls || [], contactCallsByTask[card.id] || []);
      deal.contactCallsPartial = true;
    } else {
      deal.contactCalls = contactCallsByTask[card.id] || [];
      deal.contactCallsPartial = false;
    }
  }

  const totalActive = lightTasks.length
    ? lightTasks
      .filter(task => !(task.parent && task.parent.id))
      .filter(task => {
        const tplName = task.template?.name || '';
        if (!tplName) return true;
        return ALLOWED_TEMPLATES.some(at => tplName.toLowerCase().includes(at.toLowerCase()));
      })
      .filter(task => !SKIP_STATUSES.includes(task.status?.name || ''))
      .length
    : dealCards.filter(card => card.isActive).length;

  const dailyActivity = {
    newDeals: [],
    workedDeals: [],
    incomingDeals: [],
    totalActive,
  };

  for (const card of dealCards) {
    const createdOnDate = reportDateObj ? isSameDay(card.dateCreated, reportDateObj) : false;
    const hasManagerComment = card.comments.some(c => c.date === reportDate && c.owner && c.owner.includes(mgrPfName));
    const hasManagerCalls = card.calls.some(c => c.date === reportDate);
    const hasActivity = hasManagerComment || hasManagerCalls;
    const isOtherHuman = c =>
      c.date === reportDate &&
      c.owner &&
      !c.owner.includes(mgrPfName) &&
      !c.owner.toLowerCase().includes('robot') &&
      !(c.text || '').includes('целевое действие') &&
      !(c.text || '').includes('Статус изменён');

    if (createdOnDate) {
      dailyActivity.newDeals.push({
        id: card.id,
        name: card.name,
        status: card.status,
        counterparty: card.counterparty,
      });
    } else if (hasActivity) {
      const dayActions = card.comments
        .filter(c => c.date === reportDate && c.owner && c.owner.includes(mgrPfName))
        .map(c => ({ type: c.type, text: (c.text || '').substring(0, 100), time: c.time }));

      dailyActivity.workedDeals.push({
        id: card.id,
        name: card.name,
        status: card.status,
        counterparty: card.counterparty,
        actions: dayActions,
      });
    }

    if (!hasActivity && !createdOnDate) {
      const otherActions = card.comments
        .filter(isOtherHuman)
        .map(c => ({ type: c.type, text: (c.text || '').substring(0, 100), time: c.time, owner: c.owner }));
      if (otherActions.length) {
        dailyActivity.incomingDeals.push({
          id: card.id,
          name: card.name,
          status: card.status,
          counterparty: card.counterparty,
          dealSum: card.dealSum || 0,
          actions: otherActions,
        });
      }
    }
  }

  function buildDayActivityServer(dateDMY) {
    const dateObj = parsePfDate(dateDMY);
    const result = [];

    for (const card of dealCards) {
      const createdOnDate = dateObj ? isSameDay(card.dateCreated, dateObj) : false;
      const dayMgrComments = card.comments.filter(c => c.date === dateDMY && c.owner && c.owner.includes(mgrPfName));
      const dayCalls = card.calls.filter(c => c.date === dateDMY);
      const hasMgrActivity = dayMgrComments.length > 0 || dayCalls.length > 0;
      if (!hasMgrActivity && !createdOnDate) continue;

      const dayComments = hasMgrActivity ? card.comments.filter(c => c.date === dateDMY) : [];
      const actions = dayComments.map(c => ({
        type: c.type,
        time: c.time,
        text: c.text,
        owner: c.owner,
        transcription: c.transcription,
        source: c.source || 'deal',
        files: c.files || [],
      }));

      for (const call of dayCalls) {
        const isDupe = actions.some(a =>
          (a.type === 'outCall' || a.type === 'inCall' || a.type === 'ndz') &&
          Math.abs(timeToMinNode(a.time) - timeToMinNode(call.time)) < 5,
        );
        if (!isDupe) {
          actions.push({
            type: call.type === 'Входящий' ? 'inCall' : 'outCall',
            time: call.time,
            text: `${call.type} ${call.contact} ${call.phone}`.trim(),
            owner: call.employee,
            transcription: null,
            source: 'datatag',
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
        deal: {
          id: card.id,
          name: card.name,
          status: card.status,
          counterparty: card.counterparty,
          dateCreated: card.dateCreated,
          dealSum: card.dealSum || 0,
          workDesc: card.workDesc || '',
        },
        isNew: createdOnDate,
        actions,
        dayCalls: actions.filter(a => a.type === 'outCall' || a.type === 'inCall' || a.type === 'ndz').length,
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

  const aiCache = loadAiCache();
  const multiDayActivity = {};
  const multiDaySummary = {};
  const reportDayDeals = buildDayActivityServer(reportDate);

  console.log(`  🤖 День отчета ${reportDate}: ${reportDayDeals.length} сделок`);
  if (reportDayDeals.length && (DEEPSEEK_KEY || POLZA_KEY)) {
    const isSnow = name => (name || '').toLowerCase().startsWith('вывоз снега');
    const cached = reportDayDeals.filter(da => {
      const dealHist = history.deals[String(da.deal.id)];
      const key = `assess_${da.deal.id}_${reportDate}_${isSnow(da.deal.name) ? 'v20' : 'v20a'}`;
      return dealHist?.assessments?.[key];
    }).length;
    const needAi = reportDayDeals.length - cached;

    if (needAi > 0) {
      console.log(`  🤖 ИИ-оценка ${reportDayDeals.length} сделок за ${reportDate} (${cached} из истории)...`);
    } else {
      process.stdout.write(`  🤖 ${reportDate}: ${reportDayDeals.length} сделок (история) `);
    }

    let aiIdx = 0;
    await parallelMap(reportDayDeals, async (dealActivity) => {
      if (!isTimeUp()) dealActivity.aiAssessment = await aiDealFullAssessment(dealActivity, reportDate, history, true);
      aiIdx++;
      if (needAi > 0) process.stdout.write(`\r    [${aiIdx}/${reportDayDeals.length}]`);
    }, CONCURRENCY);

    if (needAi > 0) console.log('\n    ✅');
    else console.log('✅');

    multiDaySummary[reportDate] = await aiDaySummary(reportDayDeals, reportDate, aiCache, mgrAlias, true);
    saveHistory(history, reportDate);
  }

  multiDayActivity[reportDate] = reportDayDeals;

  const dealTasksMap = {};
  for (const task of dealTasks) dealTasksMap[task.id] = task;

  const historyDatesSet = new Set();
  for (const [, dealHist] of Object.entries(history.deals || {})) {
    for (const c of [...(dealHist.comments || []), ...(dealHist.contactCalls || [])]) {
      if (!c.date || c.date === reportDate || !reportDateObj) continue;
      const d = parsePfDate(c.date);
      if (!d) continue;
      const daysAgo = (reportDateObj - d) / 86400000;
      if (daysAgo > 0 && daysAgo <= 30) historyDatesSet.add(c.date);
    }
  }

  const pastDays = [...historyDatesSet].sort((a, b) => parsePfDate(b) - parsePfDate(a));
  console.log(`  📚 Прошлые дни из истории: ${pastDays.length}`);

  let pastAiGenerated = 0;
  for (const dayDMY of pastDays) {
    const dayDeals = buildDayFromHistory(history, dayDMY, dealTasksMap, mgrPfName);
    if (!dayDeals.length) continue;

    if ((DEEPSEEK_KEY || POLZA_KEY) && !isTimeUp()) {
      const needAi = dayDeals.filter(da => !da.aiAssessment);
      if (needAi.length) {
        if (!pastAiGenerated) console.log('  🤖 Догенерация ИИ-оценок за прошлые дни...');
        process.stdout.write(`    ${dayDMY}: ${needAi.length} сделок...`);
        for (const dealActivity of needAi) {
          if (isTimeUp()) break;
          dealActivity.aiAssessment = await aiDealFullAssessment(dealActivity, dayDMY, history, true);
          pastAiGenerated++;
        }
        console.log(' ✅');
      }
      multiDaySummary[dayDMY] = await aiDaySummary(dayDeals, dayDMY, aiCache, mgrAlias);
    }

    multiDayActivity[dayDMY] = dayDeals;
  }

  if (pastAiGenerated) {
    console.log(`  📊 Догенерировано ИИ-оценок за прошлые дни: ${pastAiGenerated}`);
    saveHistory(history, reportDate);
  }

  const incomingByDate = {};
  function addIncoming(dealId, dealName, dealStatus, dealCounterparty, dealSum, comments) {
    for (const c of comments) {
      if (!c.date) continue;
      const ownerLow = (c.owner || '').toLowerCase();
      if (!c.owner || c.owner.includes(mgrPfName) || ownerLow.includes('robot') || ownerLow.includes('робот')) continue;
      if ((c.text || '').includes('целевое действие') || (c.text || '').includes('Статус изменён')) continue;
      if (!incomingByDate[c.date]) incomingByDate[c.date] = [];

      const action = { type: c.type, text: (c.text || '').substring(0, 100), time: c.time, owner: c.owner };
      const existing = incomingByDate[c.date].find(d => d.id === dealId);
      if (existing) {
        const hasSameAction = existing.actions.some(a =>
          a.time === action.time &&
          a.owner === action.owner &&
          a.type === action.type &&
          a.text === action.text,
        );
        if (!hasSameAction) existing.actions.push(action);
      } else {
        incomingByDate[c.date].push({
          id: dealId,
          name: dealName,
          status: dealStatus,
          counterparty: dealCounterparty,
          dealSum: dealSum || 0,
          actions: [action],
        });
      }
    }
  }

  for (const card of dealCards) {
    if (!card.isActive) continue;
    addIncoming(card.id, card.name, card.status, card.counterparty, card.dealSum, card.comments);
  }

  for (const [dealId, dealHist] of Object.entries(history.deals || {})) {
    const combinedPastComments = [
      ...(dealHist.comments || []),
      ...(dealHist.contactCalls || []),
    ].filter(c => c.date && c.date !== reportDate);

    if (!combinedPastComments.length) continue;

    const task = dealTasksMap[Number(dealId)];
    const cf = {};
    if (task) {
      for (const c of (task.customFieldData || [])) cf[c.field.id] = { value: c.value };
    }

    addIncoming(
      Number(dealId),
      task?.name || dealHist.name || '?',
      task?.status?.name || dealHist.status || '?',
      task?.counterparty?.name || dealHist.counterparty || '—',
      task ? (parseFloat(cf[67906]?.value || 0) || 0) : 0,
      combinedPastComments,
    );
  }

  const newDealAnalyses = [];
  for (const card of dealCards) {
    if (!card.isNew) continue;
    for (const analysis of card.analyses) {
      newDealAnalyses.push({ ...analysis, dealId: card.id, dealName: card.name });
    }
  }

  const scriptCompliance = {
    total: newDealAnalyses.length,
    howWeWork: newDealAnalyses.filter(a => a.howWeWork === 'Да').length,
    callToAction: newDealAnalyses.filter(a => a.callToAction === 'Да').length,
    sentInvoice: newDealAnalyses.filter(a => a.sentInvoice === 'Да').length,
    allFour: newDealAnalyses.filter(a => a.allFour === 'Да').length,
    avgScore: newDealAnalyses.length
      ? Math.round((newDealAnalyses.reduce((sum, analysis) => sum + analysis.totalBalls, 0) / newDealAnalyses.length) * 10) / 10
      : 0,
    details: newDealAnalyses,
  };

  const snapshotRoot = path.join(ROOT_DIR, 'funnel_snapshot.json');
  let snapshotFile = snapshotRoot;
  if (mgrAlias) {
    const perManagerSnapshot = path.join(ROOT_DIR, 'data', `${mgrAlias}_funnel.json`);
    if (!fs.existsSync(perManagerSnapshot) && fs.existsSync(snapshotRoot)) {
      try { fs.copyFileSync(snapshotRoot, perManagerSnapshot); } catch {}
    }
    snapshotFile = perManagerSnapshot;
  }

  const prevSnapshot = loadPreviousSnapshot(snapshotFile);
  const activeCardIds = new Set(dealCards.map(card => card.id));
  const funnelCards = lightTasks.length
    ? [
      ...dealCards,
      ...lightTasks
        .filter(task => !activeCardIds.has(task.id))
        .filter(isAllowedDealTask)
        .map(makeFunnelCardFromTask),
    ]
    : dealCards;

  const funnelChanges = computeFunnelChanges(prevSnapshot, funnelCards);
  for (const card of funnelCards) rememberDealStatus(history, card, reportDate);
  saveSnapshot(funnelCards, snapshotFile);

  const allCalls = dealCards.flatMap(card => card.calls);
  const allAnalyses = dealCards.flatMap(card => card.analyses);
  const managerSummaries = { day: null, week: null, month: null };

  if (DEEPSEEK_KEY || POLZA_KEY) {
    console.log('\n👔 Генерация отчета для руководителя...');
    managerSummaries.day = await aiManagerSummary(multiDayActivity, multiDaySummary, dealCards, funnelChanges, 1, reportDate, aiCache, mgrAlias, true);
    if (managerSummaries.day) process.stdout.write('  ✅ День ');
    managerSummaries.week = await aiManagerSummary(multiDayActivity, multiDaySummary, dealCards, funnelChanges, 7, reportDate, aiCache, mgrAlias, true);
    if (managerSummaries.week) process.stdout.write('✅ Неделя ');
    managerSummaries.month = await aiManagerSummary(multiDayActivity, multiDaySummary, dealCards, funnelChanges, 30, reportDate, aiCache, mgrAlias, true);
    if (managerSummaries.month) console.log('✅ Месяц');
    saveAiCache(aiCache);
  }

  saveHistory(history, reportDate);
  const measurementData = await buildCompanyMeasurementsBundle(reportDate, history);
  saveHistory(history, reportDate);

  console.log(`  📊 Дневная активность: ${dailyActivity.newDeals.length} новых, ${dailyActivity.workedDeals.length} обработано`);
  console.log(`  🔄 Изменения воронки: ${funnelChanges.length}`);
  console.log(`  📝 Скрипт новых: ${scriptCompliance.total} анализов`);
  console.log(`  📐 Замеров найдено: ${measurementData.measurements.length}`);

  return {
    dealCards,
    dailyReports,
    allCalls,
    allAnalyses,
    dailyActivity,
    funnelCards,
    funnelChanges,
    scriptCompliance,
    dailyDealActivity: reportDayDeals,
    aiDaySummaryText: multiDaySummary[reportDate] || null,
    multiDayActivity,
    multiDaySummary,
    managerSummaries,
    incomingByDate,
    snapshotDate: prevSnapshot?.date || null,
    ...measurementData,
    measurementsComparison: buildMeasurementsComparison(
      (measurementData.measurements || []).filter(matchesCurrentMeasurementManager),
      reportDate,
    ),
  };
}

module.exports = { getManagerDeals, getDealComments, parseComment, buildDealCards, buildCompanyMeasurementsBundle };
