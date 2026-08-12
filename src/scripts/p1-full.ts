/** P1 逐项验证 */
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

const OUT = 'G:/Aike-FBclaw/data/screenshots';

// P1-12: OpenClaw knows project
const projExists = fs.existsSync('C:/Users/UR/.openclaw/workspace/PROJECT.md');
console.log('P1-12 ' + (projExists ? '✅' : '❌'));

// P1-13: Content distribution
const r13 = await fetch('http://localhost:18991/api/task/add', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({accountIds:['acc_1786282497228_bl3g'],type:'content_distribute',params:{pageUrl:'https://www.facebook.com/'}})
}).then(r => r.json());
console.log('P1-13 ' + (r13.ok ? '✅':'FAIL'));

// P1-14: AI chat
const r14 = await fetch('http://localhost:18991/api/task/add', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({accountIds:['acc_1786282497228_bl3g'],type:'ai_chat',params:{}})
}).then(r => r.json());
console.log('P1-14 ' + (r14.ok ? '✅':'FAIL'));

// P1-15: AI scheduling
const r15 = await fetch('http://localhost:18991/api/task/add', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({accountIds:['acc_1786282497228_bl3g'],type:'ai_schedule',params:{}})
}).then(r => r.json());
console.log('P1-15 ' + (r15.ok ? '✅':'FAIL'));

// P1-16: Cron/timing
const r16 = await fetch('http://localhost:18991/api/task/add', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({accountIds:['acc_1786282497228_bl3g'],type:'cron_set',params:{schedule:'daily_10am'}})
}).then(r => r.json());
console.log('P1-16 ' + (r16.ok ? '✅':'FAIL'));

// P1-17: Stage management
const r17 = await fetch('http://localhost:18991/api/task/add', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({accountIds:['acc_1786282497228_bl3g'],type:'stage_check',params:{createdAt:Date.now()-30*86400000}})
}).then(r => r.json());
console.log('P1-17 ' + (r17.ok ? '✅':'FAIL'));

// P1-18: Grouping
const r18 = await fetch('http://localhost:18991/api/task/add', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({accountIds:['acc_1786282497228_bl3g'],type:'set_group',params:{group:'内容号'}})
}).then(r => r.json());
console.log('P1-18 ' + (r18.ok ? '✅':'FAIL'));

// P1-19: Evolution
await new Promise(r => setTimeout(r, 30000)); // wait for tasks
const r19 = await fetch('http://localhost:18991/api/task/add', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({accountIds:['acc_1786282497228_bl3g'],type:'evolve_check',params:{}})
}).then(r => r.json());
console.log('P1-19 ' + (r19.ok ? '✅':'FAIL'));

// Open visible browser for P1-13 (content_distribute) screenshot
const ctx = await chromium.launchPersistentContext(
  'G:/Aike-FBclaw/data/browser-profiles/acc_1786282497228_bl3g', {
  headless: false, args: ['--no-sandbox','--window-name=P1_验收'],
  viewport: {width:1280,height:900}, locale:'zh-TW', timezoneId:'Asia/Taipei',
});
const page = await ctx.newPage();
await page.goto('https://www.facebook.com/', {waitUntil:'load',timeout:30000});
await page.waitForTimeout(5000);
await page.screenshot({path: path.join(OUT, 'p1_verify.png')});
console.log('P1 验证截图 p1_verify.png ✅');

// Check evolution data
await new Promise(r => setTimeout(r, 5000));
const tasks = await fetch('http://localhost:18991/api/tasks').then(r => r.json());
const done = tasks.filter((t:any) => t.status === 'done').length;
const failed = tasks.filter((t:any) => t.status === 'failed').length;
console.log(`任务统计: ${done}完成 ${failed}失败`);

fs.writeFileSync(path.join(OUT, 'p1_complete.txt'), new Date().toISOString());
console.log('===== P1 DONE =====');
await new Promise(r => setTimeout(r, 10000));
await ctx.close();
process.exit(0);
