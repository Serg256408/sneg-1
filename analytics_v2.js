// ============================================
// ТрансКом — Аналитика продаж v2.0
// Запуск: node analytics.js ["Боровая"] [days]
// Пример: node analytics.js "Боровая" 30
// ============================================

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const PLANFIX_URL = process.env.PLANFIX_URL || 'https://transkom.planfix.ru/rest/';
const PLANFIX_TOKEN = process.env.PLANFIX_TOKEN;
const GROK_API_KEY = process.env.GROK_API_KEY;

// --- Маппинг менеджеров ---
const MANAGERS = {
  'Боровая': { userId: 41, fullName: 'Ия Боровая' },
  // Добавляйте новых менеджеров сюда:
  // 'Фамилия': { userId: XX, fullName: 'Имя Фамилия' },
};

// --- Воронка продаж ---
const FUNNEL_ORDER = [
  'Новая', 'Обработка', 'Коммерческое предложение',
  'Вывезли/Нашли поставщика', 'Дожим', 'Договор и оплата',
  'Выполнение Работы', 'В работе', 'Сделанная', 'Сделка завершена'
];

// --- Утилиты ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function stripHtml(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function classifyComment(description) {
  const text = stripHtml(description).toLowerCase();
  if (text.startsWith('исходящий звонок')) return 'outgoing_call';
  if (text.startsWith('входящий звонок')) return 'incoming_call';
  if (text === 'ндз' || text.startsWith('ндз')) return 'ndz';
  if (!text || text.length < 3) return 'empty';
  return 'note';
}

