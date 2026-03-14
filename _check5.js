const fs = require('fs');
const d = JSON.parse(fs.readFileSync('latest_data.json', 'utf8'));
const card = d.dealCards.find(c => c.id === 29594);
if (!card) { console.log('Card not found'); process.exit(); }

console.log('=== СДЕЛКА #29594 ===');
console.log('Name:', card.name);
console.log('Status:', card.status);
console.log('Comments:', card.comments.length);
console.log('Calls:', card.calls.length);
console.log('Analyses:', card.analyses.length);
console.log();

console.log('=== КОММЕНТАРИИ ===');
for (const c of card.comments) {
  console.log(`[${c.date} ${c.time}] type:${c.type} owner:${c.owner}`);
  console.log('  text:', (c.text || '').substring(0, 300));
  if (c.files && c.files.length) console.log('  FILES:', JSON.stringify(c.files));
  if (c.transcription) console.log('  TR:', c.transcription.substring(0, 200));
  console.log();
}

console.log('=== ЗВОНКИ ===');
for (const c of card.calls) {
  console.log(`${c.date} ${c.time} ${c.type} ${c.duration}s ${c.contact}`);
}

console.log();
console.log('=== АНАЛИЗЫ ===');
for (const a of card.analyses) {
  console.log(`${a.date}: balls=${a.totalBalls} verdict=${a.verdict} hww=${a.howWeWork}`);
}

// Check AI cache
const cache = JSON.parse(fs.readFileSync('ai_cache.json', 'utf8'));
const keys = Object.keys(cache).filter(k => k.includes('29594'));
console.log('\n=== AI CACHE KEYS ===');
console.log(keys);

const k9 = 'assess_29594_12-03-2026_v9';
const k10 = 'assess_29594_12-03-2026_v10';
for (const k of [k9, k10]) {
  if (cache[k]) {
    console.log(`\n=== ${k} ===`);
    console.log('CP:', JSON.stringify(cache[k].cp));
    console.log('writtenPres:', JSON.stringify(cache[k].writtenPresentation));
    console.log('VP source:', cache[k].verbalPresentation && cache[k].verbalPresentation.source);
    console.log('VP overall:', cache[k].verbalPresentation && cache[k].verbalPresentation.overall);
    console.log('salary:', JSON.stringify(cache[k].salaryScore));
    console.log('summary:', (cache[k].todaySummary || '').substring(0, 300));
    console.log('missing:', JSON.stringify(cache[k].missing));
  }
}
