function renderDeals(cards){
  if(!cards.length){document.getElementById('out').innerHTML='<div class="no-data">Нет данных за период</div>';return}
  const sorted=[...cards].sort((a,b)=>b.fCalls.length-a.fCalls.length||b.id-a.id);
  let h='';
  for(const d of sorted){
    const durM=Math.round(d.fCalls.reduce((s,c)=>s+c.duration,0)/60);
    const avgB=d.fAnalyses.length?Math.round(d.fAnalyses.reduce((s,a)=>s+a.totalBalls,0)/d.fAnalyses.length*10)/10:null;
    h+='<div class="sec"><div class="deal-hdr"><div><h3>#'+d.id+' '+esc(d.name.substring(0,55))+'</h3>';
    h+='<div class="deal-meta"><span>'+esc(d.counterparty)+'</span>';
    h+='<span class="bg bg-b">'+esc(d.status)+'</span>';
    if(d.isNew)h+=' <span class="bg bg-p">Новая</span>';
    h+='</div></div>';
    h+='<div class="deal-stat">';
    h+='<span style="color:#60a5fa">📞 '+d.fCalls.length+'</span>';
    h+='<span style="color:#818cf8">⏱ '+durM+'м</span>';
    if(d.fAnalyses.length)h+='<span style="color:#f472b6">📊 '+d.fAnalyses.length+'</span>';
    if(avgB!==null){
      const ac=avgB>=15?'#34d399':avgB>=10?'#fbbf24':'#f87171';
      h+='<span style="color:'+ac+'">'+avgB+'б</span>';
    }
    h+='</div></div>';

    // Таблица звонков
    if(d.fCalls.length){
      h+='<table style="margin-top:10px"><tr><th>Дата</th><th>Время</th><th>Тип</th><th>Длит.</th><th>Контакт</th><th>Как раб.</th><th>Призыв</th><th>Счёт</th><th>Баллы</th><th>Вердикт</th></tr>';
      const sortedCalls=[...d.fCalls].sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
      for(const c of sortedCalls){
        const dur=c.duration>=60?Math.round(c.duration/60)+'м':c.duration+'с';
        const cMin=timeToMin(c.time);
        const matchA=d.fAnalyses.find(a=>{
          if(a.date!==c.date)return false;
          return Math.abs(timeToMin(a.time)-cMin)<10;
        });
        h+='<tr><td style="white-space:nowrap;font-size:11px">'+esc(c.date)+'</td>';
        h+='<td>'+esc((c.time||'').split('-')[0].trim())+'</td>';
        h+='<td>'+(c.type==='Входящий'?'📥':'📤')+'</td>';
        h+='<td>'+dur+'</td>';
        h+='<td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(c.contact.substring(0,20))+'</td>';
        if(matchA){
          h+='<td>'+yn(matchA.howWeWork)+'</td><td>'+yn(matchA.callToAction)+'</td><td>'+yn(matchA.sentInvoice)+'</td>';
          const vc=matchA.verdict.includes('Эксперт')?'bg-b':matchA.verdict.includes('Хорошо')?'bg-g':matchA.verdict.includes('Средне')?'bg-y':'bg-r';
          h+='<td><strong>'+matchA.totalBalls+'</strong></td>';
          h+='<td><span class="bg '+vc+'">'+esc(matchA.verdict.split('(')[0].trim())+'</span></td>';
        } else {
          h+='<td colspan="5" style="color:#6b7280;font-size:11px">'+(c.duration<30?'Короткий':'Нет анализа')+'</td>';
        }
        h+='</tr>';
      }
      h+='</table>';
    }

    // Транскрибации звонков
    const callsWithTranscript=d.fComments.filter(c=>(c.type==='outCall'||c.type==='inCall'||c.type==='ndz')&&c.transcription);
    if(callsWithTranscript.length){
      h+='<h4>🎙 Транскрибации ('+callsWithTranscript.length+')</h4>';
      for(const c of callsWithTranscript.slice(0,5)){
        const tid='tr_'+d.id+'_'+c.id;
        const src=c.source==='contact'?' <span class="bg bg-p">👤 контакт</span>':'';
        h+='<div style="margin-bottom:6px"><button class="toggle-btn" onclick="toggleTr(&#39;'+tid+'&#39;)">'+(c.type==='outCall'?'📤':c.type==='inCall'?'📥':'⏰')+' '+esc(c.date)+' '+esc(c.time)+'</button>'+src+' <span style="font-size:10px;color:#475069">показать/скрыть</span>';
        h+='<div id="'+tid+'" class="transcript" style="display:none">'+esc(c.transcription)+'</div></div>';
      }
    }

    // Заметки
    const notes=d.fComments.filter(c=>c.type==='note'&&c.text.length>5).slice(0,5);
    if(notes.length){
      h+='<h4>💬 Заметки</h4>';
      for(const n of notes){
        h+='<div class="cmt"><span style="color:#6b7280;font-size:10px">'+esc(n.date)+' '+esc(n.time)+'</span> '+esc(n.text.substring(0,120))+'</div>';
      }
    }
    h+='</div>';
  }
  document.getElementById('out').innerHTML=h;
}

