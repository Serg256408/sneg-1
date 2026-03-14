const d = JSON.parse(require('fs').readFileSync('latest_data.json', 'utf8'));
const card = d.dealCards.find(c => c.id === 31027);
console.log('=== АНАЛИЗЫ PLANFIX ===');
for (const a of card.analyses) {
  console.log(`${a.date} ${a.time}: howWeWork:${a.howWeWork} callToAction:${a.callToAction} sentInvoice:${a.sentInvoice} allFour:${a.allFour} balls:${a.totalBalls} verdict:${a.verdict}`);
}
