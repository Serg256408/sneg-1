var activeDealId = null;
var dealDetailTab = 'summary';

function renderDeals(cards){
  renderDealsV2(cards);
}

function dealShort(text, max){
  text = String(text || '');
  if(text.length <= max) return text;
  return text.substring(0, max - 1).trim() + '…';
}

function dealDuration(seconds){
  seconds = Number(seconds || 0) || 0;
  if(seconds >= 60) return Math.round(seconds / 60) + 'м';
  return seconds + 'с';
}

function dealStatusClass(status){
  status = String(status || '');
  if(status.includes('Договор') || status.includes('Выполнение') || status.includes('Сделка')) return 'bg-g';
  if(status.includes('Коммерческое') || status.includes('Дожим') || status.includes('Замер')) return 'bg-b';
  if(status.includes('Новая') || status.includes('Обработка')) return 'bg-y';
  return 'bg-p';
}

function dealCallKind(type){
  var t = String(type || '').toLowerCase();
  if(t === 'incall' || t.includes('вход')) return 'Входящий';
  if(t === 'ndz' || t.includes('ндз')) return 'НДЗ';
  return 'Исходящий';
}

function getDealCallComments(deal){
  return (deal.fComments || []).filter(function(c){
    return c.type === 'outCall' || c.type === 'inCall' || c.type === 'ndz';
  });
}

function hasTranscriptNear(deal, call){
  return (deal.ui.transcripts || []).some(function(t){
    return t.date === call.date && Math.abs(timeToMin(t.time) - timeToMin(call.time)) < 5;
  });
}

function getDealIssues(deal){
  var flags = [];
  var ai = deal.ui.aiData;
  var callComments = getDealCallComments(deal);
  var withoutText = callComments.filter(function(c){
    return c.type !== 'ndz' && !c.transcription;
  }).length;
  var tagCallsWithoutText = (deal.fCalls || []).filter(function(c){return !hasTranscriptNear(deal, c);}).length;
  var missingTranscripts = Math.max(withoutText, tagCallsWithoutText);

  if(missingTranscripts > 0) flags.push({level:'bad', label:'Нет расшифровки: '+missingTranscripts});
  if(!ai && ((deal.fCalls || []).length || callComments.length)) {
    flags.push({level:'warn', label:(deal.fAnalyses || []).length ? 'Нет ИИ-оценки' : 'Нет анализа'});
  }
  if(ai && ai.missing && ai.missing.length) flags.push({level:'bad', label:'Скрипт: '+ai.missing.length+' пропусков'});
  if(deal.redFlags && deal.redFlags.length) flags.push({level:'bad', label:'Флаги: '+deal.redFlags.length});
  if(deal.isNew) flags.push({level:'info', label:'Новая'});
  return flags;
}

