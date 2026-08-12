/**
 * E2E 驗證：send_message 全頁 /messages/t/<uid>/ 路徑
 *
 * 用真實 Chrome（playwright-core + 系統 Chrome）驅動 mock Facebook，
 * 完整重現 skillSendMessage 的核心流程：
 *   1. 進入好友個人檔案頁
 *   2. extractProfileUid（找 data-hovercard="...user.php?id=<UID>"）
 *   3. 跳轉全頁 /messages/t/<uid>/
 *   4. 主 DOM locator 找到 composer div[contenteditable][role=textbox]
 *   5. 輸入並 Enter 送出
 *   6. 驗證 mock 狀態確實記錄了這則訊息（可驗證副作用）
 *
 * 不依賴任何真實 FB 帳號，無鎖號風險。
 */
import { chromium, type Browser } from 'playwright-core';
import { startMockFB } from './server';
import * as http from 'http';

const TEST_PORT = 19021;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const COOKIE = 'test@mock.local';

// 與 skillSendMessage 內 extractProfileUid 完全相同的邏輯
function extractProfileUidInPage(): string {
  const hcEl = document.querySelector('[data-hovercard*="user.php?id="]') as HTMLElement | null;
  if (hcEl) {
    const v = hcEl.getAttribute('data-hovercard') || hcEl.getAttribute('href') || '';
    const m = v.match(/[?&]id=(\d{6,})/);
    if (m) return m[1];
  }
  for (const a of Array.from(document.querySelectorAll('a[href*="profile.php?id="]'))) {
    const m = (a.getAttribute('href') || '').match(/[?&]id=(\d{6,})/);
    if (m) return m[1];
  }
  const canon = document.querySelector('link[rel="canonical"]');
  if (canon) {
    const m = (canon.getAttribute('href') || '').match(/[?&]id=(\d{6,})/);
    if (m) return m[1];
  }
  return '';
}

function fetchState(): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: TEST_PORT, path: '/api/mock/state', headers: { Cookie: `c_user=${COOKIE}` } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      }
    );
    req.on('error', reject);
  });
}

async function main() {
  const srv = startMockFB(TEST_PORT);
  const browser: Browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'c_user', value: COOKIE, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();

  const peer = '林怡君';
  const message = '你好，我是做跨境物流的，想請教一下貨代問題～';
  const results: string[] = [];
  let ok = true;
  const assert = (cond: boolean, label: string) => {
    results.push(`${cond ? '✅' : '❌'} ${label}`);
    if (!cond) ok = false;
  };

  try {
    // 1. 個人檔案頁
    await page.goto(`http://127.0.0.1:${TEST_PORT}/${encodeURIComponent(peer)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    const uid = await page.evaluate(extractProfileUidInPage);
    assert(!!uid && /^\d{6,}$/.test(uid), `extractProfileUid 解析到數字 UID：${uid}`);

    // 2. 跳轉全頁 thread
    await page.goto(`http://127.0.0.1:${TEST_PORT}/messages/t/${uid}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);

    // 3. 主 DOM locator 命中 composer（與 skillSendMessage 第一個選擇器一致）
    const composer = page.locator('div[contenteditable="true"][role="textbox"]').first();
    await composer.waitFor({ state: 'visible', timeout: 8000 });
    assert(true, 'composer div[contenteditable="true"][role="textbox"] 在主 DOM 可見且可被 locator 命中');

    // 4. 輸入 + Enter
    await composer.click();
    await page.waitForTimeout(150);
    await composer.type(message, { delay: 20 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // 5. 驗證 mock 狀態記錄了訊息
    const state = await fetchState();
    const conv = (state.conversations || []).find((c: any) => c.peer === peer);
    const recorded = conv && conv.last === message;
    assert(!!recorded, `mock 狀態記錄了送出的訊息（peer=${peer}，${recorded ? 'last="' + conv.last + '"' : '未找到'}）`);
  } catch (e: any) {
    assert(false, `執行例外：${e.message}`);
  } finally {
    await browser.close();
    srv.close();
  }

  console.log('\n===== send_message 全頁路徑 E2E 結果 =====');
  results.forEach((r) => console.log(r));
  console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
