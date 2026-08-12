/**
 * 朱潇 Cookie 診斷：啟動 session 後，列舉 context 中所有 facebook.com 的 Cookie
 */
import { launchSession, closeSession } from './core/browser/session-manager';

async function run() {
  const session = await launchSession('朱瀟', { headless: true });
  await session.page.waitForTimeout(3000);

  const cookies = await session.context.cookies();
  const fbCookies = cookies.filter(c => c.domain.includes('facebook.com'));
  console.log('[診斷] 總 Cookie 數:', cookies.length);
  console.log('[診斷] facebook.com Cookie 數:', fbCookies.length);
  for (const c of fbCookies) {
    console.log(`  - ${c.name} (domain=${c.domain}, httpOnly=${c.httpOnly}, expires=${c.expires ? new Date(c.expires*1000).toISOString() : 'session'})`);
  }

  const hasCUser = fbCookies.some(c => c.name === 'c_user');
  const hasXs = fbCookies.some(c => c.name === 'xs');
  console.log('[診斷] 含 c_user:', hasCUser, '| 含 xs:', hasXs);

  // 也看 document.cookie
  const docCookie = await session.page.evaluate(() => document.cookie.slice(0, 300));
  console.log('[診斷] document.cookie(前300字):', docCookie || '(空)');

  await closeSession('朱瀟');
  process.exit(0);
}
run().catch(e => { console.error('失敗', e); process.exit(1); });
