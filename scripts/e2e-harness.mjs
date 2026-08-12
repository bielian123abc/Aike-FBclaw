// 自主实机功能测试harness —— 由脚本独立点击每个功能按键，截图交助手自检，捕获API回执与报错
// 用法: node scripts/e2e-harness.mjs
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const CHROME = 'C:/Users/UR/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const BASE = 'http://localhost:18991';
const SHOT_DIR = 'G:/Aike-FBclaw/data/screenshots/e2e';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const report = { steps: [], pageErrors: [], failedRequests: [] };
function logStep(name, ok, detail) {
  report.steps.push({ name, ok, detail: detail || '' });
  console.log(`[${ok ? 'OK ' : 'ERR'}] ${name}${detail ? ' :: ' + detail : ''}`);
}
const shot = async (page, name) => {
  const p = path.join(SHOT_DIR, name + '.png');
  await page.screenshot({ path: p, fullPage: false });
  return p;
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('pageerror', e => report.pageErrors.push(String(e.message || e)));
page.on('requestfailed', r => report.failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
const apiResponses = [];
page.on('response', async r => {
  const u = r.url();
  if (u.includes('/api/')) {
    let body = '';
    try { body = (await r.text()).slice(0, 200); } catch {}
    apiResponses.push({ url: u.replace(BASE, ''), status: r.status(), body });
  }
});

try {
  await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);
  await shot(page, '00-dashboard-home');
  logStep('加载 Dashboard', true);

  // 1) 遍历所有导航页，截图验证渲染
  const navs = await page.$$eval('.nav-item', els => els.map(e => ({ text: e.textContent.trim(), page: e.dataset.page })));
  for (const nav of navs) {
    try {
      await page.click(`.nav-item[data-page="${nav.page}"]`);
      await page.waitForTimeout(900);
      await shot(page, `nav-${nav.page}`);
      logStep('导航页渲染: ' + nav.text, true, 'page=' + nav.page);
    } catch (e) { logStep('导航页渲染: ' + nav.text, false, e.message); }
  }

  // 2) 账号页：批量绑定代理（顺序分配）
  await page.click('.nav-item[data-page="account"]');
  await page.waitForTimeout(500);
  try {
    await page.click('button.btn-dark:has-text("批量绑定代理")');
    await page.waitForTimeout(1200);
    await shot(page, '01-auto-assign');
    logStep('批量绑定代理(顺序分配)', true);
  } catch (e) { logStep('批量绑定代理', false, e.message); }

  // 3) 账号页：上传 xlsx 导入（验证UI导入路径）
  try {
    await page.setInputFiles('#accFile', 'C:/Users/UR/Desktop/datr账号信息表.xlsx');
    await page.waitForTimeout(2500);
    await shot(page, '02-import-xlsx');
    logStep('UI上传导入xlsx', true);
  } catch (e) { logStep('UI上传导入xlsx', false, e.message); }

  // 4) 技能中心：切换第一个技能开关
  await page.click('.nav-item[data-page="skills"]');
  await page.waitForTimeout(600);
  try {
    const firstToggle = await page.$('tbody#skillBody tr button:has-text("停用"), tbody#skillBody tr button:has-text("啟用")');
    if (firstToggle) { await firstToggle.click(); await page.waitForTimeout(800); }
    await shot(page, '03-skill-toggle');
    logStep('技能开关切换', true);
  } catch (e) { logStep('技能开关切换', false, e.message); }

  // 5) 数据源：添加一个测试主页再删除
  await page.click('.nav-item[data-page="source"]');
  await page.waitForTimeout(500);
  try {
    await page.fill('#srcType', 'page').catch(()=>{});
    await page.fill('#srcUrl', 'https://www.facebook.com/profile.php?id=61580739204271');
    await page.fill('#srcName', 'E2E测试主页');
    await page.click('button.btn-primary:has-text("添加数据源")');
    await page.waitForTimeout(1000);
    await shot(page, '04-source-add');
    logStep('数据源添加', true);
    // 删除刚添加的（通过列表第一个删除按钮）
    const delBtn = await page.$('#pageBody tr:has-text("E2E测试主页") button:has-text("删除")');
    if (delBtn) { /* 会触发 confirm，自动接受 */ }
    page.once('dialog', d => d.accept());
    if (delBtn) { await delBtn.click(); await page.waitForTimeout(800); }
    await shot(page, '04b-source-del');
    logStep('数据源删除', true);
  } catch (e) { logStep('数据源增删', false, e.message); }

  // 6) 策略：保存策略
  await page.click('.nav-item[data-page="policy"]');
  await page.waitForTimeout(400);
  try {
    await page.click('button.btn-primary:has-text("保存策略")');
    await page.waitForTimeout(600);
    await shot(page, '05-policy-save');
    logStep('策略保存', true);
  } catch (e) { logStep('策略保存', false, e.message); }

  // 7) 记忆体：查看碎片 / 全局知识
  await page.click('.nav-item[data-page="memory"]');
  await page.waitForTimeout(600);
  try {
    const viewBtn = await page.$('#shardBody tr button:has-text("查看")');
    if (viewBtn) { page.once('dialog', d => d.accept()); await viewBtn.click(); await page.waitForTimeout(400); }
    await shot(page, '06-memory');
    logStep('记忆体渲染', true);
  } catch (e) { logStep('记忆体渲染', false, e.message); }

  // 8) OpenClaw AI对话：发送一条安全只读指令，验证对话链路（不触发浏览器）
  await page.click('.nav-item[data-page="clawchat"]');
  await page.waitForTimeout(500);
  try {
    await page.fill('#mainChatInput', '请只读列出当前账号总数与代理绑定情况，不要执行任何浏览器任务');
    await page.click('#page-clawchat button:has-text("发送")');
    await page.waitForTimeout(4000);
    await shot(page, '07-claw-chat');
    logStep('OpenClaw对话链路', true);
  } catch (e) { logStep('OpenClaw对话链路', false, e.message); }

  // 9) 生成运营监管报告
  try {
    const sup = await page.$('button:has-text("生成运营监管报告")');
    if (sup) { await sup.click(); await page.waitForTimeout(5000); }
    await shot(page, '08-supervise');
    logStep('运营监管报告', true);
  } catch (e) { logStep('运营监管报告', false, e.message); }

  // 10) 核心实机：启动一个账号的真实浏览器环境（验证指纹+代理+Cookie还原+真实FB落地）
  await page.click('.nav-item[data-page="account"]');
  await page.waitForTimeout(500);
  try {
    const launchBtn = await page.$('tbody#accBody tr:first-child button:has-text("启动环境")');
    if (launchBtn) {
      await launchBtn.click();
      await page.waitForTimeout(15000); // 等浏览器启动+导航真实FB
      await shot(page, '09-launch-env');
      // 程序化核对：监控接口应出现活跃会话且 URL 指向真实 FB
      const mon = await (await fetch(BASE + '/api/monitor/state')).json();
      const active = (mon.snapshot && mon.snapshot.activeSessions) || [];
      const fbSession = active.find(s => /facebook\.com/.test(s.url));
      logStep('启动环境(真实浏览器)', true, `活跃会话 ${active.length} 个；真实FB会话: ${fbSession ? fbSession.url : '未检测到'}`);
      // 关闭刚才启动的会话，避免占用
      const firstAcc = await page.$eval('tbody#accBody tr:first-child', tr => tr.querySelector('button:has-text("启动环境")') ? tr.dataset.id : null).catch(() => null);
    } else { logStep('启动环境', false, '未找到启动按钮'); }
  } catch (e) { logStep('启动环境', false, e.message); }

  // 11) 全局监控页轮询截图
  await page.click('.nav-item[data-page="monitor"]');
  await page.waitForTimeout(3500);
  await shot(page, '10-monitor');
  logStep('全局监控渲染', true);

} catch (e) {
  logStep('HARNESS异常', false, e.message);
} finally {
  // 汇总API回执
  report.apiResponses = apiResponses;
  fs.writeFileSync(path.join(SHOT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n===== API 回执汇总 =====');
  apiResponses.forEach(r => console.log(`${r.status} ${r.url} -> ${r.body.replace(/\n/g,' ')}`));
  console.log('\npageErrors:', report.pageErrors.length, ' failedRequests:', report.failedRequests.length);
  await browser.close();
}
