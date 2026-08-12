import { chromium } from 'playwright-core';
const ctx = await chromium.launchPersistentContext(
  'G:/Aike-FBclaw/data/browser-profiles/acc_1786282497228_bl3g', {
  headless: false, args: ['--no-sandbox', '--window-name=check'], viewport: { width: 1280, height: 900 },
});
const p = await ctx.newPage();
await p.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
await p.waitForTimeout(5000);
const c = (await ctx.cookies()).find(x => x.name === 'c_user');
console.log(c ? '已登录 UID=' + c.value : '未登录');
await p.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/check.png' });
await new Promise(r => setTimeout(r, 10000));
await ctx.close();
