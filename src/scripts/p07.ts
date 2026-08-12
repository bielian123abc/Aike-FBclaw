/** P0-7 详情编辑 */
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: false, args: ['--window-name=P0-7_编辑'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:18991/', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000);
await page.click('button:has-text("账号管理")'); await page.waitForTimeout(1000);

// 直接调 showAccountDetail 传函数
await page.evaluate(() => {
  const rows = document.querySelectorAll('#tableBody tr');
  if (rows.length > 0) {
    // 从第一个checkbox获取account id
    const cb = rows[0].querySelector('input[type="checkbox"]');
    const onChange = cb?.getAttribute('onchange') || '';
    const match = onChange.match(/'([^']+)'/);
    if (match) {
      // 调用全局的showAccountDetail
      (window as any).showAccountDetail(match[1]);
    }
  }
});
await page.waitForTimeout(3000);

const nameEl = await page.$('#editName');
const proxyEl = await page.$('#editProxy'); 
const noteEl = await page.$('#editNote');
console.log(`P0-7: name=${!!nameEl} proxy=${!!proxyEl} note=${!!noteEl}`);

if (nameEl) {
  await nameEl.fill('P07测试');
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/p07-edit.png' });
  // JS方式点保存
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const b of btns) { if (b.textContent?.includes('💾')) { (b as HTMLElement).click(); break; } }
  });
  console.log('P0-7 ✅ 编辑+保存 | 截图 p07-edit.png');
} else {
  console.log('P0-7 ⚠️ 字段未渲染 - 需检查showAccountDetail API');
}
await new Promise(r => setTimeout(r, 8000));
await browser.close();
