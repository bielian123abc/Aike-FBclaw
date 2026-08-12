/**
 * 自动登录全部账号 → 保存Cookie
 * 数据源: order*.txt (密码+Cookie) + CSV (密码) + good-accounts.json
 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// TOTP 生成（Google Authenticator 兼容）
function generateTOTP(secret: string): string {
  try {
    const key = secret.replace(/\s/g, '').toUpperCase();
    // Base32 解码
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of key) {
      const val = alphabet.indexOf(c);
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, '0');
    }
    const bytes: number[] = [];
    for (let i = 0; i + 7 < bits.length; i += 8) {
      bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    // HMAC-SHA1
    const counter = Math.floor(Date.now() / 1000 / 30);
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigUInt64BE(BigInt(counter), 0);
    const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(counterBuf).digest();
    const offset = hmac[hmac.length - 1] & 0x0F;
    const code = ((hmac[offset] & 0x7F) << 24 | (hmac[offset + 1] & 0xFF) << 16 | (hmac[offset + 2] & 0xFF) << 8 | (hmac[offset + 3] & 0xFF)) % 1000000;
    return code.toString().padStart(6, '0');
  } catch {
    return '';
  }
}

const DOWNLOADS = 'C:/Users/UR/Downloads';
const BASE = 'G:/Aike-FBclaw/data/browser-profiles';
const LOG = 'G:/Aike-FBclaw/data/login-results.txt';

let results: string[] = [];

function log(msg: string) {
  console.log(msg);
  results.push(msg);
}

interface AccountInfo {
  email: string;
  password: string;
  cookies?: string;
  twofa?: string;  // TOTP 密钥
  source: string;
}

// 解析 order*.txt: UID|PASS|COOKIE|TOKEN|EMAIL|APP|TIME
function parseOrderFile(filepath: string): AccountInfo[] {
  const accs: AccountInfo[] = [];
  const content = fs.readFileSync(filepath, 'utf-8').replace(/^\uFEFF/, '');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    
    // Tab格式: email\tpass\t2fa\t\tcookie
    if (line.includes('\t')) {
      const p = line.split('\t');
      if (p.length >= 3 && p[0].includes('@')) {
        accs.push({ email: p[0].trim(), password: p[1].trim(), twofa: p[2]?.trim(), cookies: p[4]?.trim(), source: path.basename(filepath) });
      }
      continue;
    }
    
    // Pipe格式: UID|PASS|COOKIE|TOKEN|EMAIL|APP|TIME
    const parts = line.split('|');
    if (parts.length >= 5) {
      const uid = parts[0].trim();
      const pass = parts[1].trim();
      const cookies = parts[2]?.trim();
      const email = parts[4]?.trim();  // 索引4 才是邮箱！
      
      if (email && email.includes('@') && pass && pass.length >= 4) {
        accs.push({ email, password: pass, cookies: cookies || undefined, source: path.basename(filepath) });
      }
    }
  }
  return accs;
}

// 解析 CSV 文件
function parseCSV(filepath: string): AccountInfo[] {
  const accs: AccountInfo[] = [];
  const content = fs.readFileSync(filepath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = content.split('\n');
  if (lines.length < 2) return accs;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const email = cols[1];
    const pass = cols[2];
    if (email && email.includes('@') && pass) {
      accs.push({ email, password: pass, source: path.basename(filepath) });
    }
  }
  return accs;
}

// 从 order 文件的 cookie 串提取关键 cookie
function parseCookieStr(cookieStr: string): { name: string; value: string; domain: string; path: string; url?: string }[] {
  const pairs = cookieStr.split(';').map(s => s.trim());
  const cookies: { name: string; value: string; domain: string; path: string; url?: string }[] = [];
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (value && name) {
      cookies.push({ name, value, domain: '.facebook.com', path: '/', url: 'https://www.facebook.com' });
    }
  }
  return cookies;
}

async function loginAccount(acc: AccountInfo, proxyPort: number): Promise<boolean> {
  const safeName = acc.email.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
  const profileDir = path.join(BASE, 'fb_' + safeName);

  // 确保目录存在
  fs.mkdirSync(profileDir, { recursive: true });

  log(`\n--- ${acc.email} ---`);

  try {
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: [
        '--no-sandbox',
        `--proxy-server=http://127.0.0.1:${proxyPort}`,
        '--disable-blink-features=AutomationControlled',
      ],
      viewport: { width: 1280, height: 900 },
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
    });

    const page = await ctx.newPage();

    // 如果有order文件中的cookie，先注入
    if (acc.cookies) {
      const cookies = parseCookieStr(acc.cookies);
      if (cookies.length > 0) {
        await ctx.addCookies(cookies);
        log(`  注入 ${cookies.length} 个Cookie`);
      }
    }

    // 打开 Facebook
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // 检查是否已登录
    const currentCookies = await ctx.cookies();
    const cUser = currentCookies.find(c => c.name === 'c_user');

    if (cUser) {
      log(`  ✅ 已登录 (UID: ${cUser.value})`);
      await page.screenshot({ path: `G:/Aike-FBclaw/data/login-${safeName}.png` });
      await ctx.close();
      return true;
    }

    // 需要在页面输入密码
    log(`  填入登录信息...`);
    
    // 找邮箱输入框
    const emailInput = await page.$('input[name="email"], #email, input[aria-label*="電子郵件"], input[placeholder*="電子郵件"]');
    // 找密码输入框
    const passInput = await page.$('input[name="pass"], #pass, input[aria-label*="密碼"], input[placeholder*="密碼"]');
    
    if (!emailInput || !passInput) {
      log(`  ❌ 找不到登录表单`);
      await page.screenshot({ path: `G:/Aike-FBclaw/data/login-${safeName}.png` });
      await ctx.close();
      return false;
    }
    
    await emailInput.fill(acc.email);
    log(`  邮箱: ${acc.email}`);
    await passInput.fill(acc.password);
    log(`  密码: 已填入`);
    await passInput.press('Enter');
    await page.waitForTimeout(8000);
    
    // 检查登录结果
    let cookies = await ctx.cookies();
    let cU = cookies.find(c => c.name === 'c_user');
    if (cU) {
      log(`  ✅ 登录成功 (UID: ${cU.value})`);
      const sp = path.join(profileDir, 'state.json');
      await ctx.storageState({ path: sp });
      await page.screenshot({ path: `G:/Aike-FBclaw/data/login-${safeName}.png` });
      await ctx.close();
      return true;
    }
    
    // 检查是否需要2FA
    const body = await page.textContent('body');
    const need2FA = body?.includes('驗證碼') || body?.includes('verification code') || body?.includes('Authenticator') || body?.includes('approvals_code') || body?.includes('雙重驗證') || body?.includes('two-factor');
    if (need2FA && acc.twofa) {
      log(`  需要2FA，自动生成验证码...`);
      const code = generateTOTP(acc.twofa);
      log(`  验证码: ${code}`);
      
      const codeInput = await page.$('input[name="approvals_code"], #approvals_code, input[type="text"]');
      if (codeInput) {
        await codeInput.fill(code);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(6000);
        cookies = await ctx.cookies();
        cU = cookies.find(c => c.name === 'c_user');
        if (cU) {
          log(`  ✅ 2FA通过！UID: ${cU.value}`);
          const sp = path.join(profileDir, 'state.json');
          await ctx.storageState({ path: sp });
          await page.screenshot({ path: `G:/Aike-FBclaw/data/login-${safeName}.png` });
          await ctx.close();
          return true;
        }
      }
      log(`  ❌ 2FA自动填写失败`);
    } else if (need2FA) {
      log(`  ⚠️ 需要2FA但无密钥数据，跳过`);
    }
    
    // 检查 checkpoint
    if (body?.includes('checkpoint') || body?.includes('confirm your identity') || body?.includes('驗證你的身份')) {
      log(`  ⚠️ checkpoint，跳过`);
      await page.screenshot({ path: `G:/Aike-FBclaw/data/login-${safeName}.png` });
      await ctx.close();
      return false;
    }
    
    log(`  ❌ 登录未成功`);
    await page.screenshot({ path: `G:/Aike-FBclaw/data/login-${safeName}.png` });
    await ctx.close();
    return false;
  } catch (e: any) {
    log(`  ❌ 浏览器错误: ${e.message}`);
    return false;
  }
}

async function main() {
  fs.writeFileSync(LOG, '');
  
  // 收集所有账号
  const allAccounts: Map<string, AccountInfo> = new Map();
  
  // 1. 从 order*.txt 解析
  const orderFiles = fs.readdirSync(DOWNLOADS).filter(f => f.startsWith('order-') && f.endsWith('.txt'));
  log(`order文件: ${orderFiles.length}个`);
  for (const f of orderFiles) {
    const accs = parseOrderFile(path.join(DOWNLOADS, f));
    for (const a of accs) {
      const key = a.email.toLowerCase();
      if (!allAccounts.has(key)) allAccounts.set(key, a);
      else if (a.cookies) allAccounts.set(key, a); // 优先保留有cookie的
    }
  }
  
  // 2. 从 CSV 解析
  const csvFiles = fs.readdirSync(DOWNLOADS).filter(f => f.startsWith('order_') && f.endsWith('.csv'));
  log(`CSV文件: ${csvFiles.length}个`);
  for (const f of csvFiles) {
    const accs = parseCSV(path.join(DOWNLOADS, f));
    for (const a of accs) {
      const key = a.email.toLowerCase();
      if (!allAccounts.has(key)) allAccounts.set(key, a);
    }
  }
  
  // 3. 从 good-accounts.json（过滤掉含|的坏数据）
  const gaPath = 'G:/Aike-FBclaw/data/good-accounts.json';
  if (fs.existsSync(gaPath)) {
    const gaData = JSON.parse(fs.readFileSync(gaPath, 'utf-8'));
    for (const a of gaData) {
      if (a.email && a.password && a.email.includes('@') && !a.email.includes('|')) {
        const key = a.email.toLowerCase();
        if (!allAccounts.has(key)) {
          allAccounts.set(key, { email: a.email, password: a.password, cookies: a.cookies, source: 'good-accounts.json' });
        }
      }
    }
  }
  
  log(`\n总计: ${allAccounts.size} 个唯一账号`);
  
  let success = 0, fail = 0;
  let portIdx = 0;
  
  for (const [email, acc] of allAccounts) {
    const proxyPort = 11080 + (portIdx % 100);
    portIdx++;
    
    const ok = await loginAccount(acc, proxyPort);
    if (ok) success++; else fail++;
    
    // 关闭浏览器后等一下
    await new Promise(r => setTimeout(r, 1000));
    
    if (portIdx >= 30) break; // 最多30个
  }
  
  log(`\n═══════════════════`);
  log(`成功: ${success}  失败: ${fail}`);
  log(`结果: ${LOG}`);
  
  fs.writeFileSync(LOG, results.join('\n'), 'utf-8');
}

main().catch(e => {
  log(`致命错误: ${e.message}`);
  fs.writeFileSync(LOG, results.join('\n'), 'utf-8');
});