// --- Планфикс API ---
async function planfixRequest(endpoint, data = {}, method = 'POST') {
  const url = PLANFIX_URL.replace(/\/$/, '') + endpoint;
  try {
    const resp = await axios({
      method,
      url,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PLANFIX_TOKEN}`
      },
      data: method === 'POST' ? data : undefined,
      maxRedirects: 10,
      timeout: 30000
    });
    return resp.data;
  } catch (err) {
    console.error(`  [API Error] ${endpoint}: ${err.response?.status || err.message}`);
    return null;
  }
}

async function getManagerTasks(userId, daysBack) {
  console.log(`\n📋 Загружаю сделки (user:${userId})...`);

  const filters = [
    { type: 97, operator: 'equal', value: `user:${userId}` }
  ];

  // Фильтр по дате создания, если указан период
  if (daysBack) {
    const now = new Date();
    const from = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const dateFrom = `${pad(from.getDate())}-${pad(from.getMonth() + 1)}-${from.getFullYear()}`;
    const dateTo = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
    filters.push({
      type: 12,
      operator: 'equal',
      value: { dateType: 'otherRange', dateFrom, dateTo }
    });
    console.log(`  📅 Период: ${dateFrom} — ${dateTo}`);
  }

  let allTasks = [];
  let offset = 0;
  const pageSize = 100;

  while (true) {
    const resp = await planfixRequest('/task/list', {
      offset,
      pageSize,
      fields: 'id,name,status,assignees,counterparty,dateCreated',
      filters
    });

    if (!resp || resp.result !== 'success') {
      console.error('  ❌ Ошибка загрузки задач');
      break;
    }

    const tasks = resp.tasks || [];
    if (tasks.length === 0) break;

    allTasks = allTasks.concat(tasks);
    console.log(`  ✅ Загружено: ${allTasks.length} сделок (offset ${offset})`);

    if (tasks.length < pageSize) break;
    offset += pageSize;
    await sleep(300);
  }

  console.log(`  📊 Итого сделок: ${allTasks.length}`);
  return allTasks;
}

async function getTaskComments(taskId) {
  const resp = await planfixRequest(`/task/${taskId}/comments/list`, {
    offset: 0,
    pageSize: 100,
    fields: 'id,description,type,dateTime,owner'
  });
  return (resp && resp.comments) || [];
}

// --- Аналитика ---
async function analyzeManager(managerKey, daysBack) {
  const manager = MANAGERS[managerKey];
  if (!manager) {
    console.error(`❌ Менеджер "${managerKey}" не найден. Доступные: ${Object.keys(MANAGERS).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 АНАЛИТИКА: ${manager.fullName}`);
  console.log(`📅 ${new Date().toLocaleDateString('ru-RU')} ${new Date().toLocaleTimeString('ru-RU')}`);
  if (daysBack) console.log(`📆 Период: последние ${daysBack} дней`);
  console.log(`${'='.repeat(50)}`);

  // 1. Получаем сделки
  const tasks = await getManagerTasks(manager.userId, daysBack);
  if (tasks.length === 0) {
    console.log('⚠️ Сделки не найдены.');
    return null;
  }

  // 2. Статистика по воронке
  const funnel = {};
  for (const t of tasks) {
    const status = t.status?.name || 'Без статуса';
    funnel[status] = (funnel[status] || 0) + 1;
  }

  console.log(`\n🔹 ВОРОНКА ПРОДАЖ:`);
  for (const stage of FUNNEL_ORDER) {
    if (funnel[stage]) {
      const bar = '█'.repeat(Math.min(funnel[stage], 40));
      console.log(`  ${stage}: ${funnel[stage]} ${bar}`);
    }
  }
  // Прочие статусы
  for (const [status, count] of Object.entries(funnel)) {
    if (!FUNNEL_ORDER.includes(status)) {
      console.log(`  ${status}: ${count}`);
    }
  }

  // 3. Загружаем комментарии (топ-50 свежих сделок чтобы не перегружать API)
  const recentTasks = tasks.sort((a, b) => b.id - a.id).slice(0, 50);
  console.log(`\n📞 Загружаю комментарии (топ-${recentTasks.length} свежих сделок)...`);

  let totalCalls = { outgoing_call: 0, incoming_call: 0, ndz: 0, note: 0 };
  let callDetails = [];

  for (let i = 0; i < recentTasks.length; i++) {
    const task = recentTasks[i];
    const comments = await getTaskComments(task.id);

    for (const c of comments) {
      const type = classifyComment(c.description);
      if (type !== 'empty') totalCalls[type]++;
      if (type === 'outgoing_call' || type === 'incoming_call') {
        callDetails.push({
          taskId: task.id,
          taskName: task.name,
          type,
          date: c.dateTime?.date,
          text: stripHtml(c.description).substring(0, 200)
        });
      }
    }

    if ((i + 1) % 10 === 0) {
      console.log(`  ... обработано ${i + 1}/${recentTasks.length} сделок`);
    }
    await sleep(200);
  }

  console.log(`\n📞 АКТИВНОСТЬ (топ-${recentTasks.length} сделок):`);
  console.log(`  Исходящие звонки: ${totalCalls.outgoing_call}`);
  console.log(`  Входящие звонки:  ${totalCalls.incoming_call}`);
  console.log(`  Не дозвонился:    ${totalCalls.ndz}`);
  console.log(`  Заметки:          ${totalCalls.note}`);

  // 4. Собираем данные для отчёта
  const reportData = {
    manager: manager.fullName,
    date: new Date().toISOString(),
    period: daysBack ? `${daysBack} дней` : 'все время',
    totalDeals: tasks.length,
    funnel,
    calls: totalCalls,
    recentCallsAnalyzed: recentTasks.length,
    lastCalls: callDetails.slice(0, 10)
  };

  fs.writeFileSync('latest_data.json', JSON.stringify(reportData, null, 2), 'utf8');
  console.log(`\n💾 Данные сохранены: latest_data.json`);

  return reportData;
}

// --- Grok AI отчёт ---
async function generateGrokReport(data) {
  if (!GROK_API_KEY) {
    console.log('\n⚠️ GROK_API_KEY не задан в .env — пропускаю ИИ-отчёт');
    return null;
  }

  console.log('\n🤖 Генерирую ИИ-отчёт через Grok...');

  const prompt = `Ты — аналитик отдела продаж компании ТрансКом (вывоз снега, Москва).
Составь краткий аналитический отчёт по менеджеру на основе данных ниже.

Менеджер: ${data.manager}
Период: ${data.period}
Всего сделок: ${data.totalDeals}

Воронка продаж:
${Object.entries(data.funnel).map(([k, v]) => `  ${k}: ${v}`).join('\n')}

Активность (по ${data.recentCallsAnalyzed} свежим сделкам):
  Исходящие звонки: ${data.calls.outgoing_call}
  Входящие звонки: ${data.calls.incoming_call}
  Не дозвонился (НДЗ): ${data.calls.ndz}
  Заметки: ${data.calls.note}

Сделай:
1. Краткую сводку (3-4 предложения)
2. Сильные стороны
3. Зоны роста / рекомендации
4. Оценку активности (высокая/средняя/низкая)

Формат: текст, без markdown, по-русски, кратко и по делу.`;

  try {
    const resp = await axios.post('https://api.x.ai/v1/chat/completions', {
      model: 'grok-3-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROK_API_KEY}`
      }
    });

    const aiText = resp.data.choices?.[0]?.message?.content || 'Ошибка генерации';
    console.log('\n🤖 ИИ-ОТЧЁТ:');
    console.log('─'.repeat(50));
    console.log(aiText);
    console.log('─'.repeat(50));
    return aiText;
  } catch (err) {
    console.error(`❌ Ошибка Grok API: ${err.response?.status || err.message}`);
    return null;
  }
}

