/**
 * 无头渲染指挥中心 UI，逐页截图，用于客观定位排版问题。
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright-core';

const APP = 'G:/Aike-FBclaw';
const SERVER = path.join(APP, 'dist', 'server.js');
const CHROME = path.join(APP, 'browser', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const PORT = 18997;
const OUT = path.join(APP, 'fbtest_shots', 'ui-shots');
fs.mkdirSync(OUT, { recursive: true });

function waitServer(timeoutMs = 45000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/status`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) return resolve(true);
      } catch {}
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 600);
    };
    tick();
  });
}

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, API_PORT: String(PORT), MOCK_FB: '1' },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d.toString()));
child.stderr.on('data', (d) => (log += d.toString()));

const up = await waitServer();
if (!up) {
  console.error('server 未就绪:\n' + log.slice(-2000));
  child.kill('SIGKILL');
  process.exit(1);
}
console.log('server 就绪，开始截图');

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERR: ' + e.message));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => console.log('goto warn:', e.message));
await page.waitForTimeout(1500);

// 默认（dashboard）
await page.screenshot({ path: path.join(OUT, '00-dashboard.png'), fullPage: true });
console.log('截: 00-dashboard');

// 遍历所有 nav 项
const navItems = await page.$$('.nav-item');
console.log('nav 项数:', navItems.length);
for (let i = 0; i < navItems.length; i++) {
  const item = (await page.$$('.nav-item'))[i];
  let label = 'unknown';
  try { label = (await item.innerText()).replace(/\s+/g, '').slice(0, 16); } catch {}
  try {
    await item.click({ timeout: 4000 });
    await page.waitForTimeout(1200);
    const fname = `0${i + 1}-${label}.png`.replace(/[^\w\-.\u4e00-\u9fa5]/g, '_');
    await page.screenshot({ path: path.join(OUT, fname), fullPage: true });
    console.log('截:', fname);
  } catch (e) {
    console.log(`nav ${i} (${label}) 点击失败:`, e.message.slice(0, 60));
  }
}

// 聊天页：尝试输入并发送，看气泡排版
try {
  const chatNav = await page.$('.nav-item[data-page="clawchat"], .nav-item:has-text("对话")');
  if (chatNav) {
    await chatNav.click();
    await page.waitForTimeout(800);
    const input = await page.$('textarea, input[type="text"]');
    if (input) { await input.fill('测试消息排版'); const btn = await page.$('button:has-text("发送"), button:has-text("Send")'); if (btn) await btn.click(); }
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, '99-chat.png'), fullPage: true });
    console.log('截: 99-chat');
  }
} catch (e) { console.log('chat 截图跳过:', e.message.slice(0, 60)); }

console.log('JS errors:', errors.length ? errors.slice(0, 10) : '无');
await browser.close();
child.kill('SIGKILL');
console.log('完成，输出目录:', OUT);
process.exit(0);