function prepareDealCards(cards){
  var hasDealRange = !!(dealFrom || dealTo);
  function dmyToIso(d){if(!d)return '';var p=d.split('-');return p.length===3&&p[2].length===4?p[2]+'-'+p[1]+'-'+p[0]:d;}
  function inDealRange(dateStr){
    if(!hasDealRange) return true;
    var iso = dmyToIso(dateStr);
    if(dealFrom && iso < dealFrom) return false;
    if(dealTo && iso > dealTo) return false;
    return true;
  }

  var query = (dealSearch || '').trim().toLowerCase();
  return cards.map(function(d){
    var fCalls = hasDealRange ? d.fCalls.filter(function(c){return inDealRange(c.date);}) : d.fCalls;
    var fComments = hasDealRange ? d.fComments.filter(function(c){return inDealRange(c.date);}) : d.fComments;
    var fAnalyses = hasDealRange ? d.fAnalyses.filter(function(a){return inDealRange(a.date);}) : d.fAnalyses;
    var transcripts = fComments.filter(function(c){
      return (c.type === 'outCall' || c.type === 'inCall' || c.type === 'ndz') && c.transcription;
    }).sort(function(a,b){return dateStamp(b.date,b.time)-dateStamp(a.date,a.time);});
    var notes = fComments.filter(function(c){return c.type === 'note' && String(c.text || '').trim().length > 5;})
      .sort(function(a,b){return dateStamp(b.date,b.time)-dateStamp(a.date,a.time);});
    var aiData = findLatestAiForDeal(d.id);
    var aiScore = aiData && aiData.salaryScore ? aiData.salaryScore : null;
    var avgB = aiScore ? aiScore.total : fAnalyses.length ? Math.round(fAnalyses.reduce(function(s,a){return s + a.totalBalls;},0) / fAnalyses.length * 10) / 10 : null;
    var maxB = aiScore ? aiScore.max : 29;
    var lastTouch = getLastTouch({...d, fCalls:fCalls, fComments:fComments, fAnalyses:fAnalyses});
    var prepared = {
      ...d,
      fCalls:fCalls,
      fComments:fComments,
      fAnalyses:fAnalyses,
      ui:{
        aiData:aiData,
        transcripts:transcripts,
        notes:notes,
        durM:Math.round(fCalls.reduce(function(s,c){return s + (c.duration || 0);},0) / 60),
        avgB:avgB,
        maxB:maxB,
        lastTouch:lastTouch,
        lastStamp:lastTouch ? dateStamp(lastTouch.date,lastTouch.time) : 0,
      }
    };
    prepared.ui.issues = getDealIssues(prepared);
    prepared.ui.issueCount = prepared.ui.issues.filter(function(x){return x.level === 'bad' || x.level === 'warn';}).length;
    return prepared;
  }).filter(function(d){
    if(!dealHasQuery(d, query)) return false;
    if(dealStatus !== 'all' && d.status !== dealStatus) return false;
    if(dealFocus === 'new' && !d.isNew) return false;
    if(dealFocus === 'calls' && !d.fCalls.length && !getDealCallComments(d).length) return false;
    if(dealFocus === 'analyses' && !d.fAnalyses.length) return false;
    if(dealFocus === 'transcripts' && !d.ui.transcripts.length) return false;
    if(dealFocus === 'notes' && !d.ui.notes.length) return false;
    if(dealFocus === 'issues' && !d.ui.issueCount) return false;
    if(dealFocus === 'untranscribed' && !d.ui.issues.some(function(x){return x.label.indexOf('расшифровки') >= 0;})) return false;
    if(dealFocus === 'high' && !(d.dealSum >= 1000000)) return false;
    if(hasDealRange && !d.fCalls.length && !d.fComments.length && !d.fAnalyses.length) return false;
    return true;
  }).sort(function(a,b){
    if(dealSort === 'latest') return b.ui.lastStamp - a.ui.lastStamp || b.id - a.id;
    if(dealSort === 'score') return (b.ui.avgB ?? -1) - (a.ui.avgB ?? -1) || b.ui.lastStamp - a.ui.lastStamp;
    if(dealSort === 'sum') return (b.dealSum || 0) - (a.dealSum || 0) || b.ui.lastStamp - a.ui.lastStamp;
    if(dealSort === 'name') return (a.name || '').localeCompare(b.name || '', 'ru');
    return b.ui.issueCount - a.ui.issueCount || b.fCalls.length - a.fCalls.length || b.ui.lastStamp - a.ui.lastStamp || b.id - a.id;
  });
}

function setActiveDeal(id){
  activeDealId = Number(id) || id;
  renderDealsV2(currentCards);
}

function setDealDetailTab(name){
  dealDetailTab = name || 'summary';
  renderDealsV2(currentCards);
}

function renderDealPills(deal){
  var h = '<span class="bg '+dealStatusClass(deal.status)+'">'+esc(deal.status || 'Без статуса')+'</span>';
  if(deal.isNew) h += '<span class="bg bg-p">Новая</span>';
  for(var i=0;i<Math.min(deal.ui.issues.length,3);i++){
    var f = deal.ui.issues[i];
    h += '<span class="deal-flag '+(f.level === 'bad' ? 'is-bad' : f.level === 'warn' ? 'is-warn' : 'is-info')+'">'+esc(f.label)+'</span>';
  }
  return h;
}

function renderDealIssuePills(deal){
  if(!deal.ui.issues.length) return '<span class="deal-quiet">—</span>';
  var h = '';
  for(var i=0;i<Math.min(deal.ui.issues.length,3);i++){
    var f = deal.ui.issues[i];
    h += '<span class="deal-flag '+(f.level === 'bad' ? 'is-bad' : f.level === 'warn' ? 'is-warn' : 'is-info')+'">'+esc(f.label)+'</span>';
  }
  return h;
}

