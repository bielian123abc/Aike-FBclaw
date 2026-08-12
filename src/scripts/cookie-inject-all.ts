/** 批量注入Cookie → 检查登录 → 保存storageState */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const LOG = 'G:/Aike-FBclaw/data/cookie-inject-results.txt';
let results: string[] = [];

function log(msg: string) { console.log(msg); results.push(msg); }

async function main() {
  fs.writeFileSync(LOG, '');
  
  // 找所有 order 文件
  const dir = 'C:/Users/UR/Downloads';
  const files = fs.readdirSync(dir).filter(f => f.startsWith('order-') && f.endsWith('.txt'));
  log(`order文件: ${files.length}个\n`);
  
  let success = 0, checkpoint = 0, fail = 0;
  
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8').replace(/^\uFEFF/, '');
    const lines = content.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      if (line.includes('\t')) continue; // 跳过 tab 格式的
      
      const parts = line.split('|');
      if (parts.length < 5) continue;
      
      const uid = parts[0];
      const pass = parts[1];
      const cookieStr = parts[2];
      const email = parts[4];
      
      if (!email || !email.includes('@')) continue;
      
      // 解析 Cookie
      const pairs = cookieStr.split(';').map(s => s.trim());
      const cookies: any[] = [];
      for (const p of pairs) {
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        cookies.push({ name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim(), url: 'https://www.facebook.com/' });
      }
      
      if (cookies.length === 0) continue;
      
      const safeName = email.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      const profileDir = path.join('G:/Aike-FBclaw/data/browser-profiles', 'fb_' + safeName);
      fs.mkdirSync(profileDir, { recursive: true });
      
      try {
        const ctx = await chromium.launchPersistentContext(profileDir, {
          headless: true,
          args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
          viewport: { width: 1280, height: 900 },
        });
        await ctx.addCookies(cookies);
        
        const page = await ctx.newPage();
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        
        const fbCookies = await ctx.cookies();
        const cUser = fbCookies.find(c => c.name === 'c_user');
        const url = page.url();
        
        if (cUser && !url.includes('checkpoint')) {
          log(`✅ ${email} | UID:${cUser.value} | 正常登录`);
          await ctx.storageState({ path: path.join(profileDir, 'state.json') });
          success++;
        } else if (cUser && url.includes('checkpoint')) {
          log(`⚠️ ${email} | UID:${cUser.value} | checkpoint页面`);
          await ctx.storageState({ path: path.join(profileDir, 'state.json') });
          checkpoint++;
        } else {
          log(`❌ ${email} | 未登录`);
          fail++;
        }
        
        await ctx.close();
      } catch (e: any) {
        log(`❌ ${email} | ${e.message}`);
        fail++;
      }
      
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  log(`\n═══════════════════`);
  log(`正常登录: ${success} | Checkpoint: ${checkpoint} | 失败: ${fail}`);
  fs.writeFileSync(LOG, results.join('\n'), 'utf-8');
}

main().catch(e => { log('FATAL: '+e.message); fs.writeFileSync(LOG, results.join('\n'), 'utf-8'); });
