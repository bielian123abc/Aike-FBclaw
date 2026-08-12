// 驗證「Cookie 直登 + 帳號密碼填充」接線：
// 1) xlsx 匯入讀取密碼欄(D) → 帳號存 password + 標籤「含密碼」
// 2) 單帳號 update API 設密碼/Cookie → 寫入 state.json
// 3) 啟動該帳號觸發 ensureSession 兜底：未登入且有密碼 → clearCookies + skillLogin 被呼叫（不崩潰）
// 4) 清理測試帳號
import fs from 'fs';
import path from 'path';
const BASE = 'http://localhost:18991';
const XLSX = 'G:/Aike-FBclaw/data/_verify_pwd.xlsx';
const ACC = 'test_pwd_001';
const PROFILE_STATE = path.join('G:/Aike-FBclaw/data/browser-profiles', ACC, 'state.json');

async function getAcc() {
  const r = await fetch(BASE + '/api/account/' + ACC);
  return (await r.json()).account;
}
async function main() {
  const b64 = fs.readFileSync(XLSX).toString('base64');

  // 1) 匯入（含密碼欄 D）
  let r = await fetch(BASE + '/api/accounts/import-xlsx', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileB64: b64 }),
  });
  let j = await r.json();
  console.log('[1] import ->', JSON.stringify({ created: j.created, passwords: j.passwords, cookieRestored: j.cookieRestored }));

  let a = await getAcc();
  console.log('[2] after import -> password=', a?.password, '| tags=', a?.tags);

  // 2) update API：設密碼 + 假 Cookie
  r = await fetch(BASE + '/api/account/' + ACC + '/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'newpass', cookies: 'datr=x;sb=y;c_user=' + ACC + ';xs=1%3Aabc' }),
  });
  j = await r.json();
  console.log('[3] update -> success=', j.success, '| cookiesWritten=', j.cookiesWritten);
  a = await getAcc();
  console.log('[4] after update -> password=', a?.password, '| tags=', a?.tags);
  const stateExists = fs.existsSync(PROFILE_STATE);
  const stateHasCuser = stateExists && fs.readFileSync(PROFILE_STATE, 'utf-8').includes('c_user=' + ACC);
  console.log('[5] state.json exists=', stateExists, '| has c_user=', stateHasCuser);

  // 3) 啟動 → ensureSession 兜底路徑（clearCookies + skillLogin 會被呼叫；假憑證必然失敗，但不應 500）
  console.log('[6] launching (fallback path)...');
  try {
    r = await fetch(BASE + '/api/account/' + ACC + '/launch', { method: 'POST', signal: AbortSignal.timeout(150000) });
    j = await r.json();
    console.log('[6] launch resp ->', JSON.stringify(j).slice(0, 200));
  } catch (e) {
    console.log('[6] launch threw (非預期):', e.message);
  }
  await new Promise(res => setTimeout(res, 3000));
  a = await getAcc();
  console.log('[7] after launch -> status=', a?.status, '(預期 error/checkpoint，證明 fallback 已執行且不崩潰)');

  // 關閉 + 清理
  await fetch(BASE + '/api/account/' + ACC + '/close', { method: 'POST' }).catch(() => {});
  r = await fetch(BASE + '/api/accounts/' + ACC, { method: 'DELETE' });
  j = await r.json();
  console.log('[8] delete ->', JSON.stringify(j));
  const cleaned = !fs.existsSync(path.join('G:/Aike-FBclaw/data/browser-profiles', ACC));
  console.log('[9] profile cleaned=', cleaned);
  console.log('\nVERIFY DONE');
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
