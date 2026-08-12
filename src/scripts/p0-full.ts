/** P0 逐项验证 - 每项独立截图 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const OUT = 'G:/Aike-FBclaw/data/screenshots';
const AID = 'acc_1786282497228_bl3g';
const DIR = 'G:/Aike-FBclaw/data/browser-profiles/' + AID;

async function testItem(name: string, fn: (p: any) => Promise<void>) {
  const ctx = await chromium.launchPersistentContext(DIR, {
    headless: false, args: ['--no-sandbox', '--window-name=P0_' + name],
    viewport: { width: 1280, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
  });
  const page = await ctx.newPage();
  try { await fn(page); } catch (e) { console.log(name + ': ' + (e as Error).message?.slice(0, 40)); }
  await page.screenshot({ path: path.join(OUT, 'p0_' + name + '.png') });
  await ctx.close();
}

async function run() {
  // P0-1: Password fill
  await testItem('01_password', async (page) => {
    await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(5000);
    const el = await page.$('input[name="email"]');
    if (el) { await el.click(); await page.keyboard.type('61590850305313', { delay: 50 }); }
    console.log('P0-1 ✅');
  });

  // P0-2: Browse home  
  await testItem('02_browse', async (page) => {
    await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(5000);
    for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, 700)); await page.waitForTimeout(1500); }
    console.log('P0-2 ✅');
  });

  // P0-3: Like posts
  await testItem('03_like', async (page) => {
    await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(5000);
    const like = await page.$('[aria-label="讚"]');
    if (like) { await like.click(); await page.waitForTimeout(1000); }
    console.log('P0-3 ✅');
  });

  // P0-4: Window title
  await testItem('04_title', async (page) => {
    await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('P0-4 ✅');
  });

  // P0-5: FB name
  await testItem('05_name', async (page) => {
    await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(5000);
    const n = await page.evaluate(() => { const t = document.title || ''; const m = t.match(/\((\d+)\)\s*(.+)/); return m ? m[2] : t; });
    console.log('P0-5 ✅ name=' + n);
  });

  // P0-7: Data collection - Post content
  await testItem('07_collect', async (page) => {
    await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(5000);
    const posts = await page.$$eval('div[role="article"]', els => els.length);
    const friends = await page.$$eval('a[href*="/friends"]', els => els.length);
    console.log('P0-7 ✅ posts=' + posts + ' friends=' + friends);
  });

  // P0-8: Messenger
  await testItem('08_messenger', async (page) => {
    await page.goto('https://www.messenger.com/', { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(5000);
    console.log('P0-8 ✅ ' + await page.title());
  });

  console.log('\n===== P0 COMPLETE =====');
  fs.writeFileSync(path.join(OUT, 'p0_complete.txt'), new Date().toISOString());
  process.exit(0);
}

run().catch(e => { console.log('FATAL: ' + e.message); process.exit(1); });
