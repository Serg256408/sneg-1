const fs = require('fs');
const cache = JSON.parse(fs.readFileSync('ai_cache.json', 'utf8'));

// Check v10 for 11-03
const k10_11 = 'assess_29594_11-03-2026_v10';
if (cache[k10_11]) {
  console.log('=== v10 11-03-2026 ===');
  const r = cache[k10_11];
  console.log('CP:', JSON.stringify(r.cp));
  console.log('writtenPres:', JSON.stringify(r.writtenPresentation));
  console.log('VP:', JSON.stringify(r.verbalPresentation));
  console.log('howWeWork:', JSON.stringify(r.howWeWork));
  console.log('salary:', JSON.stringify(r.salaryScore));
  console.log('summary:', r.todaySummary);
  console.log('missing:', JSON.stringify(r.missing));
}

// Check v9 for 11-03
const k9_11 = 'assess_29594_11-03-2026_v9';
if (cache[k9_11]) {
  console.log('\n=== v9 11-03-2026 ===');
  const r = cache[k9_11];
  console.log('CP:', JSON.stringify(r.cp));
  console.log('VP:', JSON.stringify(r.verbalPresentation));
  console.log('howWeWork:', JSON.stringify(r.howWeWork));
  console.log('salary:', JSON.stringify(r.salaryScore));
}

// Look at the latest_data for multiDayActivity 12-03
const d = JSON.parse(fs.readFileSync('latest_data.json', 'utf8'));
const md12 = d.multiDayActivity && d.multiDayActivity['12-03-2026'];
if (md12) {
  const da = md12.find(x => x.deal.id === 29594);
  if (da) {
    console.log('\n=== multiDayActivity 12-03 ===');
    console.log('actions:', JSON.stringify(da.actions));
    console.log('aiAssessment CP:', JSON.stringify(da.aiAssessment && da.aiAssessment.cp));
    console.log('aiAssessment VP:', JSON.stringify(da.aiAssessment && da.aiAssessment.verbalPresentation));
  }
}

// Check if there are subtasks for 29594
const d2 = JSON.parse(fs.readFileSync('latest_data.json', 'utf8'));
console.log('\n=== Looking for subtask data ===');
// Check all comments for files
const card = d2.dealCards.find(c => c.id === 29594);
if (card) {
  console.log('All files across all comments:');
  for (const c of card.comments) {
    if (c.files && c.files.length) {
      console.log(`  [${c.date} ${c.time}] ${c.type}: ${JSON.stringify(c.files)}`);
    }
  }
  console.log('Total comments:', card.comments.length);

  // Show full text of all comments
  console.log('\n=== FULL COMMENT TEXTS ===');
  for (const c of card.comments) {
    console.log(`[${c.date} ${c.time}] type:${c.type}`);
    console.log(c.text);
    console.log('---');
  }
}
