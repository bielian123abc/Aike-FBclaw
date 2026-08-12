import { chromium } from 'playwright-core';
import * as fs from 'fs';
const DIR = 'G:/Aike-FBclaw/data/browser-profiles/fb_1722550179';
const state = JSON.parse(fs.readFileSync(DIR + '/state.json', 'utf-8'));
const R: string[] = [];

async function test() {
  const ctx = await chromium.launchPersistentContext(DIR, {
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-name=完整实测'],
    viewport: { width: 1280, height: 900 },
    locale: 'zh-TW', timezoneId: 'Asia/Taipei',
  });
  await ctx.addCookies(state.cookies.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain || '.facebook.com', path: c.path || '/' })));
  const page = await ctx.newPage();
  
  // 1. 登录
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  let cs = await ctx.cookies();
  const uid = cs.find(c => c.name === 'c_user')?.value;
  R.push(`✅ 登录 UID:${uid}`);

  // 处理任何弹窗
  async function dismissPopups() {
    for (let i = 0; i < 3; i++) {
      // 关闭各类弹窗
      const closeBtns = await page.$$('[aria-label="關閉"], [aria-label="Close"], div[role="dialog"] [aria-label="關閉"], div[role="dialog"] span:has-text("確定")');
      for (const b of closeBtns) {
        try { await b.click(); await page.waitForTimeout(500); R.push('  🔔 关闭弹窗'); } catch {}
      }
      // 按 ESC
      try { await page.keyboard.press('Escape'); await page.waitForTimeout(500); } catch {}
    }
  }
  await dismissPopups();

  // 2. 审查元素 — 收集页面结构
  R.push('\n📋 页面元素审查:');
  const title = await page.title();
  R.push(`  标题: ${title}`);
  const url = page.url();
  R.push(`  URL: ${url.slice(0, 80)}`);
  const allBtns = await page.$$('div[role="button"]');
  R.push(`  按钮总数: ${allBtns.length}`);
  // 收集前10个按钮的aria-label
  for (const b of allBtns.slice(0, 10)) {
    const label = await b.getAttribute('aria-label');
    if (label) R.push(`    [${label.slice(0, 50)}]`);
  }
  const allLinks = await page.$$('a[href*="/"]');
  R.push(`  链接总数: ${allLinks.length}`);
  const allImgs = await page.$$('img');
  R.push(`  图片总数: ${allImgs.length}`);

  // 3. 浏览滚动
  R.push('\n📜 浏览:');
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(2000);
    await dismissPopups();
  }
  R.push('  ✅ 3次滚动完成');

  // 4. 点赞
  try {
    const like = await page.$('[aria-label="讚"]');
    if (like) { await like.click(); R.push('  ✅ 点赞成功'); }
    else R.push('  ⚠️ 无赞按钮');
  } catch { R.push('  ❌ 点赞失败'); }
  await page.waitForTimeout(1000);

  // 5. 发帖 — 完整流程
  R.push('\n✏️ 发帖测试:');
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(4000);
  await dismissPopups();

  // 找发帖框
  let postBox = await page.$('div[role="button"]:has-text("在想")') 
    || await page.$('[aria-label*="建立貼文"]')
    || await page.$('span:has-text("在想些什麼")');
  
  if (postBox) {
    await postBox.click();
    await page.waitForTimeout(3000);
    await dismissPopups();
    R.push('  ✅ 打开发帖框');
    
    // 输入文字
    try {
      const editor = await page.$('div[contenteditable="true"], div[role="textbox"], div[aria-label*="貼文"]');
      if (editor) {
        await editor.click();
        await page.waitForTimeout(500);
        await page.keyboard.type('Aike-FBclaw 自动化测试', { delay: 60 });
        R.push('  ✅ 已输入测试文字');
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'G:/Aike-FBclaw/data/post-test.png' });
        R.push('  📸 截图 post-test.png');
        // 不移除发布，只验证流程
      } else R.push('  ⚠️ 未找到文本编辑区');
    } catch { R.push('  ❌ 输入失败'); }
  } else R.push('  ❌ 未找到发帖框');

  // 6. 好友建议页
  R.push('\n👥 好友页:');
  await page.goto('https://www.facebook.com/friends/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(4000);
  await dismissPopups();
  const friendCards = await page.$$('a[href*="/profile.php?id="]');
  R.push(`  好友/建议链接: ${friendCards.length}个`);

  // 7. 社团页
  R.push('\n🏠 社团页:');
  await page.goto('https://www.facebook.com/groups/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(4000);
  await dismissPopups();
  const groupLinks = await page.$$('a[href*="/groups/"]');
  R.push(`  社团链接: ${groupLinks.length}个`);

  // 最终截图
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/full-test.png' });
  fs.writeFileSync('G:/Aike-FBclaw/data/full-test-report.txt', R.join('\n'));
  console.log(R.join('\n'));
  console.log('\n浏览器保持打开30秒');
  await new Promise(r => setTimeout(r, 30000));
  await ctx.close();
}
test().catch(e => { console.log('ERR:', e.message); fs.writeFileSync('G:/Aike-FBclaw/data/full-test-report.txt', 'ERR: ' + e.message); });
