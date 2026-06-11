// ============================================================
// planfix.js — HTTP-клиент и Planfix API
// ============================================================

const { fs, path, os, ROOT_DIR, API_URL, TOKEN, AUTH, DEAL_FIELDS, MANAGERS_LIST } = require('../utils/config');
const { sleep } = require('../utils/helpers');

let useAxios = true, axios;
try { axios = require('axios'); } catch { useAxios = false; }

const restStats = {
  total: 0,
  byEndpoint: {},
  startedAt: new Date().toISOString(),
};
const restRunId = `${Date.now()}-${process.pid}`;
const REST_USAGE_FILE = path.join(ROOT_DIR, 'planfix_api_usage.json');

const rateLimitState = {
  active: false,
  remaining: null,
  timeToReset: null,
  message: '',
  endpoint: '',
};

const managerExecutorTaskCache = new Map();

function normalizeEndpoint(url) {
  const raw = String(url || '').replace(API_URL, '').replace(/\?.*$/, '');
  return raw
    .replace(/\/task\/\d+/g, '/task/:id')
    .replace(/\/contact\/\d+/g, '/contact/:id')
    .replace(/\/file\/\d+/g, '/file/:id');
}

function registerPlanfixRestRequest(method, url) {
  const endpoint = `${String(method || 'POST').toUpperCase()} ${normalizeEndpoint(url)}`;
  restStats.total += 1;
  restStats.byEndpoint[endpoint] = (restStats.byEndpoint[endpoint] || 0) + 1;
}

function topEndpointList(byEndpoint, limit = 8) {
  return Object.entries(byEndpoint || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([endpoint, count]) => ({ endpoint, count }));
}

function parseRateLimitDetails(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  if (!/rate limit exceeded|Rest API billing/i.test(text)) return null;
  const remaining = text.match(/remaining\s*:?\s*(\d+)/i);
  const timeToReset = text.match(/timeToReset\s*:?\s*(\d+)/i);
  return {
    remaining: remaining ? Number(remaining[1]) : null,
    timeToReset: timeToReset ? Number(timeToReset[1]) : null,
    message: text.replace(/\s+/g, ' ').slice(0, 300),
  };
}

function notePlanfixRateLimit(payload, endpoint = '') {
  const details = parseRateLimitDetails(payload);
  if (!details) return false;
  rateLimitState.active = true;
  rateLimitState.remaining = details.remaining;
  rateLimitState.timeToReset = details.timeToReset;
  rateLimitState.message = details.message;
  rateLimitState.endpoint = normalizeEndpoint(endpoint);
  return true;
}

function makePlanfixRateLimitError() {
  const reset = rateLimitState.timeToReset != null
    ? `, timeToReset=${rateLimitState.timeToReset}s`
    : '';
  const endpoint = rateLimitState.endpoint ? ` (${rateLimitState.endpoint})` : '';
  const err = new Error(`Planfix REST API rate limit exceeded${reset}${endpoint}`);
  err.code = 'PLANFIX_RATE_LIMIT';
  err.planfixRateLimited = true;
  err.rateLimit = { ...rateLimitState };
  return err;
}

function isPlanfixRateLimitError(e) {
  return !!(e?.planfixRateLimited || e?.code === 'PLANFIX_RATE_LIMIT');
}

function isPlanfixRateLimited() {
  return rateLimitState.active;
}

function throwIfPlanfixRateLimited() {
  if (rateLimitState.active) throw makePlanfixRateLimitError();
}

function getPlanfixRestStats() {
  return {
    runId: restRunId,
    ...restStats,
    byEndpoint: { ...restStats.byEndpoint },
    topEndpoints: topEndpointList(restStats.byEndpoint),
    updatedAt: new Date().toISOString(),
    rateLimit: { ...rateLimitState },
  };
}

function diffPlanfixRestStats(before, after = getPlanfixRestStats()) {
  const beforeByEndpoint = before?.byEndpoint || {};
  const afterByEndpoint = after?.byEndpoint || {};
  const byEndpoint = {};
  const endpoints = new Set([...Object.keys(beforeByEndpoint), ...Object.keys(afterByEndpoint)]);
  for (const endpoint of endpoints) {
    const count = (afterByEndpoint[endpoint] || 0) - (beforeByEndpoint[endpoint] || 0);
    if (count > 0) byEndpoint[endpoint] = count;
  }
  return {
    runId: after.runId || restRunId,
    total: Math.max(0, (after.total || 0) - (before?.total || 0)),
    cumulativeTotal: after.total || 0,
    startedAt: before?.updatedAt || before?.startedAt || restStats.startedAt,
    finishedAt: after.updatedAt || new Date().toISOString(),
    byEndpoint,
    topEndpoints: topEndpointList(byEndpoint),
    rateLimit: { ...(after.rateLimit || rateLimitState) },
  };
}

