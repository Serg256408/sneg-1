// ============================================================
// transcription.js — Извлечение транскрибации из комментария
// ============================================================

const { stripHtml } = require('../utils/helpers');

function extractTranscription(description) {
  const text = stripHtml(description);
  const sepIdx = text.indexOf('----------');
  if (sepIdx === -1) return null;
  const after = text.substring(sepIdx + 10).trim();
  if (!after || after.length < 10) return null;
  return after;
}

module.exports = { extractTranscription };
