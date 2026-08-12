/**
 * Aike-FBclaw — 新版 HTTP API Server
 *
 * 設計原則：
 * 1. 乾淨、單一職責：只負責 HTTP API + 任務派發
 * 2. 所有敏感資訊走 config.ts / .env
 * 3. 任務執行全部交給 task-runner.ts
 * 4. AI 對話 → intent-parser.ts → 任務
 */

// ---------- 全局防護罩：長期執行的桌面服務，任何偶發未捕獲錯誤都只記錄、不崩潰 ----------
process.on('uncaughtException', (err) => {
  try { console.error('[uncaughtException]', err && (err as Error).message, (err as Error).stack || ''); } catch {}
});
process.on('unhandledRejection', (reason) => {
  try { console.error('[unhandledRejection]', reason && (reason as any).message ? (reason as any).message : String(reason)); } catch {}
});

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn } from 'child_process';
import { URL, fileURLToPath } from 'url';
import * as XLSX from 'xlsx';
import { API_PORT, MOCK_FB, MOCK_FB_PORT, FB_BASE, DATA_DIR, SCREENSHOT_DIR, PROFILES_DIR, AVATAR_INBOX_DIR } from './config';
import { startMockFB } from './mock-facebook/server';
import { ensureAccountDefaults, listAccounts, getAccount, createAccount, updateAccount, deleteAccount, createAccountsBatch, type Account } from './core/account-store';
import { fingerprintFilePath } from './core/browser/fingerprint';
import { runTask, ensureSession, listContent, saveContent, loadContent, deleteContent, closeAllSessions, getMemory } from './core/engine/task-runner';
import { parseIntent, parseIntentWithLLM } from './core/engine/intent-parser';
import { runAgentChat } from './core/openclaw/agent-loop';
import { generatePostContent } from './core/provider/ai-provider';
import { closeSession, getSession, screenshot, persistSession, getActiveSessionCount, detectExitIp, launchSession, attachDemoToSession } from './core/browser/session-manager';
import { isRecording, setRecording, getEvents, clearEvents, flush } from './core/browser/demo-recorder';
import { getSystemProfile, getLiveResources } from './core/system/system-profiler';
import { getResourceLoad } from './core/system/resource-allocator';
import { retileAllSessions, getLastRetileBounds, startAutoRetile, stopAutoRetile, setAutoRetileEnabled, isAutoRetileEnabled, isAutoRetileRunning } from './core/browser/session-manager';
import { getFingerprintEngine } from './core/browser/fingerprint';
import { startWarmupScheduler, stopWarmupScheduler, runWarmupCycle } from './core/scheduler/warmup-scheduler';
import { analyzeAndEvolve, getEvolutionParams } from './core/evolution/self-evolution';
import { getProjectBrief } from './core/agent/openclaw-context';
import { getProxyManager } from './core/proxy/proxy-manager';
import { getSourcesManager } from './core/browser/sources';
import { getRecentLogs, installConsoleCapture } from './core/logger';
import { startMonitor, stopMonitor, getMonitorSnapshot, getSnapshotHistory } from './core/monitor/monitor';
import {
  startAgentAutoSupervise,
  stopAgentAutoSupervise,
  getAgentHealth,
  getLatestSuperviseReport,
  runAgentSuperviseNow,
} from './core/agent/agent-monitor';
import { getSkills, getSkill, setSkillEnabled } from './core/openclaw/skill-registry';
import { getShardSummaries, getGlobalKnowledge, summarizeContext } from './core/openclaw/memory-service';
import { getRecentEvents, getPerception, emitAppEvent } from './core/openclaw/event-bus';
import { startPassiveMonitor, stopPassiveMonitor, isPassiveMonitorRunning } from './core/openclaw/passive-monitor';
import { startSessionWatchdog, stopSessionWatchdog, isWatchdogRunning, getAllWatchdogViews } from './core/agent/session-watchdog';
import { getOpenClawSettings, saveOpenClawSettings, repairGatewayConfig, diagnoseGatewayConfig } from './core/openclaw/openclaw-config';
import { getGlobalGroupEntries, getCrossAccountOverlap } from './core/group-registry';
import { getAvatarStats, listInboxAvatars, markAvatarUsed, accountHasAvatar, saveUploadedAvatar } from './core/avatar';
import { skillSetAvatar } from './skills/fb-core-skills';
import { gatewayReachable } from './core/openclaw/engine';

// ---------- 啟動 Mock FB（若啟用） ----------
if (MOCK_FB) {
  startMockFB(MOCK_FB_PORT);
  console.log(`[MockFB] 已啟動: ${FB_BASE}`);
}

// ---------- 初始化社团 & 公共主页数据源（用户已提供的初始来源） ----------
getSourcesManager().ensureSeed([
  { type: 'page',  url: 'https://www.facebook.com/profile.php?id=61580739204271', name: '公共主页 #1' },
  { type: 'group', url: 'https://www.facebook.com/groups/1009250201890464', name: '社团 #1' },
]);

// ---------- 簡易日誌 ----------
function log(kind: string, msg: string) {
  console.log(`[${kind}] ${msg}`);
}

// ---------- 账号导入 / 清理 辅助 ----------
/** 解析 FB Cookie 字符串（k=v; k2=v2）为 name/value 列表 */
function parseFbCookieString(str: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  if (!str) return out;
  for (const part of str.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    out.push({ name, value });
  }
  return out;
}

/** 将 FB Cookie 字符串写入账号浏览器档案的 state.json，供启动环境时还原登录态 */
function writeAccountCookiesState(accountId: string, cookieStr: string): boolean {
  try {
    const pairs = parseFbCookieString(cookieStr);
    if (!pairs.length) return false;
    const dir = path.join(PROFILES_DIR, accountId);
    fs.mkdirSync(dir, { recursive: true });
    const cookies = pairs.map(p => ({
      name: p.name, value: p.value,
      domain: '.facebook.com', path: '/',
      expires: -1, httpOnly: false, secure: true, sameSite: 'Lax',
    }));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ cookies, origins: [] }, null, 2));
    return true;
  } catch (e: any) {
    console.warn('[Import] 寫入Cookie state失敗:', accountId, e.message);
    return false;
  }
}

/** 删除账号时清理本地档案：浏览器档案、指纹、记忆碎片、Cookie 備份 */
function cleanupAccountLocal(accountId: string) {
  try {
    const profDir = path.join(PROFILES_DIR, accountId);
    if (fs.existsSync(profDir)) fs.rmSync(profDir, { recursive: true, force: true });
    const fpFile = fingerprintFilePath(accountId);
    if (fs.existsSync(fpFile)) fs.unlinkSync(fpFile);
    const memDir = path.join(DATA_DIR, 'accounts', accountId);
    if (fs.existsSync(memDir)) fs.rmSync(memDir, { recursive: true, force: true });
    const bakDir = path.join(DATA_DIR, 'cookie-backup', accountId);
    if (fs.existsSync(bakDir)) fs.rmSync(bakDir, { recursive: true, force: true });
    const shardFile = path.join(DATA_DIR, 'memory', 'shards', `${accountId.replace(/[^a-zA-Z0-9_.@-]/g, '_')}.json`);
    if (fs.existsSync(shardFile)) fs.unlinkSync(shardFile);
  } catch (e: any) {
    console.warn('[Delete] 清理本地檔案失敗:', accountId, e.message);
  }
}

// ---------- 任務歷史記錄 ----------
const HISTORY_FILE = path.join(DATA_DIR, 'task-history.json');
function recordHistory(entry: { scope: string; type: string; status: string; detail?: string }) {
  try {
    let arr: any[] = [];
    if (fs.existsSync(HISTORY_FILE)) arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    arr.unshift({ taskId: 'T' + Date.now(), time: new Date().toISOString(), ...entry });
    if (arr.length > 200) arr = arr.slice(0, 200);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr, null, 2));
  } catch {}
}

// ---------- 策略配置 ----------
const POLICY_FILE = path.join(DATA_DIR, 'policy.json');
const DEFAULT_POLICY = {
  dailyInviteLimit: 20,
  dailyShareLimit: 15,
  dailyLikeLimit: 50,
  dailyMsgLimit: 20,
  minDelaySec: 2,
  maxDelaySec: 8,
  dedupInvite: true,
  dedupShare: true,
};
function loadPolicy() {
  try { if (fs.existsSync(POLICY_FILE)) return { ...DEFAULT_POLICY, ...JSON.parse(fs.readFileSync(POLICY_FILE, 'utf-8')) }; } catch {}
  return { ...DEFAULT_POLICY };
}
function savePolicy(p: any) { fs.writeFileSync(POLICY_FILE, JSON.stringify({ ...DEFAULT_POLICY, ...p }, null, 2)); }

// ---------- HTTP 路由 ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const url = new URL(req.url || '/', `http://localhost:${API_PORT}`);
  const method = req.method || 'GET';

  // 上傳頭像：直接讀原始位元組（不走 JSON 解析）
  if (url.pathname === '/api/avatar/upload' && method === 'POST') {
    const buf = await readRawBody(req);
    const fname = decodeURIComponent(String(req.headers['x-filename'] || 'avatar.png'));
    const r = saveUploadedAvatar(buf, fname);
    res.statusCode = r.ok ? 200 : 400;
    res.end(JSON.stringify(r));
    return;
  }

  const body = await readBody(req);

  // Favicon（避免浏览器自动請求產生 404 刷屏）
  if (url.pathname === '/favicon.ico') return { _status: 204 };


  try {
    const result = await route(url, method, body);
    if (result && typeof result === 'object' && result._html) {
      res.statusCode = result._status || 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(result._html);
    } else {
      res.statusCode = result?._status || 200;
      res.end(JSON.stringify(result, null, 2));
    }
  } catch (e: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ success: false, error: e.message }));
  }
});

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

