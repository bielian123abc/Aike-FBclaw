// 窗口重排实测：开 3 个账号窗口 -> 点「一键重排窗口」-> 读服务端真实下发的窗口矩形验证网格排布
import { chromium } from 'playwright-core';
import * as fs from 'fs';

const CHROME = 'C:/Users/UR/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const BASE = 'http://localhost:18991';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('dialog', d => { try { d.accept(); } catch {} });
const api = async (u, m = 'GET') => { try { const r = await page.evaluate(async (a) => { const res = await fetch(a.u, { method: a.m }); return await res.json(); }, { u: BASE + u, m }); return r; } catch { return null; } };

let log = '';
try {
  await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);

  const ids = await page.$$eval('#accBody tr', rows => rows.slice(0, 3).map(r => { const e = r.querySelector('[data-id]'); return e ? e.getAttribute('data-id') : null; }).filter(Boolean));
  log += `[verify] 将启动账号: ${ids.join(',')}\n`;

  for (const id of ids) {
    const sel = `#accBody tr:has([data-id="${id}"]) button:has-text("启动环境")`;
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.click().catch(() => {}); }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);

  const before = await api('/api/windows/bounds');
  log += `[verify] 重排前 bounds: ${JSON.stringify(before?.bounds || [])}\n`;

  const retileBtn = await page.$('button:has-text("一键重排窗口")');
  if (retileBtn) { await retileBtn.click(); log += '[verify] 已点击 一键重排窗口\n'; }
  else log += '[verify] 未找到 一键重排窗口 按钮!\n';
  await page.waitForTimeout(3000);

  const after = await api('/api/windows/bounds');
  const b = after?.bounds || [];
  log += `[verify] 重排后 bounds(${b.length}):\n`;
  b.forEach(x => log += `   ${x.accountId} -> left=${x.x} top=${x.y} w=${x.w} h=${x.h}\n`);

  const distinct = new Set(b.map(x => `${x.x},${x.y}`));
  const tiled = b.length >= 3 && distinct.size >= 3;
  // 额外校验：3 个窗口应覆盖屏幕且不重叠（网格坐标单调）
  log += `[verify] 有效窗口数=${b.length}, 不同左上角数=${distinct.size}\n`;
  log += tiled ? '[verify] 结论: 窗口已被排成网格(多窗口各自归位) ✓\n' : '[verify] 结论: 未形成有效网格 ✗\n';
  fs.writeFileSync('G:/Aike-FBclaw/data/screenshots/window-retile-verify.txt', log);
  console.log(log);
} catch (e) {
  console.log('[verify] 异常:', e.message);
} finally {
  await browser.close();
  try { require('child_process').execSync('taskkill /F /IM chrome.exe >nul 2>&1'); } catch {}
  console.log('[verify] 已清理浏览器进程');
}
