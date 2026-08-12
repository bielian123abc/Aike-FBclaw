/**
 * 导入用户提供的真实 FB 账号（order-1NT5EDJ6C2NC.txt）
 * 格式: UID:TOKEN:base64({"cookies":[...]})
 * 把 cookie 写入各账号的 state.json，并注册到 accounts.json (mode=real)
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR, PROFILES_DIR } from './config';

const SRC = 'C:/Users/UR/Downloads/order-1NT5EDJ6C2NC.txt';

function main() {
  const raw = fs.readFileSync(SRC, 'utf-8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  console.log(`[導入] 讀到 ${lines.length} 行`);

  const accounts: any[] = [];

  for (const line of lines) {
    const parts = line.split(':');
    if (parts.length < 3) { console.log('[導入] 跳過無效行:', line.slice(0, 30)); continue; }
    const uid = parts[0];
    // token 在 parts[1]，base64 可能是 parts[2] 起的拼接（若含冒号，重新 join）
    const b64 = parts.slice(2).join(':');
    let cookies: any[] = [];
    try {
      const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
      cookies = json.cookies || [];
    } catch (e: any) {
      console.log(`[導入] ${uid} base64 解碼失敗: ${e.message}`);
      continue;
    }
    const hasCUser = cookies.some((c: any) => c.name === 'c_user');
    const hasXs = cookies.some((c: any) => c.name === 'xs');
    console.log(`[導入] ${uid} cookie數=${cookies.length} c_user=${hasCUser} xs=${hasXs}`);

    // 寫入 state.json
    const dir = path.join(PROFILES_DIR, uid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ cookies, origins: [] }, null, 2));

    accounts.push({
      accountId: uid,
      name: uid,
      email: uid,
      stage: 'mature',
      mode: 'real',
      status: 'offline',
      tags: ['真实号', '含cookie'],
      notes: `用戶提供真實FB號 (order文件)`,
      createdAt: Date.now(),
    });
  }

  // 保留朱潇（用戶手動，雖然 profile 缺登錄cookie）
  accounts.push({
    accountId: '朱瀟',
    name: '朱潇',
    email: '朱瀟',
    stage: 'mature',
    mode: 'real',
    status: 'offline',
    tags: ['内容号'],
    notes: '用戶手動登(但profile缺登錄cookie，需補登)',
    createdAt: 1786322852408,
    lastUsed: 1786322857299,
  });

  fs.writeFileSync(path.join(DATA_DIR, 'accounts.json'), JSON.stringify(accounts, null, 2));
  console.log(`[導入] 完成，共註冊 ${accounts.length} 個帳號（含朱潇）`);
}

main();
