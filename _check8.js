const fs = require('fs');
const d = JSON.parse(fs.readFileSync('latest_data.json', 'utf8'));
const card = d.dealCards.find(c => c.id === 21425);

console.log('=== #21425 ТРАНСКРИБАЦИИ ===');
for (const c of card.comments) {
  if (c.transcription) {
    console.log(`[${c.date} ${c.time}] ЕСТЬ транскрибация (${c.transcription.length} chars)`);
    console.log('  Фрагмент:', c.transcription.substring(0, 300));
    console.log();
  }
}

// Also check — does 06-03 have any transcription?
const comments0603 = card.comments.filter(c => c.date === '06-03-2026');
console.log('\n=== Комменты за 06-03-2026 ===');
for (const c of comments0603) {
  console.log(`[${c.time}] type:${c.type} hasTr:${!!c.transcription}`);
  if (c.files && c.files.length) console.log('  files:', JSON.stringify(c.files));
  console.log('  text:', (c.text || '').substring(0, 200));
}
