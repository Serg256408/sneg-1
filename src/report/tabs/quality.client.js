function renderQuality(analyses,cards){
  let h='';

  // Скрипт новых сделок
  const sc=D.scriptCompliance;
  if(sc.total>0){
    h+='<div class="sec"><h3>🆕 Скрипт новых сделок ('+sc.total+' анализов)</h3>';
    h+='<div class="grid2"><div>';
    const criteria=[
      {l:'Рассказал как работаем',v:sc.howWeWork,t:sc.total},
      {l:'Призыв к действию',v:sc.callToAction,t:sc.total},
      {l:'Скинул счёт',v:sc.sentInvoice,t:sc.total},
      {l:'Все 4 момента',v:sc.allFour,t:sc.total},
    ];
    for(const cr of criteria){
      const pct=cr.t?Math.round(cr.v/cr.t*100):0;
      const col=pct>=50?'#34d399':pct>=25?'#fbbf24':'#f87171';
      h+='<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span>'+cr.l+'</span><span style="color:'+col+';font-weight:700">'+cr.v+'/'+cr.t+' ('+pct+'%)</span></div><div class="bar-bg" style="height:8px"><div class="bar-f" style="width:'+pct+'%;background:'+col+'"></div></div></div>';
    }
    h+='</div><div style="text-align:center;padding:20px">';
    const sc_col=sc.avgScore>=15?'#34d399':sc.avgScore>=10?'#fbbf24':'#f87171';
    h+='<div style="font-size:36px;font-weight:800;color:'+sc_col+'">'+sc.avgScore+'</div>';
    h+='<div style="font-size:12px;color:#6b7280">Ср. балл новых</div>';
    h+='</div></div>';

    // Детали по сделкам
    if(sc.details.length){
      h+='<h4>Детали</h4><table><tr><th>Сделка</th><th>Тема</th><th>Как раб.</th><th>Призыв</th><th>Счёт</th><th>Все 4</th><th>Баллы</th><th>Вердикт</th></tr>';
      for(const a of sc.details){
        const vc=a.verdict.includes('Эксперт')?'bg-b':a.verdict.includes('Хорошо')?'bg-g':a.verdict.includes('Средне')?'bg-y':'bg-r';
        h+='<tr><td style="font-size:11px">#'+a.dealId+'</td>';
        h+='<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.topic.substring(0,30))+'</td>';
        h+='<td>'+yn(a.howWeWork)+'</td><td>'+yn(a.callToAction)+'</td><td>'+yn(a.sentInvoice)+'</td><td>'+yn(a.allFour)+'</td>';
        h+='<td><strong>'+a.totalBalls+'</strong></td>';
        h+='<td><span class="bg '+vc+'">'+esc(a.verdict.split('(')[0].trim())+'</span></td></tr>';
      }
      h+='</table>';
    }
    h+='</div>';
  }

  // Общее качество
  const sorted=[...analyses].sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
  h+='<div class="sec"><h3>📊 Общее качество ('+analyses.length+')</h3><div style="overflow-x:auto"><table>';
  h+='<tr><th>Дата</th><th>Тема</th><th>Как раб.</th><th>Призыв</th><th>Счёт</th><th>Все 4</th><th>Баллы</th><th>Вердикт</th></tr>';
  for(const a of sorted){
    const vc=a.verdict.includes('Эксперт')?'bg-b':a.verdict.includes('Хорошо')?'bg-g':a.verdict.includes('Средне')?'bg-y':'bg-r';
    h+='<tr><td style="white-space:nowrap;font-size:11px">'+esc(a.date)+'</td>';
    h+='<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(a.topic)+'">'+esc(a.topic.substring(0,35))+'</td>';
    h+='<td>'+yn(a.howWeWork)+'</td><td>'+yn(a.callToAction)+'</td><td>'+yn(a.sentInvoice)+'</td><td>'+yn(a.allFour)+'</td>';
    h+='<td><strong>'+a.totalBalls+'</strong></td>';
    h+='<td><span class="bg '+vc+'">'+esc(a.verdict.split('(')[0].trim())+'</span></td></tr>';
  }
  h+='</table></div></div>';

  // Вердикты + Критерии
  const verdicts={};analyses.forEach(a=>{const v=a.verdict.split('(')[0].trim()||'?';verdicts[v]=(verdicts[v]||0)+1});
  h+='<div class="sec grid2"><div><h3>Вердикты</h3>';
  for(const[v,n]of Object.entries(verdicts).sort((a,b)=>b[1]-a[1])){
    const pct=Math.round(n/analyses.length*100);
    const col=v.includes('Эксперт')?'#60a5fa':v.includes('Хорошо')?'#34d399':v.includes('Средне')?'#fbbf24':'#f87171';
    h+='<div style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span>'+v+'</span><span style="color:'+col+';font-weight:700">'+n+' ('+pct+'%)</span></div><div class="bar-bg"><div class="bar-f" style="width:'+pct+'%;background:'+col+'"></div></div></div>';
  }
  h+='</div><div><h3>Критерии</h3>';
  [{l:'Как работаем',f:'howWeWork'},{l:'Призыв',f:'callToAction'},{l:'Счёт',f:'sentInvoice'},{l:'Все 4',f:'allFour'}].forEach(yr=>{
    const yes=analyses.filter(a=>a[yr.f]==='Да').length;const pct=analyses.length?Math.round(yes/analyses.length*100):0;
    const col=pct>=50?'#34d399':pct>=25?'#fbbf24':'#f87171';
    h+='<div style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span>'+yr.l+'</span><span style="color:'+col+';font-weight:700">'+pct+'%</span></div><div class="bar-bg"><div class="bar-f" style="width:'+pct+'%;background:'+col+'"></div></div></div>';
  });
  h+='</div></div>';
  document.getElementById('out').innerHTML=h;
}

// === ЕЖЕДНЕВНЫЕ ===