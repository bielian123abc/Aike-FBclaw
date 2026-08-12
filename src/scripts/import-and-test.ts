/**
 * 账号测试 v2 — 先不用代理，测账号本身是否存活
 */
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright-core';

const DOWNLOADS = 'C:/Users/UR/Downloads';

interface Account { email: string; password: string; twoFactor?: string; cookie?: string; source: string; }

function parseAll(): Account[] {
  const files = fs.readdirSync(DOWNLOADS).filter(f => f.startsWith('order') && f.endsWith('.txt'));
  const accounts: Account[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(DOWNLOADS, file), 'utf-8').replace(/^\uFEFF/, '');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;

      const fields = line.split('\t').filter(f => f.trim());
      const pipes = line.split('|').filter(f => f.trim());

      // 找email: 含@的字段
      const emails = fields.filter(f => f.includes('@'));
      const pipeEmails = pipes.filter(f => f.includes('@'));
      const allEmails = [...emails, ...pipeEmails];

      if (allEmails.length === 0) continue;

      // email是含@的最长字段
      const email = allEmails.reduce((a,b) => a.length > b.length ? a : b).trim();

      // 找密码: 排除email、cookie、数字ID、token等
      const allFields = [...fields, ...pipes];
      const passCandidates = allFields.filter(f => {
        const t = f.trim();
        return t.length >= 4 && t.length <= 40 && 
               !t.includes('@') && !t.includes('c_user=') && !t.includes('xs=') &&
               !t.includes('datr=') && !t.includes('EAAAA') && t !== email;
      });
      const pass = passCandidates[0] || '';

      // 找2FA: 大写字母+空格的32位码
      const twofaCandidates = allFields.filter(f => {
        const t = f.trim();
        return /^[A-Z0-9\s]{20,50}$/.test(t) && t.includes(' ');
      });
      const twofa = twofaCandidates[0] || undefined;

      // 找cookie
      const cookieCandidates = allFields.filter(f => f.includes('c_user=') || f.includes('datr='));
      const cookie = cookieCandidates[0] || (allFields.length > 4 ? allFields[allFields.length - 2] : undefined);

      if (email.includes('@') && pass) {
        accounts.push({ email, password: pass.trim(), twoFactor: twofa?.trim(), cookie: cookie?.trim(), source: file });
      }
    }
  }

  // 去重
  const seen = new Set<string>();
  return accounts.filter(a => {
    const k = a.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function testOne(acc: Account): Promise<boolean> {
  let context: any = null;
  try {
    context = await chromium.launchPersistentContext(
      `G:/Aike-FBclaw/data/login-${acc.email.replace(/[^a-zA-Z0-9]/g,'_').slice(0,20)}`,
      {
        headless: false,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        locale: 'zh-TW',
        timezoneId: 'Asia/Taipei',
      }
    );

    const page = await context.newPage();

    // Cookie注入
    if (acc.cookie) {
      try {
        // JSON cookie
        const c = JSON.parse(acc.cookie);
        if (Array.isArray(c)) await context.addCookies(c);
      } catch {
        // 纯文本cookie: name=value;name2=value2
        const cookies = acc.cookie.split(';').map((s: string) => {
          const [name, ...rest] = s.trim().split('=');
          return { name: name.trim(), value: rest.join('=').trim(), domain: '.facebook.com', path: '/' };
        }).filter((c: any) => c.name && c.value);
        if (cookies.length > 0) await context.addCookies(cookies);
      }
    }

    // 打开FB
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);

    // 检查是否已登陆（有cookie的话可能直接登陆）
    const isLoggedIn = await page.$('div[role="navigation"]') || await page.$('[aria-label="Facebook"]');
    if (isLoggedIn) {
      console.log(`  ✅ ${acc.email} cookie有效，已登陆`);
      await context.close();
      return true;
    }

    // 没有cookie或cookie无效，手动登陆
    const emailEl = await page.$('input[name="email"]') || await page.$('#email');
    const passEl = await page.$('input[name="pass"]') || await page.$('#pass');

    if (!emailEl || !passEl) {
      console.log(`  ⚠️ ${acc.email} 找不到登陆表单 (URL: ${page.url().slice(0,50)})`);
      await context.close();
      return false;
    }

    await emailEl.click();
    await emailEl.fill(acc.email);
    await page.waitForTimeout(300);
    await passEl.click();
    await passEl.fill(acc.password);
    await page.waitForTimeout(500);

    const loginBtn = await page.$('button[name="login"]') || await page.$('#loginbutton');
    if (loginBtn) await loginBtn.click();

    await page.waitForTimeout(5000);

    const url = page.url();

    // 判断结果
    if (url.includes('checkpoint') || url.includes('challenge') || url.includes('login/identify')) {
      console.log(`  🔐 ${acc.email} 需要验证`);
      await context.close();
      return false;
    }

    // 2FA页面
    if (url.includes('two_factor') || url.includes('checkpoint') || url.includes('approvals')) {
      if (acc.twoFactor) {
        console.log(`  🔑 ${acc.email} 需要2FA，尝试...`);
        const codeEl = await page.$('input[name="approvals_code"]') || await page.$('input[type="text"]');
        if (codeEl) {
          await codeEl.fill(acc.twoFactor);
          await page.click('button[type="submit"]');
          await page.waitForTimeout(5000);
          const url2 = page.url();
          if (url2.includes('facebook.com') && !url2.includes('login') && !url2.includes('checkpoint')) {
            console.log(`  ✅ ${acc.email} 2FA通过`);
            await context.close();
            return true;
          }
        }
      }
      console.log(`  ⚠️ ${acc.email} 需要手动2FA`);
      await context.close();
      return false;
    }

    // 登陆成功
    if (url.includes('facebook.com') && !url.includes('login') && !url.includes('checkpoint')) {
      console.log(`  ✅ ${acc.email} 登陆成功`);
      await context.close();
      return true;
    }

    // 密码错误等
    const errorEl = await page.$('[id*="error"]') || await page.$('div[class*="error"]');
    const errorText = errorEl ? await errorEl.textContent() : '';
    console.log(`  ❌ ${acc.email} 失败: ${errorText?.slice(0,60) || url.slice(0,60)}`);
    await context.close();
    return false;

  } catch (e: any) {
    console.log(`  💥 ${acc.email} 异常: ${e.message?.slice(0,80)}`);
    if (context) await context.close().catch(() => {});
    return false;
  }
}

async function main() {
  const accounts = parseAll();
  console.log(`解析到 ${accounts.length} 个账号\n`);

  if (accounts.length === 0) { console.log('无账号'); return; }

  const good: Account[] = [];
  const bad: { email: string; reason: string }[] = [];

  // 只测试有cookie的（更快），然后测试无cookie的
  const withCookie = accounts.filter(a => a.cookie);
  const withoutCookie = accounts.filter(a => !a.cookie);
  const toTest = [...withCookie, ...withoutCookie].slice(0, 30);

  console.log(`有cookie: ${withCookie.length}, 无cookie: ${withoutCookie.length}`);
  console.log(`测试前 ${toTest.length} 个\n`);

  for (let i = 0; i < toTest.length; i++) {
    const acc = toTest[i];
    console.log(`[${i+1}/${toTest.length}] ${acc.email}`);
    const ok = await testOne(acc);
    if (ok) good.push(acc);
    else bad.push({ email: acc.email, reason: '见上方日志' });
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n=== 结果 ===`);
  console.log(`✅ 可用: ${good.length}`);
  console.log(`❌ 不可用: ${bad.length}`);

  fs.writeFileSync('G:/Aike-FBclaw/data/good-accounts.json', JSON.stringify(good.map(a => ({
    email: a.email, password: a.password, twoFactor: a.twoFactor,
  })), null, 2));
  console.log('已保存到 data/good-accounts.json');
}

main().catch(console.error);