async function route(url: URL, method: string, body: any): Promise<any> {
  const p = url.pathname;
  const proxy = getProxyManager();

  // Health
  if (p === '/api/health') return { success: true, mock: MOCK_FB, fbBase: FB_BASE, time: new Date().toISOString() };


  // Accounts
  if (p === '/api/accounts' && method === 'GET') return { success: true, accounts: ensureAccountDefaults() };
  if (p === '/api/accounts' && method === 'POST') {
    const acc = createAccount(body);
    // 新建账号即生成独立指纹环境（与导入一致，确保任意添加途径都准备好指纹）
    try { getFingerprintEngine().loadOrCreate(acc.accountId); } catch (e: any) { console.warn('[Account] 指纹生成失败:', acc.accountId, e.message); }
    return { success: true, account: acc };
  }
  if (p.startsWith('/api/accounts/') && method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/accounts/'.length));
    // 先释放该账号占用的代理槽位，使其轮空等待下次导入补充
    await proxy.unassignProxy(id);
    // 清理本地指纹 / 浏览器档案 / 记忆 / Cookie 備份
    cleanupAccountLocal(id);
    return { success: deleteAccount(id) };
  }

  // 批量导入 xlsx 账号表：A=UID/accountId, B=email/login, C=Cookie 字符串,
  // D=登入密碼(選用), E=2FA 驗證碼(選用，僅儲存)
  // 导入时即：① 写入账号（携带会话 Cookie + 密碼）② 为每个账号生成独立指纹环境 ③ 顺序分配代理
  if (p === '/api/accounts/import-xlsx' && method === 'POST') {
    const fileB64 = body.fileB64;
    if (!fileB64) throw new Error('缺少文件数据');
    const buf = Buffer.from(String(fileB64), 'base64');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
    const toImport: Omit<Account, 'createdAt' | 'status'>[] = [];
    let headerSkipped = 0;
    rows.forEach((row, ri) => {
      const rawUid = String(row[0] ?? '').trim();
      const email = String(row[1] ?? '').trim();
      const cookieStr = String(row[2] ?? '').trim();
      const password = String(row[3] ?? '').trim();   // 選用：D 欄 = 登入密碼
      const twofa = String(row[4] ?? '').trim();       // 選用：E 欄 = 2FA 驗證碼（僅儲存）
      if (!rawUid) return;
      // 跳过疑似表头（首格非数字且含关键字）
      if (ri === 0 && !/^\d+$/.test(rawUid) && /(uid|user|cookie|賬號|账号|account|密碼|密码)/i.test(rawUid)) { headerSkipped++; return; }
      const impTags: string[] = [];
      if (cookieStr) impTags.push('含cookie');
      if (password) impTags.push('含密碼');
      toImport.push({
        accountId: rawUid, name: email || rawUid, email, mode: 'real', stage: 'new',
        cookies: cookieStr || undefined,
        password: password || undefined,
        twofa: twofa || undefined,
        tags: impTags,
      });
    });
    const { created, skipped: dupSkipped } = createAccountsBatch(toImport);
    // 为每个新账号生成指纹 + 还原会话 Cookie
    const fp = getFingerprintEngine();
    let fingerprinted = 0, cookieRestored = 0;
    const newIds: string[] = [];
    for (const acc of created) {
      try { fp.loadOrCreate(acc.accountId); fingerprinted++; } catch (e: any) { console.warn('[Import] 指纹生成失败:', acc.accountId, e.message); }
      if (acc.cookies) { if (writeAccountCookiesState(acc.accountId, acc.cookies)) cookieRestored++; }
      newIds.push(acc.accountId);
    }
    // 顺序分配代理（优先填回被删除账号释放的空闲槽位）
    const proxyAssigned = await proxy.assignSequentially(newIds);
    return {
      success: true,
      totalRows: rows.length,
      created: created.length,
      skipped: dupSkipped.length + headerSkipped,
      duplicates: dupSkipped,
      fingerprinted,
      cookieRestored,
      passwords: created.filter(a => a.password).length,
      twofa: created.filter(a => a.twofa).length,
      proxyAssigned,
      accounts: created.map(a => ({ accountId: a.accountId, name: a.name })),
    };
  }

  // Account single operations
  const accountMatch = p.match(/^\/api\/account\/([^/]+)(?:\/(\w+))?$/);
  if (accountMatch) {
    const accountId = decodeURIComponent(accountMatch[1]);
    const action = accountMatch[2];
    if (method === 'GET' && !action) return { success: true, account: getAccount(accountId) };
    if (method === 'POST' && action === 'launch') {
      const s = await ensureSession(accountId);
      emitAppEvent({ type: 'account.started', accountId, ts: Date.now() });
      // 螺旋代理：開窗後即時檢測當前出口 IP 並寫入賬號狀態
      let exitIp: string | undefined;
      try { exitIp = await detectExitIp(accountId); } catch (e: any) { console.warn('[Launch] 出口IP檢測異常:', e.message); }
      return { success: true, url: s.page.url(), exitIp };
    }
    if (method === 'POST' && action === 'close') {
      await closeSession(accountId, true);
      emitAppEvent({ type: 'account.stopped', accountId, ts: Date.now() });
      return { success: true };
    }
    if (method === 'POST' && action === 'sync') {
      return runTask(accountId, 'sync', body);
    }
    if (method === 'POST' && action === 'screenshot') {
      const ssPath = await screenshot(accountId, body.suffix || 'manual');
      return { success: !!ssPath, path: ssPath };
    }
    if (method === 'POST' && action === 'persist') {
      const statePath = await persistSession(accountId);
      return { success: !!statePath, path: statePath };
    }
    if (method === 'POST' && action === 'update') {
      // 單帳號補/改：密碼、Cookie、email、2FA。Cookie 同步寫入 state.json，
      // 讓「Cookie 失效」或「缺密碼」的帳號不必整表重匯即可修復登入。
      const patch: Partial<Account> = {};
      if (typeof body.password === 'string') patch.password = body.password;
      if (typeof body.twofa === 'string') patch.twofa = body.twofa;
      if (typeof body.email === 'string' && body.email.trim()) patch.email = body.email.trim();
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
      let cookiesWritten = false;
      if (typeof body.cookies === 'string' && body.cookies.trim()) {
        cookiesWritten = writeAccountCookiesState(accountId, body.cookies.trim());
        patch.cookies = body.cookies.trim();
      }
      // 標籤同步：有密碼標「含密碼」，有 Cookie 標「含cookie」
      const acc0 = getAccount(accountId);
      const tags = new Set(acc0?.tags || []);
      if (patch.password) tags.add('含密碼');
      if (patch.cookies) tags.add('含cookie');
      if (patch.password === '' ) tags.delete('含密碼');
      patch.tags = [...tags];
      const updated = updateAccount(accountId, patch);
      if (!updated) throw new Error('帳號不存在: ' + accountId);
      return { success: true, accountId, cookiesWritten, account: updated };
    }
    if (method === 'GET' && action === 'state') {
      const s = getSession(accountId);
      const mem = getMemory(accountId);
      return { success: true, sessionActive: !!s, memorySummary: mem.getMemorySummary() };
    }
  }

  // Task run
  if (p === '/api/task/run' && method === 'POST') {
    const { accountId, accountIds, type, params } = body;
    const ids = accountIds || [accountId];
    if (!ids.length || !type) throw new Error('缺少 accountId(s) 或 type');
    const scope = ids.length === 1 ? ids[0] : `分组(${ids.length}账号)`;
    try {
      if (ids.length === 1) {
        const r = await runTask(ids[0], type, params || {});
        recordHistory({ scope, type, status: r.success ? '完成' : '失败', detail: r.error || '' });
        return r;
      }
      // socialize 自帶帳號池（accountIds），只需執行一次，避免被逐帳號重複跑
      if (type === 'socialize') {
        const r = await runTask(ids[0], 'socialize', { ...params, accountIds: ids });
        recordHistory({ scope, type, status: r.success ? '完成' : '失败', detail: r.error || '' });
        return r;
      }
      const results = [];
      for (const id of ids) results.push(await runTask(id, type, { ...params }));
      const ok = results.filter((r: any) => r && r.success).length;
      recordHistory({ scope, type, status: `${ok}/${ids.length}成功` });
      return { success: true, results };
    } catch (e: any) {
      recordHistory({ scope, type, status: '异常', detail: e.message });
      throw e;
    }
  }

  // AI Chat → 真 OpenClaw 智能體（自由對話 + 工具調度迴圈）
  if (p === '/api/chat' && method === 'POST') {
    const { accountId, message, history } = body;
    if (!accountId || !message) throw new Error('缺少 accountId 或 message');
    const result = await runAgentChat(accountId, message, history || '');
    recordHistory({ scope: accountId, type: 'AI:chat', status: '完成', detail: message.slice(0, 60) });
    return { success: true, reply: result.reply, steps: result.steps, usedTools: result.usedTools };
  }

  // AI generate post
  if (p === '/api/ai/generate-post' && method === 'POST') {
    const text = await generatePostContent({ topic: body.topic || '台灣生活日常' });
    return { success: true, text };
  }

  // Content library
  if (p === '/api/content' && method === 'GET') return { success: true, items: listContent() };
  if (p === '/api/content' && method === 'POST') {
    const id = body.id || `post_${Date.now()}`;
    saveContent(id, { title: body.title || '', text: body.text || '', tags: body.tags || [] });
    return { success: true, id };
  }
  if (p.startsWith('/api/content/') && method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/content/'.length));
    return { success: true, content: loadContent(id) };
  }
  if (p.startsWith('/api/content/') && method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/content/'.length));
    deleteContent(id);
    return { success: true };
  }

  // Distribute content shortcut
  if (p === '/api/distribute' && method === 'POST') {
    return runTask(body.accountIds[0] || body.accountId, 'distribute_content', {
      contentId: body.contentId,
      accountIds: body.accountIds,
      staggerSeconds: body.staggerSeconds ?? 10,
    });
  }

  // Self-evolution (PRD 2.4 核心流程⑥)
  const evoMatch = p.match(/^\/api\/evolution\/([^/]+)$/);
  if (evoMatch && method === 'GET') {
    const id = decodeURIComponent(evoMatch[1]);
    return { success: true, params: analyzeAndEvolve(id) };
  }
  if (p === '/api/evolution' && method === 'GET') {
    return { success: true, params: listAccounts().map(a => getEvolutionParams(a.accountId)) };
  }

  // OpenClaw Agent：项目移交文档（让内置 Agent 知道整个项目）
  if (p === '/api/agent/brief' && method === 'GET') {
    return { success: true, brief: getProjectBrief() };
  }

  // OpenClaw Agent：运营监管 + 进化建议（走自动循环缓存，立即刷新并回傳）
  if (p === '/api/agent/supervise' && method === 'POST') {
    const report = await runAgentSuperviseNow();
    return { success: !!report, report };
  }

  // OpenClaw Agent：健康狀態（LLM 可達 / 最後調用 / 錯誤率 / 自動監管開關）
  if (p === '/api/agent/health' && method === 'GET') {
    return { success: true, health: getAgentHealth(), lastReport: getLatestSuperviseReport() };
  }

  // 全局監控快照
  if (p === '/api/monitor/state' && method === 'GET') {
    return { success: true, snapshot: getMonitorSnapshot() };
  }
  if (p === '/api/monitor/history' && method === 'GET') {
    return { success: true, history: getSnapshotHistory().slice(-30) };
  }
  // 會話看門狗狀態
  if (p === '/api/watchdog/state' && method === 'GET') {
    return { success: true, running: isWatchdogRunning(), views: getAllWatchdogViews() };
  }

  // 服務端整體狀態（供「服務端&模型」頁顯示 + 監管探活）
  if (p === '/api/status' && method === 'GET') {
    const gw = await gatewayReachable();
    // 探測監管啟動器（18992）是否在運行
    const supervisor = await new Promise<any>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: 18992, path: '/status', timeout: 1500 }, (r) => {
        let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(1500, () => { req.destroy(); resolve(null); });
    });
    return {
      success: true,
      serverUp: true,
      gatewayReachable: gw,
      watchdogRunning: isWatchdogRunning(),
      uptimeSec: process.uptime(),
      supervisor: supervisor || { supervisorRunning: false, maintaining: false, serverPid: null, restarts: 0 },
    };
  }

  // ---------- OpenClaw 模型設置 + 一鍵修復 ----------
  if (p === '/api/settings/openclaw' && method === 'GET') {
    return { success: true, settings: getOpenClawSettings(), diagnose: diagnoseGatewayConfig() };
  }
  if (p === '/api/settings/openclaw' && method === 'POST') {
    const r = saveOpenClawSettings(body);
    return { success: r.ok, applied: r.applied, error: r.error, settings: getOpenClawSettings() };
  }
  if (p === '/api/openclaw/repair' && method === 'POST') {
    // 修復流程：先停網關 → 還原安全基線+重注入模型API → 重啟網關
    stopOpenClawGateway();
    await new Promise((r) => setTimeout(r, 800));
    const rep = repairGatewayConfig();
    ensureOpenClawGateway();
    return { success: rep.ok, steps: rep.steps, error: rep.error, gatewayReachable: await gatewayReachable() };
  }

  // ---------- 跨帳號社團總覽 ----------
  if (p === '/api/groups/joined' && method === 'GET') {
    const entries = getGlobalGroupEntries();
    const accounts = ensureAccountDefaults();
    const perAccount = accounts.map((a: any) => ({
      accountId: a.accountId,
      name: a.name,
      joined: (a.joinedGroups || []).length,
      overlap: getCrossAccountOverlap(a.accountId).length,
    }));
    return { success: true, groups: entries, perAccount, total: entries.length };
  }

  // ---------- 頭像資源 ----------
  if (p === '/api/avatar/stats' && method === 'GET') {
    return { success: true, stats: getAvatarStats(), inbox: listInboxAvatars() };
  }
  if (p === '/api/avatar/mark-used' && method === 'POST') {
    // 手動標記某張頭像已用（例如使用者手動上傳過）
    if (!body.filename) throw new Error('缺少 filename');
    const r = markAvatarUsed(body.filename, body.accountId || 'manual');
    return { success: r.ok, ...r };
  }
  if (p === '/api/avatar/apply' && method === 'POST') {
    // 真正替換頭像：把指定（或下一張）頭像上傳到該賬號的 FB 個人檔案
    if (!body.accountId) throw new Error('缺少 accountId');
    const imgPath = body.filename ? path.join(AVATAR_INBOX_DIR, body.filename) : undefined;
    const s = getSession(body.accountId);
    if (!s || !s.page) return { success: false, error: '賬號會話未啟動，請先在該賬號點「啟動」開窗' };
    const r = await skillSetAvatar({ page: s.page, accountId: body.accountId, memory: getMemory(body.accountId) }, { imagePath: imgPath });
    return { success: r.success, action: r.action, data: r.data, error: r.error };
  }

  if (p === '/api/warmup/stop' && method === 'POST') {
    stopWarmupScheduler();
    return { success: true, stopped: true };
  }
  if (p === '/api/warmup/run' && method === 'POST') {
    const id = body.accountId;
    if (!id) throw new Error('缺少 accountId');
    return { success: true, result: await runWarmupCycle(id, { dryRun: !!body.dryRun }) };
  }

  // ---------- 代理池 API ----------
  if (p === '/api/proxy' && method === 'GET') {
    const accounts = ensureAccountDefaults();
    const assignments = proxy.getAssignments();
    return {
      success: true,
      proxies: proxy.getManualProxies().map(px => ({
        ...px,
        boundAccount: accounts.find((a: any) => assignments[a.accountId] === px.id)?.name || '',
      })),
    };
  }
  if (p === '/api/proxy' && method === 'POST') {
    const px = proxy.addManualProxy({
      name: body.name || `${body.host}:${body.port}`,
      type: body.type || 'http',
      host: body.host, port: Number(body.port),
      username: body.username, password: body.password,
      country: body.country || '',
    });
    return { success: true, proxy: px };
  }
  if (p.startsWith('/api/proxy/import') && method === 'POST') {
    const n = proxy.importProxyText(body.text || '');
    return { success: true, added: n };
  }
  if (p === '/api/proxy/test-all' && method === 'POST') {
    const results = await proxy.testAllProxies();
    const ok = results.filter(r => r.alive).length;
    return { success: true, results, ok, total: results.length };
  }
  if (p.startsWith('/api/proxy/test/') && method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/proxy/test/'.length));
    const ok = await proxy.checkManualProxy(id);
    const px = proxy.getManualProxies().find(x => x.id === id);
    return { success: true, alive: ok, latency: px?.latency ?? -1, exitIp: px?.exitIp || '', note: px?.note || '' };
  }
  if (p.startsWith('/api/proxy/') && p.endsWith('/assign') && method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/proxy/'.length, -'/assign'.length));
    await proxy.assignProxy(body.accountId, id);
    return { success: true };
  }
  if (p.startsWith('/api/proxy/') && p.endsWith('/unbind') && method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/proxy/'.length, -'/unbind'.length));
    // 找到绑定此代理的账号并解绑
    const assignments = proxy.getAssignments();
    for (const [accId, pxId] of Object.entries(assignments)) {
      if (pxId === id) await proxy.assignProxy(accId, '');
    }
    return { success: true };
  }
  if (p.startsWith('/api/proxy/') && method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/proxy/'.length));
    proxy.removeManualProxy(id);
    return { success: true };
  }
  if (p === '/api/proxy/auto-assign' && method === 'POST') {
    const accounts = ensureAccountDefaults();
    // 顺序分配：优先填回被删除账号释放的空闲槽位，已有绑定的账号保持不变
    const assigned = await proxy.assignSequentially(accounts.map((a: any) => a.accountId));
    return { success: true, assigned };
  }

  // ---------- 社团 & 公共主页 数据源 API ----------
  const sourcesMgr = getSourcesManager();
  if (p === '/api/sources' && method === 'GET') {
    return { success: true, sources: sourcesMgr.list() };
  }
  if (p === '/api/sources' && method === 'POST') {
    const t = body.type === 'group' ? 'group' : 'page';
    const created = sourcesMgr.add(t, body.url, body.name, body.note);
    return { success: true, source: created };
  }
  if (p.startsWith('/api/sources/') && method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/sources/'.length));
    return { success: sourcesMgr.remove(id) };
  }

  // ---------- 策略配置 API ----------
  if (p === '/api/policy' && method === 'GET') return { success: true, policy: loadPolicy() };
  if (p === '/api/policy' && method === 'POST') { savePolicy(body); return { success: true, policy: loadPolicy() }; }

  // ---------- 任務歷史 API ----------
  if (p === '/api/history' && method === 'GET') {
    try { return { success: true, history: fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')) : [] }; }
    catch { return { success: true, history: [] }; }
  }

  // ---------- 即時日誌 API ----------
  if (p === '/api/logs' && method === 'GET') {
    return { success: true, logs: getRecentLogs(120) };
  }

  // ---------- 系統配置識別 + 資源負載（需求 C / D） ----------
  if (p === '/api/system/profile' && method === 'GET') {
    return {
      success: true,
      profile: getSystemProfile(),
      live: getLiveResources(),
      load: getResourceLoad(getActiveSessionCount()),
    };
  }

  // ---------- 窗口網格重排（需求 B） ----------
  if (p === '/api/windows/retile' && method === 'POST') {
    try {
      await retileAllSessions();
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }
  if (p === '/api/windows/bounds' && method === 'GET') {
    return { success: true, bounds: getLastRetileBounds() };
  }
  if (p === '/api/windows/auto-retile' && method === 'GET') {
    return { success: true, enabled: isAutoRetileEnabled(), running: isAutoRetileRunning() };
  }
  if (p === '/api/windows/auto-retile' && method === 'POST') {
    setAutoRetileEnabled(body?.enabled !== false);
    if (body?.enabled !== false) startAutoRetile(body?.intervalMs || 5000);
    else stopAutoRetile();
    return { success: true, enabled: isAutoRetileEnabled(), running: isAutoRetileRunning() };
  }

  // ---------- 示范学习录制（使用者手動操作 → AI 記錄並完善技能） ----------
  if (p === '/api/demo/start' && method === 'POST') {
    const ids: string[] = Array.isArray(body?.accountIds) ? body.accountIds : [];
    const opened: string[] = [];
    for (const id of ids) {
      setRecording(id, true);
      try {
        if (!getSession(id)) { await launchSession(id); opened.push(id); }
        await attachDemoToSession(id);
      } catch (e: any) {
        console.log(`[demo] 啟動录制失敗 ${id}: ${e.message}`);
      }
    }
    return { success: true, recording: ids, opened };
  }
  if (p === '/api/demo/stop' && method === 'POST') {
    const ids: string[] = Array.isArray(body?.accountIds) ? body.accountIds : [];
    ids.forEach((id: string) => { setRecording(id, false); flush(id); });
    return { success: true, stopped: ids };
  }
  if (p === '/api/demo/events' && method === 'GET') {
    const id = url.searchParams.get('accountId');
    if (!id) return { success: false, error: 'accountId required' };
    const events = getEvents(id);
    return { success: true, accountId: id, recording: isRecording(id), count: events.length, events };
  }
  if (p === '/api/demo/clear' && method === 'POST') {
    const id = body?.accountId;
    if (!id) return { success: false, error: 'accountId required' };
    clearEvents(id);
    return { success: true, cleared: id };
  }

  // Mock FB state
  if (p === '/api/mock/state' && method === 'GET') {
    const mockUrl = `${FB_BASE}/api/mock/state`;
    try {
      const r = await fetch(mockUrl);
      return { success: true, mockState: await r.json() };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  // Static dashboard — 优先读取磁盘上的新版 Command Deck UI
  if ((p === '/' || p === '/dashboard') && method === 'GET') {
    return { _html: loadCommandDeckHtml(), _status: 200 };
  }

  // ---------- OpenClaw 技能中心 API（功能 = 技能，點擊即可調用） ----------
  if (p === '/api/skills' && method === 'GET') {
    return { success: true, skills: getSkills() };
  }
  if (p.startsWith('/api/skills/') && p.endsWith('/toggle') && method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/skills/'.length, -'/toggle'.length));
    const enabled = body.enabled !== false;
    return { success: setSkillEnabled(id, enabled), skill: getSkill(id) };
  }

  // ---------- OpenClaw 记忆体 API（记忆碎片 + 全局知识库） ----------
  if (p === '/api/memory/shards' && method === 'GET') {
    return { success: true, shards: getShardSummaries(), global: getGlobalKnowledge().slice(0, 4000) };
  }
  if (p.startsWith('/api/memory/shard/') && method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/memory/shard/'.length));
    return { success: true, accountId: id, context: summarizeContext(id) };
  }

  // ---------- OpenClaw 实时感知 API（事件总线 + 每账号状态快照） ----------
  if (p === '/api/perception' && method === 'GET') {
    return { success: true, perception: getPerception(), events: getRecentEvents(60) };
  }

  // ---------- 被动接管监控 API（OpenClaw 被動觸發聊天接管） ----------
  if (p === '/api/passive/start' && method === 'POST') {
    startPassiveMonitor(body.intervalMs || 90 * 1000);
    return { success: true, running: isPassiveMonitorRunning() };
  }
  if (p === '/api/passive/stop' && method === 'POST') {
    stopPassiveMonitor();
    return { success: true, running: isPassiveMonitorRunning() };
  }
  if (p === '/api/passive/status' && method === 'GET') {
    return { success: true, running: isPassiveMonitorRunning() };
  }

  return { success: false, error: 'Not found', _status: 404 };
}

// ---------- Dashboard HTML ----------
function resolveUiFile(): string {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // = dist/
    candidates.push(path.join(here, '..', 'ui', 'command-deck.html'));
  } catch {}
  try {
    const cwd = process.cwd();
    candidates.push(path.join(cwd, 'ui', 'command-deck.html'));
    candidates.push(path.join(cwd, '..', 'ui', 'command-deck.html'));
  } catch {}
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return candidates[0];
}
function loadCommandDeckHtml(): string {
  try {
    const f = resolveUiFile();
    return fs.readFileSync(f, 'utf-8');
  } catch (e: any) {
    console.error('[ui] 讀取 command-deck.html 失敗，回退內聯版本：', e && e.message);
    return dashboardHtml();
  }
}
function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>FB多账号自动化工具｜OpenClaw驱动</title>
<style>
* {margin:0;padding:0;box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
body {background:#12141a;color:#e4e7ed;display:flex;height:100vh;overflow:hidden}
.sidebar {width:220px;background:#1a1d26;border-right:1px solid #2c303b;padding-top:20px;overflow:auto}
.sidebar .nav-item {padding:12px 24px;cursor:pointer;color:#a3a6ad;font-size:14px}
.sidebar .nav-item.active {background:#252a36;color:#fff;border-left:3px solid #409eff}
.sidebar .nav-item:hover {background:#222732;color:#fff}
.main-wrap {flex:1;display:flex;flex-direction:column;min-width:0}
.top-bar {height:50px;background:#1a1d26;border-bottom:1px solid #2c303b;display:flex;align-items:center;padding:0 20px;gap:10px;flex-wrap:wrap}
.content {flex:1;overflow:auto;padding:16px;background:#12141a}
.right-log {width:320px;background:#1a1d26;border-left:1px solid #2c303b;display:flex;flex-direction:column}
.log-title {padding:12px 16px;border-bottom:1px solid #2c303b;font-weight:bold;font-size:13px}
.log-box {flex:1;padding:12px;overflow:auto;font-size:12px;color:#99a2b3;line-height:1.6;font-family:monospace}
button {padding:6px 12px;border:none;border-radius:4px;cursor:pointer;font-size:13px}
.btn-primary {background:#409eff;color:#fff}
.btn-success {background:#67c23a;color:#fff}
.btn-warning {background:#e6a23c;color:#000}
.btn-danger {background:#f56c6c;color:#fff}
.btn-dark {background:#303643;color:#fff}
input,textarea,select {background:#222732;border:1px solid #2c303b;color:#fff;border-radius:4px;padding:5px;font-size:13px}
table {width:100%;border-collapse:collapse;margin-top:12px;table-layout:fixed}
th,td {border:1px solid #2c303b;padding:8px 10px;text-align:left;font-size:13px}
th {background:#1e222c}
td {word-break:break-all;vertical-align:top}
tr:hover {background:#181b23}
.card {border:1px solid #2c303b;border-radius:6px;padding:14px;margin-bottom:16px;background:#161921}
.card-title {font-size:15px;margin-bottom:10px;font-weight:bold}
.mask {position:fixed;inset:0;background:rgba(0,0,0,0.6);display:none;align-items:center;justify-content:center;z-index:99}
.modal {width:600px;background:#1a1d26;border:1px solid #2c303b;border-radius:6px;padding:18px}
.func-tag{display:inline-flex;align-items:center;gap:4px;padding:5px 9px;border:1px solid #2c303b;border-radius:4px;background:#222732;margin:4px;font-size:12px;cursor:pointer}
.func-tag.active{border-color:#409eff;background:#2b3a52}
.func-tag.notimpl{opacity:.55}
.func-tag .badge{font-size:10px;color:#e6a23c;border:1px solid #e6a23c;border-radius:3px;padding:0 3px}
.tip-depend{font-size:12px;color:#e6a23c;margin:6px 2px}
.task-layout{display:flex;gap:16px}
.col-left{width:48%}
.col-right{flex:1;min-width:0}
.claw-float-btn{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:#409eff;color:#fff;font-size:24px;box-shadow:0 4px 14px rgba(64,158,255,0.35);z-index:200;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none}
.claw-float-btn:hover{transform:scale(1.08)}
.claw-chat-window{position:fixed;bottom:90px;right:24px;width:420px;height:520px;background:#1a1d26;border:1px solid #2c303b;border-radius:8px;z-index:201;display:none;flex-direction:column;overflow:hidden}
.claw-chat-header{padding:10px 14px;background:#252a36;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #2c303b}
.claw-chat-body{flex:1;padding:12px;overflow:auto;font-size:13px}
.msg-user{background:#2b3a52;padding:8px 10px;border-radius:6px;margin-bottom:8px;max-width:85%;margin-left:auto}
.msg-agent{background:#222732;padding:8px 10px;border-radius:6px;margin-bottom:8px;max-width:85%}
.claw-chat-input-area{padding:10px;border-top:1px solid #2c303b;display:flex;gap:8px}
.claw-chat-input-area textarea{flex:1;resize:none;height:44px}
#toast{position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#252a36;border:1px solid #409eff;color:#fff;padding:8px 16px;border-radius:6px;display:none;z-index:300;font-size:13px}
.filter-input{width:200px}
.card{box-shadow:0 1px 3px rgba(0,0,0,.35);transition:border-color .15s,box-shadow .15s}
.card:hover{border-color:#3a4150}
.card-title{color:#fff;border-left:3px solid #409eff;padding-left:10px}
button{transition:filter .15s ease,transform .04s ease}
button:hover{filter:brightness(1.1)}
button:active{transform:translateY(1px)}
.sidebar .nav-item.active{background:linear-gradient(90deg,#2b3a52,#252a36);color:#fff;border-left:3px solid #409eff}
.top-bar{background:linear-gradient(180deg,#1c202b,#161922)}
body{background:radial-gradient(1200px 600px at 85% -10%,#1b2233 0%,#12141a 55%)}
.func-tag{transition:border-color .15s,background .15s}
.func-tag:hover{border-color:#409eff}
table th{color:#cdd3df;letter-spacing:.3px}
input:focus,textarea:focus,select:focus{outline:none;border-color:#409eff;box-shadow:0 0 0 2px rgba(64,158,255,.25)}
</style>
</head>
<body>
<div id="toast"></div>
<div class="claw-float-btn" onclick="toggleClawChat()">🤖</div>
<div class="claw-chat-window" id="clawChatWin">
  <div class="claw-chat-header">
    <span><strong>OpenClaw Agent 对话助手</strong></span>
    <button class="btn-danger" style="padding:2px 8px;font-size:12px" onclick="doRepair()">🔧 修复</button>
    <button class="btn-dark" onclick="toggleClawChat()">×</button>
  </div>
  <div class="claw-chat-body" id="clawChatBody">
    <div class="msg-agent">OpenClaw Agent 就绪<br>软件自动生成台湾地区适配随机指纹，无需手动配置模板<br>支持单账号智能执行、全部账号智能批量执行</div>
  </div>
  <div class="claw-chat-input-area">
    <textarea id="clawInput" placeholder="和 OpenClaw 智能體對話，或請它操作 FB / 修復軟體..."></textarea>
    <button class="btn-primary" onclick="sendClaw()">发送</button>
  </div>
</div>

<div class="sidebar">
  <div class="nav-item active" data-page="account">账号环境管理</div>
  <div class="nav-item" data-page="proxy">代理池管理</div>
  <div class="nav-item" data-page="task">任务编排编辑器</div>
  <div class="nav-item" data-page="policy">运营策略配置</div>
  <div class="nav-item" data-page="source">社团&主页数据源</div>
  <div class="nav-item" data-page="clawchat">OpenClaw AI对话</div>
  <div class="nav-item" data-page="report">历史任务报告</div>
  <div class="nav-item" data-page="monitor">全局监控</div>
  <div class="nav-item" data-page="server">服务端&模型</div>
  <div class="nav-item" data-page="groups">社团总览</div>
  <div class="nav-item" data-page="avatar">头像管理</div>
  <div class="nav-item" data-page="skills">技能中心</div>
  <div class="nav-item" data-page="memory">记忆体</div>
</div>

<div class="main-wrap">
  <div class="top-bar">
    <button class="btn-dark" onclick="importAccounts()">批量导入账号</button>
    <input type="file" id="accFile" accept=".txt,.csv,.xlsx,.xls" style="display:none" onchange="importAccountsFile(this)">
    <button class="btn-dark" onclick="document.getElementById('accFile').click()">上传账号文件</button>
    <button class="btn-dark" onclick="autoAssignProxy()">批量绑定代理</button>
    <button class="btn-primary" onclick="checkAllAccounts()">检测全部账号状态</button>
    <button class="btn-success" onclick="runAllSmart()">AI执行所有账号</button>
    <button class="btn-warning" onclick="retileWindows()">一键重排窗口</button>
    <button id="autoRetileBtn" class="btn-primary" onclick="toggleAutoRetile()">自动重排：开</button>
    <button class="btn-info" onclick="startDemoRecord()">示范录制(打开窗口+记录)</button>
    <button class="btn-warning" onclick="stopDemoRecord()">停止录制</button>
    <button class="btn-primary" onclick="viewDemoSteps()">查看录制步骤</button>
    <div style="flex:1"></div>
    <input class="filter-input" id="accFilter" placeholder="筛选账号状态/绑定状态" oninput="renderAccFilter()">
  </div>
  <div class="content">
    <div id="page-account" class="page">
      <div class="card card-title">账号列表（软件自动生成台湾专属随机指纹，无需手动配置）</div>
      <table>
        <thead><tr>
          <th style="width:3%"><input type="checkbox" id="accAll" onchange="toggleAll(this.checked)"></th>
          <th style="width:10%">账号备注</th><th style="width:10%">登录标识</th><th style="width:8%">登录类型</th>
          <th style="width:8%">账号状态</th>
          <th style="width:26%">代理/出口IP</th><th style="width:7%">好友总数</th><th style="width:7%">社团总数</th><th style="width:7%">今日任务进度</th><th style="width:14%">操作</th>
        </tr></thead>
        <tbody id="accBody"></tbody>
      </table>
      <div style="margin-top:12px;color:#a3a6ad;font-size:13px">说明：账号启动时自动生成台湾地区适配隔离指纹；单行【智能执行】仅运行当前账号完整智能联动任务</div>
    </div>

    <div id="page-proxy" class="page" style="display:none">
      <div class="card card-title">代理池管理（支持上传proxyList.txt批量导入，重启不丢）</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn-primary" onclick="document.getElementById('proxyFile').click()">上传TXT代理文件</button>
        <input type="file" id="proxyFile" accept=".txt" style="display:none" onchange="importProxyFile(this)">
        <button class="btn-dark" onclick="testAllProxy()">批量连通检测</button>
        <button class="btn-success" onclick="autoAssignProxy()">自动分配至账号</button>
        <button class="btn-warning" onclick="exportProxyMap()">导出账号-代理映射表</button>
      </div>
      <table>
        <thead><tr><th>完整代理地址</th><th>端口</th><th>出口地区</th><th>状态</th><th>延迟</th><th>出口IP</th><th>检测备注</th><th>绑定账号</th><th>操作</th></tr></thead>
        <tbody id="proxyBody"></tbody>
      </table>
    </div>

    <div id="page-task" class="page" style="display:none">
      <div class="card card-title">任务编排编辑器</div>
      <div class="task-layout">
        <div class="col-left">
          <div class="card">
            <div class="card-title">FB功能库</div>
            <div style="margin-bottom:12px">
              <div style="color:#a3a6ad;font-size:13px;margin-bottom:4px">▌日常社交养号</div>
              <span class="func-tag" data-task="browse_feed">FB观看视频随机点赞</span>
              <span class="func-tag" data-task="browse_feed">FB首页浏览随机点赞</span>
              <span class="func-tag" data-task="join_groups">FB搜索、加入台湾本地小组</span>
              <span class="func-tag notimpl" data-task="__notimpl">FB评论指定帖子<span class="badge">未接入</span></span>
              <span class="func-tag" data-task="like_post">FB首页全部点赞</span>
              <span class="func-tag" data-task="create_post">FB发布帖子（生活分享）</span>
              <span class="func-tag" data-task="add_friends">FB添加台湾本地好友（搜索）</span>
              <span class="func-tag" data-task="add_friends_from_group">FB从社团成员加本地好友</span>
              <span class="func-tag" data-task="greet_new_friends">FB通过好友请求并问候</span>
              <span class="func-tag" data-task="get_friends">FB获取好友列表</span>
            </div>
            <div style="margin-bottom:12px">
              <div style="color:#a3a6ad;font-size:13px;margin-bottom:4px">▌社团&主页业务（扩展圈子后期使用）</div>
              <div class="tip-depend">提示：邀请好友进社团 / 点赞主页 / 分享帖子，依赖已加好友与已加入的社团</div>
              <span class="func-tag" data-task="invite_to_group">FB邀请好友加入指定社团</span>
              <span class="func-tag" data-task="invite_to_page">FB邀请好友点赞/访问我的主页</span>
              <span class="func-tag" data-task="share_post">FB分享主页/社团帖子</span>
              <span class="func-tag notimpl" data-task="__notimpl">FB账号创建主页<span class="badge">未接入</span></span>
            </div>
            <div>
              <div style="color:#a3a6ad;font-size:13px;margin-bottom:4px">▌BM广告账号业务（后端待接入）</div>
              <span class="func-tag notimpl" data-task="__notimpl">获取广告账号质量<span class="badge">未接入</span></span>
              <span class="func-tag notimpl" data-task="__notimpl">获取广告账号花费数据<span class="badge">未接入</span></span>
              <span class="func-tag notimpl" data-task="__notimpl">获取全部广告账号信息<span class="badge">未接入</span></span>
              <span class="func-tag notimpl" data-task="__notimpl">获取广告权限Access-Token<span class="badge">未接入</span></span>
              <span class="func-tag notimpl" data-task="__notimpl">创建BM<span class="badge">未接入</span></span>
              <span class="func-tag notimpl" data-task="__notimpl">BM添加广告账户<span class="badge">未接入</span></span>
              <span class="func-tag notimpl" data-task="__notimpl">授权广告账号<span class="badge">未接入</span></span>
            </div>
            <div style="margin-top:10px"><button class="btn-dark" onclick="clearFunc()">清空全部勾选</button></div>
          </div>
          <div class="card">
            <div class="card-title">账号分组定义</div>
            <div id="groupDef" style="font-size:13px;color:#a3a6ad"></div>
            <button class="btn-primary" style="margin-top:8px" onclick="toast('分组编辑：勾选账号后点“选中账号智能执行”即可按所选账号批量运行')">新建账号分组</button>
            <label style="margin-top:8px;display:block"><input type="checkbox" id="dedup" checked> 全局开启重复过滤（自动跳过已邀请/已分享好友）</label>
          </div>
        </div>
        <div class="col-right">
          <div class="card">
            <div class="card-title">已编排任务序列（勾选左侧功能生成）</div>
            <div id="seqBox" style="min-height:140px;border:1px dashed #2c303b;padding:10px;border-radius:4px;color:#a3a6ad;font-size:13px">手动勾选左侧功能，或者交给OpenClaw智能自动生成任务序列</div>
          </div>
          <div class="card">
            <div class="card-title">智能任务执行控制</div>
            <div style="margin:10px 0;display:flex;gap:10px">
              <button class="btn-dark" onclick="previewPlan()">预览全部执行方案</button>
              <button class="btn-dark" onclick="savePlan()">保存编排方案</button>
            </div>
            <div style="margin:10px 0;display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn-success" onclick="runSelected()">选中账号智能执行</button>
              <button class="btn-primary" onclick="runAllSmart()">全部账号智能执行</button>
              <button class="btn-danger" onclick="abortAll()">全部终止任务</button>
            </div>
            <div style="margin-top:10px;color:#f56c6c;font-size:13px">禁止底层内存模拟自测，全部流程拉起真实浏览器实机运行；缺少缓存资源自动跳过对应功能，任务不中断</div>
          </div>
        </div>
      </div>
    </div>

    <div id="page-policy" class="page" style="display:none">
      <div class="card card-title">全局运营策略配置</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:13px">
        <div class="card">
          <div class="card-title">每日操作上限</div>
          <div>单账号每日最大邀请：<input id="dailyInvite" value="20" style="width:80px"></div>
          <div style="margin-top:6px">单账号每日最大分享：<input id="dailyShare" value="15" style="width:80px"></div>
        </div>
        <div class="card">
          <div class="card-title">真人行为延时</div>
          <div>操作最小延时(秒)：<input id="minDelay" value="2" style="width:80px"></div>
          <div style="margin-top:6px">操作最大延时(秒)：<input id="maxDelay" value="8" style="width:80px"></div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-title">重复过滤总开关</div>
        <label><input type="checkbox" id="dedupInvite" checked> 邀请好友自动跳过已发送对象</label>
        <label style="margin-left:16px"><input type="checkbox" id="dedupShare" checked> 分享帖子自动跳过已分享好友</label>
      </div>
      <button class="btn-primary" style="margin-top:12px" onclick="savePolicy()">保存策略</button>
      <span id="policyMsg" style="margin-left:10px;color:#67c23a"></span>
    </div>

    <div id="page-source" class="page" style="display:none">
      <div class="card card-title">社团 &amp; 公共主页数据源（可无限添加，重启不丢）</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
        <div>
          <div style="font-size:12px;color:#a3a6ad">类型</div>
          <select id="srcType">
            <option value="page">公共主页</option>
            <option value="group">社团</option>
          </select>
        </div>
        <div style="flex:1;min-width:280px">
          <div style="font-size:12px;color:#a3a6ad">Facebook 网址（必填）</div>
          <input id="srcUrl" style="width:100%" placeholder="如 https://www.facebook.com/profile.php?id=61580739204271 或 https://www.facebook.com/groups/1009250201890464">
        </div>
        <div>
          <div style="font-size:12px;color:#a3a6ad">备注名（可选）</div>
          <input id="srcName" placeholder="如 我的主页#1">
        </div>
        <button class="btn-primary" onclick="addSource()">＋ 添加数据源</button>
      </div>
      <div id="srcTip" style="color:#e6a23c;font-size:12px;margin-bottom:8px"></div>
      <div style="display:flex;gap:14px">
        <div class="card" style="flex:1;min-width:0">
          <div class="card-title">公共主页（邀请点赞/访问、分享帖子读取这里）</div>
          <table>
            <thead><tr><th style="width:18%">备注名</th><th style="width:55%">网址</th><th style="width:17%">识别ID</th><th style="width:10%">操作</th></tr></thead>
            <tbody id="pageBody"></tbody>
          </table>
        </div>
        <div class="card" style="flex:1;min-width:0">
          <div class="card-title">社团（邀请好友进社团、从成员加好友读取这里）</div>
          <table>
            <thead><tr><th style="width:18%">备注名</th><th style="width:55%">网址</th><th style="width:17%">识别ID</th><th style="width:10%">操作</th></tr></thead>
            <tbody id="groupBody"></tbody>
          </table>
        </div>
      </div>
      <div style="margin-top:10px;color:#a3a6ad;font-size:13px">关联：邀请好友进社团 / 邀请点赞主页 / 从社团成员加好友 / 分享帖子，会自动从本表读取第一个匹配来源，无需手动输入 ID。后续可随时添加更多主页与社团。</div>
    </div>

    <div id="page-clawchat" class="page" style="display:none">
      <div class="card card-title">OpenClaw Agent 对话面板</div>
      <div class="card">
        <div style="margin-bottom:10px"><button class="btn-dark" onclick="runSupervise()">生成运营监管报告</button> <span style="color:#a3a6ad;font-size:12px">OpenClaw 自动汇总日志/风控/进化参数</span></div>
        <div id="mainPageChatBody" style="height:420px;overflow:auto;padding:12px;font-size:13px"></div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <textarea id="mainChatInput" style="flex:1;height:48px" placeholder="和 OpenClaw 智能體對話，或請它操作 FB / 修復軟體..."></textarea>
          <button class="btn-primary" onclick="sendClaw('main')">发送</button>
        </div>
      </div>
    </div>

    <div id="page-report" class="page" style="display:none">
      <div class="card card-title">历史任务执行报告</div>
      <table>
        <thead><tr><th>TaskID</th><th>执行范围</th><th>执行类型</th><th>执行时间</th><th>状态</th></tr></thead>
        <tbody id="reportBody"></tbody>
      </table>
    </div>

    <div id="page-monitor" class="page" style="display:none">
      <div class="card card-title">全局实时监控 <span id="monitorTs" style="font-weight:normal;color:#a3a6ad;font-size:12px"></span></div>
      <div class="task-layout">
        <div class="col-left">
          <div class="card"><div class="card-title">系统 &amp; 资源</div>
            <div id="monSystem" style="font-size:13px;line-height:1.8"></div>
            <div id="monLoad"></div>
          </div>
          <div class="card"><div class="card-title">OpenClaw Agent 监控</div>
            <div id="monAgent" style="font-size:13px;line-height:1.8"></div>
          </div>
        </div>
        <div class="col-right">
          <div class="card"><div class="card-title">活跃账号窗口（<span id="monActiveCount">0</span>）</div>
            <div id="monSessions" style="display:flex;flex-wrap:wrap;gap:8px"></div>
          </div>
          <div class="card"><div class="card-title">近期错误 / 警告</div>
            <div id="monErrors" style="font-size:12px;line-height:1.7;max-height:200px;overflow:auto;color:#f56c6c"></div>
          </div>
          <div class="card"><div class="card-title">任务吞吐（近1分钟 <span id="monTput">0</span>）</div>
            <div id="monTasks" style="font-size:12px;line-height:1.7"></div>
          </div>
          <div class="card"><div class="card-title">OpenClaw 实时感知（账号状态 + 接管事件）</div>
            <div id="monPerception" style="font-size:12px;line-height:1.7"></div>
          </div>
        </div>
      </div>
    </div>

    <div id="page-skills" class="page" style="display:none">
      <div class="card card-title">技能中心 — 软件的所有功能都是 OpenClaw 的「技能」</div>
      <div style="margin-bottom:10px;color:#a3a6ad;font-size:13px">點擊「執行」即調用該技能（對選中帳號運行）；可停用暫不使用的技能。啟用/停用與使用次數會持久化。</div>
      <table>
        <thead><tr><th>技能名稱</th><th>分類</th><th>說明</th><th>使用次數</th><th>最後使用</th><th>狀態</th><th>操作</th></tr></thead>
        <tbody id="skillBody"></tbody>
      </table>
    </div>

    <div id="page-memory" class="page" style="display:none">
      <div class="card card-title">记忆体 — 每个账号独立「记忆碎片」+ 跨账号「全局知识库」</div>
      <div class="task-layout">
        <div class="col-left">
          <div class="card"><div class="card-title">账号记忆碎片</div>
            <table>
              <thead><tr><th>账号</th><th>关键事实</th><th>重要记忆</th><th>最近上下文</th><th>关系</th><th>操作</th></tr></thead>
              <tbody id="shardBody"></tbody>
            </table>
          </div>
        </div>
        <div class="col-right">
          <div class="card"><div class="card-title">全局知识库（OpenClaw 跨账号学习与进化沉淀）</div>
            <textarea id="globalKnowledge" style="width:100%;height:300px;background:#222732;color:#cdd3df;border:1px solid #2c303b;border-radius:4px;padding:8px;font-size:12px;font-family:monospace" readonly></textarea>
          </div>
        </div>
      </div>
    </div>

    <div id="page-server" class="page" style="display:none">
      <div class="card card-title">服务端 & OpenClaw 模型设置</div>
      <div class="task-layout">
        <div class="col-left">
          <div class="card"><div class="card-title">服务端状态（监管启动器）</div>
            <div id="serverStatusBox" style="font-size:13px;line-height:2"></div>
            <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn-primary" onclick="supervisorAction('restart')">重启服务端</button>
              <button class="btn-warning" onclick="supervisorAction('stop')">停止服务端</button>
              <button class="btn-success" onclick="supervisorAction('start')">启动服务端</button>
              <button class="btn-dark" onclick="loadServerPage()">刷新状态</button>
            </div>
            <div style="margin-top:8px;font-size:12px;color:#71767b">说明：监管啟动器（Supervisor）會自動看門狗式重啟崩潰/無響應的服務端；按鈕透過控制端口 18992 操作。</div>
          </div>
          <div class="card"><div class="card-title">OpenClaw 模型设置（给别人用可直接填）</div>
            <div style="display:flex;flex-direction:column;gap:8px;max-width:460px">
              <label style="font-size:12px;color:#a3a6ad">API 基址<input id="ocBase" class="filter-input" style="width:100%" placeholder="https://api.deepseek.com"></label>
              <label style="font-size:12px;color:#a3a6ad">API 金鑰<input id="ocKey" type="password" class="filter-input" style="width:100%" placeholder="sk-..."></label>
              <label style="font-size:12px;color:#a3a6ad">模型名<input id="ocModel" class="filter-input" style="width:100%" placeholder="deepseek-chat"></label>
              <div style="display:flex;gap:8px">
                <button class="btn-primary" onclick="saveModelSettings()">保存并热生效</button>
                <button class="btn-danger" onclick="doRepair()">🔧 一键修复 OpenClaw</button>
              </div>
              <div id="ocDiag" style="font-size:12px;color:#71767b"></div>
            </div>
          </div>
        </div>
        <div class="col-right">
          <div class="card"><div class="card-title">一键修复说明</div>
            <div style="font-size:13px;line-height:1.9;color:#cdd3df">
              • 把 OpenClaw 配置恢復到官方「安全基線」(openclaw.json.last-good)，避免配置跑偏/損壞導致智能體不可用。<br>
              • 修復後會自動把上方設置的「模型 API」寫回，<b>不丟失你的 Key</b>。<br>
              • <b>帳號資料（accounts.json / 瀏覽器檔案 / 記憶體）完全不受影響</b>。<br>
              • 適用場景：智能體突然不可用、網關啟動失敗、配置被誤改。<br>
              <span style="color:#e6a23c">點擊「一鍵修復」會先停止網關再還原並重啟，過程約數秒。</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="page-groups" class="page" style="display:none">
      <div class="card card-title">社团总览 — 仅台湾社团 + 跨账号去重（防止协同风控）</div>
      <div id="groupsPerAccount" style="margin-bottom:10px;font-size:13px;color:#cdd3df"></div>
      <table>
        <thead><tr><th style="width:32%">社团</th><th style="width:8%">地区</th><th style="width:12%">人数</th><th style="width:24%">已加账号</th><th style="width:14%">加入时间</th><th style="width:10%">协同风险</th></tr></thead>
        <tbody id="groupsBody"></tbody>
      </table>
    </div>

    <div id="page-avatar" class="page" style="display:none">
      <div class="card card-title">头像管理 — 把图片放到 data/avatars/inbox，软件自动上传替换</div>
      <div id="avatarStats" style="font-size:13px;color:#cdd3df;margin-bottom:10px"></div>
      <div style="font-size:12px;color:#71767b;margin-bottom:10px">规则：每个账号一生只换一次头像；用过的头像自动移到 used/ 并标记，避免跨账号重复使用。仅在 warmup 阶段自动套用。</div>
      <table>
        <thead><tr><th style="width:60%">待处理头像（inbox）</th><th style="width:40%">操作</th></tr></thead>
        <tbody id="avatarBody"></tbody>
      </table>
    </div>
  </div>
</div>

<div class="right-log">
  <div class="log-title">实时运行日志</div>
  <div class="log-box" id="logBox">加载中...</div>
  <div class="log-title" style="border-top:1px solid #2c303b">实时任务进度</div>
  <div style="padding:12px;font-size:13px" id="progressBox">当前模式：待命<br>待执行：等待下发任务序列</div>
</div>

<script>
// ---------- 服务端 & 模型 ----------
async function loadServerPage(){
  try{
    const r=await fetch('/api/status'); const j=await r.json();
    const gw=j.gatewayReachable?'<span style="color:#67c23a">● 可达</span>':'<span style="color:#f56c6c">● 不可达</span>';
    const wd=j.watchdogRunning?'<span style="color:#67c23a">● 运行中</span>':'<span style="color:#e6a23c">○ 未运行</span>';
    const sv=(j.supervisor&&j.supervisor.supervisorRunning)?'<span style="color:#67c23a">● 监管运行中</span>':'<span style="color:#71767b">○ 监管未运行（开发模式）</span>';
    document.getElementById('serverStatusBox').innerHTML=
      '服务端：<b>运行中</b>（已运行 '+Math.round(j.uptimeSec)+'s）<br>'+
      'OpenClaw 网关：'+gw+'<br>会话看门狗：'+wd+'<br>监管启动器：'+sv+'<br>'+
      (j.supervisor?('累计重启：'+(j.supervisor.restarts||0)+' 次'):'');
  }catch(e){ document.getElementById('serverStatusBox').innerHTML='状态获取失败：'+(e.message||e); }
  try{
    const r=await fetch('/api/settings/openclaw'); const j=await r.json();
    if(j.settings){ document.getElementById('ocBase').value=j.settings.baseUrl||''; document.getElementById('ocKey').value=j.settings.apiKey||''; document.getElementById('ocModel').value=j.settings.model||''; }
    const d=j.diagnose||{};
    document.getElementById('ocDiag').innerHTML='网关配置可读：'+(d.readable?'是':'否')+' ｜ 含模型：'+(d.hasModel?'是':'否')+' ｜ 含API Key：'+(d.hasApiKey?'是':'否');
  }catch(e){}
}
async function saveModelSettings(){
  const body={ baseUrl:document.getElementById('ocBase').value, apiKey:document.getElementById('ocKey').value, model:document.getElementById('ocModel').value };
  const r=await fetch('/api/settings/openclaw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  toast(j.ok?('已保存'+(j.applied?'，已套用到网关':'，但网关套用失败：'+(j.error||''))):'保存失败');
  loadServerPage();
}
async function doRepair(){
  if(!confirm('确认一键修复 OpenClaw 配置？\n将恢复官方安全基线并保留你的模型 API，账号资料不受影响。')) return;
  toast('修复中...');
  const r=await fetch('/api/openclaw/repair',{method:'POST'}); const j=await r.json();
  let msg=(j.ok?'修复完成':'修复失败：'+(j.error||''));
  if(j.steps) msg+='\n'+j.steps.join('\n');
  if(j.gatewayReachable!==undefined) msg+='\n网关可达：'+j.gatewayReachable;
  alert(msg);
  loadServerPage();
}
async function supervisorAction(act){
  try{
    const r=await fetch('http://127.0.0.1:18992/'+act,{method:'POST'}); const j=await r.json();
    toast((j.ok?'已'+act:'操作失败')+(j.serverPid?(' PID='+j.serverPid):''));
  }catch(e){ toast('监管未运行，无法操作（'+(e.message||e)+'）'); }
  setTimeout(loadServerPage,1200);
}

// ---------- 社团总览 ----------
async function loadGroupsPage(){
  try{
    const r=await fetch('/api/groups/joined'); const j=await r.json();
    const pa=(j.perAccount||[]).map(function(a){ return esc(a.name)+'('+esc(a.accountId)+')：已加 '+a.joined+(a.overlap?('，<span style="color:#e6a23c">协同'+a.overlap+'</span>'):''); }).join(' ｜ ');
    document.getElementById('groupsPerAccount').innerHTML= pa||'暂无账号社团数据';
    const tb=document.getElementById('groupsBody');
    tb.innerHTML=(j.groups||[]).map(function(g){
      const overlap=(g.by&&g.by.length>1)?'<span style="color:#e6a23c">'+g.by.length+'账号同加</span>':'安全';
      const by=(g.by||[]).join(', ');
      return '<tr><td>'+esc(g.name||g.url)+'<br><span style="font-size:11px;color:#71767b">'+esc(g.url)+'</span></td>'+
        '<td>'+esc(g.region||'-')+'</td><td>'+esc(g.members||'-')+'</td><td>'+esc(by)+'</td>'+
        '<td>'+esc(g.addedAt?new Date(g.addedAt).toLocaleDateString('zh-TW'):-)+'</td><td>'+overlap+'</td></tr>';
    }).join('')||'<tr><td colspan="6" style="color:#a3a6ad">暂无社团数据</td></tr>';
  }catch(e){ document.getElementById('groupsBody').innerHTML='<tr><td colspan="6">加载失败：'+(e.message||e)+'</td></tr>'; }
}

// ---------- 头像管理 ----------
async function loadAvatarPage(){
  try{
    const r=await fetch('/api/avatar/stats'); const j=await r.json();
    const st=j.stats||{};
    document.getElementById('avatarStats').innerHTML='待处理(inbox)：<b>'+(st.inbox||0)+'</b> ｜ 已用(used)：<b>'+(st.used||0)+'</b> ｜ 总计：'+(st.total||0);
    const tb=document.getElementById('avatarBody');
    tb.innerHTML=(j.inbox||[]).map(function(f){ return '<tr><td>'+esc(f)+'</td><td><button class="btn-dark" onclick="markAvatarUsed(\''+esc(f)+'\')">标记已用</button></td></tr>'; }).join('')||'<tr><td colspan="2" style="color:#a3a6ad">inbox 暂无头像，把图片放入 data/avatars/inbox 即可</td></tr>';
  }catch(e){ document.getElementById('avatarStats').innerHTML='加载失败：'+(e.message||e); }
}
async function markAvatarUsed(fn){
  const r=await fetch('/api/avatar/mark-used',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:fn})});
  const j=await r.json(); toast(j.ok?'已标记'+fn:'失败：'+(j.error||'')); loadAvatarPage();
}

let allAccounts=[], currentAccount=null, selectedAccounts=[], abortFlag=false, selectedFuncs=[];
let prevBlockers={};
function esc(s){ if(s===null||s===undefined) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtLogTime(t){ if(!t) return ''; try { return new Date(t).toLocaleTimeString('zh-TW'); } catch(e){ return String(t); } }
function toast(msg){ const t=document.getElementById('toast'); if(!t)return; t.textContent=msg; t.style.display='block'; clearTimeout(t._t); t._t=setTimeout(function(){t.style.display='none';},3200); }

const navItems=document.querySelectorAll('.nav-item');
const pages=document.querySelectorAll('.page');
navItems.forEach(function(item){
  item.onclick=function(){
    navItems.forEach(function(i){i.classList.remove('active');});
    item.classList.add('active');
    const id=item.dataset.page;
    pages.forEach(function(p){p.style.display='none';});
    document.getElementById('page-'+id).style.display='block';
    if(id==='proxy') loadProxies();
    if(id==='policy') loadPolicy();
    if(id==='report') loadHistory();
    if(id==='source') loadSources();
    if(id==='clawchat') syncClaw();
    if(id==='monitor') startMonitorPoll(); else stopMonitorPoll();
    if(id==='skills') loadSkills();
    if(id==='memory') loadMemory();
    if(id==='server') loadServerPage();
    if(id==='groups') loadGroupsPage();
    if(id==='avatar') loadAvatarPage();
  };
});
document.querySelectorAll('.func-tag').forEach(function(tag){
  tag.onclick=function(){
    if(tag.dataset.task==='__notimpl'){ toast('该功能后端尚未接入'); return; }
    tag.classList.toggle('active');
    const t=tag.dataset.task;
    const i=selectedFuncs.indexOf(t);
    if(tag.classList.contains('active')){ if(i<0) selectedFuncs.push(t); } else { if(i>=0) selectedFuncs.splice(i,1); }
    renderSeq();
  };
});
function renderSeq(){
  const box=document.getElementById('seqBox');
  if(!selectedFuncs.length){ box.innerHTML='手动勾选左侧功能，或者交给OpenClaw智能自动生成任务序列'; return; }
  box.innerHTML=selectedFuncs.map(function(t){return '<div>· '+esc(t)+'</div>';}).join('');
}
function clearFunc(){ selectedFuncs=[]; document.querySelectorAll('.func-tag.active').forEach(function(e){e.classList.remove('active');}); renderSeq(); }

function toggleClawChat(){ const w=document.getElementById('clawChatWin'); w.style.display = w.style.display==='flex'?'none':'flex'; }

// 账号
async function loadAccounts(){
  const r=await fetch('/api/accounts'); const j=await r.json(); allAccounts=j.accounts||[];
  const pr=await fetch('/api/proxy'); const pj=await pr.json();
  const accToProxy={}; (pj.proxies||[]).forEach(function(px){ if(px.boundAccount) accToProxy[px.boundAccount]=px.name; });
  renderAccBody(accToProxy);
  if(!currentAccount && allAccounts[0]) currentAccount=allAccounts[0].accountId;
  renderGroups();
}
function renderAccBody(accToProxy){
  accToProxy=accToProxy||{};
  const f=document.getElementById('accFilter').value.trim().toLowerCase();
  const tb=document.getElementById('accBody');
  tb.innerHTML=allAccounts.map(function(a){
    const checked=selectedAccounts.includes(a.accountId)?'checked':'';
    const proxy=accToProxy[a.name];
    const exitIp=a.exitIp;
    const stColor=(a.status==='active'||a.status==='正常')?'#67c23a':(a.status==='checkpoint'||a.status==='人脸复核')?'#f56c6c':'#e6a23c';
    const proxyCell=exitIp
      ? '<span style="color:#67c23a">出口IP '+esc(exitIp)+'</span>'+(proxy?'<br><span style="font-size:11px;color:#71767b">'+esc(proxy)+'</span>':'')
      : (proxy?'<span style="color:#67c23a">'+esc(proxy)+'</span>':'<span style="color:#e6a23c">未绑定代理</span>');
    const line=(a.name+' '+(a.accountId||'')+' '+(a.status||'')+' '+(exitIp||proxy||'')).toLowerCase();
    if(f && line.indexOf(f)<0) return '';
    return '<tr>'
      +'<td><input type="checkbox" '+checked+' data-id="'+a.accountId+'" onchange="toggleAcc(this.dataset.id,this.checked)"></td>'
      +'<td>'+esc(a.name)+'</td>'
      +'<td>'+esc(a.accountId)+'</td>'
      +'<td>'+(a.mode==='real'?'真实登录':'模拟')+'</td>'
      +'<td style="color:'+stColor+'">'+(a.status||'未知')+'</td>'
      +'<td>'+proxyCell+'</td>'
      +'<td>-</td><td>-</td><td>—</td>'
      +'<td><button class="btn-primary" data-id="'+a.accountId+'" onclick="launchEnv(this.dataset.id)">启动环境</button> <button class="btn-success" data-id="'+a.accountId+'" onclick="runSmart(this.dataset.id)">智能执行</button> <button class="btn-danger" data-id="'+a.accountId+'" onclick="deleteAccountBtn(this.dataset.id)">删除</button></td>'
      +'</tr>';
  }).join('');
}
function renderAccFilter(){ loadAccounts(); }
function toggleAcc(id,checked){ if(checked){ if(!selectedAccounts.includes(id)) selectedAccounts.push(id); } else { selectedAccounts=selectedAccounts.filter(function(x){return x!==id;}); } }
function toggleAll(c){ selectedAccounts = c? allAccounts.map(function(a){return a.accountId;}) : []; loadAccounts(); }
function renderGroups(){ const g=document.getElementById('groupDef'); const sel=selectedAccounts.length?selectedAccounts.join('、'):'(未选)'; g.innerHTML='当前已选账号：'+esc(sel); }
async function launchEnv(id){ const r=await fetch('/api/account/'+id+'/launch',{method:'POST'}); const j=await r.json(); toast(j.success?'环境已启动':'启动失败'); }
async function retileWindows(){ try{ const r=await fetch('/api/windows/retile',{method:'POST'}); const j=await r.json(); toast(j.success?'窗口已重新排布':'重排失敗'); }catch(e){ toast('重排失敗'); } }
async function toggleAutoRetile(){ try{ const r=await fetch('/api/windows/auto-retile',{method:'GET'}); const j=await r.json(); const enabled=!(j.enabled||false); await fetch('/api/windows/auto-retile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})}); document.getElementById('autoRetileBtn').innerText='自动重排：'+(enabled?'开':'关'); toast(enabled?'已开启自动重排':'已关闭自动重排'); }catch(e){ toast('自动重排切换失败'); } }
(async function initAutoRetileBtn(){ try{ const r=await fetch('/api/windows/auto-retile',{method:'GET'}); const j=await r.json(); const btn=document.getElementById('autoRetileBtn'); if(btn) btn.innerText='自动重排：'+(j.enabled?'开':'关'); }catch(e){} })();

// 示范录制：打開勾選的窗口並開始記錄使用者手動操作（用於校驗/完善技能，如繁體中文設置）
async function startDemoRecord(){
  const ids = selectedAccounts.slice(0,6);
  if(ids.length===0){ toast('请先勾选至少1个账号'); return; }
  const r = await fetch('/api/demo/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountIds:ids})});
  const j = await r.json();
  toast(j.success?('已开始示范录制：'+j.recording.length+'个窗口已打开，请手动操作'):'启动失败');
}
async function stopDemoRecord(){
  const ids = selectedAccounts.slice(0,6);
  if(ids.length===0){ toast('请勾选要停止的账号'); return; }
  const r = await fetch('/api/demo/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountIds:ids})});
  const j = await r.json();
  toast(j.success?('已停止录制：'+j.stopped.length+'个账号'):'停止失败');
}
async function viewDemoSteps(){
  const id = selectedAccounts[0];
  if(!id){ toast('请勾选1个账号查看录制'); return; }
  const r = await fetch('/api/demo/events?accountId='+encodeURIComponent(id));
  const j = await r.json();
  if(!j.success){ toast('读取失败'); return; }
  const lines = (j.events||[]).map(function(e){ return '['+e.t+'] '+(e.el?(''+(e.el.aria||e.el.text||e.el.tag)+(e.el.val?' = '+e.el.val:'')):'')+' @ '+e.url; });
  console.log('=== 示范录制步骤 ('+j.count+') ===');
  lines.forEach(function(l){ console.log(l); });
  toast('已记录 '+(j.count||0)+' 步，详见浏览器控制台(F12)');
}
async function deleteAccountBtn(id){
  if(!confirm('确定删除该账号？同时会移除其绑定的代理与本地记忆，不可恢复。')) return;
  try{
    // 关闭可能正在运行的会话
    try{ await fetch('/api/account/'+id+'/close',{method:'POST'}); }catch(e){}
    const r=await fetch('/api/accounts/'+encodeURIComponent(id),{method:'DELETE'}); const j=await r.json();
    if(j.success){ toast('已删除账号'); allAccounts=allAccounts.filter(function(a){return a.accountId!==id;}); selectedAccounts=selectedAccounts.filter(function(x){return x!==id;}); }
    else toast('删除失败');
  }catch(e){ toast('删除失败：'+(e.message||e)); }
  loadAccounts();
}

// 代理池
async function loadProxies(){
  const r=await fetch('/api/proxy'); const j=await r.json();
  const tb=document.getElementById('proxyBody');
  tb.innerHTML=(j.proxies||[]).map(function(px){
    const st=px.alive?'<span style="color:#67c23a">正常</span>':'<span style="color:#f56c6c">异常</span>';
    const lat=(px.alive && px.latency && px.latency>=0)?('<span style="color:#67c23a">'+px.latency+' ms</span>'):'<span style="color:#71767b">—</span>';
    const exitIp=px.exitIp?('<span style="color:#67c23a">'+esc(px.exitIp)+'</span>'):'<span style="color:#71767b">—</span>';
    const note=px.note?('<span style="color:'+(px.alive?'#67c23a':'#f56c6c')+'" title="'+esc(px.note)+'">'+esc(px.note.length>46?px.note.slice(0,46)+'…':px.note)+'</span>'):'—';
    return '<tr>'
      +'<td>'+esc(px.name||(px.host+':'+px.port))+'</td>'
      +'<td>'+(px.port||'')+'</td>'
      +'<td>'+(px.country||'—')+'</td>'
      +'<td>'+st+'</td>'
      +'<td>'+lat+'</td>'
      +'<td>'+exitIp+'</td>'
      +'<td style="max-width:280px;font-size:12px;line-height:1.4">'+note+'</td>'
      +'<td>'+(px.boundAccount||'—')+'</td>'
      +'<td><button class="btn-dark" data-id="'+px.id+'" onclick="unbindProxy(this.dataset.id)">解绑</button></td>'
      +'</tr>';
  }).join('') || '<tr><td colspan="9" style="color:#a3a6ad">尚无代理，点击“上传TXT代理文件”导入</td></tr>';
}
function importProxyFile(input){
  const file=input.files[0]; if(!file) return;
  const rd=new FileReader();
  rd.onload=async function(){
    const r=await fetch('/api/proxy/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:rd.result})});
    const j=await r.json(); toast('已导入代理 '+j.added+' 条'); loadProxies();
  };
  rd.readAsText(file);
}
async function testAllProxy(){ toast('正在批量连通检测，请稍候...'); try{ const r=await fetch('/api/proxy/test-all',{method:'POST'}); const j=await r.json(); const ok=j.ok||0; const total=j.total||0; const avg=Math.round((j.results||[]).filter(x=>x.alive&&x.latency>=0).reduce(function(a,b){return a+b.latency;},0)/Math.max(1,ok)); toast('连通检测完成：正常 '+ok+'/'+total+(ok?('，平均延迟 '+avg+' ms'):'')); }catch(e){ toast('检测失败：'+(e.message||e)); } loadProxies(); }
async function autoAssignProxy(){ const r=await fetch('/api/proxy/auto-assign',{method:'POST'}); const j=await r.json(); toast('已自动分配 '+j.assigned+' 个账号'); loadAccounts(); }
async function unbindProxy(id){ await fetch('/api/proxy/'+id+'/unbind',{method:'POST'}); toast('已解绑'); loadProxies(); loadAccounts(); }
function exportProxyMap(){ window.open('/api/proxy'); }

// 社团 & 公共主页 数据源
async function loadSources(){
  const r=await fetch('/api/sources'); const j=await r.json();
  const srcs=j.sources||[];
  const pages=srcs.filter(function(s){return s.type==='page';});
  const groups=srcs.filter(function(s){return s.type==='group';});
  const pb=document.getElementById('pageBody'); const gb=document.getElementById('groupBody');
  pb.innerHTML=pages.map(function(s){return '<tr>'
    +'<td>'+esc(s.name)+'</td>'
    +'<td><a href="'+esc(s.url)+'" target="_blank" style="color:#409eff">'+esc(s.url)+'</a></td>'
    +'<td>'+esc(s.rawId)+'</td>'
    +'<td><button class="btn-danger" data-id="'+s.id+'" onclick="deleteSource(this.dataset.id)">删除</button></td>'
    +'</tr>';}).join('') || '<tr><td colspan="4" style="color:#a3a6ad">尚无公共主页，填写上方表单添加</td></tr>';
  gb.innerHTML=groups.map(function(s){return '<tr>'
    +'<td>'+esc(s.name)+'</td>'
    +'<td><a href="'+esc(s.url)+'" target="_blank" style="color:#409eff">'+esc(s.url)+'</a></td>'
    +'<td>'+esc(s.rawId)+'</td>'
    +'<td><button class="btn-danger" data-id="'+s.id+'" onclick="deleteSource(this.dataset.id)">删除</button></td>'
    +'</tr>';}).join('') || '<tr><td colspan="4" style="color:#a3a6ad">尚无社团，填写上方表单添加</td></tr>';
}
async function addSource(){
  const type=document.getElementById('srcType').value;
  const url=document.getElementById('srcUrl').value.trim();
  const name=document.getElementById('srcName').value.trim();
  const tip=document.getElementById('srcTip');
  if(!url){ tip.textContent='请先填写 Facebook 网址'; return; }
  try{
    const r=await fetch('/api/sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:type,url:url,name:name})});
    const j=await r.json();
    if(j.success){ tip.style.color='#67c23a'; tip.textContent='已添加：'+(j.source&&j.source.name||''); document.getElementById('srcUrl').value=''; document.getElementById('srcName').value=''; loadSources(); }
    else { tip.textContent='添加失败：'+(j.error||''); }
  }catch(e){ tip.textContent='添加失败：'+(e.message||e); }
}
async function deleteSource(id){
  if(!confirm('确定删除该数据源？')) return;
  await fetch('/api/sources/'+id,{method:'DELETE'});
  toast('已删除'); loadSources();
}

// 策略
async function loadPolicy(){ const r=await fetch('/api/policy'); const j=await r.json(); const p=j.policy||{}; document.getElementById('dailyInvite').value=p.dailyInviteLimit||20; document.getElementById('dailyShare').value=p.dailyShareLimit||15; document.getElementById('minDelay').value=p.minDelaySec||2; document.getElementById('maxDelay').value=p.maxDelaySec||8; document.getElementById('dedupInvite').checked=!!p.dedupInvite; document.getElementById('dedupShare').checked=!!p.dedupShare; }
async function savePolicy(){ const p={ dailyInviteLimit:Number(document.getElementById('dailyInvite').value), dailyShareLimit:Number(document.getElementById('dailyShare').value), minDelaySec:Number(document.getElementById('minDelay').value), maxDelaySec:Number(document.getElementById('maxDelay').value), dedupInvite:document.getElementById('dedupInvite').checked, dedupShare:document.getElementById('dedupShare').checked }; await fetch('/api/policy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)}); document.getElementById('policyMsg').textContent='已保存'; setTimeout(function(){document.getElementById('policyMsg').textContent='';},2000); }

// 历史
async function loadHistory(){ const r=await fetch('/api/history'); const j=await r.json(); const tb=document.getElementById('reportBody'); tb.innerHTML=(j.history||[]).map(function(h){ return '<tr><td>'+(h.taskId||'')+'</td><td>'+esc(h.scope||'')+'</td><td>'+esc(h.type||'')+'</td><td>'+esc((h.time||'').replace('T',' ').slice(0,16))+'</td><td>'+esc(h.status||'')+'</td></tr>'; }).join('') || '<tr><td colspan="5" style="color:#a3a6ad">暂无任务记录</td></tr>'; }

// 任务执行
function paramsFor(type){
  // 全部圍繞台灣本地生活興趣，杜絕任何商業/跨境電商關鍵詞
  if(type==='add_friends') return {mode:'search', searchQuery:'台灣 美食', count:2};
  if(type==='join_groups') return {keywords:['台灣美食','台灣旅遊','台灣生活'], count:1};
  if(type==='browse_feed') return {like:true, scrollCount:4};
  return {};
}
async function runTask(type, params, accountId){
  const r=await fetch('/api/task/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:accountId, type:type, params:params||{}})});
  const j=await r.json(); return j;
}
async function runSmartSequence(ids){
  abortFlag=false;
  const seq=['sync','browse_feed','add_friends','join_groups','greet_new_friends','ai_chat_reply'];
  for(const id of ids){
    if(abortFlag){ toast('已终止'); break; }
    toast('智能执行 '+id); document.getElementById('progressBox').innerHTML='当前模式：智能执行 '+id;
    for(const step of seq){
      if(abortFlag) break;
      document.getElementById('progressBox').innerHTML='运行中：'+id+' → '+step;
      try { await runTask(step, paramsFor(step), id); } catch(e){ toast(id+' '+step+' 异常: '+e.message); }
      await new Promise(function(r){setTimeout(r,800);});
    }
  }
  document.getElementById('progressBox').innerHTML='当前模式：待命<br>待执行：等待下发任务序列';
  loadAccounts();
}
function runSmart(id){ runSmartSequence([id]); }
function runAllSmart(){ runSmartSequence(allAccounts.map(function(a){return a.accountId;})); }
function runSelected(){
  if(!selectedFuncs.length){ toast('请先在左侧勾选功能，或直接点“全部账号智能执行”'); return; }
  const ids=selectedAccounts.length?selectedAccounts:allAccounts.map(function(a){return a.accountId;});
  runSeqForAccounts(ids, selectedFuncs.slice());
}
async function runSeqForAccounts(ids, seq){
  abortFlag=false;
  for(const id of ids){
    if(abortFlag) break;
    for(const step of seq){
      if(abortFlag) break;
      document.getElementById('progressBox').innerHTML='运行中：'+id+' → '+step;
      try { await runTask(step, paramsFor(step), id); } catch(e){}
      await new Promise(function(r){setTimeout(r,600);});
    }
  }
  document.getElementById('progressBox').innerHTML='当前模式：待命'; toast('所选任务执行完成');
}
function abortAll(){ abortFlag=true; toast('已发送终止信号'); }
function previewPlan(){ toast('方案：'+(selectedFuncs.length?selectedFuncs.join(' → '):'默认智能序列 sync → browse_feed → add_friends → join_groups → greet_new_friends → ai_chat_reply')); }
function savePlan(){ localStorage.setItem('fbclaw_plan', JSON.stringify(selectedFuncs)); toast('编排方案已保存（本地）'); }

// AI 对话（真 OpenClaw 智能體：自由對話 + 工具調度）
const chatHistory = { main: [], claw: [] };
async function sendClaw(target){
  const inp = target==='main'? document.getElementById('mainChatInput') : document.getElementById('clawInput');
  const msg=inp.value; if(!msg) return; inp.value='';
  const acc = currentAccount || (allAccounts[0]&&allAccounts[0].accountId);
  if(!acc){ toast('请先导入并选择账号'); return; }
  const body=document.getElementById(target==='main'?'mainPageChatBody':'clawChatBody');
  body.innerHTML+='<div class="msg-user">'+esc(msg)+'</div>';
  chatHistory[target].push('使用者：'+msg);
  const hist = chatHistory[target].slice(-10).join('\n');
  const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:acc,message:msg,history:hist})});
  const j=await r.json();
  let agentHtml='<div class="msg-agent">'+esc(j.reply||'（暫無回應）');
  if(j.steps&&j.steps.length){
    agentHtml+='<details style="margin-top:6px;font-size:12px;opacity:.85"><summary>執行紀錄 ('+j.steps.length+')</summary>';
    j.steps.forEach(function(st){ agentHtml+='<div style="margin:2px 0">• <b>'+esc(st.tool)+'</b>：'+esc((st.result||'').slice(0,300))+'</div>'; });
    agentHtml+='</details>';
  }
  agentHtml+='</div>';
  body.innerHTML+=agentHtml;
  chatHistory[target].push('智能體：'+(j.reply||''));
  body.scrollTop=body.scrollHeight;
  loadAccounts();
}
function syncClaw(){ const b=document.getElementById('mainPageChatBody'); if(!b.innerHTML.trim()) b.innerHTML='<div class="msg-agent">OpenClaw Agent 就绪<br>支持下发选中账号智能执行、全部账号智能批量执行指令</div>'; }

async function runSupervise(){
  const body=document.getElementById('mainPageChatBody');
  body.innerHTML+='<div class="msg-agent">OpenClaw 正在生成运营监管报告…</div>'; body.scrollTop=body.scrollHeight;
  try{
    const r=await fetch('/api/agent/supervise',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const j=await r.json();
    const rep=j.report||{};
    let html='<div class="msg-agent"><b>运营监管报告</b><br>';
    html+=(rep.llmSummary||'')+'<br><br><b>账号状态：</b><br>';
    (rep.accounts||[]).forEach(a=>{ html+='• '+esc(a.accountId)+' ｜ '+esc(a.status)+' ｜ 风控:'+esc(a.riskLevel)+'<br>'; });
    html+='<br><b>进化建议：</b><br>';
    (rep.suggestions||[]).forEach(s=>{ html+='• '+esc(s)+'<br>'; });
    html+='</div>';
    body.innerHTML+=html; body.scrollTop=body.scrollHeight;
  }catch(e){ body.innerHTML+='<div class="msg-agent">监管报告生成失败：'+(e.message||e)+'</div>'; }
}

async function importAccounts(){
  const txt=prompt('粘贴账号行，格式：备注,登录标识,类型(real/mock)\\n例如：\\n账号A,61590344349141,real');
  if(!txt) return;
  let n=0;
  for(const line of txt.split(/\\n/)){
    const p=line.split(','); if(p.length<3) continue;
    await fetch('/api/accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:p[0].trim(), accountId:p[1].trim(), mode:p[2].trim()==='real'?'real':'mock'})});
    n++;
  }
  toast('已导入 '+n+' 个账号'); loadAccounts();
}
async function importAccountsFile(input){
  const file=input.files[0]; if(!file){ return; }
  const isXlsx=/\.xlsx?$/i.test(file.name);
  if(isXlsx){
    try{
      const buf=await file.arrayBuffer();
      const bytes=new Uint8Array(buf);
      let bin=''; const chunk=0x8000;
      for(let i=0;i<bytes.length;i+=chunk){ bin+=String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i,i+chunk))); }
      const b64=btoa(bin);
      toast('正在解析 xlsx 并导入账号（生成指纹+顺序分配代理）...');
      const r=await fetch('/api/accounts/import-xlsx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileB64:b64, filename:file.name})});
      const j=await r.json();
      if(j&&j.success){
        let msg='已导入 '+j.created+' 个账号';
        if(j.skipped) msg+='，跳过 '+j.skipped;
        msg+=' ｜ 指纹 '+j.fingerprinted+' ｜ Cookie还原 '+j.cookieRestored+' ｜ 代理分配 '+j.proxyAssigned;
        toast(msg);
      } else { toast('导入失败：'+(j&&j.error||'未知错误')); }
      loadAccounts();
    }catch(e){ toast('导入失败：'+(e.message||e)); }
    input.value='';
    return;
  }
  const rd=new FileReader();
  rd.onload=async function(){
    const text=rd.result; if(!text) return;
    const lines=String(text).split(/\\r?\\n/).map(function(l){return l.trim();}).filter(Boolean);
    let n=0, skip=0;
    for(const line of lines){
      if(/^(备注|名称|账号|name|email|account)/i.test(line)) continue; // 跳过 CSV 表头
      const p=line.split(/[,，\\t]/);
      if(p.length<2){ skip++; continue; }
      const name=p[0].trim(); const accountId=p[1].trim();
      if(!accountId){ skip++; continue; }
      const mode=(p[2]&&/real/i.test(p[2].trim()))?'real':'mock';
      try{
        const r=await fetch('/api/accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name, accountId:accountId, mode:mode})});
        const j=await r.json();
        if(j&&j.success) n++; else skip++;
      }catch(e){ skip++; }
    }
    toast('已导入 '+n+' 个账号'+(skip?('，跳过 '+skip):'')); loadAccounts();
  };
  rd.readAsText(file);
  input.value='';
}
async function checkAllAccounts(){ toast('正在检测全部账号状态...'); for(const a of allAccounts){ if(abortFlag){ toast('已终止'); break; } try{ await runTask('sync',{}, a.accountId); }catch(e){} } loadAccounts(); if(!abortFlag) toast('检测完成'); }

// 全局监控面板
let monitorTimer = null;
function bar(label, pct) {
  pct = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const color = pct > 85 ? '#f56c6c' : (pct > 60 ? '#e6a23c' : '#67c23a');
  return '<div style="margin-top:6px"><div style="font-size:12px">'+label+'：'+pct+'%</div><div style="background:#222732;height:10px;border-radius:5px;overflow:hidden"><div style="width:'+pct+'%;height:100%;background:'+color+'"></div></div></div>';
}
async function loadMonitor() {
  try {
    const r = await fetch('/api/monitor/state');
    const j = await r.json();
    const s = j.snapshot;
    if (!s) return;
    document.getElementById('monitorTs').textContent = '更新于 ' + new Date(s.ts).toLocaleTimeString('zh-TW');
    const sys = s.system;
    document.getElementById('monSystem').innerHTML =
      'OS：' + esc(sys.os) + '<br>CPU：' + esc(sys.cpuModel) + ' ｜ ' + sys.cpuCores + ' 核<br>' +
      'GPU：' + esc(sys.gpu) + '<br>螢幕：' + sys.screen.width + '×' + sys.screen.height + '<br>' +
      '記憶體：總 ' + sys.totalRamGB + 'GB ｜ 剩 ' + sys.freeRamGB.toFixed(1) + 'GB';
    const load = s.load;
    document.getElementById('monLoad').innerHTML =
      bar('記憶體使用', load.memPct) + bar('並發佔用', load.cpuPct) +
      '<div style="margin-top:6px">活躍視窗：' + load.active + ' / 最大 ' + load.max + '</div>';
    document.getElementById('monActiveCount').textContent = s.activeSessions.length;
    document.getElementById('monSessions').innerHTML = (s.activeSessions.length
      ? s.activeSessions.map(function(a) {
          const blocker = a.blocker;
          const badge = blocker
            ? '<span style="display:inline-block;background:#f56c6c;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;margin-top:4px">⚠ 阻塞：' + esc(blocker) + '</span>'
            : '';
          const stuck = a.stuckSince ? '<br>卡頓自：' + new Date(a.stuckSince).toLocaleTimeString('zh-TW') : '';
          const act = a.lastWatchdogAction ? '<br><span style="color:#e6a23c">看門狗：' + esc(a.lastWatchdogAction) + '</span>' : '';
          return '<div style="border:1px solid #2c303b;border-radius:6px;padding:8px;width:200px;font-size:12px">' +
            '<b>' + esc(a.name) + '</b><br>' + esc(a.accountId) + '<br>狀態：' + esc(a.status) + '<br>' +
            'PID：' + (a.pid || '-') + '<br>已開：' + Math.floor(a.uptimeSec / 60) + ' 分<br>' +
            '<span style="color:#409eff;word-break:break-all">' + esc(a.url) + '</span>' + badge + stuck + act + '</div>';
        }).join('')
      : '<span style="color:#a3a6ad">目前無活躍視窗</span>');

    // 看門狗：新出現的阻塞即時 toast 告警
    try {
      const cur = {};
      s.activeSessions.forEach(function(a){ if (a.blocker) cur[a.accountId] = a.blocker; });
      Object.keys(cur).forEach(function(id){
        if (prevBlockers[id] !== cur[id]) toast('⚠ ' + id + ' 阻塞：' + cur[id]);
      });
      prevBlockers = cur;
    } catch (e) {}
    const ag = s.agent;
    document.getElementById('monAgent').innerHTML =
      'LLM 可達：' + (ag.llmReachable ? '<span style="color:#67c23a">是</span>' : '<span style="color:#f56c6c">否</span>') + '<br>' +
      '自動監管：' + (ag.autoSuperviseOn ? '<span style="color:#67c23a">運行中</span>' : '<span style="color:#e6a23c">關閉</span>') + '<br>' +
      '最後探活：' + (ag.lastCallAt ? new Date(ag.lastCallAt).toLocaleTimeString('zh-TW') : '-') + '<br>' +
      '最後監管：' + (ag.lastSuperviseAt ? new Date(ag.lastSuperviseAt).toLocaleTimeString('zh-TW') : '-') + '<br>' +
      '錯誤計數：' + ag.errorCount + '<br>' +
      '<div style="margin-top:6px;color:#a3a6ad">' + esc(ag.summary) + '</div>' +
      (ag.suggestions.length ? '<div style="margin-top:6px"><b>建議：</b><br>' + ag.suggestions.map(function(x) { return '• ' + esc(x); }).join('<br>') + '</div>' : '');
    document.getElementById('monErrors').innerHTML = (s.recentErrors.length
      ? s.recentErrors.map(function(e) {
          return '[' + e.time + '] ' + e.level.toUpperCase() + ' [' + esc(e.module) + '] ' + esc(e.message);
        }).join('<br>')
      : '<span style="color:#67c23a">暫無錯誤</span>');
    document.getElementById('monTput').textContent = s.taskThroughput.lastMinute;
    document.getElementById('monTasks').innerHTML = (s.taskThroughput.recent.length
      ? s.taskThroughput.recent.map(function(t) {
          return '• ' + esc((t.time || '').replace('T', ' ').slice(0, 16)) + ' ｜ ' + esc(t.scope) + ' ｜ ' + esc(t.type) + ' ｜ ' + esc(t.status);
        }).join('<br>')
      : '<span style="color:#a3a6ad">暫無任務記錄</span>');
    // OpenClaw 实时感知：账号状态快照 + 接管/聊天事件
    try {
      const pr = await fetch('/api/perception');
      const pj = await pr.json();
      const per = pj.perception || {};
      const evs = pj.events || [];
      let html = '<div style="margin-bottom:6px"><b>账号实时状态：</b></div>';
      const ids = Object.keys(per);
      if (!ids.length) html += '<span style="color:#a3a6ad">暂无知覺</span>';
      else ids.forEach(function(k){ const st = per[k]; html += '• ' + esc(k) + '：' + esc(st.status || '') + (st.currentTask ? ' ｜ 執行:' + esc(st.currentTask) : '') + (st.lastFriend ? ' ｜ 最近:' + esc(st.lastFriend) : '') + '<br>'; });
      html += '<div style="margin-top:8px"><b>最近事件：</b></div>';
      evs.slice().reverse().slice(0, 12).forEach(function(e){ html += '[' + fmtLogTime(e.ts) + '] ' + esc(e.type) + (e.friend ? (' ｜ ' + esc(e.friend)) : '') + (e.message ? ('：' + esc(e.message).slice(0, 30)) : '') + '<br>'; });
      const pel = document.getElementById('monPerception'); if (pel) pel.innerHTML = html;
    } catch (e) {}
  } catch (e) {}
}
function startMonitorPoll() { if (monitorTimer) return; loadMonitor(); monitorTimer = setInterval(loadMonitor, 3000); }
function stopMonitorPoll() { if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; } }

// 日志轮询
async function pollLogs(){
  try{ const r=await fetch('/api/logs'); const j=await r.json(); const box=document.getElementById('logBox'); box.innerHTML=(j.logs||[]).slice().reverse().map(function(l){ return '['+fmtLogTime(l.time)+'] '+esc(l.level)+' '+esc(l.message); }).join('<br>'); box.scrollTop=box.scrollHeight; }catch(e){}
}
setInterval(pollLogs, 2500);

(async function(){
  const h=await (await fetch('/api/health')).json();
  document.title='FB多账号自动化工具｜'+(h.mock?'Mock':'真实FB');
  loadAccounts();
  pollLogs();
})();

// ---------- 技能中心（功能 = OpenClaw 技能，點擊即可調用） ----------
async function loadSkills(){
  const r=await fetch('/api/skills'); const j=await r.json();
  const skills=j.skills||[];
  window._skills=skills;
  const tb=document.getElementById('skillBody');
  tb.innerHTML=skills.map(function(s, i){
    return '<tr>'
      +'<td>'+esc(s.name)+'</td>'
      +'<td>'+esc(s.category)+'</td>'
      +'<td style="color:#a3a6ad">'+esc(s.description)+'</td>'
      +'<td>'+s.usageCount+'</td>'
      +'<td>'+(s.lastUsed?new Date(s.lastUsed).toLocaleString('zh-TW'):'-')+'</td>'
      +'<td>'+(s.enabled?'<span style="color:#67c23a">啟用</span>':'<span style="color:#f56c6c">停用</span>')+'</td>'
      +'<td><button class="btn-dark" onclick="toggleSkill('+i+')">'+(s.enabled?'停用':'啟用')+'</button> '
      +'<button class="btn-primary" '+(s.enabled?'':'disabled style="opacity:.5"')+' onclick="execSkill('+i+')">執行</button></td>'
      +'</tr>';
  }).join('') || '<tr><td colspan="7" style="color:#a3a6ad">暂无技能</td></tr>';
}
async function toggleSkill(i){
  const s=window._skills && window._skills[i]; if(!s) return;
  await fetch('/api/skills/'+s.id+'/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!s.enabled})});
  loadSkills();
}
async function execSkill(i){
  const s=window._skills && window._skills[i]; if(!s) return;
  const type=s.taskType;
  if(!selectedAccounts || !selectedAccounts.length){ toast('请先在「账号环境管理」勾选账号'); return; }
  toast('執行技能 '+type+' 於 '+selectedAccounts.length+' 個帳號...');
  for(const acc of selectedAccounts){
    try{ await fetch('/api/task/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:acc,type:type,params:{}})}); }catch(e){}
  }
  toast('技能執行完成'); loadSkills();
}

// ---------- 记忆体（账号记忆碎片 + 全局知识库） ----------
async function loadMemory(){
  const r=await fetch('/api/memory/shards'); const j=await r.json();
  const shards=j.shards||[];
  window._shards=shards.map(function(s){ return s.accountId; });
  const tb=document.getElementById('shardBody');
  tb.innerHTML=shards.map(function(s, i){
    return '<tr>'
      +'<td>'+esc(s.accountId)+'</td>'
      +'<td>'+s.facts+'</td>'
      +'<td>'+s.important+'</td>'
      +'<td>'+s.recent+'</td>'
      +'<td>'+s.relationships+'</td>'
      +'<td><button class="btn-dark" onclick="viewShardIdx('+i+')">查看</button></td>'
      +'</tr>';
  }).join('') || '<tr><td colspan="6" style="color:#a3a6ad">暂无记忆碎片</td></tr>';
  const gk=document.getElementById('globalKnowledge'); if(gk) gk.value=(j.global||'');
}
function viewShardIdx(i){ const id=window._shards && window._shards[i]; if(id) viewShard(encodeURIComponent(id)); }
async function viewShard(encId){
  const aid=decodeURIComponent(encId);
  const r=await fetch('/api/memory/shard/'+encodeURIComponent(aid)); const j=await r.json();
  alert('账号 '+aid+' 的压缩上下文（提供给 OpenClaw）：\\n\\n'+(j.context||''));
}
</script>
</body>
</html>`;
}

// ---------- OpenClaw 網關自管理 ----------
let gatewayProc: any = null;
async function ensureOpenClawGateway() {
  const reachable = await new Promise<boolean>((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: 18789 }, () => { try { sock.destroy(); } catch {} resolve(true); });
    sock.on('error', () => { try { sock.destroy(); } catch {} resolve(false); });
    sock.setTimeout(1500, () => { try { sock.destroy(); } catch {} resolve(false); });
  });
  if (reachable) { log('Gateway', ':18789 已存在，跳過啟動'); return; }
  const cli = path.join(process.cwd(), 'node_modules', 'openclaw', 'openclaw.mjs');
  try {
    // 把使用者設定的 DeepSeek 金鑰注入網關啟動環境。
    // 新版 OpenClaw 不允許把 apiKey 寫進 openclaw.json（schema 禁止），
    // 改由環境變數 DEEPSEEK_API_KEY 在網關執行時被讀取為憑證（runtime 外部 profile）。
    const gatewayEnv = { ...process.env };
    const ocSettings = getOpenClawSettings();
    if (ocSettings.apiKey) gatewayEnv.DEEPSEEK_API_KEY = ocSettings.apiKey;
    gatewayProc = spawn(process.execPath, [cli, 'gateway'], { env: gatewayEnv, windowsHide: true });
    gatewayProc.on('error', (e: any) => log('Gateway', '啟動失敗: ' + e.message));
    gatewayProc.on('exit', (c: any) => { if (gatewayProc) log('Gateway', '進程結束 code=' + c); });
    log('Gateway', '已嘗試啟動 OpenClaw 網關 (:18789)');
  } catch (e: any) { log('Gateway', '啟動異常: ' + e.message); }
}
function stopOpenClawGateway() {
  if (gatewayProc) { try { gatewayProc.kill(); } catch {} gatewayProc = null; log('Gateway', '已關閉網關'); }
}

// ---------- 啟動 ----------
// 監聽錯誤處理：端口被佔用（Windows TIME_WAIT 常見）時自行重試綁定，而非崩潰；
// 其它錯誤才退出。這讓服務端在監管重啟瞬間能自愈，不會因 TIME_WAIT 拋 EADDRINUSE。
let listenAttempts = 0;
async function onListening() {
  // 接管全域 console → 結構化日誌（/api/logs 與監控統一日誌源）
  installConsoleCapture();
  // 把已持久化的代理分配同步到 SOCKS5 本地轉發池，讓 Chromium 可用
  try {
    await getProxyManager().init();
    log('Proxy', '代理分配已同步到 SOCKS5 本地轉發池');
  } catch (e: any) {
    log('Proxy', '轉發池同步失敗: ' + e.message);
  }
  // 全局監控 + OpenClaw Agent 自動監管循環
  startMonitor(5000);
  startAgentAutoSupervise(5 * 60 * 1000);
  // 會話看門狗：實時巡檢活躍視窗，檢測卡頓 / checkpoint / 浮層並智能恢復
  startSessionWatchdog(20000);
  // 自起 OpenClaw 網關（智能體本體），關閉時隨服務回收
  ensureOpenClawGateway();
  // 被動接管監控（OpenClaw 被動觸發：帳號開始聊天即接管回覆，含一級介紹）
  startPassiveMonitor(90 * 1000);
  log('Server', `API 已啟動 http://localhost:${API_PORT}`);
  log('Server', `Dashboard http://localhost:${API_PORT}/dashboard`);
  if (MOCK_FB) log('Server', `Mock FB http://${FB_BASE}`);
}

function tryListen() {
  listenAttempts++;
  server.listen(API_PORT, onListening);
}

server.on('error', (e: any) => {
  if (e?.code === 'EADDRINUSE' && listenAttempts < 30) {
    log('Server', `端口 ${API_PORT} 被佔用（TIME_WAIT），1s 後重試綁定（第 ${listenAttempts} 次）`);
    setTimeout(tryListen, 1000);
  } else {
    console.error('[Server] 監聽錯誤:', e?.message || e);
    process.exit(1);
  }
});

tryListen();

// 優雅關閉
async function shutdown() {
  log('Server', '正在關閉監控與 sessions...');
  stopMonitor();
  stopAgentAutoSupervise();
  stopSessionWatchdog();
  stopPassiveMonitor();
  stopOpenClawGateway();
  await closeAllSessions();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
