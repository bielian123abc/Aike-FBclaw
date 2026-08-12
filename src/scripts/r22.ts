import { chromium } from 'playwright-core';
import * as fs from 'fs';

const ctx = await chromium.launchPersistentContext(
  'G:/Aike-FBclaw/data/browser-profiles/acc_1786282497228_bl3g', {
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-name=Aike-FBclaw_朱潇'],
  viewport: { width: 1280, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
});
const page = await ctx.newPage();

await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(5000);

const uid = (await ctx.cookies()).find(c => c.name === 'c_user');
if (uid) {
  const name = await page.evaluate(() => {
    const el = document.querySelector('a[aria-label*="個人"] span');
    return el?.textContent?.trim() || document.title?.replace(/\(?\d+\)?\s*/, '').replace('Facebook','').trim();
  });
  console.log(`UID:${uid.value} 名字:${name}`);
  
  for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, 700)); await page.waitForTimeout(1500); }
  console.log('浏览 ✅');
  
  const like = await page.$('[aria-label="讚"]');
  if (like) { await like.click(); console.log('点赞 ✅'); await page.waitForTimeout(1000); }
  else console.log('点赞: 无按钮');

  const friends = await page.$$eval('a[href*="/friends"]', els => els.length);
  const posts = await page.$$eval('div[role="article"]', els => els.length);
  console.log(`采集: 好友链接=${friends} 帖子=${posts}`);
  
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/r22-verify.png' });
  
  // 进化数据
  const stats = JSON.parse(fs.readFileSync('G:/Aike-FBclaw/data/evolution-stats.json', 'utf-8') || '{}');
  const today = Object.entries(stats).pop();
  console.log(`进化: ${JSON.stringify(today)}`);
  
  console.log('r22-verify.png ✅');
} else {
  console.log('未登录');
}

await new Promise(r => setTimeout(r, 30000));
await ctx.close();
