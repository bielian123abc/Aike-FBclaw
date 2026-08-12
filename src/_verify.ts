/**
 * 端到端驗證腳本：
 * 1. 啟動 API server（在子進程）
 * 2. 用 HTTP API + AI 對話兩種方式跑完所有核心功能
 * 3. 驗證 Mock FB 狀態副作用
 * 4. 輸出驗證報告
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { API_PORT, FB_BASE } from './config';

const REPORT_FILE = 'data/verification-report.json';

async function api(method: string, path: string, body?: any) {
  const res = await fetch(`http://localhost:${API_PORT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function waitForServer(maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`http://localhost:${API_PORT}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('server 啟動超時');
}

async function run() {
  console.log('[Verify] 啟動 server...');
  const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    cwd: 'G:/Aike-FBclaw',
    stdio: 'pipe',
    env: { ...process.env, HEADLESS: '1' },
  });
  server.stderr.on('data', d => console.log('[Server]', d.toString().trim()));

  await waitForServer();
  console.log('[Verify] server 就緒');

  const report: any = { startAt: new Date().toISOString(), tasks: [], chat: [] };

  // 初始化帳號
  await api('POST', '/api/accounts', {
    accountId: 'verify1@mock.local', name: '驗證一號', email: 'verify1@mock.local',
    password: 'verify1234', stage: 'new', status: 'offline',
    createdAt: Date.now(),
  });

  const accountId = 'verify1@mock.local';

  // 預先啟動 session
  console.log('[Verify] 啟動 session');
  await api('POST', `/api/account/${encodeURIComponent(accountId)}/launch`);

  const tasks = [
    { type: 'login', params: {}, desc: '登入' },
    { type: 'sync', params: {}, desc: '同步狀態' },
    { type: 'browse_feed', params: { scrollCount: 2, likeProbability: 0, duration: 4000 }, desc: '瀏覽動態' },
    { type: 'like_post', params: {}, desc: '點讚帖子' },
    { type: 'add_friends', params: { mode: 'recommendations', count: 2 }, desc: '加好友' },
    { type: 'greet_new_friends', params: {}, desc: '問候新友' },
    { type: 'ai_chat_reply', params: {}, desc: 'AI 回覆訊息' },
    { type: 'join_groups', params: {}, desc: '加入社團' },
    { type: 'create_post', params: { content: '今天測試一下自動發文功能 📦' }, desc: '發布貼文' },
    { type: 'auto_like_own_page', params: {}, desc: '自動讚主頁' },
    { type: 'risk_check', params: {}, desc: '風控檢查' },
  ];

  for (const t of tasks) {
    console.log(`[Verify] API 任務: ${t.desc}`);
    const r = await api('POST', '/api/task/run', { accountId, type: t.type, params: t.params });
    report.tasks.push({ mode: 'api', ...t, status: r.status, result: r.json });
    if (!r.json.success) console.log(`  ⚠️ ${t.desc} 失敗:`, JSON.stringify(r.json.error || r.json).slice(0, 200));
    else console.log(`  ✅ ${t.desc} 成功`);
  }

  // AI 對話發布任務
  const chatMessages = [
    '幫我加兩個好友',
    '回覆未讀訊息',
    '發一則貼文',
    '幫我同步狀態',
    '檢查風控',
  ];
  for (const msg of chatMessages) {
    console.log(`[Verify] AI 對話: ${msg}`);
    const r = await api('POST', '/api/chat', { accountId, message: msg });
    report.chat.push({ message: msg, status: r.status, result: r.json });
    if (r.json.success) console.log(`  ✅ AI 執行 ${r.json.intent?.type}`);
    else console.log(`  ⚠️ AI 失敗:`, JSON.stringify(r.json).slice(0, 200));
  }

  // 驗證 Mock FB 狀態副作用
  const mockBefore = report.tasks.find((t: any) => t.type === 'login')?.result?.result?.success ? 'logged-in' : 'unknown';
  const mockStateRes = await api('GET', '/api/mock/state');
  report.mockState = mockStateRes.json.mockState;

  // 截圖
  await api('POST', `/api/account/${encodeURIComponent(accountId)}/screenshot`, { suffix: 'verify_final' });

  // 關閉 session
  await api('POST', `/api/account/${encodeURIComponent(accountId)}/close`);

  report.endAt = new Date().toISOString();
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`[Verify] 報告已寫入 ${REPORT_FILE}`);

  server.kill('SIGTERM');
  setTimeout(() => server.kill('SIGKILL'), 3000);
  process.exit(0);
}

run().catch(e => { console.error('[Verify] 失敗', e); process.exit(1); });
