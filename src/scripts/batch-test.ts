import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:18990/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// 切换到账号管理
await page.click('button:has-text("账号管理")');
await page.waitForTimeout(1000);

// 点击全选
await page.click('#selectAll');
await page.waitForTimeout(500);

// 看看已选数量
const selCount = await page.textContent('#selCount');
console.log(`已选账号: ${selCount}`);

// 点击批量浏览
const browseBtn = await page.$('#btnBrowseSel');
const disabled = await browseBtn?.getAttribute('disabled');
console.log(`浏览按钮: ${disabled === null ? '已启用' : '禁用中'}`);

if (disabled === null) {
  await browseBtn!.click();
  console.log('点击批量浏览 ✅');
  await page.waitForTimeout(2000);
  
  // 切到任务页看结果
  await page.click('button:has-text("任务")');
  await page.waitForTimeout(1000);
  const taskText = await page.textContent('#taskBody');
  console.log('任务状态:', taskText?.slice(0, 150));
}

await page.screenshot({ path: 'G:/Aike-FBclaw/data/batch-test.png' });

// API确认
const tasks = await (await fetch('http://localhost:18990/api/tasks')).json();
console.log(`API: ${tasks.length} 个任务`);

console.log('浏览器保持打开');
await new Promise(r => setTimeout(r, 15000));
await browser.close();
