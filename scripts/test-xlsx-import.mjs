// 临时测试：把桌面 xlsx 导入到运行中的 server (:18991)
import * as fs from 'fs';

const XLSX = 'C:/Users/UR/Desktop/datr账号信息表.xlsx';
const buf = fs.readFileSync(XLSX);
const b64 = buf.toString('base64');

const r = await fetch('http://localhost:18991/api/accounts/import-xlsx', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fileB64: b64, filename: 'datr账号信息表.xlsx' }),
});
const j = await r.json();
console.log('IMPORT RESULT:', JSON.stringify(j, null, 2));

// 验证指纹文件生成
const newIds = (j.accounts || []).map(a => a.accountId);
console.log('\n指纹文件检查:');
for (const id of newIds.slice(0, 12)) {
  const fp = `G:/Aike-FBclaw/data/fingerprints/${id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40)}.json`;
  console.log(' ', id, '->', fs.existsSync(fp) ? 'OK' : 'MISSING');
}
console.log('\nCookie state 检查:');
for (const id of newIds.slice(0, 12)) {
  const st = `G:/Aike-FBclaw/data/browser-profiles/${id}/state.json`;
  if (fs.existsSync(st)) {
    const s = JSON.parse(fs.readFileSync(st, 'utf-8'));
    console.log(' ', id, '-> OK cookies=', s.cookies?.length);
  } else console.log(' ', id, '-> NO state.json');
}

// 验证代理分配
const pr = await fetch('http://localhost:18991/api/proxy');
const pj = await pr.json();
console.log('\n代理分配总数:', (pj.proxies || []).length, ' 已绑定:', (pj.proxies || []).filter(x => x.boundAccount).length);
