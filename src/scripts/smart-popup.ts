import { chromium } from 'playwright-core';
import * as fs from 'fs';
const DIR = 'G:/Aike-FBclaw/data/browser-profiles/fb_1722550179';
const state = JSON.parse(fs.readFileSync(DIR + '/state.json', 'utf-8'));

async function test() {
  const ctx = await chromium.launchPersistentContext(DIR, {
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-name=弹窗处理'],
    viewport: { width: 1280, height: 900 },
    locale: 'zh-TW', timezoneId: 'Asia/Taipei',
  });
  await ctx.addCookies(state.cookies.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain || '.facebook.com', path: c.path || '/' })));
  const page = await ctx.newPage();

  // 登录
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  const uid = (await ctx.cookies()).find(c => c.name === 'c_user')?.value;
  console.log('UID:', uid);

  // 处理可能出现的弹窗 — 直接删 DOM
  async function rmDialog() {
    await page.evaluate(() => {
      const d = document.querySelector('div[role="dialog"]');
      if (d) d.remove();
    });
    await page.waitForTimeout(300);
  }
  await rmDialog();

  // 浏览
  for (let i = 0; i < 2; i++) { await page.evaluate(() => window.scrollBy(0, 600)); await page.waitForTimeout(1000); }

  // 发帖
  console.log('点击发帖...');
  const btn = await page.$('span:has-text("在想些什麼"), div[role="button"]:has-text("在想")');
  if (btn) { await btn.click(); console.log('✅ 点击成功'); }
  else { console.log('❌ 未找到按钮'); await ctx.close(); return; }

  await page.waitForTimeout(3000);
  await rmDialog(); // 删分享受众弹窗
  await rmDialog();
  console.log('弹窗已清除');

  // 输入文字
  const editor = await page.$('div[contenteditable="true"], div[role="textbox"]');
  if (editor) {
    await editor.click();
    await page.waitForTimeout(500);
    await page.keyboard.type('Aike-FBclaw 实机测试消息', { delay: 50 });
    console.log('✅ 已输入文字');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'G:/Aike-FBclaw/data/post-ready.png' });
    console.log('📸 截图');
  } else {
    // 可能弹窗还在，用 evaluate 强行找
    await page.evaluate(() => {
      const ed = document.querySelector('div[contenteditable="true"], div[role="textbox"]');
      if (ed) { (ed as HTMLElement).focus(); (ed as HTMLElement).click(); }
    });
    await page.keyboard.type('测试消息', { delay: 50 });
    console.log('✅ evaluate输入');
  }

  console.log('浏览器保持打开');
  await new Promise(r => setTimeout(r, 30000));
  await ctx.close();
}
test().catch(e => console.log('ERR:', e.message));
