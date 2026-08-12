import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: false, args: ['--window-name=任务面板_卡片视图'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:18991/', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000);
await page.click('button:has-text("账号管理")'); await page.waitForTimeout(1000);

// 先给账号设置分组
const rows = await page.$$('#tableBody tr');
console.log(`账号数: ${rows.length}`);

// 切到任务面板看卡片
await page.click('button:has-text("任务")'); await page.waitForTimeout(1500);
const cards = await page.$$('#accountCards > div');
console.log(`卡片数: ${cards.length}`);

// 点击第一张卡片
if (cards.length > 0) { await cards[0].click(); await page.waitForTimeout(500); }

// 找操作按钮
const opBtns = await page.$$('#opPanel button');
console.log(`操作按钮: ${opBtns.length}个`);

await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/card-view.png' });
console.log('截图 card-view.png ✅');
await new Promise(r => setTimeout(r, 15000)); await browser.close();
