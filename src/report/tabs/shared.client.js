function navTo(alias){
  var loc=(window.location.pathname||'').replace(/\\/g,'/').toLowerCase();
  var hash=alias==='index'?'':(window.location.hash||'');
  var target='';

  if(loc.indexOf('/deploy/')>=0){
    target=alias==='index'?'../index.html':'../'+alias+'/index.html';
  }else if(loc.indexOf('/reports/')>=0){
    target=alias==='index'?'../deploy/index.html':'../deploy/'+alias+'/index.html';
  }else{
    target=alias==='index'?'deploy/index.html':'deploy/'+alias+'/index.html';
  }

  window.location.href=target+hash;
  return false;
}

function buildRecommendationText(taskId){
  var da=(D.dailyDealActivity||[]).find(function(x){return x.deal.id===taskId});
  // Если не нашли в dailyDealActivity — ищем в multiDayActivity для выбранной даты
  if(!da||!da.aiAssessment){
    var mda=D.multiDayActivity&&D.multiDayActivity[selectedDate];
    if(mda) da=mda.find(function(x){return x.deal.id===taskId});
  }
  if(!da||!da.aiAssessment)return null;
  var aa=da.aiAssessment;
  var ss=aa.salaryScore||{};
  var t='🤖 ИИ-оценка сделки за '+(selectedDate||D.reportDate)+'\n\n';
  if(aa.todaySummary) t+='📅 Итог дня: '+aa.todaySummary+'\n\n';
  if(aa.overallVerdict) t+='📊 Вердикт: '+aa.overallVerdict+'\n\n';
  t+='📋 Скрипт продаж:\n';
  var vp=aa.verbalPresentation;
  if(vp) t+='  Устная презентация: '+(vp.overall?'✅ ('+vp.source+')':'❌')+'\n';
  var hw=aa.howWeWork;
  if(hw) t+='  Как мы работаем: '+(hw.done?'✅ ('+hw.source+')':'❌')+'\n';
  if(aa.writtenPresentation) t+='  Презентация (файл): '+(aa.writtenPresentation.done?'✅':'❌')+'\n';
  if(aa.cp) t+='  КП: '+(aa.cp.done?'✅':'❌')+(aa.cp.note?' — '+aa.cp.note:'')+'\n';
  if(aa.invoice) t+='  Счёт: '+(aa.invoice.done?'✅':'❌')+(aa.invoice.note?' — '+aa.invoice.note:'')+'\n';
  if(aa.callToAction) t+='  Призыв к действию: '+(aa.callToAction.done?'✅':'❌')+'\n';
  if(aa.objectionHandling) t+='  Отработка возражений: '+(aa.objectionHandling.done?'✅':'❌')+'\n';
  t+='\n💰 Баллы ЗП: '+ss.total+'/'+ss.max+'\n';
  var miss=aa.missing||[];
  if(miss.length){t+='\n❗ Не выполнено:\n';miss.forEach(function(m){t+='  • '+m+'\n'});}
  var recs=aa.recommendations||[];
  if(recs.length){t+='\n💡 Рекомендации:\n';recs.forEach(function(r){t+='  • '+r+'\n'});}
  if(aa.nextStep){t+='\n▶ Следующий шаг: '+aa.nextStep+'\n';}
  return t;
}
async function copyRecommendation(taskId){
  var text=buildRecommendationText(taskId);
  if(!text)return alert('Нет ИИ-оценки для этой сделки');
  var btn=document.getElementById('pf_btn_'+taskId);
  try{
    await navigator.clipboard.writeText(text);
    if(btn){btn.textContent='✅ Скопировано!';btn.style.background='rgba(52,211,153,.15)';btn.style.color='#34d399';}
    setTimeout(function(){if(btn){btn.textContent='📋 Копировать';btn.style.background='';btn.style.color='';}},3000);
  }catch(e){
    var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
    if(btn){btn.textContent='✅ Скопировано!';btn.style.background='rgba(52,211,153,.15)';btn.style.color='#34d399';}
    setTimeout(function(){if(btn){btn.textContent='📋 Копировать';btn.style.background='';btn.style.color='';}},3000);
  }
}
async function sendToPlanfix(taskId){
  var text=buildRecommendationText(taskId);
  if(!text)return alert('Нет ИИ-оценки для этой сделки');
  if(!confirm('Отправить ИИ-рекомендации в Planfix в задачу #'+taskId+'?'))return;
  var btn=document.getElementById('pf_send_'+taskId);
  if(btn){btn.disabled=true;btn.textContent='Отправка...';}
  var h=text.replace(/\n/g,'<br>').replace(/  /g,'&nbsp;&nbsp;');
  try{
    var resp=await fetch(PF_URL+'/task/'+taskId+'/comments/',{
      method:'POST',
      headers:{'Authorization':'Bearer '+PF_TOKEN,'Content-Type':'application/json'},
      body:JSON.stringify({description:h})
    });
    if(!resp.ok){var t=await resp.text();throw new Error(t);}
    if(btn){btn.textContent='✅ Отправлено!';btn.style.background='rgba(52,211,153,.15)';btn.style.color='#34d399';}
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='📤 Planfix';}
    alert('Ошибка: '+e.message+'\n\nТокен не имеет прав на создание комментариев.\nОбновите права токена в Planfix: Управление аккаунтом → API → Токен → Разрешения → Комментарии задач: Добавление.\n\nПока можно скопировать текст кнопкой 📋.');
  }
}
let selectedDate=D.reportDate||'';
function getTabName(){return 'День '+selectedDate}
const TABS_BASE=['','Все сделки','Качество','Ежедневные','Воронка','📊 Статистика','👔 Руководитель','📨 Входящие'];
let period=7,tab=0;
let currentCards=[];
let dealSearch='';
let dealStatus='all';
let dealFocus='all';
let dealSort='activity';
let dealFrom='';
let dealTo='';
const cardOpenState={};
const TAB_KEYS=['day','deals','quality','daily','funnel','stats','measurements','incoming','manager'];
const TAB_LABELS=function(){
  return [
    getTabName(),
    'Все сделки',
    'Качество',
    'Ежедневные',
    'Воронка',
    '📉 Статистика',
    '📐 Замеры',
    '📨 Входящие',
    '👔 Руководитель'
  ];
};

