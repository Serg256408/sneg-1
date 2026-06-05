const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const statusFile = path.join(root, 'reports', 'audit_compact_25_05_05_06_after_catchup.status.json');
const rawLog = path.join(root, 'reports', 'audit_compact_25_05_05_06_after_catchup.raw.log');
const outFile = path.join(root, 'reports', 'audit_compact_25_05_05_06_after_catchup.json');

function writeStatus(update) {
  const previous = fs.existsSync(statusFile)
    ? JSON.parse(fs.readFileSync(statusFile, 'utf8'))
    : {};
  const state = {
    ...previous,
    ...update,
    updated: new Date().toISOString(),
  };
  fs.writeFileSync(statusFile, JSON.stringify(state, null, 2));
}

function ids(value) {
  return (value || []).map(item => (typeof item === 'object' ? item.id : item)).filter(Boolean);
}

(async () => {
  const started = new Date().toISOString();
  writeStatus({
    started,
    finished: null,
    exitCode: null,
    command: 'node scripts/audit-planfix-registry-dates.js 25-05-2026..05-06-2026 borovaya,guzairov',
    output: outFile,
    rawLog,
  });

  try {
    const stdout = execFileSync(process.execPath, [
      'scripts/audit-planfix-registry-dates.js',
      '25-05-2026..05-06-2026',
      'borovaya,guzairov',
    ], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      env: process.env,
    });

    fs.writeFileSync(rawLog, stdout, 'utf8');
    const start = stdout.indexOf('RESULT_JSON_START');
    const end = stdout.indexOf('RESULT_JSON_END');
    if (start < 0 || end < 0) throw new Error('RESULT_JSON markers not found');
    const data = JSON.parse(stdout.slice(start + 'RESULT_JSON_START'.length, end).trim());
    const rows = (data.rows || []).map(row => ({
      date: row.date,
      managerAlias: row.managerAlias,
      rawPlanfixDeals: row.rawPlanfixDeals,
      localDeals: row.localDeals,
      assessed: row.assessed,
      callComments: row.callComments,
      recordingComments: row.recordingComments,
      missingRecordingTranscripts: row.missingRecordingTranscripts,
      shortTranscripts: row.shortTranscripts,
      reportableMissing: ids(row.reportableMissing),
      unloadable: ids(row.unloadable),
      nonReportable: ids(row.nonReportable),
      rawIds: row.rawIds || [],
      localIds: row.localIds || [],
      localReportDate: row.localReportDate,
      localGenerated: row.localGenerated,
    }));

    const compact = {
      generated: new Date().toISOString(),
      usage: data.usage,
      rows,
    };
    fs.writeFileSync(outFile, JSON.stringify(compact, null, 2), 'utf8');
    writeStatus({ finished: new Date().toISOString(), exitCode: 0 });
    process.exit(0);
  } catch (error) {
    writeStatus({ finished: new Date().toISOString(), exitCode: 1, error: error.message || String(error) });
    process.exit(1);
  }
})();
