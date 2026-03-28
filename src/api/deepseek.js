// ============================================================
// deepseek.js — ИИ-чат (DeepSeek, OpenAI, Polza.ai)
// ============================================================

const { fs, path, os, OPENAI_KEY, DEEPSEEK_KEY, POLZA_KEY } = require('../utils/config');

async function openaiChat(prompt, systemPrompt, maxTokens, model) {
  const isDeepSeek = model && model.startsWith('deepseek');
  let apiKey = isDeepSeek ? DEEPSEEK_KEY : OPENAI_KEY;
  let apiUrl = isDeepSeek ? 'https://api.deepseek.com/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
  const polzaFallback = isDeepSeek && POLZA_KEY;
  if (!apiKey && polzaFallback) {
    apiKey = POLZA_KEY;
    apiUrl = 'https://polza.ai/api/v1/chat/completions';
    model = 'deepseek/deepseek-chat';
  }
  if (!apiKey) return null;
  const { execFileSync } = require('child_process');
  const body = JSON.stringify({
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt || 'Ты аналитик отдела продаж компании по вывозу снега ТрансКом. Отвечай кратко, по-русски.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: maxTokens || 1000,
  });
  const tmp = path.join(os.tmpdir(), 'oai_' + Date.now() + '.json');
  const maxRetries = 3;
  try {
    fs.writeFileSync(tmp, body);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const r = execFileSync('curl', [
          '-s', '-L', '--ssl-no-revoke', '--connect-timeout', '15', '--max-time', '90', '-X', 'POST',
          apiUrl,
          '-H', `Authorization: Bearer ${apiKey}`,
          '-H', 'Content-Type: application/json',
          '-d', `@${tmp}`,
        ], { encoding: 'utf8', timeout: 120000 });
        const parsed = JSON.parse(r);
        if (parsed.error) {
          const errCode = parsed.error.code || '';
          const errMsg = parsed.error.message || '';
          console.error(`    ⚠️ API error: ${errMsg}`);
          if (errCode === 'invalid_api_key' || errMsg.includes('Incorrect API key')) return null;
          if (isDeepSeek && POLZA_KEY && apiUrl.includes('deepseek.com')) {
            console.log('    🔄 DeepSeek недоступен, переключаюсь на Polza.ai...');
            apiKey = POLZA_KEY;
            apiUrl = 'https://polza.ai/api/v1/chat/completions';
            model = 'deepseek/deepseek-chat';
            const newBody = JSON.stringify({ ...JSON.parse(body), model });
            fs.writeFileSync(tmp, newBody);
            continue;
          }
          if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
          return null;
        }
        return (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || null;
      } catch (e) {
        if (attempt < maxRetries) {
          process.stdout.write(`⟳`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
          continue;
        }
        console.error(`    ⚠️ ${isDeepSeek ? 'DeepSeek' : 'OpenAI'} error (${maxRetries} attempts): ${e.message.substring(0, 100)}`);
        return null;
      }
    }
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { openaiChat };
