function hasCallRecordingFile(files){
  return (files||[]).some(function(file){
    var name=typeof file==='string'?file:(file&&(file.name||file.fileName))||'';
    return /(запись звонка|\.mp3\b|\.mpga\b|\.mpeg\b|\.m4a\b|\.mp4\b|\.wav\b|\.webm\b|\.ogg\b|\.oga\b|\.flac\b)/i.test(String(name));
  });
}

function callNeedsTranscript(item){
  if(!item)return false;
  var isCall=item.type==='outCall'||item.type==='inCall'||item.type==='ndz';
  if(!isCall||item.transcription)return false;
  var duration=parseInt(item.duration||0,10)||0;
  return hasCallRecordingFile(item.files)||duration>0;
}

function renderDay(){
  const deals=buildDayActivity(selectedDate);
  const isOriginalDate=selectedDate===D.reportDate;
  let h='';

  // Выбор даты
  const dates=getAllDates();
  h+='<div style="margin-bottom:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
  h+='<span style="font-size:12px;color:#6b7280;font-weight:600">📅 Дата:</span>';
  h+='<select id="datePicker" onchange="setDate(this.value)" style="padding:6px 10px;border-radius:8px;border:1px solid rgba(0,0,0,.1);background:#fff;color:#1a1a2e;font-size:13px;font-family:inherit;cursor:pointer">';
  for(const dt of dates){
    const hasAi=D.multiDayActivity&&D.multiDayActivity[dt];
    h+='<option value="'+dt+'"'+(dt===selectedDate?' selected':'')+'>'+dt+(hasAi?' (ИИ)':'')+'</option>';
  }
  h+='</select>';
  const hasAiData=D.multiDayActivity&&D.multiDayActivity[selectedDate];
  if(!hasAiData&&!isOriginalDate){
    h+='<span style="font-size:11px;color:#fbbf24">⚠️ ИИ-оценка недоступна за эту дату</span>';
  }
  h+='</div>';

  // ИИ итог дня
  const daySummary=(D.multiDaySummary&&D.multiDaySummary[selectedDate])||(isOriginalDate?D.aiDaySummaryText:null);
  if(daySummary){
    h+='<div class="sec" style="border-left:3px solid #8b5cf6;background:rgba(139,92,246,.06)">';
    h+='<h3>🤖 ИИ-итог дня ('+esc(selectedDate)+')</h3>';
    h+='<div style="font-size:13px;line-height:1.7;color:#374151;white-space:pre-wrap">'+esc(daySummary)+'</div>';
    h+='</div>';
  }

  // Метрики дня
  const newD=deals.filter(d=>d.isNew).length;
  const oldD=deals.filter(d=>!d.isNew).length;
  const totalCalls=deals.reduce((s,d)=>(d.actions||[]).filter(a=>a.type==='outCall'||a.type==='inCall'||a.type==='ndz').length+s,0);
  const totalSalaryScore=deals.reduce((s,d)=>{const ss=(d.aiAssessment||{}).salaryScore;return s+(ss?ss.total:0)},0);
  const maxSalaryScore=deals.length*12;
  h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:14px">';
  h+='<div class="met"><div class="met-l">Обработано</div><div class="met-v" style="color:#60a5fa">'+deals.length+'</div></div>';
  h+='<div class="met"><div class="met-l">Новых</div><div class="met-v" style="color:#a78bfa">'+newD+'</div></div>';
  h+='<div class="met"><div class="met-l">Старых</div><div class="met-v" style="color:#818cf8">'+oldD+'</div></div>';
  h+='<div class="met"><div class="met-l">Звонков</div><div class="met-v" style="color:#34d399">'+totalCalls+'</div></div>';
  h+='<div class="met"><div class="met-l">Баллы ЗП</div><div class="met-v" style="color:#fbbf24">'+totalSalaryScore+'/'+maxSalaryScore+'</div></div>';
  h+='</div>';

  if(!deals.length){
    h+='<div class="no-data">Нет активности за '+esc(selectedDate||'сегодня')+'</div>';
    document.getElementById('out').innerHTML=h;return;
  }

  // Кнопка развернуть/свернуть
  h+='<div style="text-align:right;margin-bottom:8px"><button id="toggleAllBtn" onclick="toggleAllCards()" style="padding:4px 12px;font-size:11px;font-weight:600;color:#6b7280;background:rgba(0,0,0,.03);border:1px solid rgba(0,0,0,.08);border-radius:6px;cursor:pointer">📂 Развернуть всё</button></div>';

  // Карточки сделок за день
  for(let di=0;di<deals.length;di++){
    const da=deals[di];
    const d=da.deal;
    const aa=da.aiAssessment||{};
    const uid=d.id+'_'+di;
    const borderCol=da.isNew?'#a78bfa':'#3b82f6';
    const dss=(aa.salaryScore||{});
    const dsCol=dss.total>=7?'#34d399':dss.total>=4?'#fbbf24':'#f87171';
    const acts=da.actions||[];
    const callCount=acts.filter(a=>a.type==='outCall'||a.type==='inCall'||a.type==='ndz').length;

    // === CARD WRAPPER ===
    h+='<div class="card" style="border-left:3px solid '+borderCol+'">';

    // === CARD HEADER (always visible, click to expand) ===
    const cardId='card_'+uid;
    h+='<div class="card-top" id="chdr_'+cardId+'" onclick="toggleCard(&#39;'+cardId+'&#39;)">';
    h+='<div style="flex:1;min-width:200px">';
    h+='<div class="card-title"><span class="card-arrow">▶</span> #'+d.id+' '+esc((d.name||'').substring(0,70))+'</div>';
    h+='<div class="card-tags">';
    h+='<span style="font-size:11px;color:#6b7280">'+esc(d.counterparty)+'</span>';
    h+='<span class="bg bg-b">'+esc(d.status)+'</span>';
    var ws=(aa&&aa.workSummary)||d.workDesc||'';
    if(ws)h+='<span class="bg" style="background:rgba(147,197,253,.1);color:#93c5fd">'+esc(ws)+'</span>';
    if(d.dealSum)h+='<span class="bg" style="background:rgba(251,191,36,.12);color:#fbbf24">'+fmt(d.dealSum)+' ₽</span>';
    if(da.isNew)h+='<span class="bg bg-p">Новая</span>';
    else h+='<span class="bg bg-y">Старая</span>';
    var dcCard=D.dealCards.find(function(c){return c.id===d.id});
    if(dcCard&&dcCard.dateCreated)h+='<span style="font-size:10px;color:#6b7280;margin-left:2px">'+esc(dcCard.dateCreated)+'</span>';
    if(callCount)h+='<span class="bg" style="background:rgba(52,211,153,.12);color:#34d399">📞 '+callCount+'</span>';
    h+='</div>';
    h+='</div>';
    // Score pill
    if(dss.total!==undefined){
      h+='<div class="score-pill" style="background:rgba(251,191,36,.1);color:'+dsCol+'">💰 '+dss.total+'/'+dss.max+'</div>';
    }
    h+='</div>';

    h+='<div class="card-body" id="cbody_'+cardId+'">';

    // === СИТУАЦИЯ + РЕЗУЛЬТАТ + СЛЕДУЮЩИЙ ШАГ ===
    const hasSituation=aa.dealSituation||aa.todaySummary||aa.nextStep;
    if(hasSituation){
      h+='<div class="result-block">';
      // Ситуация по сделке (соль)
      if(aa.dealSituation){
        h+='<div style="font-size:12px;font-weight:700;color:#1a1a2e;margin-bottom:4px">📋 Ситуация</div>';
        h+='<div style="font-size:12px;color:#374151;margin-bottom:8px;line-height:1.5">'+esc(aa.dealSituation)+'</div>';
      }
      // Что сделано сегодня
      if(aa.todaySummary){
        h+='<div style="font-size:12px;font-weight:700;color:#1a1a2e;margin-bottom:4px">📊 Сегодня</div>';
        h+='<div style="font-size:12px;color:#374151;margin-bottom:8px;line-height:1.5">'+esc(aa.todaySummary)+'</div>';
      }
      // Вердикт
      if(aa.overallVerdict){
        h+='<div class="res-verdict">→ '+esc(aa.overallVerdict)+'</div>';
      }
      // Следующий шаг — сразу здесь, не внизу
      if(aa.nextStep){
        h+='<div style="margin-top:6px;padding:8px 10px;background:rgba(59,130,246,.06);border-radius:8px;border-left:3px solid #3b82f6">';
        h+='<span style="font-size:11px;font-weight:700;color:#2563eb">▶ СЛЕДУЮЩИЙ ШАГ:</span> ';
        h+='<span style="font-size:12px;color:#1e40af">'+esc(aa.nextStep)+'</span></div>';
      }
      h+='</div>';
    }

    // === RED-ФЛАГИ ===
    const cardData=D.dealCards.find(c=>c.id===d.id);
    const rf=cardData&&cardData.redFlags||[];
    if(rf.length){
      h+='<div style="margin:6px 0 8px;display:flex;flex-wrap:wrap;gap:6px">';
      for(const f of rf){
        if(f.type==='warning') h+='<span style="font-size:11px;padding:3px 8px;border-radius:6px;background:rgba(251,146,60,.12);color:#ea580c;font-weight:600">⚠️ '+esc(f.label)+'</span>';
        else if(f.type==='priority') h+='<span style="font-size:11px;padding:3px 8px;border-radius:6px;background:rgba(59,130,246,.08);color:#2563eb;font-weight:600">💰 '+esc(f.label)+'</span>';
      }
      h+='</div>';
    }

    // === ДЕЙСТВИЯ ЗА ДЕНЬ (collapsible, open by default) ===
    if(acts.length){
      const cid='acts_'+uid;
      h+='<div class="coll" style="background:#f9fafb">';
      h+='<div class="coll-hdr open" id="hdr_'+cid+'" onclick="toggleColl(&#39;'+cid+'&#39;)" style="color:#60a5fa;background:rgba(96,165,250,.06)">';
      h+='<span class="arr">▶</span> 📅 Действия за '+esc(selectedDate||'')+' <span style="color:#6b7280;font-weight:500;margin-left:4px">('+acts.length+')</span></div>';
      h+='<div class="coll-body open" id="body_'+cid+'"><div class="coll-inner">';
      for(let ai=0;ai<acts.length;ai++){
        const a=acts[ai];
        const isCall=a.type==='outCall'||a.type==='inCall'||a.type==='ndz';
        const icon=a.type==='outCall'?'📤':a.type==='inCall'?'📥':a.type==='ndz'?'⏰':'📝';
        const lbl=a.type==='outCall'?'Исходящий':a.type==='inCall'?'Входящий':a.type==='ndz'?'НДЗ':'Заметка';
        const src=a.source==='contact'?' <span class="bg bg-p" style="font-size:9px">контакт</span>':'';
        const durMin=a.duration?Math.round(a.duration/60):0;
        const durCol=durMin>=3?'#34d399':durMin>=1?'#fbbf24':'#f87171';
        h+='<div style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,.03)">';
        h+='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
        h+='<span style="color:#60a5fa;font-weight:700;font-size:13px">'+esc(a.time||'?')+'</span>';
        h+='<span style="font-size:12px;font-weight:600;color:#1a1a2e">'+icon+' '+lbl+'</span>'+src;
        if(a.duration)h+='<span style="font-size:12px;font-weight:700;color:'+durCol+'">'+durMin+'м</span>';
        h+='</div>';
        if(isCall){
          const nextNote=acts.slice(ai+1).find(n=>n.type==='note'&&n.text&&Math.abs(timeToMin(n.time)-timeToMin(a.time))<5);
          if(nextNote&&nextNote.text){
            h+='<div style="margin-top:6px;padding:8px 12px;background:rgba(251,191,36,.06);border-left:3px solid #fbbf24;border-radius:0 8px 8px 0;font-size:12px;color:#1a1a2e;line-height:1.6">'+esc(nextNote.text.substring(0,300))+'</div>';
          }
        }
        if(a.text&&!isCall){
          h+='<div style="margin-top:6px;padding:8px 12px;background:rgba(148,163,184,.05);border-left:3px solid #d1d5db;border-radius:0 8px 8px 0;font-size:12px;color:#374151;line-height:1.6">'+esc(a.text.substring(0,400))+'</div>';
        }
        if(a.transcription){
          const tid='tr_day_'+d.id+'_'+ai;
          h+='<div style="margin-top:6px"><span style="font-size:10px;color:#16a34a;font-weight:600">✅ ИИ учёл этот звонок</span> ';
          h+='<button class="toggle-btn" onclick="toggleTr(&#39;'+tid+'&#39;)">🎙 Показать транскрибацию</button></div>';
          h+='<div id="'+tid+'" class="transcript" style="display:none;max-height:300px;overflow-y:auto;margin-top:4px;padding:8px 12px;background:rgba(96,165,250,.04);border-left:3px solid #60a5fa;border-radius:0 8px 8px 0;font-size:11px;color:#374151;line-height:1.5">'+esc(a.transcription)+'</div>';
        } else if(callNeedsTranscript(a)){
          h+='<div style="margin-top:4px"><span style="font-size:10px;color:#f87171;font-weight:600">⚠️ Транскрибация отсутствует — ИИ не видел содержание звонка</span></div>';
        }
        h+='</div>';
      }
      h+='</div></div></div>';
    }

    // === ИСТОРИЯ СДЕЛКИ (collapsible, closed by default) ===
    const hist=(da.allComments||[]).filter(c=>c.date!==selectedDate&&c.text.length>5);
    if(hist.length){
      const cid='hist_'+uid;
      h+='<div class="coll" style="background:rgba(100,116,139,.04)">';
      h+='<div class="coll-hdr" id="hdr_'+cid+'" onclick="toggleColl(&#39;'+cid+'&#39;)" style="color:#6b7280;background:rgba(100,116,139,.06)">';
      h+='<span class="arr">▶</span> 📜 История сделки <span style="color:#6b7280;font-weight:500;margin-left:4px">('+hist.length+' записей)</span></div>';
      h+='<div class="coll-body" id="body_'+cid+'"><div class="coll-inner" style="max-height:350px;overflow-y:auto">';
      for(const c of hist.slice(0,30)){
        const icon=c.type==='outCall'?'📤':c.type==='inCall'?'📥':c.type==='ndz'?'⏰':'📝';
        h+='<div style="padding:4px 0;border-bottom:1px solid rgba(0,0,0,.03)">';
        h+='<span style="color:#6b7280;font-size:10px;font-weight:600">'+esc(c.date)+' '+esc(c.time)+'</span> '+icon+' ';
        h+='<span style="font-size:11px;color:#6b7280">'+esc(c.text.substring(0,150))+'</span>';
        if(c.transcription){
          const tid='tr_hist_'+d.id+'_'+c.id;
          h+=' <span style="font-size:9px;color:#16a34a">✅</span> <button class="toggle-btn" onclick="toggleTr(&#39;'+tid+'&#39;)" style="font-size:9px">транскр.</button>';
          h+='<div id="'+tid+'" class="transcript" style="display:none;max-height:150px">'+esc(c.transcription)+'</div>';
        } else if(callNeedsTranscript(c)){
          h+=' <span style="font-size:9px;color:#f87171">⚠️ нет транскр.</span>';
        }
        h+='</div>';
      }
      h+='</div></div></div>';
    }

    // === СКРИПТ ПРОДАЖ (collapsible, closed by default) ===
    const vp=aa.verbalPresentation;
    const wp=aa.writtenPresentation;
    const hasAssessment=vp||wp||aa.cp||aa.invoice||aa.callToAction||aa.objectionHandling;
    if(hasAssessment){
      const cid='script_'+uid;
      h+='<div class="coll" style="background:rgba(59,130,246,.03)">';
      h+='<div class="coll-hdr" id="hdr_'+cid+'" onclick="toggleColl(&#39;'+cid+'&#39;)" style="color:#60a5fa;background:rgba(59,130,246,.06)">';
      h+='<span class="arr">▶</span> 📋 Скрипт продаж (ИИ-оценка по всей истории)';
      // Mini score in header
      if(dss.total!==undefined)h+=' <span style="margin-left:auto;color:'+dsCol+';font-size:11px">'+dss.total+'/'+dss.max+'б</span>';
      h+='</div>';
      h+='<div class="coll-body" id="body_'+cid+'"><div class="coll-inner">';

      // Устная презентация
      if(vp){
        const qual=vp.quality||'';
        const vpSrc=(vp.source||'').toLowerCase();
        const isCall=vpSrc==='call'||vpSrc==='звонок';
        const qCol=qual.includes('хорошо')?'#34d399':qual.includes('средне')?'#fbbf24':'#f87171';
        const vpIsCall=isCall;
        const vpBorderCol=vp.overall?(vpIsCall?'rgba(52,211,153,.3)':'rgba(251,191,36,.3)'):'rgba(248,113,113,.2)';
        const vpTitleCol=vp.overall?(vpIsCall?'#34d399':'#fbbf24'):'#f87171';
        h+='<div style="margin-bottom:10px;padding:10px 12px;background:'+(vpIsCall?'rgba(52,211,153,.04)':'rgba(251,191,36,.04)')+';border:1px solid '+vpBorderCol+';border-radius:8px">';
        h+='<div style="font-size:12px;font-weight:700;color:'+vpTitleCol+';margin-bottom:6px">🎙 Устная презентация';
        if(vp.overall)h+=' <span class="bg" style="font-size:9px;background:'+(isCall?'rgba(52,211,153,.15);color:#34d399':'rgba(251,191,36,.15);color:#fbbf24')+'">'+(isCall?'звонок 3б':'переписка 1.5б')+'</span>';
        if(qual)h+=' — <span style="color:'+qCol+'">'+esc(qual)+'</span>';
        h+='</div>';
        const prItems=aa.dealType==='asphalt'?[
          {k:'since2014',l:'С 2014 года'},
          {k:'fiveBrigades',l:'5 бригад + геодезист/проектировщик'},
          {k:'fullCycle',l:'Полный цикл работ'},
          {k:'bigProjects',l:'Крупные объекты'},
          {k:'guarantee',l:'Гарантия + бригадир + фото-отчёт'},
        ]:[
          {k:'since2014',l:'Работаем с 2014 года'},
          {k:'manyObjects',l:'Много объектов по Москве'},
          {k:'govClients',l:'Госдума и госучреждения'},
          {k:'reliableInSnow',l:'Надежность в снегопады'},
          {k:'manyVehicles',l:'Много техники'},
        ];
        for(const it of prItems){
          const v=vp[it.k];
          if(!v)continue;
          const vpItemCol=v.done?(vpIsCall?'#34d399':'#fbbf24'):'#f87171';
          h+='<div style="font-size:11px;margin:3px 0;margin-left:12px"><span style="color:'+vpItemCol+'">'+(v.done?(vpIsCall?'✅':'☑️'):'❌')+'</span> '+it.l;
          if(v.note)h+=' <span style="color:#6b7280;font-size:10px">— '+esc(v.note)+'</span>';
          h+='</div>';
        }
        h+='</div>';
      }

      // Чек-лист items
      const checkItems=[];
      const hw=aa.howWeWork;
      if(hw){
        const hwSrc=hw.source==='call'||hw.source==='звонок';
        checkItems.push({done:hw.done,label:'Как мы работаем',badge:hw.done?(hwSrc?'звонок 3б':'переписка 1.5б'):'',badgeCall:hwSrc,isText:hw.done&&!hwSrc,note:hw.note});
      }
      if(wp) checkItems.push({done:wp.done,label:'Презентация (файл)',badge:wp.done?'1б':'',note:wp.note});
      if(aa.cp) checkItems.push({done:aa.cp.done,label:'КП',badge:aa.cp.done?'1б':'',note:aa.cp.note});
      if(aa.invoice) checkItems.push({done:aa.invoice.done,label:'Счёт',badge:aa.invoice.done?'1б':'',note:aa.invoice.note});
      const ctaSrc=aa.callToAction&&aa.callToAction.source;
      const ctaIsCall=ctaSrc==='call'||ctaSrc==='звонок';
      if(aa.callToAction) checkItems.push({done:aa.callToAction.done,label:'Призыв к действию',badge:aa.callToAction.done?(ctaIsCall?'звонок 3б':'переписка 3б'):'',badgeCall:ctaIsCall,isText:aa.callToAction.done&&!ctaIsCall,note:aa.callToAction.note});
      if(aa.objectionHandling) checkItems.push({done:aa.objectionHandling.done,label:'Отработка возражений',badge:'',note:aa.objectionHandling.note});

      if(checkItems.length){
        h+='<div style="display:grid;gap:4px;margin-bottom:10px">';
        for(const ci of checkItems){
          const ciBorderCol=ci.done?(ci.isText?'#fbbf24':'#34d399'):'rgba(248,113,113,.4)';
          h+='<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(0,0,0,.02);border-radius:6px;border-left:3px solid '+ciBorderCol+'">';
          h+='<span style="font-size:14px">'+(ci.done?(ci.isText?'☑️':'✅'):'❌')+'</span>';
          h+='<span style="font-size:12px;font-weight:600;color:'+(ci.done?'#1a1a2e':'#9ca3af')+'">'+ci.label+'</span>';
          if(ci.badge){
            const bgCol=ci.badgeCall?'rgba(52,211,153,.15)':'rgba(251,191,36,.15)';
            const txCol=ci.badgeCall?'#34d399':'#fbbf24';
            h+='<span class="bg" style="font-size:9px;background:'+bgCol+';color:'+txCol+'">'+ci.badge+'</span>';
          }
          if(ci.note)h+='<span style="color:#6b7280;font-size:10px;margin-left:auto">'+esc(ci.note)+'</span>';
          h+='</div>';
        }
        h+='</div>';
      }

      // === БАЛЛЫ ДЛЯ ЗП ===
      const ss=aa.salaryScore;
      if(ss){
        const pct=ss.max?Math.round(ss.total/ss.max*100):0;
        const col=pct>=70?'#34d399':pct>=40?'#fbbf24':'#f87171';
        h+='<div style="padding:10px 12px;background:rgba(251,191,36,.05);border:1px solid rgba(251,191,36,.12);border-radius:8px">';
        h+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">';
        h+='<span style="font-size:12px;font-weight:700;color:'+col+'">💰 Баллы для ЗП</span>';
        h+='<span style="font-size:16px;font-weight:800;color:'+col+'">'+ss.total+' / '+ss.max+'</span>';
        h+='</div>';
        h+='<div style="background:rgba(0,0,0,.05);border-radius:4px;height:8px;margin-bottom:8px"><div style="background:'+col+';height:100%;border-radius:4px;width:'+pct+'%;transition:width .3s"></div></div>';
        if(ss.items&&ss.items.length){
          for(const it of ss.items){
            h+='<div style="font-size:10px;color:#6b7280;padding:2px 0">✅ '+esc(it.name)+': <strong style="color:'+col+'">+'+it.score+'</strong>';
            if(it.note)h+=' <span style="color:#6b7280">— '+esc(it.note)+'</span>';
            h+='</div>';
          }
        }
        const missing=[];
        const textWarnings=[];
        if(!aa.cp||!aa.cp.done) missing.push('КП (1б)');
        if(!aa.invoice||!aa.invoice.done) missing.push('Счёт (1б)');
        if(!aa.writtenPresentation||!aa.writtenPresentation.done) missing.push('Презентация-файл (1б)');
        const vpDone=aa.verbalPresentation&&aa.verbalPresentation.overall;
        if(!vpDone) missing.push('Устная презентация (до 3б)');
        else if(vp&&vp.source!=='call'&&vp.source!=='звонок') textWarnings.push('Устная презентация — 1.5б вместо 3б (переписка, не звонок)');
        const hwDone=aa.howWeWork&&aa.howWeWork.done;
        if(!hwDone) missing.push('Как мы работаем (до 3б)');
        else if(hw&&hw.source!=='call'&&hw.source!=='звонок') textWarnings.push('Как мы работаем — 1.5б вместо 3б (переписка, не звонок)');
        const ctaDone=aa.callToAction&&aa.callToAction.done;
        if(!ctaDone) missing.push('Призыв к действию (3б)');
        if(missing.length){
          h+='<div style="font-size:10px;color:#f87171;margin-top:6px;padding-top:6px;border-top:1px solid rgba(0,0,0,.03)">Не набрано: '+esc(missing.join(', '))+'</div>';
        }
        if(textWarnings.length){
          h+='<div style="font-size:10px;color:#fbbf24;margin-top:4px">⚠️ Балл снижен: '+esc(textWarnings.join('; '))+'. Рекомендуем проговаривать по телефону!</div>';
        }
        h+='</div>';
      }

      // Planfix анализ за сегодня
      const pf=da.planfixScript;
      if(pf){
        h+='<div style="margin-top:8px;padding:6px 10px;background:rgba(100,116,139,.06);border-radius:6px;font-size:10px;color:#6b7280">';
        h+='Planfix ('+esc(D.reportDate||'')+'): '+pf.totalBalls+'б | '+esc((pf.verdict||'').split('(')[0].trim());
        h+=' | Презент:'+yn(pf.howWeWork)+' Призыв:'+yn(pf.callToAction)+' Счёт:'+yn(pf.sentInvoice);
        h+='</div>';
      }

      h+='</div></div></div>'; // end coll-inner, coll-body, coll
    }

    // === ЧТО НЕ ХВАТАЕТ + РЕКОМЕНДАЦИИ (collapsible, open if has missing) ===
    if(aa.missing||aa.recommendations){
      const miss=aa.missing||[];
      const recs=aa.recommendations||[];
      const cid='recs_'+uid;
      const hasImportant=miss.length>0;
      h+='<div class="coll" style="background:rgba(139,92,246,.03)">';
      h+='<div class="coll-hdr'+(hasImportant?' open':'')+'" id="hdr_'+cid+'" onclick="toggleColl(&#39;'+cid+'&#39;)" style="color:#a78bfa;background:rgba(139,92,246,.06)">';
      h+='<span class="arr">▶</span>';
      if(miss.length)h+=' ❗ Что не выполнено ('+miss.length+')';
      if(recs.length)h+=(miss.length?' + ':' ')+'💡 Рекомендации ('+recs.length+')';
      h+='</div>';
      h+='<div class="coll-body'+(hasImportant?' open':'')+'" id="body_'+cid+'"><div class="coll-inner">';

      if(miss.length){
        h+='<div style="margin-bottom:8px">';
        for(const m of miss){
          h+='<div style="font-size:11px;color:#fca5a5;padding:3px 0;padding-left:8px;border-left:2px solid rgba(248,113,113,.3)">• '+esc(m)+'</div>';
        }
        h+='</div>';
      }

      if(recs.length){
        h+='<div>';
        for(const r of recs){
          h+='<div style="font-size:11px;color:#6ee7b7;padding:3px 0;padding-left:8px;border-left:2px solid rgba(52,211,153,.3)">• '+esc(r)+'</div>';
        }
        h+='</div>';
      }

      h+='<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">';
      h+='<button id="pf_btn_'+d.id+'" onclick="copyRecommendation('+d.id+')" style="padding:6px 14px;font-size:11px;font-weight:600;color:#60a5fa;background:rgba(96,165,250,.1);border:1px solid rgba(96,165,250,.25);border-radius:6px;cursor:pointer;transition:.2s">📋 Копировать</button>';
      h+='<button id="pf_send_'+d.id+'" onclick="sendToPlanfix('+d.id+')" style="padding:6px 14px;font-size:11px;font-weight:600;color:#818cf8;background:rgba(129,140,248,.1);border:1px solid rgba(129,140,248,.25);border-radius:6px;cursor:pointer;transition:.2s">📤 Planfix</button>';
      h+='</div>';

      h+='</div></div></div>'; // end coll
    }

    h+='</div>'; // end card-body
    h+='</div>'; // end card
  }

  document.getElementById('out').innerHTML=h;
}

// === СДЕЛКИ + ЗВОНКИ ===
