// ============================================================
// helpers.js — Чистые утилиты без доменных зависимостей
// ============================================================

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function parallelMap(items, fn, concurrency = 10) {
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
function utcToMsk(dateStr, timeStr) {
  if (!timeStr) return { date: dateStr || '', time: '' };
  const tm = (timeStr || '').match(/(\d+):(\d+)/);
  if (!tm) return { date: dateStr || '', time: timeStr || '' };
  let h = parseInt(tm[1]) + 3; // UTC+3
  let date = dateStr || '';
  if (h >= 24) {
    h -= 24;
    const dp = date.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (dp) {
      const d = new Date(`${dp[3]}-${dp[2]}-${dp[1]}`);
      d.setDate(d.getDate() + 1);
      date = `${pad2(d.getDate())}-${pad2(d.getMonth()+1)}-${d.getFullYear()}`;
    }
  }
  return { date, time: `${pad2(h)}:${tm[2]}` };
}

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

function parsePfDate(dateStr) {
  if (!dateStr) return null;
  const m1 = dateStr.match(/(\d{2})-(\d{2})-(\d{4})/);
  const m2 = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(dateStr);
  if (m1) return new Date(`${m1[3]}-${m1[2]}-${m1[1]}`);
  return null;
}

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

function extractWorkDesc(name) {
  if (!name) return '';
  const workKeywords = [
    /асфальт\S*/i, /рем(?:онт)?\s+\S+/i, /вывоз\s+снега/i, /укладк\S*/i, /благоустройств\S*/i,
    /тротуар\S*/i, /дорог\S*/i, /площадк\S*/i, /парковк\S*/i, /бордюр\S*/i,
    /крошк\S*/i, /фрезеровк\S*/i, /разметк\S*/i, /щебен\S*/i, /грунтовк\S*/i,
  ];
  const volMatch = name.match(/(\d[\d\s.,]*)\s*(м2|м²|кв\.?\s*м|м\.п\.|п\.м\.|м\.кв|тонн|т\b|км|куб\.?\s*м|м3|м³|шт)/i);
  const vol = volMatch ? volMatch[0].trim() : '';
  let workType = '';
  for (const re of workKeywords) {
    const m = name.match(re);
    if (m) { workType = m[0].trim(); break; }
  }
  if (!workType && !vol) return '';
  return [workType, vol].filter(Boolean).join(' ').trim();
}

// Нормализация телефона: +7/8/7 → 10 цифр (9xx...)
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits;
}

module.exports = {
  sleep, parallelMap, pad2, timeToMinNode, utcToMsk,
  parseCfd, stripHtml, parsePfDate, todayStr, isSameDay, extractWorkDesc, normalizePhone,
};
