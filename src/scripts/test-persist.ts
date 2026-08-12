import { chromium } from 'playwright-core';
import * as fs from 'fs';

// 从 order-WUU6C4V339TH.txt 第一行取一个账号测试
// UID=61591650163294, pass=yeamin15, cookie有c_user

const PROFILE = 'G:/Aike-FBclaw/data/test-persist';
fs.mkdirSync(PROFILE, { recursive: true });

const cookieStr = 'datr=xD5XaiG7512E4KvxZXKPfiKK;sb=xD5XalqhsftHDeD8Rpekk19S;c_user=61591650163294;fr=0n5lWX7XE9lXKZ7q0.AWdqJsGEOPDru9HzpdwxDENT5iV5zRWIZ6OpghNEKkCsPKq9I0k.BqVz7E..AAA.0.0.BqVz7K.AWck9Sw5cSLnwPE4wLtw1Xscbbw;xs=11%3AlWAE5Q9sPgSPEA%3A2%3A1784102603%3A-1%3A-1';

const cookies = cookieStr.split(';').filter(s => s.includes('=')).map(s => {
  const eq = s.indexOf('=');
  return {
    name: s.substring(0, eq).trim(),
    value: s.substring(eq + 1).trim(),
    domain: '.facebook.com',
    path: '/',
    httpOnly: ['xs', 'fr', 'datr', 'sb'].includes(s.substring(0, eq).trim()),
    secure: true,
    sameSite: 'None' as const,
  };
});

console.log('注入前cookies:', cookies.map(c => c.name + '=' + c.value.slice(0, 10)).join(', '));

// 方法1: 使用 storageState
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  args: ['--no-sandbox'],
});
console.log('Context opened');

// 先设置cookies
await ctx.addCookies(cookies);
console.log('Cookies added to context');

// 验证内存中有
let check = await ctx.cookies();
console.log('内存中: ' + check.length + '个, c_user=' + (check.some(c => c.name === 'c_user') ? '✅' : '❌'));

// 保存到文件
const statePath = PROFILE + '/state.json';
await ctx.storageState({ path: statePath });
console.log('storageState 保存到:', statePath);

// 关闭context
await ctx.close();
await new Promise(r => setTimeout(r, 2000));
console.log('Context closed, waiting 2s...\n');

// 方法2: 使用 storageState 选项重新加载
console.log('Reopening with storageState...');
const ctx2 = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  args: ['--no-sandbox'],
});
const check2 = await ctx2.cookies();
console.log('重开后内存: ' + check2.length + '个');
check2.forEach(c => console.log('  ' + c.name + '=' + c.value.slice(0, 20)));

const hasPersist = check2.some(c => c.name === 'c_user');
console.log('c_user: ' + (hasPersist ? '✅ 已持久化！' : '❌ 未持久化'));

// 测试FB
if (hasPersist) {
  const page = await ctx2.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);
  const url = page.url();
  const title = await page.title();
  console.log('FB URL:', url.slice(0, 60));
  console.log('FB Title:', title);
  const loginForm = await page.$('input[name="email"]');
  console.log('登录表单: ' + (loginForm ? '存在（未登录）' : '无（已登录）'));
}

await ctx2.close();
