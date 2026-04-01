// ============================================================
// transcription.js — Извлечение транскрибации из комментария
// ============================================================

const { stripHtml } = require('../utils/helpers');

// Тексты-мусор от Planfix AI (ошибки, системные сообщения) — НЕ транскрибация
const PLANFIX_JUNK = [
  'не могу выполнить операцию',
  'закончились ai-кредиты',
  'ответственный за оплату планфикса',
  'добавить ai-кредиты',
];

function extractTranscription(description) {
  const text = stripHtml(description);
  const sepIdx = text.indexOf('----------');
  if (sepIdx === -1) return null;
  const after = text.substring(sepIdx + 10).trim();
  if (!after || after.length < 10) return null;
  // Фильтруем системные ошибки Planfix AI — это НЕ транскрибация звонка
  const low = after.toLowerCase();
  if (PLANFIX_JUNK.some(j => low.includes(j))) return null;
  return after;
}

module.exports = { extractTranscription };
