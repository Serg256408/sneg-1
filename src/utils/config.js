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
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const POLZA_KEY = process.env.POLZA_API_KEY || OPENAI_KEY;
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();

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
  ROOT_DIR, API_URL, TOKEN, OPENAI_KEY, DEEPSEEK_KEY, POLZA_KEY, AUTH,
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  TRANSCRIPTION_CACHE_FILE, AI_CACHE_FILE,
  MANAGERS_FILE, MANAGERS_LIST, MANAGERS,
  CONCURRENCY, START_TIME, isCI, TIME_LIMIT_MS, MAX_DAYS_CI,
  timeLeft, isTimeUp,
  CALL_TAG, ANALYSIS_TAG, DEAL_FIELDS, ALLOWED_TEMPLATES,
  SKIP_STATUSES, NEW_STATUSES, FUNNEL_ORDER,
  fs, path, os,
};
