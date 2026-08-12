import { chromium } from 'playwright-core';
import * as fs from 'fs';

const DIR = 'G:/Aike-FBclaw/data/browser-profiles/acc_1786283206173_kl6w';
const EMAIL = '61590850305313';
const PASS = 'Lb@#9373387392542';

const ctx = await chromium.launchPersistentContext(DIR, {
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-name=登录v3'],
  viewport: { width: 1280, height: 900 },
  locale: 'zh-TW', timezoneId: 'Asia/Taipei',
});
const page = await ctx.newPage();
await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(5000);

// 填 + 点
await page.type('input[name="email"]', EMAIL, { delay: 30 });
await page.type('input[name="pass"]', PASS, { delay: 30 });
await page.waitForTimeout(1000);

// 截图看填充后
await page.screenshot({ path: 'G:/Aike-FBclaw/data/login-v3-filled.png' });

// 点击登录
await page.click('div[role="button"]:has-text("登录")');
await page.waitForTimeout(15000);
await page.screenshot({ path: 'G:/Aike-FBclaw/data/login-v3-after.png' });

// 检查结果
const url = page.url();
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
console.log('URL:', url.slice(0, 80));
console.log('页面内容:', bodyText.slice(0, 150));

const cs = await ctx.cookies();
const uid = cs.find(c => c.name === 'c_user');
console.log('UID:', uid?.value || 'NONE');

// 如果有验证码
const captcha = await page.$('img[src*="captcha"], #captcha, div[data-testid*="captcha"]');
console.log('CAPTCHA:', !!captcha);

// 如果有2FA
const tfa = await page.$('input[name="approvals_code"], input[placeholder*="驗證"]');
console.log('2FA:', !!tfa);

console.log('浏览器保持打开');
await new Promise(r => setTimeout(r, 30000));
await ctx.close();
