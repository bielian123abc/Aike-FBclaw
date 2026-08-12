// 为所有缺少指纹文件的账号补齐指纹环境（幂等）
import { listAccounts } from '../src/core/account-store';
import { getFingerprintEngine } from '../src/core/browser/fingerprint';

const engine = getFingerprintEngine();
const accounts = listAccounts();
let gen = 0;
for (const a of accounts) {
  engine.loadOrCreate(a.accountId);
  gen++;
}
console.log(`已确保 ${gen} 个账号均具备指纹环境（含刚刚还原的账号）`);
