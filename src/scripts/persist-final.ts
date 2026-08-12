/** 批量Cookie持久化 — 修正版 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const LOG = 'G:/Aike-FBclaw/data/persist-results.txt';
const BASE = 'G:/Aike-FBclaw/data/browser-profiles';
fs.mkdirSync(BASE, { recursive: true });

function log(s: string) { console.log(s); fs.appendFileSync(LOG, s+'\n'); }

async function main() {
  fs.writeFileSync(LOG, '');
  const dir = 'C:/Users/UR/Downloads';
  const files = fs.readdirSync(dir).filter(f => f.startsWith('order-') && f.endsWith('.txt'));
  let ok = 0, cp = 0, fail = 0;
  
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8').replace(/^\uFEFF/, '');
    for (const line of content.split('\n')) {
      if (!line.trim() || line.includes('\t')) continue;
      const parts = line.split('|');
      if (parts.length < 5) continue;
      const uid = parts[0], pass = parts[1], cookieStr = parts[2], email = parts[4];
      if (!email?.includes('@')) continue;
      
      const safeName = email.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      const profDir = path.join(BASE, 'fb_' + safeName);
      fs.mkdirSync(profDir, { recursive: true });
      
      const pairs = cookieStr.split(';').map(s => s.trim());
      const cookies: any[] = [];
      for (const p of pairs) {
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        cookies.push({ name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim(), domain: '.facebook.com', path: '/' });
      }
      if (cookies.length === 0) continue;
      
      try {
        const ctx = await chromium.launchPersistentContext(profDir, {
          headless: true,
          args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        });
        await ctx.addCookies(cookies);
        const page = await ctx.newPage();
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(4000);
        
        const cs = await ctx.cookies();
        const cUser = cs.find(c => c.name === 'c_user');
        const url = page.url();
        
        if (cUser) {
          await ctx.storageState({ path: path.join(profDir, 'state.json') });
          if (url.includes('checkpoint')) {
            log(`⚠️ ${email} | UID:${cUser.value} | checkpoint (已保存)`);
            cp++;
          } else {
            log(`✅ ${email} | UID:${cUser.value} | 正常登录`);
            ok++;
          }
        } else {
          log(`❌ ${email} | 无cookie`);
          fail++;
        }
        await ctx.close();
      } catch (e: any) {
        log(`💥 ${email} | ${e.message}`);
        fail++;
      }
      await new Promise(r => setTimeout(r, 800));
    }
  }
  
  log(`\n✅正常:${ok} ⚠️checkpoint:${cp} ❌失败:${fail}`);
  process.exit(0);
}
main();
