/** 剩余好号批量操作测试 + 截图 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'G:/Aike-FBclaw/data/browser-profiles';
const R = JSON.parse(fs.readFileSync('G:/Aike-FBclaw/data/account-report.json', 'utf-8'));
const good = R.results.filter((r: any) => r.status === 'ok');
console.log('好账号:', good.length);

async function opsTest(profileDir: string, idx: number) {
  const state = JSON.parse(fs.readFileSync(path.join(profileDir, 'state.json'), 'utf-8'));
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    args: [`--proxy-server=http://127.0.0.1:${11080+idx}`, '--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
  });
  await ctx.addCookies(state.cookies.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain || '.facebook.com', path: c.path || '/' })));
  const page = await ctx.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(4000);
  
  const name = path.basename(profileDir);
  const ops: string[] = [];
  
  // 浏览
  for (let i=0; i<3; i++) { await page.evaluate(() => window.scrollBy(0, 700)); await page.waitForTimeout(1500); }
  ops.push('浏览首页 ✅');
  
  // 点赞
  try {
    const btn = await page.$('[aria-label="讚"], [aria-label*="赞"], div[role="button"][aria-label*="讚"]');
    if (btn) { await btn.click(); await page.waitForTimeout(1500); ops.push('点赞 ✅'); }
    else ops.push('点赞 ⚠️ 无按钮');
  } catch { ops.push('点赞 ❌'); }
  
  // 截图
  const ss = `G:/Aike-FBclaw/data/screenshots/${name}_ops.png`;
  await page.screenshot({ path: ss });
  
  // 输出
  const cUser = (await ctx.cookies()).find(c => c.name === 'c_user');
  console.log(`${idx+1}. ${name.slice(0,30)} | UID:${cUser?.value} | ${ops.join(' | ')} | ${ss}`);
  
  await ctx.close();
}

async function main() {
  for (let i = 1; i < good.length; i++) { // 跳过第一个（已经开可见窗口了）
    const dir = path.join(BASE, good[i].profile);
    if (!fs.existsSync(dir)) continue;
    await opsTest(dir, i);
    await new Promise(r => setTimeout(r, 2000));
  }
  process.exit(0);
}
main();
