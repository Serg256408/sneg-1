#!/usr/bin/env node
// ============================================================
// verify.js — CLI точка входа для верификатора отчётов
// ============================================================
// Использование:
//   node verify.js borovaya 05-04-2026     — один менеджер
//   node verify.js --all 05-04-2026        — все менеджеры
//   node verify.js --all                   — все, за сегодня

require('dotenv').config({ quiet: true });
const { MANAGERS_LIST } = require('./src/utils/config');
const { verifyManagerReport } = require('./src/core/verify');

function todayDMY() {
  const d = new Date(); d.setHours(d.getHours() + 3);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

async function main() {
  const args = process.argv.slice(2);
  const isAll = args.includes('--all');
  const dateArg = args.find(a => /^\d{2}-\d{2}-\d{4}$/.test(a));
  const aliasArg = args.find(a => !a.startsWith('--') && !/^\d{2}-\d{2}-\d{4}$/.test(a));
  const reportDate = dateArg || todayDMY();
  const results = [];

  console.log(`\n🔎 Верификатор отчётов (${reportDate})\n`);

  if (isAll) {
    for (const mgr of MANAGERS_LIST) {
      results.push(await verifyManagerReport(mgr.alias, reportDate));
    }
  } else {
    const alias = aliasArg || 'borovaya';
    results.push(await verifyManagerReport(alias, reportDate));
  }

  const failed = results.some(result => result?.checks?.some(check => check.status === 'fail'));
  if (failed) process.exitCode = 1;
}

main().catch(err => {
  console.error('❌ Ошибка верификации:', err.message);
  process.exit(1);
});
