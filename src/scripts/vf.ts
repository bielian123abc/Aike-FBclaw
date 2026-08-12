import { chromium } from 'playwright-core';
import * as fs from 'fs';

const base = 'G:/Aike-FBclaw/data/browser-profiles/';
const dirs = fs.readdirSync(base).filter(d => d.startsWith('fb_')).slice(0, 5);

async function main() {
  for (const d of dirs) {
    try {
      const ctx = await chromium.launchPersistentContext(base + d, {
        headless: false,
        args: ['--no-sandbox', '--window-size=400,300', '--window-position=0,0'],
      });
      const cookies = await ctx.cookies();
      const has = cookies.some((c: any) => c.name === 'c_user');
      console.log(d.slice(-8) + ':', has ? '✅' : '❌', cookies.length + ' cookies');
      await ctx.close();
      await new Promise(r => setTimeout(r, 500));
    } catch (e: any) { console.log(d.slice(-8) + ': ERROR'); }
  }
}
main();
