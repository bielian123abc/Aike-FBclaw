/** 从面板API触发 → 真实执行 → 拿回执 */
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'G:/Aike-FBclaw/data/browser-profiles';

// 找到好号目录
const good = ['fb_1472867526', 'fb_1722550179', 'fb_jakenyacfaulkner1_hotmail_com', 'fb_ninja_drache6956_do0_imgui_de']
  .filter(d => fs.existsSync(path.join(BASE, d, 'state.json')));

console.log(`好号: ${good.length}个\n`);

// 模拟面板"浏览首页"按钮点击
for (const dir of good) {
  console.log(`触发任务: ${dir}`);
  const resp = await fetch('http://localhost:18990/api/task/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountIds: [dir], type: 'browse_home', params: {} }),
  });
  const r = await resp.json();
  console.log(`  任务ID: ${r.taskIds?.[0]?.slice(-8)}`);
  await new Promise(r2 => setTimeout(r2, 3000));
}

// 等所有任务执行完
await new Promise(r2 => setTimeout(r2, 15000));

// 检查结果
console.log('\n═══════════════════');
const tasks = await (await fetch('http://localhost:18990/api/tasks')).json();
const logs = await (await fetch('http://localhost:18990/api/logs')).json();

console.log('任务结果:');
tasks.slice(0, 5).forEach(t => console.log(`  ${t.type} → ${t.status} | ${t.result || ''}`));

console.log('\n操作日志:');
logs.slice(0, 5).forEach(l => console.log(`  [${l.time}] ${l.msg}`));

process.exit(0);
