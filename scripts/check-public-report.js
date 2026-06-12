#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

function todayDMY() {
  const d = new Date();
  d.setHours(d.getHours() + 3);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

function publicReportUrl(alias) {
  if (process.env.REPORT_PUBLIC_URL) return process.env.REPORT_PUBLIC_URL;
  const base = (process.env.REPORT_PUBLIC_BASE_URL || 'https://serg256408.github.io/sneg-1').replace(/\/+$/, '');
  return `${base}/${alias}/index.html`;
}

function cacheBusted(url) {
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}fresh=${Date.now()}`;
}

function extractField(html, field) {
  const re = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`);
  return html.match(re)?.[1] || '';
}

function writeArtifact(alias, payload) {
  const target = path.join(ROOT_DIR, 'reports', `public_check_${alias}_latest.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

function printTable(rows) {
  const headers = ['Проверка', 'Статус', 'Значение'];
  const data = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...data.map(row => [...String(row[i] || '')].length)));
  const pad = (value, width) => `${value}${' '.repeat(Math.max(0, width - [...String(value || '')].length))}`;
  const line = row => row.map((value, i) => pad(value, widths[i])).join(' | ');
  console.log(line(headers));
  console.log(widths.map(w => '-'.repeat(w)).join('-+-'));
  for (const row of rows) console.log(line(row));
}

async function main() {
  const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  const alias = args[0] || 'borovaya';
  const expectedDate = args.find(arg => /^\d{2}-\d{2}-\d{4}$/.test(arg)) || todayDMY();
  const url = cacheBusted(publicReportUrl(alias));
  const startedAt = Date.now();

  let httpStatus = 0;
  let httpOk = false;
  let reportDate = '';
  let generated = '';
  let bytes = 0;
  let error = '';

  try {
    const res = await fetch(url, { cache: 'no-store' });
    httpStatus = res.status;
    httpOk = res.ok;
    const html = await res.text();
    bytes = Buffer.byteLength(html, 'utf8');
    reportDate = extractField(html, 'reportDate');
    generated = extractField(html, 'generated');
  } catch (err) {
    error = err.message;
  }

  const checks = {
    http: httpOk,
    date: reportDate === expectedDate,
    content: bytes > 10 * 1024,
  };
  const ok = checks.http && checks.date && checks.content;
  const payload = {
    alias,
    expectedDate,
    url,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    ok,
    checks,
    httpStatus,
    reportDate,
    generated,
    bytes,
    error,
  };
  const artifact = writeArtifact(alias, payload);

  printTable([
    ['HTTP', checks.http ? 'OK' : 'FAIL', String(httpStatus || error || '-')],
    ['Дата отчёта', checks.date ? 'OK' : 'FAIL', `${reportDate || '-'} / ${expectedDate}`],
    ['Размер HTML', checks.content ? 'OK' : 'FAIL', `${Math.round(bytes / 1024)} KB`],
    ['Артефакт', 'OK', path.relative(ROOT_DIR, artifact)],
  ]);

  if (!ok) process.exitCode = 1;
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