function renderDealTools(prepared, cards, statusOptions, totals){
  var hasFilters = !!dealSearch || dealStatus !== 'all' || dealFocus !== 'all' || dealSort !== 'activity' || !!dealFrom || !!dealTo;
  var h = '<div class="deal-tools deal-command">';
  h += '<div class="deal-tools-head"><div><div class="deal-tools-kicker">Рабочий реестр</div><div class="deal-tools-title">Сделки</div></div>';
  h += '<div class="deal-view-actions">';
  h += '<button class="toggle-btn" onclick="setDealFocus(\'all\')">Все</button>';
  h += '<button class="toggle-btn '+(dealFocus==='issues'?'is-active':'')+'" onclick="setDealFocus(\'issues\')">Проблемы</button>';
  h += '<button class="toggle-btn '+(dealFocus==='untranscribed'?'is-active':'')+'" onclick="setDealFocus(\'untranscribed\')">Без расшифровки</button>';
  h += '<button class="toggle-btn '+(dealFocus==='high'?'is-active':'')+'" onclick="setDealFocus(\'high\')">Крупные</button>';
  if(hasFilters) h += '<button class="toggle-btn" onclick="resetDealFilters()">Сбросить</button>';
  h += '</div></div>';

  h += '<div class="deal-tools-grid">';
  h += '<div class="deal-field"><span class="deal-label">Поиск</span><input id="dealSearch" class="deal-input" type="text" placeholder="ID, сделка, контрагент, статус" value="'+esc(dealSearch)+'" oninput="setDealSearch(this.value,this.selectionStart)"></div>';
  h += '<div class="deal-field"><span class="deal-label">Статус</span><select class="deal-select" onchange="setDealStatus(this.value)">';
  h += '<option value="all"'+(dealStatus==='all'?' selected':'')+'>Все статусы</option>';
  for(var s=0;s<statusOptions.length;s++) h += '<option value="'+esc(statusOptions[s])+'"'+(dealStatus===statusOptions[s]?' selected':'')+'>'+esc(statusOptions[s])+'</option>';
  h += '</select></div>';
  h += '<div class="deal-field"><span class="deal-label">Фокус</span><select class="deal-select" onchange="setDealFocus(this.value)">';
  var focusOpts = [['all','Все сделки'],['new','Только новые'],['calls','Есть звонки'],['analyses','Есть анализы'],['transcripts','Есть транскрипции'],['notes','Есть заметки'],['issues','Есть проблемы'],['untranscribed','Без расшифровки'],['high','Крупные сделки']];
  for(var f=0;f<focusOpts.length;f++) h += '<option value="'+focusOpts[f][0]+'"'+(dealFocus===focusOpts[f][0]?' selected':'')+'>'+focusOpts[f][1]+'</option>';
  h += '</select></div>';
  h += '<div class="deal-field"><span class="deal-label">Сортировка</span><select class="deal-select" onchange="setDealSort(this.value)">';
  var sortOpts = [['activity','По проблемам и активности'],['latest','Последнее касание'],['score','Средний балл'],['sum','Сумма сделки'],['name','По названию']];
  for(var so=0;so<sortOpts.length;so++) h += '<option value="'+sortOpts[so][0]+'"'+(dealSort===sortOpts[so][0]?' selected':'')+'>'+sortOpts[so][1]+'</option>';
  h += '</select></div></div>';

  h += '<div class="deal-date-row"><span class="deal-caption">Период активности</span>';
  h += '<input type="date" id="dealFrom" value="'+(dealFrom||'')+'" onchange="dealFrom=this.value;renderDealsV2(currentCards)">';
  h += '<span class="deal-caption">по</span>';
  h += '<input type="date" id="dealTo" value="'+(dealTo||'')+'" onchange="dealTo=this.value;renderDealsV2(currentCards)">';
  if(dealFrom || dealTo) h += '<button class="toggle-btn" onclick="dealFrom=\'\';dealTo=\'\';renderDealsV2(currentCards)">Очистить даты</button>';
  h += '</div>';

  h += '<div class="deal-chips deal-summary-strip">';
  h += '<div class="deal-chip">Показано <strong>'+prepared.length+'</strong><span>из '+cards.length+'</span></div>';
  h += '<div class="deal-chip">Звонки <strong>'+totals.calls+'</strong><span>'+totals.minutes+' мин</span></div>';
  h += '<div class="deal-chip">Транскрипции <strong>'+totals.transcripts+'</strong><span>доступно в деталях</span></div>';
  h += '<div class="deal-chip">Проблемные <strong>'+totals.issueDeals+'</strong><span>сделки с флагами</span></div>';
  h += '<div class="deal-chip">Новые <strong>'+totals.newDeals+'</strong><span>за период</span></div>';
  h += '</div></div>';
  return h;
}

