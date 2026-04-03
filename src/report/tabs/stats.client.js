function extractMovedStatus(text){
  var raw=(text||'').replace(/<br\s*\/?>/gi,'\n').replace(/\r/g,'');
  var prefixes=['Статус изменён на ','Статус изменен на '];
  for(var i=0;i<prefixes.length;i++){
    var prefix=prefixes[i];
    var idx=raw.indexOf(prefix);
    if(idx<0)continue;
    var status=raw.slice(idx+prefix.length).split('\n')[0].replace(/<[^>]*>/g,'').trim();
    if(status)return status;
  }
  return '';
}

function collectMovedToStatuses(){
  var movedTo={};
  var dealLookup={};
  (D.dealCards||[]).forEach(function(card){dealLookup[card.id]=card;});

  var periodDays={};
  var multiDay=D.multiDayActivity||{};
  Object.keys(multiDay).forEach(function(date){
    if(inStatRange(date))periodDays[date]=multiDay[date]||[];
  });
  if(D.reportDate&&inStatRange(D.reportDate)&&!periodDays[D.reportDate]&&D.dailyDealActivity){
    periodDays[D.reportDate]=D.dailyDealActivity;
  }

  Object.keys(periodDays).forEach(function(date){
    (periodDays[date]||[]).forEach(function(entry){
      var dealId=entry&&entry.deal?entry.deal.id:0;
      if(!dealId)return;
      var liveCard=dealLookup[dealId];
      var sourceDeal=liveCard||entry.deal||{};
      (entry.actions||[]).forEach(function(action){
        var newStatus=extractMovedStatus(action.text);
        if(!newStatus)return;
        if(!movedTo[newStatus])movedTo[newStatus]={count:0,sum:0,deals:[],ids:{}};
        if(movedTo[newStatus].ids[dealId])return;
        movedTo[newStatus].ids[dealId]=true;
        movedTo[newStatus].count++;
        movedTo[newStatus].sum+=(sourceDeal.dealSum||0);
        movedTo[newStatus].deals.push({
          id:dealId,
          name:sourceDeal.name||'?',
          sum:sourceDeal.dealSum||0,
          counterparty:sourceDeal.counterparty||'',
          moveDate:date
        });
      });
    });
  });

  if(Object.keys(movedTo).length){
    return Object.keys(movedTo).reduce(function(acc,status){
      var item=movedTo[status];
      acc[status]={count:item.count,sum:item.sum,deals:item.deals};
      return acc;
    },{});
  }

  D.dealCards.forEach(function(card){
    (card.comments||[]).forEach(function(c){
      if(!inStatRange(c.date))return;
      var newStatus=extractMovedStatus(c.text);
      if(!newStatus)return;
      if(!movedTo[newStatus])movedTo[newStatus]={count:0,sum:0,deals:[],ids:{}};
      if(movedTo[newStatus].ids[card.id])return;
      movedTo[newStatus].ids[card.id]=true;
      movedTo[newStatus].count++;
      movedTo[newStatus].sum+=(card.dealSum||0);
      movedTo[newStatus].deals.push({
        id:card.id,
        name:card.name,
        sum:card.dealSum||0,
        counterparty:card.counterparty||'',
        moveDate:c.date
      });
    });
  });

  return Object.keys(movedTo).reduce(function(acc,status){
    var item=movedTo[status];
    acc[status]={count:item.count,sum:item.sum,deals:item.deals};
    return acc;
  },{});
}

