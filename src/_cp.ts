/** 提取真實號的 checkpoint 彈窗文案 */
import { launchSession, closeSession } from './core/browser/session-manager';
import { listAccounts } from './core/account-store';

async function run() {
  const uids = listAccounts().filter(a => a.mode === 'real' && a.accountId !== '朱瀟').map(a => a.accountId);
  for (const uid of uids) {
    console.log(`\n=== ${uid} ===`);
    try {
      const s = await launchSession(uid, { headless: true });
      await s.page.waitForTimeout(6000);
      const txt = await s.page.evaluate(() => {
        const d = document.querySelector('div[role="dialog"], div[role="alertdialog"]');
        if (d) return (d as HTMLElement).innerText.slice(0, 600);
        // 也試試 body 裡的 checkpoint 關鍵字
        const b = document.body?.innerText || '';
        const idx = b.indexOf('Confirm');
        return idx >= 0 ? b.slice(Math.max(0, idx - 100), idx + 400) : '(無對話框，頁面文本前300字: ' + b.slice(0, 300) + ')';
      });
      console.log(txt);
      await closeSession(uid);
    } catch (e: any) { console.log('失敗', e.message); }
  }
  process.exit(0);
}
run();
