// ============================================================
// dashboard.js — Мульти-менеджерский дашборд
// ============================================================

const { fs, path, ROOT_DIR, MANAGERS_LIST } = require('../utils/config');
const { pad2 } = require('../utils/helpers');

// ============ Дашборд для всех менеджеров ============
function generateDashboard(date, mgrDataFile) {
  const deployDir = path.join(ROOT_DIR, 'deploy');
  if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir, { recursive: true });

  const cards = [];
  for (const mgr of MANAGERS_LIST) {
    const dataPath = mgrDataFile(mgr.alias);
    if (!fs.existsSync(dataPath)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      const active = (d.dealCards || []).filter(c => c.isActive);
      const pipeline = active.reduce((s, c) => s + (c.dealSum || 0), 0);
      const dda = d.dailyDealActivity || [];
      const totalCalls = dda.reduce((s, dd) => s + (dd.actions || []).filter(a => a.type === 'outCall' || a.type === 'inCall').length, 0);
      const scores = dda.filter(dd => dd.ai?.salaryScore?.total).map(dd => dd.ai.salaryScore.total);
      const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—';
      const closing = active.filter(c => ['Дожим', 'Договор и оплата'].includes(c.status));
      const closingSum = closing.reduce((s, c) => s + (c.dealSum || 0), 0);
      cards.push({
        name: mgr.name, alias: mgr.alias,
        activeDealCount: active.length, pipeline,
        todayDeals: dda.length, totalCalls, avgScore,
        closingCount: closing.length, closingSum,
        reportDate: d.reportDate || date,
        aiSummary: (d.aiDaySummaryText || '').substring(0, 200),
      });
    } catch {}
  }

  const fmtMoney = n => { if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return Math.round(n / 1e3) + 'K'; return String(n); };

  let html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ТрансКом — Обзор менеджеров</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#f5f5f5;color:#1a1a2e;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:20px}
