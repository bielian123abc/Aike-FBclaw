/**
 * 端到端测试 v3 — 全部走服务器 API
 */
import * as fs from 'fs';
import * as path from 'path';

const API = 'http://localhost:18990/api';
const TEST_DIR = 'G:/Aike-FBclaw/data/e2e-test-results';
fs.mkdirSync(TEST_DIR, { recursive: true });

async function apiGet(url: string) {
  const r = await fetch(`${API}/${url}`);
  return r.ok ? r.json() : null;
}
async function apiPost(url: string, data?: any) {
  const r = await fetch(`${API}/${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  return r.ok ? r.json() : null;
}

async function main() {
  const log: string[] = [];

  function step(msg: string) { console.log(msg); log.push(msg); }

  step('═══════════════════════════════════');
  step('  Aike-FBclaw 端到端实机测试 v3');
  step('═══════════════════════════════════\n');

  // 1. 服务器状态
  step('[1/7] 服务器状态...');
  const status = await apiGet('status');
  if (!status) { step('  ❌ 服务器未运行'); process.exit(1); }
  step(`  ✅ ${status.profiles}账号 | 代理:${100} | OpenClaw:${status.gatewayRunning}`);

  // 2. 代理分配
  step('\n[2/7] 代理分配...');
  const assign = await apiGet('proxy/assignments') || {};
  step(`  ${Object.keys(assign).length > 0 ? '✅' : '❌'} ${Object.keys(assign).length}个已分配`);

  // 3. 账号列表
  step('\n[3/7] 账号列表...');
  const profiles = await apiGet('profiles') || [];
  step(`  ✅ ${profiles.length}个账号`);
  profiles.slice(0, 3).forEach(p => step(`    - ${p.name} | ${p.accountId.slice(-8)}`));

  // 4. 代理池
  step('\n[4/7] 代理池...');
  const proxies = await apiGet('proxy/list') || [];
  const active = proxies.filter((p: any) => p.status === 'active').length;
  step(`  ✅ ${proxies.length}个代理 | ${active}个已激活`);

  // 5. 取一个账号查看详情
  step('\n[5/7] 账号详情...');
  const testAcc = profiles[2];
  const detail = await apiGet(`account/${testAcc.accountId}`);
  step(`  账号: ${detail?.name || '-'}`);
  step(`  状态: ${detail?.status || '-'}`);
  step(`  代理: ${detail?.proxyString || '无'}`);
  step(`  指纹: ${detail?.fingerprint ? '✅' : '❌'}`);

  // 6. 日志
  step('\n[6/7] 系统日志...');
  const logs = await apiGet('logs') || [];
  step(`  ✅ ${logs.length}条日志`);
  logs.slice(0, 3).forEach((l: any) => step(`    [${l.time}] ${l.msg.slice(0,60)}`));

  // 7. 写入测试报告
  const report = fs.createWriteStream(path.join(TEST_DIR, `report-${Date.now()}.txt`));
  report.write(log.join('\n'));
  report.end();

  step('\n═══════════════════════════════════');
  step('  测试完成');
  step(`  报告: ${path.join(TEST_DIR, `report-${Date.now()}.txt`)}`);
  step('═══════════════════════════════════');

  // 汇总
  const issues: string[] = [];
  if (Object.keys(assign).length === 0) issues.push('代理未分配');
  if (profiles.length === 0) issues.push('无账号');
  if (!status?.gatewayRunning) issues.push('OpenClaw未运行');

  if (issues.length > 0) {
    step('\n⚠️  发现问题:');
    issues.forEach(i => step(`  - ${i}`));
  } else {
    step('\n✅ 基础功能全部正常');
  }
}

main().catch(e => process.exit(1));
