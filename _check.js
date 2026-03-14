const d = JSON.parse(require('fs').readFileSync('latest_data.json', 'utf8'));
const day = d.multiDayActivity['11-03-2026'];
const da = day.find(x => x.deal.id === 31027);
if (!da) { console.log('not found'); process.exit(); }
const aa = da.aiAssessment;
console.log('VP source:', aa.verbalPresentation?.source);
console.log('VP overall:', aa.verbalPresentation?.overall);
const items = ['since2014', 'manyObjects', 'govClients', 'reliableInSnow', 'manyVehicles'];
for (const k of items) console.log(' ', k, ':', JSON.stringify(aa.verbalPresentation?.[k]));
console.log('howWeWork:', JSON.stringify(aa.howWeWork));
console.log('salaryScore:', JSON.stringify(aa.salaryScore));
