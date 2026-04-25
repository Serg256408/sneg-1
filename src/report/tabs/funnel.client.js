function renderFunnel(){
  const funnelSource=(D.funnelCards&&D.funnelCards.length)?D.funnelCards:D.dealCards;
  const funnel={};funnelSource.forEach(d=>{funnel[d.status]=(funnel[d.status]||0)+1});
  const order=['Новая','Обработка','В работе','Коммерческое предложение','Вывезли/Нашли поставщика','Дожим','Договор и оплата','Выполнение Работы','Сделанная','Сделка завершена'];
  const max=Math.max(...Object.values(funnel),1);

  let h='<div class="sec"><h3>📊 Воронка ('+funnelSource.length+')</h3>';
  [...order,...Object.keys(funnel).filter(k=>!order.includes(k))].forEach(s=>{
    const n=funnel[s]||0;if(!n)return;
    const pct=Math.round(n/max*100);const good=['Договор и оплата','Выполнение Работы','Сделка завершена','Сделанная'].includes(s);
    h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px"><span style="width:180px;font-size:12px;color:#6b7280;text-align:right;flex-shrink:0">'+s+'</span><div class="bar-bg" style="flex:1;height:18px"><div class="bar-f" style="width:'+pct+'%;background:'+(good?'#34d399':'#60a5fa')+'"></div></div><span style="width:30px;font-size:13px;font-weight:700;text-align:right">'+n+'</span></div>';
  });
  h+='</div>';

  // Изменения воронки
  if(D.funnelChanges.length){
    h+='<div class="sec"><h3>🔄 Изменения с прошлого запуска ('+D.funnelChanges.length+')</h3>';
    h+='<table><tr><th>Сделка</th><th>Контрагент</th><th>Было</th><th></th><th>Стало</th></tr>';
    for(const c of D.funnelChanges){
      const cls=c.direction==='forward'?'change-fwd':'change-bwd';
      const arrow=c.direction==='forward'?'→ ✅':'→ ⬅️';
      h+='<tr><td style="font-size:11px">#'+c.dealId+' '+esc(c.dealName.substring(0,40))+'</td>';
      h+='<td style="font-size:11px;color:#6b7280">'+esc(c.counterparty.substring(0,25))+'</td>';
      h+='<td><span class="bg bg-y">'+esc(c.from)+'</span></td>';
      h+='<td class="'+cls+'" style="font-size:14px">'+arrow+'</td>';
      h+='<td><span class="bg '+(c.direction==='forward'?'bg-g':'bg-r')+'">'+esc(c.to)+'</span></td></tr>';
    }
    h+='</table></div>';
  }

  document.getElementById('out').innerHTML=h;
}

// === СТАТИСТИКА ===
let statFrom='',statTo='';
function parseDMY(d){const p=d.split('-');return new Date(p[2]+'-'+p[1]+'-'+p[0])}
function toISO(d){const p=d.split('-');return p[2]+'-'+p[1]+'-'+p[0]}
function setStatPeriod(days){
  const now=new Date();
  const from=new Date(now);from.setDate(from.getDate()-days);
  statTo=now.toISOString().split('T')[0];
  statFrom=from.toISOString().split('T')[0];
  document.getElementById('sf').value=statFrom;
  document.getElementById('st').value=statTo;
  renderStats();
}
function setStatRange(fromISO,toISO){
  statFrom=fromISO;statTo=toISO;
  document.getElementById('sf').value=statFrom;
  document.getElementById('st').value=statTo;
  renderStats();
}
function getWeekRange(year,month,weekNum){
  const first=new Date(year,month,1);
  const start=new Date(first);start.setDate(1+(weekNum-1)*7);
  if(start.getMonth()!==month&&weekNum>1)return null;
  const end=new Date(start);end.setDate(end.getDate()+6);
  const lastDay=new Date(year,month+1,0);
  if(end>lastDay)end.setTime(lastDay.getTime());
  if(start>lastDay)return null;
  return{from:start.toISOString().split('T')[0],to:end.toISOString().split('T')[0]};
}
function getMonthRange(year,month){
  const from=new Date(year,month,1).toISOString().split('T')[0];
  const to=new Date(year,month+1,0).toISOString().split('T')[0];
  return{from,to};
}
const MONTH_NAMES=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const MONTH_SHORT=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
var statSelectedMonth=null; // {year,month} текущий выбранный месяц для недель
function buildPeriodButtons(){
  const now=new Date();
  const y=now.getFullYear(),m=now.getMonth();
  const Q=String.fromCharCode(39);
  if(!statSelectedMonth)statSelectedMonth={year:y,month:m};
  const sm=statSelectedMonth;
  let h='';
  // Выпадающий список месяцев
  h+='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
  h+='<select id="statMonthSelect" onchange="onStatMonthChange(this.value)" style="padding:4px 8px;border-radius:6px;border:1px solid #d1d5db;font-size:12px;font-weight:600;cursor:pointer">';
  for(let i=0;i<12;i++){
    const pm=new Date(y,m-i,1);
    const val=pm.getFullYear()+'-'+pm.getMonth();
    const sel=(pm.getFullYear()===sm.year&&pm.getMonth()===sm.month)?' selected':'';
    h+='<option value="'+val+'"'+sel+'>'+MONTH_NAMES[pm.getMonth()]+' '+pm.getFullYear()+'</option>';
  }
  h+='</select>';
  // Недели выбранного месяца
  for(let w=1;w<=5;w++){
    const wr=getWeekRange(sm.year,sm.month,w);
    if(!wr)break;
    const isActive=(statFrom===wr.from&&statTo===wr.to);
    h+='<button class="pbtn'+(isActive?' on':'')+'" onclick="setStatRange('+Q+wr.from+Q+','+Q+wr.to+Q+')">Нед '+w+'</button>';
  }
  // Месяц целиком
  const mr=getMonthRange(sm.year,sm.month);
  const isCurMonth=(statFrom===mr.from&&statTo===mr.to);
  h+='<button class="pbtn'+(isCurMonth?' on':'')+'" onclick="setStatRange('+Q+mr.from+Q+','+Q+mr.to+Q+')">Месяц</button>';
  h+='<span style="margin:0 4px;color:#d1d5db">|</span>';
  // Всё
  const isAll=(!statFrom&&!statTo);
  h+='<button class="pbtn'+(isAll?' on':'')+'" onclick="statFrom='+Q+Q+';statTo='+Q+Q+';document.getElementById('+Q+'sf'+Q+').value='+Q+Q+';document.getElementById('+Q+'st'+Q+').value='+Q+Q+';renderStats()">Всё</button>';
  h+='</div>';
  return h;
}
function onStatMonthChange(val){
  const parts=val.split('-');
  statSelectedMonth={year:parseInt(parts[0]),month:parseInt(parts[1])};
  renderStats();
}
function statDateChanged(){
  statFrom=document.getElementById('sf').value;
  statTo=document.getElementById('st').value;
  renderStats();
}
function inStatRange(dateStr){
  if(!statFrom&&!statTo)return true;
  const d=parseDMY(dateStr);
  if(statFrom&&d<new Date(statFrom))return false;
  if(statTo&&d>new Date(statTo+'T23:59:59'))return false;
  return true;
}
