const crypto = require('crypto');
const { fs, path, os, API_URL, TOKEN, OPENAI_KEY, POLZA_KEY, isTimeUp } = require('../utils/config');
const {
  saveAiCache, loadAiCache, loadTranscriptionCache, saveTranscriptionCache,
} = require('../core/cache');

const MAX_WHISPER_PER_RUN = parseInt(process.env.MAX_WHISPER_PER_RUN || '150', 10) || 150;
let whisperCallsThisRun = 0;
const AUDIO_EXT_RE = /\.(mp3|mpga|mpeg|m4a|mp4|wav|webm|ogg|oga|flac)$/i;
const inFlightTranscriptions = new Map();
let warnedNoTranscriptionProvider = false;

function getFileName(file) {
  if (typeof file === 'string') return file.trim();
  return String(file?.name || file?.fileName || '').trim();
}

function buildAudioSignature(file) {
  const normalized = getFileName(file).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

function findCallAudioFile(files) {
  return (files || []).find((file) => {
    const name = getFileName(file).toLowerCase();
    if (!name) return false;
    return name.includes('запись звонка') || AUDIO_EXT_RE.test(name);
  }) || null;
}

function getCachedTranscription(cache, audioFile) {
  const fileId = String(audioFile?.id || '');
  if (fileId && cache[fileId]) return cache[fileId];

  const signature = buildAudioSignature(audioFile);
  if (signature && cache[`sig:${signature}`]) {
    if (fileId) cache[fileId] = cache[`sig:${signature}`];
    return cache[`sig:${signature}`];
  }

  return null;
}

function persistTranscription(cache, audioFile, text) {
  if (!audioFile || !text) return;

  const fileId = String(audioFile.id || '');
  const signature = buildAudioSignature(audioFile);

  if (fileId) cache[fileId] = text;
  if (signature) cache[`sig:${signature}`] = text;

  const aiCache = loadAiCache();
  if (fileId) aiCache[`whisper_${fileId}`] = text;
  if (signature) aiCache[`whisper_sig_${signature}`] = text;
  saveAiCache(aiCache);

  const transcriptionCache = loadTranscriptionCache(true);
  if (fileId) transcriptionCache[fileId] = text;
  if (signature) transcriptionCache[`sig:${signature}`] = text;
  saveTranscriptionCache(transcriptionCache);
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

function parseTranscriptionResponse(result, provider, model) {
  const trimmed = String(result || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.error) {
        console.log(`    Warning: ${provider} error (${model}): ${(parsed.error.message || '').substring(0, 100)}`);
        return null;
      }
      const text = (parsed.text || parsed.transcription || '').trim();
      return text || null;
    } catch {}
  }
  if (trimmed.includes('"error"') || trimmed.includes('invalid_api_key') || trimmed.includes('Incorrect API key')) return null;
  return trimmed;
}

async function polzaTranscribe(audioPath) {
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
      const text = parseTranscriptionResponse(result, 'Polza Whisper', model);
      if (text) return text;
    } catch {}
  }
  return null;
}

async function openaiTranscribe(audioPath) {
  const { execFileSync } = require('child_process');
  const models = ['gpt-4o-mini-transcribe', 'whisper-1'];
  for (const model of models) {
    try {
      const result = execFileSync('curl', [
        '-s', '-L', '--ssl-no-revoke',
        'https://api.openai.com/v1/audio/transcriptions',
        '-H', `Authorization: Bearer ${OPENAI_KEY}`,
        '-F', `file=@${audioPath}`,
        '-F', `model=${model}`,
        '-F', 'language=ru',
        '-F', 'response_format=json',
      ], { encoding: 'utf8', timeout: 120000 });
      const text = parseTranscriptionResponse(result, 'OpenAI Whisper', model);
      if (text) return text;
    } catch {}
  }
  return null;
}

