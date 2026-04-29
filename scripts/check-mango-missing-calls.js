#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { isMangoConfigured, loadMangoCallsForDate } = require('../src/api/mango');
const { normalizePhone, timeToMinNode } = require('../src/utils/helpers');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DEFAULT_DATE = '28-04-2026';
const MIN_USEFUL_TRANSCRIPT_CHARS = 20;

function usage() {
  console.log('Usage: node scripts/check-mango-missing-calls.js [DD-MM-YYYY] [managerAlias,managerAlias]');
}

function parseArgs() {
  const date = (process.argv[2] || DEFAULT_DATE).trim();
  const managers = String(process.argv[3] || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);

  if (!/^\d{2}-\d{2}-\d{4}$/.test(date)) {
    usage();
    throw new Error(`Invalid date: ${date}`);
  }

  return { date, managers };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function callRecordingFiles(comment) {
  return (comment.files || []).filter(file => /запись\s+звонка/i.test(file.name || ''));
}

function isCallComment(comment) {
  const type = String(comment.type || '').toLowerCase();
  return type.includes('call') || callRecordingFiles(comment).length > 0;
}

function hasUsefulTranscript(comment) {
  const text = String(comment.transcription || '').trim();
  return text.length >= MIN_USEFUL_TRANSCRIPT_CHARS;
}

function minutesFromText(value) {
  return String(value || '')
    .match(/\d{1,2}:\d{2}/g)
    ?.map(timeToMinNode)
    .filter(Number.isFinite) || [];
}

function nearestCalls(deal, comment, reportDate) {
  const targetTimes = minutesFromText(comment.time);
  const target = targetTimes.length ? targetTimes[0] : timeToMinNode(comment.time);

  const scored = (deal.calls || [])
    .filter(call => call.date === reportDate)
    .map(call => {
      const times = minutesFromText(call.time);
      const diff = times.length
        ? Math.min(...times.map(t => Math.abs(t - target)))
        : Math.abs(timeToMinNode(call.time) - target);
      return { call, diff };
    })
    .sort((a, b) => a.diff - b.diff || (b.call.duration || 0) - (a.call.duration || 0));

  const close = scored.filter(item => item.diff <= 5).map(item => item.call);
  return close.length ? close : scored.slice(0, 1).map(item => item.call);
}

function collectMissingCalls(report, reportDate) {
  const rows = [];
  for (const deal of report.dealCards || []) {
    for (const comment of deal.comments || []) {
      if (comment.date !== reportDate) continue;
      if (!isCallComment(comment)) continue;
      if (hasUsefulTranscript(comment)) continue;

      const relatedCalls = nearestCalls(deal, comment, reportDate);
      const files = callRecordingFiles(comment);
      const phones = [...new Set(relatedCalls.map(call => normalizePhone(call.phone || '')).filter(Boolean))];

      rows.push({
        manager: report.manager || report.managerPfName || report.managerAlias || '',
        managerAlias: report.managerAlias || '',
        managerName: report.manager || report.managerPfName || '',
        dealId: deal.id,
        dealName: deal.name,
        commentId: comment.id,
        time: comment.time,
        type: comment.type,
        phones,
        planfixFiles: files,
        relatedCalls,
        transcriptChars: String(comment.transcription || '').trim().length,
      });
    }
  }
  return rows;
}

function loadReports(date, managerFilter) {
  const files = fs.readdirSync(DATA_DIR)
    .filter(name => name.endsWith('_latest.json'))
    .sort();

  const reports = [];
  for (const name of files) {
    const file = path.join(DATA_DIR, name);
    const report = readJson(file);
    const alias = String(report.managerAlias || name.replace(/_latest\.json$/, '')).toLowerCase();
    if (managerFilter.length && !managerFilter.includes(alias)) continue;
    if (report.reportDate !== date) continue;
    reports.push({ ...report, managerAlias: alias, sourceFile: file });
  }

  return reports;
}

function formatFile(file) {
  if (!file) return 'нет файла';
  return `${file.id || '?'} ${file.name || ''}`.trim();
}

function formatCalls(calls) {
  if (!calls.length) return 'нет строки звонка в data';
  return calls
    .map(call => `${call.time || '?'} ${call.phone || '?'} ${call.contact || ''} ${call.duration || 0}s`.trim())
    .join('; ');
}

function formatMangoMatch(match) {
  if (!match) return 'не найдено';
  const call = match || {};
  const numbers = [call.fromNumber, call.toNumber].filter(Boolean).join(' -> ') || 'номер не указан';
  const recording = call.recordingIds?.length ? `rec=${call.recordingIds[0]}` : 'записи нет';
  return `${call.time || '?'} ${call.duration || 0}s ${recording} ${numbers}`;
}

function callMatchesPhones(call, phones) {
  const wanted = new Set((phones || []).map(normalizePhone).filter(Boolean));
  if (!wanted.size) return false;
  return wanted.has(call.fromNumber) || wanted.has(call.toNumber);
}

function findBestMangoCall(calls, item, windowMin = 10) {
  const targetMin = timeToMinNode(item.time);
  return calls
    .filter(call => callMatchesPhones(call, item.phones))
    .map(call => ({ call, diff: Math.abs(timeToMinNode(call.time) - targetMin) }))
    .filter(item => item.diff <= windowMin)
    .sort((a, b) => a.diff - b.diff || b.call.duration - a.call.duration)[0]?.call || null;
}

async function main() {
  const { date, managers } = parseArgs();
  const reports = loadReports(date, managers);
  const candidates = reports.flatMap(report => collectMissingCalls(report, date));

  console.log(`Mango targeted call check: ${date}`);
  console.log(`Managers: ${reports.map(r => r.managerAlias).join(', ') || 'none'}`);
  const mangoConfigured = isMangoConfigured();
  console.log(`Mango configured: ${mangoConfigured ? 'yes' : 'no'}`);
  console.log(`Planfix calls without usable transcript: ${candidates.length}`);
  const mangoCalls = mangoConfigured ? await loadMangoCallsForDate(date) : [];

  const results = [];
  for (const item of candidates) {
    const match = mangoConfigured && item.phones.length ? findBestMangoCall(mangoCalls, item) : null;
    const status = !mangoConfigured
      ? 'MANGO_DISABLED'
      : (match
        ? (match.recordingIds.length ? 'FOUND_WITH_RECORD' : 'FOUND_NO_RECORD')
        : (item.phones.length ? 'NOT_FOUND' : 'NO_PHONE'));
    const result = {
      status,
      managerAlias: item.managerAlias,
      manager: item.manager,
      dealId: item.dealId,
      dealName: item.dealName,
      time: item.time,
      phones: item.phones,
      planfixFileIds: item.planfixFiles.map(file => String(file.id || '')),
      planfixFileNames: item.planfixFiles.map(file => file.name || ''),
      relatedCalls: item.relatedCalls.map(call => ({
        time: call.time,
        phone: call.phone,
        contact: call.contact,
        duration: call.duration,
      })),
      mango: match ? {
        time: match.time,
        duration: match.duration,
        recordingId: match.recordingIds[0] || '',
        hasRecording: match.recordingIds.length > 0,
        fromNumber: match.fromNumber,
        toNumber: match.toNumber,
        fromExtension: match.fromExtension,
        toExtension: match.toExtension,
      } : null,
    };
    results.push(result);

    console.log('');
    console.log(`[${status}] ${item.manager} #${item.dealId} ${item.time} ${item.dealName}`);
    console.log(`  Planfix: ${item.planfixFiles.map(formatFile).join('; ') || 'нет файла'}`);
    console.log(`  Data call: ${formatCalls(item.relatedCalls)}`);
    console.log(`  Mango: ${formatMangoMatch(match)}`);
  }

  const summary = results.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  console.log('');
  console.log(`Summary: ${JSON.stringify(summary)}`);
  console.log('RESULT_JSON_START');
  console.log(JSON.stringify(results, null, 2));
  console.log('RESULT_JSON_END');
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
