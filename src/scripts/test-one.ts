/**
 * 最小验证：注入 order 文件中的 Cookie → 检查是否已登录
 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';

async function test() {
  // 读取第一个账号的数据
  const content = fs.readFileSync('C:/Users/UR/Downloads/order-1Z29CESDSRAD.txt', 'utf-8');
  const line = content.split('\n')[0].replace(/^\uFEFF/, '');
  const parts = line.split('|');
  // UID|PASS|COOKIE|TOKEN|EMAIL|APP|TIME
  const uid = parts[0];
  const pass = parts[1];
  const cookieStr = parts[2];
  const email = parts[4];
  
  console.log('UID:', uid);
  console.log('Email:', email);
  console.log('Pass:', pass.slice(0, 5) + '...');
  console.log('Cookie:', cookieStr.slice(0, 80) + '...');
  
  // 解析 Cookie
  const pairs = cookieStr.split(';').map(s => s.trim());
  const cookies: any[] = [];
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (value && name) {
      cookies.push({ name, value, url: 'https://www.facebook.com/' });
    }
  }
  console.log('Parsed cookies:', cookies.length);
  cookies.forEach(c => console.log('  ', c.name, '=', c.value.slice(0, 20) + '...'));
  
  // 启动浏览器并注入 Cookie
  const ctx = await chromium.launchPersistentContext('G:/Aike-FBclaw/data/test-cookie', {
    headless: true,
    args: ['--no-sandbox', '--proxy-server=http://127.0.0.1:11080', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
  });
  
  await ctx.addCookies(cookies);
  console.log('Cookies injected');
  
  const page = await ctx.newPage();
  
  // 先检查IP
  await page.goto('https://api.ipify.org?format=json', { waitUntil: 'load', timeout: 15000 });
  const ip = JSON.parse(await page.textContent('body')).ip;
  console.log('Proxy IP:', ip);
  
  // 打开 Facebook
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  
  console.log('URL:', page.url().slice(0, 80));
  console.log('Title:', await page.title());
  
  // 检查 Cookie
  const fbCookies = await ctx.cookies();
  const cUser = fbCookies.find(c => c.name === 'c_user');
  console.log('c_user cookie:', cUser?.value || 'NONE');
  
  if (cUser) {
    console.log('✅ 已登录！');
    // 保存 storageState
    await ctx.storageState({ path: 'G:/Aike-FBclaw/data/test-cookie/state.json' });
    console.log('✅ Cookie 已持久化');
  } else {
    // 检查是否需要登录
    const body = await page.textContent('body');
    console.log('页面文本:', body?.slice(0, 200));
    
    // 尝试登录
    console.log('尝试用密码登录...');
    const emailInput = await page.$('input[name="email"], #email');
    const passInput = await page.$('input[name="pass"], #pass');
    if (emailInput && passInput) {
      await emailInput.fill(email);
      await passInput.fill(pass);
      console.log('填入:', email);
      await passInput.press('Enter');
      await page.waitForTimeout(8000);
      
      const c2 = await ctx.cookies();
      const u2 = c2.find(c => c.name === 'c_user');
      console.log('登录后 c_user:', u2?.value || 'NONE');
      
      if (u2) {
        console.log('✅ 密码登录成功！');
        await ctx.storageState({ path: 'G:/Aike-FBclaw/data/test-cookie/state.json' });
      } else {
        const b2 = await page.textContent('body');
        console.log('登录后页面:', b2?.slice(0, 300));
      }
    }
  }
  
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/test-cookie-result.png' });
  await ctx.close();
  console.log('Done');
}

test().catch(e => console.log('ERROR:', e.message));