async function whisperTranscribe(audioPath) {
  if (POLZA_KEY) {
    const text = await polzaTranscribe(audioPath);
    if (text) return text;
  }
  if (OPENAI_KEY) {
    const text = await openaiTranscribe(audioPath);
    if (text) return text;
  }
  if (!POLZA_KEY && !OPENAI_KEY && !warnedNoTranscriptionProvider) {
    console.log('    Warning: POLZA_API_KEY or OPENAI_API_KEY is not set, new calls cannot be transcribed');
    warnedNoTranscriptionProvider = true;
  }
  return null;
}

async function transcribeCallIfNeeded(comment, cache, allowNew) {
  if (comment.transcription) return comment.transcription;
  const files = comment.files || [];
  const audioFile = findCallAudioFile(files);
  if (!audioFile) return null;

  const cached = getCachedTranscription(cache, audioFile);
  if (cached) {
    const fileId = String(audioFile.id || '');
    const signature = buildAudioSignature(audioFile);
    const hasFileId = fileId && cache[fileId];
    const hasSignature = signature && cache[`sig:${signature}`];
    if (!hasFileId || !hasSignature) persistTranscription(cache, audioFile, cached);
    return cached;
  }

  if (!allowNew) return null;
  if (!audioFile.id) {
    console.log(`    Warning: call audio has no Planfix file id (${getFileName(audioFile)})`);
    return null;
  }
  if (isTimeUp()) return null;
  if (whisperCallsThisRun >= MAX_WHISPER_PER_RUN) return null;

  const lockKey = String(audioFile.id || '') || `sig:${buildAudioSignature(audioFile)}` || getFileName(audioFile);
  if (inFlightTranscriptions.has(lockKey)) {
    return inFlightTranscriptions.get(lockKey);
  }

  whisperCallsThisRun++;
  if (whisperCallsThisRun === 1) {
    console.log(`    Whisper: new transcriptions, limit ${MAX_WHISPER_PER_RUN}...`);
  }

  const run = (async () => {
    const audioPath = downloadPlanfixFile(audioFile.id);
    if (!audioPath) {
      console.log(`    Warning: failed to download Planfix file ${audioFile.id} (${audioFile.name})`);
      return null;
    }

    try {
      const text = await whisperTranscribe(audioPath);
      if (text) persistTranscription(cache, audioFile, text);
      return text;
    } finally {
      try { fs.unlinkSync(audioPath); } catch {}
    }
  })();

  inFlightTranscriptions.set(lockKey, run);
  try {
    return await run;
  } finally {
    inFlightTranscriptions.delete(lockKey);
  }
}

async function transcribeExternalAudioIfNeeded(audioFile, audioPath, cache) {
  if (!audioFile || !audioPath) return null;

  const cached = getCachedTranscription(cache, audioFile);
  if (cached) return cached;

  if (isTimeUp()) return null;
  if (whisperCallsThisRun >= MAX_WHISPER_PER_RUN) return null;

  const lockKey = String(audioFile.id || '') || `sig:${buildAudioSignature(audioFile)}` || getFileName(audioFile);
  if (inFlightTranscriptions.has(lockKey)) {
    return inFlightTranscriptions.get(lockKey);
  }

  whisperCallsThisRun++;
  if (whisperCallsThisRun === 1) {
    console.log(`    Whisper: new transcriptions, limit ${MAX_WHISPER_PER_RUN}...`);
  }

  const run = (async () => {
    const text = await whisperTranscribe(audioPath);
    if (text) persistTranscription(cache, audioFile, text);
    return text;
  })();

  inFlightTranscriptions.set(lockKey, run);
  try {
    return await run;
  } finally {
    inFlightTranscriptions.delete(lockKey);
  }
}

module.exports = {
  downloadPlanfixFile,
  whisperTranscribe,
  transcribeCallIfNeeded,
  transcribeExternalAudioIfNeeded,
  getCachedTranscription,
  findCallAudioFile,
  buildAudioSignature,
  MAX_WHISPER_PER_RUN,
};
