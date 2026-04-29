// ============================================================
// html.js — Генерация HTML-отчёта
// ============================================================

const { API_URL, TOKEN, FUNNEL_ORDER } = require('../utils/config');
const { loadAiCache } = require('../core/cache');


// Загрузка клиентского JS из файлов вкладок
const __tabsDir = require('path').join(__dirname, 'tabs');
const __tabOrder = ['shared','day','deals','quality','daily','funnel','stats','measurements','incoming','manager'];
function _loadClientJS() {
  return __tabOrder.map(t => {
    const f = require('path').join(__tabsDir, t + '.client.js');
    return require('fs').readFileSync(f, 'utf8');
  }).join('\n');
}


function buildStatsFromMultiDay(multiDayActivity) {
  const stats = {};
  for (const [date, deals] of Object.entries(multiDayActivity || {})) {
    if (!deals || !deals.length) continue;
    if (!stats[date]) stats[date] = { deals: 0, totalScore: 0, maxScore: 0, scores: [], callSources: 0, textSources: 0, vpDone: 0, hwDone: 0, ctaDone: 0, cpDone: 0, invDone: 0, presDone: 0, objDone: 0 };
    const s = stats[date];
    for (const da of deals) {
      const val = da.aiAssessment;
      if (!val) continue;
      s.deals++;
      const ss = val.salaryScore || {};
      s.totalScore += (ss.total || 0);
      s.maxScore += (ss.max || 12);
      s.scores.push(ss.total || 0);
      if (val.verbalPresentation && val.verbalPresentation.overall) {
        s.vpDone++;
        if (val.verbalPresentation.source === 'call') s.callSources++; else s.textSources++;
      }
      if (val.howWeWork && val.howWeWork.done) {
        s.hwDone++;
        if (val.howWeWork.source === 'call') s.callSources++; else s.textSources++;
      }
      if (val.callToAction && val.callToAction.done) s.ctaDone++;
      if (val.cp && val.cp.done) s.cpDone++;
      if (val.invoice && val.invoice.done) s.invDone++;
      if (val.writtenPresentation && val.writtenPresentation.done) s.presDone++;
      if (val.objectionHandling && val.objectionHandling.done) s.objDone++;
    }
  }
  const sorted = Object.entries(stats).sort((a, b) => {
    const pa = a[0].split('-'), pb = b[0].split('-');
    return new Date(pa[2]+'-'+pa[1]+'-'+pa[0]) - new Date(pb[2]+'-'+pb[1]+'-'+pb[0]);
  });
  return sorted.map(([date, s]) => ({
    date, deals: s.deals,
    totalScore: s.totalScore, maxScore: s.maxScore,
    avgScore: s.deals ? Math.round(s.totalScore / s.deals * 10) / 10 : 0,
    scores: s.scores,
    callSources: s.callSources, textSources: s.textSources,
    vpDone: s.vpDone, hwDone: s.hwDone, ctaDone: s.ctaDone,
    cpDone: s.cpDone, invDone: s.invDone, presDone: s.presDone, objDone: s.objDone,
  }));
}

