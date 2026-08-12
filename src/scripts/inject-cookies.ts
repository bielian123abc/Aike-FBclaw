/**
 * 从 order 文件中提取 Cookie 并写入 Chromium 用户数据目录
 */
import * as fs from 'fs';
import * as path from 'path';
import { getBrowserManager } from '../core/browser/profile-manager.js';
import { chromium } from 'playwright-core';

const DOWNLOADS = 'C:/Users/UR/Downloads';

// 解析所有 order 文件中的账号和 Cookie
function parseCookies(): Map<string, any[]> {
  const files = fs.readdirSync(DOWNLOADS).filter(f => f.startsWith('order') && f.endsWith('.txt'));
  const map = new Map<string, any[]>();

  for (const file of files) {
    const content = fs.readFileSync(path.join(DOWNLOADS, file), 'utf-8').replace(/^\uFEFF/, '');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');

      if (parts.length >= 5) {
        // Tab 格式: email pass 2fa _ cookie
        const cookieStr = parts[4]?.trim();
        if (cookieStr && cookieStr.includes('c_user=')) {
          const email = parts[0].trim();
          const cookies = parseCookieString(cookieStr);
          if (cookies.length > 0) map.set(email, cookies);
        }
        continue;
      }

      if (line.includes('|')) {
        const p = line.split('|');
        // 找 email
        const emails = p.filter(x => x.includes('@'));
        const email = emails[0]?.trim();
        if (!email) continue;

        // 找 cookie (包含 c_user= 的字段)
        const cookieField = p.find(x => x.includes('c_user='));
        if (cookieField) {
          const cookies = parseCookieString(cookieField);
          if (cookies.length > 0) map.set(email, cookies);
        }
      }
    }
  }
  return map;
}

function parseCookieString(str: string): any[] {
  const cookies: any[] = [];
  const pairs = str.split(';');
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const name = pair.substring(0, eq).trim();
      const value = pair.substring(eq + 1).trim();
      if (name && value) {
        cookies.push({
          name, value,
          domain: '.facebook.com',
          path: '/',
          httpOnly: ['xs','fr','datr','sb'].includes(name),
          secure: true,
          sameSite: 'None' as const,
        });
      }
    }
  }
  // 至少要有 c_user 才有效
  return cookies.some(c => c.name === 'c_user') ? cookies : [];
}

async function main() {
  const cookieMap = parseCookies();
  console.log(`提取到 ${cookieMap.size} 个账号的 Cookie`);

  const profiles = getBrowserManager().getAllProfiles();
  console.log(`系统中有 ${profiles.length} 个 Profile`);

  let injected = 0;
  for (const profile of profiles) {
    // 尝试匹配 email 或名称
    let cookies = cookieMap.get(profile.name);
    if (!cookies) {
      // 模糊匹配：profile.name 是邮箱前缀
      for (const [email, c] of cookieMap) {
        if (email.includes(profile.name) || profile.name.includes(email)) {
          cookies = c;
          break;
        }
      }
    }

    if (cookies && cookies.length > 0) {
      try {
        // 用 Playwright 打开浏览器，注入 Cookie
        const context = await chromium.launchPersistentContext(profile.dataDir, {
          headless: true,
          args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        });
        await context.addCookies(cookies);
        await context.close();
        console.log(`  ✅ ${profile.name}: 已注入 ${cookies.length} 个 Cookie`);
        injected++;
      } catch (e: any) {
        console.log(`  ❌ ${profile.name}: ${e.message}`);
      }
    }
  }

  console.log(`\n完成: ${injected}/${profiles.length} 个账号已注入 Cookie`);
}

main().catch(console.error);
