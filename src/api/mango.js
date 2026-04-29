const crypto = require('crypto');
const axios = require('axios');
const {
  fs, path, os, MANGO_API_KEY, MANGO_API_SALT, MANGO_MANAGER_EXTENSIONS, MANGO_MATCH_WINDOW_MIN,
} = require('../utils/config');
const { sleep, normalizePhone, timeToMinNode, pad2 } = require('../utils/helpers');

const MANGO_BASE_URL = 'https://app.mango-office.ru';
const statsCache = new Map();
let warnedNoMango = false;

function isMangoConfigured() {
  return !!(MANGO_API_KEY && MANGO_API_SALT);
}

function warnNoMangoOnce() {
  if (!warnedNoMango) {
    console.log('    Mango: MANGO_API_KEY or MANGO_API_SALT is not set, fallback is disabled');
    warnedNoMango = true;
  }
}

function mangoSign(json) {
  return crypto.createHash('sha256').update(MANGO_API_KEY + json + MANGO_API_SALT).digest('hex');
}

async function mangoPost(apiPath, payload, options = {}) {
  if (!isMangoConfigured()) {
    warnNoMangoOnce();
    return null;
  }

  const json = JSON.stringify(payload || {});
  const body = new URLSearchParams({
    vpbx_api_key: MANGO_API_KEY,
    sign: mangoSign(json),
    json,
  });

  const response = await axios.post(`${MANGO_BASE_URL}${apiPath}`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: options.timeout || 60000,
    maxRedirects: options.maxRedirects ?? 5,
    validateStatus: status => status >= 200 && status < 400,
    responseType: options.responseType || 'json',
  });

  return options.raw ? response : response.data;
}

function dmyToMskUnixRange(reportDate) {
  const m = String(reportDate || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]) - 1;
  const year = Number(m[3]);
  const start = Date.UTC(year, month, day, -3, 0, 0) / 1000;
  const end = Date.UTC(year, month, day + 1, -3, 0, 0) / 1000;
  return { start: Math.floor(start), end: Math.floor(end) };
}

function unixToMskParts(value) {
  const sec = Number(value);
  if (!sec || Number.isNaN(sec)) return { date: '', time: '' };
  const d = new Date((sec + 3 * 3600) * 1000);
  return {
    date: `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`,
    time: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
  };
}

function normalizeStatsRows(data) {
  if (!data) return null;
  if (Array.isArray(data)) return data;
  if (typeof data !== 'object') return null;

  for (const key of ['records', 'data', 'result', 'calls']) {
    if (Array.isArray(data[key])) return data[key];
  }

  for (const value of Object.values(data)) {
    const rows = normalizeStatsRows(value);
    if (rows) return rows;
  }
  return null;
}

