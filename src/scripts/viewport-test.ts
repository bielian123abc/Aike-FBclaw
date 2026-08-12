/**
 * 純淨對照測試：模擬正常 Chrome 打開 Facebook，只用設定檔 Cookie
 * 無任何指紋干擾、無自訂 viewport、無 init script
 * 分別測 900px、1200px、1920px 三個寬度
 */
import { chromium } from 'playwright-core';

const PROFILE = 'G:/Aike-FBclaw/data/browser-profiles/acc_1786282497228_bl3g';

const sizes = [
  { name: 'narrow', w: 900, h: 800 },
  { name: 'medium', w: 1200, h: 800 },
  { name: 'wide', w: 1920, h: 1000 },
];

for (const sz of sizes) {
  console.log(`\n=== 測試: ${sz.name} (${sz.w}x${sz.h}) ===`);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [
      '--no-sandbox',
      `--window-size=${sz.w},${sz.h}`,
      '--window-position=0,0',
    ],
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    // ★ 關鍵：不設 viewport、不設 deviceScaleFactor、不設 userAgent
    noViewport: true,
  });

  const page = ctx.pages()[0];

  // 導航
  await page.goto('https://www.facebook.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(5000);

  // 檢查視口
  const info = await page.evaluate(() => ({
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    outerW: window.outerWidth,
    outerH: window.outerHeight,
    docW: document.documentElement.clientWidth,
    docH: document.documentElement.clientHeight,
    screenW: screen.width,
    screenH: screen.height,
    dpr: window.devicePixelRatio,
    title: document.title,
  }));

  console.log('  視口:', JSON.stringify(info));

  // 截圖
  const shotPath = `G:/Aike-FBclaw/data/screenshots/vptest_${sz.name}.png`;
  await page.screenshot({ path: shotPath });
  console.log('  截圖:', shotPath);

  await ctx.close();
  await new Promise(r => setTimeout(r, 2000));
}

console.log('\n=== 全部完成 ===');
