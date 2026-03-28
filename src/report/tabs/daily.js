// ============================================================
// daily.js — клиентский JS: вкладка "daily"
// ============================================================

function get_daily_JS() {
  return "  const sorted=[...reports].sort((a,b)=>b.date.localeCompare(a.date));\n  let h='<div class=\"sec\"><h3>📅 Ежедневные</h3><div style=\"overflow-x:auto\"><table>';\n  h+='<tr><th>Дата</th><th>Оплаты</th><th>Исх.</th><th>Мин</th><th>КП</th><th>Дожим</th><th>Договор</th><th>Выполн.</th></tr>';\n  for(const r of sorted){\n    h+='<tr><td><strong>'+fmtD(r.date)+'</strong></td>';\n    h+='<td>'+(r.revenue?'<span style=\"color:#fbbf24;font-weight:700\">'+fmt(r.revenue)+'₽</span>':'—')+'</td>';\n    h+='<td>'+(r.outCalls||'—')+'</td><td>'+(r.callMinutes||'—')+'</td><td>'+(r.kpSent||'—')+'</td><td>'+(r.dozhim||'—')+'</td>';\n    h+='<td>'+(r.contract?'<span class=\"bg bg-g\">'+r.contract+'</span>':'—')+'</td>';\n    h+='<td>'+(r.workDone||'—')+'</td></tr>';\n  }\n  h+='</table></div></div>';\n  document.getElementById('out').innerHTML=h;\n}\n\n// === ВОРОНКА ===\nfunction renderFunnel(){";
}

module.exports = { get_daily_JS };
