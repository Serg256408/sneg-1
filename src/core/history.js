// ============================================================
// history.js — Единая история сделок (комментарии, транскрибации, ИИ-оценки)
// ============================================================

const { fs, path, ROOT_DIR } = require('../utils/config');
const { writeJsonWithRetry } = require('../utils/safe-write');

const HISTORY_FILE = path.join(ROOT_DIR, 'deal_history.json');

const HISTORY_VERSION = 1;

/**
 * Формат deal_history.json:
 * {
 *   meta: { version: 1, lastUpdate: "28-03-2026" },
 *   deals: {
 *     "12345": {
 *       comments: [{ id, date, time, type, text, owner, transcription, files, source }],
 *       transcriptions: { "file_url_or_id": "текст транскрибации" },
 *       assessments: { "assess_12345_28-03-2026_v20": { ... } }
 *     }
 *   }
 * }
 */

function createEmptyHistory() {
  return { meta: { version: HISTORY_VERSION, lastUpdate: null }, deals: {} };
}

function ensureDeal(history, dealId) {
  const id = String(dealId);
  if (!history.deals[id]) {
    history.deals[id] = { comments: [], transcriptions: {}, assessments: {} };
  }
  return history.deals[id];
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data.meta || !data.deals) return createEmptyHistory();
    const count = Object.keys(data.deals).length;
    console.log(`  📚 История сделок: ${count} сделок (${HISTORY_FILE})`);
    return data;
  } catch {
    console.log(`  📚 История сделок: пустая (файл не найден)`);
    return createEmptyHistory();
  }
}

function saveHistory(history, dateDMY) {
  history.meta.lastUpdate = dateDMY || history.meta.lastUpdate;
  history.meta.version = HISTORY_VERSION;

  writeJsonWithRetry(HISTORY_FILE, history);

  const count = Object.keys(history.deals).length;
  console.log(`  💾 История сохранена: ${count} сделок`);
}

module.exports = {
  HISTORY_FILE,
  HISTORY_VERSION,
  createEmptyHistory,
  ensureDeal,
  loadHistory,
  saveHistory,
};
