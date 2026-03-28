// ============================================================
// scoring.js — Расчёт баллов для ЗП по сделке
// ============================================================

function calculateSalaryScore(aa) {
  const items = [];
  let total = 0;

  // КП: 1 балл
  if (aa.cp && aa.cp.done) {
    items.push({ name: 'КП', score: 1, note: aa.cp.note || '' });
    total += 1;
  }

  // Счёт: 1 балл
  if (aa.invoice && aa.invoice.done) {
    items.push({ name: 'Счёт', score: 1, note: aa.invoice.note || '' });
    total += 1;
  }

  // Презентация (файл): 1 балл
  if (aa.writtenPresentation && aa.writtenPresentation.done) {
    items.push({ name: 'Презентация (файл)', score: 1, note: aa.writtenPresentation.note || '' });
    total += 1;
  }

  // Устная презентация: в звонке 3 балла, в переписке 1.5 балла
  const vp = aa.verbalPresentation;
  if (vp && vp.overall) {
    const src = (vp.source || '').toLowerCase();
    if (src === 'call' || src === 'звонок') {
      items.push({ name: 'Устная презентация (звонок)', score: 3, note: vp.quality || '' });
      total += 3;
    } else {
      items.push({ name: 'Устная презентация (переписка)', score: 1.5, note: vp.quality || '' });
      total += 1.5;
    }
  }

  // Как мы работаем: в звонке 3 балла, в переписке 1.5 балла
  const hw = aa.howWeWork;
  if (hw && hw.done) {
    const src = (hw.source || '').toLowerCase();
    if (src === 'call' || src === 'звонок') {
      items.push({ name: 'Как мы работаем (звонок)', score: 3, note: hw.note || '' });
      total += 3;
    } else {
      items.push({ name: 'Как мы работаем (переписка)', score: 1.5, note: hw.note || '' });
      total += 1.5;
    }
  }

  // Призыв к действию: 3 балла
  if (aa.callToAction && aa.callToAction.done) {
    items.push({ name: 'Призыв к действию', score: 3, note: aa.callToAction.note || '' });
    total += 3;
  }

  return { total, max: 12, items };
}

module.exports = { calculateSalaryScore };
