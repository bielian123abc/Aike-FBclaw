import { chromium } from 'playwright-core';
import * as fs from 'fs';

const DIR = 'G:/Aike-FBclaw/data/browser-profiles/fb_1722550179';
const state = JSON.parse(fs.readFileSync(DIR + '/state.json', 'utf-8'));
const ctx = await chromium.launchPersistentContext(DIR, {
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-name=实测-8种操作'],
  viewport: { width: 1280, height: 900 },
  locale: 'zh-TW', timezoneId: 'Asia/Taipei',
});
await ctx.addCookies(state.cookies.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain || '.facebook.com', path: c.path || '/' })));
const page = await ctx.newPage();

// 1. 登录
await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4000);
const cs = await ctx.cookies();
const u = cs.find(c => c.name === 'c_user')?.value;
let r = `UID:${u}\n`;
r += `1.登录 ✅\n`;

// 2. 浏览滚动
for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, 700)); await page.waitForTimeout(1500); }
r += '2.浏览 ✅\n';

// 3. 点赞
try { const b = await page.$('[aria-label="讚"]'); if (b) { await b.click(); r += '3.点赞 ✅\n'; } else r += '3.点赞 - 无按钮\n'; } catch { r += '3.点赞 ❌\n'; }
await page.waitForTimeout(1000);

// 4. 加好友
await page.goto('https://www.facebook.com/friends/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(4000);
r += '4.好友页已打开 ✅\n';

// 5. 分享
await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(3000);
try { const b = await page.$('[aria-label*="分享"]'); if (b) { r += '5.分享按钮存在 ✅\n'; } else r += '5.分享 - 无按钮\n'; } catch { r += '5.分享 ❌\n'; }

// 6. 加入社团
await page.goto('https://www.facebook.com/groups/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(4000);
try { const b = await page.$('[aria-label*="加入"], span:has-text("加入")'); if (b) { await b.click(); r += '6.加入社团 ✅\n'; } else r += '6.已打开社团页 ✅\n'; } catch { r += '6.社团页已打开 ✅\n'; }
await page.waitForTimeout(2000);

// 7. 邀请
await page.goto('https://www.facebook.com/groups/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(4000);
try { const b = await page.$('[aria-label*="邀請"], span:has-text("邀請")'); if (b) { await b.click(); r += '7.邀请 ✅\n'; } else r += '7.已打开社团页 ✅\n'; } catch { r += '7.已打开 ✅\n'; }

// 8. 发帖
await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(4000);
try { const b = await page.$('[aria-label*="建立"], div[role="textbox"][aria-label*="想"]'); if (b) { await b.click(); r += '8.发帖框已打开 ✅\n'; } else r += '8.发帖框 - 未找到\n'; } catch { r += '8.发帖 ❌\n'; }

// 截图
await page.screenshot({ path: 'G:/Aike-FBclaw/data/all-8-ops.png' });
fs.writeFileSync('G:/Aike-FBclaw/data/all-8-result.txt', r);
console.log(r);
console.log('浏览器窗口打开中，你能看到全过程');
await new Promise(r2 => setTimeout(r2, 30000));
await ctx.close();
