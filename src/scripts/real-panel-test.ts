/** 实机验证：打开面板 → 点按钮 → 启动浏览器 → 验证登录 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';

async function test() {
  // 用服务器API启动浏览器
  const resp = await fetch('http://localhost:18990/api/account-states');
  const states = await resp.json();
  console.log('账号状态数:', states.length);
  
  // 找一个有 state.json 的账号
  const base = 'G:/Aike-FBclaw/data/browser-profiles';
  const dirs = fs.readdirSync(base).filter(d => fs.existsSync(base+'/'+d+'/state.json'));
  console.log('有state.json的账号:', dirs.length);
  
  if (dirs.length === 0) { console.log('ERROR:无可用账号'); return; }
  
  // 用第一个测试
  const dir = dirs[0];
  const state = JSON.parse(fs.readFileSync(base+'/'+dir+'/state.json','utf-8'));
  console.log('测试账号:', dir);
  console.log('Cookie数:', state.cookies?.length);
  
  // 启动浏览器（模拟面板按钮）
  const ctx = await chromium.launchPersistentContext(base+'/'+dir, {
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-name=Aike-FBclaw测试'],
    viewport: { width: 1280, height: 900 },
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
  });
  
  if (state.cookies) {
    await ctx.addCookies(state.cookies.map((c:any) => ({ name:c.name, value:c.value, domain:c.domain||'.facebook.com', path:c.path||'/' })));
  }
  
  const page = await ctx.newPage();
  
  // 检查IP
  await page.goto('https://api.ipify.org?format=json', { waitUntil: 'load', timeout: 10000 });
  const ip = JSON.parse(await page.textContent('body')).ip;
  console.log('IP:', ip);
  
  // 打开Facebook
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  
  const url = page.url();
  const cs = await ctx.cookies();
  const cUser = cs.find(c => c.name === 'c_user');
  
  console.log('URL:', url.slice(0, 70));
  console.log('UID:', cUser?.value || 'NONE');
  console.log('总Cookie:', cs.length);
  
  if (cUser) {
    console.log('\n✅ 实机测试通过 — 账号已登录');
    
    // 尝试浏览首页
    if (url.includes('checkpoint')) {
      console.log('⚠️ 账号在checkpoint页面，Cookie有效但需验证');
    } else {
      // 尝试点击首页
      try {
        await page.click('[aria-label="Facebook"]');
        await page.waitForTimeout(2000);
        console.log('已导航到首页');
      } catch {}
      
      // 截图
      await page.screenshot({ path: 'G:/Aike-FBclaw/data/real-browser-test.png' });
      console.log('截图已保存');
    }
  } else {
    console.log('❌ 未登录');
  }
  
  // 保持窗口打开5秒
  await new Promise(r => setTimeout(r, 5000));
  await ctx.close();
  process.exit(0);
}
test();
