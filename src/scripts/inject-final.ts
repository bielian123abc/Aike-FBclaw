/**
 * Cookie 持久化最终方案：visual 注入 → storageState 保存
 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const DOWNLOADS = 'C:/Users/UR/Downloads';
const BASE = 'G:/Aike-FBclaw/data/browser-profiles';

interface Account { uid: string; pass: string; cookie: string; }

function parseAll(): Account[] {
  const files = fs.readdirSync(DOWNLOADS).filter(f => f.startsWith('order') && f.endsWith('.txt'));
  const accs: Account[] = [];
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
      httpOnly: ['xs','fr','datr','sb'].includes(p.substring(0, eq).trim()),
      secure: true,
      sameSite: 'None' as const,
    };
  }).filter(Boolean);
}

async function main() {
  const accs = parseAll();
  console.log(`找到 ${accs.length} 个账号\n`);

  // 先删旧测试profile
  const existing = fs.readdirSync(BASE);
  for (const d of existing) {
    if (d.startsWith('fb_')) {
      try { fs.rmSync(path.join(BASE, d), { recursive: true, force: true }); } catch {}
    }
  }

  const results: { uid: string; profileDir: string; ok: boolean }[] = [];

  for (let i = 0; i < Math.min(15, accs.length); i++) {
    const a = accs[i];
    const profileId = 'fb_' + a.uid.slice(-10);
    const profileDir = path.join(BASE, profileId);
    fs.mkdirSync(profileDir, { recursive: true });

    console.log(`[${i+1}] ${a.uid.slice(-8)}`);

    let ctx: any = null;
    try {
      const cookies = parseCookies(a.cookie);
      if (!cookies.find((c: any) => c.name === 'c_user')) {
        console.log(`  ⏭️ 无c_user`);
        continue;
      }

      // 视觉模式注入
      ctx = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        args: ['--no-sandbox', '--window-size=400,300', '--window-position=0,0'],
      });
      await ctx.addCookies(cookies);
      
      const page = await ctx.newPage();
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(4000);

      // 保存 storageState
      const statePath = path.join(profileDir, 'fb-state.json');
      await ctx.storageState({ path: statePath });

      const verify = await ctx.cookies();
      const ok = verify.some((c: any) => c.name === 'c_user');
      console.log(`  ${ok ? '✅' : '❌'} 注入成功 (state: ${fs.statSync(statePath).size}B)`);
      
      if (ok) results.push({ uid: a.uid, profileDir, ok: true });
      
    } catch (e: any) {
      console.log(`  💥 ${e.message?.slice(0,60)}`);
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 验证持久化：headless模式加载storageState
  console.log(`\n=== 持久化验证 (headless) ===`);
  let verified = 0;
  for (const r of results) {
    const statePath = path.join(r.profileDir, 'fb-state.json');
    if (!fs.existsSync(statePath)) continue;

    try {
      const ctx = await chromium.launchPersistentContext(r.profileDir, {
        headless: true,
        args: ['--no-sandbox'],
      });
      const cookies = await ctx.cookies();
      const has = cookies.some((c: any) => c.name === 'c_user');
      console.log(`  ${r.uid.slice(-8)}: ${has ? '✅' : '❌'} headless (${cookies.length}cookies)`);
      if (has) verified++;
      await ctx.close();
    } catch {}
  }

  console.log(`\n成功: ${results.length} | 持久化: ${verified}`);
  
  // 导入到服务器
  for (const r of results) {
    try {
      await (await fetch('http://localhost:18990/api/profiles/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: [{ name: 'FB_' + r.uid.slice(-6), email: r.uid, proxy: '' }] }),
      })).json();
    } catch {}
  }
  console.log(`${results.length} 个新账号已加入系统`);
}

main().catch(console.error);