function renderStats(){
  const stAll=D.statsData||[];
  const opsAll=D.opsStats||[];
  // Фильтрация по выбранному периоду
  const st=stAll.filter(s=>inStatRange(s.date));
  const ops=opsAll.filter(o=>inStatRange(o.date));

  let h='';

  // === ФИЛЬТР ПЕРИОДА ===
  h+='<div class="sec" style="padding:10px 14px">';
  h+='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
  h+='<span style="font-size:12px;font-weight:700;color:#6b7280">Период:</span>';
  h+=buildPeriodButtons();
  h+='<span style="margin-left:8px;font-size:11px;color:#6b7280">с</span>';
  h+='<input type="date" id="sf" value="'+(statFrom||'')+'" onchange="statDateChanged()" style="background:#fff;border:1px solid rgba(0,0,0,.1);color:#1a1a2e;padding:4px 8px;border-radius:6px;font-size:11px;font-family:inherit">';
  h+='<span style="font-size:11px;color:#6b7280">по</span>';
  h+='<input type="date" id="st" value="'+(statTo||'')+'" onchange="statDateChanged()" style="background:#fff;border:1px solid rgba(0,0,0,.1);color:#1a1a2e;padding:4px 8px;border-radius:6px;font-size:11px;font-family:inherit">';
  h+='</div></div>';

  if(!ops.length&&!st.length){
    h+='<div class="no-data">Нет данных за выбранный период</div>';
    document.getElementById('out').innerHTML=h;return;
  }

  // === СВОДКА ЗА ПЕРИОД ===
  const totalOutC=ops.reduce((a,o)=>a+o.outCalls,0);
  const totalInC=ops.reduce((a,o)=>a+o.inCalls,0);
  const totalCallMin=ops.reduce((a,o)=>a+o.callMinutes,0);
  const totalWorked=ops.reduce((a,o)=>a+o.dealsWorked,0);
  const totalNewD=ops.reduce((a,o)=>a+o.newDeals,0);
  const totalOldD=ops.reduce((a,o)=>a+o.oldDeals,0);
  const totalAiDeals=st.reduce((a,s)=>a+s.deals,0);
  const totalScore=st.reduce((a,s)=>a+s.totalScore,0);
  const maxScore=st.reduce((a,s)=>a+s.maxScore,0);
  const avgScore=totalAiDeals>0?Math.round(totalScore/totalAiDeals*10)/10:0;
  const scCol=avgScore>=7?'#34d399':avgScore>=4?'#fbbf24':'#f87171';

  h+='<div class="sec"><h3>📋 Сводка за период ('+ops.length+' дней)</h3>';
  h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px">';
  const mets=[
    {l:'Рабочих дней',v:ops.length,c:'#60a5fa'},
    {l:'Обработано сделок',v:totalWorked,c:'#a78bfa'},
    {l:'Новых',v:totalNewD,c:'#c084fc'},
    {l:'Старых',v:totalOldD,c:'#818cf8'},
    {l:'Исходящих',v:totalOutC,c:'#34d399'},
    {l:'Входящих',v:totalInC,c:'#60a5fa'},
    {l:'Время звонков',v:totalCallMin+'м',c:'#818cf8'},
    {l:'Ср. балл ЗП',v:avgScore+'/12',c:scCol},
  ];
  for(const m of mets) h+='<div class="met"><div class="met-l">'+m.l+'</div><div class="met-v" style="color:'+m.c+'">'+m.v+'</div></div>';
  h+='</div></div>';

  // === РАСПРЕДЕЛЕНИЕ СДЕЛОК ПО СТАТУСАМ (все сделки из Planfix) ===
  var statusOrder2=['Новая','Обработка','В работе','Коммерческое предложение','Вывезли/Нашли поставщика','Дожим','Договор и оплата','Выполнение Работы','Сделанная','Сделка завершена'];
  // Фильтруем сделки по периоду: те у которых была активность (звонки/комментарии) в диапазоне
  var periodDeals=D.dealCards.filter(function(d){
    // Проверяем звонки
    if((d.calls||[]).some(function(c){return inStatRange(c.date);}))return true;
    // Проверяем комментарии
    if((d.comments||[]).some(function(c){return inStatRange(c.date);}))return true;
    // Проверяем создание в периоде
    if(d.dateCreated && inStatRange(d.dateCreated))return true;
    return false;
  });
  var statusData={};
  periodDeals.forEach(function(d){
    var s=d.status||'?';
    if(!statusData[s])statusData[s]={count:0,sum:0,deals:[]};
    statusData[s].count++;
    statusData[s].sum+=(d.dealSum||0);
    statusData[s].deals.push(d);
  });
  var allStatuses=[...statusOrder2,...Object.keys(statusData).filter(function(k){return statusOrder2.indexOf(k)<0;})].filter(function(k){return statusData[k];});
  var totalDealsAll=periodDeals.length;
  var totalSumAll=periodDeals.reduce(function(s,d){return s+(d.dealSum||0);},0);
  var maxStCount=Math.max.apply(null,allStatuses.map(function(s){return statusData[s].count;}))||1;

  h+='<div class="sec"><h3>📊 Текущие статусы сделок с активностью за период ('+totalDealsAll+' из '+D.dealCards.length+')</h3>';
  h+='<p style="color:#6b7280;font-size:12px;margin-bottom:10px">Здесь показано текущее состояние сделок с активностью за выбранный период, а не переходы между этапами</p>';
  h+='<div style="overflow-x:auto"><table>';
  h+='<tr><th>Статус</th><th style="text-align:center">Сделок</th><th style="text-align:right">Сумма</th><th style="text-align:right">%</th><th style="width:30%"></th></tr>';
  for(var si=0;si<allStatuses.length;si++){
    var st2=allStatuses[si];
    var sd=statusData[st2];
    var pct2=totalDealsAll?Math.round(sd.count/totalDealsAll*100):0;
    var barPct=Math.round(sd.count/maxStCount*100);
    var isWork=st2==='Выполнение Работы';
    var isDone=['Договор и оплата','Выполнение Работы','Сделанная','Сделка завершена'].indexOf(st2)>=0;
    var rowStyle=isWork?'background:rgba(52,211,153,.12);':'';
    var nameCol=isWork?'#16a34a':isDone?'#16a34a':'#1a1a2e';
    var barCol=isWork?'#34d399':isDone?'#34d399':'#60a5fa';
    h+='<tr style="'+rowStyle+'">';
    h+='<td style="font-weight:700;color:'+nameCol+';white-space:nowrap">'+(isWork?'🏗 ':'')+esc(st2)+'</td>';
    h+='<td style="text-align:center;font-weight:700">'+sd.count+'</td>';
    h+='<td style="text-align:right;font-weight:700;color:#fbbf24">'+(sd.sum?fmt(sd.sum)+' ₽':'—')+'</td>';
    h+='<td style="text-align:right;color:#6b7280">'+pct2+'%</td>';
    h+='<td><div class="bar-bg"><div class="bar-f" style="width:'+barPct+'%;background:'+barCol+'"></div></div></td>';
    h+='</tr>';
    // Раскрываем список для ключевых статусов
    if(isWork||st2==='Договор и оплата'||st2==='Дожим'){
      sd.deals.sort(function(a,b){return(b.dealSum||0)-(a.dealSum||0);});
      for(var di2=0;di2<sd.deals.length;di2++){
        var deal=sd.deals[di2];
        h+='<tr style="background:rgba(0,0,0,.02)">';
        h+='<td style="padding-left:24px;font-size:11px;color:#6b7280">↳ #'+deal.id+' '+esc((deal.name||'').substring(0,45))+'</td>';
        h+='<td style="text-align:center;font-size:11px;color:#6b7280">'+esc(deal.counterparty||'')+'</td>';
        h+='<td style="text-align:right;font-size:11px;color:#fbbf24">'+(deal.dealSum?fmt(deal.dealSum)+' ₽':'—')+'</td>';
        h+='<td colspan="2"></td></tr>';
      }
    }
  }
  h+='<tr style="border-top:2px solid rgba(0,0,0,.1);font-weight:800">';
  h+='<td>Итого</td><td style="text-align:center">'+totalDealsAll+'</td>';
  h+='<td style="text-align:right;color:#fbbf24">'+fmt(totalSumAll)+' ₽</td>';
  h+='<td style="text-align:right">100%</td><td></td></tr>';
  h+='</table></div>';

  var movedTo=collectMovedToStatuses();
  var hasMovedDeals=Object.keys(movedTo).some(function(status){return movedTo[status]&&movedTo[status].count>0;});

  // === ПРОДУКТИВНОСТЬ МЕНЕДЖЕРА ===
  var prodStatuses=[
    {key:'Обработка',icon:'📥',color:'#60a5fa',label:'Попало в обработку'},
    {key:'Коммерческое предложение',icon:'📋',color:'#818cf8',label:'Передвинуто в КП'},
    {key:'Клиент принимает решение',icon:'🤔',color:'#a78bfa',label:'Клиент принимает решение'},
    {key:'Дожим',icon:'💪',color:'#f59e0b',label:'Дожим'},
    {key:'Договор и оплата',icon:'💰',color:'#16a34a',label:'Договор и оплата'},
    {key:'Выполнение Работы',icon:'🏗',color:'#059669',label:'Выполнение работы'},
    {key:'Сделанная',icon:'✅',color:'#10b981',label:'Успешно завершены'},
    {key:'Сделка завершена',icon:'❌',color:'#ef4444',label:'Неуспешные (закрыты)'}
  ];
  var totalToPayment=0,totalToPaymentCount=0;
  prodStatuses.forEach(function(ps){
    if(['Договор и оплата','Выполнение Работы','Сделанная'].indexOf(ps.key)>=0 && movedTo[ps.key]){
      totalToPayment+=movedTo[ps.key].sum;
      totalToPaymentCount+=movedTo[ps.key].count;
    }
  });

  h+='<div style="margin-top:18px"><h4 style="color:#60a5fa;margin-bottom:10px">📈 Продуктивность менеджера за период</h4>';
  h+='<p style="color:#6b7280;font-size:12px;margin:0 0 10px">Здесь считаются именно переходы сделок в статусы внутри выбранного периода, а не их текущее распределение</p>';
  h+='<table><tr><th>Движение по воронке</th><th style="text-align:center">Сделок</th><th style="text-align:right">Сумма</th></tr>';
  for(var pi=0;pi<prodStatuses.length;pi++){
    var ps=prodStatuses[pi];
    var mv=movedTo[ps.key];
    if(!mv||mv.count===0){
      h+='<tr style="opacity:.4"><td>'+ps.icon+' '+ps.label+'</td><td style="text-align:center">0</td><td style="text-align:right">—</td></tr>';
      continue;
    }
    var isMoney=['Договор и оплата','Выполнение Работы','Сделанная'].indexOf(ps.key)>=0;
    var bgStyle=isMoney?'background:rgba(16,185,129,.08);':'';
    h+='<tr style="'+bgStyle+'"><td style="font-weight:700;color:'+ps.color+'">'+ps.icon+' '+ps.label+'</td>';
    h+='<td style="text-align:center;font-weight:700;font-size:16px">'+mv.count+'</td>';
    h+='<td style="text-align:right;font-weight:700;color:'+(isMoney?'#16a34a':'#fbbf24')+'">'+(mv.sum?fmt(mv.sum)+' ₽':'—')+'</td></tr>';
    // Раскрывающийся список сделок
    mv.deals.sort(function(a,b){return(b.sum||0)-(a.sum||0)||dateStamp(b.moveDate,'00:00')-dateStamp(a.moveDate,'00:00');});
    for(var di3=0;di3<mv.deals.length;di3++){
      var dd=mv.deals[di3];
      h+='<tr style="background:rgba(0,0,0,.02)"><td style="padding-left:28px;font-size:11px;color:#6b7280">';
      h+='↳ <span style="color:#60a5fa;font-weight:600">#'+dd.id+'</span> '+esc((dd.name||'').substring(0,50));
      if(dd.counterparty) h+=' <span style="color:#9ca3af">— '+esc(dd.counterparty.substring(0,25))+'</span>';
      if(dd.moveDate) h+=' <span style="color:#9ca3af">• '+esc(dd.moveDate)+'</span>';
      h+='</td><td></td>';
      h+='<td style="text-align:right;font-size:11px;color:#fbbf24">'+(dd.sum?fmt(dd.sum)+' ₽':'—')+'</td></tr>';
    }
  }
  // Также показываем статусы не в основном списке
  Object.keys(movedTo).forEach(function(s){
    if(prodStatuses.some(function(ps){return ps.key===s;}))return;
    if(!movedTo[s]||movedTo[s].count===0)return;
    var mv=movedTo[s];
    h+='<tr><td style="font-weight:600;color:#6b7280">↪ '+esc(s)+'</td>';
    h+='<td style="text-align:center;font-weight:700">'+mv.count+'</td>';
    h+='<td style="text-align:right;color:#fbbf24">'+(mv.sum?fmt(mv.sum)+' ₽':'—')+'</td></tr>';
    mv.deals.sort(function(a,b){return(b.sum||0)-(a.sum||0)||dateStamp(b.moveDate,'00:00')-dateStamp(a.moveDate,'00:00');});
    for(var di4=0;di4<mv.deals.length;di4++){
      var dd2=mv.deals[di4];
      h+='<tr style="background:rgba(0,0,0,.02)"><td style="padding-left:28px;font-size:11px;color:#6b7280">';
      h+='↳ <span style="color:#60a5fa;font-weight:600">#'+dd2.id+'</span> '+esc((dd2.name||'').substring(0,50));
      if(dd2.moveDate) h+=' <span style="color:#9ca3af">• '+esc(dd2.moveDate)+'</span>';
      h+='</td>';
      h+='<td></td><td style="text-align:right;font-size:11px;color:#fbbf24">'+(dd2.sum?fmt(dd2.sum)+' ₽':'—')+'</td></tr>';
    }
  });
  if(!hasMovedDeals){
    h+='<tr style="opacity:.65"><td colspan="3">За выбранный период не найдено переходов по воронке</td></tr>';
  }
  // ИТОГО к оплате
  h+='<tr style="border-top:2px solid rgba(16,185,129,.3);background:rgba(16,185,129,.06)">';
  h+='<td style="font-weight:800;color:#059669">💵 ИТОГО к оплате/в работе</td>';
  h+='<td style="text-align:center;font-weight:800;color:#059669">'+totalToPaymentCount+'</td>';
  h+='<td style="text-align:right;font-weight:800;color:#16a34a;font-size:15px">'+(totalToPayment?fmt(totalToPayment)+' ₽':'—')+'</td></tr>';
  h+='</table></div>';

  h+='</div>';

  // === АКТИВНОСТЬ ПО ДНЯМ — большая таблица ===
  h+='<div class="sec"><h3>📅 Активность менеджера по дням</h3>';
  h+='<div style="overflow-x:auto"><table>';
  h+='<tr><th>Дата</th><th>Сделок</th><th>Новых</th><th>Старых</th><th>📤 Исх.</th><th>📥 Вх.</th><th>⏱ Мин</th><th>Ср.балл</th></tr>';
  // Merge ops and st by date
  const allDates=[...new Set([...ops.map(o=>o.date),...st.map(s=>s.date)])].sort((a,b)=>{
    const pa=a.split('-'),pb=b.split('-');
    return new Date(pa[2]+'-'+pa[1]+'-'+pa[0])-new Date(pb[2]+'-'+pb[1]+'-'+pb[0]);
  });
  let totDeals=0,totNew=0,totOld=0,totOut=0,totIn=0,totMin=0,totScore=0,totScoreDays=0;
  for(const date of allDates){
    const o=ops.find(x=>x.date===date)||{outCalls:0,inCalls:0,callMinutes:0,dealsWorked:0,newDeals:0,oldDeals:0};
    const s=st.find(x=>x.date===date);
    const avg=s?s.avgScore:'-';
    const col=s?(s.avgScore>=7?'#34d399':s.avgScore>=4?'#fbbf24':'#f87171'):'#64748b';
    totDeals+=o.dealsWorked;totNew+=o.newDeals;totOld+=o.oldDeals;
    totOut+=o.outCalls;totIn+=o.inCalls;totMin+=o.callMinutes;
    if(s){totScore+=s.avgScore;totScoreDays++;}
    h+='<tr>';
    h+='<td style="white-space:nowrap;font-weight:600">'+date+'</td>';
    h+='<td style="font-weight:700">'+o.dealsWorked+'</td>';
    h+='<td style="color:#c084fc">'+o.newDeals+'</td>';
    h+='<td style="color:#818cf8">'+o.oldDeals+'</td>';
    h+='<td style="color:#34d399;font-weight:700">'+o.outCalls+'</td>';
    h+='<td style="color:#60a5fa">'+o.inCalls+'</td>';
    h+='<td style="color:#818cf8">'+o.callMinutes+'</td>';
    h+='<td style="color:'+col+';font-weight:700">'+avg+'</td>';
    h+='</tr>';
  }
  const totAvg=totScoreDays?+(totScore/totScoreDays).toFixed(1):'-';
  const totAvgCol=totScoreDays?(totAvg>=7?'#34d399':totAvg>=4?'#fbbf24':'#f87171'):'#64748b';
  h+='<tr style="border-top:2px solid rgba(0,0,0,.1);font-weight:800;background:rgba(0,0,0,.03)">';
  h+='<td>Итого</td>';
  h+='<td>'+totDeals+'</td>';
  h+='<td style="color:#c084fc">'+totNew+'</td>';
  h+='<td style="color:#818cf8">'+totOld+'</td>';
  h+='<td style="color:#34d399">'+totOut+'</td>';
  h+='<td style="color:#60a5fa">'+totIn+'</td>';
  h+='<td style="color:#818cf8">'+totMin+'</td>';
  h+='<td style="color:'+totAvgCol+'">'+totAvg+'</td>';
  h+='</tr>';
  h+='</table></div></div>';

  // === ЗВОНКИ ПО ДНЯМ — гистограмма ===
  h+='<div class="sec"><h3>📞 Исходящие звонки по дням</h3>';
  const maxCalls=Math.max(...ops.map(o=>o.outCalls),1);
  for(const o of ops){
    const pct=Math.round(o.outCalls/maxCalls*100);
    h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">';
    h+='<span style="width:80px;font-size:11px;color:#6b7280;text-align:right;flex-shrink:0">'+o.date+'</span>';
    h+='<div class="bar-bg" style="flex:1;height:18px"><div class="bar-f" style="width:'+pct+'%;background:#34d399"></div></div>';
    h+='<span style="width:40px;font-size:12px;font-weight:700;color:#34d399;text-align:right">'+o.outCalls+'</span>';
    h+='<span style="width:40px;font-size:10px;color:#6b7280">'+o.callMinutes+'м</span>';
    h+='</div>';
  }
  h+='</div>';

  // === СРЕДНИЙ БАЛЛ ЗП ПО ДНЯМ ===
  if(st.length){
    h+='<div class="sec"><h3>📈 Средний балл ЗП по дням</h3>';
    for(const s of st){
      const pct=Math.round(s.avgScore/12*100);
      const col=s.avgScore>=7?'#34d399':s.avgScore>=4?'#fbbf24':'#f87171';
      h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">';
      h+='<span style="width:80px;font-size:11px;color:#6b7280;text-align:right;flex-shrink:0">'+s.date+'</span>';
      h+='<div class="bar-bg" style="flex:1;height:18px"><div class="bar-f" style="width:'+pct+'%;background:'+col+'"></div></div>';
      h+='<span style="width:70px;font-size:12px;font-weight:700;color:'+col+';text-align:right">'+s.avgScore+'/12</span>';
      h+='<span style="width:50px;font-size:10px;color:#6b7280">'+s.deals+' сд.</span>';
      h+='</div>';
    }
    h+='</div>';
  }

  // === ВЫПОЛНЕНИЕ СКРИПТА ===
  if(st.length){
    const totalDeals=st.reduce((a,s)=>a+s.deals,0);
    h+='<div class="sec"><h3>✅ Выполнение скрипта продаж</h3>';
    h+='<div style="overflow-x:auto"><table><tr><th>Пункт</th><th>Выполнено</th><th>%</th><th></th></tr>';
    const items=[
      {l:'Устная презентация',v:st.reduce((a,s)=>a+s.vpDone,0)},
      {l:'Как мы работаем',v:st.reduce((a,s)=>a+s.hwDone,0)},
      {l:'Призыв к действию',v:st.reduce((a,s)=>a+s.ctaDone,0)},
      {l:'КП отправлено',v:st.reduce((a,s)=>a+s.cpDone,0)},
      {l:'Счёт отправлен',v:st.reduce((a,s)=>a+s.invDone,0)},
      {l:'Презентация (файл)',v:st.reduce((a,s)=>a+s.presDone,0)},
      {l:'Отработка возражений',v:st.reduce((a,s)=>a+s.objDone,0)},
    ];
    for(const it of items){
      const pct=totalDeals?Math.round(it.v/totalDeals*100):0;
      const col=pct>=60?'#34d399':pct>=30?'#fbbf24':'#f87171';
      h+='<tr><td style="font-weight:600">'+it.l+'</td><td>'+it.v+'/'+totalDeals+'</td>';
      h+='<td style="color:'+col+';font-weight:700">'+pct+'%</td>';
      h+='<td style="width:200px"><div class="bar-bg"><div class="bar-f" style="width:'+pct+'%;background:'+col+'"></div></div></td></tr>';
    }
    h+='</table></div>';

    // Звонок vs переписка
    const totalCall=st.reduce((a,s)=>a+s.callSources,0);
    const totalText=st.reduce((a,s)=>a+s.textSources,0);
    const totalSrc=totalCall+totalText||1;
    h+='<div style="margin-top:12px;display:flex;gap:20px;align-items:center;flex-wrap:wrap">';
    h+='<div style="text-align:center"><div style="font-size:24px;font-weight:800;color:#34d399">'+totalCall+'</div><div style="font-size:10px;color:#6b7280">По телефону (3б)</div></div>';
    h+='<div style="text-align:center"><div style="font-size:24px;font-weight:800;color:#fbbf24">'+totalText+'</div><div style="font-size:10px;color:#6b7280">Переписка (1.5б)</div></div>';
    h+='<div style="flex:1;min-width:200px"><div class="bar-bg" style="height:20px;display:flex;overflow:hidden">';
    h+='<div style="width:'+Math.round(totalCall/totalSrc*100)+'%;background:#34d399"></div>';
    h+='<div style="width:'+Math.round(totalText/totalSrc*100)+'%;background:#fbbf24"></div>';
    h+='</div></div></div></div>';
  }

  // === ВОРОНКА СДЕЛОК ===
  const sc=D.statusCounts||{};
  const order=['Новая','Обработка','В работе','Коммерческое предложение','Вывезли/Нашли поставщика','Дожим','Договор и оплата','Выполнение Работы','Сделанная','Сделка завершена'];
  const allSt=[...order,...Object.keys(sc).filter(k=>!order.includes(k))].filter(k=>sc[k]);
  if(allSt.length){
    const maxSt=Math.max(...Object.values(sc),1);
    h+='<div class="sec"><h3>📊 Воронка — текущее распределение ('+D.dealCards.length+' сделок)</h3>';
    for(const s of allSt){
      const n=sc[s]||0;
      const pct=Math.round(n/maxSt*100);
      const good=['Договор и оплата','Выполнение Работы','Сделка завершена','Сделанная'].includes(s);
      h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">';
      h+='<span style="width:180px;font-size:11px;color:#6b7280;text-align:right;flex-shrink:0">'+s+'</span>';
      h+='<div class="bar-bg" style="flex:1;height:18px"><div class="bar-f" style="width:'+pct+'%;background:'+(good?'#34d399':'#60a5fa')+'"></div></div>';
      h+='<span style="width:30px;font-size:12px;font-weight:700;text-align:right">'+n+'</span>';
      h+='</div>';
    }
    h+='</div>';
  }

  document.getElementById('out').innerHTML=h;
}

