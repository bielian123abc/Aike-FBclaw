/** 自动登录保存Cookie */
import { chromium } from 'playwright-core';
import * as fs from 'fs';

const ctx = await chromium.launchPersistentContext(
  'G:/Aike-FBclaw/data/browser-profiles/acc_1786282497228_bl3g', {
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled',
    '--window-name=朱潇_登录保存Cookie'],
  viewport: { width: 1280, height: 900 }, locale: 'zh-TW',
});
const page = await ctx.newPage();

await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4000);

// 自动登录
const email = await page.$('input[name="email"], input#email');
if (email) {
  console.log('检测到登录表单，自动填入...');
  await email.fill('61590850305313');
  const pass = await page.$('input[name="pass"], input#pass');
  if (pass) {
    await pass.fill('Lb@#9373387392542');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(15000);
  }
}

// 验证
const uid = (await ctx.cookies()).find(c => c.name === 'c_user');
if (uid) {
  console.log('✅ 登录成功! UID:', uid.value);
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/logged_in.png' });

  // 跳 Messenger
  await page.goto('https://www.facebook.com/messages/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/messenger_from_fb.png' });
  console.log('✅ Messenger已打开 | 截图保存');
  
  // 读对话列表
  const chats = await page.evaluate(() => {
    const items: string[] = [];
    document.querySelectorAll('span').forEach(el => {
      const t = el.textContent?.trim();
      if (t && t.length > 2 && t.length < 30 && !items.includes(t))
        items.push(t);
    });
    return items.slice(0, 15);
  });
  console.log('对话:', JSON.stringify(chats));

  const real = chats.filter(c => !c.includes('你') && !c.includes('Marketplace') && !c.includes('更多') && !c.includes('Meta') && !c.includes('©'));
  if (real.length) {
    const pick = real[Math.floor(Math.random() * real.length)];
    console.log('🎯', pick);
    
    await page.evaluate(n => {
      for (const s of document.querySelectorAll('span')) {
        if (s.textContent?.trim() === n) { (s as HTMLElement).click(); return; }
      }
    }, pick);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/chat_selected.png' });

    const input = await page.$('div[contenteditable="true"]');
    if (input) {
      const reply = '嗨～👋';
      await input.click(); await page.waitForTimeout(300);
      await page.keyboard.type(reply, { delay: 50 });
      await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/msg_typed.png' });
      console.log('💬', reply, '| msg_typed.png');
    }
  }
} else {
  console.log('❌ 登录失败');
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/login_failed.png' });
}

await new Promise(r => setTimeout(r, 30000));
await ctx.close();
