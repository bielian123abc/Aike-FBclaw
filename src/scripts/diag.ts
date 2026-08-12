import { chromium } from 'playwright-core';
import * as fs from 'fs';

const d = 'G:/Aike-FBclaw/data/browser-profiles/fb_1472867526';

const ctx = await chromium.launchPersistentContext(d, {
  headless: false,
  args: ['--no-sandbox', '--window-size=400,300', '--window-position=0,0'],
});

const cks = await ctx.cookies();
console.log(cks.length + ' cookies:');
cks.forEach((c: any) => {
  console.log(`  ${c.name}=${c.value.slice(0,30)} [${c.domain}]`);
});

// 尝试打开FB看看
const page = await ctx.newPage();
await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(3000);

const cks2 = await ctx.cookies();
console.log('\nFB打开后:', cks2.length + ' cookies');
cks2.forEach((c: any) => {
  console.log(`  ${c.name}=${c.value.slice(0,30)}`);
});

const url = page.url();
console.log('URL:', url.slice(0, 60));
const loginForm = await page.$('input[name="email"]');
console.log('Login form:', loginForm ? 'YES (not logged in)' : 'NO (logged in)');

await ctx.close();
