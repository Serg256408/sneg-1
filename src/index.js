// ============================================================
// index.js — Точка входа: CLI, запуск менеджеров, роутинг
// ============================================================

const { fs, path, ROOT_DIR, TOKEN, MANAGERS, MANAGERS_LIST } = require('./utils/config');
const { sleep, pad2 } = require('./utils/helpers');
const { loadAiCache, saveAiCache } = require('./core/cache');
const { buildDealCards } = require('./core/deals');
const {
  pf, getAllTasks, getActiveTasks, getLightTasks,
  getPlanfixRestStats, diffPlanfixRestStats, savePlanfixRestUsage,
} = require('./api/planfix');
const { generateHtml } = require('./report/html');
const { generateDashboard } = require('./report/dashboard');
const { writeFileWithRetry, writeJsonWithRetry } = require('./utils/safe-write');

// ============ Пути файлов для менеджера ============
function mgrDataFile(alias) { return path.join(ROOT_DIR, 'data', `${alias}_latest.json`); }
function mgrFunnelFile(alias) { return path.join(ROOT_DIR, 'data', `${alias}_funnel.json`); }
function mgrReportFile(alias) { return path.join(ROOT_DIR, 'reports', `${alias}.html`); }
function mgrDeployDir(alias) { return path.join(ROOT_DIR, 'deploy', alias); }

function writeManagerHtmlOutputs(mgr, outData) {
  const htmlReport = generateHtml(mgr.name, outData, MANAGERS_LIST, 'reports');
  const htmlRoot = generateHtml(mgr.name, outData, MANAGERS_LIST, 'root');
  const htmlDeploy = generateHtml(mgr.name, outData, MANAGERS_LIST, 'deploy');

  if (!fs.existsSync(mgrDeployDir(mgr.alias))) fs.mkdirSync(mgrDeployDir(mgr.alias), { recursive: true });

  writeFileWithRetry(mgrReportFile(mgr.alias), htmlReport);
  writeFileWithRetry(path.join(ROOT_DIR, 'report.html'), htmlRoot);
  writeFileWithRetry(path.join(mgrDeployDir(mgr.alias), 'index.html'), htmlDeploy);
}

