/**
 * 朱潇真实账号连通性验证（只读）：
 * 启动浏览器 → 加载朱潇 profile 的登录 Cookie → 检测页面类型 → 截图
 */
import { launchSession, screenshot, closeSession } from './core/browser/session-manager';
import { createPageDetector } from './detection/page-detector';

async function run() {
  console.log('[朱潇] 啟動瀏覽器（真實 FB，mode=real）...');
  const session = await launchSession('朱瀟', { headless: true });

  const url = session.page.url();
  console.log('[朱潇] 初始 URL:', url);

  // 等待 FB 加載
  await session.page.waitForTimeout(4000);

  const detector = createPageDetector(session.page);
  const info = await detector.detectPageState();
  console.log('[朱潇] 頁面類型:', info.pageType, '| 標題:', info.title, '| 已登入:', info.isLoggedIn);
  console.log('[朱潇] 彈窗:', info.activePopup, '| 帳號:', info.currentUser);
  console.log('[朱潇] 決策建議:', info.suggestedActions.map(a => a.action).join(', '));

  // 嘗試偵測帳號名稱（已登入時）
  let accountName = '';
  try {
    accountName = await session.page.evaluate(() => {
      const el = document.querySelector('a[aria-label*="主頁"], a[href*="/me"], h1');
      return el?.textContent?.trim() || '';
    });
  } catch {}
  console.log('[朱潇] 帳號名稱(推測):', accountName.slice(0, 40));

  const shot = await screenshot('朱瀟', 'real_connectivity');
  console.log('[朱潇] 截圖:', shot);

  await closeSession('朱瀟');
  console.log('[朱潇] 完成。已登入 =', info.isLoggedIn, '| 頁面 =', info.pageType);
  process.exit(0);
}

run().catch(e => { console.error('[朱潇] 失敗', e); process.exit(1); });
