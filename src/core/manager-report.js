// ============================================================
// manager-report.js — ИИ итог дня + отчёт руководителя
// ============================================================

const { parsePfDate } = require('../utils/helpers');
const { loadAiCache, saveAiCache } = require('./cache');
const { aiChat } = require('../api/deepseek');
const { FUNNEL_ORDER } = require('../utils/config');

async function aiDaySummary(dailyDeals, reportDate, aiCache, mgrAlias, forceRefresh) {
  const cacheKey = `day_${mgrAlias || 'default'}_${reportDate}_${dailyDeals.length}_v4`;
  if (!forceRefresh && aiCache[cacheKey]) return aiCache[cacheKey];

  const totalCalls = dailyDeals.reduce((s, d) => s + (d.dayCalls || 0), 0);
  const totalScore = dailyDeals.reduce((s, d) => { const ss = (d.aiAssessment || {}).salaryScore; return s + (ss ? ss.total : 0); }, 0);
  const maxScore = dailyDeals.length * 12;

  const dealsText = dailyDeals.map(d => {
    const a = d.aiAssessment;
    const verdict = a ? a.overallVerdict || '' : '';
    const score = a && a.salaryScore ? a.salaryScore.total + '/' + a.salaryScore.max : '';
    const calls = (d.actions || []).filter(x => x.type === 'outCall' || x.type === 'inCall' || x.type === 'ndz').length;
    const callsList = (d.actions || []).filter(x => x.type === 'outCall' || x.type === 'inCall' || x.type === 'ndz')
      .map(x => `${x.time} ${x.type === 'outCall' ? 'Исх' : x.type === 'inCall' ? 'Вх' : 'НДЗ'}${x.transcription ? ' (с транскрибацией)' : ''}`).join(', ');
    const sum = d.deal.dealSum ? d.deal.dealSum + '₽' : '';
    let line = `- #${d.deal.id} "${d.deal.name}" (${d.deal.status}${sum ? ', ' + sum : ''}) ${d.deal.counterparty || ''}`;
    if (calls) line += `\n  Звонки (${calls}): ${callsList}`;
    if (score) line += `\n  Баллы: ${score}`;
    if (verdict) line += `\n  Вердикт: ${verdict}`;
    if (a && a.nextStep) line += `\n  След.шаг: ${a.nextStep}`;
    return line;
  }).join('\n');

  const prompt = `Резюмируй рабочий день менеджера по продажам (вывоз снега, асфальтирование) за ${reportDate}.

СТАТИСТИКА ДНЯ:
- Обработано сделок: ${dailyDeals.length} (новых: ${dailyDeals.filter(d => d.isNew).length}, старых: ${dailyDeals.filter(d => !d.isNew).length})
- Звонков: ${totalCalls}
- Баллы ЗП: ${totalScore}/${maxScore}

СДЕЛКИ ЗА ДЕНЬ:
${dealsText}

Напиши краткий итог дня (5-7 предложений):
1. Что менеджер сделал за день (звонки, КП, продвижения)
2. Ключевые сделки дня — какие продвинулись, с кем общался
3. Проблемы — где менеджер пассивен, какие сделки требуют внимания
4. Что нужно сделать завтра

КРИТИЧЕСКОЕ ПРАВИЛО: При каждом упоминании сделки ОБЯЗАТЕЛЬНО пиши "#ID название" (например: #31766 "Асфальтирование/4200м2"). НИКОГДА не упоминай сделку без #ID. Пиши конкретно, без воды.`;

  const result = await aiChat(prompt, 'Ты аналитик отдела продаж компании ТрансКом. Пиши кратко, по-русски, с номерами сделок.', 1500, 'deepseek-chat');
  if (result) {
    aiCache[cacheKey] = result;
    saveAiCache(aiCache);
  }
  return result;
}

// ============ ИТОГ ДЛЯ РУКОВОДИТЕЛЯ ============