function reportDateToIso(reportDate) {
  const m = String(reportDate || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function htmlizeText(text) {
  return String(text || '')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
}

function formatPlanfixUsageLine(usage) {
  const top = (usage?.topEndpoints || [])
    .slice(0, 4)
    .map(item => `${item.endpoint}=${item.count}`)
    .join(', ');
  return `  📡 Planfix API: ${usage?.total || 0} запросов${top ? ` (${top})` : ''}`;
}

function buildDealAssessmentComment(aa, reportDate) {
  const ss = aa.salaryScore || {};
  let h = `<b>🤖 ИИ-оценка сделки за ${reportDate}</b><br><br>`;
  if (aa.todaySummary) h += `📅 <b>Итог дня:</b> ${aa.todaySummary}<br><br>`;
  if (aa.overallVerdict) h += `📊 <b>Вердикт:</b> ${aa.overallVerdict}<br><br>`;
  h += '<b>📋 Скрипт продаж:</b><br>';
  const vp = aa.verbalPresentation;
  if (vp) h += `&nbsp;&nbsp;Устная презентация: ${vp.overall ? '✅ (' + vp.source + ')' : '❌'}<br>`;
  const hw = aa.howWeWork;
  if (hw) h += `&nbsp;&nbsp;Как мы работаем: ${hw.done ? '✅ (' + hw.source + ')' : '❌'}<br>`;
  if (aa.writtenPresentation) h += `&nbsp;&nbsp;Презентация (файл): ${aa.writtenPresentation.done ? '✅' : '❌'}<br>`;
  if (aa.cp) h += `&nbsp;&nbsp;КП: ${aa.cp.done ? '✅' : '❌'}${aa.cp.note ? ' — ' + aa.cp.note : ''}<br>`;
  if (aa.invoice) h += `&nbsp;&nbsp;Счёт: ${aa.invoice.done ? '✅' : '❌'}${aa.invoice.note ? ' — ' + aa.invoice.note : ''}<br>`;
  if (aa.callToAction) h += `&nbsp;&nbsp;Призыв к действию: ${aa.callToAction.done ? '✅' : '❌'}<br>`;
  if (aa.objectionHandling) h += `&nbsp;&nbsp;Отработка возражений: ${aa.objectionHandling.done ? '✅' : '❌'}<br>`;
  h += `<br><b>💰 Баллы ЗП: ${ss.total}/${ss.max}</b><br>`;
  const miss = aa.missing || [];
  if (miss.length) {
    h += '<br><b>❗ Не выполнено:</b><br>';
    for (const m of miss) h += `&nbsp;&nbsp;• ${m}<br>`;
  }
  const recs = aa.recommendations || [];
  if (recs.length) {
    h += '<br><b>💡 Рекомендации:</b><br>';
    for (const r of recs) h += `&nbsp;&nbsp;• ${r}<br>`;
  }
  if (aa.nextStep) h += `<br><b>▶ Следующий шаг:</b> ${aa.nextStep}<br>`;
  return h;
}

async function autoSendDealRecommendations(dailyDealActivity, reportDate, aiCache) {
  if (!dailyDealActivity.length) return;

  const toSend = dailyDealActivity.filter(da => {
    if (!da.aiAssessment || !da.aiAssessment.missing || !da.aiAssessment.missing.length) return false;
    return !aiCache[`sent_${da.deal.id}_${reportDate}`];
  });

  if (!toSend.length) return;

  console.log(`\n📤 Автоотправка ИИ-рекомендаций в Planfix (${toSend.length} сделок за ${reportDate})...`);
  let sent = 0;
  let failed = 0;

  for (const da of toSend) {
    try {
      await pf(`/task/${da.deal.id}/comments/`, { description: buildDealAssessmentComment(da.aiAssessment, reportDate) });
      sent++;
      aiCache[`sent_${da.deal.id}_${reportDate}`] = true;
      process.stdout.write(`  ✅ #${da.deal.id} `);
    } catch (e) {
      failed++;
      process.stdout.write(`  ❌ #${da.deal.id} `);
    }
    await sleep(300);
  }

  console.log(`\n  📤 Отправлено: ${sent}, ошибок: ${failed}`);
}

function buildManagerSummaryComment(mgr, reportDate, aiDaySummaryText, managerSummaries) {
  let h = `<b>🤖 ИИ-сводка менеджера за ${reportDate}</b><br><br>`;
  h += `<b>Менеджер:</b> ${mgr.name}<br>`;
  h += `<b>Дата отчета:</b> ${reportDate}<br><br>`;

  if (aiDaySummaryText) {
    h += `<b>📅 Итог дня</b><br>${htmlizeText(aiDaySummaryText)}<br><br>`;
  }

  if (managerSummaries?.day) {
    h += `<b>👔 Вывод для руководителя</b><br>${htmlizeText(managerSummaries.day)}<br><br>`;
  }

  h += 'Полный HTML-отчет уже сгенерирован и обновлен в GitHub.';
  return h;
}

async function autoSendManagerSummary(mgr, reportDate, dailyReports, aiDaySummaryText, managerSummaries, aiCache) {
  if (!aiDaySummaryText && !managerSummaries?.day) return;

  const reportTaskDate = reportDateToIso(reportDate);
  const reportTask = (dailyReports || []).find(r => r.date === reportTaskDate);
  if (!reportTask) {
    console.log(`  ℹ️ Задача ежедневного отчета за ${reportDate} для ${mgr.name} не найдена, сводку не отправляю`);
    return;
  }

  const sentKey = `sent_manager_${mgr.alias}_${reportDate}`;
  if (aiCache[sentKey]) {
    console.log(`  ℹ️ ИИ-сводка менеджеру за ${reportDate} уже отправлялась`);
    return;
  }

  await pf(`/task/${reportTask.id}/comments/`, {
    description: buildManagerSummaryComment(mgr, reportDate, aiDaySummaryText, managerSummaries),
  });
  aiCache[sentKey] = true;
  console.log(`  ✅ ИИ-сводка отправлена в задачу отчета #${reportTask.id}`);
}

// ============ Один менеджер ============
async function runForManager(mgr, reportDate) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 ${mgr.name} — ${reportDate}\n`);

  // Обеспечиваем директории
  for (const d of [path.join(ROOT_DIR, 'data'), path.join(ROOT_DIR, 'reports'), mgrDeployDir(mgr.alias)])
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

  const planfixApiStart = getPlanfixRestStats();
  const result = await buildDealCards(mgr.userId, reportDate, mgr.pfName);
  const planfixApiUsage = diffPlanfixRestStats(planfixApiStart);
  const {
    dealCards, dailyReports, allCalls, allAnalyses, dailyActivity, funnelCards, funnelChanges, scriptCompliance,
    dailyDealActivity, aiDaySummaryText, multiDayActivity, multiDaySummary,
    measurements, measurementsSummary, measurementsComparison,
  } = result;

  console.log(`\n  📊 Сделок с звонками: ${dealCards.filter(d => d.totalCalls > 0).length}`);
  console.log(`  📞 Всего звонков: ${allCalls.length}`);
  console.log(`  🔍 Всего анализов: ${allAnalyses.length}`);
  console.log(`  📅 Ежедневных отчётов: ${dailyReports.length}`);
  console.log(`  🆕 Новых сделок за день: ${dailyActivity.newDeals.length}`);
  console.log(`  ⚡ Обработано за день: ${dailyActivity.workedDeals.length}`);
  console.log(`  🔄 Изменений воронки: ${funnelChanges.length}`);
  console.log(`  📝 Анализов новых сделок: ${scriptCompliance.total}`);
  console.log(`  🤖 ИИ-сделок за день: ${dailyDealActivity.length}`);
  console.log(`  📐 Замеров в базе: ${(measurements || []).length}`);
  console.log(formatPlanfixUsageLine(planfixApiUsage));

  const outData = {
    generated: new Date().toISOString(),
    manager: mgr.name,
    managerPfName: mgr.pfName,
    managerAlias: mgr.alias,
    reportDate,
    dealCards, dailyReports, allCalls, allAnalyses, dailyActivity, funnelCards: funnelCards || [], funnelChanges, scriptCompliance,
    dailyDealActivity, aiDaySummaryText,
    multiDayActivity, multiDaySummary,
    managerSummaries: result.managerSummaries || {},
    incomingByDate: result.incomingByDate || {},
    snapshotDate: result.snapshotDate,
    measurements: measurements || [],
    measurementsSummary: measurementsSummary || {},
    measurementsComparison: measurementsComparison || {},
    planfixApiUsage,
  };

  // Сохраняем данные (per-manager + совместимость со старым latest_data.json)
  writeJsonWithRetry(mgrDataFile(mgr.alias), outData);
  writeJsonWithRetry(path.join(ROOT_DIR, 'latest_data.json'), outData);
  savePlanfixRestUsage({
    scope: 'manager',
    reportDate,
    managerAlias: mgr.alias,
    managerName: mgr.name,
    total: planfixApiUsage.total,
    cumulativeTotal: planfixApiUsage.cumulativeTotal,
    byEndpoint: planfixApiUsage.byEndpoint,
    topEndpoints: planfixApiUsage.topEndpoints,
    rateLimit: planfixApiUsage.rateLimit,
    startedAt: planfixApiUsage.startedAt,
    finishedAt: planfixApiUsage.finishedAt,
  });

  // HTML
  const htmlPath = mgrReportFile(mgr.alias);
  writeManagerHtmlOutputs(mgr, outData);

  console.log(`\n🌐 ${htmlPath}`);

  // === Автоотправка ИИ-рекомендаций в Planfix за текущий день ===
  if (!process.argv.includes('--no-send')) {
    const aiCache = loadAiCache();
    await autoSendDealRecommendations(dailyDealActivity, reportDate, aiCache);
    try {
      await autoSendManagerSummary(mgr, reportDate, dailyReports, aiDaySummaryText, outData.managerSummaries, aiCache);
    } catch (e) {
      console.log(`  ⚠️ ИИ-сводку менеджеру не удалось отправить: ${e.message || e}`);
    }
    saveAiCache(aiCache);
    const toSend = [];
    if (toSend.length) {
      console.log(`\n📤 Автоотправка ИИ-рекомендаций в Planfix (${toSend.length} сделок за ${reportDate})...`);
      let sent = 0, failed = 0;
      for (const da of toSend) {
        const aa = da.aiAssessment;
        const ss = aa.salaryScore || {};
        let h = `<b>🤖 ИИ-оценка сделки за ${reportDate}</b><br><br>`;
        if (aa.todaySummary) h += `📅 <b>Итог дня:</b> ${aa.todaySummary}<br><br>`;
        if (aa.overallVerdict) h += `📊 <b>Вердикт:</b> ${aa.overallVerdict}<br><br>`;
        h += '<b>📋 Скрипт продаж:</b><br>';
        const vp = aa.verbalPresentation;
        if (vp) h += `&nbsp;&nbsp;Устная презентация: ${vp.overall ? '✅ (' + vp.source + ')' : '❌'}<br>`;
        const hw = aa.howWeWork;
        if (hw) h += `&nbsp;&nbsp;Как мы работаем: ${hw.done ? '✅ (' + hw.source + ')' : '❌'}<br>`;
        if (aa.writtenPresentation) h += `&nbsp;&nbsp;Презентация (файл): ${aa.writtenPresentation.done ? '✅' : '❌'}<br>`;
        if (aa.cp) h += `&nbsp;&nbsp;КП: ${aa.cp.done ? '✅' : '❌'}${aa.cp.note ? ' — ' + aa.cp.note : ''}<br>`;
        if (aa.invoice) h += `&nbsp;&nbsp;Счёт: ${aa.invoice.done ? '✅' : '❌'}${aa.invoice.note ? ' — ' + aa.invoice.note : ''}<br>`;
        if (aa.callToAction) h += `&nbsp;&nbsp;Призыв к действию: ${aa.callToAction.done ? '✅' : '❌'}<br>`;
        if (aa.objectionHandling) h += `&nbsp;&nbsp;Отработка возражений: ${aa.objectionHandling.done ? '✅' : '❌'}<br>`;
        h += `<br><b>💰 Баллы ЗП: ${ss.total}/${ss.max}</b><br>`;
        const miss = aa.missing || [];
        if (miss.length) { h += '<br><b>❗ Не выполнено:</b><br>'; for (const m of miss) h += `&nbsp;&nbsp;• ${m}<br>`; }
        const recs = aa.recommendations || [];
        if (recs.length) { h += '<br><b>💡 Рекомендации:</b><br>'; for (const r of recs) h += `&nbsp;&nbsp;• ${r}<br>`; }
        if (aa.nextStep) { h += `<br><b>▶ Следующий шаг:</b> ${aa.nextStep}<br>`; }
        try {
          await pf(`/task/${da.deal.id}/comments/`, { description: h });
          sent++;
          aiCache[`sent_${da.deal.id}_${reportDate}`] = true;
          process.stdout.write(`  ✅ #${da.deal.id} `);
        } catch (e) {
          failed++;
          process.stdout.write(`  ❌ #${da.deal.id} `);
        }
        await sleep(300);
      }
      saveAiCache(aiCache);
      console.log(`\n  📤 Отправлено: ${sent}, ошибок: ${failed}`);
    }
  }

  console.log(`✅ ${mgr.name} — готово!`);
  return outData;
}

