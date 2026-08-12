/** P0-7/8/10/11 实机验证 */
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:18991/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.click('button:has-text("账号管理")');
await page.waitForTimeout(1000);

const R: string[] = [];

// P0-7: 详情编辑
const rows = await page.$$('#tableBody tr');
if (rows.length > 0) {
  await rows[0].click(); await page.waitForTimeout(1500);
  const nameEl = await page.$('#editName');
  const proxyEl = await page.$('#editProxy');
  const noteEl = await page.$('#editNote');
  R.push(`P0-7: name=${!!nameEl} proxy=${!!proxyEl} note=${!!noteEl}`);
  if (nameEl) { await nameEl.fill('P0验证名'); await page.waitForTimeout(300); }
  if (proxyEl) { await proxyEl.fill('socks5://test:1080'); }
  if (noteEl) { await noteEl.fill('测试备注'); }
  const saveBtn = await page.$('button:has-text("💾")');
  if (saveBtn) { await saveBtn.click(); R.push('  保存 ✅'); await page.waitForTimeout(500); }
  await page.evaluate(() => { const d = document.getElementById('accountDetail'); if (d) d.style.display = 'none'; });
  await page.waitForTimeout(500);
}

// P0-10: 代理导入
await page.click('button:has-text("配置")'); await page.waitForTimeout(500);
const proxyBtn = await page.$('button:has-text("导入代理"), input#proxyFileInput, .btn:has-text("代理")');
R.push(`P0-10 代理导入按钮: ${!!proxyBtn}`);

// P0-11: 数据采集通过API
const resp = await fetch('http://localhost:18991/api/task/add', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ accountIds: ['acc_1786282497228_bl3g'], type: 'collect_data', params: {} }),
});
const j = await resp.json();
R.push(`P0-11 数据采集API: ${j.ok ? 'queued ✅' : 'FAIL'}`);

// 等采集完成
await new Promise(r => setTimeout(r, 15000));
const tasks = await (await fetch('http://localhost:18991/api/tasks')).json();
const cd = tasks.filter((t: any) => t.type === 'collect_data');
const lastCD = cd[cd.length - 1];
R.push(`  结果: ${lastCD?.status} ${lastCD?.result || ''}`);

await page.screenshot({ path: 'G:/Aike-FBclaw/data/p0-rest-verify.png' });
console.log(R.join('\n'));
console.log('\n截图 p0-rest-verify.png');
await new Promise(r => setTimeout(r, 15000));
await browser.close();
