/** 可见浏览器操作测试 — 你桌面上能看到全过程 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'G:/Aike-FBclaw/data/browser-profiles';

async function testGoodAccount(profileDir: string, tag: string) {
  const state = JSON.parse(fs.readFileSync(path.join(profileDir, 'state.json'), 'utf-8'));
  
  console.log(`启动: ${path.basename(profileDir)}`);
  
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,  // 你能看到窗口
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', `--window-name=${tag}`],
    viewport: { width: 1280, height: 900 },
    locale: 'zh-TW', timezoneId: 'Asia/Taipei',
  });
  
  await ctx.addCookies(state.cookies.map((c: any) => ({
    name: c.name, value: c.value, domain: c.domain || '.facebook.com', path: c.path || '/',
  })));
  
  const page = await ctx.newPage();
  
  // 打开FB
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  
  const url = page.url();
  const cookies = await ctx.cookies();
  const cUser = cookies.find(c => c.name === 'c_user');
  console.log('  UID:', cUser?.value);
  console.log('  URL:', url.slice(0, 70));
  
  if (!cUser) { console.log('  ❌ 未登录'); await ctx.close(); return false; }
  if (url.includes('checkpoint') || url.includes('captcha')) { console.log('  🚫 异常'); await ctx.close(); return false; }
  
  console.log('  ✅ 已登录');
  
  // 操作1: 滚动浏览
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(2000);
  }
  console.log('  ✅ 浏览首页 - 3次滚动');
  
  // 操作2: 找点赞按钮
  const likeSelectors = [
    '[aria-label="赞"]', '[aria-label="讚"]', '[aria-label*="like" i]',
    'div[role="button"][aria-label*="赞"]', 'div[role="button"][aria-label*="讚"]',
    '[data-testid="like"]', 'span:has-text("赞")', 'span:has-text("讚")',
    // 繁体中文常见按钮
    'div[aria-label*="讚"]', 'div[aria-label*="大心"]', 'div[aria-label*="加油"]',
  ];
  
  let liked = false;
  for (const sel of likeSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await page.waitForTimeout(2000);
        liked = true;
        console.log('  ✅ 点赞成功 - 选择器:', sel);
        break;
      }
    } catch {}
  }
  
  if (!liked) {
    // 尝试另一种方式：遍历所有可见按钮找"赞"
    try {
      const allBtns = await page.$$('div[role="button"]');
      for (const btn of allBtns.slice(0, 10)) {
        const label = await btn.getAttribute('aria-label');
        if (label?.includes('赞') || label?.includes('讚') || label?.includes('like')) {
          await btn.click();
          await page.waitForTimeout(1500);
          liked = true;
          console.log('  ✅ 点赞成功 - aria-label:', label.slice(0, 30));
          break;
        }
      }
    } catch {}
  }
  
  if (!liked) console.log('  ⚠️ 未找到点赞按钮（首页可能无动态）');
  
  // 截图保存
  await page.screenshot({ path: `G:/Aike-FBclaw/data/visible-test-${tag}.png` });
  console.log('  截图已保存');
  
  // 保持窗口打开
  console.log('  浏览器窗口保持打开，2分钟后自动关闭...');
  await new Promise(r => setTimeout(r, 120000));
  await ctx.close();
  return true;
}

async function main() {
  // 找4个好账号
  const report = JSON.parse(fs.readFileSync('G:/Aike-FBclaw/data/account-report.json', 'utf-8'));
  const good = report.results.filter((r: any) => r.status === 'ok');
  console.log(`好账号: ${good.length}个\n`);
  
  // 逐个测试（头两个开可见窗口）
  for (let i = 0; i < good.length; i++) {
    const dir = path.join(BASE, good[i].profile);
    if (!fs.existsSync(dir)) continue;
    await testGoodAccount(dir, `测试${i+1}-${good[i].profile.slice(0,20)}`);
    if (i >= 1) break; // 先测2个，避免开太多窗口
  }
  process.exit(0);
}

main();