function renderDealsV2(cards){
  if(!cards.length){
    document.getElementById('out').innerHTML = '<div class="no-data">Нет данных за период</div>';
    return;
  }

  var statusOptions = [...new Set(cards.map(function(d){return d.status;}).filter(Boolean))].sort(function(a,b){return a.localeCompare(b,'ru');});
  var prepared = prepareDealCards(cards);
  var totals = {
    calls:prepared.reduce(function(s,d){return s + d.fCalls.length;},0),
    minutes:prepared.reduce(function(s,d){return s + d.ui.durM;},0),
    transcripts:prepared.reduce(function(s,d){return s + d.ui.transcripts.length;},0),
    issueDeals:prepared.filter(function(d){return d.ui.issueCount > 0;}).length,
    newDeals:prepared.filter(function(d){return d.isNew;}).length,
  };

  if(prepared.length && !prepared.some(function(d){return String(d.id) === String(activeDealId);})) activeDealId = prepared[0].id;
  var selected = prepared.find(function(d){return String(d.id) === String(activeDealId);}) || prepared[0] || null;

  var h = '<div class="deal-workspace">';
  h += renderDealTools(prepared, cards, statusOptions, totals);
  if(!prepared.length){
    h += '<div class="deal-empty">Ничего не найдено. Измените поиск, статус, фокус или период.</div></div>';
    document.getElementById('out').innerHTML = h;
    return;
  }

  h += '<div class="deal-layout">';
  h += '<div class="deal-register"><div class="deal-register-head"><div><b>Реестр сделок</b><span>'+prepared.length+' строк</span></div></div>';
  h += '<div class="deal-table-wrap"><table class="deal-grid-table"><thead><tr><th>Сделка</th><th>Статус</th><th>Касание</th><th>Звонки</th><th>ИИ</th><th>Сумма</th><th>Сигналы</th></tr></thead><tbody>';

  for(var i=0;i<prepared.length;i++){
    var d = prepared[i];
    var active = selected && String(selected.id) === String(d.id);
    var scoreColor = getScoreColor(d.ui.avgB, d.ui.maxB);
    var lastTouchLabel = d.ui.lastTouch ? formatTouch(d.ui.lastTouch.date,d.ui.lastTouch.time) : 'Нет';
    h += '<tr class="deal-row '+(active?'is-active':'')+'" onclick="setActiveDeal('+d.id+')">';
    h += '<td><div class="deal-namecell"><b>#'+d.id+' '+esc(dealShort(d.name, 72))+'</b><span>'+esc(dealShort(d.counterparty || 'Без контрагента', 64))+'</span></div></td>';
    h += '<td><span class="bg '+dealStatusClass(d.status)+'">'+esc(d.status || '—')+'</span></td>';
    h += '<td><span class="deal-quiet">'+esc(lastTouchLabel)+'</span></td>';
    h += '<td><b>'+d.fCalls.length+'</b><span class="deal-quiet"> / '+d.ui.durM+'м</span></td>';
    h += '<td><span style="font-weight:800;color:'+scoreColor+'">'+(d.ui.avgB === null || d.ui.avgB === undefined ? '—' : d.ui.avgB+'/'+d.ui.maxB)+'</span></td>';
    h += '<td>'+esc(d.dealSum ? fmt(d.dealSum) : '—')+'</td>';
    h += '<td><div class="deal-row-flags">'+renderDealIssuePills(d)+'</div></td>';
    h += '</tr>';
  }

  h += '</tbody></table></div></div>';
  h += renderDealDetail(selected);
  h += '</div></div>';
  document.getElementById('out').innerHTML = h;
}

