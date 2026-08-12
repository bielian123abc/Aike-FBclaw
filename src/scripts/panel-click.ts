/** 面板按钮点击 → 真实触发任务 → 拿回执 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';

async function test() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-TW' });
  const page = await ctx.newPage();

  console.log('打开面板 http://localhost:18990');
  await page.goto('http://localhost:18990/', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(2000);

  // 切换到账号管理
  await page.click('button:has-text("账号管理")');
  await page.waitForTimeout(1000);

  // 检查有多少行，找到包含好号的行
  const rows = await page.$$('#tableBody tr');
  console.log(`账号数: ${rows.length}`);
  
  // 找第一个非旧测试号的行
  let targetRow = rows[0];
  for (const r of rows) {
    const txt = await r.textContent();
    if (txt && (txt.includes('fb_') || txt.includes('jaken') || txt.includes('ninja') || txt.includes('172255') || txt.includes('147286'))) {
      targetRow = r;
      console.log('目标行:', txt.slice(0, 50));
      break;
    }
  }

  if (rows.length === 0) { console.log('无账号'); await browser.close(); return; }

  // 测试每个操作按钮
  const ops = [
    { name: '浏览', text: '👀', type: 'browse_home' },
    { name: '点赞', text: '👍', type: 'like_posts' },
    { name: '加好友', text: '👥', type: 'add_friends' },
    { name: '分享', text: '📤', type: 'share_post' },
    { name: '社团', text: '🏠', type: 'join_groups' },
    { name: '邀请', text: '📨', type: 'invite_to_group' },
    { name: '发帖', text: '✏️', type: 'post_content' },
  ];

  for (const op of ops) {
    // 用 JS 直接点按钮（避免 Playwright 的 visible check 问题）
    const clicked = await page.evaluate((text) => {
      const btns = document.querySelectorAll('button.mini-btn');
      for (const b of btns) {
        if (b.textContent?.trim() === text) { (b as HTMLElement).click(); return true; }
      }
      return false;
    }, op.text);

    if (clicked) {
      console.log(`  ✅ 点击 ${op.name}(${op.text})`);
    } else {
      console.log(`  ❌ 未找到 ${op.name}(${op.text}) 按钮`);
    }
    await page.waitForTimeout(1500);
  }

  console.log('\n等待任务执行...');
  await page.waitForTimeout(15000);

  // 切到任务页看结果
  await page.click('button:has-text("任务")');
  await page.waitForTimeout(1500);
  const taskText = await page.textContent('#taskBody');
  console.log('任务面板:', taskText?.slice(0, 200));

  // API 验证
  const tasks = await (await fetch('http://localhost:18990/api/tasks')).json();
  const recent = tasks.slice(-7).filter((t: any) => t.status === 'done' || t.status === 'running');
  const doneCount = tasks.slice(-7).filter((t: any) => t.status === 'done').length;
  console.log(`\nAPI回执: ${doneCount}/7 完成`);
  for (const t of recent) {
    console.log(`  ${t.type} → ${t.status} | ${t.result || ''}`);
  }

  await page.screenshot({ path: 'G:/Aike-FBclaw/data/panel-click-test.png' });
  console.log('\n截图 panel-click-test.png');
  await new Promise(r => setTimeout(r, 10000));
  await browser.close();
}
test();
