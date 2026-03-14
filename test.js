require('dotenv').config();
const axios = require('axios');

const API = process.env.PLANFIX_URL;
const TOKEN = process.env.PLANFIX_TOKEN;
const headers = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const SALES = ['Новая','Обработка','Коммерческое предложение','Вывезли/Нашли поставщика','Дожим','Договор и оплата','Выполнение работ','Выполнение Работы'];

async function run() {
  // Сканируем дальше большими шагами чтобы найти ID 30000+
  for (const offset of [3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]) {
    try {
      const r = await axios.post(`${API}task/list`, {
        offset, pageSize: 10,
        fields: "id,name,status,assignees"
      }, { headers });
      const tasks = r.data.tasks || [];
      if (!tasks.length) { console.log(`offset ${offset}: КОНЕЦ БАЗЫ`); break; }
      const ids = tasks.map(t=>t.id);
      const borovaya = tasks.filter(t => t.assignees?.users?.some(u => u.name.includes('Боровая')));
      const sales = tasks.filter(t => SALES.includes(t.status?.name));
      console.log(`offset ${offset}: ID ${ids[0]}..${ids[ids.length-1]} | воронка: ${sales.length} | Боровая: ${borovaya.length}`);
      if (borovaya.length > 0) borovaya.forEach(t => console.log(`  ✅ [${t.id}] ${t.name?.slice(0,50)}`));
    } catch(e) { console.log(`offset ${offset}: ошибка`); }
  }
}

run().catch(console.error);
