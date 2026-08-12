import { chromium } from 'playwright-core';
import * as fs from 'fs';

(async () => {
  const PROFILE = 'G:/Aike-FBclaw/data/browser-profiles/acc_1786267236728_j8f5';
  const PROXY = 'http://127.0.0.1:11082';

  console.log('Start test...');
  
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    args: ['--no-sandbox', '--proxy-server=' + PROXY, '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1536, height: 864 },
  });

  const page = await ctx.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(4000);

  // 详细诊断
  const title = await page.title();
  console.log('Page title:', title);

  const hasLoginForm = await page.$('form[action*="login"]') || await page.$('#loginform') || await page.$('input[name="email"]');
  console.log('Has login form:', !!hasLoginForm);

  const hasFeed = await page.$('div[role="feed"]');
  console.log('Has feed:', !!hasFeed);

  const hasNav = await page.$('div[role="navigation"]');
  console.log('Has navigation:', !!hasNav);

  // 检查完整URL
  console.log('Final URL:', page.url().slice(0, 100));

  // 检查所有cookie
  const cookies = await ctx.cookies();
  console.log('All cookies:');
  cookies.forEach(c => console.log(`  ${c.name}=${c.value.slice(0,30)} [domain:${c.domain}]`));

  // 查找登录表单元素
  try {
    const inputs = await page.$$('input');
    console.log('Input elements on page:', inputs.length);
    for (const el of inputs.slice(0,5)) {
      const name = await el.getAttribute('name');
      const type = await el.getAttribute('type');
      const placeholder = await el.getAttribute('placeholder');
      if (name || type || placeholder) {
        console.log(`  input[name="${name||''}" type="${type||''}" placeholder="${placeholder||''}"]`);
      }
    }
  } catch {}
  
  await ctx.close();
})();