function renderDealDetail(deal){
  if(!deal) return '<div class="deal-detail"><div class="deal-empty">Выберите сделку в таблице.</div></div>';
  var ai = deal.ui.aiData;
  var scoreColor = getScoreColor(deal.ui.avgB, deal.ui.maxB);
  var tabs = [['summary','Итог'],['calls','Звонки'],['ai','ИИ-анализ'],['transcripts','Транскрипции'],['notes','Заметки'],['history','История']];
  var h = '<aside class="deal-detail">';
  h += '<div class="deal-detail-head">';
  h += '<div class="deal-detail-title">#'+deal.id+' '+esc(dealShort(deal.name, 90))+'</div>';
  h += '<div class="deal-detail-sub">'+esc(deal.counterparty || 'Без контрагента')+'</div>';
  h += '<div class="deal-card-meta">'+renderDealPills(deal)+'</div>';
  h += '<div class="deal-detail-kpis">';
  h += '<div><b>'+deal.fCalls.length+'</b><span>звонки</span></div>';
  h += '<div><b>'+deal.ui.durM+'м</b><span>время</span></div>';
  h += '<div><b style="color:'+scoreColor+'">'+(deal.ui.avgB === null || deal.ui.avgB === undefined ? '—' : deal.ui.avgB+'/'+deal.ui.maxB)+'</b><span>оценка</span></div>';
  h += '<div><b>'+deal.ui.transcripts.length+'</b><span>тексты</span></div>';
  h += '</div></div>';
  h += '<div class="deal-detail-tabs">';
  for(var i=0;i<tabs.length;i++){
    h += '<button class="deal-detail-tab '+(dealDetailTab===tabs[i][0]?'is-active':'')+'" onclick="setDealDetailTab(\''+tabs[i][0]+'\')">'+tabs[i][1]+'</button>';
  }
  h += '</div><div class="deal-detail-body">';
  if(dealDetailTab === 'calls') h += renderDealCalls(deal);
  else if(dealDetailTab === 'ai') h += renderDealAi(deal, ai);
  else if(dealDetailTab === 'transcripts') h += renderDealTranscripts(deal);
  else if(dealDetailTab === 'notes') h += renderDealNotes(deal);
  else if(dealDetailTab === 'history') h += renderDealHistory(deal);
  else h += renderDealSummary(deal, ai);
  h += '</div></aside>';
  return h;
}

function renderDealSummary(deal, ai){
  var lastTouchLabel = deal.ui.lastTouch ? formatTouch(deal.ui.lastTouch.date,deal.ui.lastTouch.time) : 'Нет активности';
  var topNote = deal.ui.notes[0] ? deal.ui.notes[0].text : '';
  var h = '<div class="deal-summary compact">';
  h += '<div class="deal-summary-item"><b>Последнее касание</b><span>'+esc(lastTouchLabel)+'</span></div>';
  h += '<div class="deal-summary-item"><b>Создана</b><span>'+esc(deal.dateCreated || '—')+'</span></div>';
  h += '<div class="deal-summary-item"><b>Сумма</b><span>'+esc(deal.dealSum ? fmt(deal.dealSum) : '—')+'</span></div>';
  h += '<div class="deal-summary-item"><b>Сигналы</b><span>Звонки: '+deal.fCalls.length+' · Анализы: '+deal.fAnalyses.length+' · Заметки: '+deal.ui.notes.length+'</span></div>';
  h += '</div>';

  if(deal.ui.issues.length){
    h += '<div class="deal-panel-block"><h4>Требует внимания</h4><div class="deal-issue-list">';
    deal.ui.issues.forEach(function(f){h += '<span class="deal-flag '+(f.level==='bad'?'is-bad':f.level==='warn'?'is-warn':'is-info')+'">'+esc(f.label)+'</span>';});
    h += '</div></div>';
  }

  if(ai){
    h += '<div class="deal-panel-block"><h4>Короткий вывод ИИ</h4>';
    if(ai.todaySummary) h += '<p>'+esc(ai.todaySummary)+'</p>';
    if(ai.overallVerdict) h += '<p><b>Вердикт:</b> '+esc(ai.overallVerdict)+'</p>';
    if(ai.nextStep) h += '<p><b>Следующий шаг:</b> '+esc(ai.nextStep)+'</p>';
    h += '<div class="deal-actions"><button id="pf_btn_'+deal.id+'" class="toggle-btn" onclick="copyRecommendation('+deal.id+')">Копировать ИИ</button><button id="pf_send_'+deal.id+'" class="toggle-btn" onclick="sendToPlanfix('+deal.id+')">Planfix</button></div>';
    h += '</div>';
  }

  h += '<div class="deal-panel-block"><h4>Последняя заметка</h4>';
  h += topNote ? '<p>'+esc(topNote)+'</p>' : '<p class="deal-quiet">Нет заметок в выбранном периоде.</p>';
  h += '</div>';
  return h;
}

