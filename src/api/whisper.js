// ============================================================
// whisper.js — Транскрибация через Whisper (Polza.ai)
// ============================================================

const { fs, path, os, API_URL, TOKEN, POLZA_KEY, isTimeUp } = require('../utils/config');
const { saveAiCache, loadAiCache } = require('../core/cache');

const MAX_WHISPER_PER_RUN = 70;
let whisperCallsThisRun = 0;
const AUDIO_EXT_RE = /\.(mp3|mpga|mpeg|m4a|mp4|wav|webm|ogg|oga|flac)$/i;

function getFileName(file) {
  return String(file?.name || file?.fileName || '').trim();
}

function findCallAudioFile(files) {
  return (files || []).find((file) => {
    const name = getFileName(file).toLowerCase();
    if (!name) return false;
    return name.includes('запись звонка') || AUDIO_EXT_RE.test(name);
  }) || null;
}

function looksLikeHtmlOrError(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 512)).toString('utf8').toLowerCase();
  if (!head) return false;
  if (head.includes('<html') || head.includes('<!doctype html') || head.includes('<body') || head.includes('<head')) return true;
  if (head.trim().startsWith('{') && (head.includes('"error"') || head.includes('"result":"error"'))) return true;
  return false;
}

function downloadPlanfixFile(fileId) {
  const { execFileSync } = require('child_process');
  const tmpFile = path.join(
    os.tmpdir(),
    `pf_audio_${fileId}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`,
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync('curl', [
        '-s', '-L', '--ssl-no-revoke', '-o', tmpFile,
        `${API_URL}/file/${fileId}/download`,
        '-H', `Authorization: Bearer ${TOKEN}`,
      ], { timeout: 60000 });
      const stat = fs.statSync(tmpFile);
      if (stat.size < 100) {
        try { fs.unlinkSync(tmpFile); } catch {}
        continue;
      }
      const head = fs.readFileSync(tmpFile);
      if (looksLikeHtmlOrError(head)) {
        try { fs.unlinkSync(tmpFile); } catch {}
        continue;
      }
      return tmpFile;
    } catch {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }
  return null;
}

async function whisperTranscribe(audioPath) {
  if (!POLZA_KEY) return null;
  const { execFileSync } = require('child_process');
  const models = ['openai/whisper-1', 'openai/gpt-4o-mini-transcribe'];
  for (const model of models) {
    try {
      const result = execFileSync('curl', [
        '-s', '-L', '--ssl-no-revoke',
        'https://polza.ai/api/v1/audio/transcriptions',
        '-H', `Authorization: Bearer ${POLZA_KEY}`,
        '-F', `file=@${audioPath}`,
        '-F', `model=${model}`,
        '-F', 'language=ru',
        '-F', 'response_format=json',
      ], { encoding: 'utf8', timeout: 120000 });
      const trimmed = result.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.error) {
            console.log(`    ⚠️ Whisper error (${model}): ${(parsed.error.message || '').substring(0, 80)}`);
            continue;
          }
          const text = (parsed.text || parsed.transcription || '').trim();
          if (text) return text;
          continue;
        } catch {}
      }
      if (trimmed.includes('"error"') || trimmed.includes('invalid_api_key') || trimmed.includes('Incorrect API key')) continue;
      return trimmed;
    } catch {}
  }
  return null;
}

async function transcribeCallIfNeeded(comment, cache, allowNew) {
  if (comment.transcription) return comment.transcription;
  const files = comment.files || [];
  const audioFile = findCallAudioFile(files);
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

module.exports = {
  downloadPlanfixFile,
  whisperTranscribe,
  transcribeCallIfNeeded,
  findCallAudioFile,
  MAX_WHISPER_PER_RUN,
};
