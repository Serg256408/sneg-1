function renderDaily(reports){
  const sorted=[...reports].sort((a,b)=>b.date.localeCompare(a.date));
  let h='<div class="sec"><h3>📅 Ежедневные</h3><div style="overflow-x:auto"><table>';
  h+='<tr><th>Дата</th><th>Оплаты</th><th>Исх.</th><th>Мин</th><th>КП</th><th>Дожим</th><th>Договор</th><th>Выполн.</th></tr>';
  for(const r of sorted){
    h+='<tr><td><strong>'+fmtD(r.date)+'</strong></td>';
    h+='<td>'+(r.revenue?'<span style="color:#fbbf24;font-weight:700">'+fmt(r.revenue)+'₽</span>':'—')+'</td>';
    h+='<td>'+(r.outCalls||'—')+'</td><td>'+(r.callMinutes||'—')+'</td><td>'+(r.kpSent||'—')+'</td><td>'+(r.dozhim||'—')+'</td>';
    h+='<td>'+(r.contract?'<span class="bg bg-g">'+r.contract+'</span>':'—')+'</td>';
    h+='<td>'+(r.workDone||'—')+'</td></tr>';
  }
  h+='</table></div></div>';
  document.getElementById('out').innerHTML=h;
}

// === ВОРОНКА ===