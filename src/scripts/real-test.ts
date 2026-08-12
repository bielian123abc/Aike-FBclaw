import { chromium } from 'playwright-core';
import * as fs from 'fs';

const LOG = 'G:/Aike-FBclaw/data/full-test.log';
fs.writeFileSync(LOG, '');

function log(msg: string) {
  console.log(msg);
  fs.appendFileSync(LOG, msg + '\n');
}

(async () => {
  try {
    // 测试账号：cyber.rebel7277，代理端口 11082
    const PROFILE = 'G:/Aike-FBclaw/data/browser-profiles/acc_1786267236728_j8f5';
    const PROXY = 'http://127.0.0.1:11082';

    log('=== 完整端到端测试 ===');
    log('账号: cyber.rebel7277');
    log('代理: ' + PROXY);
    log('');

    // 1. 启动浏览器
    log('[1] 启动浏览器...');
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: true,
      args: ['--no-sandbox', '--proxy-server=' + PROXY, '--disable-blink-features=AutomationControlled'],
      viewport: { width: 1536, height: 864 },
    });
    log('✅ 浏览器已启动');

    const page = await ctx.newPage();

    // 2. 检测IP
    log('[2] 检测代理IP...');
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'load', timeout: 15000 });
    const ip = JSON.parse(await page.textContent('body')).ip;
    log('✅ 代理IP: ' + ip);

    // 3. 打开Facebook
    log('[3] 打开 Facebook...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(4000);

    const fbUrl = page.url();
    const isLoggedIn = fbUrl.includes('facebook.com') && !fbUrl.includes('/login') && !fbUrl.includes('checkpoint');
    log('   URL: ' + fbUrl.slice(0, 80));

    // 4. Cookie检查
    log('[4] 检查 Cookie...');
    const cookies = await ctx.cookies();
    const cUser = cookies.find(c => c.name === 'c_user');
    const xs = cookies.find(c => c.name === 'xs');
    log('   c_user: ' + (cUser ? '✅ ' + cUser.value.slice(0, 10) + '...' : '❌ 无'));
    log('   xs: ' + (xs ? '✅' : '❌ 无'));
    log('   总Cookie数: ' + cookies.length);

    // 5. FB首页内容检查
    log('[5] 首页内容检查...');
    try {
      const storyCount = await page.$$eval('div[role="feed"] > div, div[data-pagelet="Stories"]', els => els.length);
      log('   内容元素: ' + storyCount + '个');
    } catch {
      log('   内容元素: 无法检测');
    }

    // 6. 截图
    log('[6] 截图...');
    await page.screenshot({ path: 'G:/Aike-FBclaw/data/fb-login-test.png', fullPage: false });
    log('✅ 截图已保存: data/fb-login-test.png');

    await ctx.close();

    // 7. 汇总
    log('');
    log('═══════════════════════════════════');
    log('  测试结果');
    log('═══════════════════════════════════');
    log('  代理IP: ' + ip);
    log('  已登录: ' + (isLoggedIn ? '✅ 是' : '❌ 否'));
    log('  Cookie: ' + (cUser ? '✅ 有效' : '❌ 无效'));
    log('═══════════════════════════════════');

    if (!isLoggedIn) {
      log('⚠️  账号未登录，需要重新注入Cookie或手动登录');
    }

  } catch (e: any) {
    log('💥 错误: ' + e.message);
  }
})();
