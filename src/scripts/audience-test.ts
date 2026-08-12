import { chromium } from 'playwright-core';
import * as fs from 'fs';
const DIR = 'G:/Aike-FBclaw/data/browser-profiles/fb_1722550179';
const state = JSON.parse(fs.readFileSync(DIR + '/state.json', 'utf-8'));
const ctx = await chromium.launchPersistentContext(DIR, {
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-name=受众选择'],
  viewport: { width: 1280, height: 900 },
  locale: 'zh-TW', timezoneId: 'Asia/Taipei',
});
await ctx.addCookies(state.cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain || '.facebook.com', path: c.path || '/' })));
const page = await ctx.newPage();

console.log('1. 登录');
await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);

console.log('2. 发帖');
const btn = await page.$('span:has-text("在想些什麼")');
if (!btn) { console.log('FAIL'); process.exit(1); }
await btn.click();
await page.waitForTimeout(4000);

console.log('3. 两步处理弹窗');
await page.evaluate(() => {
  // 第1步：确认政策公告
  const d1 = document.querySelector('div[role="dialog"]');
  if (d1) {
    const btns = d1.querySelectorAll('div[role="button"]');
    for (const b of btns) {
      const t = b.textContent?.trim() || '';
      if (t === '確定' || t === '繼續' || t === '下一步' || t === '了解' || t === 'OK') {
        (b as HTMLElement).click();
        return;
      }
    }
    // fallback: Enter
    d1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
});
await page.waitForTimeout(2000);
// 第2步：弹窗可能还在，再处理受众选择
await page.evaluate(() => {
  const d2 = document.querySelector('div[role="dialog"]');
  if (!d2) return 'no dialog';
  // 看看有没有确认按钮
  const btns = d2.querySelectorAll('div[role="button"]');
  for (const b of btns) {
    const t = b.textContent?.trim() || '';
    if (t === '完成' || t === '儲存' || t === '確定') { (b as HTMLElement).click(); return; }
  }
  // Enter
  d2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
});
await page.waitForTimeout(1500);
console.log('   弹窗已处理');

console.log('4. 输入文字');
await page.evaluate(() => {
  const ed = document.querySelector('div[contenteditable="true"], div[role="textbox"]');
  if (ed) { (ed as HTMLElement).focus(); (ed as HTMLElement).click(); }
});
await page.waitForTimeout(500);
await page.keyboard.type('Aike-FBclaw 实机测试', { delay: 60 });
console.log('   ✅ 已输入');

await page.screenshot({ path: 'G:/Aike-FBclaw/data/final-post.png' });
console.log('5. 截图 — 浏览器保持打开');
await new Promise(r => setTimeout(r, 30000));
await ctx.close();