// ============ MAIN ============
async function main() {
  // Режим --html: перегенерация HTML из кэша
  if (process.argv.includes('--html')) {
    const rawName = process.argv.find(a => a !== '--html' && !a.endsWith('.js') && !a.startsWith('--') && a !== 'node');
    if (rawName && MANAGERS[rawName]) {
      const mgr = MANAGERS[rawName];
      const dataPath = mgrDataFile(mgr.alias);
      const fallback = path.join(ROOT_DIR, 'latest_data.json');
      const dataFile = fs.existsSync(dataPath) ? dataPath : fallback;
      if (!fs.existsSync(dataFile)) { console.error('❌ Данные не найдены'); process.exit(1); }
      const outData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      writeManagerHtmlOutputs(mgr, outData);
      console.log(`✅ HTML: ${mgrReportFile(mgr.alias)}`);
    } else {
      for (const mgr of MANAGERS_LIST) {
        const dataPath = mgrDataFile(mgr.alias);
        const fallback = path.join(ROOT_DIR, 'latest_data.json');
        const dataFile = fs.existsSync(dataPath) ? dataPath : fallback;
        if (!fs.existsSync(dataFile)) continue;
        const outData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        writeManagerHtmlOutputs(mgr, outData);
        console.log(`✅ HTML: ${mgrReportFile(mgr.alias)}`);
      }
      const now = new Date();
      generateDashboard(`${pad2(now.getDate())}-${pad2(now.getMonth()+1)}-${now.getFullYear()}`, mgrDataFile);
    }
    return;
  }

  if (!TOKEN) { console.error('❌ PLANFIX_TOKEN не задан'); process.exit(1); }

  // Определяем дату отчёта
  const dateArg = process.argv.find(a => /^\d{2}-\d{2}-\d{4}$/.test(a));
  let reportDate;
  if (dateArg) {
    reportDate = dateArg;
  } else {
    const now = new Date();
    reportDate = `${pad2(now.getDate())}-${pad2(now.getMonth()+1)}-${now.getFullYear()}`;
  }

  // Режим --all: все менеджеры
  if (process.argv.includes('--all')) {
    console.log(`🚀 ТрансКом v9.0 — ВСЕ менеджеры — ${reportDate}`);
    console.log(`   Менеджеров: ${MANAGERS_LIST.length}\n`);
    for (const mgr of MANAGERS_LIST) {
      await runForManager(mgr, reportDate);
    }
    generateDashboard(reportDate, mgrDataFile);
    savePlanfixRestUsage({ scope: 'all-managers', reportDate, managerCount: MANAGERS_LIST.length });
    console.log('\n✅ Все отчёты готовы!');
    return;
  }

  // Один менеджер (обратная совместимость)
  const rawFilterName = (process.argv[2] || 'Боровая').trim();
  const mgr = MANAGERS[rawFilterName] || MANAGERS[rawFilterName.toLowerCase()];
  if (!mgr) { console.error('❌ Менеджер не найден'); process.exit(1); }

  await runForManager(mgr, reportDate);
  generateDashboard(reportDate, mgrDataFile);
  savePlanfixRestUsage({ scope: 'single-manager', reportDate, managerAlias: mgr.alias, managerName: mgr.name });

  try {
    const { exec } = require('child_process');
    exec(process.platform === 'win32' ? `start "" "${path.join(ROOT_DIR, 'report.html')}"` : `xdg-open "${path.join(ROOT_DIR, 'report.html')}"`);
  } catch {}
}

