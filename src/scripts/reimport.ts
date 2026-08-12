/**
 * 重新导入 + Cookie 注入 — 从剩余 order 文件
 * 格式: UID\tpassword\tcookie...
 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const DOWNLOADS = 'C:/Users/UR/Downloads';
const BASE_DIR = 'G:/Aike-FBclaw/data/browser-profiles';

async function main() {
  const files = fs.readdirSync(DOWNLOADS).filter(f => f.startsWith('order') && f.endsWith('.txt'));
  console.log(`${files.length} 个文件\n`);

  // 不删除旧Profile，直接添加新的

  let imported = 0, success = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(DOWNLOADS, file), 'utf-8').replace(/^\uFEFF/, '');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines.slice(0, 5)) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      
      const uid = parts[0].trim();
      const password = parts[1].trim();
      const cookieStr = parts[2]?.trim() || '';

      if (!uid || !password) continue;

      // 检查是否有 c_user cookie
      const hasLogin = cookieStr.includes('c_user=');

      console.log(`UID: ${uid} | Pass: ${password.slice(0,8)} | Cookie: ${hasLogin ? '✅' : '❌'}`);

      const profileId = 'acc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const profileDir = path.join(BASE_DIR, profileId);
      fs.mkdirSync(profileDir, { recursive: true });

      // 调用服务器 API 导入
      try {
        await (await fetch('http://localhost:18990/api/profiles/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accounts: [{ name: 'UID_' + uid.slice(-6), email: uid, proxy: '' }] }),
        })).json();
      } catch {}

      imported++;

      if (!hasLogin) {
        console.log(`  → 无Cookie，跳过注入\n`);
        continue;
      }

      // 注入 Cookie
      try {
        const pairs = cookieStr.split(';').map(s => s.trim()).filter(s => s.includes('='));
        const cookies = pairs.map(p => {
          const eq = p.indexOf('=');
          return {
            name: p.substring(0, eq).trim(),
            value: p.substring(eq + 1).trim(),
            domain: '.facebook.com',
            path: '/',
            httpOnly: ['xs', 'fr', 'datr', 'sb'].includes(p.substring(0, eq).trim()),
            secure: true,
            sameSite: 'None' as const,
          };
        });

        // 确保有 c_user
        if (!cookies.some(c => c.name === 'c_user')) {
          console.log(`  → Cookie中无c_user\n`);
          continue;
        }

        const ctx = await chromium.launchPersistentContext(profileDir, {
          headless: true,
          args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        });
        await ctx.addCookies(cookies);
        // 强制关闭确保写入磁盘
        await ctx.close();
        await new Promise(r => setTimeout(r, 1000));

        // 验证是否持久化
        const ctx2 = await chromium.launchPersistentContext(profileDir, {
          headless: true,
          args: ['--no-sandbox'],
        });
        const check = await ctx2.cookies();
        const hasPersisted = check.some(c => c.name === 'c_user');
        console.log(`  → ${hasPersisted ? '✅' : '❌'} 持久化: ${hasPersisted ? '成功' : '失败'} (${check.length} cookies)`);
        await ctx2.close();

        if (hasPersisted) success++;

      } catch (e: any) {
        console.log(`  → ❌ ${e.message}`);
      }

      // 避免过快
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n═══════════════════`);
  console.log(`  导入: ${imported} | Cookie持久化: ${success}`);
  console.log(`═══════════════════`);

  // 通知服务器重载
  try { 
    await fetch('http://localhost:18990/api/status');
    console.log('服务器需要重启以加载新Profile');
  } catch {}
}

main().catch(console.error);
