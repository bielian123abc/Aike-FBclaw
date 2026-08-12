import * as fs from 'fs';
const BASE = 'http://localhost:18991';
const DATA = 'G:/Aike-FBclaw/data';

// 读磁盘上的真实赋值映射
const proxiesRaw = JSON.parse(fs.readFileSync(DATA + '/proxies.json', 'utf-8'));
const assignment = proxiesRaw.assignment || {}; // accountId -> proxyId
const proxies = proxiesRaw.proxies || [];
const idToName = {};
const accRaw = JSON.parse(fs.readFileSync(DATA + '/accounts.json', 'utf-8'));
accRaw.forEach(a => idToName[a.accountId] = a.name);

// 找出“最低索引且已绑定”的代理（池顺序）
let lowestProxyId = null, lowestAccId = null;
for (const px of proxies) {
  const acc = Object.keys(assignment).find(k => assignment[k] === px.id);
  if (acc) { lowestProxyId = px.id; lowestAccId = acc; break; }
}
console.log('最低索引已绑定代理:', lowestProxyId, ' 绑定账号:', lowestAccId, '(', idToName[lowestAccId], ')');

// 删除该账号 —— 释放该槽位
const del = await fetch(BASE + '/api/accounts/' + encodeURIComponent(lowestAccId), { method: 'DELETE' });
console.log('DELETE', lowestAccId, '=', JSON.stringify(await del.json()));

// 新建唯一账号并自动顺序分配
const NEW_ID = 'recycle_low_' + Date.now();
await fetch(BASE + '/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'recycle_low', accountId: NEW_ID, mode: 'real' }) });
const assign = await (await fetch(BASE + '/api/proxy/auto-assign', { method: 'POST' })).json();
console.log('auto-assign:', JSON.stringify(assign));

// 重新读赋值映射
const a2 = JSON.parse(fs.readFileSync(DATA + '/proxies.json', 'utf-8')).assignment || {};
const newProxy = a2[NEW_ID];
console.log('新账号分配到的代理:', newProxy);
console.log('是否精确回填被释放的最低槽位?', newProxy === lowestProxyId ? 'YES ✅（顺序回填对应槽位）' : 'NO (分配到 ' + newProxy + ')');

// 清理
await fetch(BASE + '/api/accounts/' + encodeURIComponent(NEW_ID), { method: 'DELETE' }).catch(()=>{});
