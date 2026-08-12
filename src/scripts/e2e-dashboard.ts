/**
 * E2E：真机加载 :18991/dashboard，真实点击按钮，验证 UI↔后端 联调。
 * 用途：开发者角度全局验证（查缺补漏）。
 */
import { chromium, Browser, Page } from 'playwright-core';

const CHROME_PATH = 'C:/Users/UR/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = 'http://localhost:18991/dashboard';
const SHOT_DIR = 'G:/Aike-FBclaw/data';

const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const findings: string[] = [];

function log(...a: any[]) { console.log('[E2E]', ...a); }

async function main() {
  const browser: Browser = await chromium.launch({ executablePath: CHROME_PATH, headless: false });
  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  try {
    // 1) 加载仪表盘
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const title = await page.title();
    const accCount = await page.locator('#accBody tr').count();
    log('仪表盘标题:', title, '| 账号行数:', accCount);
    if (!title.includes('FB') && !title.includes('账号')) findings.push('⚠️ 仪表盘标题异常: ' + title);

    await page.screenshot({ path: `${SHOT_DIR}/e2e-1-dashboard.png` });

    // 2) 切换到 OpenClaw AI对话，点击「生成运营监管报告」
    await page.click('.nav-item[data-page="clawchat"]');
    await page.waitForTimeout(600);
    await page.click('#page-clawchat button:has-text("生成运营监管报告")');
    log('已点击：生成运营监管报告，等待 agent...');
    await page.waitForTimeout(8000);
    const reportText = (await page.textContent('#mainPageChatBody')) || '';
    const hasReport = reportText.includes('运营监管报告') || reportText.includes('总') || reportText.includes('建议');
    log('监管报告长度:', reportText.length, '| 含报告内容:', hasReport);
    if (!hasReport) findings.push('⚠️ 监管报告未生成/未渲染: len=' + reportText.length);
    await page.screenshot({ path: `${SHOT_DIR}/e2e-2-supervise.png` });

    // 3) 在 AI对话 发送一条消息（验证 /api/chat + LLM 联通）
    await page.fill('#mainChatInput', '帮我看看现在哪些账号状态正常，需要注意什么');
    await page.click('#page-clawchat button:has-text("发送")');
    log('已发送 AI 对话消息，等待回复...');
    await page.waitForTimeout(10000);
    const chatText = (await page.textContent('#mainPageChatBody')) || '';
    log('AI对话后内容长度:', chatText.length);
    if (chatText.length < reportText.length + 10) findings.push('⚠️ AI对话回复可能为空或异常');
    await page.screenshot({ path: `${SHOT_DIR}/e2e-3-chat.png` });

    // 4) 回到账号页，真实点击第一个账号「启动环境」
    await page.click('.nav-item[data-page="account"]');
    await page.waitForTimeout(500);
    const before = await page.locator('#accBody tr').count();
    const launchBtn = page.locator('#accBody button:has-text("启动环境")').first();
    await launchBtn.click();
    log('已点击：启动环境（首个账号），等待 FB 浏览器启动...');
    await page.waitForTimeout(12000);
    // 刷新日志面板
    const logText = (await page.textContent('#logBox')) || '';
    log('日志面板长度:', logText.length);
    if (!logText || logText.includes('加载中')) findings.push('⚠️ 实时日志面板未更新');
    await page.screenshot({ path: `${SHOT_DIR}/e2e-4-launch.png` });

    // 5) 检查系统配置端点 + 全局监控快照（验证监控集成）
    const profResp = await page.evaluate(async () => {
      const r = await fetch('/api/system/profile');
      return r.json();
    });
    log('system/profile:', JSON.stringify(profResp.profile?.os || profResp.profile, null, 0).slice(0, 120));
    if (!profResp.success) findings.push('⚠️ /api/system/profile 失败');

    // 6) 全局监控快照：启动后应有活跃 session + 日志已填充
    const monResp = await page.evaluate(async () => {
      const r = await fetch('/api/monitor/state');
      return r.json();
    });
    const snap = monResp.snapshot || {};
    log('monitor: activeSessions=', (snap.activeSessions || []).length, '| logs via /api/logs 检查');
    const logsResp = await page.evaluate(async () => {
      const r = await fetch('/api/logs');
      return r.json();
    });
    log('logs count after launch:', (logsResp.logs || []).length);
    if ((snap.activeSessions || []).length < 1) findings.push('⚠️ 启动环境后监控未显示活跃 session');
    if ((logsResp.logs || []).length < 1) findings.push('⚠️ 启动后 /api/logs 仍为空（console 接管失效）');
    // 切到全局监控页验证渲染
    await page.click('.nav-item[data-page="monitor"]');
    await page.waitForTimeout(2500);
    const monTs = await page.textContent('#monitorTs');
    log('monitor panel ts:', monTs);
    await page.screenshot({ path: `${SHOT_DIR}/e2e-5-monitor.png` });


  } catch (e: any) {
    findings.push('❌ E2E 异常: ' + (e?.message || e));
  } finally {
    const result = {
      consoleErrors,
      pageErrors,
      findings,
      accountRows: await page.locator('#accBody tr').count().catch(() => -1),
    };
    log('==== RESULT ====');
    console.log(JSON.stringify(result, null, 2));
    await browser.close();
  }
}

main();
