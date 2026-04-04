// ============================================================
// html.js — Генерация HTML-отчёта
// ============================================================

const { API_URL, TOKEN } = require('../utils/config');
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
      os.oldDeals.add(dealId);
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
  // Статусы воронки для статистики
  const statusCounts = {};
  for (const card of (data.dealCards || [])) { statusCounts[card.status] = (statusCounts[card.status] || 0) + 1; }
  data.statusCounts = statusCounts;
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
</style>
</head><body>
<div class="hdr"><div class="hdr-in">
  <div class="logo">T</div>
  <div><div style="font-size:17px;font-weight:800;color:#1a1a2e">${managerName}</div><div style="font-size:12px;color:#6b7280" id="upd"></div></div>
  ${allManagers ? `<div style="display:flex;gap:6px;margin-left:auto;margin-right:12px;flex-wrap:wrap">${allManagers.map(m =>
    m.name === managerName
      ? `<span style="padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;background:#3b82f6;color:#1a1a2e">${m.name}</span>`
      : `<a href="${navHref(m.alias)}" onclick="return navTo('${m.alias}')" style="padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;background:#fff;color:#6b7280;text-decoration:none;border:1px solid #d1d5db;cursor:pointer">${m.name}</a>`
  ).join('')}<a href="${navHref('index')}" onclick="return navTo('index')" style="padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;background:#fff;color:#fbbf24;text-decoration:none;border:1px solid #d1d5db;cursor:pointer">Обзор</a></div>` : ''}
  <div class="pbar" id="pbar"></div>
</div></div>
<div class="cnt">
  <div class="mets" id="mets"></div>
  <div class="tabs" id="tabs"></div>
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
