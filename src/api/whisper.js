// ============================================================
// whisper.js — Транскрибация через Whisper (Polza.ai)
// ============================================================

const { fs, path, os, API_URL, TOKEN, POLZA_KEY, isTimeUp } = require('../utils/config');
const { saveAiCache, loadAiCache } = require('../core/cache');

const MAX_WHISPER_PER_RUN = 70;
let whisperCallsThisRun = 0;

function downloadPlanfixFile(fileId) {
  const { execFileSync } = require('child_process');
  const tmpFile = path.join(os.tmpdir(), `pf_audio_${fileId}.mp3`);
  try {
    execFileSync('curl', [
      '-s', '-L', '--ssl-no-revoke', '-o', tmpFile,
      `${API_URL}/file/${fileId}/download`,
      '-H', `Authorization: Bearer ${TOKEN}`,
    ], { timeout: 60000 });
    const stat = fs.statSync(tmpFile);
    if (stat.size < 100) { try { fs.unlinkSync(tmpFile); } catch {} return null; }
    return tmpFile;
  } catch { return null; }
}

async function whisperTranscribe(audioPath) {
  if (!POLZA_KEY) return null;
  const { execFileSync } = require('child_process');
  try {
    const result = execFileSync('curl', [
      '-s', '-L', '--ssl-no-revoke',
      'https://polza.ai/api/v1/audio/transcriptions',
      '-H', `Authorization: Bearer ${POLZA_KEY}`,
      '-F', `file=@${audioPath}`,
      '-F', 'model=openai/whisper-1',
      '-F', 'language=ru',
      '-F', 'response_format=text',
    ], { encoding: 'utf8', timeout: 120000 });
    const trimmed = result.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.error) { console.log(`    ⚠️ Whisper error: ${(parsed.error.message || '').substring(0, 80)}`); return null; }
        return parsed.text || parsed.transcription || null;
      } catch {}
    }
    if (trimmed.includes('"error"') || trimmed.includes('invalid_api_key') || trimmed.includes('Incorrect API key')) return null;
    return trimmed;
  } catch { return null; }
}

async function transcribeCallIfNeeded(comment, cache, allowNew) {
  if (comment.transcription) return comment.transcription;
  const files = comment.files || [];
  const audioFile = files.find(f => (f.name || '').toLowerCase().endsWith('.mp3'));
  if (!audioFile) return null;
  const cacheKey = String(audioFile.id);
  if (cache[cacheKey]) return cache[cacheKey]; // из кэша
  // Новые транскрибации — только если явно разрешено (звонки за день отчёта)
  if (!allowNew) return null;
  if (isTimeUp()) return null;
  if (whisperCallsThisRun >= MAX_WHISPER_PER_RUN) return null;
  whisperCallsThisRun++;
  if (whisperCallsThisRun === 1) console.log(`    🎤 Whisper: новых транскрибаций (лимит ${MAX_WHISPER_PER_RUN})...`);
  const audioPath = downloadPlanfixFile(audioFile.id);
  if (!audioPath) { console.log(`    ⚠️ Whisper: не удалось скачать файл ${audioFile.id} (${audioFile.name})`); return null; }
  try {
    const text = await whisperTranscribe(audioPath);
    if (text) {
      cache[cacheKey] = text;
      const aiC = loadAiCache();
      aiC[`whisper_${audioFile.id}`] = text;
      saveAiCache(aiC);
    }
    return text;
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }
}

module.exports = { downloadPlanfixFile, whisperTranscribe, transcribeCallIfNeeded, MAX_WHISPER_PER_RUN };
