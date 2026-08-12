/**
 * 轻量验证：仪表盘日志面板(G5修复) + 全局监控面板渲染（不启动真实 FB 窗口）。
 */
import { chromium, Browser, Page } from 'playwright-core';

const CHROME_PATH = 'C:/Users/UR/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = 'http://localhost:18991/dashboard';

async function main() {
  const browser: Browser = await chromium.launch({ executablePath: CHROME_PATH, headless: false });
  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERR: ' + e.message));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000); // 让 pollLogs 跑几次（启动日志已存在）

  const logText = (await page.textContent('#logBox')) || '';
  const logStuck = logText.includes('加载中');
  console.log('[QUICK] logBox.length=', logText.length, '| stuck=', logStuck);

  await page.click('.nav-item[data-page="monitor"]');
  await page.waitForTimeout(3000);
  const monTs = (await page.textContent('#monitorTs')) || '';
  const monSystem = (await page.textContent('#monSystem')) || '';
  const monAgent = (await page.textContent('#monAgent')) || '';
  await page.screenshot({ path: 'G:/Aike-FBclaw/data/e2e-final.png' });

  const result = {
    logPanelOk: !logStuck && logText.length > 6,
    monitorTs: monTs.trim(),
    monitorSystemHasOs: monSystem.includes('Windows'),
    monitorAgentHasLlm: monAgent.includes('LLM'),
    consoleErrors,
  };
  console.log('[QUICK] RESULT', JSON.stringify(result, null, 2));
  await browser.close();
}
main();
