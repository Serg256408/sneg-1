// ============================================================
// funnel.js — Снимки воронки, сравнение статусов
// ============================================================

const { fs } = require('../utils/config');
const { FUNNEL_ORDER } = require('../utils/config');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeJsonWithRetry(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
      return;
    } catch (e) {
      lastError = e;
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      if (attempt < 6) sleepSync(150 * attempt);
    }
  }
  throw lastError;
}

// ============ СНИМКИ ВОРОНКИ ============

function loadPreviousSnapshot(snapshotFile) {
  try {
    return JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  } catch { return null; }
}

function saveSnapshot(dealCards, snapshotFile) {
  const snapshot = {
    date: new Date().toISOString(),
    deals: {},
  };
  for (const d of dealCards) {
    snapshot.deals[d.id] = { name: d.name, status: d.status };
  }
  writeJsonWithRetry(snapshotFile, snapshot);
  return snapshot;
}

function computeFunnelChanges(prevSnapshot, currentCards) {
  if (!prevSnapshot) return [];
  const changes = [];
  for (const card of currentCards) {
    const prev = prevSnapshot.deals[card.id];
    if (prev && prev.status !== card.status) {
      const fromIdx = FUNNEL_ORDER.indexOf(prev.status);
      const toIdx = FUNNEL_ORDER.indexOf(card.status);
      changes.push({
        dealId: card.id,
        dealName: card.name,
        counterparty: card.counterparty,
        from: prev.status,
        to: card.status,
        direction: (fromIdx !== -1 && toIdx !== -1) ? (toIdx > fromIdx ? 'forward' : 'backward') : 'unknown',
      });
    }
  }
  return changes;
}

module.exports = { loadPreviousSnapshot, saveSnapshot, computeFunnelChanges };
