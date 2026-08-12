/**
 * Cookie注入 v3 — 使用视觉模式确保持久化
 * 从剩余17个order文件提取c_user cookie并注入
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
      if (parts.length >= 2) {
        const uid = parts[0].trim();
        const pass = parts[1].trim();
        const cookie = parts[2]?.trim() || '';
        if (uid && pass && cookie.includes('c_user=')) {
          accs.push({ uid, pass, cookie });
        }
      }
    }
  }
  return accs;
}

async function main() {
  const accs = parseAll();
  console.log(`找到 ${accs.length} 个带c_user的账号\n`);

  // 删旧测试目录
  // (skip, already done)

  let injected = 0;
  for (let i = 0; i < Math.min(20, accs.length); i++) {
    const a = accs[i];
    const profileId = 'fb_' + a.uid.slice(-10);
    const profileDir = path.join(BASE, profileId);
    fs.mkdirSync(profileDir, { recursive: true });

    console.log(`[${i+1}] UID ${a.uid.slice(-8)}...`);

    try {
      // 解析cookie
      const pairs = a.cookie.replace(/%3A/g, ':').replace(/%2F/g, '/').replace(/%3D/g, '=').replace(/%3B/g, ';').split(';');
      const cookies = pairs.map(p => {
        const s = p.trim();
        if (!s.includes('=')) return null;
        const eq = s.indexOf('=');
        return {
          name: s.substring(0, eq).trim(),
          value: s.substring(eq + 1).trim(),
          domain: '.facebook.com',
          path: '/',
          httpOnly: ['xs','fr','datr','sb'].includes(s.substring(0,eq).trim()),
          secure: true,
          sameSite: 'None' as const,
        };
      }).filter(Boolean);

      if (!cookies.find((c: any) => c.name === 'c_user')) {
        console.log('  ⏭️ 跳过(无c_user)');
        continue;
      }

      // 用视觉模式注入（确保持久化到SQLite）
      const ctx = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        args: ['--no-sandbox', '--window-size=400,300', '--window-position=0,0'],
      });
      await ctx.addCookies(cookies as any);
      ctx.addCookies(cookies as any); // double add to be safe
      
      // 打开FB验证
      const page = await ctx.newPage();
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(4000);
      
      const verifyCookies = await ctx.cookies();
      const hasCUser = verifyCookies.some((c: any) => c.name === 'c_user');
      
      if (hasCUser) {
        console.log(`  ✅ 已登录 (${verifyCookies.length}cookies)`);
        injected++;
      } else {
        console.log(`  ❌ 登录失败`);
      }
      
      await ctx.close();
      await new Promise(r => setTimeout(r, 2000));

      // 验证持久化：重新打开
      const ctx2 = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        args: ['--no-sandbox'],
      });
      const final = await ctx2.cookies();
      const persisted = final.some((c: any) => c.name === 'c_user');
      console.log(`  ${persisted ? '💾 持久化成功' : '❌ 持久化失败'} (${final.length}cookies)`);
      await ctx2.close();

    } catch (e: any) {
      console.log(`  💥 ${e.message?.slice(0,60)}`);
    }
  }

  console.log(`\n登录成功: ${injected}/${Math.min(20, accs.length)}`);
}

main().catch(console.error);
