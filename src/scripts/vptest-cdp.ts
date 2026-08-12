/**
 * 終極測試：直接 spawn Chrome + Playwright CDP 連接
 * 兩階段：先開 1000x700 截圖，再開 1800x1000 截圖，對比視口是否跟隨
 */
import { chromium } from 'playwright-core';
import { spawn } from 'child_process';

const PROFILE = 'G:/Aike-FBclaw/data/browser-profiles/acc_1786282497228_bl3g';
const CHROME = 'C:/Users/UR/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

async function testAtSize(label: string, w: number, h: number) {
  console.log(`\n=== ${label}: ${w}x${h} ===`);
  const cp = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`,
    '--remote-debugging-port=9223',
    `--window-size=${w},${h}`,
    '--window-position=0,0',
    '--no-first-run',
    '--no-default-browser-check',
    'https://www.facebook.com/',
  ], { stdio: 'pipe' });

  // 等 CDP
  let connected = false;
  for (let i = 0; i < 20; i++) {
    try {
      const resp = await fetch('http://127.0.0.1:9223/json/version');
      if (resp.ok) { connected = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!connected) { console.log('  CDP 失敗'); cp.kill(); return; }

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages().find((p: any) => p.url().includes('facebook')) 
            || browser.contexts()[0].pages()[0];
  await page.waitForTimeout(6000);

  const info = await page.evaluate(() => ({
    innerW: window.innerWidth, innerH: window.innerHeight,
    outerW: window.outerWidth, outerH: window.outerHeight,
    docW: document.documentElement.clientWidth,
    docH: document.documentElement.clientHeight,
  }));
  console.log('  innerW:', info.innerW, 'docW:', info.docW, 'outerW:', info.outerW);

  const shotPath = `G:/Aike-FBclaw/data/screenshots/vptest_cdp_${label}.png`;
  await page.screenshot({ path: shotPath });
  console.log('  截圖:', shotPath);

  await browser.close();
  cp.kill();
  await new Promise(r => setTimeout(r, 3000));
}

await testAtSize('narrow', 1000, 700);
await testAtSize('wide', 1800, 1000);
console.log('\n=== 完成 ===');