function normalizeRecordingIds(records) {
  if (!records) return [];
  if (Array.isArray(records)) {
    return records
      .map(record => (typeof record === 'string' ? record : record?.recording_id || record?.id || record?.record_id || ''))
      .map(String)
      .map(s => s.trim())
      .filter(Boolean);
  }
  return String(records)
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function normalizeMangoCall(row) {
  const start = unixToMskParts(row.start || row.answer || row.finish);
  const finish = Number(row.finish || 0);
  const answer = Number(row.answer || row.start || 0);
  const duration = finish && answer && finish > answer ? finish - answer : Number(row.duration || row.talk_time || 0) || 0;
  const recordingIds = normalizeRecordingIds(row.records || row.recording_id || row.record_id);

  return {
    raw: row,
    date: start.date,
    time: start.time,
    start: Number(row.start || 0) || 0,
    answer,
    finish,
    duration,
    fromExtension: String(row.from_extension || '').trim(),
    toExtension: String(row.to_extension || '').trim(),
    fromNumber: normalizePhone(String(row.from_number || '')),
    toNumber: normalizePhone(String(row.to_number || '')),
    lineNumber: normalizePhone(String(row.line_number || '')),
    recordingIds,
  };
}

async function loadMangoCallsForDate(reportDate) {
  if (!isMangoConfigured()) return [];
  if (statsCache.has(reportDate)) return statsCache.get(reportDate);

  const range = dmyToMskUnixRange(reportDate);
  if (!range) return [];

  const requestPayload = {
    date_from: String(range.start),
    date_to: String(range.end),
    from: { extension: '', number: '' },
    to: { extension: '', number: '' },
    fields: 'records,start,finish,answer,from_extension,from_number,to_extension,to_number,disconnect_reason,line_number,entry_id',
  };

  try {
    const request = await mangoPost('/vpbx/stats/request', requestPayload);
    let rows = normalizeStatsRows(request);

    if (!rows) {
      for (let attempt = 1; attempt <= 12; attempt++) {
        await sleep(attempt === 1 ? 500 : 1500);
        const result = await mangoPost('/vpbx/stats/result', request);
        rows = normalizeStatsRows(result);
        if (rows) break;
      }
    }

    const calls = (rows || []).map(normalizeMangoCall).filter(call => call.date === reportDate);
    statsCache.set(reportDate, calls);
    console.log(`    Mango: ${calls.length} calls loaded for ${reportDate}`);
    return calls;
  } catch (e) {
    console.log(`    Mango: failed to load calls (${String(e.message || e).substring(0, 120)})`);
    statsCache.set(reportDate, []);
    return [];
  }
}

function parseManagerExtensions(managerAlias, managerName) {
  const aliases = [managerAlias, managerName].filter(Boolean).map(v => String(v).toLowerCase());
  const result = new Set();

  for (const alias of aliases) {
    const envName = `MANGO_EXT_${alias.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
    const raw = process.env[envName];
    if (raw) raw.split(/[,\s|]+/).forEach(v => v && result.add(String(v).trim()));
  }

  for (const part of String(MANGO_MANAGER_EXTENSIONS || '').split(/[;\n]+/)) {
    const [key, values] = part.split(':');
    if (!key || !values) continue;
    if (!aliases.includes(key.trim().toLowerCase())) continue;
    values.split(/[,\s|]+/).forEach(v => v && result.add(String(v).trim()));
  }

  return [...result];
}

function hasManagerExtension(call, managerExtensions) {
  if (!managerExtensions || !managerExtensions.length) return true;
  return managerExtensions.includes(call.fromExtension) || managerExtensions.includes(call.toExtension);
}

function callMatchesPhones(call, phones) {
  const wanted = new Set((phones || []).map(normalizePhone).filter(Boolean));
  if (!wanted.size) return false;
  return wanted.has(call.fromNumber) || wanted.has(call.toNumber);
}

async function findMangoRecordingForCall({ reportDate, time, phones, managerAlias, managerName, windowMin }) {
  if (!isMangoConfigured()) return null;
  const calls = await loadMangoCallsForDate(reportDate);
  const targetMin = timeToMinNode(time);
  const managerExtensions = parseManagerExtensions(managerAlias, managerName);
  const allowedWindow = Number(windowMin || MANGO_MATCH_WINDOW_MIN || 7);

  const candidates = calls
    .filter(call => call.recordingIds.length)
    .filter(call => callMatchesPhones(call, phones))
    .filter(call => hasManagerExtension(call, managerExtensions))
    .map(call => ({ call, diff: Math.abs(timeToMinNode(call.time) - targetMin) }))
    .filter(item => item.diff <= allowedWindow)
    .sort((a, b) => a.diff - b.diff || b.call.duration - a.call.duration);

  if (!candidates.length) return null;
  const best = candidates[0].call;
  return {
    call: best,
    recordingId: best.recordingIds[0],
    audioFile: {
      id: `mango:${best.recordingIds[0]}`,
      name: `Mango ${best.date} ${best.time} ${best.fromNumber || best.toNumber || 'call'}.mp3`,
    },
  };
}

async function getMangoRecordingLink(recordingId) {
  const response = await mangoPost('/vpbx/queries/recording/post/', {
    recording_id: recordingId,
    action: 'download',
  }, { raw: true, maxRedirects: 0, responseType: 'text' });

  const location = response?.headers?.location || response?.headers?.Location;
  if (location) return String(location).trim();

  const body = String(response?.data || '');
  const match = body.match(/https?:\/\/\S+/);
  return match ? match[0].trim() : '';
}

async function downloadMangoRecording(recordingId) {
  const link = await getMangoRecordingLink(recordingId);
  if (!link) return null;

  const tmpFile = path.join(
    os.tmpdir(),
    `mango_audio_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`,
  );

  const response = await axios.get(link, {
    responseType: 'arraybuffer',
    timeout: 120000,
    maxRedirects: 5,
    validateStatus: status => status >= 200 && status < 300,
  });
  fs.writeFileSync(tmpFile, Buffer.from(response.data));

  const stat = fs.statSync(tmpFile);
  if (stat.size < 100) {
    try { fs.unlinkSync(tmpFile); } catch {}
    return null;
  }

  return tmpFile;
}

module.exports = {
  isMangoConfigured,
  findMangoRecordingForCall,
  downloadMangoRecording,
  loadMangoCallsForDate,
};
