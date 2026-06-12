// ============================================================
// config.js — Конфигурация, env vars, константы
// ============================================================

require('dotenv').config({ quiet: true });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Planfix TLS workaround
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT_DIR = path.join(__dirname, '..', '..');

const API_URL = (process.env.PLANFIX_URL || '').trim().replace(/\/+$/, '');
const TOKEN = (process.env.PLANFIX_TOKEN || '').trim();
const POLZA_KEY = (process.env.POLZA_API_KEY || '').trim();
const REPORT_SKIP_AI = process.argv.includes('--no-ai') ||
  /^(1|true|yes|on)$/i.test((process.env.REPORT_SKIP_AI || '').trim());
const AI_ENABLED = !!POLZA_KEY && !REPORT_SKIP_AI;
const REPORT_SKIP_MEASUREMENTS = process.argv.includes('--no-measurements') ||
  /^(1|true|yes|on)$/i.test((process.env.REPORT_SKIP_MEASUREMENTS || '').trim());
const REPORT_BACKFILL_HISTORY = process.argv.includes('--backfill-history') ||
  /^(1|true|yes|on)$/i.test((process.env.REPORT_BACKFILL_HISTORY || '').trim());
const REPORT_HISTORY_AI = process.argv.includes('--history-ai') ||
  process.argv.includes('--ai-history') ||
  /^(1|true|yes|on)$/i.test((process.env.REPORT_HISTORY_AI || '').trim());
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const MANGO_API_KEY = (process.env.MANGO_API_KEY || '').trim();
const MANGO_API_SALT = (process.env.MANGO_API_SALT || '').trim();
const MANGO_MANAGER_EXTENSIONS = (process.env.MANGO_MANAGER_EXTENSIONS || '').trim();
const MANGO_MATCH_WINDOW_MIN = parseInt(process.env.MANGO_MATCH_WINDOW_MIN || '7', 10) || 7;

const TRANSCRIPTION_CACHE_FILE = path.join(ROOT_DIR, 'transcriptions_cache.json');
const AI_CACHE_FILE = path.join(ROOT_DIR, 'ai_cache.json');

// Менеджеры из managers.json (фоллбэк на хардкод)
const MANAGERS_FILE = path.join(ROOT_DIR, 'managers.json');
let MANAGERS_LIST = [{ alias: 'borovaya', userId: 41, name: 'Ия Боровая', pfName: 'Боровая' }];
try { MANAGERS_LIST = JSON.parse(fs.readFileSync(MANAGERS_FILE, 'utf8')); } catch {}
const MANAGERS = {};
for (const m of MANAGERS_LIST) {
  MANAGERS[m.pfName] = m;
  MANAGERS[m.alias] = m;
  if (m.pfName) MANAGERS[m.pfName.toLowerCase()] = m;
}

const AUTH = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const CONCURRENCY = 10;
const parsedAiConcurrency = parseInt(
  process.env.REPORT_AI_CONCURRENCY || process.env.AI_CONCURRENCY || (POLZA_KEY ? '2' : String(CONCURRENCY)),
  10,
);
const AI_CONCURRENCY = Number.isFinite(parsedAiConcurrency) && parsedAiConcurrency > 0
  ? parsedAiConcurrency
  : CONCURRENCY;
const START_TIME = Date.now();
const isCI = !!process.env.CI || !!process.env.GITHUB_ACTIONS;
const TIME_LIMIT_MS = isCI ? 150 * 60 * 1000 : Infinity;
const MAX_DAYS_CI = 14;

function timeLeft() { return TIME_LIMIT_MS - (Date.now() - START_TIME); }
function isTimeUp() { return timeLeft() < 5 * 60 * 1000; }

const CALL_TAG = 15900;
const ANALYSIS_TAG = 15920;
const DEAL_FIELDS = 'id,name,parent,status,dateTime,counterparty,dataTags,template,assignees,67906,76880,76866,76868,76872,76874,76876,76878,76672,75760,67892,67894,76678,76826,76828';
const ALLOWED_TEMPLATES = ['Сделка', 'Вывоз снега'];
const SKIP_STATUSES = ['Сделанная', 'Завершённая', 'Сделка завершена'];
const NEW_STATUSES = ['Новая', 'Обработка'];
const FUNNEL_ORDER = [
  'Новая', 'Обработка', 'В работе', 'Коммерческое предложение',
  'Вывезли/Нашли поставщика', 'Дожим', 'Договор и оплата',
  'Выполнение Работы', 'Сделанная', 'Сделка завершена',
];

module.exports = {
  ROOT_DIR, API_URL, TOKEN, POLZA_KEY,
  REPORT_SKIP_AI, AI_ENABLED, REPORT_SKIP_MEASUREMENTS, REPORT_BACKFILL_HISTORY, REPORT_HISTORY_AI, AUTH,
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  MANGO_API_KEY, MANGO_API_SALT, MANGO_MANAGER_EXTENSIONS, MANGO_MATCH_WINDOW_MIN,
  TRANSCRIPTION_CACHE_FILE, AI_CACHE_FILE,
  MANAGERS_FILE, MANAGERS_LIST, MANAGERS,
  CONCURRENCY, AI_CONCURRENCY, START_TIME, isCI, TIME_LIMIT_MS, MAX_DAYS_CI,
  timeLeft, isTimeUp,
  CALL_TAG, ANALYSIS_TAG, DEAL_FIELDS, ALLOWED_TEMPLATES,
  SKIP_STATUSES, NEW_STATUSES, FUNNEL_ORDER,
  fs, path, os,
};
