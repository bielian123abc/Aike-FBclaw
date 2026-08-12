/**
 * 实机端到端测试：启动浏览器 → 走代理 → 打开FB → 截图验证
 * 测试标准：拿到实际页面截图和URL才算通过
 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DIR = 'G:/Aike-FBclaw/data/real-tests';
fs.mkdirSync(TEST_DIR, { recursive: true });
const RESULTS: string[] = [];

function log(msg: string) {
  const line = `[${new Date().toLocaleTimeString('zh-TW')}] ${msg}`;
  console.log(line);
  RESULTS.push(line);
}

async function testBrowserLaunch(accountId: string, proxyPort: number, testName: string) {
  const profileDir = path.join('G:/Aike-FBclaw/data/browser-profiles', accountId);
  const screenshot = path.join(TEST_DIR, `${testName}.png`);
  
  log(`\n=== 测试: ${testName} ===`);
  log(`Profile: ${accountId}`);
  log(`代理: http://127.0.0.1:${proxyPort}`);
  
  try {
    log('启动浏览器...');
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: [
        '--no-sandbox',
        `--proxy-server=http://127.0.0.1:${proxyPort}`,
        '--disable-blink-features=AutomationControlled',
        `--window-name=${testName}`,
      ],
      viewport: { width: 1280, height: 900 },
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
    });
    log('✅ 浏览器已启动');
    
    const page = await ctx.newPage();
    
    // Step 1: 检查代理IP
    log('检查代理IP...');
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'load', timeout: 15000 });
    const ipText = await page.textContent('body');
    const ip = JSON.parse(ipText).ip;
    log(`✅ 代理IP: ${ip}`);
    
    // Step 2: 打开 Facebook
    log('打开 Facebook...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    const currentUrl = page.url();
    log(`当前URL: ${currentUrl.slice(0,80)}`);
    
    // Step 3: 检查登录状态
    const cookies = await ctx.cookies();
    const cUser = cookies.find(c => c.name === 'c_user');
    const xs = cookies.find(c => c.name === 'xs');
    
    log(`c_user: ${cUser?.value || '无'}`);
    log(`xs: ${xs?.value ? xs.value.slice(0,20)+'...' : '无'}`);
    
    // Step 4: 检查页面元素
    const title = await page.title();
    log(`页面标题: ${title}`);
    
    // 检查是否有登录表单
    const loginForm = await page.$('form[action*="login"]');
    const hasLoginForm = !!loginForm;
    log(`登录表单: ${hasLoginForm ? '有（未登录）' : '无（已登录或验证页）'}`);
    
    // 检查是否有 checkpoint
    const checkpoint = await page.$('[data-checkpoint]');
    if (checkpoint) log('⚠️ 发现 checkpoint 页面');
    
    // Step 5: 截图
    await page.screenshot({ path: screenshot, fullPage: false });
    log(`✅ 截图已保存: ${screenshot}`);
    
    // Step 6: 检查页面内容
    const bodyText = await page.textContent('body');
    const textPreview = bodyText?.slice(0, 200).replace(/\s+/g, ' ');
    log(`页面文本: ${textPreview}`);
    
    await ctx.close();
    log(`✅ 测试完成: ${testName}`);
    
  } catch (e: any) {
    log(`❌ 测试失败: ${e.message}`);
  }
}

async function main() {
  log('═══════════════════════════════════════');
  log('  Aike-FBclaw 实机端到端测试');
  log('═══════════════════════════════════════');
  
  // 获取账号和代理数据
  const profilesResp = await fetch('http://localhost:18990/api/profiles');
  const profiles = await profilesResp.json();
  const proxyResp = await fetch('http://localhost:18990/api/proxy/list');
  const proxies = await proxyResp.json();
  const assignResp = await fetch('http://localhost:18990/api/proxy/assignments');
  const assignments = await assignResp.json();
  
  log(`账号: ${profiles.length}个`);
  log(`代理: ${proxies.length}个`);
  log(`已分配: ${Object.keys(assignments).length}个`);
  
  // 取第一个有分配代理的账号
  const assignedIds = Object.keys(assignments);
  if (assignedIds.length === 0) {
    log('❌ 无已分配代理的账号');
    return;
  }
  
  // 测试前3个账号
  for (let i = 0; i < Math.min(3, assignedIds.length); i++) {
    const accId = assignedIds[i];
    const proxyId = assignments[accId];
    const proxy = proxies.find((p: any) => p.id === proxyId);
    if (!proxy) continue;
    
    await testBrowserLaunch(accId, proxy.localPort, `account-${i+1}`);
  }
  
  // 写入结果
  fs.writeFileSync(path.join(TEST_DIR, 'results.txt'), RESULTS.join('\n'), 'utf-8');
  log('\n═══════════════════════════════════════');
  log('测试完成，结果保存在: G:/Aike-FBclaw/data/real-tests/');
}

main().catch(e => {
  log(`致命错误: ${e.message}`);
  fs.writeFileSync(path.join(TEST_DIR, 'results.txt'), RESULTS.join('\n'), 'utf-8');
});