// Итог для руководителя за период (день/неделя/месяц)
async function aiManagerSummary(multiDayActivity, multiDaySummary, dealCards, funnelChanges, periodDays, reportDate, aiCache, mgrAlias, forceRefresh) {
  const cacheKey = `mgr_${mgrAlias || 'default'}_${periodDays}d_${reportDate}_v3`;
  if (!forceRefresh && aiCache[cacheKey]) return aiCache[cacheKey];

  // Собираем даты за период
  const refDate = parsePfDate(reportDate);
  if (!refDate) return null;
  const allDates = Object.keys(multiDayActivity).filter(d => {
    const pd = parsePfDate(d);
    if (!pd) return false;
    const diff = Math.floor((refDate - pd) / 86400000);
    return diff >= 0 && diff < periodDays;
  }).sort((a, b) => {
    const pa = parsePfDate(a), pb = parsePfDate(b);
    return pb - pa;
  });

  if (!allDates.length) return null;

  // Агрегация по всем дням периода
  const dealMap = {};
  let totalCalls = 0, totalDeals = 0, newDeals = 0;
  for (const dt of allDates) {
    const dayDeals = multiDayActivity[dt] || [];
    for (const da of dayDeals) {
      totalDeals++;
      if (da.isNew) newDeals++;
      totalCalls += da.dayCalls || 0;
      if (!dealMap[da.deal.id]) dealMap[da.deal.id] = { deal: da.deal, days: [], ai: null, bestScore: 0 };
      dealMap[da.deal.id].days.push(dt);
      if (da.aiAssessment) {
        dealMap[da.deal.id].ai = da.aiAssessment;
        const sc = (da.aiAssessment.salaryScore || {}).total || 0;
        if (sc > dealMap[da.deal.id].bestScore) dealMap[da.deal.id].bestScore = sc;
      }
    }
  }

  // Только сделки, обработанные менеджером за период (из dealMap)
  const workedIds = new Set(Object.keys(dealMap).map(Number));

  // Топ сделки по сумме — ТОЛЬКО обработанные за период
  const activeBig = dealCards.filter(d => workedIds.has(d.id) && d.dealSum > 0)
    .sort((a, b) => (b.dealSum || 0) - (a.dealSum || 0)).slice(0, 10);

  // Сделки ближе к оплате — ТОЛЬКО обработанные за период
  const closing = dealCards.filter(d => workedIds.has(d.id) && ['Дожим', 'Договор и оплата'].includes(d.status));

  // Движения воронки за период
  const fwdMoves = (funnelChanges || []).filter(c => c.direction === 'forward');
  const bwdMoves = (funnelChanges || []).filter(c => c.direction === 'backward');

  // Дневные итоги
  const daySummaries = allDates.map(d => `${d}: ${(multiDaySummary || {})[d] || 'нет итога'}`).join('\n');

  // Детали по ключевым сделкам — с номерами и red-флагами
  const dealDetails = Object.values(dealMap)
    .sort((a, b) => (b.deal.dealSum || 0) - (a.deal.dealSum || 0))
    .slice(0, 20)
    .map(d => {
      const card = dealCards.find(c => c.id === d.deal.id);
      const rf = (card && card.redFlags || []).map(f => f.label).join(', ');
      let line = `- #${d.deal.id} "${d.deal.name}" (${d.deal.status}, ${d.deal.dealSum ? d.deal.dealSum + '₽' : 'без суммы'})`;
      line += ` — работали ${d.days.length} дн.`;
      if (rf) line += ` | ⚠️ ${rf}`;
      if (d.ai) {
        if (d.ai.dealSituation) line += ` | Ситуация: ${d.ai.dealSituation}`;
        if (d.ai.nextStep) line += ` | След.шаг: ${d.ai.nextStep}`;
      }
      return line;
    }).join('\n');

  const periodName = periodDays === 1 ? 'день' : periodDays <= 7 ? 'неделю' : 'месяц';

  const prompt = `Ты составляешь отчёт для РУКОВОДИТЕЛЯ компании ТрансКом (вывоз снега, асфальтирование).
Период: за ${periodName} (${allDates.length} рабочих дней, ${allDates[allDates.length - 1]} — ${allDates[0]}).
Отчёт об эффективности МЕНЕДЖЕРА ПО ПРОДАЖАМ за этот период.

ВАЖНО: Анализируй ТОЛЬКО сделки, с которыми менеджер реально работал за этот период (звонил, писал, продвигал). НЕ включай сделки, по которым не было активности менеджера за период.

СТАТИСТИКА ПЕРИОДА:
- Обработано обращений: ${totalDeals} (новых: ${newDeals})
- Уникальных сделок за период: ${Object.keys(dealMap).length}
- Звонков: ${totalCalls}
- Продвижений по воронке: ${fwdMoves.length}
- Откатов назад: ${bwdMoves.length}
- Обработанных сделок на стадии "Дожим"/"Договор и оплата": ${closing.length}${closing.length ? ' (сумма: ' + closing.reduce((s, d) => s + (d.dealSum || 0), 0) + '₽)' : ''}

ИТОГИ ПО ДНЯМ:
${daySummaries}

СДЕЛКИ, ОБРАБОТАННЫЕ ЗА ПЕРИОД (по сумме):
${dealDetails}

ТОП ОБРАБОТАННЫХ СДЕЛОК ПО ДЕНЬГАМ:
${activeBig.length ? activeBig.map(d => `- #${d.id} "${d.name}" ${d.status} — ${d.dealSum}₽`).join('\n') : 'Нет сделок с суммой'}

БЛИЗКО К ОПЛАТЕ (обработанные за период):
${closing.length ? closing.map(d => `- #${d.id} "${d.name}" — ${d.dealSum || 0}₽ (${d.status})`).join('\n') : 'Нет'}

Напиши отчёт для руководителя в формате:

1. **КРАТКИЙ ИТОГ** (3-4 предложения): главные результаты менеджера за ${periodName}, сколько денег в пайплайне, сколько реально может закрыться

2. **🔥 СРОЧНО ДОЖАТЬ** — сделки где клиент почти согласен, КП отправлено, большая сумма. Конкретно: что сделать чтобы закрыть. По каждой сделке — #ID, сумма, что мешает, следующий шаг

3. **⚠️ ЗАБЫТЫЕ СДЕЛКИ** — нет активности давно, а сделка живая. Кто забыл, сколько дней молчат, сумма

4. **📋 НЕ ХВАТАЕТ ДОКУМЕНТОВ** — где нет КП, счёта, презентации. Что конкретно отправить

5. **✅ ХОРОШО ИДУТ** — сделки где всё по скрипту, менеджер работает правильно. Коротко

6. **💰 ДЕНЬГИ** — общая сумма пайплайна, сколько реально закроется в ближайшие 2 недели, какие сделки принесут деньги

7. **📌 ПЛАН ДЕЙСТВИЙ НА ЗАВТРА** — топ-5 конкретных действий: кому позвонить, что отправить, куда подключиться руководителю

КРИТИЧЕСКОЕ ПРАВИЛО: При КАЖДОМ упоминании сделки ОБЯЗАТЕЛЬНО пиши "#ID название" (например: #31766 "Асфальтирование/4200м2"). НИКОГДА не упоминай сделку без #ID. Пиши конкретно с именами, номерами и суммами.`;

  const result = await aiChat(prompt, 'Ты бизнес-аналитик, составляешь отчёт для директора. Пиши по-русски, конкретно, с цифрами и именами.', 2000, 'deepseek-chat');
  if (result) {
    aiCache[cacheKey] = result;
    saveAiCache(aiCache);
  }
  return result;
}

module.exports = { aiDaySummary, aiManagerSummary };
