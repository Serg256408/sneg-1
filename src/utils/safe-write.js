// ============================================================
// safe-write.js - retrying atomic file writes for Windows locks
// ============================================================

const { fs, path } = require('./config');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeFileWithRetry(filePath, contents, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let lastError = null;

  for (let attempt = 1; attempt <= 8; attempt++) {
    const tmp = path.join(dir, `${base}.${process.pid}.${Date.now()}.${attempt}.tmp`);
    try {
      if (Buffer.isBuffer(contents)) {
        fs.writeFileSync(tmp, contents);
      } else {
        fs.writeFileSync(tmp, contents, encoding);
      }
      fs.renameSync(tmp, filePath);
      return;
    } catch (e) {
      lastError = e;
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      if (attempt < 8) sleepSync(150 * attempt);
    }
  }

  throw lastError;
}

function writeJsonWithRetry(filePath, data) {
  writeFileWithRetry(filePath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { writeFileWithRetry, writeJsonWithRetry };
