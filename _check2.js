const d = JSON.parse(require('fs').readFileSync('latest_data.json', 'utf8'));
const card = d.dealCards.find(c => c.id === 31027);
if (!card) { console.log('card not found'); process.exit(); }

console.log('=== КОММЕНТАРИИ 25-02 ===');
for (const c of card.comments.filter(x => x.date === '25-02-2026')) {
  console.log(`[${c.type}] ${c.time} owner:${c.owner} hasTr:${!!c.transcription}`);
  console.log('  text:', c.text.substring(0, 300));
  if (c.transcription) console.log('  TRANSCRIPTION:', c.transcription.substring(0, 300));
  console.log();
}

console.log('=== ЗВОНКИ (dataTags) 25-02 ===');
for (const c of card.calls.filter(x => x.date === '25-02-2026')) {
  console.log(`${c.time} ${c.type} ${c.duration}с ${c.contact} ${c.employee}`);
}

console.log('\n=== ВСЕ ТРАНСКРИБАЦИИ ===');
for (const c of card.comments.filter(x => x.transcription)) {
  console.log(`[${c.date} ${c.time}] type:${c.type} tr:${c.transcription.substring(0, 200)}`);
}
