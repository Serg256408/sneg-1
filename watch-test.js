/**
 * File watcher — автоматически запускает тесты при изменении analytics.js или src/
 * Запуск: node watch-test.js (или через npm run watch)
 * Работает независимо от IDE/чата — следит за файлами на диске
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const NODE = path.join(__dirname, '.tools/node-v24.14.0-win-x64/node.exe');
const ANALYTICS = path.join(__dirname, 'analytics.js');
const SRC_DIR = path.join(__dirname, 'src');
const TEST_FILE = path.join(__dirname, 'test.js');

let debounce = null;

function runTests(changedFile) {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    const time = new Date().toLocaleTimeString('ru-RU');
    console.log(`\n\u23F1\uFE0F  ${time} \u2014 ${changedFile} \u0438\u0437\u043C\u0435\u043D\u0451\u043D, \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u044E \u0442\u0435\u0441\u0442\u044B...\n`);
    try {
      const result = execSync(`"${NODE}" "${TEST_FILE}"`, {
        encoding: 'utf8', stdio: 'pipe', timeout: 60000
      });
      console.log(result);
    } catch (e) {
      if (e.stdout) console.log(e.stdout);
      if (e.stderr) console.error(e.stderr);
      console.log('\n\u26A0\uFE0F  \u0422\u0435\u0441\u0442\u044B \u043D\u0435 \u043F\u0440\u043E\u0448\u043B\u0438! \u0418\u0441\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u043E\u0448\u0438\u0431\u043A\u0438.\n');
    }
  }, 1000);
}

console.log('\uD83D\uDC41\uFE0F  \u0421\u043B\u0435\u0436\u0443 \u0437\u0430 analytics.js + src/ \u2014 \u0442\u0435\u0441\u0442\u044B \u0437\u0430\u043F\u0443\u0441\u0442\u044F\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u043F\u0440\u0438 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0438');
console.log('   \u041D\u0430\u0436\u043C\u0438\u0442\u0435 Ctrl+C \u0447\u0442\u043E\u0431\u044B \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C\n');

// Следим за analytics.js
fs.watch(ANALYTICS, () => runTests('analytics.js'));

// Следим за src/ рекурсивно
fs.watch(SRC_DIR, { recursive: true }, (ev, filename) => {
  if (filename && filename.endsWith('.js')) runTests('src/' + filename);
});