// === Отправка рекомендаций в Planfix ===
async function sendRecommendations(taskIdFilter) {
  const dataFile = path.join(ROOT_DIR, 'latest_data.json');
  if (!fs.existsSync(dataFile)) { console.error('❌ latest_data.json не найден. Сначала запустите отчёт.'); return; }
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const deals = data.dailyDealActivity || [];
  if (!deals.length) { console.log('Нет сделок с дневной активностью.'); return; }

  const toSend = taskIdFilter === 'all'
    ? deals.filter(d => d.aiAssessment)
    : deals.filter(d => d.deal.id === Number(taskIdFilter) && d.aiAssessment);

  if (!toSend.length) { console.log(`Нет сделок для отправки${taskIdFilter !== 'all' ? ' (ID: ' + taskIdFilter + ')' : ''}`); return; }

  console.log(`📤 Отправка ИИ-рекомендаций в Planfix для ${toSend.length} сделок...\n`);

  for (const da of toSend) {
    const aa = da.aiAssessment;
    const ss = aa.salaryScore || {};
    let h = `<b>🤖 ИИ-оценка сделки за ${data.reportDate}</b><br><br>`;
    if (aa.todaySummary) h += `📅 <b>Итог дня:</b> ${aa.todaySummary}<br><br>`;
    if (aa.overallVerdict) h += `📊 <b>Вердикт:</b> ${aa.overallVerdict}<br><br>`;
    h += '<b>📋 Скрипт продаж:</b><br>';
    const vp = aa.verbalPresentation;
    if (vp) h += `&nbsp;&nbsp;Устная презентация: ${vp.overall ? '✅ (' + vp.source + ')' : '❌'}<br>`;
    const hw = aa.howWeWork;
    if (hw) h += `&nbsp;&nbsp;Как мы работаем: ${hw.done ? '✅ (' + hw.source + ')' : '❌'}<br>`;
    if (aa.writtenPresentation) h += `&nbsp;&nbsp;Презентация (файл): ${aa.writtenPresentation.done ? '✅' : '❌'}<br>`;
    if (aa.cp) h += `&nbsp;&nbsp;КП: ${aa.cp.done ? '✅' : '❌'}${aa.cp.note ? ' — ' + aa.cp.note : ''}<br>`;
    if (aa.invoice) h += `&nbsp;&nbsp;Счёт: ${aa.invoice.done ? '✅' : '❌'}${aa.invoice.note ? ' — ' + aa.invoice.note : ''}<br>`;
    if (aa.callToAction) h += `&nbsp;&nbsp;Призыв к действию: ${aa.callToAction.done ? '✅' : '❌'}<br>`;
    if (aa.objectionHandling) h += `&nbsp;&nbsp;Отработка возражений: ${aa.objectionHandling.done ? '✅' : '❌'}<br>`;
    h += `<br><b>💰 Баллы ЗП: ${ss.total}/${ss.max}</b><br>`;
    const miss = aa.missing || [];
    if (miss.length) { h += '<br><b>❗ Не выполнено:</b><br>'; for (const m of miss) h += `&nbsp;&nbsp;• ${m}<br>`; }
    const recs = aa.recommendations || [];
    if (recs.length) { h += '<br><b>💡 Рекомендации:</b><br>'; for (const r of recs) h += `&nbsp;&nbsp;• ${r}<br>`; }
    if (aa.nextStep) { h += `<br><b>▶ Следующий шаг:</b> ${aa.nextStep}<br>`; }

    try {
      await pf(`/task/${da.deal.id}/comments/`, { description: h });
      console.log(`  ✅ #${da.deal.id} ${da.deal.name.substring(0, 40)} — отправлено`);
    } catch (e) {
      console.error(`  ❌ #${da.deal.id} — ошибка: ${e.message || JSON.stringify(e)}`);
    }
    await sleep(300);
  }
  console.log('\n✅ Готово!');
}

// Роутинг команд
const cmd = process.argv[3] || '';
if (cmd === '--send' || cmd === '--send-all') {
  const target = process.argv[4] || 'all';
  sendRecommendations(target).catch(e => { console.error('❌', e.message || e); process.exit(1); });
} else {
  main().catch(e => { console.error('❌', e.message || e); process.exit(1); });
}