function savePlanfixRestUsage(extra = {}) {
  const stats = getPlanfixRestStats();
  const savedAt = new Date().toISOString();
  const record = {
    ...stats,
    ...extra,
    runId: extra.runId || stats.runId,
    savedAt,
  };

  let previous = {};
  try {
    if (fs.existsSync(REST_USAGE_FILE)) {
      previous = JSON.parse(fs.readFileSync(REST_USAGE_FILE, 'utf8')) || {};
    }
  } catch {}

  const records = Array.isArray(previous.records)
    ? previous.records
    : (Array.isArray(previous.runs) ? previous.runs : []);
  records.push(record);
  while (records.length > 200) records.shift();

  const payload = { updatedAt: savedAt, latest: record, records };
  const tmp = `${REST_USAGE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, REST_USAGE_FILE);
  return record;
}

function throwIfResponseIsRateLimited(payload, endpoint) {
  if (notePlanfixRateLimit(payload, endpoint)) throw makePlanfixRateLimitError();
}

async function httpPost(url, body, headers) {
  throwIfPlanfixRateLimited();
  registerPlanfixRestRequest('POST', url);
  if (useAxios) {
    try {
      const data = (await axios.post(url, body, { headers, timeout: 30000, maxRedirects: 10 })).data;
      throwIfResponseIsRateLimited(data, url);
      return data;
    } catch (e) {
      if (e.message?.includes('redirect')) { useAxios = false; return httpPost(url, body, headers); }
      throwIfResponseIsRateLimited(e.response?.data || e.message, url);
      throw e;
    }
  }
  const { execFileSync } = require('child_process');
  const tmp = path.join(os.tmpdir(), 'pf_' + Date.now() + '.json');
  try {
    fs.writeFileSync(tmp, JSON.stringify(body));
    const a = ['-s', '-L', '-X', 'POST', url];
    for (const [k, v] of Object.entries(headers || {})) a.push('-H', `${k}: ${v}`);
    a.push('-d', `@${tmp}`);
    const parsed = JSON.parse(execFileSync('curl', a, { encoding: 'utf8', timeout: 30000 }));
    throwIfResponseIsRateLimited(parsed, url);
    return parsed;
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

async function httpGet(url, headers) {
  throwIfPlanfixRateLimited();
  registerPlanfixRestRequest('GET', url);
  if (useAxios) {
    try {
      const data = (await axios.get(url, { headers, timeout: 30000 })).data;
      throwIfResponseIsRateLimited(data, url);
      return data;
    } catch (e) {
      throwIfResponseIsRateLimited(e.response?.data || e.message, url);
      throw e;
    }
  }
  const { execFileSync } = require('child_process');
  const a = ['-s', '-L', url];
  for (const [k, v] of Object.entries(headers || {})) a.push('-H', `${k}: ${v}`);
  const parsed = JSON.parse(execFileSync('curl', a, { encoding: 'utf8', timeout: 30000 }));
  throwIfResponseIsRateLimited(parsed, url);
  return parsed;
}

const pf = (ep, body) => httpPost(API_URL + ep, body, AUTH);
const pfGet = (ep) => httpGet(API_URL + ep, AUTH);

async function discoverEmployees() {
  const users = new Map();
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

const MAX_PARTICIPANT_TASKS = 2000; // лимит задач-участника (старые не нужны)

async function getAllTasks(userId, role) {
  const all = [];
  const executorTasks = [];
  let offset = 0;
  while (true) {
    process.stdout.write(`  Сделки (исполнитель) offset=${offset}...`);
    const d = await pf('/task/list', { offset, pageSize: 100,
      filters: [{ type: 97, operator: 'equal', value: `user:${userId}` }],
      fields: DEAL_FIELDS,
    });
    const tasks = d.tasks || [];
    console.log(` ${tasks.length}`);
    if (!tasks.length) break;
    all.push(...tasks);
    executorTasks.push(...tasks);
    if (tasks.length < 100) break;
    offset += 100;
  }
  managerExecutorTaskCache.set(String(userId), executorTasks);
  const seenIds = new Set(all.map(t => t.id));
  offset = 0;
  while (true) {
    process.stdout.write(`  Сделки (участник) offset=${offset}...`);
    const d = await pf('/task/list', { offset, pageSize: 100,
      filters: [{ type: 51, operator: 'equal', value: `user:${userId}` }],
      fields: DEAL_FIELDS,
    });
    const tasks = d.tasks || [];
    console.log(` ${tasks.length}`);
    if (!tasks.length) break;
    for (const t of tasks) {
      if (!seenIds.has(t.id)) { all.push(t); seenIds.add(t.id); }
    }
    if (tasks.length < 100) break;
    offset += 100;
    if (offset >= MAX_PARTICIPANT_TASKS) {
      console.log(`  ⚠️ Лимит участника: ${MAX_PARTICIPANT_TASKS}, остальные пропущены`);
      break;
    }
  }
  return all;
}

async function getTaskComments(taskId) {
  try {
    const d = await pf(`/task/${taskId}/comments/list`, {
      offset: 0, pageSize: 100, fields: 'id,description,type,dateTime,owner,files',
    });
    if (String(taskId) === '31811' && d.comments) {
      const calls = d.comments.filter(c => {
        const desc = (c.description || '').toLowerCase();
        return desc.includes('звонок') || (c.files || []).some(f => (f.name||'').includes('Запись'));
      });
      console.log(`  🔍 Диагностика #31811: ${calls.length} звонков из ${d.comments.length} комментариев`);
      calls.slice(0, 3).forEach(c => {
        console.log(`    comment ${c.id}: desc=${(c.description||'').length}б type=${c.type} files=${(c.files||[]).map(f=>f.name).join(',')} desc_preview="${(c.description||'').substring(0,100)}"`);
      });
    }
    return d.comments || [];
  } catch (e) {
    if (isPlanfixRateLimitError(e)) throw e;
    return [];
  }
}

