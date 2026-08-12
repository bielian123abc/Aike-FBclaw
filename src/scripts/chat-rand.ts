import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  headless: false,
  args: ['--no-sandbox', '--start-maximized', '--window-name=朱潇'],
});
const page = await browser.newPage();

await page.goto('https://www.facebook.com/messages/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(8000);

// 检测登录状态
const ctx = browser.contexts()[0];
const uidCookie = (await ctx.cookies()).find(c => c.name === 'c_user');
console.log(uidCookie ? '已登录 UID=' + uidCookie.value : '未登录');

if (!uidCookie) {
  console.log('在浏览器中手动登录，限时 90 秒...');
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);
    const u = (await ctx.cookies()).find(c => c.name === 'c_user');
    if (u) { console.log('登录成功! UID=' + u.value); break; }
  }
  const u2 = (await ctx.cookies()).find(c => c.name === 'c_user');
  if (!u2) { console.log('超时未登录'); await browser.close(); process.exit(0); }
}

// 截图
await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/msg_step1.png' });

// 读对话
const chats = await page.evaluate(() => {
  const out: string[] = [];
  const links = document.querySelectorAll('a[href*="/messages/"]');
  links.forEach(a => {
    const t = a.textContent?.trim();
    if (t && t.length > 2 && t.length < 30 && !out.includes(t)) out.push(t);
  });
  // fallback: 读 listitem
  if (out.length < 3) {
    document.querySelectorAll('div[role="listitem"] span').forEach(el => {
      const t = el.textContent?.trim();
      if (t && t.length > 2 && t.length < 30 && !out.includes(t)) out.push(t);
    });
  }
  return out.slice(0, 12);
});
console.log('对话:', chats.join(' | '));

const skip = ['你', '群', 'Marketplace', 'Meta', '©', '中文', '忘记', '搜寻', 'Messenger', 'Chats', '功能'];
const real = chats.filter(c => !skip.some(s => c.includes(s)) && c.length > 2);
if (!real.length) { console.log('无对话'); await browser.close(); process.exit(0); }

const pick = real[Math.floor(Math.random() * real.length)];
console.log('🎯', pick);

// 点击
const clicked = await page.evaluate(n => {
  for (const a of document.querySelectorAll('a[href*="/messages/"]')) {
    if (a.textContent?.includes(n)) { (a as HTMLElement).click(); return true; }
  }
  for (const el of document.querySelectorAll('span')) {
    if (el.textContent?.trim() === n) {
      (el as HTMLElement).click(); return true;
    }
  }
  return false;
}, pick);
if (!clicked) { console.log('点击失败'); await browser.close(); process.exit(0); }

await page.waitForTimeout(5000);
await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/msg_step2.png' });

// 读消息 + 输入回复
const msgs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('div[dir="auto"]'))
    .slice(-6).map(e => e.textContent?.trim()).filter(Boolean)
);
console.log('消息:', msgs.join(' | '));

const reply = msgs.length > 10 ? ['哈哈對啊','嗯嗯','最近好嗎'][Math.floor(Math.random()*3)] : '嗨～👋';

const input = await page.$('div[contenteditable="true"]');
if (input) {
  await input.click(); await page.waitForTimeout(300);
  await page.keyboard.type(reply, { delay: 60 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/msg_step3.png' });
  console.log('💬', reply, '| msg_step3.png');
} else {
  console.log('没输入框');
}

console.log('选中:', pick, '| 消息数:', msgs.length, '| 回复:', reply);
await new Promise(r => setTimeout(r, 30000));
await browser.close();
