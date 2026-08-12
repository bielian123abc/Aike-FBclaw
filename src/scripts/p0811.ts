/** P0-8 Messenger P0-11 Data */
import { chromium } from 'playwright-core';
import * as fs from 'fs';

const ctx = await chromium.launchPersistentContext('G:/Aike-FBclaw/data/browser-profiles/acc_1786282497228_bl3g', {
  headless: false, args: ['--no-sandbox', '--window-name=P0_验收'], viewport: { width: 1280, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
});
const page = await ctx.newPage();

// P0-8 Messenger
await page.goto('https://www.messenger.com/', { waitUntil: 'load', timeout: 20000 });
await page.waitForTimeout(5000);
const msgrTitle = await page.title();
const msgrLoggedIn = msgrTitle.includes('Messenger') || msgrTitle.includes('Messages') || await page.$('a[aria-label*="聊天"]') !== null;
console.log(`P0-8 Messenger: ${msgrLoggedIn ? '✅已打开' : '⚠️'} "${msgrTitle.slice(0,30)}"`);
await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/p08-messenger.png' });

// P0-11 Data collection
await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 20000 }); await page.waitForTimeout(4000);
const friends = await page.$$eval('a[href*="/friends"] span', els => els.length);
const articles = await page.$$eval('div[role="article"]', els => els.length);
console.log(`P0-11 采集: 好友链接=${friends} 帖子=${articles}`);

await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/p08-p11.png' });
console.log('截图 p08-p11.png');
await new Promise(r => setTimeout(r, 8000)); await ctx.close();
