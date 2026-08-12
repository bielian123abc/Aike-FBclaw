/**
 * 全量自动登陆 — 从 order 文件解析密码，通过浏览器输入账号密码登陆
 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const DOWNLOADS = 'C:/Users/UR/Downloads';
const PROFILES_DIR = 'G:/Aike-FBclaw/data/browser-profiles';

// 从 order 文件解析 email→password 映射
function loadCredentials(): Map<string, string> {
  const map = new Map<string, string>();
  const files = fs.readdirSync(DOWNLOADS).filter(f => f.startsWith('order') && f.endsWith('.txt'));
  
  for (const file of files) {
    const content = fs.readFileSync(path.join(DOWNLOADS, file), 'utf-8').replace(/^\uFEFF/, '');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      if (line.includes('\t')) {
        const p = line.split('\t');
        if (p.length >= 2 && p[0].includes('@')) {
          map.set(p[0].trim().toLowerCase(), p[1].trim());
        }
      }
    }
  }
  return map;
}

async function main() {
  const creds = loadCredentials();
  console.log(`找到 ${creds.size} 组密码`);

  const profiles = fs.readdirSync(PROFILES_DIR).filter(d => d.startsWith('acc_'));
  console.log(`找到 ${profiles.length} 个 Profile`);

  // 建立 name→profile 映射
  const nameToProfile = new Map<string, string>();
  for (const pr of profiles) {
    const profPath = path.join(PROFILES_DIR, pr);
    const jsonFile = path.join(profPath, '..', 'profiles.json');
    // 从 profiles.json 读取
    try {
      const j = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, 'profiles.json'), 'utf-8'));
      for (const p of j) {
        if (p.id === pr || p.accountId === pr) {
          nameToProfile.set((p.name || '').toLowerCase(), pr);
        }
      }
    } catch {}
  }

  // 手动映射已知的账号名→profile
  // 从API获取映射
  const apiProfiles = await (await fetch('http://localhost:18990/api/profiles')).json();
  for (const p of apiProfiles) {
    nameToProfile.set(p.name.toLowerCase(), p.accountId);
  }

  console.log(`映射: ${nameToProfile.size}个`);

  let success = 0, fail = 0;

  for (const [name, profileId] of nameToProfile) {
    // 找密码
    let password = creds.get(name.toLowerCase());
    if (!password) {
      // 模糊匹配
      for (const [k, v] of creds) {
        if (k.includes(name) || name.includes(k)) { password = v; break; }
      }
    }
    if (!password) {
      console.log(`  ⏭️ ${name}: 无密码`);
      continue;
    }

    console.log(`\n🔑 ${name} (${profileId.slice(-6)})`);

    let ctx: any = null;
    try {
      const proxyRes = await (await fetch('http://localhost:18990/api/proxy/assignments')).json();
      const proxyId = proxyRes[profileId];
      let proxyArg: string | undefined;
      if (proxyId) {
        // 使用已有的转发器端口
        const proxyList = await (await fetch('http://localhost:18990/api/proxy/list')).json();
        const px = proxyList.find((p: any) => p.id === proxyId);
        if (px) proxyArg = `http://127.0.0.1:${px.localPort}`;
      }

      const args = ['--no-sandbox', '--disable-blink-features=AutomationControlled'];
      if (proxyArg) args.push('--proxy-server=' + proxyArg);

      ctx = await chromium.launchPersistentContext(
        path.join(PROFILES_DIR, profileId),
        {
          headless: false,
          args,
          viewport: { width: 1280, height: 900 },
          locale: 'zh-TW',
          timezoneId: 'Asia/Taipei',
        }
      );

      const page = await ctx.newPage();
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      // 检查是否已登陆
      const cookies = await ctx.cookies();
      if (cookies.some(c => c.name === 'c_user')) {
        console.log(`  ✅ ${name}: 已登陆（跳过）`);
        await ctx.close();
        success++;
        continue;
      }

      // 输入账号密码
      const emailEl = await page.$('input[name="email"]');
      const passEl = await page.$('input[name="pass"]');
      const loginBtn = await page.$('button[name="login"]') || await page.$('#loginbutton');

      if (!emailEl || !passEl || !loginBtn) {
        console.log(`  ⚠️ ${name}: 找不到登陆表单`);
        await ctx.close();
        fail++;
        continue;
      }

      await emailEl.fill(name);
      await page.waitForTimeout(500);
      await passEl.fill(password);
      await page.waitForTimeout(500);
      await loginBtn.click();

      // 等待结果
      await page.waitForTimeout(8000);

      const url = page.url();
      const newCookies = await ctx.cookies();
      const hasCUser = newCookies.some(c => c.name === 'c_user');

      if (url.includes('checkpoint') || url.includes('challenge') || url.includes('two_factor')) {
        console.log(`  🔐 ${name}: 需要验证 → 浏览器保持打开，请手动处理`);
        // 不关闭，留给用户手动操作
        await page.waitForTimeout(5000);
        // 多等10秒看是否自动通过
        const url2 = page.url();
        const cookies2 = await ctx.cookies();
        if (cookies2.some(c => c.name === 'c_user')) {
          console.log(`  ✅ ${name}: 验证自动通过`);
          success++;
        } else {
          console.log(`  ⚠️ ${name}: 仍需手动验证，保持打开`);
        }
        await ctx.close();
        continue;
      }

      if (hasCUser) {
        console.log(`  ✅ ${name}: 登陆成功`);
        success++;
      } else {
        console.log(`  ❌ ${name}: 登陆失败 (URL: ${url.slice(0,60)})`);
        fail++;
      }

      await ctx.close();

    } catch (e: any) {
      console.log(`  💥 ${name}: ${e.message?.slice(0,80)}`);
      if (ctx) await ctx.close().catch(() => {});
      fail++;
    }

    // 每个账号间隔
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`\n═══════════════════════`);
  console.log(`  成功: ${success}  失败: ${fail}`);
  console.log(`═══════════════════════`);
}

main().catch(console.error);
