import { chromium } from 'playwright-core';
import * as fs from 'fs';

const DIR = 'G:/Aike-FBclaw/data/browser-profiles/acc_1786282497228_bl3g';
const ctx = await chromium.launchPersistentContext(DIR, {
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-name=FB_最终验证'],
  viewport: { width: 1280, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
});
const page = await ctx.newPage();
await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(5000);

const R: string[] = [];
const cs = await ctx.cookies();
const uid = cs.find(c => c.name === 'c_user');

if (uid) {
  R.push(`✅ 登录: UID=${uid.value}`);
  const name = await page.evaluate(() => {
    const el = document.querySelector('a[aria-label*="個人"] span, h1 span');
    return el?.textContent?.trim() || document.title?.replace('Facebook','').trim();
  });
  R.push(`✅ 名字: ${name}`);
  
  // 完整任务链: 浏览+点赞+采集
  for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, 700)); await page.waitForTimeout(1500); }
  R.push('✅ 浏览 3次');
  
  const like = await page.$('[aria-label="讚"]');
  if (like) { await like.click(); R.push('✅ 点赞'); await page.waitForTimeout(1000); }
  
  // 采集数据
  const friendsLink = await page.$('a[href*="/friends"] span');
  const posts = await page.$$eval('div[role="article"], div[data-pagelet]', els => els.length);
  R.push(`✅ 采集: ${friendsLink ? '好友=' + await friendsLink.textContent() : '无好友链接'} 帖子区域=${posts}`);
  
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/final-delivery.png' });
  R.push('📸 final-delivery.png');
} else {
  R.push('❌ 未登录');
}

fs.writeFileSync('G:/Aike-FBclaw/data/final-report.txt', R.join('\n'));
console.log(R.join('\n'));
await new Promise(r => setTimeout(r, 30000));
await ctx.close();
