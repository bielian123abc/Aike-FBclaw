import * as fs from 'fs';
const BASE = 'http://localhost:18991';
const DATA = 'G:/Aike-FBclaw/data';

// 还原被测试误删的真实账号 61590344349141（Johnny Garcia），仅恢复记录+指纹+代理，会话 Cookie 已随档案清理不可恢复
const restore = await fetch(BASE + '/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Johnny Garcia', accountId: '61590344349141', email: '61590344349141', mode: 'real', stage: 'mature', tags: ['真实号', '含cookie'], notes: '用户原账号（测试回收流程时曾被删除，已还原记录）' }) });
console.log('还原 61590344349141:', JSON.stringify(await restore.json()));

// 清理所有 recycle_ 测试账号
const acc = JSON.parse(fs.readFileSync(DATA + '/accounts.json', 'utf-8'));
const recycleIds = acc.filter(a => String(a.accountId).startsWith('recycle_')).map(a => a.accountId);
for (const id of recycleIds) {
  await fetch(BASE + '/api/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
  console.log('清理测试账号:', id);
}

// 最终核对
const final = await (await fetch(BASE + '/api/accounts')).json();
const fp = `G:/Aike-FBclaw/data/fingerprints/61590344349141.json`;
console.log('还原后账号总数:', final.accounts.length);
console.log('还原账号指纹已生成?', fs.existsSync(fp));
const pr = await (await fetch(BASE + '/api/proxy')).json();
console.log('代理已绑定:', (pr.proxies||[]).filter(p=>p.boundAccount).length, '/', (pr.proxies||[]).length);