// === КАЧЕСТВО ===
function renderDealsV2(cards){
  if(!cards.length){document.getElementById('out').innerHTML='<div class="no-data">Нет данных за период</div>';return}
  const query=(dealSearch||'').trim().toLowerCase();
  const statusOptions=[...new Set(cards.map(d=>d.status).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
  // Конвертация DD-MM-YYYY → YYYY-MM-DD для сравнения с date input
  function dmyToIso(d){if(!d)return '';var p=d.split('-');return p.length===3&&p[2].length===4?p[2]+'-'+p[1]+'-'+p[0]:d;}
  function inDealRange(dateStr){
    if(!dealFrom&&!dealTo)return true;
    var iso=dmyToIso(dateStr);
    if(dealFrom&&iso<dealFrom)return false;
    if(dealTo&&iso>dealTo)return false;
    return true;
  }
  var hasDealRange=!!(dealFrom||dealTo);
  const prepared=cards.map(d=>{
    // Фильтрация данных по выбранному периоду
    const fCalls=hasDealRange?d.fCalls.filter(c=>inDealRange(c.date)):d.fCalls;
    const fComments=hasDealRange?d.fComments.filter(c=>inDealRange(c.date)):d.fComments;
    const fAnalyses=hasDealRange?d.fAnalyses.filter(a=>inDealRange(a.date)):d.fAnalyses;
    const transcripts=fComments.filter(c=>(c.type==='outCall'||c.type==='inCall'||c.type==='ndz')&&c.transcription);
    const notes=fComments.filter(c=>c.type==='note'&&c.text.length>5);
    const durM=Math.round(fCalls.reduce((s,c)=>s+c.duration,0)/60);
    // ИИ salaryScore (из 12) — приоритет, иначе Planfix анализы
    const aiData=findLatestAiForDeal(d.id);
    const aiScore=aiData&&aiData.salaryScore?aiData.salaryScore:null;
    const avgB=aiScore?aiScore.total:fAnalyses.length?Math.round(fAnalyses.reduce((s,a)=>s+a.totalBalls,0)/fAnalyses.length*10)/10:null;
    const maxB=aiScore?aiScore.max:29;
    const lastTouch=getLastTouch(d);
    return {
      ...d,
      fCalls,fComments,fAnalyses,
      ui:{
        transcripts,
        notes,
        durM,
        avgB,
        maxB,
        lastTouch,
        lastStamp:lastTouch?dateStamp(lastTouch.date,lastTouch.time):0,
      }
    };
  }).filter(d=>{
    if(!dealHasQuery(d,query))return false;
    if(dealStatus!=='all'&&d.status!==dealStatus)return false;
    if(dealFocus==='new'&&!d.isNew)return false;
    if(dealFocus==='calls'&&!d.fCalls.length)return false;
    if(dealFocus==='analyses'&&!d.fAnalyses.length)return false;
    if(dealFocus==='transcripts'&&!d.ui.transcripts.length)return false;
    if(dealFocus==='notes'&&!d.ui.notes.length)return false;
    // Фильтр по периоду: показывать только сделки с активностью в диапазоне
    if(hasDealRange&&!d.fCalls.length&&!d.fComments.length&&!d.fAnalyses.length)return false;
    return true;
  });

  prepared.sort((a,b)=>{
    if(dealSort==='latest')return b.ui.lastStamp-a.ui.lastStamp||b.id-a.id;
    if(dealSort==='score')return (b.ui.avgB??-1)-(a.ui.avgB??-1)||b.ui.lastStamp-a.ui.lastStamp;
    if(dealSort==='sum')return (b.dealSum||0)-(a.dealSum||0)||b.ui.lastStamp-a.ui.lastStamp;
    if(dealSort==='name')return (a.name||'').localeCompare(b.name||'','ru');
    return b.fCalls.length-a.fCalls.length||b.fAnalyses.length-a.fAnalyses.length||b.ui.lastStamp-a.ui.lastStamp||b.id-a.id;
  });

  const visibleCalls=prepared.reduce((s,d)=>s+d.fCalls.length,0);
  const visibleAnalyses=prepared.reduce((s,d)=>s+d.fAnalyses.length,0);
  const visibleTranscripts=prepared.reduce((s,d)=>s+d.ui.transcripts.length,0);
  const visibleNew=prepared.filter(d=>d.isNew).length;
  const anyOpen=prepared.some(d=>cardOpenState['deal_'+d.id]);
  const hasFilters=!!dealSearch||dealStatus!=='all'||dealFocus!=='all'||dealSort!=='activity'||!!dealFrom||!!dealTo;

  let h='<div class="deal-tools">';
  h+='<div class="deal-tools-grid">';
  h+='<div class="deal-field"><span class="deal-label">Поиск</span><input id="dealSearch" class="deal-input" type="text" placeholder="ID, название, контрагент, статус" value="'+esc(dealSearch)+'" oninput="setDealSearch(this.value,this.selectionStart)"></div>';
  h+='<div class="deal-field"><span class="deal-label">Статус</span><select class="deal-select" onchange="setDealStatus(this.value)">';
  h+='<option value="all"'+(dealStatus==='all'?' selected':'')+'>Все статусы</option>';
  for(const status of statusOptions){
    h+='<option value="'+esc(status)+'"'+(dealStatus===status?' selected':'')+'>'+esc(status)+'</option>';
  }
  h+='</select></div>';
  h+='<div class="deal-field"><span class="deal-label">Фокус</span><select class="deal-select" onchange="setDealFocus(this.value)">';
  h+='<option value="all"'+(dealFocus==='all'?' selected':'')+'>Все сделки</option>';
  h+='<option value="new"'+(dealFocus==='new'?' selected':'')+'>Только новые</option>';
  h+='<option value="calls"'+(dealFocus==='calls'?' selected':'')+'>Есть звонки</option>';
  h+='<option value="analyses"'+(dealFocus==='analyses'?' selected':'')+'>Есть анализы</option>';
  h+='<option value="transcripts"'+(dealFocus==='transcripts'?' selected':'')+'>Есть транскрипции</option>';
  h+='<option value="notes"'+(dealFocus==='notes'?' selected':'')+'>Есть заметки</option>';
  h+='</select></div>';
  h+='<div class="deal-field"><span class="deal-label">Сортировка</span><select class="deal-select" onchange="setDealSort(this.value)">';
  h+='<option value="activity"'+(dealSort==='activity'?' selected':'')+'>По активности</option>';
  h+='<option value="latest"'+(dealSort==='latest'?' selected':'')+'>Последнее касание</option>';
  h+='<option value="score"'+(dealSort==='score'?' selected':'')+'>Средний балл</option>';
  h+='<option value="sum"'+(dealSort==='sum'?' selected':'')+'>Сумма сделки</option>';
  h+='<option value="name"'+(dealSort==='name'?' selected':'')+'>По названию</option>';
  h+='</select></div>';
  h+='</div>';
  // Фильтр по периоду (от — до)
  h+='<div style="display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap">';
  h+='<span style="font-size:11px;color:#6b7280">с</span>';
  h+='<input type="date" id="dealFrom" value="'+(dealFrom||'')+'" onchange="dealFrom=this.value;renderDealsV2(currentCards)" style="background:#fff;border:1px solid rgba(0,0,0,.1);color:#1a1a2e;padding:4px 8px;border-radius:6px;font-size:11px;font-family:inherit">';
  h+='<span style="font-size:11px;color:#6b7280">по</span>';
  h+='<input type="date" id="dealTo" value="'+(dealTo||'')+'" onchange="dealTo=this.value;renderDealsV2(currentCards)" style="background:#fff;border:1px solid rgba(0,0,0,.1);color:#1a1a2e;padding:4px 8px;border-radius:6px;font-size:11px;font-family:inherit">';
  if(dealFrom||dealTo)h+='<button class="toggle-btn" onclick="dealFrom=\'\';dealTo=\'\';renderDealsV2(currentCards)" style="font-size:11px;padding:3px 8px">✕</button>';
  h+='</div>';
  h+='<div class="deal-tools-row"><div class="deal-chips">';
  h+='<div class="deal-chip">Показано <strong>'+prepared.length+'</strong> из '+cards.length+'</div>';
  h+='<div class="deal-chip">Звонки <strong>'+visibleCalls+'</strong></div>';
  h+='<div class="deal-chip">Анализы <strong>'+visibleAnalyses+'</strong></div>';
  h+='<div class="deal-chip">Транскрипции <strong>'+visibleTranscripts+'</strong></div>';
  h+='<div class="deal-chip">Новые <strong>'+visibleNew+'</strong></div>';
  h+='</div><div style="display:flex;gap:8px;flex-wrap:wrap">';
  h+='<button id="toggleAllBtn" class="toggle-btn" onclick="toggleAllCards()">'+(anyOpen?'📁 Свернуть всё':'📂 Развернуть всё')+'</button>';
  if(hasFilters)h+='<button class="toggle-btn" onclick="resetDealFilters()">Сбросить фильтры</button>';
  h+='</div></div></div>';

  if(!prepared.length){
    h+='<div class="deal-empty">Ничего не найдено. Попробуйте изменить поиск, статус или фокус.</div>';
    document.getElementById('out').innerHTML=h;
    return;
  }

  for(const d of prepared){
    const avgB=d.ui.avgB;
    const scoreColor=getScoreColor(avgB,d.ui.maxB);
    const transcripts=d.ui.transcripts;
    const notes=d.ui.notes;
    const topNote=notes[0]?notes[0].text.substring(0,160):'';
    const cardId='deal_'+d.id;
    const isOpen=!!cardOpenState[cardId];
    const lastTouchLabel=d.ui.lastTouch?formatTouch(d.ui.lastTouch.date,d.ui.lastTouch.time):'Нет касаний';
    const statusClass=(d.status||'').includes('Договор')||(d.status||'').includes('Выполнение')||(d.status||'').includes('Сделка')?'bg-g':(d.status||'').includes('Коммерческое')||(d.status||'').includes('Дожим')?'bg-b':(d.status||'').includes('Новая')||(d.status||'').includes('Обработка')?'bg-y':'bg-p';
    const borderColor=d.isNew?'#a78bfa':avgB!==null?scoreColor:(d.fCalls.length?'#2563eb':'#d1d5db');
    h+='<div class="deal-card" style="border-left:3px solid '+borderColor+'">';
    h+='<div class="deal-card-top'+(isOpen?' open':'')+'" id="chdr_'+cardId+'" onclick="toggleCard(&#39;'+cardId+'&#39;)">';
    h+='<div style="flex:1;min-width:220px">';
    h+='<div class="deal-card-title"><span class="card-arrow">▸</span> #'+d.id+' '+esc((d.name||'').substring(0,80))+'</div>';
    h+='<div class="deal-card-meta">';
    h+='<span style="font-size:12px;color:#6b7280">'+esc((d.counterparty||'Без контрагента').substring(0,60))+'</span>';
    h+='<span class="bg '+statusClass+'">'+esc(d.status||'Без статуса')+'</span>';
    if(d.isNew)h+='<span class="bg bg-p">Новая</span>';
    if(transcripts.length)h+='<span class="bg bg-b">🎙 '+transcripts.length+'</span>';
    if(notes.length)h+='<span class="bg bg-y">💬 '+notes.length+'</span>';
    h+='</div></div>';
    h+='<div class="deal-kpis">';
    h+='<div class="deal-kpi"><span class="deal-kpi-v" style="color:#60a5fa">'+d.fCalls.length+'</span><span class="deal-kpi-l">Звонков</span></div>';
    h+='<div class="deal-kpi"><span class="deal-kpi-v" style="color:#818cf8">'+d.ui.durM+'м</span><span class="deal-kpi-l">Время</span></div>';
    h+='<div class="deal-kpi"><span class="deal-kpi-v" style="color:'+scoreColor+'">'+(avgB===null?'—':avgB+'/'+d.ui.maxB)+'</span><span class="deal-kpi-l">Средний балл</span></div>';
    h+='<div class="deal-kpi"><span class="deal-kpi-v" style="color:#1a1a2e">'+(d.dealSum?fmt(d.dealSum):'—')+'</span><span class="deal-kpi-l">Сумма</span></div>';
    h+='</div></div>';

    h+='<div class="deal-card-body'+(isOpen?' open':'')+'" id="cbody_'+cardId+'">';
    h+='<div class="deal-summary">';
    h+='<div class="deal-summary-item"><b>Последнее касание</b><span>'+esc(lastTouchLabel)+'</span></div>';
    h+='<div class="deal-summary-item"><b>Контрагент</b><span>'+esc(d.counterparty||'Не указан')+'</span></div>';
    h+='<div class="deal-summary-item"><b>Сигналы по сделке</b><span>Звонки: '+d.fCalls.length+' · Анализы: '+d.fAnalyses.length+' · Заметки: '+notes.length+'</span></div>';
    h+='<div class="deal-summary-item"><b>Последняя заметка</b><span>'+(topNote?esc(topNote):'Нет заметок в периоде')+'</span></div>';
    h+='</div>';

    if(d.fCalls.length){
      h+='<div class="deal-section-title"><h4>📞 Звонки</h4><span class="deal-caption">'+d.fCalls.length+' за выбранный период</span></div>';
      h+='<div class="deal-table-wrap"><table><tr><th>Дата</th><th>Время</th><th>Тип</th><th>Длит.</th><th>Контакт</th><th>Как работаем</th><th>Призыв</th><th>Счёт</th><th>Баллы</th><th>Вердикт</th></tr>';
      const sortedCalls=[...d.fCalls].sort((a,b)=>dateStamp(b.date,b.time)-dateStamp(a.date,a.time));
      for(const c of sortedCalls){
        const dur=c.duration>=60?Math.round(c.duration/60)+'м':c.duration+'с';
        const cMin=timeToMin(c.time);
        const matchA=d.fAnalyses.find(a=>{
          if(a.date!==c.date)return false;
          return Math.abs(timeToMin(a.time)-cMin)<10;
        });
        h+='<tr><td style="white-space:nowrap;font-size:11px">'+esc(c.date)+'</td>';
        h+='<td>'+esc((c.time||'').split('-')[0].trim())+'</td>';
        h+='<td>'+(c.type==='Входящий'?'📥':'📤')+'</td>';
        h+='<td>'+dur+'</td>';
        h+='<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((c.contact||'').substring(0,26))+'</td>';
        if(matchA){
          h+='<td>'+yn(matchA.howWeWork)+'</td><td>'+yn(matchA.callToAction)+'</td><td>'+yn(matchA.sentInvoice)+'</td>';
          const vc=matchA.verdict.includes('Эксперт')?'bg-b':matchA.verdict.includes('Хорошо')?'bg-g':matchA.verdict.includes('Средне')?'bg-y':'bg-r';
          h+='<td><strong>'+matchA.totalBalls+'</strong></td>';
          h+='<td><span class="bg '+vc+'">'+esc(matchA.verdict.split('(')[0].trim())+'</span></td>';
        } else {
          h+='<td colspan="5" style="color:#6b7280;font-size:11px">'+(c.duration<30?'Короткий звонок':'Нет анализа')+'</td>';
        }
        h+='</tr>';
      }
      h+='</table></div>';
    } else {
      h+='<div class="deal-empty">По этой сделке нет звонков в выбранном периоде.</div>';
    }

    if(transcripts.length){
      h+='<div class="deal-section-title"><h4>🎙 Транскрипции</h4><span class="deal-caption">'+transcripts.length+' записей</span></div>';
      for(const c of transcripts.slice(0,6)){
        const tid='tr_'+d.id+'_'+c.id;
        const src=c.source==='contact'?' <span class="bg bg-p">контакт</span>':'';
        h+='<div style="margin-bottom:8px"><button class="toggle-btn" onclick="toggleTr(&#39;'+tid+'&#39;)">'+(c.type==='outCall'?'📤':'📥')+' '+esc(c.date)+' '+esc(c.time)+'</button>'+src+' <span class="deal-caption">показать / скрыть</span>';
        h+='<div id="'+tid+'" class="transcript" style="display:none">'+esc(c.transcription)+'</div></div>';
      }
    }

    if(notes.length){
      h+='<div class="deal-section-title"><h4>💬 Заметки</h4><span class="deal-caption">'+notes.length+' записей</span></div>';
      for(const n of notes.slice(0,8)){
        h+='<div class="cmt"><span style="color:#6b7280;font-size:10px">'+esc(n.date)+' '+esc(n.time)+'</span> '+esc(n.text.substring(0,220))+'</div>';
      }
    }
    h+='</div></div>';
  }
  document.getElementById('out').innerHTML=h;
}
