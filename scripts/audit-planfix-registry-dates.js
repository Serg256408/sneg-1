#!/usr/bin/env node

const { pf, getPlanfixRestStats, diffPlanfixRestStats, savePlanfixRestUsage } = require('../src/api/planfix');
const { fs, path, ROOT_DIR, MANAGERS_LIST, ALLOWED_TEMPLATES, SKIP_STATUSES } = require('../src/utils/config');

const DIRECTORY_ID = 16572;
const FIELD_DATE = 34134;
const FIELD_EMPLOYEE = 34136;
const FIELD_TASK_ID = 34138;
const FIELD_TASK_NAME = 34140;
const DIR_FIELDS = `key,${FIELD_DATE},${FIELD_EMPLOYEE},${FIELD_TASK_ID},${FIELD_TASK_NAME}`;
const MIN_USEFUL_TRANSCRIPT_CHARS = 20;

function usage() {
  console.log('Usage: node scripts/audit-planfix-registry-dates.js DD-MM-YYYY[,DD-MM-YYYY|..DD-MM-YYYY] [managerAlias,managerAlias]');
  console.log('Example: node scripts/audit-planfix-registry-dates.js 30-05-2026..05-06-2026 borovaya,guzairov');
}

function parseDMY(value) {
  const m = String(value || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

function formatDMY(date) {
  return [
    String(date.getDate()).padStart(2, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    date.getFullYear(),
  ].join('-');
}

function expandDates(raw) {
  const dates = [];
  for (const part of String(raw || '').split(',').map(v => v.trim()).filter(Boolean)) {
    if (part.includes('..')) {
      const [fromRaw, toRaw] = part.split('..').map(v => v.trim());
      const from = parseDMY(fromRaw);
      const to = parseDMY(toRaw);
      if (!from || !to || from > to) throw new Error(`Invalid date range: ${part}`);
      for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) dates.push(formatDMY(d));
    } else {
      if (!parseDMY(part)) throw new Error(`Invalid date: ${part}`);
      dates.push(part);
    }
  }
  return [...new Set(dates)];
}

function parseArgs() {
  const dateArg = process.argv[2] || '';
  if (!dateArg) {
    usage();
    process.exit(1);
  }
  const dates = expandDates(dateArg);
  const aliases = String(process.argv[3] || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
  return { dates, aliases };
}

function fieldMap(entry) {
  const fields = {};
  for (const cf of entry.customFieldData || []) fields[String(cf.field?.id || '')] = cf;
  return fields;
}

function managerMaps(aliases) {
  const managers = (MANAGERS_LIST || [])
    .filter(m => !aliases.length || aliases.includes(String(m.alias || '').toLowerCase()));
  const byUserId = new Map();
  for (const manager of managers) byUserId.set(String(manager.userId), manager);
  return { managers, byUserId };
}

function normalizeEmployeeId(value) {
  return String(value || '').replace(/^user:/, '');
}

function isAllowedReportTask(task) {
  if (!task) return false;
  if (task.parent?.id) return false;
  if (SKIP_STATUSES.includes(task.status?.name || '')) return false;
  const templateName = task.template?.name || '';
  if (!templateName) return true;
  return ALLOWED_TEMPLATES.some(item => templateName.toLowerCase().includes(item.toLowerCase()));
}

async function loadTaskBrief(taskId) {
  try {
    const data = await pf('/task/list', {
      offset: 0,
      pageSize: 1,
      filters: [{ type: 57, operator: 'equal', value: Number(taskId) }],
      fields: 'id,name,parent,status,template',
    });
    return (data.tasks || [])[0] || null;
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function localDayItems(report, date) {
  if (!report) return [];
  if (report.reportDate === date && Array.isArray(report.dailyDealActivity)) return report.dailyDealActivity;
  return report.multiDayActivity?.[date] || [];
}

function hasRecordingFile(comment) {
  return (comment.files || []).some(file => /\u0437\u0430\u043f\u0438\u0441\u044c\s+\u0437\u0432\u043e\u043d\u043a\u0430/i.test(file.name || ''));
}

function isCallLike(comment) {
  const type = String(comment.type || '').toLowerCase();
  return type.includes('call') || type === 'ndz' || hasRecordingFile(comment);
}

function hasUsefulTranscript(comment) {
  return String(comment.transcription || '').trim().length >= MIN_USEFUL_TRANSCRIPT_CHARS;
}

function localStats(report, date) {
  const items = localDayItems(report, date);
  const comments = items
    .flatMap(item => item.allComments || item.comments || [])
    .filter(comment => comment.date === date);
  const callComments = comments.filter(isCallLike);
  const recordingComments = callComments.filter(hasRecordingFile);
  const missingRecordingTranscripts = recordingComments.filter(comment => !hasUsefulTranscript(comment));
  const shortTranscripts = recordingComments.filter(comment => {
    const length = String(comment.transcription || '').trim().length;
    return length > 0 && length < MIN_USEFUL_TRANSCRIPT_CHARS;
  });
  return {
    reportDate: report?.reportDate || '',
    generated: report?.generated || '',
    deals: items.length,
    ids: items.map(item => Number(item.deal?.id || 0)).filter(Boolean),
    assessed: items.filter(item => item.aiAssessment).length,
    callComments: callComments.length,
    recordingComments: recordingComments.length,
    missingRecordingTranscripts: missingRecordingTranscripts.length,
    shortTranscripts: shortTranscripts.length,
    missingTranscriptIds: missingRecordingTranscripts
      .map(comment => comment.sourceTaskId || comment.taskId || '')
      .filter(Boolean),
  };
}

async function loadRegistry(dates, managers) {
  const wantedDates = new Set(dates);
  const wantedUsers = new Set(managers.map(m => String(m.userId)));
  const byKey = new Map();

  for (let offset = 0; ; offset += 100) {
    const data = await pf(`/directory/${DIRECTORY_ID}/entry/list`, {
      offset,
      pageSize: 100,
      fields: DIR_FIELDS,
    });
    const entries = data.directoryEntries || [];

    for (const entry of entries) {
      const fields = fieldMap(entry);
      const date = fields[FIELD_DATE]?.stringValue || '';
      const employeeId = normalizeEmployeeId(fields[FIELD_EMPLOYEE]?.value?.id);
      const taskId = Number(fields[FIELD_TASK_ID]?.value?.id || 0);
      const taskName = fields[FIELD_TASK_NAME]?.value?.name || fields[FIELD_TASK_NAME]?.stringValue || '';
      if (!wantedDates.has(date) || !wantedUsers.has(employeeId) || !taskId) continue;
      const key = `${date}|${employeeId}`;
      if (!byKey.has(key)) byKey.set(key, new Map());
      byKey.get(key).set(taskId, taskName);
    }

    if (entries.length < 100) break;
  }

  return byKey;
}

async function classifyMissing(rawIds, localIds) {
  const local = new Set(localIds.map(Number));
  const missingRaw = rawIds.filter(id => !local.has(Number(id)));
  const unloadable = [];
  const nonReportable = [];
  const reportableMissing = [];

  for (const id of missingRaw) {
    const task = await loadTaskBrief(id);
    if (!task) {
      unloadable.push(id);
    } else if (!isAllowedReportTask(task)) {
      nonReportable.push({
        id,
        name: task.name || '',
        status: task.status?.name || '',
        template: task.template?.name || '',
        parentId: task.parent?.id || null,
      });
    } else {
      reportableMissing.push({
        id,
        name: task.name || '',
        status: task.status?.name || '',
        template: task.template?.name || '',
      });
    }
  }

  return { missingRaw, unloadable, nonReportable, reportableMissing };
}

async function main() {
  const { dates, aliases } = parseArgs();
  const { managers } = managerMaps(aliases);
  if (!managers.length) throw new Error('No managers matched.');

  const started = getPlanfixRestStats();
  const registry = await loadRegistry(dates, managers);
  const reports = new Map(managers.map(manager => [
    manager.alias,
    readJson(path.join(ROOT_DIR, 'data', `${manager.alias}_latest.json`)),
  ]));

  const rows = [];
  for (const date of dates) {
    for (const manager of managers) {
      const rawMap = registry.get(`${date}|${manager.userId}`) || new Map();
      const rawIds = [...rawMap.keys()].sort((a, b) => a - b);
      const local = localStats(reports.get(manager.alias), date);
      const classified = await classifyMissing(rawIds, local.ids);
      rows.push({
        date,
        managerAlias: manager.alias,
        managerName: manager.name,
        rawPlanfixDeals: rawIds.length,
        localDeals: local.deals,
        assessed: local.assessed,
        callComments: local.callComments,
        recordingComments: local.recordingComments,
        missingRecordingTranscripts: local.missingRecordingTranscripts,
        shortTranscripts: local.shortTranscripts,
        reportableMissing: classified.reportableMissing,
        unloadable: classified.unloadable,
        nonReportable: classified.nonReportable,
        rawIds,
        localIds: local.ids,
        localReportDate: local.reportDate,
        localGenerated: local.generated,
      });
    }
  }

  const usage = diffPlanfixRestStats(started);
  savePlanfixRestUsage({ scope: 'audit-planfix-registry-dates', total: usage.total, byEndpoint: usage.byEndpoint });

  console.log('AUDIT_TABLE');
  for (const row of rows) {
    const status = row.reportableMissing.length || row.missingRecordingTranscripts || row.shortTranscripts
      ? 'CHECK'
      : 'OK';
    console.log([
      status,
      row.date,
      row.managerAlias,
      `pfRaw=${row.rawPlanfixDeals}`,
      `local=${row.localDeals}`,
      `ai=${row.assessed}/${row.localDeals}`,
      `calls=${row.callComments}`,
      `rec=${row.recordingComments}`,
      `missTr=${row.missingRecordingTranscripts}`,
      `shortTr=${row.shortTranscripts}`,
      `missingDeals=${row.reportableMissing.map(item => `#${item.id}`).join(',') || '-'}`,
      `unloadable=${row.unloadable.map(id => `#${id}`).join(',') || '-'}`,
      `nonReportable=${row.nonReportable.map(item => `#${item.id}`).join(',') || '-'}`,
    ].join(' | '));
  }
  console.log('RESULT_JSON_START');
  console.log(JSON.stringify({ rows, usage }, null, 2));
  console.log('RESULT_JSON_END');
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