function renderDealCalls(deal){
  var h = '';
  if(deal.fCalls.length){
    h += '<div class="deal-panel-block"><h4>Звонки из реестра</h4><div class="deal-table-wrap"><table><tr><th>Дата</th><th>Время</th><th>Тип</th><th>Длит.</th><th>Контакт</th><th>Скрипт</th><th>Балл</th><th>Вердикт</th></tr>';
    var calls = [...deal.fCalls].sort(function(a,b){return dateStamp(b.date,b.time)-dateStamp(a.date,a.time);});
    calls.forEach(function(c){
      var cMin = timeToMin(c.time);
      var matchA = deal.fAnalyses.find(function(a){return a.date === c.date && Math.abs(timeToMin(a.time) - cMin) < 10;});
      h += '<tr><td>'+esc(c.date)+'</td><td>'+esc((c.time||'').split('-')[0].trim())+'</td><td>'+esc(dealCallKind(c.type))+'</td><td>'+dealDuration(c.duration)+'</td><td>'+esc(dealShort(c.contact || '', 32))+'</td>';
      if(matchA){
        h += '<td>'+yn(matchA.howWeWork)+' '+yn(matchA.callToAction)+' '+yn(matchA.sentInvoice)+'</td><td><b>'+matchA.totalBalls+'</b></td><td>'+esc(matchA.verdict || '')+'</td>';
      } else {
        h += '<td colspan="3" class="deal-quiet">'+(Number(c.duration || 0) < 30 ? 'Короткий звонок' : 'Нет анализа')+'</td>';
      }
      h += '</tr>';
    });
    h += '</table></div></div>';
  }

  var callComments = getDealCallComments(deal).sort(function(a,b){return dateStamp(b.date,b.time)-dateStamp(a.date,a.time);});
  if(callComments.length){
    h += '<div class="deal-panel-block"><h4>Записи из комментариев</h4>';
    callComments.forEach(function(c){
      h += '<div class="deal-event"><b>'+esc(c.date)+' '+esc(c.time)+' · '+esc(dealCallKind(c.type))+'</b><span>'+esc(c.owner || '')+' · '+esc(c.source || 'deal')+'</span><p>'+esc(dealShort(c.transcription || c.text || 'Без расшифровки', 260))+'</p></div>';
    });
    h += '</div>';
  }
  if(!h) h = '<div class="deal-empty">Звонков в выбранном периоде нет.</div>';
  return h;
}

