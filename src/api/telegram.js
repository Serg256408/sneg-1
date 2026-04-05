// ============================================================
// telegram.js — Отправка сообщений в Telegram Bot API
// ============================================================

const axios = require('axios');

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const MAX_MSG_LEN = 4096;

function isTelegramConfigured() {
  return !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

/**
 * Отправить сообщение в Telegram.
 * Если текст > 4096 символов — разбивает на части.
 * @param {string} text — текст сообщения
 * @param {string} parseMode — 'HTML' или 'MarkdownV2'
 * @returns {boolean} — успех
 */
async function sendTelegramMessage(text, parseMode = 'HTML') {
  if (!isTelegramConfigured()) {
    console.log('  ⚠️ Telegram не настроен (нет TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)');
    return false;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const chunks = [];

  // Разбиваем длинные сообщения
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LEN) {
      chunks.push(remaining);
      break;
    }
    // Ищем последний перенос строки в пределах лимита
    let cut = remaining.lastIndexOf('\n', MAX_MSG_LEN);
    if (cut < 100) cut = MAX_MSG_LEN;
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trimStart();
  }

  for (const chunk of chunks) {
    try {
      await axios.post(url, {
        chat_id: TELEGRAM_CHAT_ID,
        text: chunk,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }, { timeout: 15000 });
    } catch (err) {
      const msg = err.response?.data?.description || err.message || '';
      console.error(`  ❌ Telegram ошибка: ${msg.substring(0, 200)}`);
      return false;
    }
  }

  console.log(`  ✅ Telegram: отправлено (${chunks.length} сообщ.)`);
  return true;
}

module.exports = { isTelegramConfigured, sendTelegramMessage };
