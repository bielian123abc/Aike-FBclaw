import { chromium } from 'playwright-core';
import * as fs from 'fs';

const profiles = fs.readdirSync('G:/Aike-FBclaw/data/browser-profiles').filter((d: string) => d.startsWith('acc_'));
let withCookie = 0;

for (const p of profiles.slice(0, 8)) {
  try {
    const ctx = await chromium.launchPersistentContext('G:/Aike-FBclaw/data/browser-profiles/' + p, {
      headless: true, args: ['--no-sandbox'],
    });
    const cookies = await ctx.cookies();
    const has = cookies.some((c: any) => c.name === 'c_user');
    console.log(p.slice(-8), ':', has ? '✅' : '❌', cookies.length + ' cookies');
    if (has) withCookie++;
    await ctx.close();
    await new Promise(r => setTimeout(r, 500));
  } catch (e: any) { console.log(p.slice(-8), ': error', e.message); }
}
console.log('有c_user:', withCookie, '/', Math.min(8, profiles.length));
process.exit(0);
