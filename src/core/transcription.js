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

const NO_ANSWER_PATTERNS = [
  'абонент не отвечает',
  'абонент не ответил',
  'абонент не берет трубку',
  'продолжаем дозваниваться',
  'попытка дозвониться',
  'можете оставить голосовое сообщение',
  'оставьте голосовое сообщение',
  'голосовой почтовый ящик',
  'после сигнала',
];

const AUDIO_FILE_RE = /(запись звонка|\.mp3\b|\.mpga\b|\.mpeg\b|\.m4a\b|\.mp4\b|\.wav\b|\.webm\b|\.ogg\b|\.oga\b|\.flac\b)/i;

function getFileName(file) {
  if (typeof file === 'string') return file.trim();
  return String(file?.name || file?.fileName || '').trim();
}

function hasCallRecordingFile(files) {
  return (files || []).some(file => AUDIO_FILE_RE.test(getFileName(file)));
}

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

function isNoAnswerTranscription(text) {
  const low = String(text || '').toLowerCase();
  if (!low) return false;
  return NO_ANSWER_PATTERNS.some(p => low.includes(p));
}

function getNoAnswerLabel(transcription) {
  const low = String(transcription || '').toLowerCase();
  if (low.includes('абонент не берет трубку')) return 'Недозвон — абонент не берет трубку';
  if (low.includes('абонент не отвечает') || low.includes('абонент не ответил')) return 'Недозвон — абонент не отвечает';
  if (low.includes('голосовой почтовый ящик') || low.includes('после сигнала')) return 'Недозвон — автоответчик';
  return 'Недозвон';
}

module.exports = { extractTranscription, isNoAnswerTranscription, getNoAnswerLabel, hasCallRecordingFile };
