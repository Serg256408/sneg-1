// ============================================================
// cache.js — Загрузка/сохранение AI и Transcription кэша
// ============================================================

const { fs, TRANSCRIPTION_CACHE_FILE, AI_CACHE_FILE } = require('../utils/config');

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
  fs.writeFileSync(TRANSCRIPTION_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function loadAiCache() {
  try { return JSON.parse(fs.readFileSync(AI_CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveAiCache(cache) {
  fs.writeFileSync(AI_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

module.exports = { loadTranscriptionCache, saveTranscriptionCache, loadAiCache, saveAiCache };
