// 独立探测：用指定代理访问 ipify（通用网站）与 facebook.com，判断 ERR_EMPTY_RESPONSE 是代理全坏还是仅 FB
import { chromium } from 'playwright-core';
const CHROME = 'C:/Users/UR/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

const proxy = process.argv[2];
if (!proxy) {
  console.log('Usage: node scripts/proxy-probe.mjs <proxy-url>');
  console.log('Example: node scripts/proxy-probe.mjs http://u:p@gw.dataimpulse.com:10000');
  process.exit(1);
}

console.log('Testing proxy:', proxy.replace(/\/\/.*@/, '//***@'));
const context = await chromium.launchPersistentContext('G:/Aike-FBclaw/data/probe-profile', {
  executablePath: CHROME,
  headless: true,
  proxy: { server: proxy },
  args: ['--no-sandbox'],
});
const page = context.pages()[0] || await context.newPage();

async function probe(label, url) {
  try {
    console.log(`\n[${label}] navigating to ${url}`);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = resp ? resp.status() : 'no-response';
    const urlNow = page.url();
    const body = await page.evaluate(() => document.body ? document.body.innerText.trim().slice(0, 200) : '(no body)').catch(e => e.message);
    console.log(`[${label}] status=${status} url=${urlNow} body=${body}`);
  } catch (e) {
    console.log(`[${label}] FAIL: ${e.message}`);
  }
}

await probe('ipify', 'https://api.ipify.org?format=text');
await probe('google', 'https://www.google.com');
await probe('facebook', 'https://www.facebook.com');

await context.close();
