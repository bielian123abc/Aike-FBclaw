import { chromium } from 'playwright-core';
const ctx = await chromium.launchPersistentContext(
  'G:/Aike-FBclaw/data/browser-profiles/acc_1786282497228_bl3g', {
  headless: false, args: ['--no-sandbox','--window-name=P1_FINAL'],
  viewport: {width:1280,height:900}, locale:'zh-TW', timezoneId:'Asia/Taipei',
});
const p = await ctx.newPage();
await p.goto('https://www.facebook.com/', {waitUntil:'load',timeout:30000});
await p.waitForTimeout(5000);
await p.screenshot({path:'G:/Aike-FBclaw/data/screenshots/p1_final.png'});
console.log('OK');
await new Promise(r=>setTimeout(r,10000));
await ctx.close();
