const fs = require('fs');
const d = JSON.parse(fs.readFileSync('latest_data.json', 'utf8'));
const card = d.dealCards.find(c => c.id === 28974);
if (!card) { console.log('Card not found'); process.exit(); }

console.log('=== СДЕЛКА #28974 ===');
console.log('Name:', card.name);
console.log('Status:', card.status);
console.log('Comments:', card.comments.length);
console.log('Calls:', card.calls.length);
console.log('Analyses:', card.analyses.length);

console.log('\n=== ВСЕ КОММЕНТАРИИ ===');
for (const c of card.comments) {
  console.log(`[${c.date} ${c.time}] type:${c.type} owner:${c.owner}`);
  console.log('  text:', (c.text || '').substring(0, 300));
  if (c.files && c.files.length) console.log('  FILES:', JSON.stringify(c.files));
  if (c.transcription) console.log('  TR:', c.transcription.substring(0, 300));
  console.log();
}

console.log('=== ЗВОНКИ ===');
for (const c of card.calls) {
  console.log(`${c.date} ${c.time} ${c.type} ${c.duration}s ${c.contact}`);
}

console.log('\n=== АНАЛИЗЫ ===');
for (const a of card.analyses) {
  console.log(`${a.date}: balls=${a.totalBalls} verdict=${a.verdict} hww=${a.howWeWork} cta=${a.callToAction}`);
}

// AI cache v11
const cache = JSON.parse(fs.readFileSync('ai_cache.json', 'utf8'));
const dates = ['12-03-2026', '11-03-2026', '06-03-2026', '05-03-2026', '04-03-2026', '03-03-2026'];
for (const date of dates) {
  const k = `assess_28974_${date}_v11`;
  if (!cache[k]) continue;
  const r = cache[k];
  console.log(`\n=== v11 ${date} ===`);
  console.log('CP:', JSON.stringify(r.cp));
  console.log('Презентация:', JSON.stringify(r.writtenPresentation));
  console.log('Счёт:', JSON.stringify(r.invoice));
  const vp = r.verbalPresentation || {};
  console.log('VP: overall=' + vp.overall + ' source=' + vp.source);
  for (const k2 of ['since2014','manyObjects','govClients','reliableInSnow','manyVehicles']) {
    if (vp[k2]) console.log('  ' + k2 + ': done=' + vp[k2].done + ' ' + (vp[k2]._corrected || '') + ' ' + (vp[k2].note || '').substring(0, 100));
  }
  console.log('HowWeWork:', JSON.stringify(r.howWeWork));
  console.log('CallToAction:', JSON.stringify(r.callToAction));
  console.log('Баллы:', r.salaryScore ? r.salaryScore.total + '/' + r.salaryScore.max : 'N/A');
  console.log('Summary:', (r.todaySummary || '').substring(0, 200));
}
