/** Messenger 随机好友聊天 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--window-name=朱潇_Messenger聊天'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW' });

// 打开 Messenger
await page.goto('https://www.messenger.com/', { waitUntil: 'load', timeout: 20000 });
await page.waitForTimeout(5000);

// 检查是否需要 PIN
const pinInput = await page.$('input[type="password"]');
if (pinInput) { 
  console.log('检测到PIN输入框');
  await pinInput.fill('000000');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
}

// 获取聊天列表
const conversations = await page.$$('div[role="grid"] div[data-virtualized], div[role="listitem"]');
console.log('对话列表条目:', conversations.length);

// 直接读取页面DOM找对话
const chatList = await page.evaluate(() => {
  const items: { name: string; preview: string; el: string }[] = [];
  const allDivs = document.querySelectorAll('div[role="grid"] > div > div, div[role="listitem"]');
  allDivs.forEach(div => {
    const nameEl = div.querySelector('span') as HTMLElement;
    if (nameEl && nameEl.textContent && nameEl.textContent.length > 1 && !nameEl.textContent.includes('聊天室')) {
      items.push({ name: nameEl.textContent.trim(), preview: '', el: 'div' });
    }
  });
  return items.slice(0, 20);
});
console.log('识别到的对话:', JSON.stringify(chatList.slice(0, 5)));

// 取一个非空的对话，点击打开
if (chatList.length > 0) {
  // 过滤掉"你"、群组等
  const candidates = chatList.filter(c => !c.name.includes('你') && !c.name.includes('群') && c.name.length > 1);
  const target = candidates[Math.floor(Math.random() * candidates.length)] || chatList[0];
  console.log('🎯 选中好友:', target.name);
  
  // 用文本匹配点击
  const clicked = await page.evaluate((name) => {
    const spans = document.querySelectorAll('span');
    for (const s of spans) {
      if (s.textContent?.trim() === name) {
        const clickable = s.closest('div[role="button"], div[role="listitem"], a');
        if (clickable) { (clickable as HTMLElement).click(); return true; }
        (s as HTMLElement).click(); return true;
      }
    }
    return false;
  }, target.name);
  
  if (clicked) {
    await page.waitForTimeout(3000);
    
    // 读取对话历史
    const history = await page.evaluate(() => {
      const msgs: string[] = [];
      const containers = document.querySelectorAll('[role="log"]');
      if (containers.length > 0) {
        const bubbles = containers[0].querySelectorAll('div[dir="auto"]');
        bubbles.forEach(b => {
          const txt = b.textContent?.trim();
          if (txt && txt.length > 0) msgs.push(txt);
        });
      }
      return msgs;
    });
    
    console.log('对话历史:', history.slice(-10).join(' | '));
    
    // 判断关系阶段
    const totalMsgs = history.length;
    let stage = 'new';
    if (totalMsgs > 30) stage = 'friendly';
    else if (totalMsgs > 10) stage = 'acquaintance';
    console.log('关系阶段:', stage, '| 总消息数:', totalMsgs);
    
    // 生成回复
    const replies: Record<string, string[]> = {
      new: ['嗨～', '哈囉', '你好啊 👋'],
      acquaintance: ['嗯嗯', '最近好嗎？', '哈哈對啊', '最近在忙什麼？'],
      friendly: ['XD 真的', '最近過得怎麼樣～', '我也覺得！'],
    };
    const reply = replies[stage]?.[Math.floor(Math.random() * replies[stage].length)] || '嗨';
    console.log('💬 生成回复:', reply);
    
    // 找到输入框
    const inputBox = await page.$('div[contenteditable="true"], div[aria-label*="訊息"]');
    if (inputBox) {
      await inputBox.click();
      await page.waitForTimeout(500);
      await page.keyboard.type(reply, { delay: 80 });
      await page.waitForTimeout(1000);
      
      await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/messenger_chat.png' });
      console.log('✅ 消息已输入 | 截图 messenger_chat.png');
      console.log('⚠️ 未发送（待确认）');
    } else {
      console.log('❌ 未找到输入框');
      await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/messenger_chat.png' });
    }
  } else {
    console.log('❌ 点击对话失败');
    await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/messenger_chat.png' });
  }
} else {
  console.log('❌ 无可用对话');
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/messenger_chat.png' });
}

await new Promise(r => setTimeout(r, 30000));
await browser.close();
