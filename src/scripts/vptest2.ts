/**
 * 終極測試：四種方法啟動瀏覽器，對比視口行為
 * A: launchPersistentContext + noViewport
 * B: launchPersistentContext + 自訂 viewport
 * C: chromium.launch + --user-data-dir
 * D: 直接 spawn chrome.exe + CDP
 */
import { chromium } from 'playwright-core';
import { spawn } from 'child_process';

const PROFILE = 'G:/Aike-FBclaw/data/browser-profiles/acc_1786282497228_bl3g';

// ===== Test A: launchPersistentContext + noViewport =====
console.log('=== Test A: launchPersistentContext + noViewport ===');
try {
  const ctxA = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: ['--no-sandbox', '--window-size=1000,700'],
    locale: 'zh-TW', timezoneId: 'Asia/Taipei',
    noViewport: true,
  });
  const pageA = ctxA.pages()[0];
  await pageA.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await pageA.waitForTimeout(3000);
  const infoA = await pageA.evaluate(() => ({
    innerW: window.innerWidth, innerH: window.innerHeight,
    outerW: window.outerWidth, outerH: window.outerHeight,
    docW: document.documentElement.clientWidth,
    docH: document.documentElement.clientHeight,
  }));
  console.log('  A:', JSON.stringify(infoA));
  await ctxA.close();
} catch (e: any) { console.log('  A error:', e.message.slice(0,80)); }

await new Promise(r => setTimeout(r, 3000));

// ===== Test B: launchPersistentContext + explicit viewport =====
console.log('=== Test B: launchPersistentContext + viewport 1400x900 ===');
try {
  const ctxB = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: ['--no-sandbox', '--window-size=1000,700'],
    locale: 'zh-TW', timezoneId: 'Asia/Taipei',
    viewport: { width: 1400, height: 900 },
  });
  const pageB = ctxB.pages()[0];
  await pageB.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await pageB.waitForTimeout(3000);
  const infoB = await pageB.evaluate(() => ({
    innerW: window.innerWidth, innerH: window.innerHeight,
    outerW: window.outerWidth, outerH: window.outerHeight,
    docW: document.documentElement.clientWidth,
  }));
  console.log('  B:', JSON.stringify(infoB));
  await ctxB.close();
} catch (e: any) { console.log('  B error:', e.message.slice(0,80)); }

await new Promise(r => setTimeout(r, 3000));

// ===== Test C: chromium.launch + --user-data-dir =====
console.log('=== Test C: chromium.launch + user-data-dir ===');
try {
  const browserC = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', `--user-data-dir=${PROFILE}`, '--window-size=1000,700'],
    channel: undefined,
  });
  const ctxC = browserC.contexts()[0];
  const pageC = ctxC.pages()[0];
  // Don't set viewport at all
  await pageC.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await pageC.waitForTimeout(3000);
  const infoC = await pageC.evaluate(() => ({
    innerW: window.innerWidth, innerH: window.innerHeight,
    outerW: window.outerWidth, outerH: window.outerHeight,
    docW: document.documentElement.clientWidth,
  }));
  console.log('  C:', JSON.stringify(infoC));
  await browserC.close();
} catch (e: any) { console.log('  C error:', e.message.slice(0,80)); }

console.log('\n=== 全部完成 ===');
