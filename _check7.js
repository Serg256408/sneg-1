const fs = require('fs');
const cache = JSON.parse(fs.readFileSync('ai_cache.json', 'utf8'));

// Check v11 results
const deals = [29594, 21425, 31027, 23382];
const dates = ['12-03-2026', '11-03-2026', '06-03-2026'];

for (const dealId of deals) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`СДЕЛКА #${dealId}`);
  for (const date of dates) {
    const k = `assess_${dealId}_${date}_v11`;
    if (!cache[k]) continue;
    const r = cache[k];
    console.log(`\n  --- ${date} ---`);
    if (r.cp) console.log(`  КП: done=${r.cp.done} ${r.cp._corrected || ''} ${r.cp.note || ''}`);
    if (r.writtenPresentation) console.log(`  Презентация: done=${r.writtenPresentation.done} ${r.writtenPresentation._corrected || ''} ${r.writtenPresentation.note || ''}`);
    if (r.invoice) console.log(`  Счёт: done=${r.invoice.done} ${r.invoice._corrected || ''} ${r.invoice.note || ''}`);
    if (r.verbalPresentation) {
      const vp = r.verbalPresentation;
      console.log(`  VP: overall=${vp.overall} source=${vp.source} quality=${vp.quality}`);
      for (const k2 of ['since2014','manyObjects','govClients','reliableInSnow','manyVehicles']) {
        if (vp[k2]) console.log(`    ${k2}: done=${vp[k2].done} ${vp[k2]._corrected || ''} ${(vp[k2].note||'').substring(0,80)}`);
      }
    }
    if (r.howWeWork) console.log(`  HowWeWork: done=${r.howWeWork.done} source=${r.howWeWork.source} ${r.howWeWork._corrected || ''}`);
    if (r.salaryScore) console.log(`  Баллы: ${r.salaryScore.total}/${r.salaryScore.max}`);
    if (r.todaySummary) console.log(`  Summary: ${r.todaySummary.substring(0, 150)}`);
  }
}
