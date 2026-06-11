// ============================================================
// cache.js — Загрузка/сохранение AI и Transcription кэша
// ============================================================

const { fs, TRANSCRIPTION_CACHE_FILE, AI_CACHE_FILE } = require('../utils/config');
const { writeJsonWithRetry } = require('../utils/safe-write');

function loadTranscriptionCache(silent = false) {
  try {
    const data = JSON.parse(fs.readFileSync(TRANSCRIPTION_CACHE_FILE, 'utf8'));
    if (!silent) {
      console.log(`  📝 Кэш транскрибаций: ${Object.keys(data).length} записей (${TRANSCRIPTION_CACHE_FILE})`);
    }
    return data;
  } catch {
    if (!silent) {
      console.log(`  📝 Кэш транскрибаций: пустой (файл не найден)`);
    }
    return {};
  }
}

function saveTranscriptionCache(cache) {
  writeJsonWithRetry(TRANSCRIPTION_CACHE_FILE, cache);
}

function loadAiCache() {
  try { return JSON.parse(fs.readFileSync(AI_CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveAiCache(cache) {
  writeJsonWithRetry(AI_CACHE_FILE, cache);
}

module.exports = { loadTranscriptionCache, saveTranscriptionCache, loadAiCache, saveAiCache };