.header{text-align:center;padding:20px 0 30px}
.header h1{font-size:24px;color:#1a1a2e}
.header .date{color:#6b7280;font-size:14px;margin-top:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px;max-width:1200px;margin:0 auto}
.card{background:#fff;border-radius:12px;padding:20px;border:1px solid #d1d5db;transition:transform .2s}
.card:hover{transform:translateY(-2px);border-color:#3b82f6}
.card-name{font-size:18px;font-weight:700;color:#1a1a2e;margin-bottom:12px}
.card-metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.met{background:#f5f5f5;border-radius:8px;padding:10px;text-align:center}
.met-v{font-size:20px;font-weight:700}
.met-l{font-size:10px;color:#6b7280;text-transform:uppercase;margin-top:2px}
.green{color:#4ade80}.yellow{color:#fbbf24}.blue{color:#60a5fa}.purple{color:#a78bfa}.cyan{color:#22d3ee}
.card-summary{margin-top:12px;font-size:12px;color:#6b7280;line-height:1.4}
.card-link{display:block;text-align:center;margin-top:16px;padding:10px;background:#d97706;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px}
.card-link:hover{background:#2563eb}
.footer{text-align:center;margin-top:30px;color:#6b7280;font-size:12px}
</style></head><body>
<div class="header"><h1>ТрансКом — Обзор менеджеров</h1><div class="date">${date}</div></div>
<div class="grid">`;

  for (const c of cards) {
    html += `<div class="card">
<div class="card-name">${c.name}</div>
<div class="card-metrics">
<div class="met"><div class="met-v blue">${c.activeDealCount}</div><div class="met-l">Активных сделок</div></div>
<div class="met"><div class="met-v green">${fmtMoney(c.pipeline)} ₽</div><div class="met-l">Пайплайн</div></div>
<div class="met"><div class="met-v cyan">${c.todayDeals}</div><div class="met-l">Сделок за день</div></div>
<div class="met"><div class="met-v purple">${c.totalCalls}</div><div class="met-l">Звонков за день</div></div>
<div class="met"><div class="met-v yellow">${c.avgScore}/12</div><div class="met-l">Ср. балл</div></div>
<div class="met"><div class="met-v green">${c.closingCount} / ${fmtMoney(c.closingSum)} ₽</div><div class="met-l">К оплате</div></div>
</div>
${c.aiSummary ? `<div class="card-summary">${c.aiSummary}...</div>` : ''}
<a class="card-link" href="${c.alias}/index.html">Открыть полный отчёт →</a>
</div>`;
  }

  // Кнопка "+ Менеджер"
  html += `<div style="text-align:center;margin-top:20px">
<button onclick="document.getElementById('addModal').style.display='flex'" style="padding:12px 24px;background:#fff;color:#d97706;border:2px dashed #d1d5db;border-radius:12px;font-size:16px;cursor:pointer;font-weight:600">+ Добавить менеджера</button>
</div>`;

  // Модалка добавления менеджера
  html += `<div id="addModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:100;align-items:center;justify-content:center">
<div style="background:#fff;border-radius:16px;padding:30px;max-width:450px;width:90%;border:1px solid #d1d5db">
<h2 style="color:#1a1a2e;margin-bottom:20px;font-size:20px">Добавить менеджера</h2>
<p style="color:#6b7280;font-size:13px;margin-bottom:16px">Введите данные нового менеджера. userId можно найти в Planfix: Сотрудники → Профиль → число в URL.</p>
<div style="margin-bottom:12px"><label style="color:#6b7280;font-size:12px">Имя и Фамилия</label><br>
<input id="mgrName" placeholder="Иван Иванов" style="width:100%;padding:10px;background:#f5f5f5;border:1px solid #d1d5db;border-radius:8px;color:#1a1a2e;font-size:14px;margin-top:4px"></div>
<div style="margin-bottom:12px"><label style="color:#6b7280;font-size:12px">userId из Planfix</label><br>
<input id="mgrId" type="number" placeholder="55" style="width:100%;padding:10px;background:#f5f5f5;border:1px solid #d1d5db;border-radius:8px;color:#1a1a2e;font-size:14px;margin-top:4px"></div>
<div id="addResult" style="display:none;margin-bottom:12px;padding:12px;border-radius:8px;font-size:12px"></div>
<div style="display:flex;gap:10px;margin-top:16px">
<button onclick="addManager()" style="flex:1;padding:10px;background:#d97706;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">Добавить</button>
<button onclick="document.getElementById('addModal').style.display='none'" style="flex:1;padding:10px;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:8px;font-size:14px;cursor:pointer">Отмена</button>
</div>
</div></div>

<script>
function addManager(){
  var name=document.getElementById('mgrName').value.trim();
  var id=parseInt(document.getElementById('mgrId').value);
  if(!name||!id){alert('Заполните имя и userId');return;}
  var alias=name.split(' ').pop().toLowerCase().replace(/[^a-zа-яё]/gi,'');
  var pfName=name.split(' ').pop();
  var entry={alias:alias,userId:id,name:name,pfName:pfName};
  // Сохраняем в localStorage
  var saved=JSON.parse(localStorage.getItem('transcom_managers')||'[]');
  if(saved.find(function(m){return m.userId===id})){alert('Менеджер с таким ID уже добавлен');return;}
  saved.push(entry);
  localStorage.setItem('transcom_managers',JSON.stringify(saved));
  // Показываем JSON для managers.json
  var res=document.getElementById('addResult');
  res.style.display='block';
  res.style.background='#f0fdf4';
  res.style.color='#16a34a';
  res.innerHTML='<b>Добавлено!</b> Чтобы отчёт генерировался автоматически, добавьте в <code>managers.json</code>:<br><br>'
    +'<code style="color:#fbbf24;word-break:break-all">'+JSON.stringify(entry)+'</code>'
    +'<br><br>После коммита и пуша — отчёт появится при следующем запуске в 19:00.';
  // Добавляем карточку на страницу
  var grid=document.querySelector('.grid');
  var div=document.createElement('div');
  div.className='card';
  div.innerHTML='<div class="card-name">'+name+'</div>'
    +'<div style="color:#6b7280;font-size:13px;padding:20px 0">Отчёт будет сгенерирован при следующем запуске после добавления в managers.json</div>'
    +'<div style="padding:8px 12px;background:#f5f5f5;border-radius:8px;font-size:11px;color:#fbbf24">userId: '+id+' | alias: '+alias+'</div>';
  grid.appendChild(div);
}
</script>`;

  html += `<div class="footer">Обновлено: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</div></body></html>`;

  fs.writeFileSync(path.join(deployDir, 'index.html'), html, 'utf8');
  console.log(`\n📊 Дашборд: deploy/index.html (${cards.length} менеджеров)`);
}

module.exports = { generateDashboard };
