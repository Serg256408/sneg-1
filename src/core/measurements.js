const { parsePfDate, timeToMinNode, stripHtml, pad2 } = require('../utils/helpers');

const STATUS_PREFIXES = ['Статус изменён на ', 'Статус изменен на '];
const MEASUREMENT_KEYWORDS = /(замер|замерщик|замерить|замер\s+на|осмотр|осмотреть)/i;
const PROGRESS_STATUSES = new Set([
  'Коммерческое предложение',
  'Клиент принимает решение',
  'Дожим',
  'Договор и Оплата',
  'Выполнение Работы',
  'Сделанная',
]);
const CONTRACT_STATUS = 'Договор и Оплата';
const WORK_STATUSES = new Set(['Выполнение Работы', 'Сделанная', 'Подготовка закрывающих документов']);
const CLOSED_LOST_STATUSES = new Set(['Сделка завершена', 'Сделка потеряна', 'Отложенная']);
const STALLED_AFTER_DAYS = 10;

function toDmy(dateStr) {
  if (!dateStr) return '';
  const d = parsePfDate(dateStr);
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
}

function dateStamp(dateStr, timeStr) {
  const d = parsePfDate(dateStr);
  if (!d || Number.isNaN(d.getTime())) return 0;
  return d.getTime() + (timeToMinNode(timeStr || '') * 60000);
}

function dateDiffDays(fromStr, toStr) {
  const from = parsePfDate(fromStr);
  const to = parsePfDate(toStr);
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

function clip(text, max = 180) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function isAiText(text) {
  const normalized = String(text || '').toLowerCase();
  return normalized.includes('ии-рекомендаци') ||
    normalized.includes('ии рекомендаци') ||
    normalized.includes('ai-рекомендаци') ||
    normalized.includes('рекомендации ии') ||
    normalized.includes('ии-оценка сделки') ||
    normalized.includes('баллы зп:');
}

function isMeaningfulText(text) {
  const normalized = clip(stripHtml(text || ''), 500);
  if (!normalized) return false;
  if (isAiText(normalized)) return false;
  if (extractStatusChange(normalized)) return false;
  return /[A-Za-zА-Яа-яЁё0-9]/.test(normalized);
}

function extractStatusChange(text) {
  const raw = String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/\r/g, '');
  for (const prefix of STATUS_PREFIXES) {
    const idx = raw.indexOf(prefix);
    if (idx < 0) continue;
    const status = raw
      .slice(idx + prefix.length)
      .split('\n')[0]
      .replace(/<[^>]*>/g, '')
      .trim();
    if (status) return status;
  }
  return '';
}

function parseTaskSum(task) {
  if (!task || !Array.isArray(task.customFieldData)) return 0;
  const field = task.customFieldData.find(cf => String(cf.field?.id) === '67906');
  const value = field?.value ?? field?.stringValue ?? 0;
  return parseFloat(String(value).replace(/\s/g, '').replace(',', '.')) || 0;
}

function getTaskAssignees(task) {
  return ((task?.assignees?.users) || [])
    .map(user => user?.name || '')
    .filter(Boolean);
}

function isMeasurementSubtask(task) {
  const hay = [
    task?.name || '',
    task?.status?.name || '',
    task?.template?.name || '',
  ].join(' ').toLowerCase();
  return hay.includes('замер');
}

