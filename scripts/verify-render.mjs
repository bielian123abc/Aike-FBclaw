import { chromium } from 'playwright-core';

const url = 'http://localhost:18991/';
const shot = 'G:\\Aike-FBclaw\\scripts\\_ui-render.png';

async function tryLaunch() {
  for (const opt of [
    { channel: 'msedge', headless: true },
    { headless: true },
  ]) {
    try {
      const b = await chromium.launch(opt);
      return b;
    } catch (e) {
      console.log('launch failed with', JSON.stringify(opt), '-', e.message.split('\n')[0]);
    }
  }
  return null;
}

const browser = await tryLaunch();
if (!browser) { console.error('no browser available'); process.exit(2); }
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console:' + m.text()); });
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => console.log('goto warn:', e.message));
await page.waitForTimeout(2500);
const hasBtn = await page.$('#fbclawLogBtn');
const hasPanel = await page.$('#fbclawLogPanel');
await page.screenshot({ path: shot, fullPage: false });
console.log('fbclawLogBtn present:', !!hasBtn);
console.log('fbclawLogPanel present:', !!hasPanel);
console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
console.log('screenshot ->', shot);
