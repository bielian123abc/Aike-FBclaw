/** P0-2 批量操作 */
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: false, args: ['--window-name=P0-2_批量操作'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:18991/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.click('button:has-text("账号管理")'); await page.waitForTimeout(1000);

await page.click('#selectAll'); await page.waitForTimeout(500);
const sel = await page.textContent('#selCount');
const btn = await page.$('#btnBrowseSel');
const disabled = await btn?.evaluate(el => (el as HTMLButtonElement).disabled);
console.log(`P0-2 已选=${sel} 按钮${!disabled?'启用':'禁用'}`);

if (!disabled) { await btn!.click(); console.log('  批量浏览已触发'); }
await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/p02-batch.png' });
console.log('截图 p02-batch.png');
await new Promise(r => setTimeout(r, 10000));
await browser.close();
