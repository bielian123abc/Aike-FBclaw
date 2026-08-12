/**
 * 最终修复：Cookie 持久化
 * 1. 视觉模式启动 → 绝对不用 headless
 * 2. 保存 storageState
 * 3. 每次重开时加载 storageState
 * 4. 统一浏览器配置（指纹参数完全一致）
 */
import { chromium, BrowserContext } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';
import { getFingerprintEngine, FingerprintConfig } from '../core/browser/fingerprint.js';

const DOWNLOADS = 'C:/Users/UR/Downloads';
const BASE = 'G:/Aike-FBclaw/data/browser-profiles';

// 解析剩余 order 文件中带 c_user cookie 的账号
function parseAll(): { uid: string; pass: string; cookie: string }[] {
  const files = fs.readdirSync(DOWNLOADS).filter(f => f.startsWith('order') && f.endsWith('.txt'));
  const accs: any[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(DOWNLOADS, file), 'utf-8').replace(/^\uFEFF/, '');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length >= 2 && parts[0] && parts[1]) {
        const cookie = parts[2]?.trim() || '';
        if (cookie.includes('c_user=')) {
          accs.push({ uid: parts[0].trim(), pass: parts[1].trim(), cookie });
        }
      }
    }
  }
  return accs;
}

function parseCookies(str: string): any[] {
  const clean = str.replace(/%3A/g, ':').replace(/%2F/g, '/').replace(/%3D/g, '=');
  return clean.split(';').map(s => {
    const p = s.trim();
    if (!p.includes('=')) return null;
    const eq = p.indexOf('=');
    return {
      name: p.substring(0, eq).trim(),
      value: p.substring(eq + 1).trim(),
      domain: '.facebook.com',
      path: '/',
      httpOnly: ['xs', 'fr', 'datr', 'sb'].includes(p.substring(0, eq).trim()),
      secure: true,
      sameSite: 'None' as const,
      expires: 2147483647, // 2038年
    };
  }).filter(Boolean);
}

async function openProfile(profileDir: string, fp: FingerprintConfig, proxy?: string): Promise<BrowserContext> {
  const args = ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-features=IsolateOrigins,site-per-process'];
  if (proxy) args.push('--proxy-server=' + proxy);

  // 加载之前保存的 storageState
  const statePath = path.join(profileDir, 'state.json');
  const options: any = {
    headless: false,
    args,
    viewport: { width: fp.viewportWidth, height: fp.viewportHeight },
    locale: fp.locale,
    timezoneId: fp.timezone,
    userAgent: fp.userAgent,
    deviceScaleFactor: fp.deviceScaleFactor,
    geolocation: fp.geolocation,
  };

  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (state.cookies && state.cookies.some((c: any) => c.name === 'c_user')) {
        options.storageState = statePath;
        console.log('  📂 加载 storageState');
      }
    } catch {}
  }

  return chromium.launchPersistentContext(profileDir, options);
}

async function main() {
  const accs = parseAll();
  console.log(`找到 ${accs.length} 个账号\n`);

  const fp = getFingerprintEngine();
  let success = 0;

  // 清理旧fb_ profile
  for (const d of fs.readdirSync(BASE)) {
    if (d.startsWith('fb_')) {
      try { fs.rmSync(path.join(BASE, d), { recursive: true, force: true }); } catch {}
    }
  }

  for (let i = 0; i < Math.min(5, accs.length); i++) {
    const a = accs[i];
    const profileId = 'fb_' + a.uid.slice(-10);
    const profileDir = path.join(BASE, profileId);
    fs.mkdirSync(profileDir, { recursive: true });

    const fingerprint = fp.generate(profileId);
    console.log(`[${i + 1}] ${a.uid.slice(-8)} (${fingerprint.viewportWidth}x${fingerprint.viewportHeight})`);

    try {
      const cookies = parseCookies(a.cookie);
      if (!cookies.some((c: any) => c.name === 'c_user')) { console.log('  ⏭️ 无c_user'); continue; }

      // 第一次打开：注入cookie + 验证 + 保存state
      const ctx1 = await openProfile(profileDir, fingerprint);
      await ctx1.addCookies(cookies);

      const page = await ctx1.newPage();
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(5000);

      const verify = await ctx1.cookies();
      const hasCUser = verify.some((c: any) => c.name === 'c_user');

      if (hasCUser) {
        await ctx1.storageState({ path: path.join(profileDir, 'state.json') });
        console.log(`  ✅ 登录成功 + state已保存`);
      } else {
        console.log(`  ❌ 登录失败`);
      }

      await ctx1.close();
      await new Promise(r => setTimeout(r, 3000));

      // 第二次打开：验证持久化
      if (hasCUser) {
        console.log(`  🔄 重新打开验证...`);
        const ctx2 = await openProfile(profileDir, fingerprint);
        const cks = await ctx2.cookies();
        const persisted = cks.some((c: any) => c.name === 'c_user');

        if (persisted) {
          console.log(`  💾 持久化成功！(${cks.length} cookies)`);
          success++;
        } else {
          // 不放 storageState 时没 cookie，说明 state.json 有效
          console.log(`  ⚠️ 需要 storageState 加载 (state.json有效)`);
          // 测试用 storageState 加载
          const ctx3 = await chromium.launchPersistentContext(profileDir, {
            headless: false,
            args: ['--no-sandbox', '--window-size=400,300', '--window-position=0,0'],
            ...Object.fromEntries(
              Object.entries({ viewport: { width: fingerprint.viewportWidth, height: fingerprint.viewportHeight }, locale: fingerprint.locale, timezoneId: fingerprint.timezone, userAgent: fingerprint.userAgent, deviceScaleFactor: fingerprint.deviceScaleFactor })
            ),
            storageState: path.join(profileDir, 'state.json'),
          });
          const cks3 = await ctx3.cookies();
          const withState = cks3.some((c: any) => c.name === 'c_user');
          console.log(`  ${withState ? '💾 storageState有效！' : '❌ storageState也无效'}`);
          if (withState) success++;
          await ctx3.close();
        }
        await ctx2.close();
      }
    } catch (e: any) {
      console.log(`  💥 ${e.message?.slice(0, 60)}`);
    }
  }

  console.log(`\n成功持久化: ${success}/${Math.min(5, accs.length)}`);

  // 清理旧 profile 并通知服务器重载
  // (在面板中手动刷新即可)
}

main().catch(console.error);