function renderDealAi(deal, ai){
  if(!ai && !deal.fAnalyses.length) return '<div class="deal-empty">ИИ-оценки и анализов звонков нет.</div>';
  var h = '';
  if(ai){
    var ss = ai.salaryScore || {};
    h += '<div class="deal-panel-block"><h4>ИИ-оценка сделки</h4>';
    h += '<p><b>Баллы:</b> '+esc((ss.total ?? '—') + '/' + (ss.max ?? '—'))+'</p>';
    if(ai.overallVerdict) h += '<p><b>Вердикт:</b> '+esc(ai.overallVerdict)+'</p>';
    if(ai.todaySummary) h += '<p>'+esc(ai.todaySummary)+'</p>';
    var checklist = [
      ['Устная презентация', ai.verbalPresentation && ai.verbalPresentation.overall],
      ['Как работаем', ai.howWeWork && ai.howWeWork.done],
      ['Призыв к действию', ai.callToAction && ai.callToAction.done],
      ['КП', ai.cp && ai.cp.done],
      ['Счёт', ai.invoice && ai.invoice.done],
      ['Возражения', ai.objectionHandling && ai.objectionHandling.done],
    ];
    h += '<div class="deal-checkgrid">';
    checklist.forEach(function(x){h += '<div class="'+(x[1]?'is-ok':'is-miss')+'"><b>'+(x[1]?'✓':'×')+'</b><span>'+x[0]+'</span></div>';});
    h += '</div>';
    if(ai.missing && ai.missing.length){h += '<h4>Не выполнено</h4><ul>';ai.missing.forEach(function(m){h += '<li>'+esc(m)+'</li>';});h += '</ul>';}
    if(ai.recommendations && ai.recommendations.length){h += '<h4>Рекомендации</h4><ul>';ai.recommendations.forEach(function(r){h += '<li>'+esc(r)+'</li>';});h += '</ul>';}
    if(ai.nextStep) h += '<p><b>Следующий шаг:</b> '+esc(ai.nextStep)+'</p>';
    h += '</div>';
  }
  if(deal.fAnalyses.length){
    h += '<div class="deal-panel-block"><h4>Planfix-анализы звонков</h4><div class="deal-table-wrap"><table><tr><th>Дата</th><th>Время</th><th>Тема</th><th>Как работаем</th><th>Призыв</th><th>Счёт</th><th>Балл</th></tr>';
    deal.fAnalyses.forEach(function(a){
      h += '<tr><td>'+esc(a.date)+'</td><td>'+esc(a.time)+'</td><td>'+esc(dealShort(a.topic || '', 42))+'</td><td>'+yn(a.howWeWork)+'</td><td>'+yn(a.callToAction)+'</td><td>'+yn(a.sentInvoice)+'</td><td><b>'+esc(String(a.totalBalls || 0))+'</b></td></tr>';
    });
    h += '</table></div></div>';
  }
  return h;
}

function renderDealTranscripts(deal){
  if(!deal.ui.transcripts.length) return '<div class="deal-empty">Транскрипций в выбранном периоде нет.</div>';
  var h = '<div class="deal-panel-block"><h4>Все транскрипции</h4>';
  deal.ui.transcripts.forEach(function(c){
    var tid = 'tr_'+deal.id+'_'+c.id;
    h += '<div class="deal-transcript-row"><button class="toggle-btn" onclick="toggleTr(\''+tid+'\')">'+esc(c.date)+' '+esc(c.time)+' · '+esc(dealCallKind(c.type))+'</button><span class="deal-caption">'+esc(c.source || '')+'</span><div id="'+tid+'" class="transcript" style="display:none">'+esc(c.transcription)+'</div></div>';
  });
  h += '</div>';
  return h;
}

function renderDealNotes(deal){
  if(!deal.ui.notes.length) return '<div class="deal-empty">Заметок в выбранном периоде нет.</div>';
  var h = '<div class="deal-panel-block"><h4>Все заметки</h4>';
  deal.ui.notes.forEach(function(n){
    h += '<div class="deal-event"><b>'+esc(n.date)+' '+esc(n.time)+'</b><span>'+esc(n.owner || '')+'</span><p>'+esc(n.text || '')+'</p></div>';
  });
  h += '</div>';
  return h;
}

function renderDealHistory(deal){
  var events = [];
  (deal.fCalls || []).forEach(function(c){events.push({stamp:dateStamp(c.date,c.time), title:'Звонок из реестра', meta:c.date+' '+c.time, text:(c.type || '')+' '+(c.contact || '')+' '+(c.phone || '')});});
  (deal.fAnalyses || []).forEach(function(a){events.push({stamp:dateStamp(a.date,a.time), title:'Анализ звонка', meta:a.date+' '+a.time, text:(a.verdict || '')+' · баллы '+(a.totalBalls || 0)});});
  (deal.fComments || []).forEach(function(c){events.push({stamp:dateStamp(c.date,c.time), title:dealCallKind(c.type), meta:(c.date || '')+' '+(c.time || '')+' · '+(c.owner || ''), text:c.transcription ? 'Есть транскрипция: '+dealShort(c.transcription, 220) : (c.text || '')});});
  events.sort(function(a,b){return b.stamp - a.stamp;});
  if(!events.length) return '<div class="deal-empty">Истории в выбранном периоде нет.</div>';
  var h = '<div class="deal-panel-block"><h4>Лента событий</h4>';
  events.forEach(function(e){h += '<div class="deal-event"><b>'+esc(e.title)+'</b><span>'+esc(e.meta)+'</span><p>'+esc(e.text || '')+'</p></div>';});
  h += '</div>';
  return h;
}
