/** P0-1 密码填充 - 单独验证 */
import { chromium } from 'playwright-core';

const ctx = await chromium.launchPersistentContext('G:/Aike-FBclaw/data/browser-profiles/p01_verify', {
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-name=P0-1_密码填充'],
  viewport: { width: 1280, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
});
const page = await ctx.newPage();
await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(5000);

const emailEl = await page.$('input[name="email"]');
const passEl = await page.$('input[name="pass"]');

if (emailEl && passEl) {
  await emailEl.click(); await page.keyboard.type('61590850305313', { delay: 50 });
  await passEl.click(); await page.keyboard.type('Lb@#9373387392542', { delay: 50 });
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/p01-filled.png' });
  console.log('P0-1 ✅ 密码已填入 | 截图 p01-filled.png');
} else {
  const cs = await ctx.cookies();
  const uid = cs.find(c => c.name === 'c_user');
  if (uid) console.log(`P0-1 ✅ 已登录 UID=${uid.value} | Cookie持久化生效`);
  else console.log('P0-1 ❌ 未找到表单且未登录');
}

await new Promise(r => setTimeout(r, 10000));
await ctx.close();
