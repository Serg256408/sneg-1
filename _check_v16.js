const fs = require('fs');
const cache = JSON.parse(fs.readFileSync('ai_cache.json', 'utf8'));
const data = JSON.parse(fs.readFileSync('latest_data.json', 'utf8'));

const v16keys = Object.keys(cache).filter(k => k.includes('_v17'));
console.log('v16 записей:', v16keys.length);

const checkDeals = [21425, 28974, 29594, 31303, 31399, 30651];
const dates = ['12-03-2026', '11-03-2026'];

for (const dealId of checkDeals) {
  for (const date of dates) {
    const k = `assess_${dealId}_${date}_v17`;
    if (!cache[k]) continue;
    const r = cache[k];
    console.log('\n' + '='.repeat(60));
    console.log(`СДЕЛКА #${dealId} — ${date}`);

    const card = data.dealCards.find(c => c.id === dealId);
    if (card) {
      const dayComments = card.comments.filter(c => c.date === date);
      const hasTr = dayComments.some(c => c.transcription);
      console.log('Транскрибация за дату:', hasTr ? 'ЕСТЬ' : 'НЕТ');
      const calls = card.calls.filter(c => c.date === date);
      console.log('Звонков за дату:', calls.length, calls.map(c => c.duration + 's').join(', '));
    }

    const vp = r.verbalPresentation || {};
    console.log('VP: overall=' + vp.overall + ' source=' + vp.source + ' quality=' + vp.quality);
    for (const k2 of ['since2014','manyObjects','govClients','reliableInSnow','manyVehicles']) {
      if (vp[k2]) console.log('  ' + k2 + ': done=' + vp[k2].done + ' note=' + (vp[k2].note || '').substring(0, 120));
    }

    console.log('HowWeWork:', JSON.stringify(r.howWeWork));
    console.log('CallToAction:', JSON.stringify(r.callToAction));
    console.log('CP:', JSON.stringify(r.cp));
    console.log('Invoice:', JSON.stringify(r.invoice));
    console.log('Presentation:', JSON.stringify(r.writtenPresentation));

    if (r.salaryScore) console.log('Баллы:', r.salaryScore.total + '/' + r.salaryScore.max);
    console.log('Summary:', (r.todaySummary || '').substring(0, 250));
    console.log('Missing:', JSON.stringify(r.missing));
  }
}
