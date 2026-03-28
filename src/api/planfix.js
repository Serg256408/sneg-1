// ============================================================
// planfix.js — HTTP-клиент и Planfix API
// ============================================================

const { fs, path, os, API_URL, TOKEN, AUTH, DEAL_FIELDS, MANAGERS_LIST } = require('../utils/config');
const { sleep } = require('../utils/helpers');

let useAxios = true, axios;
try { axios = require('axios'); } catch { useAxios = false; }

async function httpPost(url, body, headers) {
  if (useAxios) {
    try { return (await axios.post(url, body, { headers, timeout: 30000, maxRedirects: 10 })).data; }
    catch (e) { if (e.message?.includes('redirect')) { useAxios = false; return httpPost(url, body, headers); } throw e; }
  }
  const { execFileSync } = require('child_process');
  const tmp = path.join(os.tmpdir(), 'pf_' + Date.now() + '.json');
  try {
    fs.writeFileSync(tmp, JSON.stringify(body));
    const a = ['-s', '-L', '-X', 'POST', url];
    for (const [k, v] of Object.entries(headers || {})) a.push('-H', `${k}: ${v}`);
    a.push('-d', `@${tmp}`);
    return JSON.parse(execFileSync('curl', a, { encoding: 'utf8', timeout: 30000 }));
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

async function httpGet(url, headers) {
  if (useAxios) return (await axios.get(url, { headers, timeout: 30000 })).data;
  const { execFileSync } = require('child_process');
  const a = ['-s', '-L', url];
  for (const [k, v] of Object.entries(headers || {})) a.push('-H', `${k}: ${v}`);
  return JSON.parse(execFileSync('curl', a, { encoding: 'utf8', timeout: 30000 }));
}

const pf = (ep, body) => httpPost(API_URL + ep, body, AUTH);
const pfGet = (ep) => httpGet(API_URL + ep, AUTH);

async function discoverEmployees() {
  const users = new Map();
  for (let off = 0; off < 500; off += 100) {
    try {
      const r = await pf('/task/list', { offset: off, pageSize: 100, fields: 'id,assignees' });
      for (const t of (r.tasks || [])) {
        for (const u of (t.assignees?.users || [])) {
          const numId = parseInt((u.id || '').replace('user:', ''));
          if (numId && u.name) users.set(numId, u.name);
        }
      }
      if ((r.tasks || []).length < 100) break;
    } catch { break; }
  }
  for (const m of MANAGERS_LIST) users.set(m.userId, m.name);
  return [...users.entries()].map(([id, name]) => {
    const existing = MANAGERS_LIST.find(m => m.userId === id);
    const lastName = name.split(' ').pop();
    return {
      userId: id, name,
      alias: existing?.alias || lastName.toLowerCase().replace(/[^a-zа-яё]/gi, ''),
      pfName: existing?.pfName || lastName,
    };
  });
}

async function getAllTasks(userId, role) {
  const all = [];
  let offset = 0;
  while (true) {
    process.stdout.write(`  Сделки (исполнитель) offset=${offset}...`);
    const d = await pf('/task/list', { offset, pageSize: 100,
      filters: [{ type: 97, operator: 'equal', value: `user:${userId}` }],
      fields: DEAL_FIELDS,
    });
    const tasks = d.tasks || [];
    console.log(` ${tasks.length}`);
    if (!tasks.length) break;
    all.push(...tasks);
    if (tasks.length < 100) break;
    offset += 100;
  }
  const seenIds = new Set(all.map(t => t.id));
  offset = 0;
  while (true) {
    process.stdout.write(`  Сделки (участник) offset=${offset}...`);
    const d = await pf('/task/list', { offset, pageSize: 100,
      filters: [{ type: 51, operator: 'equal', value: `user:${userId}` }],
      fields: DEAL_FIELDS,
    });
    const tasks = d.tasks || [];
    console.log(` ${tasks.length}`);
    if (!tasks.length) break;
    for (const t of tasks) {
      if (!seenIds.has(t.id)) { all.push(t); seenIds.add(t.id); }
    }
    if (tasks.length < 100) break;
    offset += 100;
  }
  return all;
}

async function getTaskComments(taskId) {
  try {
    const d = await pf(`/task/${taskId}/comments/list`, {
      offset: 0, pageSize: 100, fields: 'id,description,type,dateTime,owner,files',
    });
    if (String(taskId) === '31811' && d.comments) {
      const calls = d.comments.filter(c => {
        const desc = (c.description || '').toLowerCase();
        return desc.includes('звонок') || (c.files || []).some(f => (f.name||'').includes('Запись'));
      });
      console.log(`  🔍 Диагностика #31811: ${calls.length} звонков из ${d.comments.length} комментариев`);
      calls.slice(0, 3).forEach(c => {
        console.log(`    comment ${c.id}: desc=${(c.description||'').length}б type=${c.type} files=${(c.files||[]).map(f=>f.name).join(',')} desc_preview="${(c.description||'').substring(0,100)}"`);
      });
    }
    return d.comments || [];
  } catch { return []; }
}

async function getContactComments(contactId) {
  const id = String(contactId).replace('contact:', '');
  const body = { offset: 0, pageSize: 100, fields: 'id,description,type,dateTime,owner,files' };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const tm = attempt === 1 ? 15000 : attempt === 2 ? 25000 : 40000;
      const d = useAxios
        ? (await axios.post(API_URL + `/contact/${id}/comments/list`, body, { headers: AUTH, timeout: tm, maxRedirects: 10 })).data
        : await pf(`/contact/${id}/comments/list`, body);
      return d.comments || [];
    } catch (e) {
      if (attempt < 3) { await sleep(2000 * attempt); continue; }
      console.error(`    ⚠️ Contact ${contactId} error: ${e.message}`);
      return [];
    }
  }
  return [];
}

module.exports = { httpPost, httpGet, pf, pfGet, discoverEmployees, getAllTasks, getTaskComments, getContactComments };
