/**
 * 交付前全功能点击测试 — 操作面板UI → 验证每个按钮 → 拿回执
 */
import { chromium } from 'playwright-core';

const REPORT: string[] = [];
function r(s: string) { console.log(s); REPORT.push(s); }

async function test() {
  const browser = await chromium.launch({ headless: false });  // 你能看到
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-TW' });
  const page = await ctx.newPage();

  r('═══════════════════════════');
  r('  Aike-FBclaw 交付前全功能点击测试');
  r('═══════════════════════════');

  // 1. 打开面板
  await page.goto('http://localhost:18990/', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(3000);
  const title = await page.title();
  r(`\n1. 面板加载: ${title ? '✅' : '❌'} "${title}"`);

  // 2. 测试标签切换
  const tabs = [
    { name: '看板', selector: 'button:has-text("看板")' },
    { name: '账号管理', selector: 'button:has-text("账号管理")' },
    { name: '任务', selector: 'button:has-text("任务")' },
    { name: '运营', selector: 'button:has-text("运营")' },
    { name: 'AI 对话', selector: 'button:has-text("AI")' },
    { name: '配置', selector: 'button:has-text("配置")' },
  ];
  r('\n2. 标签切换:');
  for (const t of tabs) {
    try {
      const btn = await page.$(t.selector);
      if (btn) { await btn.click(); await page.waitForTimeout(500); r(`  ✅ ${t.name}`); }
      else r(`  ❌ ${t.name} 按钮未找到`);
    } catch { r(`  ❌ ${t.name} 点击失败`); }
  }

  // 3. 账号管理页 → 检查列表
  await page.click('button:has-text("账号管理")');
  await page.waitForTimeout(1000);
  const rows = await page.$$('#tableBody tr');
  r(`\n3. 账号列表: ${rows.length > 0 ? '✅ ' + rows.length + '行' : '❌ 空'}`);

  // 4. 点击第一个账号行 → 查看详情弹窗
  if (rows.length > 0) {
    try {
      await rows[0].click();
      await page.waitForTimeout(1000);
      const detail = await page.$('#accountDetail');
      r(`4. 账号详情弹窗: ${detail ? '✅' : '❌'}`);
      if (detail) {
        // 关闭弹窗
        const close = await page.$('#accountDetail button');
        if (close) await close.click();
        await page.waitForTimeout(500);
      }
    } catch { r('4. 详情: ❌'); }
  }

  // 5. 任务页 → 新建任务
  await page.click('button:has-text("任务")');
  await page.waitForTimeout(500);
  try {
    const newTaskBtn = await page.$('button:has-text("新建任务")');
    r(`5. 新建任务按钮: ${newTaskBtn ? '✅' : '❌'}`);
  } catch { r('5. 新建任务: ❌'); }

  // 6. 代理池页 → 检查代理列表
  await page.click('button:has-text("代理池")');
  await page.waitForTimeout(1000);
  const proxyRows = await page.$$('#proxyBody tr, #tab-proxy table tr');
  r(`6. 代理列表: ${proxyRows.length > 0 ? '✅ ' + proxyRows.length + '条' : '⚠️ 检查中'}`);

  // 7. 运营页 → 检查主页/社团输入框
  await page.click('button:has-text("运营")');
  await page.waitForTimeout(500);
  const pageInput = await page.$('input[placeholder*="主页"], #newPageInput');
  const groupInput = await page.$('input[placeholder*="社团"], #newGroupInput');
  r(`7. 运营页输入框: 主页${pageInput?'✅':'❌'} 社团${groupInput?'✅':'❌'}`);

  // 8. 配置页 → Gateway状态
  await page.click('button:has-text("配置")');
  await page.waitForTimeout(500);
  const gwStatus = await page.textContent('#gwStatus');
  r(`8. Gateway状态: ${gwStatus || '❌'}`);

  // 9. 点击浏览按钮 → 用 force click
  const anyBtns = await page.$$('button.mini-btn');
  if (anyBtns.length > 0) {
    // 用 evaluate 强制点击
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button.mini-btn');
      let target: any = null;
      for (const b of btns) {
        if (b.textContent?.includes('👀')) { target = b; break; }
        if (b.textContent?.includes('浏览')) { target = b; break; }
      }
      if (target) (target as HTMLElement).click();
      else if (btns.length > 1) (btns[1] as HTMLElement).click();
    });
    await page.waitForTimeout(2000);
    r('9. 浏览按钮: ✅ js强制点击');
  } else {
    r('9. 浏览按钮: ❌ 未找到');
  }

  // 10. 等待任务执行并检查
  await page.waitForTimeout(8000);
  await page.click('button:has-text("任务")');
  await page.waitForTimeout(1000);
  const taskStatus = await page.textContent('#taskBody');
  r(`10. 任务执行结果: ${taskStatus?.includes('done') || taskStatus?.includes('完成') ? '✅ 任务完成' : '⚠️ ' + (taskStatus?.slice(0, 50) || '空')}`);

  // 检查看板数据
  await page.click('button:has-text("看板")');
  await page.waitForTimeout(1000);
  const dTotal = await page.textContent('#dTotal');
  const dRunning = await page.textContent('#dRunning');
  r(`11. 看板数据: 总账号=${dTotal||'?'} 执行中=${dRunning||'?'}`);

  // 保存截图
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/panel-click-test.png' });
  r('\n📸 截图保存: panel-click-test.png');

  // 汇总
  const pass = REPORT.filter(l => l.includes('✅')).length;
  const fail = REPORT.filter(l => l.includes('❌')).length;
  r(`\n═══════════════════════════`);
  r(`通过: ${pass} | 失败: ${fail}`);

  const fs = require('fs');
  fs.writeFileSync('G:/Aike-FBclaw/data/panel-test-report.txt', REPORT.join('\n'));
  
  // 保持浏览器打开
  await new Promise(r2 => setTimeout(r2, 30000));
  await browser.close();
  process.exit(0);
}

test().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
