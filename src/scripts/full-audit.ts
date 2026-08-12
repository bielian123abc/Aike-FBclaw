/**
 * 全自动账号体检 + 真实操作测试
 * 目标：遍历所有账号 → 分类 → 执行操作 → 拿回执截图
 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'G:/Aike-FBclaw/data/browser-profiles';
const REPORT = 'G:/Aike-FBclaw/data/account-report.json';
const SCREENSHOTS = 'G:/Aike-FBclaw/data/screenshots';
fs.mkdirSync(SCREENSHOTS, { recursive: true });

interface AccountTest {
  profile: string;
  email: string;
  uid: string;
  status: 'ok' | 'checkpoint' | 'captcha' | '2fa' | 'login_fail' | 'error';
  proxyIp: string;
  detail: string;
  operations: { name: string; success: boolean; screenshot: string }[];
}

const results: AccountTest[] = [];

async function testAccount(profileDir: string, proxyIdx: number): Promise<AccountTest> {
  const dirName = path.basename(profileDir);
  const statePath = path.join(profileDir, 'state.json');
  
  const base: AccountTest = {
    profile: dirName,
    email: dirName.replace(/^fb_/, '').replace(/_/g, '.'),
    uid: '',
    status: 'error',
    proxyIp: '',
    detail: '',
    operations: [],
  };

  if (!fs.existsSync(statePath)) {
    base.detail = '无state.json';
    return base;
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  if (!state.cookies?.length) {
    base.detail = '无Cookie';
    return base;
  }

  const proxyPort = 11080 + (proxyIdx % 100);

  try {
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: [`--proxy-server=http://127.0.0.1:${proxyPort}`, '--no-sandbox', '--disable-blink-features=AutomationControlled'],
      viewport: { width: 1280, height: 900 },
      locale: 'zh-TW', timezoneId: 'Asia/Taipei',
    });

    await ctx.addCookies(state.cookies.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain || '.facebook.com', path: c.path || '/' })));

    const page = await ctx.newPage();

    // 1. 查IP
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'load', timeout: 10000 });
    base.proxyIp = JSON.parse(await page.textContent('body')).ip;

    // 2. 开Facebook
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    const url = page.url();
    const cookies = await ctx.cookies();
    const cUser = cookies.find(c => c.name === 'c_user');
    base.uid = cUser?.value || '';
    const body = await page.textContent('body') || '';

    // 3. 分类判断
    if (!cUser) {
      base.status = 'login_fail';
      base.detail = '无c_user Cookie';
      await takeScreenshot(page, dirName, 'login_fail');
    } else if (url.includes('checkpoint') && body.includes('captcha')) {
      base.status = 'captcha';
      base.detail = 'CAPTCHA人机验证 — 建议删除';
      await takeScreenshot(page, dirName, 'captcha');
    } else if (url.includes('checkpoint') && body.includes('Confirm that you\'re human')) {
      base.status = 'captcha';
      base.detail = '人机验证 — 建议删除';
      await takeScreenshot(page, dirName, 'captcha');
    } else if (url.includes('checkpoint')) {
      base.status = 'checkpoint';
      base.detail = '需身份验证';
      await takeScreenshot(page, dirName, 'checkpoint');
    } else if (url.includes('login') || url.includes('Login')) {
      base.status = 'login_fail';
      base.detail = '跳转到登录页';
      await takeScreenshot(page, dirName, 'login');
    } else {
      // 已登录！执行真实操作
      base.status = 'ok';
      base.detail = '正常登录';
      
      // 操作1: 浏览首页
      try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);
        const feedBody = await page.textContent('body') || '';
        const hasFeed = feedBody.includes('feed') || feedBody.includes('home') || feedBody.includes('news');
        base.operations.push({ name: '浏览首页', success: hasFeed, screenshot: await takeScreenshot(page, dirName, 'op1-home') });
      } catch (e: any) {
        base.operations.push({ name: '浏览首页', success: false, screenshot: '' });
      }

      // 操作2: 模拟滚动
      try {
        await page.evaluate(() => window.scrollBy(0, 600));
        await page.waitForTimeout(2000);
        await page.evaluate(() => window.scrollBy(0, 600));
        await page.waitForTimeout(2000);
        base.operations.push({ name: '模拟滚动', success: true, screenshot: await takeScreenshot(page, dirName, 'op2-scroll') });
      } catch {
        base.operations.push({ name: '模拟滚动', success: false, screenshot: '' });
      }

      // 操作3: 尝试点赞第一条帖子
      try {
        const likeBtn = await page.$('[aria-label*="赞"]') || await page.$('[aria-label*="Like"]') || await page.$('[role="button"][aria-label$="like"]');
        if (likeBtn) {
          await likeBtn.click();
          await page.waitForTimeout(2000);
          base.operations.push({ name: '点赞帖子', success: true, screenshot: await takeScreenshot(page, dirName, 'op3-like') });
        } else {
          base.operations.push({ name: '点赞帖子', success: false, screenshot: '无可用按钮' });
        }
      } catch {
        base.operations.push({ name: '点赞帖子', success: false, screenshot: '' });
      }
    }

    // 保存Cookie状态
    if (cUser) {
      await ctx.storageState({ path: statePath });
    }

    await ctx.close();
  } catch (e: any) {
    base.detail = e.message.slice(0, 100);
  }

  return base;
}

async function takeScreenshot(page: any, name: string, tag: string): Promise<string> {
  try {
    const fname = `${name}_${tag}_${Date.now()}.png`;
    await page.screenshot({ path: path.join(SCREENSHOTS, fname) });
    return fname;
  } catch { return ''; }
}

async function main() {
  const dirs = fs.readdirSync(BASE).filter(d => fs.existsSync(path.join(BASE, d, 'state.json')));
  console.log(`找到 ${dirs.length} 个有Cookie的账号\n`);

  for (let i = 0; i < dirs.length; i++) {
    console.log(`[${i+1}/${dirs.length}] 测试: ${dirs[i]}`);
    const r = await testAccount(path.join(BASE, dirs[i]), i);
    results.push(r);
    console.log(`  状态: ${r.status} | UID:${r.uid} | IP:${r.proxyIp} | ${r.detail}`);
    for (const op of r.operations) {
      console.log(`    操作: ${op.name} → ${op.success ? '✅' : '❌'} ${op.screenshot}`);
    }
    await new Promise(r2 => setTimeout(r2, 1000));
  }

  // 统计
  const ok = results.filter(r => r.status === 'ok');
  const cp = results.filter(r => r.status === 'checkpoint');
  const captcha = results.filter(r => r.status === 'captcha');
  const fail = results.filter(r => r.status === 'login_fail' || r.status === 'error');

  console.log(`\n═══════════════════════════`);
  console.log(`✅ 正常: ${ok.length}`);
  console.log(`⚠️ Checkpoint: ${cp.length}`);
  console.log(`🚫 CAPTCHA/异常: ${captcha.length}  ← 建议删除`);
  console.log(`❌ 失败: ${fail.length}`);
  console.log(`\n截图目录: ${SCREENSHOTS}`);
  console.log(`报告: ${REPORT}`);

  // 保存报告
  fs.writeFileSync(REPORT, JSON.stringify({ time: new Date().toISOString(), summary: { ok: ok.length, checkpoint: cp.length, captcha: captcha.length, fail: fail.length }, results }, null, 2));
  process.exit(0);
}

main();
