import { chromium } from 'playwright-core';
import * as fs from 'fs';
const dir = 'G:/Aike-FBclaw/data/browser-profiles/fb_cyber_rebel7277_fake_legal';
const state = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf-8'));
console.log('state cookies:', state.cookies?.length || 0);
if (state.cookies) console.log('First cookie:', JSON.stringify(state.cookies[0]));

// Fix: add url to each cookie
const fixedCookies = (state.cookies || []).map((c: any) => ({
  name: c.name,
  value: c.value,
  domain: c.domain || '.facebook.com',
  path: c.path || '/',
}));
console.log('Fixed cookies:', fixedCookies.length, 'first:', JSON.stringify(fixedCookies[0]));

const ctx = await chromium.launchPersistentContext(dir, { headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
await ctx.addCookies(fixedCookies);
console.log('Cookies injected');
const page = await ctx.newPage();
await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(3000);
const cs = await ctx.cookies();
const u = cs.find(c => c.name === 'c_user');
console.log('URL:', page.url().slice(0, 60));
console.log('UID:', u?.value || 'NONE');
console.log('Total:', cs.length);
await ctx.close();
process.exit(0);