function extractMeasurerFromText(text) {
  const raw = stripHtml(text || '');
  if (!raw) return '';
  const patterns = [
    /замерщик(?:а|у|ом)?\s+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/,
    /(?:приедет|будет)\s+(?:к вам\s+|у вас\s+|на объекте\s+)?(?:наш\s+)?(?:замерщик\s+)?([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/,
    /(?:на замер\s+приедет|замер провед[её]т)\s+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/,
  ];
  for (const re of patterns) {
    const match = raw.match(re);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function parseDateMention(text, commentDate) {
  const raw = stripHtml(text || '');
  const low = raw.toLowerCase();
  const base = parsePfDate(commentDate);
  if (!base || Number.isNaN(base.getTime())) return '';

  if (/послезавтра/.test(low)) {
    const d = new Date(base);
    d.setDate(d.getDate() + 2);
    return toDmy(d.toISOString().slice(0, 10));
  }
  if (/завтра/.test(low)) {
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    return toDmy(d.toISOString().slice(0, 10));
  }
  if (/сегодня/.test(low)) {
    return toDmy(commentDate);
  }

  const match = raw.match(/(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/);
  if (!match) return '';
  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (!day || !month || month > 12 || day > 31) return '';
  let year = match[3] ? parseInt(match[3], 10) : base.getFullYear();
  if (year < 100) year += 2000;
  const parsed = new Date(year, month - 1, day);
  if (Number.isNaN(parsed.getTime())) return '';
  if (!match[3] && parsed.getTime() < (base.getTime() - 7 * 86400000)) {
    parsed.setFullYear(parsed.getFullYear() + 1);
  }
  return `${pad2(parsed.getDate())}-${pad2(parsed.getMonth() + 1)}-${parsed.getFullYear()}`;
}

function combineComments(dealHist) {
  return [
    ...(dealHist?.comments || []),
    ...(dealHist?.contactCalls || []),
  ].sort((a, b) => dateStamp(a.date, a.time) - dateStamp(b.date, b.time));
}

function collectStatusEvents(comments) {
  return comments
    .map(comment => {
      const status = extractStatusChange(comment.text || '');
      if (!status) return null;
      return {
        date: comment.date || '',
        time: comment.time || '',
        stamp: dateStamp(comment.date, comment.time),
        status,
        owner: comment.owner || '',
        text: comment.text || '',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.stamp - b.stamp);
}

function buildTaskMaps(allTasks, activeDealTasks, activeSubtasks) {
  const taskById = new Map();
  const dealTaskById = new Map();
  const subtasksByParent = new Map();
  const appendTask = (task) => {
    if (!task?.id) return;
    const current = taskById.get(task.id) || {};
    taskById.set(task.id, { ...current, ...task });
  };

  for (const task of allTasks || []) appendTask(task);
  for (const task of activeDealTasks || []) appendTask(task);
  for (const task of activeSubtasks || []) appendTask(task);

  for (const task of taskById.values()) {
    if (task.parent?.id) {
      const parentId = Number(task.parent.id);
      if (!subtasksByParent.has(parentId)) subtasksByParent.set(parentId, []);
      subtasksByParent.get(parentId).push(task);
    } else {
      dealTaskById.set(Number(task.id), task);
    }
  }

  for (const subtasks of subtasksByParent.values()) {
    subtasks.sort((a, b) => dateStamp(a?.dateTime?.date, a?.dateTime?.time) - dateStamp(b?.dateTime?.date, b?.dateTime?.time));
  }

  return { taskById, dealTaskById, subtasksByParent };
}

function buildBaseRecords({ dealId, task, comments, statusEvents, subtasks }) {
  const bases = [];

  for (const subtask of subtasks || []) {
    if (!isMeasurementSubtask(subtask)) continue;
    bases.push({
      source: 'subtask',
      rawId: String(subtask.id),
      date: toDmy(subtask?.dateTime?.date),
      time: subtask?.dateTime?.time || '',
      stamp: dateStamp(subtask?.dateTime?.date, subtask?.dateTime?.time),
      measurer: getTaskAssignees(subtask).join(', '),
      title: subtask?.name || '',
    });
  }

  for (const event of statusEvents) {
    if (event.status !== 'Замер') continue;
    bases.push({
      source: 'status',
      rawId: `synthetic-${dealId}-${event.date}`,
      date: event.date,
      time: event.time,
      stamp: event.stamp,
      measurer: '',
      title: event.text || 'Статус изменён на Замер',
    });
  }

  if (!bases.length && (task?.status?.name || '') === 'Замер') {
    const measurementComment = comments.find(comment => MEASUREMENT_KEYWORDS.test(stripHtml(comment.text || comment.transcription || '')));
    const fallbackDate = measurementComment?.date || toDmy(task?.dateTime?.date);
    bases.push({
      source: 'current-status',
      rawId: `synthetic-${dealId}-${fallbackDate || 'current'}`,
      date: fallbackDate,
      time: measurementComment?.time || task?.dateTime?.time || '',
      stamp: dateStamp(fallbackDate, measurementComment?.time || task?.dateTime?.time || ''),
      measurer: '',
      title: task?.name || 'Замер',
    });
  }

  bases.sort((a, b) => a.stamp - b.stamp);
  const deduped = [];
  for (const base of bases) {
    if (!base.date) continue;
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(base.stamp - last.stamp) <= 36 * 60 * 60 * 1000) {
      if (!last.measurer && base.measurer) last.measurer = base.measurer;
      if (last.source !== 'subtask' && base.source === 'subtask') {
        last.source = base.source;
        last.rawId = base.rawId;
        last.title = base.title;
        last.time = base.time;
        last.stamp = base.stamp || last.stamp;
      }
      continue;
    }
    deduped.push({ ...base });
  }
  return deduped;
}

function buildDailySummary(measurements, dealTaskById, reportDate) {
  const dayMap = new Map();
  const ensure = (date) => {
    if (!date) return null;
    if (!dayMap.has(date)) {
      dayMap.set(date, {
        date,
        dealsCreated: 0,
        enteredMeasurement: 0,
        scheduledMeasurements: 0,
        progressed: 0,
        toContract: 0,
        toWork: 0,
      });
    }
    return dayMap.get(date);
  };

  for (const task of dealTaskById.values()) {
    if ((task?.name || '').startsWith('Отчет')) continue;
    const day = ensure(toDmy(task?.dateTime?.date));
    if (day) day.dealsCreated++;
  }

  for (const measurement of measurements) {
    const entered = ensure(measurement.measurementCreatedAt);
    if (entered) entered.enteredMeasurement++;
    if (measurement.scheduledAt) {
      const scheduled = ensure(measurement.scheduledAt);
      if (scheduled) scheduled.scheduledMeasurements++;
    }
    if (measurement.progressedDate) {
      const progressed = ensure(measurement.progressedDate);
      if (progressed) progressed.progressed++;
    }
    if (measurement.contractDate) {
      const contract = ensure(measurement.contractDate);
      if (contract) contract.toContract++;
    }
    if (measurement.workDate) {
      const work = ensure(measurement.workDate);
      if (work) work.toWork++;
    }
  }

  const report = parsePfDate(reportDate);
  const yearStart = report ? new Date(report.getFullYear(), 0, 1) : null;
  const knownDates = [...dayMap.keys()].sort((a, b) => dateStamp(a, '00:00') - dateStamp(b, '00:00'));
  const firstDate = knownDates.length ? parsePfDate(knownDates[0]) : null;
  const startDate = yearStart && firstDate && firstDate > yearStart ? yearStart : (firstDate || yearStart);
  if (!startDate || !report) {
    return knownDates
      .map(date => dayMap.get(date))
      .sort((a, b) => dateStamp(a.date, '00:00') - dateStamp(b.date, '00:00'));
  }

  const filled = [];
  const cursor = new Date(startDate);
  while (cursor <= report) {
    const date = `${pad2(cursor.getDate())}-${pad2(cursor.getMonth() + 1)}-${cursor.getFullYear()}`;
    filled.push(dayMap.get(date) || {
      date,
      dealsCreated: 0,
      enteredMeasurement: 0,
      scheduledMeasurements: 0,
      progressed: 0,
      toContract: 0,
      toWork: 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return filled;
}

function buildSummaryObjects(measurements, dealTaskById, reportDate) {
  const byMeasurer = {};
  const outcomeCounts = {};

  for (const measurement of measurements) {
    outcomeCounts[measurement.outcome] = (outcomeCounts[measurement.outcome] || 0) + 1;
    const key = measurement.measurer || 'Не указан';
    if (!byMeasurer[key]) {
      byMeasurer[key] = {
        measurer: key,
        total: 0,
        scheduled: 0,
        progressed: 0,
        toContract: 0,
        toWork: 0,
        stalled: 0,
        sum: 0,
      };
    }
    const bucket = byMeasurer[key];
    bucket.total++;
    bucket.sum += measurement.dealSum || 0;
    if (measurement.scheduledAt) bucket.scheduled++;
    if (measurement.progressedDate) bucket.progressed++;
    if (measurement.contractDate) bucket.toContract++;
    if (measurement.workDate) bucket.toWork++;
    if (measurement.outcome === 'stalled') bucket.stalled++;
  }

  const daily = buildDailySummary(measurements, dealTaskById, reportDate);
  const report = parsePfDate(reportDate);
  const compareFrom = report ? new Date(report) : new Date();
  compareFrom.setDate(compareFrom.getDate() - 29);

  const compareInRange = (dateStr) => {
    const d = parsePfDate(dateStr);
    return !!d && d >= compareFrom && d <= report;
  };

  const compare30d = measurements.reduce((acc, measurement) => {
    if (compareInRange(measurement.measurementCreatedAt)) acc.enteredMeasurement++;
    if (compareInRange(measurement.scheduledAt)) acc.scheduledMeasurements++;
    if (compareInRange(measurement.progressedDate)) acc.progressed++;
    if (compareInRange(measurement.contractDate)) acc.toContract++;
    if (compareInRange(measurement.workDate)) acc.toWork++;
    if (measurement.outcome === 'stalled' && (
      compareInRange(measurement.measurementCreatedAt) ||
      compareInRange(measurement.lastRelevantActivityAt)
    )) acc.stalled++;
    return acc;
  }, {
    enteredMeasurement: 0,
    scheduledMeasurements: 0,
    progressed: 0,
    toContract: 0,
    toWork: 0,
    stalled: 0,
  });

  compare30d.contractRate = compare30d.enteredMeasurement
    ? Math.round(compare30d.toContract / compare30d.enteredMeasurement * 100)
    : 0;
  compare30d.workRate = compare30d.enteredMeasurement
    ? Math.round(compare30d.toWork / compare30d.enteredMeasurement * 100)
    : 0;

  return {
    defaultDays: 30,
    ytdStart: report ? `01-01-${report.getFullYear()}` : '',
    measurers: Object.keys(byMeasurer).sort((a, b) => a.localeCompare(b, 'ru')),
    outcomeCounts,
    byMeasurer: Object.values(byMeasurer).sort((a, b) => (b.total - a.total) || a.measurer.localeCompare(b.measurer, 'ru')),
    daily,
    totals: {
      total: measurements.length,
      scheduled: measurements.filter(item => item.scheduledAt).length,
      progressed: measurements.filter(item => item.progressedDate).length,
      toContract: measurements.filter(item => item.contractDate).length,
      toWork: measurements.filter(item => item.workDate).length,
      stalled: measurements.filter(item => item.outcome === 'stalled').length,
    },
    compare30d,
  };
}

function buildMeasurementsData({
  reportDate,
  managerName,
  managerAlias,
  history,
  allTasks,
  activeDealTasks,
  activeSubtasks,
}) {
  const { dealTaskById, subtasksByParent } = buildTaskMaps(allTasks, activeDealTasks, activeSubtasks);
  const dealIds = new Set([
    ...dealTaskById.keys(),
    ...Object.keys(history?.deals || {}).map(id => Number(id)),
    ...subtasksByParent.keys(),
  ]);

  const measurements = [];
  for (const dealId of dealIds) {
    const task = dealTaskById.get(Number(dealId));
    const dealHist = history?.deals?.[String(dealId)] || {};
    const comments = combineComments(dealHist);
    const statusEvents = collectStatusEvents(comments);
    const bases = buildBaseRecords({
      dealId: Number(dealId),
      task,
      comments,
      statusEvents,
      subtasks: subtasksByParent.get(Number(dealId)) || [],
    });

    if (!bases.length) continue;

    const dealCreatedAt = toDmy(task?.dateTime?.date) || toDmy(dealHist?.createdAt) || '';
    const dealName = task?.name || dealHist?.name || `Сделка #${dealId}`;
    const currentDealStatus = task?.status?.name || dealHist?.status || '?';
    const counterparty = task?.counterparty?.name || dealHist?.counterparty || '—';
    const dealSum = task ? parseTaskSum(task) : 0;

    for (let i = 0; i < bases.length; i++) {
      const base = bases[i];
      const nextBase = bases[i + 1];
      const nextStamp = nextBase?.stamp || Infinity;
      const windowComments = comments.filter(comment => {
        const stamp = dateStamp(comment.date, comment.time);
        return stamp >= base.stamp && stamp < nextStamp;
      });
      const windowStatuses = statusEvents.filter(event => event.stamp >= base.stamp && event.stamp < nextStamp);
      const measurementComments = windowComments.filter(comment =>
        MEASUREMENT_KEYWORDS.test(stripHtml(comment.text || comment.transcription || '')),
      );

      let scheduledAt = '';
      for (const comment of measurementComments) {
        scheduledAt = parseDateMention(comment.text || comment.transcription || '', comment.date);
        if (scheduledAt) break;
      }

      let measurer = base.measurer || '';
      if (!measurer) {
        for (const comment of measurementComments) {
          measurer = extractMeasurerFromText(comment.text || comment.transcription || '');
          if (measurer) break;
        }
      }
      if (!measurer) measurer = 'Не указан';

      const progressedEvent = windowStatuses.find(event => PROGRESS_STATUSES.has(event.status) && event.status !== 'Замер');
      const contractEvent = windowStatuses.find(event => event.status === CONTRACT_STATUS);
      const workEvent = windowStatuses.find(event => WORK_STATUSES.has(event.status));
      const closedEvent = windowStatuses.find(event => CLOSED_LOST_STATUSES.has(event.status));
      const latestMeaningful = [...windowComments].reverse().find(comment => isMeaningfulText(comment.text || comment.transcription || ''));
      const latestEvent = [...windowComments].reverse()[0] || null;
      const lastRelevantActivityAt = latestEvent?.date || base.date;

      let latestResultText = '';
      if (latestMeaningful) {
        latestResultText = clip(stripHtml(latestMeaningful.text || latestMeaningful.transcription || ''));
      } else if (workEvent) {
        latestResultText = `Статус переведен в ${workEvent.status}`;
      } else if (contractEvent) {
        latestResultText = `Статус переведен в ${contractEvent.status}`;
      } else if (progressedEvent) {
        latestResultText = `Статус переведен в ${progressedEvent.status}`;
      } else if (currentDealStatus) {
        latestResultText = currentDealStatus;
      }

      let outcome = 'unknown';
      if (workEvent) outcome = 'to_work';
      else if (contractEvent) outcome = 'to_contract';
      else if (progressedEvent) outcome = 'progressed';
      else if (closedEvent) outcome = 'closed_lost';
      else {
        const diff = dateDiffDays(lastRelevantActivityAt || base.date, reportDate);
        if (diff !== null && diff > STALLED_AFTER_DAYS) outcome = 'stalled';
      }

      const timeline = [{
        type: 'measurement',
        label: 'Замер создан',
        date: base.date,
        time: base.time || '',
      }];
      if (scheduledAt) {
        timeline.push({
          type: 'scheduled',
          label: 'Замер назначен',
          date: scheduledAt,
          time: '',
        });
      }
      if (progressedEvent && progressedEvent.status !== CONTRACT_STATUS && !WORK_STATUSES.has(progressedEvent.status)) {
        timeline.push({
          type: 'progressed',
          label: `Продвинуто: ${progressedEvent.status}`,
          date: progressedEvent.date,
          time: progressedEvent.time || '',
        });
      }
      if (contractEvent) {
        timeline.push({
          type: 'contract',
          label: 'Договор и оплата',
          date: contractEvent.date,
          time: contractEvent.time || '',
        });
      }
      if (workEvent) {
        timeline.push({
          type: 'work',
          label: `В работу: ${workEvent.status}`,
          date: workEvent.date,
          time: workEvent.time || '',
        });
      }
      if (closedEvent && !workEvent && !contractEvent) {
        timeline.push({
          type: 'closed',
          label: `Закрыто: ${closedEvent.status}`,
          date: closedEvent.date,
          time: closedEvent.time || '',
        });
      }
      if (latestResultText) {
        timeline.push({
          type: 'result',
          label: latestResultText,
          date: lastRelevantActivityAt || base.date,
          time: latestEvent?.time || '',
        });
      }

      measurements.push({
        id: base.source === 'subtask' ? Number(base.rawId) : String(base.rawId),
        dealId: Number(dealId),
        dealName,
        counterparty,
        dealCreatedAt,
        dealSum,
        manager: managerName,
        managerAlias,
        measurer,
        measurementCreatedAt: base.date,
        scheduledAt: scheduledAt || null,
        currentDealStatus,
        outcome,
        contractDate: contractEvent?.date || null,
        workDate: workEvent?.date || null,
        progressedDate: progressedEvent?.date || null,
        closedDate: closedEvent?.date || null,
        lastRelevantActivityAt,
        latestResultText,
        timeline,
      });
    }
  }

  measurements.sort((a, b) => dateStamp(b.measurementCreatedAt, '23:59') - dateStamp(a.measurementCreatedAt, '00:00'));
  const measurementsSummary = buildSummaryObjects(measurements, dealTaskById, reportDate);
  return {
    measurements,
    measurementsSummary,
    measurementsComparison: measurementsSummary.compare30d,
  };
}

module.exports = {
  buildMeasurementsData,
  extractStatusChange,
};
