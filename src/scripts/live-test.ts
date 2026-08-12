// 你现在能看到这个浏览器窗口 — 真实操作全程可见
import { chromium } from 'playwright-core';
import * as fs from 'fs';

const DIR = 'G:/Aike-FBclaw/data/browser-profiles/fb_1722550179';
const state = JSON.parse(fs.readFileSync(DIR + '/state.json', 'utf-8'));

const ctx = await chromium.launchPersistentContext(DIR, {
  headless: false,  // 你能看到
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-name=FB测试-1722550179'],
  viewport: { width: 1280, height: 900 },
  locale: 'zh-TW', timezoneId: 'Asia/Taipei',
});

await ctx.addCookies(state.cookies.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain || '.facebook.com', path: c.path || '/' })));

const page = await ctx.newPage();
console.log('浏览器已打开在你的桌面');

// 1. 开FB
await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);
const cs = await ctx.cookies();
console.log('UID:', cs.find(c => c.name === 'c_user')?.value || 'NONE');
console.log('已登录，滚动中...');

// 2. 滚动3次（模拟浏览）
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(1500);
}
console.log('滚动完成，点赞中...');

// 3. 点赞
try {
  const btn = await page.$('[aria-label="讚"]');
  if (btn) { await btn.click(); console.log('点赞成功 ✅'); }
  else console.log('无点赞按钮');
} catch {}

// 截图
await page.screenshot({ path: 'G:/Aike-FBclaw/data/live-proof.png' });
console.log('截图已保存，浏览器保持打开30秒');
await new Promise(r => setTimeout(r, 30000));
await ctx.close();
