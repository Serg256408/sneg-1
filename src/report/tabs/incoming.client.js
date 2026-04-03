function renderIncoming(){
  var h='';
  var ibd=D.incomingByDate||{};
  var dates=Object.keys(ibd).sort(function(a,b){
    var pa=a.split('-'),pb=b.split('-');
    return new Date(pb[2]+'-'+pb[1]+'-'+pb[0])-new Date(pa[2]+'-'+pa[1]+'-'+pa[0]);
  });

  // Фильтр по периоду
  var now=new Date();
  var cutoff=new Date(now);
  cutoff.setDate(cutoff.getDate()-period);
  dates=dates.filter(function(d){
    var p=d.split('-');
    return new Date(p[2]+'-'+p[1]+'-'+p[0])>=cutoff;
  });

  var totalDeals=0,totalActions=0;
  dates.forEach(function(d){totalDeals+=(ibd[d]||[]).length;(ibd[d]||[]).forEach(function(dd){totalActions+=(dd.actions||[]).length;});});

  h+='<div class="sec"><h3 style="color:#93c5fd">📨 Входящие обращения</h3>';
  h+='<div style="font-size:12px;color:#6b7280;margin-bottom:12px">Сделки где написал клиент или другой сотрудник, но менеджер не взаимодействовал</div>';

  // Метрики
  h+='<div class="mets" style="margin-bottom:14px">';
  h+='<div class="met"><div class="met-v" style="color:#60a5fa">'+totalDeals+'</div><div class="met-l">Сделок</div></div>';
  h+='<div class="met"><div class="met-v" style="color:#fbbf24">'+totalActions+'</div><div class="met-l">Сообщений</div></div>';
  h+='<div class="met"><div class="met-v" style="color:#6b7280">'+dates.length+'</div><div class="met-l">Дней</div></div>';
  h+='</div>';

  if(!dates.length){
    h+='<div style="color:#6b7280;padding:20px;text-align:center">Нет входящих обращений за выбранный период</div>';
  }

  for(var di=0;di<dates.length;di++){
    var dt=dates[di];
    var deals=ibd[dt]||[];
    if(!deals.length) continue;
    h+='<div style="margin-bottom:16px">';
    h+='<div style="font-weight:700;color:#6b7280;font-size:13px;margin-bottom:8px;border-bottom:1px solid rgba(148,163,184,.15);padding-bottom:4px">'+esc(dt)+' — '+deals.length+' сделок</div>';
    for(var i=0;i<deals.length;i++){
      var dd=deals[i];
      h+='<div style="background:rgba(96,165,250,.06);border:1px solid rgba(96,165,250,.12);border-radius:8px;padding:10px 14px;margin-bottom:6px">';
      h+='<div style="display:flex;justify-content:space-between;align-items:center">';
      h+='<div style="font-weight:700;color:#1a1a2e;font-size:13px">#'+dd.id+' '+esc(dd.name.substring(0,60))+'</div>';
      if(dd.dealSum) h+='<span style="font-size:12px;font-weight:700;color:#fbbf24">'+fmt(dd.dealSum)+' ₽</span>';
      h+='</div>';
      h+='<div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">';
      if(dd.status) h+='<span class="tag">'+esc(dd.status)+'</span>';
      if(dd.counterparty) h+='<span style="font-size:11px;color:#6b7280">'+esc(dd.counterparty)+'</span>';
      h+='</div>';
      var acts=dd.actions||[];
      for(var ai=0;ai<Math.min(acts.length,3);ai++){
        var a=acts[ai];
        h+='<div style="font-size:12px;color:#6b7280;margin-top:4px">'+esc(a.time||'')+' <b style="color:#60a5fa">'+esc(a.owner||'')+'</b>: '+esc(a.text||'')+'</div>';
      }
      if(acts.length>3) h+='<div style="font-size:11px;color:#6b7280;margin-top:2px">...ещё '+(acts.length-3)+' сообщений</div>';
      h+='</div>';
    }
    h+='</div>';
  }
  h+='</div>';
  document.getElementById('out').innerHTML=h;
}

// ============ ВКЛАДКА РУКОВОДИТЕЛЯ ============
var mgrPeriod='day';
function setMgrPeriod(p){mgrPeriod=p;renderManager();}
function parsePfDateClient(s){
  if(!s)return null;
  var m=s.match(/(\d{2})-(\d{2})-(\d{4})/);
  if(m)return new Date(m[3]+'-'+m[2]+'-'+m[1]);
  return new Date(s);
}
function mgrDealPopup(id){
  var el=document.getElementById('mgr_inline_'+id);
  if(el){el.style.display=el.style.display==='none'?'block':'none';return;}
  var card=D.dealCards.find(function(c){return c.id===id;});
  if(!card)return;
  var ai=findLatestAiForDeal(id);
  var h2='<div id="mgr_inline_'+id+'" style="margin:4px 0 8px 18px;padding:8px 12px;border-radius:6px;background:#f9fafb;border:1px solid rgba(148,163,184,.12);font-size:12px">';
  h2+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">';
  h2+='<span class="bg bg-b">'+esc(card.status)+'</span>';
  h2+='<span style="color:#6b7280">'+esc(card.counterparty||'')+'</span>';
  if(card.dealSum)h2+='<span style="color:#fbbf24;font-weight:700">'+fmt(card.dealSum)+' ₽</span>';
  h2+='<span style="color:#6b7280">создана '+esc(card.dateCreated||'')+'</span>';
  h2+='</div>';
  if(ai&&ai.overallVerdict)h2+='<div style="color:#374151;margin-bottom:3px">'+esc(ai.overallVerdict)+'</div>';
  if(ai&&ai.missing&&ai.missing.length)h2+='<div style="color:#f87171"><b>Не хватает:</b> '+esc(ai.missing.join(', '))+'</div>';
  if(ai&&ai.nextStep)h2+='<div style="color:#34d399;margin-top:2px"><b>След.шаг:</b> '+esc(ai.nextStep)+'</div>';
  h2+='</div>';
  var btn=document.getElementById('mgr_btn_'+id);
  if(btn)btn.insertAdjacentHTML('afterend',h2);
}
function linkifyDealIds(text){
  return text.replace(/#(\d{4,6})/g,function(m,id){
    return '<span id="mgr_btn_'+id+'" onclick="mgrDealPopup('+id+')" style="color:#60a5fa;cursor:pointer;text-decoration:underline;text-decoration-style:dotted">'+m+' ▾</span>';
  });
}