// --- Главная функция ---
async function main() {
  const args = process.argv.slice(2);
  const managerKey = args[0] || 'Боровая';
  const daysBack = args[1] ? parseInt(args[1]) : null;

  if (!PLANFIX_TOKEN) {
    console.error('❌ PLANFIX_TOKEN не задан в .env');
    process.exit(1);
  }

  // Анализ
  const data = await analyzeManager(managerKey, daysBack);
  if (!data) return;

  // ИИ-отчёт
  const aiReport = await generateGrokReport(data);

  // Сохраняем полный отчёт в файл
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${pad(now.getDate())}_${pad(now.getMonth() + 1)}_${now.getFullYear()}`;
  const filename = `report_${dateStr}_${managerKey}.txt`;

  let report = '';
  report += `ОТЧЁТ: ${data.manager}\n`;
  report += `Дата: ${now.toLocaleDateString('ru-RU')} ${now.toLocaleTimeString('ru-RU')}\n`;
  report += `Период: ${data.period}\n`;
  report += `${'='.repeat(50)}\n\n`;
  report += `СДЕЛКИ: ${data.totalDeals}\n\n`;
  report += `ВОРОНКА:\n`;
  for (const [status, count] of Object.entries(data.funnel)) {
    report += `  ${status}: ${count}\n`;
  }
  report += `\nАКТИВНОСТЬ (${data.recentCallsAnalyzed} свежих сделок):\n`;
  report += `  Исходящие: ${data.calls.outgoing_call}\n`;
  report += `  Входящие:  ${data.calls.incoming_call}\n`;
  report += `  НДЗ:       ${data.calls.ndz}\n`;
  report += `  Заметки:   ${data.calls.note}\n`;

  if (aiReport) {
    report += `\n${'='.repeat(50)}\n`;
    report += `ИИ-АНАЛИЗ (Grok):\n\n${aiReport}\n`;
  }

  fs.writeFileSync(filename, report, 'utf8');
  console.log(`\n📄 Отчёт сохранён: ${filename}`);
  console.log('\n✅ Готово!');
}

main().catch(err => {
  console.error('Критическая ошибка:', err.message);
  process.exit(1);
});
