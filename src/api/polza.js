// AI chat provider. The runtime intentionally uses Polza.ai only.

const { fs, path, os, POLZA_KEY } = require('../utils/config');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitMessage(code, message) {
  const text = `${code || ''} ${message || ''}`;
  return /429|rate.?limit|too many|слишком много|много запросов/i.test(text);
}

function retryDelayMs(attempt, rateLimited) {
  return rateLimited ? Math.min(60000, 5000 * attempt) : 2000 * attempt;
}

async function aiChat(prompt, systemPrompt, maxTokens, model) {
  if (!POLZA_KEY) return null;

  const { execFileSync } = require('child_process');
  const body = JSON.stringify({
    model: model && String(model).includes('/') ? model : 'deepseek/deepseek-chat',
    messages: [
      {
        role: 'system',
        content: systemPrompt || 'Ты аналитик отдела продаж компании ТрансКом. Отвечай кратко, по-русски.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: maxTokens || 1000,
  });
  const tmp = path.join(os.tmpdir(), `polza_${Date.now()}.json`);
  const maxRetries = parseInt(process.env.AI_MAX_RETRIES || '6', 10) || 6;

  try {
    fs.writeFileSync(tmp, body);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const r = execFileSync('curl', [
          '-s', '-L', '--ssl-no-revoke', '--connect-timeout', '15', '--max-time', '90', '-X', 'POST',
          'https://polza.ai/api/v1/chat/completions',
          '-H', `Authorization: Bearer ${POLZA_KEY}`,
          '-H', 'Content-Type: application/json',
          '-d', `@${tmp}`,
        ], { encoding: 'utf8', timeout: 120000 });
        const parsed = JSON.parse(r);
        if (parsed.error) {
          const errCode = parsed.error.code || '';
          const errMsg = parsed.error.message || '';
          const rateLimited = isRateLimitMessage(errCode, errMsg);
          console.error(`    Polza.ai API error: ${errMsg}`);
          if (errCode === 'invalid_api_key' || errMsg.includes('Incorrect API key')) return null;
          if (attempt < maxRetries) {
            await sleep(retryDelayMs(attempt, rateLimited));
            continue;
          }
          return null;
        }
        return parsed.choices?.[0]?.message?.content || null;
      } catch (e) {
        if (attempt < maxRetries) {
          process.stdout.write('.');
          await sleep(retryDelayMs(attempt, isRateLimitMessage('', e.message)));
          continue;
        }
        console.error(`    Polza.ai error (${maxRetries} attempts): ${e.message.substring(0, 100)}`);
        return null;
      }
    }
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { aiChat };
