/**
 * 真实 FB 登录验证（只读）：
 * 对 5 个真实号逐个啟動瀏覽器 → 注入 cookie → 訪問 facebook.com → 檢測登錄態 → 截圖
 */
import { launchSession, screenshot, closeSession } from './core/browser/session-manager';
import { createPageDetector } from './detection/page-detector';
import { listAccounts } from './core/account-store';

async function testOne(uid: string) {
  console.log(`\n=== 真實號 ${uid} ===`);
  try {
    const session = await launchSession(uid, { headless: true });
    await session.page.waitForTimeout(6000);
    const det = createPageDetector(session.page);
    const info = await det.detectPageState();
    console.log(`  頁面: ${info.pageType} | 登入: ${info.isLoggedIn} | 帳號: ${info.currentUser || '(未識別)'}`);
    console.log(`  彈窗: ${info.activePopup} | 警告: ${info.warnings.join(';') || '無'}`);
    const shot = await screenshot(uid, 'real_login');
    console.log(`  截圖: ${shot}`);
    await closeSession(uid);
    return info.isLoggedIn;
  } catch (e: any) {
    console.log(`  ❌ 失敗: ${e.message}`);
    try { await closeSession(uid); } catch {}
    return false;
  }
}

async function run() {
  const accounts = listAccounts().filter(a => a.mode === 'real' && a.accountId !== '朱瀟');
  console.log(`[真實驗證] 共 ${accounts.length} 個真實號`);
  let ok = 0;
  for (const a of accounts) {
    const logged = await testOne(a.accountId);
    if (logged) ok++;
  }
  console.log(`\n[真實驗證] 登入成功 ${ok}/${accounts.length}`);
  process.exit(0);
}
run();
