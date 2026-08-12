// 独立验证 CDP Client Hints 覆蓋：用指紋引擎生成一套指紋，透過 CDP 注入
// userAgentMetadata，發一個真實網路請求，讀回服務端看到的 Sec-CH-UA / Accept-Language。
import { chromium } from 'playwright-core';
import { getFingerprintEngine } from '../src/core/browser/fingerprint.ts';

const fp = getFingerprintEngine().loadOrCreate('verify_ch_' + Date.now());
const engine = getFingerprintEngine();

const context = await chromium.launchPersistentContext('', {
  headless: true,
  userAgent: fp.userAgent,
  locale: fp.locale,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
const page = context.pages()[0] || await context.newPage();

const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setUserAgentOverride', {
  userAgent: fp.userAgent,
  acceptLanguage: engine.buildAcceptLanguage(fp),
  platform: fp.platform,
  userAgentMetadata: engine.buildUserAgentMetadata(fp),
});

let captured: any = null;
await page.route('**/*', (route) => {
  const h = route.request().headers();
  if (h['sec-ch-ua']) captured = h;
  return route.continue();
});

try {
  await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
} catch (e: any) {
  console.log('(導航警告，仍嘗試從請求攔截讀取 header):', e?.message || e);
}

// 再補一個確定能通的請求
try {
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
} catch {}

if (captured) {
  console.log('=== 瀏覽器實際送出的 Client Hints ===');
  console.log('sec-ch-ua           :', captured['sec-ch-ua']);
  console.log('sec-ch-ua-platform  :', captured['sec-ch-ua-platform']);
  console.log('sec-ch-ua-mobile    :', captured['sec-ch-ua-mobile']);
  console.log('accept-language     :', captured['accept-language']);
  console.log('user-agent          :', captured['user-agent']);
} else {
  console.log('未能攔截到含 sec-ch-ua 的請求（可能網路受限）');
}

await context.close();
process.exit(0);
