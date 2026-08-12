import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

async function test() {
  try {
    const dir = 'G:/Aike-FBclaw/data/browser-profiles/fb_ninja.drache6956_do0.imgui.de';
    const statePath = path.join(dir, 'state.json');
    
    fs.writeFileSync('G:/Aike-FBclaw/data/verify-result.txt', 'starting...\n');
    fs.appendFileSync('G:/Aike-FBclaw/data/verify-result.txt', 'state.json exists: ' + fs.existsSync(statePath) + '\n');
    
    const ctx = await chromium.launchPersistentContext(dir, {
      headless: true,
      args: ['--no-sandbox', '--proxy-server=http://127.0.0.1:11086', '--disable-blink-features=AutomationControlled'],
      viewport: { width: 1280, height: 900 },
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
    });
    
    // 从 state.json 加载 Cookie
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (state.cookies && state.cookies.length > 0) {
        await ctx.addCookies(state.cookies.map((c: any) => ({ ...c, url: 'https://www.facebook.com/' })));
        fs.appendFileSync('G:/Aike-FBclaw/data/verify-result.txt', 'Loaded ' + state.cookies.length + ' cookies from state.json\n');
      }
    }
    
    fs.appendFileSync('G:/Aike-FBclaw/data/verify-result.txt', 'browser launched\n');
    
    const page = await ctx.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    
    const url = page.url();
    const title = await page.title();
    const cookies = await ctx.cookies();
    const cUser = cookies.find(c => c.name === 'c_user');
    
    fs.appendFileSync('G:/Aike-FBclaw/data/verify-result.txt', 'URL: ' + url + '\n');
    fs.appendFileSync('G:/Aike-FBclaw/data/verify-result.txt', 'Title: ' + title + '\n');
    fs.appendFileSync('G:/Aike-FBclaw/data/verify-result.txt', 'UID: ' + (cUser?.value || 'NONE') + '\n');
    fs.appendFileSync('G:/Aike-FBclaw/data/verify-result.txt', 'Cookies: ' + cookies.length + '\n');
    
    await page.screenshot({ path: 'G:/Aike-FBclaw/data/verify-login.png' });
    fs.appendFileSync('G:/Aike-FBclaw/data/verify-result.txt', 'screenshot saved\n');
    
    await ctx.close();
    fs.appendFileSync('G:/Aike-FBclaw/data/verify-result.txt', 'DONE\n');
  } catch (e: any) {
    fs.appendFileSync('G:/Aike-FBclaw/data/verify-result.txt', 'ERROR: ' + e.message + '\n');
  }
  process.exit(0);
}
test();
