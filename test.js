/**
 * Тесты для analytics.js — запуск: node test.js
 * Проверяет: синтаксис, генерацию HTML, структуру данных, содержимое отчёта
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = path.join(__dirname, '.tools/node-v24.14.0-win-x64/node.exe');
const ANALYTICS = path.join(__dirname, 'analytics.js');

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push(`  \u2705 ${name}`);
  } catch (e) {
    failed++;
    results.push(`  \u274C ${name}: ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// 1. СИНТАКСИС
console.log('\n\uD83D\uDCCB 1. Синтаксис');

test('analytics.js — валидный JS', () => {
  execSync(`"${NODE}" --check "${ANALYTICS}"`, { stdio: 'pipe' });
});

// 2. ГЕНЕРАЦИЯ HTML ИЗ КЭША
console.log('\uD83D\uDCCB 2. Генерация HTML');

const managers = ['borovaya', 'mikhail'];
for (const mgr of managers) {
  test(`${mgr} --html генерируется без ошибок`, () => {
    const out = execSync(`"${NODE}" "${ANALYTICS}" ${mgr} --html`, {
      stdio: 'pipe', encoding: 'utf8', timeout: 30000
    });
    assert(out.includes('HTML'), `Нет подтверждения HTML в выводе: ${out.slice(0, 100)}`);
  });
}

// 3. СТРУКТУРА ДАННЫХ
console.log('\uD83D\uDCCB 3. Данные менеджеров');

for (const mgr of managers) {
  const dataFile = path.join(__dirname, 'data', `${mgr}_latest.json`);

  test(`${mgr}_latest.json существует`, () => {
    assert(fs.existsSync(dataFile), `Файл не найден: ${dataFile}`);
  });

  if (!fs.existsSync(dataFile)) continue;
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  test(`${mgr}: есть dealCards[]`, () => {
    assert(Array.isArray(data.dealCards), 'dealCards не массив');
    assert(data.dealCards.length > 0, 'dealCards пустой');
  });

  test(`${mgr}: есть manager`, () => {
    assert(data.manager, 'нет поля manager');
  });

  test(`${mgr}: есть dailyActivity`, () => {
    assert(data.dailyActivity, 'нет dailyActivity');
    assert(Array.isArray(data.dailyActivity.workedDeals), 'нет workedDeals');
  });

  test(`${mgr}: структура dealCard`, () => {
    const card = data.dealCards[0];
    assert(card.id, 'нет id');
    assert(card.name, 'нет name');
    assert(card.status !== undefined, 'нет status');
  });

  test(`${mgr}: есть звонки или комментарии`, () => {
    const hasData = data.dealCards.some(c =>
      (c.calls && c.calls.length > 0) || (c.comments && c.comments.length > 0)
    );
    assert(hasData, 'ни одна сделка не имеет звонков или комментариев');
  });
}

// 3.5. ФИЛЬТРАЦИЯ ПО ШАБЛОНАМ
console.log('\uD83D\uDCCB 3.5. Фильтрация по шаблонам');

// Код теперь в src/ — читаем все исходники
const SRC_DIR = path.join(__dirname, 'src');
const srcFiles = fs.existsSync(SRC_DIR)
  ? fs.readdirSync(SRC_DIR, { recursive: true }).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(SRC_DIR, f), 'utf8')).join('\n')
  : fs.readFileSync(ANALYTICS, 'utf8');

test('ALLOWED_TEMPLATES содержит "Сделка" и "Вывоз снега"', () => {
  assert(srcFiles.includes("ALLOWED_TEMPLATES"), 'нет константы ALLOWED_TEMPLATES');
  assert(srcFiles.includes("'Сделка'") || srcFiles.includes('"Сделка"'), 'нет шаблона Сделка');
  assert(srcFiles.includes("'Вывоз снега'") || srcFiles.includes('"Вывоз снега"'), 'нет шаблона Вывоз снега');
});

test('DEAL_FIELDS содержит template', () => {
  const m = srcFiles.match(/DEAL_FIELDS\s*=\s*['"](.*?)['"]/);
  assert(m, 'не найден DEAL_FIELDS');
  assert(m[1].includes('template'), 'DEAL_FIELDS не содержит template');
});

test('buildDealCards фильтрует по ALLOWED_TEMPLATES', () => {
  assert(srcFiles.includes('ALLOWED_TEMPLATES.some'), 'нет фильтрации по ALLOWED_TEMPLATES в buildDealCards');
});

test('dealCard содержит поле template', () => {
  assert(srcFiles.includes('template: t.template') || srcFiles.includes('template:t.template'), 'шаблон не сохраняется в карточке сделки');
});

// 4. HTML ОТЧЁТЫ
console.log('\uD83D\uDCCB 4. HTML отчёты');

for (const mgr of managers) {
  const htmlFile = path.join(__dirname, 'reports', `${mgr}.html`);

  test(`${mgr}.html существует`, () => {
    assert(fs.existsSync(htmlFile), `Файл не найден: ${htmlFile}`);
  });

  if (!fs.existsSync(htmlFile)) continue;
  const html = fs.readFileSync(htmlFile, 'utf8');

  test(`${mgr}.html: размер > 10KB`, () => {
    assert(html.length > 10000, `Слишком маленький: ${html.length} байт`);
  });

  test(`${mgr}.html: содержит данные (D=)`, () => {
    assert(html.includes('const D=') || html.includes('var D='), 'Нет встроенных данных');
  });

  test(`${mgr}.html: есть вкладки`, () => {
    assert(html.includes('Статистика'), 'нет вкладки Статистика');
    assert(html.includes('Воронка'), 'нет вкладки Воронка');
    assert(html.includes('Руководитель'), 'нет вкладки Руководитель');
  });

  test(`${mgr}.html: есть период по неделям`, () => {
    assert(html.includes('buildPeriodButtons') || html.includes('getWeekRange'), 'нет кнопок периодов по неделям');
  });

  test(`${mgr}.html: script теги сбалансированы`, () => {
    const open = (html.match(/<script/g) || []).length;
    const close = (html.match(/<\/script/g) || []).length;
    assert(open === close, `${open} открытых, ${close} закрытых`);
  });
}

// 5. DEPLOY
console.log('\uD83D\uDCCB 5. Deploy');

test('deploy/index.html (дашборд) существует', () => {
  assert(fs.existsSync(path.join(__dirname, 'deploy', 'index.html')), 'нет дашборда');
});

for (const mgr of managers) {
  test(`deploy/${mgr}/index.html существует`, () => {
    assert(fs.existsSync(path.join(__dirname, 'deploy', mgr, 'index.html')), `нет deploy/${mgr}`);
  });
}

// 6. НАВИГАЦИЯ
console.log('\uD83D\uDCCB 6. Навигация');

for (const mgr of managers) {
  const htmlFile = path.join(__dirname, 'deploy', mgr, 'index.html');
  if (!fs.existsSync(htmlFile)) continue;
  const html = fs.readFileSync(htmlFile, 'utf8');

  test(`deploy/${mgr}: ссылки на других менеджеров`, () => {
    const others = managers.filter(m => m !== mgr);
    for (const other of others) {
      assert(html.includes(`../${other}/index.html`), `нет ссылки на ${other}`);
    }
  });
}

// ИТОГО
console.log('\n' + results.join('\n'));
console.log(`\n${'='.repeat(40)}`);
console.log(`Итого: ${passed} \u2705  ${failed} \u274C`);
if (failed > 0) {
  console.log('\u26A0\uFE0F  Есть ошибки!\n');
  process.exit(1);
} else {
  console.log('\uD83C\uDF89 Все тесты пройдены!\n');
}
