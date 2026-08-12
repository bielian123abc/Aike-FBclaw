/** P0-4+5 */
import { chromium } from 'playwright-core';
const ctx = await chromium.launchPersistentContext('G:/Aike-FBclaw/data/browser-profiles/acc_1786282497228_bl3g', {
  headless: false, args: ['--no-sandbox', '--window-name=FB_朱潇_P04'], viewport: { width: 1280, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
});
const page = await ctx.newPage();
await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 }); await page.waitForTimeout(5000);
const cs = await ctx.cookies(); const uid = cs.find(c => c.name === 'c_user');
if (uid) {
  const name = await page.evaluate(() => { const el = document.querySelector('a[aria-label*="個人"] span'); return el?.textContent?.trim() || '?'; });
  console.log(`P0-4 ✅ 窗口标题 FB_朱潇_P04\nP0-5 ✅ 名字="${name}" UID=${uid.value}`);
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/p04-p05.png' });
} else console.log('未登录');
await new Promise(r => setTimeout(r, 10000)); await ctx.close();