async function getContactComments(contactId) {
  const id = String(contactId).replace('contact:', '');
  const body = { offset: 0, pageSize: 100, fields: 'id,description,type,dateTime,owner,files' };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const d = await pf(`/contact/${id}/comments/list`, body);
      return d.comments || [];
    } catch (e) {
      if (isPlanfixRateLimitError(e)) throw e;
      if (attempt < 3) { await sleep(2000 * attempt); continue; }
      console.error(`    ⚠️ Contact ${contactId} error: ${e.message}`);
      return [];
    }
  }
  return [];
}

// Сделки с комментариями/изменениями за день (исполнитель + участник)
async function getActiveTasks(userId, reportDate) {
  const dateFilter = { type: 21, operator: 'equal', value: { dateType: 'otherRange', dateFrom: reportDate, dateTo: reportDate } };
  const seenIds = new Set();
  const all = [];

  for (const userFilter of [
    { type: 97, operator: 'equal', value: `user:${userId}` },
    { type: 39, operator: 'equal', value: `user:${userId}` },
  ]) {
    let offset = 0;
    const role = userFilter.type === 97 ? 'исполнитель' : 'участник';
    while (true) {
      process.stdout.write(`  Активные (${role}) offset=${offset}...`);
      const d = await pf('/task/list', { offset, pageSize: 100,
        filters: [userFilter, dateFilter],
        fields: DEAL_FIELDS,
      });
      const tasks = d.tasks || [];
      console.log(` ${tasks.length}`);
      for (const t of tasks) {
        if (!seenIds.has(t.id)) { all.push(t); seenIds.add(t.id); }
      }
      if (tasks.length < 100) break;
      offset += 100;
    }
  }
  console.log(`  ✅ Активных сделок за ${reportDate}: ${all.length}`);
  return all;
}

// Лёгкий список всех сделок (id, name, status, counterparty, template, dataTags) для воронки
const LIGHT_FIELDS = 'id,name,status,counterparty,template,dateTime,dataTags,parent';

async function getLightTasks(userId) {
  const cachedExecutorTasks = managerExecutorTaskCache.get(String(userId));
  if (cachedExecutorTasks) {
    console.log(`  Р’РѕСЂРѕРЅРєР°: ${cachedExecutorTasks.length} РёР· РєСЌС€Р° СЃРґРµР»РѕРє РјРµРЅРµРґР¶РµСЂР°`);
    return cachedExecutorTasks;
  }

  const all = [];
  let offset = 0;
  // Только исполнитель — участник может вернуть тысячи задач всей компании
  while (true) {
    process.stdout.write(`  Воронка offset=${offset}...`);
    const d = await pf('/task/list', { offset, pageSize: 100,
      filters: [{ type: 97, operator: 'equal', value: `user:${userId}` }],
      fields: LIGHT_FIELDS,
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

process.once('exit', () => {
  if (!restStats.total) return;
  try { savePlanfixRestUsage({ scope: 'process-exit' }); } catch {}
  const top = topEndpointList(restStats.byEndpoint)
    .map(({ endpoint, count }) => `${endpoint}=${count}`)
    .join(', ');
  console.log(`\n📡 Planfix REST API: ${restStats.total} запросов${top ? ` (${top})` : ''}`);
  if (rateLimitState.active) {
    const reset = rateLimitState.timeToReset != null ? `, timeToReset=${rateLimitState.timeToReset}s` : '';
    console.log(`📡 Planfix REST API остановлен по лимиту${reset}`);
  }
});

module.exports = {
  httpPost, httpGet, pf, pfGet,
  discoverEmployees, getAllTasks, getActiveTasks, getLightTasks, getTaskComments, getContactComments,
  registerPlanfixRestRequest, notePlanfixRateLimit, isPlanfixRateLimited, isPlanfixRateLimitError,
  throwIfPlanfixRateLimited, getPlanfixRestStats, diffPlanfixRestStats, savePlanfixRestUsage,
};