function toggleCard(id){
  const hdr=document.getElementById('chdr_'+id);
  const body=document.getElementById('cbody_'+id);
  if(!body)return;
  const isOpen=body.classList.contains('open');
  if(isOpen){
    body.classList.remove('open');
    if(hdr)hdr.classList.remove('open');
    cardOpenState[id]=false;
  }
  else{
    body.classList.add('open');
    if(hdr)hdr.classList.add('open');
    cardOpenState[id]=true;
  }
}
function toggleAllCards(){
  const bodies=document.querySelectorAll('.card-body, .deal-card-body');
  const anyOpen=[...bodies].some(b=>b.classList.contains('open'));
  bodies.forEach(b=>{
    const id=b.id.replace('cbody_','');
    const hdr=document.getElementById('chdr_'+id);
    if(anyOpen){
      b.classList.remove('open');
      if(hdr)hdr.classList.remove('open');
      cardOpenState[id]=false;
    }
    else{
      b.classList.add('open');
      if(hdr)hdr.classList.add('open');
      cardOpenState[id]=true;
    }
  });
  const btn=document.getElementById('toggleAllBtn');
  if(btn)btn.textContent=anyOpen?'📂 Развернуть всё':'📁 Свернуть всё';
}
function toggleTr(id){const el=document.getElementById(id);if(el)el.style.display=el.style.display==='none'?'block':'none'}
function toggleColl(id){
  const hdr=document.getElementById('hdr_'+id);
  const body=document.getElementById('body_'+id);
  if(!body)return;
  const isOpen=body.classList.contains('open');
  if(isOpen){body.classList.remove('open');hdr.classList.remove('open')}
  else{body.classList.add('open');hdr.classList.add('open')}
}
// ============ ВКЛАДКА ВХОДЯЩИЕ ============
