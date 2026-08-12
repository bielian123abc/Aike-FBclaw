import fs from 'fs';
const BASE = 'http://localhost:18991';
const XLSX = 'G:/Aike-FBclaw/data/_verify_pwd.xlsx';
const ACC = 'test_pwd_002';
async function main() {
  const b64 = fs.readFileSync(XLSX).toString('base64');
  // 用同一份 xlsx，但帳號改為 test_pwd_002（email 同檔，UID 由我們覆寫不了，故直接測 import 回傳）
  let r = await fetch(BASE + '/api/accounts/import-xlsx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileB64: b64 }) });
  let j = await r.json();
  console.log('import resp:', JSON.stringify({ created: j.created, passwords: j.passwords, accounts: j.accounts }));
  // 取第一個建立出的帳號查詢標籤
  const id = j.accounts?.[0]?.accountId;
  if (id) {
    r = await fetch(BASE + '/api/account/' + id);
    const a = (await r.json()).account;
    console.log('imported account tags:', a?.tags, '| hasPassword:', !!a?.password);
    await fetch(BASE + '/api/accounts/' + id, { method: 'DELETE' });
    console.log('cleaned', id);
  }
  console.log('LIGHT VERIFY DONE');
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
