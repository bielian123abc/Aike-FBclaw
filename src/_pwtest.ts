import { chromium } from 'playwright-core';
import { startMockFB } from './mock-facebook/server';
import { MOCK_FB_PORT, FB_BASE } from './config';

async function main() {
  startMockFB(MOCK_FB_PORT);
  await new Promise(r => setTimeout(r, 300));

  console.log('直接 chromium.launch 測試, FB_BASE=', FB_BASE);
  const browser = await chromium.launch({
    executablePath: 'C:/Users/UR/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
    headless: false,
    args: ['--window-size=1280,800'],
  });
  const page = await browser.newPage();
  console.log('before goto url=', page.url());
  await page.goto(FB_BASE + '/');
  console.log('after goto url=', page.url());
  await page.waitForTimeout(2000);
  console.log('after wait url=', page.url());
  console.log('title=', await page.title());
  const hasComposer = await page.$('div[aria-label="在想些什麼"]') || await page.$('div[role="button"]:has-text("在想些什麼")');
  console.log('composer 命中:', !!hasComposer);
  await page.screenshot({ path: 'data/screenshots/_pwtest.png' });
  await browser.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
