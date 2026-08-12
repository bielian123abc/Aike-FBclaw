import { chromium } from 'playwright-core';
import * as fs from 'fs';

(async () => {
  try {
    fs.writeFileSync('G:/Aike-FBclaw/data/proxy-test-result.txt', 'starting\n');
    const ctx = await chromium.launchPersistentContext('G:/Aike-FBclaw/data/ip-test-hd2', {
      headless: true,
      args: ['--no-sandbox','--proxy-server=http://127.0.0.1:11080'],
      viewport: { width: 1280, height: 900 },
    });
    fs.appendFileSync('G:/Aike-FBclaw/data/proxy-test-result.txt', 'browser launched\n');
    const page = await ctx.newPage();
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'load', timeout: 20000 });
    const t = await page.textContent('body');
    fs.appendFileSync('G:/Aike-FBclaw/data/proxy-test-result.txt', 'IP: ' + t + '\n');
    await ctx.close();
    process.exit(0);
  } catch(e) {
    fs.appendFileSync('G:/Aike-FBclaw/data/proxy-test-result.txt', 'ERR: ' + e.message + '\n');
    process.exit(1);
  }
})();
