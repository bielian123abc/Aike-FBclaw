/**
 * 验证 storageState 加载是否有效
 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';

const DIR = 'G:/Aike-FBclaw/data/browser-profiles/fb_50163294';

// 检查storage state文件
const statePath = DIR + '/fb-state.json';
if (!fs.existsSync(statePath)) {
  console.log('state文件不存在');
  process.exit(1);
}

console.log('State文件大小:', fs.statSync(statePath).size, 'B');
const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
console.log('cookies数:', state.cookies?.length || 0);
if (state.cookies) {
  state.cookies.slice(0, 3).forEach((c: any) => console.log('  ' + c.name + '=' + c.value.slice(0, 20)));
}

// 现在用storageState启动
console.log('\n使用storageState启动headless...');
const ctx = await chromium.launchPersistentContext(DIR, {
  headless: true,
  args: ['--no-sandbox'],
  // ❗关键：通过storageState加载
});
const cookies = await ctx.cookies();
console.log('headless cookies:', cookies.length);
const hasCUser = cookies.some((c: any) => c.name === 'c_user');
console.log('has c_user:', hasCUser);

// 尝试直接用setCookie重新设置
if (!hasCUser) {
  console.log('\n手动重新设置cookies...');
  await ctx.addCookies(state.cookies);
  const verify = await ctx.cookies();
  console.log('重新设置后:', verify.length, 'has c_user:', verify.some((c: any) => c.name === 'c_user'));
}

await ctx.close();