function dmyToTime(date) {
  const m = String(date || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return 0;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
}

function movementDirection(from, to) {
  const fromIdx = FUNNEL_ORDER.indexOf(from);
  const toIdx = FUNNEL_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return 'unknown';
  return toIdx > fromIdx ? 'forward' : 'backward';
}

function createMovementDay(date) {
  return {
    date,
    dealIds: new Set(),
    newDealIds: new Set(),
    oldDealIds: new Set(),
    outCalls: 0,
    inCalls: 0,
    ndz: 0,
    movedForward: 0,
    movedBackward: 0,
    movedUnknown: 0,
    statusCounts: {},
  };
}

function addUniqueMovement(movements, seen, movement) {
  if (!movement.dealId || !movement.to) return;
  const key = `${movement.date || ''}|${movement.dealId}|${movement.from || ''}|${movement.to || ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  movements.push(movement);
}

function buildDealMovementData(data) {
  const daily = {};
  const movements = [];
  const movementSeen = new Set();
  const lastByDeal = new Map();
  const dealLatest = new Map();
  const multiDay = data.multiDayActivity || {};
  const dates = Object.keys(multiDay).sort((a, b) => dmyToTime(a) - dmyToTime(b));

  for (const date of dates) {
    const entries = multiDay[date] || [];
    if (!daily[date]) daily[date] = createMovementDay(date);
    const day = daily[date];

    for (const entry of entries) {
      const deal = entry?.deal || {};
      const dealId = Number(deal.id || 0);
      if (!dealId) continue;

      const status = deal.status || '?';
      const dateCreated = deal.dateCreated || '';
      const isNew = !!entry.isNew || (dateCreated && dateCreated === date);
      const sum = Number(deal.dealSum || 0) || 0;

      day.dealIds.add(dealId);
      if (isNew) day.newDealIds.add(dealId);
      else day.oldDealIds.add(dealId);
      day.statusCounts[status] = (day.statusCounts[status] || 0) + 1;

      dealLatest.set(dealId, {
        id: dealId,
        name: deal.name || '?',
        status,
        counterparty: deal.counterparty || '',
        sum,
        lastDate: date,
        dateCreated,
      });

      for (const action of (entry.actions || [])) {
        if (action.type === 'outCall') day.outCalls++;
        else if (action.type === 'inCall') day.inCalls++;
        else if (action.type === 'ndz') day.ndz++;
      }

      const prev = lastByDeal.get(dealId);
      if (prev && prev.status && status && prev.status !== status) {
        const direction = movementDirection(prev.status, status);
        addUniqueMovement(movements, movementSeen, {
          date,
          dealId,
          dealName: deal.name || prev.name || '?',
          counterparty: deal.counterparty || prev.counterparty || '',
          sum,
          from: prev.status,
          to: status,
          direction,
          source: 'history',
        });
        if (direction === 'forward') day.movedForward++;
        else if (direction === 'backward') day.movedBackward++;
        else day.movedUnknown++;
      }

      lastByDeal.set(dealId, {
        status,
        name: deal.name || '?',
        counterparty: deal.counterparty || '',
      });
    }
  }

  const reportDate = data.reportDate || dates[dates.length - 1] || '';
  if (reportDate && !daily[reportDate]) daily[reportDate] = createMovementDay(reportDate);
  for (const change of (data.funnelChanges || [])) {
    const direction = change.direction || movementDirection(change.from, change.to);
    const date = reportDate;
    addUniqueMovement(movements, movementSeen, {
      date,
      dealId: Number(change.dealId || 0),
      dealName: change.dealName || '?',
      counterparty: change.counterparty || '',
      sum: Number(change.dealSum || change.sum || 0) || 0,
      from: change.from || '',
      to: change.to || '',
      direction,
      source: 'snapshot',
    });
    if (daily[date]) {
      if (direction === 'forward') daily[date].movedForward++;
      else if (direction === 'backward') daily[date].movedBackward++;
      else daily[date].movedUnknown++;
    }
  }

  const dailyArray = Object.values(daily)
    .map(day => ({
      date: day.date,
      dealsWorked: day.dealIds.size,
      newDeals: day.newDealIds.size,
      oldDeals: day.oldDealIds.size,
      outCalls: day.outCalls,
      inCalls: day.inCalls,
      ndz: day.ndz,
      movedForward: day.movedForward,
      movedBackward: day.movedBackward,
      movedUnknown: day.movedUnknown,
      dealIds: [...day.dealIds],
      newDealIds: [...day.newDealIds],
      statusCounts: day.statusCounts,
    }))
    .sort((a, b) => dmyToTime(a.date) - dmyToTime(b.date));

  const latestDeals = [...dealLatest.values()].sort((a, b) => dmyToTime(b.lastDate) - dmyToTime(a.lastDate));
  return { daily: dailyArray, movements, latestDeals, statusOrder: FUNNEL_ORDER };
}

function generateHtml(managerName, data, allManagers, navMode = 'root') {
  // Статистика из multiDayActivity (ИИ-оценки) + операционные данные
  const statsData = buildStatsFromMultiDay(data.multiDayActivity);
  // Операционная статистика по дням из dealCards
  const opsStats = {};
  const mgrNameLow = (managerName || '').toLowerCase();
  for (const card of (data.dealCards || [])) {
    // Звонки по дням (уже фильтрованы по менеджеру из dataTags)
    for (const c of (card.calls || [])) {
      if (!c.date) continue;
      if (!opsStats[c.date]) opsStats[c.date] = { outCalls: 0, inCalls: 0, callDuration: 0, dealsWorked: new Set(), newDeals: new Set(), oldDeals: new Set(), statuses: {} };
      const os = opsStats[c.date];
      if (c.type === 'Исходящий') os.outCalls++; else os.inCalls++;
      os.callDuration += (c.duration || 0);
      os.dealsWorked.add(card.id);
      // isNew по дате дня, а не reportDate
      const isNewOnDay = card.dateCreated === c.date;
      if (isNewOnDay) os.newDeals.add(card.id); else os.oldDeals.add(card.id);
    }
    // Комментарии по дням — ТОЛЬКО от менеджера (не роботы, не клиенты)
    for (const c of (card.comments || [])) {
      if (!c.date) continue;
      const ownerLow = (c.owner || '').toLowerCase();
      if (!ownerLow || !mgrNameLow || !ownerLow.includes(mgrNameLow)) continue;
      if (!opsStats[c.date]) opsStats[c.date] = { outCalls: 0, inCalls: 0, callDuration: 0, dealsWorked: new Set(), newDeals: new Set(), oldDeals: new Set(), statuses: {} };
      opsStats[c.date].dealsWorked.add(card.id);
      const isNewOnDay = card.dateCreated === c.date;
      if (isNewOnDay) opsStats[c.date].newDeals.add(card.id); else opsStats[c.date].oldDeals.add(card.id);
    }
  }
  // Дополняем из multiDayActivity (прошлые дни из истории)
  for (const [date, deals] of Object.entries(data.multiDayActivity || {})) {
    if (!deals || !deals.length) continue;
    if (!opsStats[date]) opsStats[date] = { outCalls: 0, inCalls: 0, callDuration: 0, dealsWorked: new Set(), newDeals: new Set(), oldDeals: new Set(), statuses: {} };
    const os = opsStats[date];
    for (const da of deals) {
      const dealId = da.deal ? da.deal.id : 0;
      if (os.dealsWorked.has(dealId)) continue; // уже из dealCards
      os.dealsWorked.add(dealId);
      const isNewOnDay = !!da.isNew || da.deal?.dateCreated === date;
      if (isNewOnDay) os.newDeals.add(dealId); else os.oldDeals.add(dealId);
      for (const a of (da.actions || [])) {
        if (a.type === 'outCall') os.outCalls++;
        else if (a.type === 'inCall') os.inCalls++;
      }
    }
  }
  // Конвертируем Set в числа + мёржим с AI stats
  const opsArray = Object.entries(opsStats).map(([date, o]) => ({
    date, outCalls: o.outCalls, inCalls: o.inCalls,
    callDuration: o.callDuration, callMinutes: Math.round(o.callDuration / 60),
    dealsWorked: o.dealsWorked.size, newDeals: o.newDeals.size, oldDeals: o.oldDeals.size,
  })).sort((a, b) => {
    const pa = a.date.split('-'), pb = b.date.split('-');
    return new Date(pa[2]+'-'+pa[1]+'-'+pa[0]) - new Date(pb[2]+'-'+pb[1]+'-'+pb[0]);
  });
  data.statsData = statsData;
  data.opsStats = opsArray;
  data.dealMovementData = buildDealMovementData(data);
  // Статусы воронки для статистики
  const statusCounts = {};
  const statusSource = (data.funnelCards && data.funnelCards.length) ? data.funnelCards : (data.dealCards || []);
  for (const card of statusSource) { statusCounts[card.status] = (statusCounts[card.status] || 0) + 1; }
  data.statusCounts = statusCounts;
  data.navMode = navMode;
  // Безопасная сериализация JSON для встраивания в <script>
  const json = JSON.stringify(data)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--')
    .replace(/`/g, '\\u0060');
  const navHref = (alias) => {
    if (navMode === 'deploy') return alias === 'index' ? '../index.html' : `../${alias}/index.html`;
    if (navMode === 'reports') return alias === 'index' ? '../deploy/index.html' : `../deploy/${alias}/index.html`;
    return alias === 'index' ? 'deploy/index.html' : `deploy/${alias}/index.html`;
  };

  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ТрансКом — ${managerName}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%230f172a'/%3E%3Cpath d='M16 18h32v8H36v20h-8V26H16z' fill='%2360a5fa'/%3E%3C/svg%3E">
<style>
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter','Manrope',system-ui,-apple-system,sans-serif;background:#f7f7f8;color:#1a1a2e;min-height:100vh}
.hdr{background:#fff;border-bottom:1px solid #e5e5e5;padding:14px 20px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.hdr-in{max-width:1200px;margin:0 auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#d97706,#b45309);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#1a1a2e}
.pbar{display:flex;gap:5px;margin-left:auto;flex-wrap:wrap}
.pbtn{padding:6px 12px;border-radius:7px;border:1px solid #e5e5e5;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;background:#fff;color:#6b7280;transition:.2s}
.pbtn.on{background:#d97706;color:#1a1a2e;border-color:#d97706;box-shadow:0 2px 8px rgba(217,119,6,.2)}
.cnt{max-width:1200px;margin:0 auto;padding:16px}
.mets{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-bottom:14px}
.met{background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:10px;text-align:center}
.met-v{font-size:20px;font-weight:800;margin:2px 0;color:#1a1a2e}
.met-l{font-size:9px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.tabs{display:flex;gap:0;border-bottom:1px solid #e5e5e5;margin-bottom:14px;flex-wrap:wrap}
.tab{padding:8px 14px;cursor:pointer;color:#6b7280;font-size:13px;font-weight:600;border-bottom:2px solid transparent;transition:.2s}
.tab.on{color:#d97706;border-color:#d97706;background:rgba(217,119,6,.04)}
.sec{background:#fff;border:1px solid #e5e5e5;border-radius:14px;padding:16px;margin-bottom:12px}
.sec h3{font-size:14px;font-weight:700;color:#1a1a2e;margin-bottom:10px}
.sec h4{font-size:13px;font-weight:600;color:#6b7280;margin:10px 0 6px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:5px 8px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e5e5;font-size:11px;white-space:nowrap}
td{padding:5px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top;color:#374151}
tr:hover td{background:rgba(217,119,6,.03)}
.bg{padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;white-space:nowrap}
.bg-g{background:rgba(22,163,74,.1);color:#16a34a}
.bg-y{background:rgba(202,138,4,.1);color:#b45309}
.bg-r{background:rgba(220,38,38,.1);color:#dc2626}
.bg-b{background:rgba(37,99,235,.08);color:#2563eb}
.bg-p{background:rgba(124,58,237,.08);color:#7c3aed}
.yes{color:#16a34a;font-weight:700}.no{color:#9ca3af}
.bar-bg{height:5px;background:#f3f4f6;border-radius:3px;overflow:hidden;margin-top:2px}
.bar-f{height:100%;border-radius:3px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:700px){.grid2{grid-template-columns:1fr}.mets{grid-template-columns:repeat(3,1fr)}}
.deal-hdr{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px}
.deal-meta{font-size:11px;color:#6b7280;display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
.deal-stat{display:flex;gap:12px;flex-wrap:wrap}
.deal-stat span{font-size:12px;font-weight:700}
.cmt{font-size:11px;color:#6b7280;padding:4px 0;border-bottom:1px solid #f3f4f6}
.cmt-type{font-size:10px;font-weight:700;margin-right:4px}
.no-data{text-align:center;padding:30px;color:#9ca3af;font-size:14px}
.transcript{background:#f9fafb;border:1px solid #e5e5e5;border-radius:8px;padding:10px;margin:6px 0;font-size:11px;line-height:1.6;color:#374151;max-height:200px;overflow-y:auto;white-space:pre-wrap}
.toggle-btn{background:#fff;border:1px solid #d1d5db;color:#6b7280;padding:2px 8px;border-radius:5px;cursor:pointer;font-size:10px;font-family:inherit}
.toggle-btn:hover{color:#d97706;border-color:#d97706}
.act-card{background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:12px;margin-bottom:8px}
.act-card h4{margin:0 0 6px;font-size:13px;color:#1a1a2e}
.act-tag{display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;margin:2px}
.change-fwd{color:#16a34a}.change-bwd{color:#dc2626}
.ai-box{margin-top:10px;padding:10px;background:rgba(124,58,237,.04);border:1px solid rgba(124,58,237,.12);border-radius:8px}
.ai-label{font-size:11px;font-weight:700;color:#7c3aed;margin-bottom:4px}
.script-box{margin-top:10px;padding:10px;background:rgba(37,99,235,.03);border:1px solid rgba(37,99,235,.1);border-radius:8px}
/* Collapsible sections */
.coll{border-radius:10px;margin-top:10px;overflow:hidden;border:1px solid #e5e5e5}
.coll-hdr{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;user-select:none;transition:background .2s;font-size:12px;font-weight:700}
.coll-hdr:hover{background:#f9fafb}
.coll-hdr .arr{font-size:10px;color:#6b7280;transition:transform .25s;display:inline-block}
.coll-hdr.open .arr{transform:rotate(90deg)}
.coll-body{max-height:0;overflow:hidden;transition:max-height .3s ease-out}
.coll-body.open{max-height:5000px;transition:max-height .5s ease-in}
.coll-inner{padding:10px 14px 14px}
/* Card header redesign */
.card{background:#fff;border:1px solid #e5e5e5;border-radius:16px;margin-bottom:14px;overflow:hidden}
.card-top{padding:16px 18px 12px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;border-bottom:1px solid #f3f4f6;cursor:pointer;user-select:none;transition:background .2s}
.card-top:hover{background:#f9fafb}
.card-top .card-arrow{color:#6b7280;font-size:10px;transition:transform .2s;margin-right:4px}
.card-top.open .card-arrow{transform:rotate(90deg)}
.card-title{font-size:14px;font-weight:800;color:#1a1a2e;margin-bottom:4px}
.card-tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px}
.card-body{padding:0 4px 8px;display:none}
.card-body.open{display:block}
/* Result block */
.result-block{margin:12px 14px;padding:12px 16px;background:linear-gradient(135deg,rgba(37,99,235,.04),rgba(124,58,237,.03));border:1px solid rgba(37,99,235,.12);border-radius:12px}
.result-block .res-title{font-size:11px;font-weight:700;color:#2563eb;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.result-block .res-text{font-size:13px;line-height:1.7;color:#1a1a2e}
.result-block .res-verdict{font-size:12px;line-height:1.5;color:#b45309;margin-top:6px;font-weight:700;padding-top:6px;border-top:1px solid #f3f4f6}
/* Score pill */
.score-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:800}
.deal-tools{position:sticky;top:8px;z-index:4;background:rgba(255,255,255,.95);border:1px solid #e5e5e5;border-radius:16px;padding:14px 16px;margin-bottom:14px;backdrop-filter:blur(18px);box-shadow:0 4px 16px rgba(0,0,0,.06)}
.deal-tools-grid{display:grid;grid-template-columns:minmax(220px,2fr) repeat(3,minmax(150px,1fr));gap:10px}
.deal-field{display:flex;flex-direction:column;gap:6px}
.deal-label{font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px}
.deal-input,.deal-select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #d1d5db;background:#fff;color:#1a1a2e;font-size:13px;font-family:inherit;outline:none}
.deal-input:focus,.deal-select:focus{border-color:#d97706;box-shadow:0 0 0 3px rgba(217,119,6,.1)}
.deal-tools-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:12px}
.deal-chips{display:flex;gap:8px;flex-wrap:wrap}
.deal-chip{padding:7px 10px;border-radius:999px;background:#f3f4f6;border:1px solid #e5e5e5;font-size:12px;color:#374151}
.deal-chip strong{color:#1a1a2e}
.deal-card{background:#fff;border:1px solid #e5e5e5;border-radius:18px;margin-bottom:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.04)}
.deal-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:16px 18px;border-bottom:1px solid #f3f4f6;cursor:pointer;user-select:none;transition:background .2s}
.deal-card-top:hover{background:#f9fafb}
.deal-card-title{font-size:15px;font-weight:800;color:#1a1a2e;line-height:1.4}
.deal-card-top.open .card-arrow{transform:rotate(90deg)}
.deal-card-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px}
.deal-card-body{display:none;padding:16px 18px 18px}
.deal-card-body.open{display:block}
.deal-kpis{display:grid;grid-template-columns:repeat(4,minmax(88px,1fr));gap:8px;min-width:min(420px,100%)}
.deal-kpi{padding:10px 12px;border-radius:14px;background:#f9fafb;border:1px solid #e5e5e5;text-align:left}
.deal-kpi-v{display:block;font-size:18px;font-weight:800;color:#1a1a2e}
.deal-kpi-l{display:block;margin-top:3px;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.45px}
.deal-summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px;margin-bottom:14px}
.deal-summary-item{padding:10px 12px;border-radius:14px;background:#f9fafb;border:1px solid #e5e5e5}
.deal-summary-item b{display:block;font-size:11px;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px}
.deal-summary-item span{display:block;font-size:13px;font-weight:600;color:#1a1a2e;line-height:1.45}
.deal-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 8px}
.deal-section-title h4{margin:0}
.deal-empty{padding:18px;border-radius:14px;background:rgba(0,0,0,.03);border:1px dashed rgba(0,0,0,.08);color:#6b7280;text-align:center;font-size:13px}
.deal-table-wrap{overflow-x:auto;border:1px solid rgba(0,0,0,.03);border-radius:12px}
.deal-caption{font-size:11px;color:#6b7280}
@media(max-width:900px){
  .deal-tools-grid{grid-template-columns:repeat(2,minmax(160px,1fr))}
  .deal-kpis{grid-template-columns:repeat(2,minmax(88px,1fr));min-width:0;width:100%}
  .deal-summary{grid-template-columns:repeat(2,minmax(120px,1fr))}
}
@media(max-width:640px){
  .deal-tools{padding:12px}
  .deal-tools-grid{grid-template-columns:1fr}
  .deal-card-top{padding:14px}
  .deal-card-body{padding:14px}
  .deal-summary{grid-template-columns:1fr}
}
:root{
  --bg:#f4f1ea;
  --panel:#fffdf9;
  --panel-strong:#ffffff;
  --line:#e6ddd0;
  --line-soft:#efe6da;
  --text:#1f2937;
  --muted:#6b7280;
  --brand:#c06a16;
  --brand-strong:#9a4f08;
  --brand-soft:rgba(192,106,22,.11);
  --blue:#2563eb;
  --blue-soft:rgba(37,99,235,.1);
  --green:#15803d;
  --green-soft:rgba(21,128,61,.1);
  --amber:#b45309;
  --amber-soft:rgba(180,83,9,.12);
  --purple:#7c3aed;
  --purple-soft:rgba(124,58,237,.1);
  --shadow:0 14px 40px rgba(120,94,58,.10);
  --shadow-soft:0 8px 22px rgba(120,94,58,.07);
}
body{
  font-family:'Manrope',system-ui,-apple-system,sans-serif;
  background:
    radial-gradient(circle at top left, rgba(217,119,6,.12), transparent 28%),
    radial-gradient(circle at top right, rgba(37,99,235,.10), transparent 30%),
    linear-gradient(180deg,#faf7f2 0%,#f4f1ea 38%,#f1eee8 100%);
  color:var(--text);
}
body::before{
  content:'';
  position:fixed;
  inset:0;
  pointer-events:none;
  background-image:
    linear-gradient(rgba(255,255,255,.24) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.24) 1px, transparent 1px);
  background-size:32px 32px;
  mask-image:linear-gradient(180deg,rgba(0,0,0,.16),transparent 62%);
}
.hdr{
  position:sticky;
  top:0;
  z-index:12;
  background:rgba(250,247,242,.90);
  border-bottom:1px solid rgba(154,79,8,.10);
  padding:18px 18px 16px;
  box-shadow:0 10px 30px rgba(75,56,33,.08);
  backdrop-filter:blur(16px);
}
.hdr-in{
  max-width:1440px;
  margin:0 auto;
  display:grid;
  grid-template-columns:minmax(320px,1.4fr) minmax(240px,.8fr);
  gap:18px;
  align-items:stretch;
}
.hero-card,
.hero-side{
  background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(255,251,244,.92));
  border:1px solid rgba(154,79,8,.10);
  border-radius:28px;
  box-shadow:var(--shadow-soft);
}
.hero-card{
  padding:22px 24px;
  display:flex;
  gap:18px;
  align-items:flex-start;
}
.hero-side{
  padding:20px 22px;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
  gap:16px;
}
.logo{
  width:64px;
  height:64px;
  border-radius:20px;
  background:linear-gradient(135deg,#cf7a1f,#a95308 58%,#6b3d10 100%);
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:28px;
  font-weight:800;
  color:#fff;
  box-shadow:0 14px 30px rgba(154,79,8,.28);
  flex:0 0 auto;
}
.brand-copy{flex:1;min-width:0}
.eyebrow{
  display:inline-flex;
  align-items:center;
  gap:8px;
  padding:7px 12px;
  border-radius:999px;
  background:var(--brand-soft);
  color:var(--brand-strong);
  font-size:11px;
  font-weight:800;
  text-transform:uppercase;
  letter-spacing:.08em;
}
.mgr-name{
  margin-top:14px;
  font-size:clamp(28px,3vw,42px);
  line-height:1.05;
  font-weight:800;
  color:#1f2937;
}
.mgr-sub{
  margin-top:10px;
  font-size:14px;
  line-height:1.65;
  color:#5b6472;
  max-width:700px;
}
.hero-meta{
  display:grid;
  grid-template-columns:repeat(2,minmax(140px,1fr));
  gap:10px;
}
.hero-meta-card{
  padding:14px 16px;
  border-radius:18px;
  background:rgba(255,255,255,.84);
  border:1px solid rgba(154,79,8,.10);
}
.hero-meta-card b{
  display:block;
  font-size:11px;
  color:var(--muted);
  text-transform:uppercase;
  letter-spacing:.08em;
  margin-bottom:7px;
}
.hero-meta-card span{
  display:block;
  font-size:15px;
  font-weight:700;
  line-height:1.45;
  color:var(--text);
}
.hero-upd{
  font-size:13px;
  line-height:1.6;
  color:#5f6773;
}
.hero-upd b{
  display:block;
  font-size:11px;
  text-transform:uppercase;
  letter-spacing:.08em;
  color:var(--muted);
  margin-bottom:6px;
}
.manager-rail{
  max-width:1440px;
  margin:14px auto 0;
  display:flex;
  gap:10px;
  flex-wrap:wrap;
  align-items:center;
}
.manager-label{
  font-size:11px;
  font-weight:800;
  color:var(--muted);
  text-transform:uppercase;
  letter-spacing:.08em;
  margin-right:6px;
}
.manager-pill{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:8px;
  min-height:44px;
  padding:10px 16px;
  border-radius:999px;
  text-decoration:none;
  font-size:13px;
  font-weight:700;
  color:#4b5563;
  background:rgba(255,255,255,.82);
  border:1px solid rgba(154,79,8,.12);
  box-shadow:0 5px 18px rgba(88,67,40,.06);
  transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease, background .18s ease;
}
.manager-pill:hover{
  transform:translateY(-1px);
  box-shadow:0 10px 20px rgba(88,67,40,.10);
  border-color:rgba(154,79,8,.24);
}
.manager-pill.is-active{
  background:linear-gradient(135deg,#cf7a1f,#9a4f08);
  color:#fff;
  border-color:transparent;
  box-shadow:0 12px 26px rgba(154,79,8,.28);
}
.manager-pill.is-overview{color:var(--brand-strong)}
.toolbar-row{
  max-width:1440px;
  margin:14px auto 0;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  flex-wrap:wrap;
}
.toolbar-copy{min-width:220px}
.toolbar-copy b{
  display:block;
  font-size:11px;
  text-transform:uppercase;
  letter-spacing:.08em;
  color:var(--muted);
  margin-bottom:6px;
}
.toolbar-copy span{
  display:block;
  font-size:14px;
  line-height:1.55;
  color:#505968;
}
.pbar{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap}
.pbtn{
  min-height:42px;
  padding:10px 15px;
  border-radius:999px;
  border:1px solid rgba(154,79,8,.14);
  cursor:pointer;
  font-size:12px;
  font-weight:800;
  font-family:inherit;
  background:rgba(255,255,255,.78);
  color:#5b6472;
  transition:.18s ease;
  box-shadow:0 5px 18px rgba(88,67,40,.06);
}
.pbtn.on{
  background:linear-gradient(135deg,#cf7a1f,#9a4f08);
  color:#fff;
  border-color:transparent;
  box-shadow:0 12px 24px rgba(154,79,8,.25);
}
.cnt{max-width:1440px;margin:0 auto;padding:20px 18px 36px}
.mets{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(168px,1fr));
  gap:14px;
  margin-bottom:18px;
}
.met{
  background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(255,251,244,.94));
  border:1px solid rgba(154,79,8,.10);
  border-radius:24px;
  padding:18px 16px;
  text-align:left;
  box-shadow:var(--shadow-soft);
  min-height:122px;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
}
.met-v{font-size:32px;line-height:1;font-weight:800;margin:10px 0 0;color:#1f2937}
.met-l{font-size:11px;color:var(--muted);font-weight:800;text-transform:uppercase;letter-spacing:.08em}
.tabs-wrap{position:sticky;top:188px;z-index:10;margin-bottom:18px}
.tabs{
  display:flex;
  gap:10px;
  padding:12px;
  border:1px solid rgba(154,79,8,.10);
  border-radius:24px;
  background:rgba(255,252,247,.88);
  box-shadow:var(--shadow-soft);
  backdrop-filter:blur(14px);
  flex-wrap:wrap;
}
.tab{
  padding:11px 16px;
  cursor:pointer;
  color:#5b6472;
  font-size:13px;
  font-weight:800;
  border:none;
  border-radius:999px;
  transition:.18s ease;
}
.tab.on{
  color:#fff;
  background:linear-gradient(135deg,#cf7a1f,#9a4f08);
  box-shadow:0 12px 24px rgba(154,79,8,.22);
}
.sec{
  background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(255,251,244,.92));
  border:1px solid rgba(154,79,8,.10);
  border-radius:28px;
  padding:22px;
  margin-bottom:16px;
  box-shadow:var(--shadow-soft);
}
.sec h3{font-size:18px;font-weight:800;color:var(--text);margin-bottom:12px}
.sec h4{font-size:14px;font-weight:700;color:#525b69;margin:12px 0 8px}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}
th{
  text-align:left;
  padding:12px 14px;
  color:var(--muted);
  font-weight:800;
  border-bottom:1px solid var(--line-soft);
  font-size:11px;
  white-space:nowrap;
  text-transform:uppercase;
  letter-spacing:.08em;
}
td{
  padding:14px;
  border-bottom:1px solid rgba(239,230,218,.95);
  vertical-align:top;
  color:#374151;
  background:rgba(255,255,255,.55);
}
tr:hover td{background:rgba(255,248,240,.92)}
.bg{padding:5px 10px;border-radius:999px;font-size:11px;font-weight:800;white-space:nowrap}
.bg-g{background:var(--green-soft);color:var(--green)}
.bg-y{background:var(--amber-soft);color:var(--amber)}
.bg-r{background:rgba(220,38,38,.10);color:#dc2626}
.bg-b{background:var(--blue-soft);color:var(--blue)}
.bg-p{background:var(--purple-soft);color:var(--purple)}
.bar-bg{height:8px;background:#efe7dd;border-radius:999px;overflow:hidden;margin-top:6px}
.bar-f{height:100%;border-radius:999px}
.grid2{display:grid;grid-template-columns:1.1fr .9fr;gap:16px}
.cmt{font-size:13px;color:#4b5563;padding:10px 0;border-bottom:1px solid rgba(239,230,218,.9);line-height:1.6}
.no-data{
  text-align:center;
  padding:52px 20px;
  color:#7b8594;
  font-size:15px;
  background:linear-gradient(180deg,rgba(255,255,255,.8),rgba(250,246,239,.9));
  border:1px dashed rgba(154,79,8,.18);
  border-radius:26px;
}
.transcript{
  background:rgba(250,248,244,.96);
  border:1px solid rgba(154,79,8,.10);
  border-radius:16px;
  padding:14px 16px;
  margin:8px 0;
  font-size:12px;
  line-height:1.8;
  color:#374151;
  max-height:260px;
  overflow-y:auto;
}
.toggle-btn{
  background:#fff;
  border:1px solid rgba(154,79,8,.16);
  color:#4b5563;
  padding:7px 12px;
  border-radius:999px;
  cursor:pointer;
  font-size:11px;
  font-weight:800;
  font-family:inherit;
  transition:.18s ease;
}
.toggle-btn:hover{
  color:var(--brand-strong);
  border-color:rgba(154,79,8,.32);
  box-shadow:0 8px 16px rgba(154,79,8,.12);
}
.card,.deal-card{
  background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(255,251,244,.94));
  border:1px solid rgba(154,79,8,.10);
  border-radius:28px;
  box-shadow:var(--shadow-soft);
}
.card-top,.deal-card-top{
  padding:20px 22px 16px;
  border-bottom:1px solid rgba(239,230,218,.95);
}
.card-top:hover,.deal-card-top:hover{background:rgba(255,248,240,.82)}
.card-title,.deal-card-title{font-size:19px;line-height:1.35;font-weight:800;color:var(--text)}
.deal-card-subline{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
  margin-top:10px;
  font-size:12px;
  color:#6b7280;
}
.result-block{
  margin:14px 16px;
  padding:16px 18px;
  background:linear-gradient(135deg,rgba(37,99,235,.06),rgba(124,58,237,.03));
  border:1px solid rgba(37,99,235,.12);
  border-radius:22px;
}
.score-pill{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:800}
.deal-tools{
  top:190px;
  z-index:9;
  background:linear-gradient(180deg,rgba(255,253,249,.96),rgba(255,250,243,.92));
  border:1px solid rgba(154,79,8,.10);
  border-radius:30px;
  padding:20px;
  margin-bottom:18px;
  box-shadow:var(--shadow);
}
.deal-tools-head{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:16px;
  flex-wrap:wrap;
  margin-bottom:16px;
}
.deal-tools-kicker{
  display:inline-flex;
  align-items:center;
  gap:8px;
  padding:7px 12px;
  border-radius:999px;
  background:var(--brand-soft);
  color:var(--brand-strong);
  font-size:11px;
  font-weight:800;
  text-transform:uppercase;
  letter-spacing:.08em;
}
.deal-tools-title{margin:12px 0 6px;font-size:28px;line-height:1.1;color:var(--text);font-weight:800}
.deal-tools-sub{max-width:720px;font-size:14px;line-height:1.65;color:#586170}
.deal-tools-grid{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:12px}
.deal-field{display:flex;flex-direction:column;gap:7px}
.deal-label{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.deal-input,.deal-select{
  width:100%;
  min-height:48px;
  padding:12px 14px;
  border-radius:16px;
  border:1px solid rgba(154,79,8,.12);
  background:rgba(255,255,255,.92);
  color:var(--text);
  font-size:14px;
  font-family:inherit;
}
.deal-input:focus,.deal-select:focus{border-color:rgba(154,79,8,.34);box-shadow:0 0 0 4px rgba(192,106,22,.10)}
.deal-date-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}
.deal-date-row input[type="date"]{
  min-height:42px;
  padding:8px 12px;
  border-radius:14px;
  border:1px solid rgba(154,79,8,.12);
  background:rgba(255,255,255,.92);
  color:var(--text);
  font-family:inherit;
}
.deal-tools-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:16px}
.deal-chips{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
  gap:10px;
  flex:1;
  min-width:min(640px,100%);
}
.deal-chip{
  padding:14px 16px;
  border-radius:20px;
  background:rgba(255,255,255,.86);
  border:1px solid rgba(154,79,8,.10);
  font-size:13px;
  color:#4b5563;
  min-height:82px;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
  box-shadow:0 6px 18px rgba(88,67,40,.06);
}
.deal-chip strong{display:block;font-size:24px;line-height:1;margin-top:10px;color:var(--text)}
.deal-card-top{padding:22px 24px 18px}
.deal-card-meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
.deal-card-body{padding:18px 22px 22px}
.deal-kpis{display:grid;grid-template-columns:repeat(2,minmax(140px,1fr));gap:10px;min-width:min(420px,100%)}
.deal-kpi{
  padding:14px 16px;
  border-radius:20px;
  background:rgba(255,255,255,.88);
  border:1px solid rgba(154,79,8,.10);
  min-height:92px;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
}
.deal-kpi-v{font-size:24px}
.deal-kpi-l{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.deal-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
.deal-summary-item{
  padding:14px 16px;
  border-radius:20px;
  background:rgba(255,255,255,.88);
  border:1px solid rgba(154,79,8,.10);
  min-height:112px;
}
.deal-summary-item b{font-size:11px;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em}
.deal-summary-item span{font-size:14px;font-weight:700;line-height:1.55}
.deal-section-title{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin:16px 0 10px;flex-wrap:wrap}
.deal-empty{
  padding:24px;
  border-radius:20px;
  background:rgba(255,249,242,.88);
  border:1px dashed rgba(154,79,8,.18);
  color:#6b7280;
  text-align:center;
  font-size:14px;
}
.deal-table-wrap{
  overflow-x:auto;
  border:1px solid rgba(154,79,8,.10);
  border-radius:20px;
  background:rgba(255,255,255,.86);
}
.deal-caption{font-size:12px;color:var(--muted)}
.deal-command{border-radius:12px;padding:16px;box-shadow:none}
.deal-view-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:flex-end}
.deal-view-actions .is-active{background:var(--brand-soft);border-color:rgba(154,79,8,.28);color:var(--brand-strong)}
.deal-summary-strip{grid-template-columns:repeat(5,minmax(120px,1fr));min-width:0}
.deal-summary-strip .deal-chip{min-height:64px;border-radius:8px;padding:10px 12px;box-shadow:none}
.deal-summary-strip .deal-chip strong{font-size:22px;margin-top:4px}
.deal-summary-strip .deal-chip span{font-size:11px;color:var(--muted)}
.deal-layout{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(360px,.9fr);gap:14px;align-items:start}
.deal-register,.deal-detail{background:rgba(255,255,255,.92);border:1px solid rgba(154,79,8,.10);border-radius:8px}
.deal-register{overflow:hidden}
.deal-register-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line-soft)}
.deal-register-head b{font-size:15px;color:var(--text)}
.deal-register-head span{display:block;margin-top:3px;font-size:12px;color:var(--muted)}
.deal-grid-table{min-width:1080px;table-layout:fixed}
.deal-grid-table th:nth-child(1){width:32%}
.deal-grid-table th:nth-child(2){width:17%}
.deal-grid-table th:nth-child(3){width:11%}
.deal-grid-table th:nth-child(4){width:8%}
.deal-grid-table th:nth-child(5){width:8%}
.deal-grid-table th:nth-child(6){width:9%}
.deal-grid-table th:nth-child(7){width:15%}
.deal-grid-table td{padding:11px 12px}
.deal-grid-table td:nth-child(2),.deal-grid-table td:nth-child(7){overflow:hidden}
.deal-grid-table .bg{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
.deal-row{cursor:pointer}
.deal-row.is-active td{background:rgba(192,106,22,.10)}
.deal-row:hover td{background:rgba(255,248,240,.9)}
.deal-namecell{display:flex;flex-direction:column;gap:4px;min-width:0}
.deal-namecell b{font-size:13px;line-height:1.35;color:var(--text)}
.deal-namecell span,.deal-quiet{font-size:12px;color:var(--muted);line-height:1.35}
.deal-row-flags{display:flex;gap:5px;flex-wrap:wrap;max-height:48px;overflow:hidden}
.deal-flag{display:inline-flex;align-items:center;max-width:100%;padding:4px 7px;border-radius:999px;font-size:10px;font-weight:800;line-height:1.2;white-space:nowrap}
.deal-flag.is-bad{background:rgba(220,38,38,.10);color:#b91c1c}
.deal-flag.is-warn{background:var(--amber-soft);color:var(--amber)}
.deal-flag.is-info{background:var(--blue-soft);color:var(--blue)}
.deal-detail{position:sticky;top:190px;max-height:calc(100vh - 210px);overflow:auto}
.deal-detail-head{padding:14px;border-bottom:1px solid var(--line-soft)}
.deal-detail-title{font-size:17px;line-height:1.35;font-weight:800;color:var(--text)}
.deal-detail-sub{margin-top:6px;font-size:13px;color:var(--muted);line-height:1.45}
.deal-detail-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}
.deal-detail-kpis div{border:1px solid rgba(154,79,8,.10);border-radius:8px;padding:9px;background:rgba(255,249,242,.72)}
.deal-detail-kpis b{display:block;font-size:18px;color:var(--text)}
.deal-detail-kpis span{display:block;margin-top:2px;font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:800}
.deal-detail-tabs{display:flex;gap:6px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--line-soft);background:rgba(250,248,244,.7)}
.deal-detail-tab{border:1px solid transparent;background:transparent;border-radius:8px;padding:7px 9px;font-size:12px;font-weight:800;color:var(--muted);cursor:pointer;font-family:inherit}
.deal-detail-tab.is-active{background:#fff;border-color:rgba(154,79,8,.16);color:var(--brand-strong)}
.deal-detail-body{padding:14px}
.deal-summary.compact{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.deal-summary.compact .deal-summary-item{min-height:86px;border-radius:8px;padding:10px 12px}
.deal-panel-block{border:1px solid rgba(154,79,8,.10);background:rgba(255,255,255,.78);border-radius:8px;padding:12px;margin-bottom:12px}
.deal-panel-block h4{margin:0 0 10px;font-size:14px;color:var(--text)}
.deal-panel-block p{margin:8px 0;color:#374151;line-height:1.65;font-size:13px}
.deal-panel-block ul{margin:8px 0 0 18px;padding:0;color:#374151;font-size:13px;line-height:1.6}
.deal-issue-list,.deal-actions{display:flex;gap:8px;flex-wrap:wrap}
.deal-checkgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0}
.deal-checkgrid div{display:flex;gap:8px;align-items:center;padding:9px;border-radius:8px;border:1px solid rgba(154,79,8,.10);background:rgba(255,249,242,.72)}
.deal-checkgrid b{font-size:16px}
.deal-checkgrid .is-ok b{color:var(--green)}
.deal-checkgrid .is-miss b{color:#dc2626}
.deal-checkgrid span{font-size:12px;font-weight:700;color:#374151}
.deal-event{padding:10px 0;border-bottom:1px solid rgba(239,230,218,.9)}
.deal-event:last-child{border-bottom:0}
.deal-event b{display:block;font-size:13px;color:var(--text)}
.deal-event span{display:block;margin-top:3px;font-size:11px;color:var(--muted)}
.deal-event p{margin:6px 0 0;font-size:13px;line-height:1.55;color:#374151;white-space:pre-wrap}
.deal-transcript-row{margin-bottom:10px}
@media(max-width:1180px){
  .hdr-in{grid-template-columns:1fr}
  .hero-meta{grid-template-columns:repeat(2,minmax(140px,1fr))}
  .tabs-wrap,.deal-tools{top:154px}
  .deal-layout{grid-template-columns:1fr}
  .deal-detail{position:static;max-height:none}
}
@media(max-width:900px){
  .cnt{padding:18px 14px 30px}
  .hdr{padding:14px 14px 12px}
  .hero-card,.hero-side,.card,.deal-card,.sec{border-radius:24px}
  .deal-tools-grid{grid-template-columns:repeat(2,minmax(160px,1fr))}
  .deal-summary-strip{grid-template-columns:repeat(2,minmax(120px,1fr))}
  .deal-kpis{grid-template-columns:repeat(2,minmax(110px,1fr));min-width:0;width:100%}
  .deal-summary{grid-template-columns:repeat(2,minmax(140px,1fr))}
  .grid2{grid-template-columns:1fr}
  .mets{grid-template-columns:repeat(2,minmax(150px,1fr))}
  .tabs-wrap{top:144px}
}
@media(max-width:640px){
  .logo{width:54px;height:54px;font-size:24px;border-radius:18px}
  .mgr-name{font-size:28px}
  .hero-meta{grid-template-columns:1fr}
  .tabs-wrap{position:static}
  .tabs{padding:10px}
  .tab{flex:1 1 calc(50% - 10px);text-align:center}
  .deal-tools{position:static;padding:16px;border-radius:24px}
  .deal-tools-title{font-size:24px}
  .deal-tools-grid{grid-template-columns:1fr}
  .deal-card-top,.deal-card-body,.card-top{padding-left:16px;padding-right:16px}
  .deal-summary{grid-template-columns:1fr}
  .deal-chips,.mets{grid-template-columns:1fr 1fr;min-width:0}
  th,td{padding:10px}
}
@media(max-width:480px){
  .cnt{padding:14px 10px 28px}
  .hdr{padding:10px}
  .hero-card,.hero-side,.sec,.deal-card,.card{border-radius:22px}
  .deal-chips,.mets{grid-template-columns:1fr}
  .tab{flex:1 1 100%}
}
</style>
</head><body>
<div class="hdr">
  <div class="hdr-in">
    <div class="hero-card">
      <div class="logo">T</div>
      <div class="brand-copy">
        <div class="eyebrow">Transkom Sales Cockpit</div>
        <div class="mgr-name">${managerName}</div>
        <div class="mgr-sub">Крупная сводка сверху, рабочие вкладки ниже и раскрывающиеся карточки внутри. Логика отчета сохранена, но визуально страница стала ближе к удобному ежедневному рабочему столу.</div>
      </div>
    </div>
    <div class="hero-side">
      <div class="hero-meta">
        <div class="hero-meta-card"><b>Отчетная дата</b><span>${data.reportDate || ''}</span></div>
        <div class="hero-meta-card"><b>Активных сделок</b><span>${(data.dealCards || []).filter(card => card.isActive).length}</span></div>
      </div>
      <div class="hero-upd"><b>Состояние сборки</b><div id="upd"></div></div>
    </div>
  </div>
  ${allManagers ? `<div class="manager-rail"><span class="manager-label">Переход по отчетам</span>${allManagers.map(m =>
    m.name === managerName
      ? `<span class="manager-pill is-active">${m.name}</span>`
      : `<a class="manager-pill" href="${navHref(m.alias)}#deals" onclick="return navTo('${m.alias}')">${m.name}</a>`
  ).join('')}<a href="${navHref('index')}" onclick="return navTo('index')" style="padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;background:#fff;color:#fbbf24;text-decoration:none;border:1px solid #d1d5db;cursor:pointer">Обзор</a></div>` : ''}
  <div class="toolbar-row">
    <div class="toolbar-copy">
      <b>Быстрые срезы</b>
      <span>Переключайте период, а затем переходите по вкладкам. Все детали остаются внутри карточек и раскрываются только по необходимости.</span>
    </div>
    <div class="pbar" id="pbar"></div>
  </div>
</div>
<div class="cnt">
  <div class="mets" id="mets"></div>
  <div class="tabs-wrap"><div class="tabs" id="tabs"></div></div>
  <div id="out"></div>
</div>
<script>
const D=${json};
const PF_URL='${API_URL.replace(/[\r\n]/g, '')}';
const PF_TOKEN='${TOKEN.replace(/[\r\n]/g, '')}';
const PERIODS=[{l:'Сегодня',d:0},{l:'3 дня',d:3},{l:'7 дн',d:7},{l:'14 дн',d:14},{l:'30 дн',d:30},{l:'Всё',d:9999}];

` + _loadClientJS() + `

init();
</script></body></html>`;
}

module.exports = { buildStatsFromMultiDay, generateHtml };
