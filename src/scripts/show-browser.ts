// 在你桌面上打开可见浏览器 — 你能看到整个过程
import { chromium } from 'playwright-core';
import * as fs from 'fs';

const base = 'G:/Aike-FBclaw/data/browser-profiles';
const dirs = fs.readdirSync(base).filter(d => fs.existsSync(base+'/'+d+'/state.json'));
if (dirs.length === 0) { console.log('无可用账号'); process.exit(1); }

const dir = dirs[0];
const state = JSON.parse(fs.readFileSync(base+'/'+dir+'/state.json','utf-8'));

const ctx = await chromium.launchPersistentContext(base+'/'+dir, {
  headless: false,  // 你能看到浏览器窗口
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-name=Aike-FB-测试账号'],
  viewport: { width: 1280, height: 900 },
  locale: 'zh-TW', timezoneId: 'Asia/Taipei',
});

await ctx.addCookies(state.cookies.map((c:any)=>({ name:c.name, value:c.value, domain:c.domain||'.facebook.com', path:c.path||'/' })));

const page = await ctx.newPage();
await page.goto('https://api.ipify.org?format=json', { waitUntil: 'load', timeout: 10000 });
console.log('IP:', JSON.parse(await page.textContent('body')).ip);

await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);

const cs = await ctx.cookies();
const u = cs.find(c=>c.name==='c_user');
console.log('UID:', u?.value||'NONE');
console.log('URL:', page.url().slice(0,80));
console.log('浏览器窗口已打开在你的桌面，请查看');
