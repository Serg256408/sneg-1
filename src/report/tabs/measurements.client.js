let measurePreset='30d';
let measureFrom='';
let measureTo='';
let measureSearch='';
let measureManager='all';
let measureMeasurer='all';
let measureOutcome='all';
let measureOnlyScheduled=false;
const measureOpenState={};

function measurementEsc(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
}
function measurementFmt(n){
  return Number(n||0).toLocaleString('ru-RU');
}
function measurementReportDate(){
  return D.reportDate||new Date().toLocaleDateString('ru-RU').split('.').join('-');
}
function measurementDateToInput(dateStr){
  if(!dateStr)return '';
  const m1=String(dateStr).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if(m1)return m1[3]+'-'+m1[2]+'-'+m1[1];
  const m2=String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m2)return m2[1]+'-'+m2[2]+'-'+m2[3];
  return '';
}
function measurementInputToDmy(value){
  if(!value)return '';
  const m=String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m?m[3]+'-'+m[2]+'-'+m[1]:'';
}
function measurementDateObj(dateStr){
  if(!dateStr)return null;
  const m1=String(dateStr).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if(m1)return new Date(m1[3]+'-'+m1[2]+'-'+m1[1]+'T00:00:00');
  const m2=String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m2)return new Date(m2[1]+'-'+m2[2]+'-'+m2[3]+'T00:00:00');
  return null;
}
function measurementDateInRange(dateStr){
  if(!dateStr)return false;
  const d=measurementDateObj(dateStr);
  if(!d||isNaN(d))return false;
  if(measureFrom){
    const from=measurementDateObj(measurementInputToDmy(measureFrom));
    if(from&&d<from)return false;
  }
  if(measureTo){
    const to=measurementDateObj(measurementInputToDmy(measureTo));
    if(to&&d>to)return false;
  }
  return true;
}
function measurementRelevantToRange(item){
  if(!measureFrom&&!measureTo)return true;
  return [
    item.measurementCreatedAt,
    item.scheduledAt,
    item.progressedDate,
    item.contractDate,
    item.workDate,
    item.lastRelevantActivityAt
  ].some(measurementDateInRange);
}
function setMeasurementPreset(preset){
  measurePreset=preset;
  const base=measurementDateObj(measurementReportDate())||new Date();
  const from=new Date(base);
  if(preset==='today'){
    measureFrom=measurementDateToInput(measurementReportDate());
    measureTo=measurementDateToInput(measurementReportDate());
  }else if(preset==='7d'){
    from.setDate(base.getDate()-6);
    measureFrom=measurementDateToInput(formatMeasurementDate(from));
    measureTo=measurementDateToInput(formatMeasurementDate(base));
  }else if(preset==='30d'){
    from.setDate(base.getDate()-29);
    measureFrom=measurementDateToInput(formatMeasurementDate(from));
    measureTo=measurementDateToInput(formatMeasurementDate(base));
  }else if(preset==='ytd'){
    const yearStart=new Date(base.getFullYear(),0,1);
    measureFrom=measurementDateToInput(formatMeasurementDate(yearStart));
    measureTo=measurementDateToInput(formatMeasurementDate(base));
  }else{
    measureFrom='';
    measureTo='';
  }
  renderMeasurements();
}
function onMeasurementDateChange(){
  measurePreset='custom';
  measureFrom=document.getElementById('measureFrom').value;
  measureTo=document.getElementById('measureTo').value;
  renderMeasurements();
}
function formatMeasurementDate(d){
  if(!d||isNaN(d))return '';
  return String(d.getDate()).padStart(2,'0')+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+d.getFullYear();
}
function resetMeasurementFilters(){
  measureSearch='';
  measureManager='all';
  measureMeasurer='all';
  measureOutcome='all';
  measureOnlyScheduled=false;
  setMeasurementPreset('30d');
}
function measurementOutcomeMeta(outcome){
  if(outcome==='to_work')return {label:'В работу',color:'#059669',bg:'rgba(5,150,105,.12)'};
  if(outcome==='to_contract')return {label:'В договор',color:'#16a34a',bg:'rgba(22,163,74,.12)'};
  if(outcome==='progressed')return {label:'Продвинуто',color:'#2563eb',bg:'rgba(37,99,235,.12)'};
  if(outcome==='stalled')return {label:'Зависло',color:'#b45309',bg:'rgba(245,158,11,.16)'};
  if(outcome==='closed_lost')return {label:'Закрыто',color:'#dc2626',bg:'rgba(220,38,38,.12)'};
  return {label:'Неясно',color:'#6b7280',bg:'rgba(107,114,128,.12)'};
}
function measurementMatchesQuery(item){
  if(!measureSearch)return true;
  const q=measureSearch.toLowerCase();
  const hay=[
    item.dealId,
    item.dealName,
    item.counterparty,
    item.measurer,
    item.currentDealStatus,
    item.latestResultText
  ].join(' ').toLowerCase();
  return hay.includes(q);
}
function measurementMatchesFilters(item){
  if(!measurementDateInRange(item.measurementCreatedAt))return false;
  if(!measurementMatchesQuery(item))return false;
  if(measureManager!=='all'&&(item.manager||'Не указан')!==measureManager)return false;
  if(measureMeasurer!=='all'&&(item.measurer||'Не указан')!==measureMeasurer)return false;
  if(measureOutcome!=='all'&&item.outcome!==measureOutcome)return false;
  if(measureOnlyScheduled&&!item.scheduledAt)return false;
  return true;
}
function measurementDaysSince(dateStr){
  const base=measurementDateObj(measurementReportDate());
  const d=measurementDateObj(dateStr);
  if(!base||!d)return '—';
  return Math.max(0,Math.floor((base.getTime()-d.getTime())/86400000));
}
function measurementEventCounts(items){
  const counts={
    entered:0,
    newInMeasurement:0,
    scheduled:0,
    progressed:0,
    toContract:0,
    toWork:0,
    stalled:0
  };
  items.forEach(function(item){
    if(measurementDateInRange(item.measurementCreatedAt)){
      counts.entered++;
      if(measurementDateInRange(item.dealCreatedAt))counts.newInMeasurement++;
    }
    if(measurementDateInRange(item.scheduledAt))counts.scheduled++;
    if(measurementDateInRange(item.progressedDate))counts.progressed++;
    if(measurementDateInRange(item.contractDate))counts.toContract++;
    if(measurementDateInRange(item.workDate))counts.toWork++;
    if(item.outcome==='stalled')counts.stalled++;
  });
  counts.contractRate=counts.entered?Math.round(counts.toContract/counts.entered*100):0;
  counts.workRate=counts.entered?Math.round(counts.toWork/counts.entered*100):0;
  return counts;
}
function measurementDailyRows(items){
  const byDate={};
  const createdKeys={};
  function ensure(date){
    if(!date)return null;
    if(!byDate[date])byDate[date]={date:date,dealsCreated:0,enteredMeasurement:0,scheduledMeasurements:0,progressed:0,toContract:0,toWork:0};
    return byDate[date];
  }
  items.forEach(function(item){
    if(measurementDateInRange(item.dealCreatedAt)){
      var createdKey=String(item.dealId)+'_'+String(item.dealCreatedAt||'');
      if(!createdKeys[createdKey]){
        createdKeys[createdKey]=true;
        ensure(item.dealCreatedAt).dealsCreated++;
      }
    }
    if(measurementDateInRange(item.measurementCreatedAt)){
      ensure(item.measurementCreatedAt).enteredMeasurement++;
    }
    if(measurementDateInRange(item.scheduledAt)){
      ensure(item.scheduledAt).scheduledMeasurements++;
    }
    if(measurementDateInRange(item.progressedDate)){
      ensure(item.progressedDate).progressed++;
    }
    if(measurementDateInRange(item.contractDate)){
      ensure(item.contractDate).toContract++;
    }
    if(measurementDateInRange(item.workDate)){
      ensure(item.workDate).toWork++;
    }
  });
  return Object.keys(byDate)
    .sort(function(a,b){return dateStamp(a,'00:00')-dateStamp(b,'00:00');})
    .map(function(date){return byDate[date];});
}
function measurementByMeasurer(items){
  const out={};
  items.forEach(function(item){
    var key=item.measurer||'Не указан';
    if(!out[key])out[key]={name:key,total:0,toContract:0,toWork:0,scheduled:0,sum:0};
    out[key].total++;
    out[key].sum+=(item.dealSum||0);
    if(item.scheduledAt&&measurementDateInRange(item.scheduledAt))out[key].scheduled++;
    if(item.contractDate&&measurementDateInRange(item.contractDate))out[key].toContract++;
    if(item.workDate&&measurementDateInRange(item.workDate))out[key].toWork++;
  });
  return Object.values(out).sort(function(a,b){return (b.total-a.total)||a.name.localeCompare(b.name,'ru');});
}
function toggleMeasurementRow(id){
  measureOpenState[id]=!measureOpenState[id];
  renderMeasurements();
}
function renderMeasurements(){
  const all=(D.measurements||[]);
  if(!measureFrom&&!measureTo&&measurePreset==='30d'){
    setMeasurementPreset('30d');
    return;
  }
  const filtered=all.filter(measurementMatchesFilters).sort(function(a,b){
    return dateStamp(b.measurementCreatedAt,'23:59')-dateStamp(a.measurementCreatedAt,'00:00');
  });
  const counts=measurementEventCounts(filtered);
  const daily=measurementDailyRows(filtered);
  const measurers=measurementByMeasurer(filtered);
  const uniqueManagers=[...new Set((D.measurementsSummary&&D.measurementsSummary.managerNames||all.map(function(item){return item.manager||'Не указан';})).filter(Boolean))].sort(function(a,b){return a.localeCompare(b,'ru');});
  const uniqueMeasurers=[...new Set((D.measurementsSummary&&D.measurementsSummary.measurers||all.map(function(item){return item.measurer||'Не указан';})).filter(Boolean))].sort(function(a,b){return a.localeCompare(b,'ru');});

  let h='';
  h+='<div class="sec" style="padding:12px 14px">';
  h+='<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">';
  h+='<div><h3 style="margin-bottom:4px">📐 Замеры</h3><div style="font-size:12px;color:#6b7280">Оперативный срез по замерам, назначению и конверсии в договор/работу</div></div>';
  h+='<div style="font-size:11px;color:#6b7280">По умолчанию: последние 30 дней до '+measurementEsc(measurementReportDate())+'</div>';
  h+='</div>';
  h+='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px">';
  [['today','Сегодня'],['7d','7 дней'],['30d','30 дней'],['ytd','YTD'],['all','Всё']].forEach(function(p){
    h+='<button class="pbtn'+(measurePreset===p[0]?' on':'')+'" onclick="setMeasurementPreset(\''+p[0]+'\')">'+p[1]+'</button>';
  });
  h+='<span style="margin-left:8px;font-size:11px;color:#6b7280">с</span>';
  h+='<input id="measureFrom" type="date" value="'+(measureFrom||'')+'" onchange="onMeasurementDateChange()" style="background:#fff;border:1px solid rgba(0,0,0,.1);color:#1a1a2e;padding:4px 8px;border-radius:6px;font-size:11px;font-family:inherit">';
  h+='<span style="font-size:11px;color:#6b7280">по</span>';
  h+='<input id="measureTo" type="date" value="'+(measureTo||'')+'" onchange="onMeasurementDateChange()" style="background:#fff;border:1px solid rgba(0,0,0,.1);color:#1a1a2e;padding:4px 8px;border-radius:6px;font-size:11px;font-family:inherit">';
  h+='</div>';
  h+='<div style="display:grid;grid-template-columns:minmax(220px,2fr) repeat(4,minmax(150px,1fr)) 180px;gap:10px;margin-top:12px">';
  h+='<input value="'+measurementEsc(measureSearch)+'" oninput="measureSearch=this.value;renderMeasurements()" placeholder="Поиск по сделке, ID, клиенту, результату" style="padding:10px 12px;border-radius:10px;border:1px solid #d1d5db;background:#fff;color:#1a1a2e;font-size:13px;font-family:inherit">';
  h+='<select onchange="measureManager=this.value;renderMeasurements()" style="padding:10px 12px;border-radius:10px;border:1px solid #d1d5db;background:#fff;color:#1a1a2e;font-size:13px;font-family:inherit">';
  h+='<option value="all">Все менеджеры</option>';
  uniqueManagers.forEach(function(name){
    h+='<option value="'+measurementEsc(name)+'"'+(measureManager===name?' selected':'')+'>'+measurementEsc(name)+'</option>';
  });
  h+='</select>';
  h+='<select onchange="measureMeasurer=this.value;renderMeasurements()" style="padding:10px 12px;border-radius:10px;border:1px solid #d1d5db;background:#fff;color:#1a1a2e;font-size:13px;font-family:inherit">';
  h+='<option value="all">Все замерщики</option>';
  uniqueMeasurers.forEach(function(name){
    h+='<option value="'+measurementEsc(name)+'"'+(measureMeasurer===name?' selected':'')+'>'+measurementEsc(name)+'</option>';
  });
  h+='</select>';
  h+='<select onchange="measureOutcome=this.value;renderMeasurements()" style="padding:10px 12px;border-radius:10px;border:1px solid #d1d5db;background:#fff;color:#1a1a2e;font-size:13px;font-family:inherit">';
  h+='<option value="all">Все исходы</option>';
  [['to_work','В работу'],['to_contract','В договор'],['progressed','Продвинуто'],['stalled','Зависло'],['closed_lost','Закрыто'],['unknown','Неясно']].forEach(function(item){
    h+='<option value="'+item[0]+'"'+(measureOutcome===item[0]?' selected':'')+'>'+item[1]+'</option>';
  });
  h+='</select>';
  h+='<label style="display:flex;align-items:center;gap:8px;padding:0 4px;font-size:12px;color:#374151"><input type="checkbox" '+(measureOnlyScheduled?'checked':'')+' onchange="measureOnlyScheduled=this.checked;renderMeasurements()"> Только с назначением</label>';
  h+='<button class="toggle-btn" onclick="resetMeasurementFilters()" style="padding:9px 12px;font-size:12px">Сбросить</button>';
  h+='</div></div>';

  if(!all.length){
    h+='<div class="no-data">По замерам пока нет данных. После следующей полной генерации вкладка заполнится автоматически.</div>';
    document.getElementById('out').innerHTML=h;
    return;
  }

  h+='<div class="sec"><h3>Сводка по периоду</h3>';
  h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">';
  [
    {l:'В замер',v:counts.entered,c:'#2563eb'},
    {l:'Новые в замере',v:counts.newInMeasurement,c:'#7c3aed'},
    {l:'Назначено',v:counts.scheduled,c:'#0f766e'},
    {l:'Продвинуто',v:counts.progressed,c:'#2563eb'},
    {l:'В договор',v:counts.toContract,c:'#16a34a'},
    {l:'В работу',v:counts.toWork,c:'#059669'},
    {l:'Конв. в договор',v:counts.contractRate+'%',c:'#b45309'},
    {l:'Конв. в работу',v:counts.workRate+'%',c:'#b45309'},
    {l:'Зависло',v:counts.stalled,c:'#dc2626'}
  ].forEach(function(item){
    h+='<div class="met"><div class="met-l">'+item.l+'</div><div class="met-v" style="color:'+item.c+'">'+item.v+'</div></div>';
  });
  h+='</div></div>';

  h+='<div class="grid2">';
  h+='<div class="sec"><h3>Ежедневная динамика</h3><div style="overflow-x:auto"><table>';
  h+='<tr><th>Дата</th><th style="text-align:center">Сделок</th><th style="text-align:center">В замер</th><th style="text-align:center">Назначено</th><th style="text-align:center">Продвинуто</th><th style="text-align:center">В договор</th><th style="text-align:center">В работу</th></tr>';
  daily.slice(-31).forEach(function(day){
    h+='<tr>';
    h+='<td>'+measurementEsc(day.date)+'</td>';
    h+='<td style="text-align:center">'+(day.dealsCreated||0)+'</td>';
    h+='<td style="text-align:center;font-weight:700;color:#2563eb">'+(day.enteredMeasurement||0)+'</td>';
    h+='<td style="text-align:center;color:#0f766e">'+(day.scheduledMeasurements||0)+'</td>';
    h+='<td style="text-align:center;color:#2563eb">'+(day.progressed||0)+'</td>';
    h+='<td style="text-align:center;color:#16a34a">'+(day.toContract||0)+'</td>';
    h+='<td style="text-align:center;color:#059669">'+(day.toWork||0)+'</td>';
    h+='</tr>';
  });
  h+='</table></div></div>';

  h+='<div class="sec"><h3>По замерщикам</h3><div style="overflow-x:auto"><table>';
  h+='<tr><th>Замерщик</th><th style="text-align:center">Замеров</th><th style="text-align:center">Назначено</th><th style="text-align:center">В договор</th><th style="text-align:center">В работу</th><th style="text-align:right">Сумма</th></tr>';
  if(!measurers.length){
    h+='<tr><td colspan="6" style="text-align:center;color:#9ca3af">Нет данных по фильтрам</td></tr>';
  }else{
    measurers.forEach(function(item){
      h+='<tr>';
      h+='<td style="font-weight:600">'+measurementEsc(item.name)+'</td>';
      h+='<td style="text-align:center">'+item.total+'</td>';
      h+='<td style="text-align:center">'+item.scheduled+'</td>';
      h+='<td style="text-align:center;color:#16a34a">'+item.toContract+'</td>';
      h+='<td style="text-align:center;color:#059669">'+item.toWork+'</td>';
      h+='<td style="text-align:right;color:#b45309">'+(item.sum?measurementFmt(item.sum)+' ₽':'—')+'</td>';
      h+='</tr>';
    });
  }
  h+='</table></div></div>';
  h+='</div>';

  h+='<div class="sec"><h3>Детали по замерам ('+filtered.length+')</h3><div class="deal-table-wrap"><table>';
  h+='<tr><th>Сделка</th><th>Менеджер</th><th>Замерщик</th><th>Дата сделки</th><th>Дата замера</th><th>Дата назначения</th><th>Текущий статус</th><th>Результат</th><th style="text-align:right">Сумма</th><th style="text-align:center">Дней</th></tr>';
  if(!filtered.length){
    h+='<tr><td colspan="10" style="text-align:center;color:#9ca3af;padding:18px">Нет замеров по текущим фильтрам</td></tr>';
  }else{
    filtered.forEach(function(item){
      var meta=measurementOutcomeMeta(item.outcome);
      var rowId='measure_'+String(item.id).replace(/[^a-zA-Z0-9_-]/g,'_');
      h+='<tr style="cursor:pointer" onclick="toggleMeasurementRow(\''+rowId+'\')">';
      h+='<td><div style="font-weight:700;color:#1a1a2e">#'+item.dealId+'</div><div style="font-size:11px;color:#6b7280;max-width:260px">'+measurementEsc(item.dealName||'')+'</div></td>';
      h+='<td>'+measurementEsc(item.manager||D.manager||'')+'</td>';
      h+='<td>'+measurementEsc(item.measurer||'Не указан')+'</td>';
      h+='<td>'+measurementEsc(item.dealCreatedAt||'—')+'</td>';
      h+='<td style="font-weight:700;color:#2563eb">'+measurementEsc(item.measurementCreatedAt||'—')+'</td>';
      h+='<td>'+measurementEsc(item.scheduledAt||'—')+'</td>';
      h+='<td><span class="bg bg-b">'+measurementEsc(item.currentDealStatus||'—')+'</span></td>';
      h+='<td><div style="display:flex;flex-direction:column;gap:4px"><span style="display:inline-block;padding:2px 8px;border-radius:999px;background:'+meta.bg+';color:'+meta.color+';font-size:11px;font-weight:700">'+meta.label+'</span><span style="font-size:11px;color:#6b7280;max-width:260px">'+measurementEsc(item.latestResultText||'—')+'</span></div></td>';
      h+='<td style="text-align:right;color:#b45309;font-weight:700">'+(item.dealSum?measurementFmt(item.dealSum)+' ₽':'—')+'</td>';
      h+='<td style="text-align:center">'+measurementDaysSince(item.measurementCreatedAt)+'</td>';
      h+='</tr>';
      if(measureOpenState[rowId]){
        h+='<tr><td colspan="10" style="background:#fafafa;padding:14px 18px">';
        h+='<div style="display:grid;grid-template-columns:minmax(220px,1fr) 2fr;gap:14px">';
        h+='<div>';
        h+='<div class="deal-caption">Контрагент</div><div style="font-size:13px;color:#1a1a2e;margin-top:4px">'+measurementEsc(item.counterparty||'—')+'</div>';
        h+='<div class="deal-caption" style="margin-top:10px">Последняя активность</div><div style="font-size:13px;color:#1a1a2e;margin-top:4px">'+measurementEsc(item.lastRelevantActivityAt||'—')+'</div>';
        h+='</div>';
        h+='<div>';
        h+='<div class="deal-caption" style="margin-bottom:6px">Таймлайн</div>';
        h+=(item.timeline||[]).map(function(step){
          return '<div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid rgba(0,0,0,.05)"><div style="min-width:82px;font-size:11px;color:#6b7280">'+measurementEsc(step.date||'—')+(step.time?' '+measurementEsc(step.time):'')+'</div><div style="font-size:13px;color:#1a1a2e">'+measurementEsc(step.label||'—')+'</div></div>';
        }).join('');
        h+='</div></div>';
        h+='</td></tr>';
      }
    });
  }
  h+='</table></div></div>';

  document.getElementById('out').innerHTML=h;
}
