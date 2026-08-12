import { chromium } from 'playwright-core';

const ctx = await chromium.launchPersistentContext(
  'G:/Aike-FBclaw/data/browser-profiles/acc_1786282497228_bl3g', {
  headless: false, args: ['--no-sandbox', '--start-maximized', '--window-name=朱潇'],
  locale: 'zh-TW', noViewport: true,
});
const page = ctx.pages()[0];

// 1. 打开FB（已有Cookie自动登）
await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);

const uid = (await ctx.cookies()).find(c => c.name === 'c_user');
console.log(uid ? '已登 UID=' + uid.value : '未登');
if (!uid) { await ctx.close(); process.exit(1); }

// 2. 点Messenger图标
await page.evaluate(() => {
  for (const b of document.querySelectorAll('div[role="button"], a[aria-label]')) {
    if ((b.getAttribute('aria-label') || '').includes('Messenger')) { (b as HTMLElement).click(); return; }
  }
});
await page.waitForTimeout(3000);

// 处理PIN - 等验证完成
const pinEl = await page.$('input[type="password"], input[aria-label*="PIN"], input[placeholder*="PIN"]');
if (pinEl) {
  console.log('PIN detected');
  await pinEl.fill('000000');
  await page.keyboard.press('Enter');
  // 等PIN验证完成——检测PIN输入框消失
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const stillPin = await page.$('input[type="password"]');
    if (!stillPin) { console.log('PIN验证完成'); break; }
    if (i === 19) console.log('PIN超时');
  }
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/msg_pin.png' });
}

// 3. 读最近聊过天的人
const chats = await page.evaluate(() => {
  const out: string[] = [];
  // Messenger下拉面板里的对话
  document.querySelectorAll('span').forEach(el => {
    const t = el.textContent?.trim();
    if (t && t.length > 1 && t.length < 20 && !out.includes(t)) out.push(t);
  });
  return out;
});
console.log('最近聊天:', JSON.stringify(chats));

const skip = ['查找', '未读', '聊天', '全部', '群聊', '社群', 'PIN', '验证', '一次性', '还原', '加密', '小时', '天', '分钟', '周', 
  '消息', '通话', '安全', '查看', '好友', '面板', 'Reels', '广告', '回忆', '收藏', '小组', '展开', '快速', '更多', '分享', '创建', 
  'Marketplace', 'Meta', 'Messenger', 'Chats', '搜寻', '功能', '你', '朱潇'];
const real = chats.filter(f => !skip.some(s => f.includes(s)) && f.length > 1 && !/^\d+/.test(f) && !/^\s/.test(f));
console.log('真人:', JSON.stringify(real));
if (!real.length) { console.log('无最近聊天'); await ctx.close(); process.exit(0); }

const pick = real[0]; // 第一个，以后再随机
console.log('🎯', pick);

// 4. 点好友
await page.evaluate(n => {
  for (const el of document.querySelectorAll('span')) {
    if (el.textContent?.trim() === n) { (el as HTMLElement).click(); return; }
  }
}, pick);
await page.waitForTimeout(4000);
await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/chat_open.png' });

// 5. 输入
const input = await page.$('div[contenteditable="true"]');
if (input) {
  await input.click(); await page.waitForTimeout(300);
  await page.keyboard.type('嗨～👋', { delay: 60 });
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/chat_typed.png' });
  console.log('💬 嗨～👋 | chat_typed.png');
}

await new Promise(r => setTimeout(r, 30000));
await ctx.close();