function getRequestedTabKey(){
  var hash=(window.location.hash||'').replace(/^#/,'').trim().toLowerCase();
  return hash||'';
}
function findTabIndexByKey(key){
  var idx=TAB_KEYS.indexOf(key||'');
  return idx>=0?idx:0;
}
function syncTabHash(){
  var key=TAB_KEYS[tab]||'day';
  if(window.location.hash==='#'+key)return;
  if(window.history&&window.history.replaceState)window.history.replaceState(null,'','#'+key);
  else window.location.hash=key;
}
function setTab(nextTab){
  tab=nextTab;
  syncTabHash();
  rT();
  upd();
}

// Все уникальные даты с активностью из dealCards
function getAllDates(){
  const ds=new Set();
  for(const c of D.dealCards){
    for(const x of (c.comments||[]))if(x.date)ds.add(x.date);
    for(const x of (c.calls||[]))if(x.date)ds.add(x.date);
  }
  if(D.multiDayActivity)for(const dt of Object.keys(D.multiDayActivity))ds.add(dt);
  return [...ds].sort((a,b)=>{
    const pa=a.split('-'),pb=b.split('-');
    const da=new Date(pa[2]+'-'+pa[1]+'-'+pa[0]),db=new Date(pb[2]+'-'+pb[1]+'-'+pb[0]);
    return db-da;
  });
}

function timeToMin(t){if(!t)return 0;const p=(t||'').split(':');return(parseInt(p[0])||0)*60+(parseInt(p[1])||0)}
function dateStamp(dateStr,timeStr){
  if(!dateStr)return 0;
  let year=0,month=0,day=0;
  const m1=dateStr.match(/(\d{2})-(\d{2})-(\d{4})/);
  const m2=dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if(m1){day=parseInt(m1[1],10);month=parseInt(m1[2],10)-1;year=parseInt(m1[3],10);}
  else if(m2){year=parseInt(m2[1],10);month=parseInt(m2[2],10)-1;day=parseInt(m2[3],10);}
  else{return 0;}
  const rawTime=(timeStr||'').split('-')[0].trim();
  const parts=rawTime.match(/(\d{1,2}):(\d{2})/);
  const hours=parts?parseInt(parts[1],10):0;
  const mins=parts?parseInt(parts[2],10):0;
  return new Date(year,month,day,hours,mins,0,0).getTime()||0;
}
function formatTouch(dateStr,timeStr){
  if(!dateStr)return 'Нет активности';
  const stamp=dateStamp(dateStr,timeStr);
  if(!stamp)return (dateStr||'')+(timeStr?' '+timeStr:'');
  return new Date(stamp).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
}
function getLastTouch(card){
  const items=[];
  (card.fCalls||[]).forEach(function(c){items.push({date:c.date,time:c.time,type:'call'});});
  (card.fAnalyses||[]).forEach(function(a){items.push({date:a.date,time:a.time,type:'analysis'});});
  (card.fComments||[]).forEach(function(c){items.push({date:c.date,time:c.time,type:c.type||'comment'});});
  items.sort(function(a,b){return dateStamp(b.date,b.time)-dateStamp(a.date,a.time);});
  return items[0]||null;
}
function getLastTouchAll(card){
  var items=[];
  (card.calls||[]).forEach(function(c){items.push({date:c.date,time:c.time});});
  (card.comments||[]).forEach(function(c){items.push({date:c.date,time:c.time});});
  items.sort(function(a,b){return dateStamp(b.date,b.time)-dateStamp(a.date,a.time);});
  return items[0]||null;
}
function getDaysSince(dateStr){
  if(!dateStr)return 999;
  var p=dateStr.split('-');
  if(p.length!==3)return 999;
  var d=new Date(p[2]+'-'+p[1]+'-'+p[0]);
  return Math.floor((Date.now()-d.getTime())/86400000);
}
function findLatestAiForDeal(id){
  var t=(D.dailyDealActivity||[]).find(function(da){return da.deal.id===id;});
  if(t&&t.aiAssessment)return t.aiAssessment;
  if(D.multiDayActivity){
    var dates=Object.keys(D.multiDayActivity).sort(function(a,b){
      var pa=a.split('-'),pb=b.split('-');
      return new Date(pb[2]+'-'+pb[1]+'-'+pb[0])-new Date(pa[2]+'-'+pa[1]+'-'+pa[0]);
    });
    for(var i=0;i<dates.length;i++){
      var da=(D.multiDayActivity[dates[i]]||[]).find(function(x){return x.deal.id===id;});
      if(da&&da.aiAssessment)return da.aiAssessment;
    }
  }
  return null;
}
function getScoreColor(avgB,maxB){
  if(avgB===null||avgB===undefined)return '#9ca3af';
  var max=maxB||12;
  var pct=avgB/max;
  return pct>=0.6?'#34d399':pct>=0.35?'#fbbf24':'#f87171';
}
function dealHasQuery(card,query){
  if(!query)return true;
  const hay=[card.id,card.name,card.counterparty,card.status].join(' ').toLowerCase();
  return hay.includes(query);
}
function setDealSearch(value,cursorPos){
  dealSearch=value||'';
  renderDealsV2(currentCards);
  requestAnimationFrame(function(){
    const el=document.getElementById('dealSearch');
    if(!el)return;
    el.focus();
    const pos=typeof cursorPos==='number'?cursorPos:dealSearch.length;
    try{el.setSelectionRange(pos,pos);}catch(e){}
  });
}
function setDealStatus(value){
  dealStatus=value||'all';
  renderDealsV2(currentCards);
}
function setDealFocus(value){
  dealFocus=value||'all';
  renderDealsV2(currentCards);
}
function setDealSort(value){
  dealSort=value||'activity';
  renderDealsV2(currentCards);
}
function resetDealFilters(){
  dealSearch='';
  dealStatus='all';
  dealFocus='all';
  dealSort='activity';
  dealFrom='';
  dealTo='';
  renderDealsV2(currentCards);
}

// Пересчитать dailyDealActivity на клиенте для любой даты
function buildDayActivity(dateStr){
  // Если есть предрасчитанные данные с ИИ — обогащаем историей из dealCards
  const multiDay=D.multiDayActivity&&D.multiDayActivity[dateStr];
  if(multiDay){
    for(const da of multiDay){
      if(!da.allComments){
        const card=D.dealCards.find(c=>c.id===da.deal.id);
        if(card){da.allComments=card.comments;da.allCalls=card.calls;da.allAnalyses=card.analyses}
      }
    }
    return multiDay;
  }
  if(dateStr===D.reportDate&&D.dailyDealActivity&&D.dailyDealActivity.length) return D.dailyDealActivity;
  const result=[];
  for(const card of D.dealCards){
    if(!card.isActive)continue;
    // ПРАВИЛО: сделка попадает в день ТОЛЬКО если МЕНЕДЖЕР имел активность (не робот)
    var mgrLow=(D.managerPfName||D.manager||'').toLowerCase();
    var isManagerComment=function(c){return c.date===dateStr&&c.owner&&c.owner.toLowerCase().indexOf(mgrLow)>=0};
    var isRobotOnly=function(c){return c.date===dateStr&&(!c.owner||c.owner.toLowerCase().indexOf('robot')>=0||c.owner.toLowerCase().indexOf('робот')>=0)};
    const dayMgrComments=(card.comments||[]).filter(isManagerComment);
    const dayCalls=(card.calls||[]).filter(c=>c.date===dateStr);
    // dateCreated может быть в формате YYYY-MM-DD или DD-MM-YYYY
    const dc=card.dateCreated||'';
    let createdDMY='';
    if(dc.match(/^\d{4}-/)){const p=dc.split(/[-T ]/);createdDMY=p[2]+'-'+p[1]+'-'+p[0]}
    else if(dc.match(/^\d{2}-\d{2}-\d{4}/)){createdDMY=dc.substring(0,10)}
    const isCreatedToday=createdDMY===dateStr;
    // Менеджер должен иметь хоть одно действие за день (комментарий или звонок из dataTags)
    const hasMgrActivity=dayMgrComments.length>0||dayCalls.length>0;
    if(!hasMgrActivity&&!isCreatedToday)continue;
    // Если менеджер активен — берём ВСЕ комментарии за день (включая от роботов/контактов)
    const dayComments=hasMgrActivity?(card.comments||[]).filter(c=>c.date===dateStr):[];
    const actions=dayComments.map(c=>({type:c.type,time:c.time,text:c.text,owner:c.owner,transcription:c.transcription,source:c.source||'deal',files:c.files||[]}));
    for(const call of dayCalls){
      const isDupe=actions.some(a=>(a.type==='outCall'||a.type==='inCall'||a.type==='ndz')&&Math.abs(timeToMin(a.time)-timeToMin(call.time))<5);
      if(!isDupe){
        actions.push({type:call.type==='Входящий'?'inCall':'outCall',time:call.time,text:(call.type+' '+(call.contact||'')+' '+(call.phone||'')).trim(),owner:call.employee,transcription:null,source:'datatag',duration:call.duration});
      }
    }
    actions.sort((a,b)=>timeToMin(a.time)-timeToMin(b.time));
    const dayAnalyses=(card.analyses||[]).filter(a=>a.date===dateStr);
    const scriptHistory={
      total:(card.analyses||[]).length,
      everHowWeWork:(card.analyses||[]).some(a=>a.howWeWork==='Да'),
      everCallToAction:(card.analyses||[]).some(a=>a.callToAction==='Да'),
      everSentInvoice:(card.analyses||[]).some(a=>a.sentInvoice==='Да'),
      everAllFour:(card.analyses||[]).some(a=>a.allFour==='Да'),
      bestScore:(card.analyses||[]).length?Math.max(...card.analyses.map(a=>a.totalBalls)):0,
      customerKnowsCompany:(card.analyses||[]).some(a=>a.howWeWork==='Да'),
    };
    result.push({
      deal:{id:card.id,name:card.name,status:card.status,counterparty:card.counterparty,dealSum:card.dealSum||0},
      isNew:isCreatedToday,
      actions,
      dayCalls:actions.filter(a=>a.type==='outCall'||a.type==='inCall'||a.type==='ndz').length,
      planfixScript:dayAnalyses.length?dayAnalyses[0]:null,
      allComments:card.comments,
      allCalls:card.calls,
      allAnalyses:card.analyses,
      scriptHistory,
      aiAssessment:null,
    });
  }
  return result;
}

function setDate(d){selectedDate=d;rT();upd()}

function init(){document.getElementById('upd').textContent='Обновлено: '+new Date(D.generated).toLocaleString('ru-RU');rP();rT();upd()}
function rP(){document.getElementById('pbar').innerHTML=PERIODS.map(p=>'<button class="pbtn'+(p.d===period?' on':'')+'" onclick="period='+p.d+';rP();upd()">'+p.l+'</button>').join('')}
function rT(){
  const tabs=[getTabName(),...TABS_BASE.slice(1)];
  document.getElementById('tabs').innerHTML=tabs.map((t,i)=>'<div class="tab'+(i===tab?' on':'')+'" onclick="tab='+i+';rT();upd()">'+t+'</div>').join('');
}

function init(){
  tab=findTabIndexByKey(getRequestedTabKey());
  document.getElementById('upd').textContent='Обновлено: '+new Date(D.generated).toLocaleString('ru-RU');
  rP();
  rT();
  upd();
  syncTabHash();
  window.addEventListener('hashchange',function(){
    var next=findTabIndexByKey(getRequestedTabKey());
    if(next===tab)return;
    tab=next;
    rT();
    upd();
  });
}

function rT(){
  const tabs=TAB_LABELS();
  document.getElementById('tabs').innerHTML=tabs.map((t,i)=>'<div class="tab'+(i===tab?' on':'')+'" onclick="setTab('+i+')">'+t+'</div>').join('');
}

function inPeriod(dateStr){
  if(period>=9999||!dateStr)return true;
  const now=new Date();now.setHours(23,59,59);
  const from=new Date(now);from.setDate(from.getDate()-(period||0));from.setHours(0,0,0);
  let d;
  const m1=dateStr.match(/(\d{2})-(\d{2})-(\d{4})/);
  const m2=dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if(m2) d=new Date(dateStr);
  else if(m1) d=new Date(m1[3]+'-'+m1[2]+'-'+m1[1]);
  else return true;
  return d>=from&&d<=now;
}

function filterCalls(calls){return calls.filter(c=>inPeriod(c.date))}
function filterAnalyses(analyses){return analyses.filter(a=>inPeriod(a.date))}

function upd(){
  const cards=D.dealCards.map(d=>({
    ...d,
    fCalls:filterCalls(d.calls),
    fAnalyses:filterAnalyses(d.analyses),
    fComments:d.comments.filter(c=>inPeriod(c.date)),
  })).filter(d=>d.fCalls.length||d.fAnalyses.length||d.fComments.length);
  currentCards=cards;

  const allC=cards.flatMap(d=>d.fCalls);
  const allA=cards.flatMap(d=>d.fAnalyses);
  const reports=D.dailyReports.filter(r=>inPeriod(r.date));
  if(tab===6){
    document.getElementById('mets').innerHTML='';
    renderMeasurements();
    return;
  }
  if(tab===7){
    document.getElementById('mets').innerHTML='';
    renderIncoming();
    return;
  }
  if(tab===8){
    document.getElementById('mets').innerHTML='';
    renderManager();
    return;
  }
  renderMets(allC,allA,reports,cards);
  if(tab===0)renderDay();
  else if(tab===1)renderDealsV2(cards);
  else if(tab===2)renderQuality(allA,cards);
  else if(tab===3)renderDaily(reports);
  else if(tab===4)renderFunnel();
  else if(tab===5)renderStats();
}

function renderMets(calls,analyses,reports,cards){
  const sum=(a,f)=>a.reduce((s,r)=>s+(r[f]||0),0);
  const rev=sum(reports,'revenue');
  const durSec=calls.reduce((s,c)=>s+c.duration,0);
  const avgB=analyses.length?Math.round(analyses.reduce((s,a)=>s+a.totalBalls,0)/analyses.length*10)/10:0;
  const fwd=D.funnelChanges.filter(c=>c.direction==='forward').length;
  // Считаем новых, обработанных и звонков из multiDayActivity за выбранный период
  var newCount=0,workedCount=0,mdaCallCount=0,mdaCallDur=0;
  if(D.multiDayActivity){
    Object.keys(D.multiDayActivity).forEach(function(dt){
      if(!inPeriod(dt))return;
      var day=D.multiDayActivity[dt]||[];
      day.forEach(function(dd){
        if(dd.isNew)newCount++;
        workedCount++;
        (dd.actions||[]).forEach(function(a){
          if(a.type==='outCall'||a.type==='inCall'||a.type==='ndz'){mdaCallCount++;mdaCallDur+=(a.duration||0);}
        });
      });
    });
  } else {
    newCount=D.dailyActivity.newDeals.length;
    workedCount=D.dailyActivity.workedDeals.length;
  }
  var totalCalls=mdaCallCount||calls.length;
  var totalDurMin=mdaCallCount?Math.round(mdaCallDur/60):Math.round(durSec/60);
  const items=[
    {v:newCount,l:'Новых сегодня',c:'#a78bfa'},
    {v:workedCount,l:'Обработано',c:'#818cf8'},
    {v:fwd,l:'Продвинуто',c:'#34d399'},
    {v:totalCalls,l:'Звонков',c:'#60a5fa'},
    {v:totalDurMin+'м',l:'Время звонков',c:'#818cf8'},
    {v:analyses.length,l:'С анализом',c:'#f472b6'},
    {v:avgB,l:'Ср. балл',c:avgB>=15?'#34d399':avgB>=10?'#fbbf24':'#f87171'},
    {v:sum(reports,'contract'),l:'Договор/оплата',c:'#34d399'},
    {v:rev?fmt(rev)+'₽':'—',l:'Поступило',c:'#fbbf24'},
    {v:sum(reports,'kpSent'),l:'КП',c:'#f472b6'},
  ];
  document.getElementById('mets').innerHTML=items.map(i=>'<div class="met"><div class="met-l">'+i.l+'</div><div class="met-v" style="color:'+i.c+'">'+i.v+'</div></div>').join('');
}

// === ДЕНЬ (главная вкладка) ===
