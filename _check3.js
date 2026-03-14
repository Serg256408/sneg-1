const d = JSON.parse(require('fs').readFileSync('latest_data.json', 'utf8'));
const card = d.dealCards.find(c => c.id === 31027);
if (!card) { console.log('card not found'); process.exit(); }

console.log('=== ВСЕ КОММЕНТАРИИ ===');
for (const c of card.comments) {
  console.log(`[${c.date} ${c.time}] type:${c.type} owner:${c.owner}`);
  console.log('  text:', c.text.substring(0, 200));
  if (c.files && c.files.length) console.log('  files:', c.files);
  console.log();
}

console.log('\nВсего комментариев:', card.comments.length);
console.log('Всего звонков (dataTags):', card.calls.length);
console.log('Всего анализов:', card.analyses.length);
