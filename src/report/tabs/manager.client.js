function renderManager(){
  var h='';
  var ms=D.managerSummaries||{};

  // === Переключатель периода ===
  h+='<div style="display:flex;gap:5px;margin-bottom:14px">';
  var periods=[{k:'day',l:'📅 День'},{k:'week',l:'📆 Неделя'},{k:'month',l:'🗓 Месяц'}];
  for(var i=0;i<periods.length;i++){
    var p=periods[i];
    var isOn=mgrPeriod===p.k;
    h+='<button onclick="setMgrPeriod(&#39;'+p.k+'&#39;)" class="pbtn'+(isOn?' on':'')+'" style="font-size:13px;padding:8px 16px">'+p.l+'</button>';
  }
  h+='</div>';

  // === AI ВЫЖИМКА ===
  // Для режима "День" — показываем итог за выбранную дату из multiDaySummary
  var text;
  if(mgrPeriod==='day' && D.multiDaySummary && D.multiDaySummary[selectedDate]){
    text=D.multiDaySummary[selectedDate];
  } else {
    text=ms[mgrPeriod]||null;
  }
  var periodLabel=mgrPeriod==='day'?'день':mgrPeriod==='week'?'неделю':'месяц';
  if(text){
    // Иконки и цвета для секций
    var secStyles={
      'КРАТКИЙ ИТОГ':{icon:'📋',color:'#60a5fa',bg:'rgba(96,165,250,.06)'},
      'УСПЕХИ И ПРОГРЕСС':{icon:'🏆',color:'#34d399',bg:'rgba(52,211,153,.06)'},
      'УСПЕХИ':{icon:'🏆',color:'#34d399',bg:'rgba(52,211,153,.06)'},
      'ПРОБЛЕМЫ':{icon:'⚠️',color:'#f87171',bg:'rgba(248,113,113,.06)'},
      'БЛИЖАЙШИЕ ОПЛАТЫ':{icon:'💰',color:'#fbbf24',bg:'rgba(251,191,36,.06)'},
      'РЕКОМЕНДАЦИИ РУКОВОДИТЕЛЮ':{icon:'🎯',color:'#a78bfa',bg:'rgba(167,139,250,.06)'},
      'РЕКОМЕНДАЦИИ':{icon:'🎯',color:'#a78bfa',bg:'rgba(167,139,250,.06)'},
    };
    // Разбиваем на секции по заголовкам (1. ТЕКСТ, 2. ТЕКСТ, **ТЕКСТ**)
    var lines=text.split('\n');
    var sections=[];
    var dateLabel=mgrPeriod==='day'?selectedDate:(mgrPeriod==='week'?'неделю':'месяц');
    var curSec={title:'Отчёт для руководителя за '+dateLabel,lines:[]};
    for(var i=0;i<lines.length;i++){
      var line=lines[i].trim();
      if(!line)continue;
      // Убираем ** и ### обёртку для проверки заголовка
      var clean=line.replace(/^#{1,4}\s*/, '').replace(/^\*\*/, '').replace(/\*\*$/, '');
      // Заголовок секции: "1. КРАТКИЙ ИТОГ" или "КРАТКИЙ ИТОГ" (4+ заглавных букв)
      var secMatch=clean.match(/^(?:\d+\.\s*)([А-ЯЁA-Z][А-ЯЁA-Z\s]{3,})$/);
      if(secMatch){
        if(curSec.lines.length||sections.length===0)sections.push(curSec);
        curSec={title:secMatch[1].trim(),lines:[]};
        continue;
      }
      // Пропуск служебных строк
      if(clean.match(/^ОТЧЁТ О РАБОТЕ/)||clean.match(/^Компания/)||clean.match(/^Период/)||clean==='---')continue;
      curSec.lines.push(line);
    }
    if(curSec.lines.length)sections.push(curSec);

    // Рендерим каждую секцию отдельной карточкой
    for(var si=0;si<sections.length;si++){
      var sec=sections[si];
      if(!sec.lines.length&&si>0)continue;
      var st=null;
      for(var sk in secStyles){if(sec.title.indexOf(sk)>=0){st=secStyles[sk];break;}}
      if(!st)st={icon:'📄',color:'#6b7280',bg:'rgba(107,114,128,.04)'};
      h+='<div style="background:'+st.bg+';border-left:3px solid '+st.color+';border-radius:8px;padding:14px 18px;margin-bottom:10px">';
      h+='<div style="font-size:14px;font-weight:700;color:'+st.color+';margin-bottom:8px">'+st.icon+' '+esc(sec.title)+'</div>';
      h+='<div style="font-size:13px;line-height:1.8;color:#374151">';
      for(var li=0;li<sec.lines.length;li++){
        var ln=sec.lines[li];
        // Жирный текст **xxx**
        ln=ln.replace(/\*\*([^*]+)\*\*/g,'<strong style="color:#1a1a2e">$1</strong>');
        // Денежные суммы выделяем
        ln=ln.replace(/(\d[\d\s.,]*\s*(?:₽|руб|Р))/g,'<span style="color:#fbbf24;font-weight:600">$1</span>');
        // Номера сделок #XXXXX → кликабельные с раскрытием
        ln=linkifyDealIds(ln);
        // Нумерованные пункты
        if(ln.match(/^\d+\./)){
          ln='<div style="padding:6px 0 6px 8px;border-bottom:1px solid rgba(148,163,184,.08)">'+ln+'</div>';
        }
        // Вложенные маркеры (    *   текст)
        else if(ln.match(/^\s{2,}[*•\-]\s+/)){
          ln='<div style="padding:4px 0 4px 34px;position:relative;color:#6b7280"><span style="position:absolute;left:18px;color:'+st.color+';opacity:.5">◦</span>'+ln.replace(/^\s*[*•\-]\s+/,'')+'</div>';
        }
        // Маркеры * или - (включая "*   текст")
        else if(ln.match(/^[*•\-]\s+/)){
          ln='<div style="padding:6px 0 6px 18px;position:relative"><span style="position:absolute;left:2px;color:'+st.color+'">•</span>'+ln.replace(/^[*•\-]\s+/,'')+'</div>';
        }
        else{
          ln='<div style="margin:3px 0">'+ln+'</div>';
        }
        h+=ln;
      }
      h+='</div>';
      // Собираем все #ID из текста секции и показываем карточки сделок
      var secText=sec.lines.join(' ');
      var idMatches=secText.match(/#(d{4,6})/g);
      if(idMatches&&idMatches.length){
        var uniqueIds=[...new Set(idMatches.map(function(m){return parseInt(m.substring(1))}))];
        var secDeals=uniqueIds.map(function(id){return D.dealCards.find(function(c){return c.id===id})}).filter(Boolean);
        if(secDeals.length){
          var secSum=secDeals.reduce(function(s,d){return s+(d.dealSum||0)},0);
          h+='<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(0,0,0,.06)">';
          h+='<div style="font-size:11px;color:#6b7280;margin-bottom:6px">📊 Сделки в блоке: <b>'+secDeals.length+'</b>'+(secSum?' · Сумма: <b style="color:#b45309">'+fmt(secSum)+' ₽</b>':'')+'</div>';
          for(var sdi=0;sdi<secDeals.length;sdi++){
            var sd2=secDeals[sdi];
            var ai4=findLatestAiForDeal(sd2.id);
            var ss4=ai4&&ai4.salaryScore?ai4.salaryScore:{};
            var sc4=ss4.total||0;
            var mx4=ss4.max||12;
            var scCol4=sc4>=7?'#16a34a':sc4>=4?'#b45309':'#dc2626';
            var secCardId='mgr_sec_'+si+'_'+sd2.id;
            h+='<div style="border:1px solid rgba(0,0,0,.06);border-radius:6px;margin-bottom:3px;overflow:hidden">';
            h+='<div onclick="var b=document.getElementById(&#39;'+secCardId+'&#39;);b.style.display=b.style.display===&#39;none&#39;?&#39;block&#39;:&#39;none&#39;" style="display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;background:rgba(0,0,0,.01)">';
            h+='<span style="color:#6b7280;font-size:11px;min-width:46px">#'+sd2.id+'</span>';
            h+='<span style="flex:1;font-size:12px;color:#1a1a2e;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((sd2.name||'').substring(0,50))+'</span>';
            if(sd2.dealSum)h+='<span style="font-size:11px;font-weight:700;color:#b45309">'+fmt(sd2.dealSum)+' ₽</span>';
            h+='<span style="font-size:11px;font-weight:700;color:'+scCol4+'">'+sc4+'/'+mx4+'</span>';
            h+='<span style="color:#9ca3af;font-size:9px">▼</span>';
            h+='</div>';
            h+='<div id="'+secCardId+'" style="display:none;padding:6px 10px 8px;border-top:1px solid rgba(0,0,0,.04);background:#f9fafb;font-size:12px">';
            h+='<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:4px">';
            h+='<span class="bg bg-b">'+esc(sd2.status||'')+'</span>';
            if(sd2.counterparty)h+='<span style="color:#6b7280;font-size:11px">'+esc(sd2.counterparty)+'</span>';
            h+='<span style="color:#6b7280;font-size:11px">создана '+esc(sd2.dateCreated||'')+'</span>';
            h+='</div>';
            if(ai4&&ai4.overallVerdict)h+='<div style="color:#374151;margin-bottom:3px">'+esc(ai4.overallVerdict)+'</div>';
            if(ai4&&ai4.missing&&ai4.missing.length)h+='<div style="color:#dc2626"><b>Не хватает:</b> '+esc(ai4.missing.join(', '))+'</div>';
            if(ai4&&ai4.nextStep)h+='<div style="color:#16a34a;margin-top:2px"><b>След.шаг:</b> '+esc(ai4.nextStep)+'</div>';
            h+='</div></div>';
          }
          h+='</div>';
        }
      }
      h+='</div>';
    }
  }else{
    h+='<div class="sec" style="border-left:3px solid #a78bfa;min-height:100px"><h3>👔 Отчёт для руководителя за '+periodLabel+'</h3>';
    h+='<div class="no-data">Нет данных за '+periodLabel+'. Запустите полный отчёт чтобы сгенерировать.</div></div>';
  }

  // === СДЕЛКИ ЗА ПЕРИОД (раскрывающиеся карточки) ===
  var periodDays=mgrPeriod==='day'?1:mgrPeriod==='week'?7:30;
  var refDate=parsePfDateClient(D.reportDate);
  var periodDeals=[];
  if(D.multiDayActivity&&refDate){
    var workedMap={};
    Object.keys(D.multiDayActivity).forEach(function(dt){
      var pd=parsePfDateClient(dt);
      if(!pd)return;
      var diff=Math.floor((refDate-pd)/86400000);
      if(diff<0||diff>=periodDays)return;
      var dayActs=D.multiDayActivity[dt]||[];
      dayActs.forEach(function(da){
        if(!workedMap[da.deal.id]){
          workedMap[da.deal.id]={deal:da.deal,ai:null,days:[],calls:0,score:0,maxScore:0};
        }
        workedMap[da.deal.id].days.push(dt);
        workedMap[da.deal.id].calls+=(da.dayCalls||0);
        if(da.aiAssessment){
          workedMap[da.deal.id].ai=da.aiAssessment;
          var ss=da.aiAssessment.salaryScore||{};
          workedMap[da.deal.id].score=ss.total||0;
          workedMap[da.deal.id].maxScore=ss.max||12;
        }
      });
    });
    periodDeals=Object.values(workedMap).sort(function(a,b){return(b.deal.dealSum||0)-(a.deal.dealSum||0);});
  }
  if(periodDeals.length){
    // Разделяем на проблемные (score <= 3 или нет звонков) и остальные
    var problemDeals=periodDeals.filter(function(d){return d.score<=3||d.calls===0;});
    var goodDeals=periodDeals.filter(function(d){return d.score>3&&d.calls>0;});

    if(problemDeals.length){
      h+='<div class="sec" style="border-left:3px solid #f87171"><h3>⚠️ Проблемные сделки ('+problemDeals.length+')</h3>';
      h+='<div style="font-size:11px;color:#6b7280;margin-bottom:8px">Низкие баллы или нет звонков. Нажмите для подробностей.</div>';
      for(var i=0;i<problemDeals.length;i++){
        var pd2=problemDeals[i];
        var cardId='mgr_prob_'+pd2.deal.id;
        var ai2=pd2.ai||{};
        var scoreCol=pd2.score>=7?'#34d399':pd2.score>=4?'#fbbf24':'#f87171';
        h+='<div style="border:1px solid rgba(248,113,113,.15);border-radius:8px;margin-bottom:4px;overflow:hidden">';
        h+='<div onclick="var b=document.getElementById(&#39;'+cardId+'&#39;);b.style.display=b.style.display===&#39;none&#39;?&#39;block&#39;:&#39;none&#39;" style="display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;background:rgba(248,113,113,.04)">';
        h+='<span style="color:#6b7280;font-size:11px;min-width:50px">#'+pd2.deal.id+'</span>';
        h+='<span style="flex:1;font-size:13px;color:#1a1a2e;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((pd2.deal.name||'').substring(0,55))+'</span>';
        if(pd2.deal.dealSum)h+='<span style="font-size:12px;font-weight:700;color:#fbbf24;white-space:nowrap">'+fmt(pd2.deal.dealSum)+' ₽</span>';
        h+='<span style="font-size:12px;font-weight:700;color:'+scoreCol+';min-width:40px;text-align:right">'+pd2.score+'/'+pd2.maxScore+'</span>';
        h+='<span style="color:#6b7280;font-size:10px">▼</span>';
        h+='</div>';
        h+='<div id="'+cardId+'" style="display:none;padding:8px 12px 10px;border-top:1px solid rgba(248,113,113,.1);background:#f9fafb">';
        h+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">';
        h+='<span class="bg bg-b">'+esc(pd2.deal.status||'')+'</span>';
        if(pd2.deal.counterparty)h+='<span style="font-size:11px;color:#6b7280">'+esc(pd2.deal.counterparty)+'</span>';
        h+='<span style="font-size:11px;color:#6b7280">📞 '+pd2.calls+' зв.</span>';
        h+='<span style="font-size:11px;color:#6b7280">'+pd2.days.length+' дн.</span>';
        h+='</div>';
        if(ai2.overallVerdict)h+='<div style="font-size:12px;color:#374151;margin-bottom:4px">'+esc(ai2.overallVerdict)+'</div>';
        if(ai2.missing&&ai2.missing.length){
          h+='<div style="font-size:11px;color:#f87171;margin-bottom:4px"><b>Не хватает:</b> '+esc(ai2.missing.join(', '))+'</div>';
        }
        if(ai2.nextStep)h+='<div style="font-size:11px;color:#34d399"><b>След.шаг:</b> '+esc(ai2.nextStep)+'</div>';
        h+='</div></div>';
      }
      h+='</div>';
    }

    if(goodDeals.length){
      h+='<div class="sec" style="border-left:3px solid #34d399"><h3>✅ Обработанные сделки ('+goodDeals.length+')</h3>';
      for(var i=0;i<goodDeals.length;i++){
        var gd=goodDeals[i];
        var cardId2='mgr_good_'+gd.deal.id;
        var ai3=gd.ai||{};
        var scoreCol2=gd.score>=7?'#34d399':gd.score>=4?'#fbbf24':'#f87171';
        h+='<div style="border:1px solid rgba(52,211,153,.12);border-radius:8px;margin-bottom:4px;overflow:hidden">';
        h+='<div onclick="var b=document.getElementById(&#39;'+cardId2+'&#39;);b.style.display=b.style.display===&#39;none&#39;?&#39;block&#39;:&#39;none&#39;" style="display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;background:rgba(52,211,153,.04)">';
        h+='<span style="color:#6b7280;font-size:11px;min-width:50px">#'+gd.deal.id+'</span>';
        h+='<span style="flex:1;font-size:13px;color:#1a1a2e;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((gd.deal.name||'').substring(0,55))+'</span>';
        if(gd.deal.dealSum)h+='<span style="font-size:12px;font-weight:700;color:#fbbf24;white-space:nowrap">'+fmt(gd.deal.dealSum)+' ₽</span>';
        h+='<span style="font-size:12px;font-weight:700;color:'+scoreCol2+';min-width:40px;text-align:right">'+gd.score+'/'+gd.maxScore+'</span>';
        h+='<span style="color:#6b7280;font-size:10px">▼</span>';
        h+='</div>';
        h+='<div id="'+cardId2+'" style="display:none;padding:8px 12px 10px;border-top:1px solid rgba(52,211,153,.1);background:#f9fafb">';
        h+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">';
        h+='<span class="bg bg-b">'+esc(gd.deal.status||'')+'</span>';
        if(gd.deal.counterparty)h+='<span style="font-size:11px;color:#6b7280">'+esc(gd.deal.counterparty)+'</span>';
        h+='<span style="font-size:11px;color:#6b7280">📞 '+gd.calls+' зв.</span>';
        h+='</div>';
        if(ai3.overallVerdict)h+='<div style="font-size:12px;color:#374151;margin-bottom:4px">'+esc(ai3.overallVerdict)+'</div>';
        if(ai3.nextStep)h+='<div style="font-size:11px;color:#34d399"><b>След.шаг:</b> '+esc(ai3.nextStep)+'</div>';
        h+='</div></div>';
      }
      h+='</div>';
    }
  }

  // === КЛЮЧЕВЫЕ ЦИФРЫ ===
  var active=D.dealCards.filter(function(d){return d.isActive;});
  var totalSum=active.reduce(function(s,d){return s+(d.dealSum||0);},0);
  var closingStatuses=['Дожим','Договор и оплата'];
  var closingDeals=active.filter(function(d){return closingStatuses.indexOf(d.status)>=0;});
  var closingSum=closingDeals.reduce(function(s,d){return s+(d.dealSum||0);},0);
  var activeWithTouch=active.map(function(d){
    var lt=getLastTouchAll(d);
    var days=lt?getDaysSince(lt.date):999;
    return {card:d,daysSince:days};
  });
  var stalling=activeWithTouch.filter(function(x){return x.daysSince>=3;}).length;

  h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:14px">';
  var mets=[
    {v:active.length,l:'Активных сделок',c:'#60a5fa'},
    {v:fmt(totalSum)+' ₽',l:'Сумма пайплайна',c:'#fbbf24'},
    {v:closingDeals.length,l:'Дожим / Договор',c:'#34d399'},
    {v:fmt(closingSum)+' ₽',l:'Сумма к оплате',c:'#34d399'},
    {v:stalling,l:'Без контакта >3д',c:stalling>0?'#f87171':'#34d399'},
  ];
  for(var i=0;i<mets.length;i++){
    h+='<div class="met"><div class="met-v" style="color:'+mets[i].c+'">'+mets[i].v+'</div><div class="met-l">'+mets[i].l+'</div></div>';
  }
  h+='</div>';

  // === БЛИЖЕ К ОПЛАТЕ (компакт) ===
  var nearPayment=active.filter(function(d){
    return closingStatuses.indexOf(d.status)>=0;
  }).sort(function(a,b){return(b.dealSum||0)-(a.dealSum||0);});
  if(nearPayment.length){
    h+='<div class="sec" style="border-left:3px solid #34d399"><h3>🎯 Ближе к оплате ('+nearPayment.length+')</h3>';
    h+='<table><tr><th>Сделка</th><th>Статус</th><th style="text-align:right">Сумма</th><th>След. шаг</th></tr>';
    for(var i=0;i<nearPayment.length;i++){
      var d=nearPayment[i];
      var ai=findLatestAiForDeal(d.id);
      h+='<tr>';
      h+='<td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((d.name||'').substring(0,50))+'<br><span style="font-size:10px;color:#6b7280">'+esc(d.counterparty||'')+'</span></td>';
      h+='<td><span class="bg bg-g">'+esc(d.status)+'</span></td>';
      h+='<td style="text-align:right;font-weight:700;color:#fbbf24">'+(d.dealSum?fmt(d.dealSum)+' ₽':'—')+'</td>';
      h+='<td style="font-size:11px;color:#93c5fd">'+(ai&&ai.nextStep?esc(ai.nextStep).substring(0,80):'—')+'</td>';
      h+='</tr>';
    }
    h+='</table></div>';
  }

  // === ВОРОНКА ПО ДЕНЬГАМ ===
  var funnelMoney={};
  active.forEach(function(d){
    if(!funnelMoney[d.status])funnelMoney[d.status]={count:0,sum:0};
    funnelMoney[d.status].count++;
    funnelMoney[d.status].sum+=(d.dealSum||0);
  });
  var fOrder=['Новая','Обработка','В работе','Коммерческое предложение','Вывезли/Нашли поставщика','Дожим','Договор и оплата'];
  var maxFSum=Math.max.apply(null,fOrder.map(function(s){return(funnelMoney[s]||{}).sum||0;}))||1;
  h+='<div class="sec"><h3>📊 Воронка по деньгам</h3>';
  h+='<table><tr><th>Статус</th><th style="text-align:center">Сделок</th><th style="text-align:right">Сумма</th><th style="width:40%"></th></tr>';
  for(var i=0;i<fOrder.length;i++){
    var s=fOrder[i];
    var f=funnelMoney[s]||{count:0,sum:0};
    var pct=Math.round(f.sum/maxFSum*100);
    var barCol=i>=5?'#16a34a':i>=3?'#2563eb':'#9ca3af';
    h+='<tr><td style="font-weight:600;white-space:nowrap">'+esc(s)+'</td>';
    h+='<td style="text-align:center">'+f.count+'</td>';
    h+='<td style="text-align:right;font-weight:700;color:#fbbf24">'+(f.sum?fmt(f.sum)+' ₽':'—')+'</td>';
    h+='<td><div class="bar-bg"><div class="bar-f" style="width:'+pct+'%;background:'+barCol+'"></div></div></td>';
    h+='</tr>';
  }
  h+='</table></div>';

  // === ТРЕБУЮТ ДОЖИМА: КП отправлено, но нет звонка давно ===
  var staleDeals=[];
  var now=new Date();
  D.dealCards.forEach(function(c){
    if(!c.isActive) return;
    if(c.status!=='Коммерческое предложение'&&c.status!=='Дожим') return;
    // Последний звонок менеджера
    var lastCall=null;
    (c.calls||[]).forEach(function(cl){
      var p=cl.date.split('-');
      var d=new Date(p[2]+'-'+p[1]+'-'+p[0]);
      if(!lastCall||d>lastCall)lastCall=d;
    });
    var daysSince=lastCall?Math.floor((now-lastCall)/(1000*60*60*24)):999;
    if(daysSince>=3){
      staleDeals.push({id:c.id,name:c.name,status:c.status,dealSum:c.dealSum||0,counterparty:c.counterparty,daysSince:daysSince,lastCall:lastCall?lastCall.toLocaleDateString('ru-RU'):'никогда'});
    }
  });
  staleDeals.sort(function(a,b){return (b.dealSum||0)-(a.dealSum||0);});
  if(staleDeals.length){
    h+='<div class="sec" style="margin-top:18px"><h3 style="color:#f59e0b">🔔 Требуют дожима ('+staleDeals.length+')</h3>';
    h+='<div style="font-size:12px;color:#6b7280;margin-bottom:10px">Сделки в статусе КП/Дожим без звонка 3+ дней</div>';
    h+='<table style="width:100%;font-size:13px"><tr style="color:#6b7280;font-size:11px"><th style="text-align:left">Сделка</th><th>Статус</th><th>Сумма</th><th>Дней без звонка</th><th>Посл. звонок</th></tr>';
    for(var si=0;si<Math.min(staleDeals.length,30);si++){
      var sd=staleDeals[si];
      var urgColor=sd.daysSince>=14?'#dc2626':sd.daysSince>=7?'#b45309':'#9ca3af';
      h+='<tr>';
      h+='<td style="font-weight:600;color:#1a1a2e;padding:6px 0">#'+sd.id+' '+esc(sd.name.substring(0,40))+'</td>';
      h+='<td style="text-align:center"><span class="tag">'+esc(sd.status)+'</span></td>';
      h+='<td style="text-align:right;font-weight:700;color:#fbbf24">'+(sd.dealSum?fmt(sd.dealSum)+' ₽':'—')+'</td>';
      h+='<td style="text-align:center;font-weight:700;color:'+urgColor+'">'+sd.daysSince+'</td>';
      h+='<td style="text-align:center;color:#6b7280;font-size:12px">'+sd.lastCall+'</td>';
      h+='</tr>';
    }
    if(staleDeals.length>30) h+='<tr><td colspan="5" style="color:#6b7280;font-size:12px">...ещё '+(staleDeals.length-30)+'</td></tr>';
    h+='</table></div>';
  }

  // === ВХОДЯЩИЕ ОБРАЩЕНИЯ (клиенты/другие сотрудники) ===
  var inc=D.dailyActivity.incomingDeals||[];
  if(inc.length){
    h+='<div class="sec" style="margin-top:18px"><h3 style="color:#93c5fd">📨 Входящие обращения ('+inc.length+')</h3>';
    h+='<div style="font-size:12px;color:#6b7280;margin-bottom:10px">Сделки где написал клиент или другой сотрудник, но менеджер не взаимодействовал</div>';
    for(var ii=0;ii<inc.length;ii++){
      var dd=inc[ii];
      h+='<div style="background:rgba(96,165,250,.06);border:1px solid rgba(96,165,250,.15);border-radius:8px;padding:10px 14px;margin-bottom:6px">';
      h+='<div style="font-weight:700;color:#1a1a2e">#'+dd.id+' '+esc(dd.name)+'</div>';
      h+='<div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">';
      if(dd.status) h+='<span class="tag">'+esc(dd.status)+'</span>';
      if(dd.dealSum) h+='<span class="tag" style="background:#854d0e;color:#fbbf24">'+fmt(dd.dealSum)+' ₽</span>';
      h+='</div>';
      var acts=dd.actions||[];
      for(var ai=0;ai<acts.length;ai++){
        var a=acts[ai];
        h+='<div style="font-size:12px;color:#6b7280;margin-top:4px">'+esc(a.owner||'')+': '+esc(a.text||'')+'</div>';
      }
      h+='</div>';
    }
    h+='</div>';
  }

  document.getElementById('out').innerHTML=h;
}
function fmt(n){return n?n.toLocaleString('ru-RU'):'0'}
function fmtD(iso){if(!iso)return'?';const d=new Date(iso);return isNaN(d)?iso:d.toLocaleDateString('ru-RU',{day:'2-digit',month:'short'})}
function yn(v){return v==='Да'?'<span class="yes">✓</span>':'<span class="no">✗</span>'}
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')}
function timeToMin(t){const m=(t||'').match(/(\d+):(\d+)/);return m?parseInt(m[1])*60+parseInt(m[2]):0}