/**
 * Aike-FBclaw Server — 完整 API + OpenClaw Gateway
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { execSync } from 'child_process';
import * as net from 'net';
import { getBrowserManager } from './core/browser/profile-manager.js';
import { getFingerprintEngine } from './core/browser/fingerprint.js';
import { getSocks5Pool } from './core/proxy/socks5-pool.js';
import { generateTOTP } from './core/utils/totp.js';
import { FbClawApp } from './index.js';

const PORT = 18991;
const app = new FbClawApp();
const pool = getSocks5Pool();

// 启动时自动加载代理 + 全部分配
const proxyFile = 'C:/Users/UR/Downloads/proxyList.txt';
const imported = pool.importFile(proxyFile);
console.log(`[Pool] 已导入 ${imported} 个代理`);

// 自动分配：每个账号一个独立代理
async function autoAssignAllProxies() {
  const profiles = browserMgr.getAllProfiles();
  const proxies = pool.list();
  let assigned = 0;
  for (let i = 0; i < profiles.length && i < proxies.length; i++) {
    try {
      await pool.assignToAccount(proxies[i].id, profiles[i].accountId);
      assigned++;
    } catch {}
  }
  console.log(`[Pool] 自动分配 ${assigned}/${profiles.length} 个代理`);
  return assigned;
}

// 2FA 数据库：从 order 文件中加载
const twofaDB: Map<string, string> = new Map();
function load2FAData() {
  const dir = 'C:/Users/UR/Downloads';
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.startsWith('order') && f.endsWith('.txt'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    for (const line of content.split('\n')) {
      const parts = line.split('\t');
      if (parts.length >= 3 && parts[0].includes('@')) {
        const email = parts[0].trim();
        const twofa = parts[2]?.trim();
        if (twofa && /^[A-Z0-9\s]{20,60}$/.test(twofa)) {
          twofaDB.set(email.toLowerCase(), twofa);
        }
      }
    }
  }
  console.log(`[2FA] 加载 ${twofaDB.size} 个验证密钥`);
}
load2FAData();
const browserMgr = getBrowserManager();
const fp = getFingerprintEngine();

// OpenClaw Gateway — 只管理进程，不存储/传递 API Key（由 OpenClaw 自己的配置管理）
let gatewayProc: cp.ChildProcess | null = null;
function startGateway() {
  if (gatewayProc) return;
  const ocBin = path.resolve('node_modules/.bin/openclaw.cmd');
  if (!fs.existsSync(ocBin)) { console.log('[GW] openclaw not found'); return; }
  console.log('[GW] Starting...');
  gatewayProc = cp.spawn('cmd.exe', ['/c', ocBin, 'gateway'], {
    env: process.env,  // 不注入任何额外的 API Key
    stdio: 'ignore',
  });
}

function stopGateway() {
  if (gatewayProc) { gatewayProc.kill(); gatewayProc = null; console.log('[GW] Stopped'); }
  try { execSync('taskkill /F /FI "WINDOWTITLE eq OpenClaw*"', { stdio: 'ignore' }); } catch {}
}

// OpenClaw Chat
// === AI Chat — 全通过 OpenClaw Gateway WebSocket Agent 协议 ===
// DeepSeek API Key 仅存在于 OpenClaw 配置中，此处只做消息中继
import * as crypto from 'crypto';
const OC_TOKEN = process.env.OC_API_KEY || process.env.DEEPSEEK_API_KEY || '';

function ocSend(socket: any, data: string) {
  const p = Buffer.from(data, 'utf-8');
  const m = crypto.randomBytes(4);
  const mp = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) mp[i] = p[i] ^ m[i % 4];
  socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), m, mp]));
}

interface OCState {
  socket: any;
  connected: boolean;
  pending: Map<string, { resolve: (s: string) => void; timeout: NodeJS.Timeout }>;
  rxBuf: Buffer;
  msgId: number;
}
let oc: OCState | null = null;

function ocConnect() {
  if (oc) return;
  const key = crypto.randomBytes(16).toString('base64');
  const req = http.request({
    hostname: '127.0.0.1', port: 18789, path: '/', method: 'GET',
    headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
  });
  req.on('upgrade', (_res, socket) => {
    const state: OCState = { socket, connected: false, pending: new Map(), rxBuf: Buffer.alloc(0), msgId: 1 };
    oc = state;

    socket.on('data', (d: Buffer) => {
      state.rxBuf = Buffer.concat([state.rxBuf, d]);
      while (state.rxBuf.length >= 2) {
        let len = state.rxBuf[1] & 0x7F, off = 2;
        if (len === 126) { if (state.rxBuf.length < 4) break; len = (state.rxBuf[2] << 8) | state.rxBuf[3]; off = 4; }
        else if (len === 127) break; // skip 64-bit for now
        if (state.rxBuf.length < off + len) break;
        const raw = state.rxBuf.slice(off, off + len).toString('utf-8');
        state.rxBuf = state.rxBuf.slice(off + len);
        try {
          const m = JSON.parse(raw);
          if (m.type === 'event' && m.event === 'connect.challenge') {
            const cid = 'c' + state.msgId++;
            ocSend(socket, JSON.stringify({
              type: 'req', id: cid, method: 'connect',
              params: { minProtocol: 4, maxProtocol: 4, client: { id: 'aike-fbclaw', version: '1.0', platform: 'windows', mode: 'operator' }, role: 'operator', scopes: ['operator.read', 'operator.write'] }
            }));
            console.log('[OC] 已发送 connect');
          } else if (m.type === 'res' && m.ok && m.payload?.type === 'hello-ok') {
            state.connected = true;
            console.log('[OC] 已连接');
          } else if (m.type === 'res' && !m.ok) {
            console.log('[OC] 失败:', JSON.stringify(m.error || m).slice(0, 100));
          } else if (m.type === 'event' && m.payload?.text) {
            const text = m.payload.text || m.payload.content || '';
            if (text && state.pending.size > 0) {
              const [id, p] = [...state.pending.entries()][0];
              state.pending.delete(id);
              clearTimeout(p.timeout);
              p.resolve(text);
            }
          }
        } catch {}
      }
    });
    socket.on('close', () => { oc = null; });
    socket.on('error', () => { oc = null; });

    // 立即发送 connect（无认证，gateway.auth.mode=none）
    const cid = 'c' + state.msgId++;
    ocSend(socket, JSON.stringify({
      type: 'req', id: cid, method: 'connect',
      params: { minProtocol: 4, maxProtocol: 4, client: { id: 'aike-fbclaw', version: '1.0', platform: 'windows', mode: 'operator' }, role: 'operator', scopes: ['operator.read', 'operator.write'] }
    }));
    socket.on('close', () => { oc = null; });
    socket.on('error', () => { oc = null; });
  });
  req.on('error', () => {});
  req.end();
}

function sendToOCAgent(message: string): Promise<string> {
  return new Promise((resolve) => {
    if (!oc || !oc.connected) {
      if (!oc) ocConnect();
      setTimeout(() => {
        if (oc?.connected) {
          sendNow(resolve, message);
        } else {
          resolve('OpenClaw Agent 正在连接中，请稍候再试');
        }
      }, 3000);
      return;
    }
    sendNow(resolve, message);
  });
}

function sendNow(resolve: (s: string) => void, message: string) {
  if (!oc) return;
  const id = 'm' + oc.msgId++;
  const timeout = setTimeout(() => {
    oc!.pending.delete(id);
    resolve('（OpenClaw Agent 回应超时）');
  }, 60000);
  oc.pending.set(id, { resolve, timeout });
  ocSend(oc.socket, JSON.stringify({
    type: 'req', id, method: 'chat.send',
    params: { content: message }
  }));
}

ocConnect();

// 状态追踪
const accountStates: Map<string, any> = new Map();
const taskQueue: any[] = [];
const eventLog: { time: string; level: string; msg: string }[] = [];

function addLog(level: string, msg: string) {
  const now = new Date().toLocaleTimeString('zh-TW');
  eventLog.unshift({ time: now, level, msg });
  if (eventLog.length > 500) eventLog.pop();
}

async function handleAPI(url: string, method: string, body: string): Promise<any> {
  // 去掉 query string
  const cleanUrl = url.split('?')[0];
  const p = cleanUrl.replace('/api/', '').replace(/\/$/, '');

  // === 系统状态 ===
  if (p === 'status' || p === '') {
    return {
      profiles: browserMgr.getAllProfiles().length,
      activeBrowsers: browserMgr.getActiveCount(),
      activeIds: browserMgr.getActiveIds(),
      engine: 'OpenClaw 2026.7.1-2 + DeepSeek Provider',
      apiKeyConfigured: false,  // API Key 由 OpenClaw 配置管理，不在此处存储
      gatewayRunning: !!gatewayProc,
    };
  }

  // === 实时日志 ===
  if (p === 'logs') {
    const limit = parseInt(new URLSearchParams(url.split('?')[1] || '').get('limit') || '50');
    return eventLog.slice(0, limit);
  }

  // === 告警 ===
  if (p === 'alerts') {
    const alerts: any[] = [];
    for (const [id, state] of accountStates) {
      if (state.status === 'error' || state.warnings?.length > 0) {
        alerts.push({ accountId: id, name: state.name, status: state.status, warnings: state.warnings || [] });
      }
    }
    return alerts;
  }

  // === Profile 管理 ===
  if (p === 'profiles') {
    if (method === 'GET') return browserMgr.getAllProfiles();
    if (method === 'POST') {
      const cfg = JSON.parse(body);
      const profile = browserMgr.createProfile(cfg);
      addLog('info', `创建配置: ${cfg.name}`);
      return profile;
    }
  }

  if (p === 'profiles/import' && method === 'POST') {
    const { accounts: accts } = JSON.parse(body);
    const results: any[] = [];
    for (const a of accts) {
      try {
        const profile = browserMgr.createProfile({
          accountId: a.accountId || 'acc_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
          name: a.name || a.email || 'Unknown',
          proxy: a.proxy,
        });
        accountStates.set(profile.accountId, { name: profile.name, status: 'offline', pageType: '-', proxy: a.proxy || '-', actions: 0, warnings: [], password: a.password || '', email: a.email || a.name || '' });
        results.push({ id: profile.accountId, name: profile.name, ok: true });
      } catch (e: any) {
        results.push({ name: a.name, ok: false, error: e.message });
      }
    }
    addLog('success', `导入 ${results.filter(r=>r.ok).length} 个账号`);
    return results;
  }

  // === 浏览器控制 ===
  if (p === 'browser/start' && method === 'POST') {
    const { accountId } = JSON.parse(body);
    try {
      const profile = browserMgr.getProfile(accountId);
      const displayName = profile?.name || accountId;
      const proxyStr = pool.getProxyString(accountId);
      
      // 启动浏览器时设置窗口标题
      const inst = await browserMgr.launchBrowser(accountId, { 
        name: displayName, 
        proxy: proxyStr,
      });
      
      // 设置页面标题
      if (inst.page) {
        try {
          const idShort = accountId.slice(-6);
          await inst.page.evaluate(({name, id}) => {
            document.title = `📱 ${name} | FBclaw`;
            if (window.top === window) {
              const badge = document.createElement('div');
              badge.id = 'fbclaw-badge';
              badge.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#1a1a2e;color:#1d9bf0;padding:4px 12px;font-size:12px;font-family:sans-serif;display:flex;justify-content:space-between;pointer-events:none';
              badge.textContent = `📱 ${name} (${id}) | Proxy: ${proxyStr ? '🟢' : '⚪'}`;
              document.body.prepend(badge);
              document.body.style.paddingTop = '28px';
            }
          }, { name: displayName, id: idShort });
        } catch {}
      }
      
      const state = accountStates.get(accountId);
      if (state) { state.status = 'idle'; state.pageType = 'facebook.com'; }
      addLog('success', `启动: ${displayName}`);
      return { ok: true, accountId, proxy: proxyStr };
    } catch (e: any) {
      addLog('error', `启动失败: ${accountId}`);
      return { ok: false, error: e.message };
    }
  }

  if (p === 'browser/stop' && method === 'POST') {
    const { accountId } = JSON.parse(body);
    try {
      await browserMgr.closeBrowser(accountId);
      const state = accountStates.get(accountId);
      if (state) state.status = 'offline';
      addLog('info', `关闭浏览器: ${accountId}`);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  if (p === 'browser/stop-all' && method === 'POST') {
    await browserMgr.closeAll();
    for (const [,s] of accountStates) s.status = 'offline';
    addLog('info', '关闭所有浏览器');
    return { ok: true };
  }

  if (p === 'browser/screenshot' && method === 'POST') {
    const { accountId } = JSON.parse(body);
    const inst = browserMgr.getInstance(accountId);
    if (!inst || !inst.page) return { ok: false, error: '浏览器未启动' };
    const filePath = path.join('G:/Aike-FBclaw/data/screenshots', `viewport_check_${Date.now()}.png`);
    await inst.page.screenshot({ path: filePath });
    const vi = await inst.page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      docClientWidth: document.documentElement.clientWidth,
      docClientHeight: document.documentElement.clientHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
    }));
    return { ok: true, file: filePath, viewport: vi };
  }

  // === 任务（真实执行） ===
  if (p === 'task/add' && method === 'POST') {
    const { accountIds, type, params } = JSON.parse(body);
    const taskIds: string[] = [];
    for (const id of accountIds) {
      const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
      taskQueue.push({ id: taskId, accountId: id, type, params: params || {}, status: 'pending', createdAt: Date.now() });
      taskIds.push(taskId);
      const state = accountStates.get(id);
      if (state) state.status = 'running';
    }
    addLog('info', `添加任务: ${type} x${accountIds.length}`);
    // 异步执行真实操作
    executeTasks(accountIds, type, params, taskIds);
    return { ok: true, queued: accountIds.length, taskIds };
  }

  if (p === 'tasks') {
    return taskQueue.slice(-100);
  }

  // === 账号状态 ===
  // === 账号管理 ===
  if (p === 'accounts/sync' && method === 'POST') {
    // 清空，只保留指定的好号
    accountStates.clear();
    const good = JSON.parse(body).good || [];
    for (const name of good) {
      const dir = path.join('G:/Aike-FBclaw/data/browser-profiles', name);
      if (fs.existsSync(dir)) {
        accountStates.set(name, { name, status: 'offline', pageType: '-', proxy: '-', actions: 0 });
      }
    }
    addLog('info', `同步账号: ${accountStates.size}个`);
    return { ok: true, count: accountStates.size };
  }

  if (p === 'account-states') {
    const result: any[] = [];
    for (const [id, state] of accountStates) {
      result.push({
        id, name: state.name, status: state.status,
        pageType: state.pageType, proxy: state.proxy,
        actions: state.actions, warnings: state.warnings,
        group: state.group, errorCount: state.errorCount,
        fingerprint: 'active',
      });
    }
    // 如果状态表为空，从 profiles 重建
    if (result.length === 0) {
      const profiles = browserMgr.getAllProfiles();
      const extrasPath = 'G:/Aike-FBclaw/data/account-extras.json';
      let extras: any = {};
      if (fs.existsSync(extrasPath)) extras = JSON.parse(fs.readFileSync(extrasPath, 'utf-8'));
      
      for (const p of profiles) {
        const ex = extras[p.accountId] || {};
        if (!accountStates.has(p.accountId)) {
          accountStates.set(p.accountId, {
            name: ex.name || p.name, status: p.status, pageType: '-',
            proxy: p.proxy || '-', actions: 0, warnings: [],
            group: ex.group, errorCount: ex.errorCount || 0,
          });
        }
        const s = accountStates.get(p.accountId)!;
        result.push({
          id: p.accountId, name: s.name, status: s.status,
          pageType: s.pageType, proxy: s.proxy,
          actions: s.actions, warnings: s.warnings,
          fingerprint: 'active',
        });
      }
    }
    return result;
  }

  // === 指纹 ===
  if (p === 'fingerprint/generate' && method === 'POST') {
    const { accountId } = JSON.parse(body);
    const f = fp.generate(accountId);
    return f;
  }

  // === AI Chat — 100% 走 OpenClaw Gateway Agent WebSocket ===
  if (p === 'chat' && method === 'POST') {
    const { message } = JSON.parse(body);
    const reply = await sendToOCAgent(message);
    return { text: reply };
  }

  // === Gateway 控制 ===
  if (p === 'gateway/start' && method === 'POST') { startGateway(); return { ok: true }; }
  if (p === 'gateway/stop' && method === 'POST') { stopGateway(); return { ok: true }; }
  if (p === 'gateway/status') {
    try { const r = await fetch('http://127.0.0.1:18789/health', { signal: AbortSignal.timeout(2000) }); return { running: r.ok }; }
    catch { return { running: false }; }
  }

  // === 代理池 ===
  if (p === 'proxy/list') {
    return pool.list();
  }
  if (p === 'proxy/import' && method === 'POST') {
    const { filePath } = JSON.parse(body);
    const count = pool.importFile(filePath);
    return { ok: true, imported: count };
  }
  if (p === 'proxy/assign' && method === 'POST') {
    const { proxyId, accountId } = JSON.parse(body);
    const proxyStr = await pool.assignToAccount(proxyId, accountId);
    return { ok: true, proxy: proxyStr };
  }
  if (p === 'proxy/unassign' && method === 'POST') {
    pool.deactivateProxy(JSON.parse(body).proxyId);
    return { ok: true };
  }
  if (p === 'proxy/assignments') {
    return pool.getAssignments();
  }

  // === 账号详情/编辑 ===
  // === 账号详情/编辑/删除 ===
  if (p.startsWith('account/') && method === 'GET') {
    const accountId = p.replace('account/', '');
    const profile = browserMgr.getProfile(accountId);
    const state = accountStates.get(accountId);
    const pxStr = pool.getProxyString(accountId);
    const twofaSecret = (profile?.name && twofaDB.get(profile.name.toLowerCase())) || '';
    let twofaCode = '';
    if (twofaSecret) {
      const { code } = generateTOTP(twofaSecret);
      twofaCode = code;
    }
    return {
      ...profile,
      status: state?.status || 'offline',
      pageType: state?.pageType || '-',
      actions: state?.actions || 0,
      proxyString: pxStr || null,
      twofaCode,
    };
  }
  if (p === 'account/delete' && method === 'POST') {
    const { accountId } = JSON.parse(body);
    await browserMgr.deleteProfile(accountId);
    accountStates.delete(accountId);
    pool.deactivateProxy(accountId);
    return { ok: true };
  }

  // === 2FA ===
  if (p === '2fa/code') {
    const accountId = new URLSearchParams(url.split('?')[1] || '').get('accountId') || '';
    const profile = browserMgr.getProfile(accountId);
    const email = profile?.name || accountId;
    const secret = twofaDB.get(email.toLowerCase()) || '';
    if (secret) {
      const { code, remaining } = generateTOTP(secret);
      return { code, remaining, email };
    }
    return { code: '', remaining: 0 };
  }

  // === 代理自动分配 ===
  if (p === 'proxy/auto-assign' && method === 'POST') {
    const assigned = await autoAssignAllProxies();
    return { ok: true, assigned };
  }

  // === 系统重启 ===
  if (p === 'system/restart' && method === 'POST') {
    // 延迟 1s 后重启，确保响应已发送
    setTimeout(() => {
      const args = process.argv.slice(1);
      cp.spawn(process.execPath, args, { detached: true, stdio: 'inherit' });
      process.exit(0);
    }, 1000);
    return { ok: true, message: '服务器将在1秒后重启' };
  }

  return { error: 'unknown api: ' + p };
}

// HTTP Server
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  const url = req.url || '/';
  if (url.startsWith('/api/')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const result = await handleAPI(url, req.method || 'GET', body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  let fp2 = url === '/' ? '/dashboard.html' : url;
  fp2 = path.join('G:/Aike-FBclaw/ui', fp2);
  try {
    if (fs.existsSync(fp2) && fs.statSync(fp2).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp2)] || 'text/plain' });
      res.end(fs.readFileSync(fp2));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync('G:/Aike-FBclaw/ui/dashboard.html'));
    }
  } catch { res.writeHead(404); res.end('Not Found'); }
});

// ====== 真实任务执行器（串行队列，避免Profile锁冲突）======
const taskLocks: Map<string, Promise<void>> = new Map();

async function executeTasks(accountIds: string[], type: string, params: any, taskIds: string[]) {
  const { chromium } = await import('playwright-core');
  
  for (let i = 0; i < accountIds.length; i++) {
    const accountId = accountIds[i];
    const taskId = taskIds[i];
    
    // 等待该账号的上一个任务完成
    const prevLock = taskLocks.get(accountId) || Promise.resolve();
    const newLock = prevLock.then(() => executeSingleTask(chromium, accountId, type, params, taskId));
    taskLocks.set(accountId, newLock);
  }
}

async function executeSingleTask(chromium: any, accountId: string, type: string, params: any, taskId: string) {
    const task = taskQueue.find(t => t.id === taskId);
    if (!task) return;
    
    // 跳过异常账号
    const st = accountStates.get(accountId);
    if (st && (st.status === 'banned' || st.errorCount >= 3)) {
      task.status = 'skipped'; task.result = '账号异常已暂停';
      addLog('warn', `⚠️ 跳过异常号: ${accountId}`);
      return;
    }
    
    task.status = 'running';
    
    try {
      const profile = browserMgr.getProfile(accountId);
      const dataDir = profile?.dataDir || path.join('G:/Aike-FBclaw/data/browser-profiles', accountId);
      if (!fs.existsSync(dataDir)) { task.status = 'failed'; task.result = '目录不存在'; return; }
      
      const statePath = path.join(dataDir, 'state.json');
      const hasState = fs.existsSync(statePath);
      
      const ctx = await chromium.launchPersistentContext(dataDir, {
        headless: true,
        viewport: { width: 1366, height: 768 },
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', 
               `--window-name=FB_${accountId.slice(-10)}`],
        locale: 'zh-TW', timezoneId: 'Asia/Taipei',
      });
      
      // 注入指纹保护（后台任务必须有）
      const fpConfig = profile?.fingerprint;
      if (fpConfig) {
        const fp = getFingerprintEngine();
        await ctx.addInitScript(fp.buildInitScript(fpConfig));
      }
      if (hasState) {
        try {
          const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
          if (state.cookies) await ctx.addCookies(state.cookies.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain || '.facebook.com', path: c.path || '/' })));
        } catch {}
      }
      
      const page = await ctx.newPage();
      // 注入弹窗两步处理器
      await page.addInitScript(() => {
        let handled = false;
        const observer = new MutationObserver(() => {
          if (handled) return;
          const d = document.querySelector('div[role="dialog"]');
          if (!d) return;
          const t = d.textContent || '';
          if (t.includes('分享對象') || t.includes('預設分享') || t.includes('Reel')) {
            // 第1步：确认政策
            const btns = d.querySelectorAll('div[role="button"]');
            for (const b of btns) {
              const txt = b.textContent?.trim() || '';
              if (txt === '確定' || txt === '繼續' || txt === '下一步' || txt === '了解') { (b as HTMLElement).click(); handled = true; return; }
            }
            d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            handled = true;
          }
          // 第2步：受众选择弹窗
          if (t.includes('選擇') && t.includes('分享對象')) {
            const btns = d.querySelectorAll('div[role="button"]');
            for (const b of btns) {
              const txt = b.textContent?.trim() || '';
              if (txt === '完成' || txt === '儲存') { (b as HTMLElement).click(); return; }
            }
            d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
      } catch (e: any) {
        console.log(`[TASK] goto 超时但继续: ${accountId}`);
      }
      await page.waitForTimeout(5000);
      
      // 密码自动填充（如果未登录，自动填登录表单并提交）
      const savedPass = accountStates.get(accountId)?.password || '';
      const savedEmail = accountStates.get(accountId)?.email || '';
      if (savedPass && savedEmail) {
        await page.type('input[name="email"]', savedEmail, { delay: 30 });
        await page.type('input[name="pass"]', savedPass, { delay: 30 });
        await page.waitForTimeout(500);
        await page.click('div[role="button"]:has-text("登录")');
        await page.waitForTimeout(10000);
        // 处理2FA审批 → 尝试其他方式
        const tryOther = await page.$('span:has-text("試試其他方式"), a:has-text("其他"), span:has-text("Try another")');
        if (tryOther) { await tryOther.click(); await page.waitForTimeout(2000); }
        // 如果到了验证码输入页，填TOTP
        const codeInput = await page.$('input[name="approvals_code"], input[placeholder*="驗證"]');
        if (codeInput) {
          const totpSecret = twofaDB.get(accountId);
          const totpResult = totpSecret ? generateTOTP(totpSecret) : null;
          if (totpResult) { await codeInput.fill(totpResult.code); await page.waitForTimeout(2000); await page.keyboard.press('Enter'); await page.waitForTimeout(5000); }
        }
        await page.waitForTimeout(3000);
      }
      
      const cs = await ctx.cookies();
      const cUser = cs.find(c => c.name === 'c_user');
      
      // 提取FB显示名称
      if (cUser) {
        try {
          const fbName = await page.evaluate(() => {
            const el = document.querySelector('a[aria-label*="個人檔案"], div[aria-label*="個人"] span, h1 span, a[href*="/profile"] span');
            if (el) return el.textContent?.trim();
            const title = document.title;
            return title?.replace(/^\(?\d+\)?\s*/, '').replace('Facebook', '').trim();
          });
          if (fbName && fbName.length > 1) {
            const state = accountStates.get(accountId);
            if (state && state.name !== fbName) { state.name = fbName; addLog('info', `提取名称: ${accountId} → ${fbName}`); }
          }
        } catch {}
      }
      
      if (!cUser) {
        task.status = 'failed'; task.result = '未登录';
        await ctx.close(); return;
      }
      
      let result = '';
      
      console.log('[TASK] type=', type, 'params=', JSON.stringify(params).slice(0,60));
      switch (type) {
        case 'check_status':
          result = `已登录 UID:${cUser.value}`;
          addLog('success', `检测: ${accountId} 正常`);
          break;
          
        case 'chain':
          // 任务链：依次执行每个步骤
          if (params?.steps && Array.isArray(params.steps)) {
            const steps: string[] = params.steps;
            result = `链-${steps.length}步`;
            for (let si = 0; si < steps.length; si++) {
              const st = steps[si];
              result += ` | ${st}=`;
              try {
                // 同一个页面执行多步操作，用函数调用复用 switch
                if (st === 'browse_home') {
                  for (let j = 0; j < 3; j++) { await page.evaluate(() => window.scrollBy(0, 800)); await page.waitForTimeout(1000 + Math.random() * 500); }
                  result += 'done';
                } else if (st === 'like_posts') {
                  const btn = await page.$('[aria-label="讚"]');
                  if (btn) { await btn.click(); result += 'done'; } else result += 'nobtn';
                } else if (st === 'add_friends') {
                  await page.goto('https://www.facebook.com/friends/', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForTimeout(3000);
                  result += 'done';
                } else if (st === 'share_post') {
                  const btn2 = await page.$('[aria-label*="分享"]');
                  if (btn2) { await btn2.click(); result += 'done'; } else result += 'nobtn';
                } else {
                  result += 'skip';
                }
                addLog('info', `任务链[${si+1}/${steps.length}]: ${accountId} → ${st} → ${result.split('|').pop()}`);
              } catch (e: any) { result += `err:${e.message.slice(0,20)}`; }
            }
          } else { result = '无步骤'; }
          break;
          
        case 'browse_home':
          for (let j = 0; j < 3; j++) {
            await page.evaluate(() => window.scrollBy(0, 800));
            await page.waitForTimeout(1500 + Math.random() * 1000);
          }
          result = '浏览首页完成';
          addLog('success', `浏览: ${accountId}`);
          break;
          
        case 'like_posts':
          try {
            const btn = await page.$('[aria-label="讚"], [aria-label*="赞"]');
            if (btn) { await btn.click(); await page.waitForTimeout(1000); result = '点赞成功'; }
            else result = '无可用按钮';
          } catch { result = '点赞失败'; }
          addLog('info', `点赞: ${accountId} → ${result}`);
          break;
          
        case 'add_friends':
          try {
            // 优先用搜索关键词
            if (params?.keyword) {
              const searchBox = await page.$('input[aria-label*="搜尋"], input[placeholder*="搜尋"]');
              if (searchBox) {
                await searchBox.fill(params.keyword);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(3000);
              }
            } else {
              // 无关键词：浏览建议好友
              await page.goto('https://www.facebook.com/friends/', { waitUntil: 'domcontentloaded', timeout: 15000 });
              await page.waitForTimeout(3000);
            }
            const addBtn = await page.$('[aria-label*="加好友"], [aria-label*="新增朋友"], span:has-text("加好友"), span:has-text("新增")');
            if (addBtn) { await addBtn.click(); await page.waitForTimeout(1500); result = '发送好友请求'; }
            else result = '已浏览好友建议页';
          } catch { result = '加好友失败'; }
          addLog('info', `加好友: ${accountId} → ${result}`);
          break;
          
        case 'share_post':
          try {
            if (params?.url) {
              // 分享指定链接
              await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
              await page.waitForTimeout(3000);
              const shareBtn = await page.$('[aria-label*="分享"], [aria-label*="Share"], span:has-text("分享")');
              if (shareBtn) { await shareBtn.click(); await page.waitForTimeout(1500); result = '已点击分享'; }
              else result = '页面已打开，未找到分享按钮';
            } else {
              // 浏览首页，随机分享帖子
              await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
              await page.waitForTimeout(3000);
              const shareBtn = await page.$('[aria-label*="分享"], [aria-label*="Share"]');
              if (shareBtn) { await shareBtn.click(); result = '已点击分享'; }
              else result = '已浏览首页，未找到可分享内容';
            }
          } catch { result = '分享失败'; }
          addLog('info', `分享: ${accountId} → ${result}`);
          break;
        
        case 'join_groups':
          try {
            const groupUrl = params?.url;
            if (groupUrl) { await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }); await page.waitForTimeout(3000); }
            else { await page.goto('https://www.facebook.com/groups/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForTimeout(3000); }
            const joinBtn = await page.$('[aria-label*="加入"], [aria-label*="Join"], span:has-text("加入")');
            if (joinBtn) { await joinBtn.click(); result = '已申请加入社团'; }
            else result = '已打开社团页';
          } catch { result = '加入社团失败'; }
          addLog('info', `加入社团: ${accountId} → ${result}`);
          break;
          
        case 'invite_to_group':
          try {
            const gUrl = params?.groupUrl || 'https://www.facebook.com/groups/feed/';
            await page.goto(gUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }); await page.waitForTimeout(3000);
            const inviteBtn = await page.$('[aria-label*="邀請"], span:has-text("邀請")');
            if (inviteBtn) { await inviteBtn.click(); await page.waitForTimeout(1500); result = '已发送邀请'; }
            else result = '已打开社团页';
          } catch { result = '邀请失败'; }
          addLog('info', `邀请: ${accountId} → ${result}`);
          break;
          
        case 'post_content':
          try {
            await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForTimeout(3000);
            const postBox = await page.$('span:has-text("在想些什麼"), div[role="button"]:has-text("在想")');
            if (postBox) { await postBox.click(); await page.waitForTimeout(3000); }
            // 如果有指定分享对象，选择对应受众
            if (params?.audience) {
              await page.evaluate((aud: string) => {
                const btns = document.querySelectorAll('div[role="dialog"] div[role="button"] span');
                for (const b of btns) {
                  if (b.textContent?.includes(aud)) { (b as HTMLElement).click(); break; }
                }
              }, params.audience);
              await page.waitForTimeout(1000);
            }
            const editor = await page.$('div[contenteditable="true"], div[role="textbox"]');
            if (!editor) { await page.evaluate(() => { const ed = document.querySelector('div[contenteditable="true"], div[role="textbox"]'); if (ed) { (ed as HTMLElement).focus(); } }); }
            if (params?.text) { await page.keyboard.type(params.text, { delay: 50 }); await page.waitForTimeout(2000); result = `已输入:"${params.text.slice(0,20)}"`; }
            else { result = '已打开发帖框'; }
          } catch { result = '发帖失败'; }
          addLog('info', `发帖: ${accountId} → ${result}`);
          break;
          
        case 'collect_data':
          try {
            await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }); await page.waitForTimeout(3000);
            const friendsLink = await page.$('a[href*="/friends"] span');
            const posts = await page.$$eval('div[data-ad-preview="message"]', els => els.slice(0, 5).map(e => e.textContent?.trim().slice(0,80)));
            const data = { title: await page.title(), friendCount: friendsLink ? await friendsLink.textContent() : '?', posts, time: new Date().toISOString() };
            const outPath = path.join('G:/Aike-FBclaw/data/screenshots', `fbdata_${accountId.slice(-8)}_${Date.now()}.json`);
            fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
            result = `采集: 好友=${data.friendCount} 帖子=${data.posts.length}`;
          } catch { result = '采集失败'; }
          addLog('info', `采集: ${accountId} → ${result}`);
          break;
          
        case 'content_distribute':
          try {
            const pageUrl = params?.pageUrl;
            if (!pageUrl) { result = '缺少主页URL'; break; }
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(4000);
            const posts = await page.$$eval('div[role="article"], div[data-pagelet*="FeedUnit"]', els => 
              els.slice(0, 5).map(e => ({ text: e.textContent?.trim().slice(0, 50), link: (e.querySelector('a[href*="/posts/"]') as HTMLAnchorElement)?.href }))
            ).filter(p => p.link);
            result = `检测: ${posts.length}帖`;
            if (posts.length > 0) {
              let distributed = 0;
              for (const [aid, s] of Array.from(accountStates.entries())) {
                if (aid === accountId || s.status === 'banned' || s.status === 'offline') continue;
                // 筛选：好友>50 + 活跃 + 非异常
                if (s.friendCount && s.friendCount < 50) continue;
                if (distributed >= 5) break;
                taskQueue.push({
                  id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                  accountId: aid, type: 'share_post',
                  params: { url: posts[0].link },
                  status: 'pending', createdAt: Date.now(),
                });
                distributed++;
              }
              result += ` | 分发${distributed}个号`;
            }
          } catch { result = '分发失败'; }
          addLog('info', `内容分发: ${accountId} → ${result}`);
          break;
          
        case 'ai_chat':
          try {
            await page.goto('https://www.messenger.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(5000);
            // PIN
            const pin = await page.$('input[type="password"]');
            if (pin) { await pin.fill('000000'); await page.keyboard.press('Enter'); await page.waitForTimeout(3000); }
            // 读未读消息
            const unreadEls = await page.$$('div[aria-label*="未讀"], span:has-text("未讀"), div[role="listitem"]');
            const contacts: { name: string; lastMsg: string }[] = [];
            for (let i = 0; i < Math.min(unreadEls.length, 3); i++) {
              try {
                const text = await unreadEls[i].textContent();
                if (text) contacts.push({ name: text.split('\n')[0]?.slice(0, 20), lastMsg: text.slice(-50) });
              } catch {}
            }
            result = `检测: ${contacts.length}个未读对话`;
            // 对每个对话生成AI回复
            for (let i = 0; i < contacts.length; i++) {
              const c = contacts[i];
              try {
                await page.evaluate((name) => {
                  const all = document.querySelectorAll('div[role="listitem"] div, span');
                  for (const el of all) {
                    if (el.textContent?.includes(name)) { (el as HTMLElement).click(); break; }
                  }
                }, c.name);
                await page.waitForTimeout(2000);
                // 读最新消息
                const msgs = await page.$$eval('div[role="row"]', els => els.slice(-3).map(e => e.textContent?.trim()));
                const context = msgs.join(' | ');
                // 生成回复（通过OpenClaw）
                let reply = '';
                try {
                  const rc = await fetch('http://127.0.0.1:18789/v1/chat/completions', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer e09a469628b389933b6cce1fbb8b315e4f7b988cc3942730' },
                    body: JSON.stringify({
                      model: 'deepseek/deepseek-v4-pro',
                      messages: [
                        { role: 'system', content: '你是台湾日常社交媒体用户。回复必须简短自然（10字内），用繁体中文。像真人朋友聊天，不要机械、不要客套、不要夸人。' },
                        { role: 'user', content: `对话上下文：${context}。请回复一句自然的台湾日常聊天。` }
                      ],
                      max_tokens: 30,
                    }),
                  });
                  const aiResp = await rc.json();
                  reply = aiResp.choices?.[0]?.message?.content?.trim() || '';
                } catch {}
                if (!reply) {
                  const defReplies = ['嗯嗯了解', '哈哈', '對啊', '好哦', '最近在忙什麼'];
                  reply = defReplies[Math.floor(Math.random() * defReplies.length)];
                }
                const msgBox = await page.$('div[contenteditable="true"]');
                if (msgBox) { await msgBox.click(); await page.keyboard.type(reply, { delay: 40 }); await page.keyboard.press('Enter'); }
                result += ` | ${c.name}=已回复`;
                addLog('info', `AI聊天: ${accountId} → ${c.name} → "${reply}"`);
                await page.waitForTimeout(2000 + Math.random() * 3000);
              } catch (e: any) { result += ` | ${c.name}=${e.message.slice(0, 10)}`; }
            }
          } catch { result = 'AI聊天失败'; }
          addLog('info', `AI聊天: ${accountId} → ${result}`);
          break;
          
        case 'ai_schedule':
          try {
            // AI 读取所有账号状态 → 智能分配任务
            const allAccts = Array.from(accountStates.entries());
            const healthy = allAccts.filter(([,s]) => s.status !== 'error' && s.status !== 'offline');
            const tasks: string[] = [];
            for (const [aid, s] of healthy.slice(0, 5)) {
              const ops = ['browse_home', 'like_posts', 'add_friends', 'browse_home'];
              const op = ops[Math.floor(Math.random() * ops.length)];
              taskQueue.push({
                id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                accountId: aid, type: op, params: {},
                status: 'pending', createdAt: Date.now(),
              });
              tasks.push(`${aid.slice(-8)}=${op}`);
            }
            result = `AI调度: ${tasks.length}个任务 | ${tasks.join(', ')}`;
            addLog('success', result);
          } catch { result = '调度失败'; }
          break;
          
        case 'cron_set':
          try {
            // 定时计划: 每天指定时间执行
            const schedule = params?.schedule || 'daily_10am';
            const key = `cron_${accountId}`;
            const cronJobs = ((globalThis as any).cronJobs = (globalThis as any).cronJobs || new Map());
            if (cronJobs.has(key)) clearInterval(cronJobs.get(key));
            const ms = 3600000; // 1小时检查间隔
            const job = setInterval(async () => {
              const now = new Date();
              const h = now.getHours();
              if (schedule === 'daily_10am' && h === 10) {
                taskQueue.push({
                  id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                  accountId, type: 'chain',
                  params: { steps: ['browse_home', 'like_posts', 'add_friends'] },
                  status: 'pending', createdAt: Date.now(),
                });
              }
            }, ms);
            cronJobs.set(key, job);
            result = `定时: ${schedule}`;
            addLog('info', `定时计划: ${accountId} → ${schedule}`);
          } catch { result = '定时设置失败'; }
          break;
          
        case 'stage_check':
          try {
            // 账号阶段管理: 根据创建天数分阶段
            const created = params?.createdAt || Date.now();
            const daysOld = Math.floor((Date.now() - created) / 86400000);
            let stage = 'cold'; let limit = 5;
            if (daysOld > 7) { stage = 'warmup'; limit = 15; }
            if (daysOld > 30) { stage = 'active'; limit = 30; }
            if (daysOld > 90) { stage = 'mature'; limit = 50; }
            const todayOps = accountStates.get(accountId)?.actions || 0;
            result = `阶段:${stage}(第${daysOld}天) 今日:${todayOps}/${limit}`;
            if (todayOps >= limit) result += ' | 已达上限';
            addLog('info', `阶段检测: ${accountId} → ${result}`);
          } catch { result = '阶段检测失败'; }
          break;
          
        case 'set_group':
          try {
            const state = accountStates.get(accountId);
            if (state) { state.group = params?.group || '默认'; }
            // 持久化
            const extrasPath = 'G:/Aike-FBclaw/data/account-extras.json';
            let extras: any = {};
            if (fs.existsSync(extrasPath)) extras = JSON.parse(fs.readFileSync(extrasPath, 'utf-8'));
            extras[accountId] = { ...(extras[accountId] || {}), group: state?.group, name: state?.name };
            fs.writeFileSync(extrasPath, JSON.stringify(extras, null, 2));
            result = `分组: ${params?.group || '默认'}`;
            addLog('info', `分组: ${accountId} → ${params?.group || '默认'}`);
          } catch { result = '分组失败'; }
          break;
          
        case 'proxy_check':
          try {
            const proxyList = Array.from((globalThis as any).proxyPool?.getAllProxies?.() || []);
            const results: string[] = [];
            for (const p of proxyList.slice(0, 5)) {
              const start = Date.now();
              try {
                await new Promise((resolve, reject) => {
                  const [host, portStr] = (p.host || p).split(':');
                  const port = parseInt(portStr) || 1080;
                  const sock = net.createConnection({ host, port, timeout: 3000 }, () => { sock.destroy(); resolve(null); });
                  sock.on('error', reject);
                });
                const ms = Date.now() - start;
                results.push(`${host}:${ms}ms`);
              } catch { results.push(`${p.host || p.slice(0,15)}:超时`); }
            }
            result = `代理测速: ${results.join(', ')}`;
            addLog('info', result);
          } catch { result = '测速失败'; }
          break;
          
        case 'evolve_check':
          try {
            const statsPath = 'G:/Aike-FBclaw/data/evolution-stats.json';
            let stats: any = {};
            if (fs.existsSync(statsPath)) stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
            const todayKey = new Date().toISOString().slice(0, 10);
            if (!stats[todayKey]) stats[todayKey] = { total: 0, success: 0, failed: 0 };
            const allTasks = taskQueue.filter(t => t.accountId === accountId);
            const today = allTasks.filter(t => new Date(t.createdAt).toISOString().slice(0, 10) === todayKey);
            stats[todayKey].total = today.length;
            stats[todayKey].success = today.filter(t => t.status === 'done').length;
            stats[todayKey].failed = today.filter(t => t.status === 'failed').length;
            fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
            const rate = stats[todayKey].total > 0 ? Math.round(stats[todayKey].success / stats[todayKey].total * 100) : 0;
            result = `成功率:${rate}% | 总:${stats[todayKey].total} | 建议:${rate<50?'降低频率':'保持'}`;
            addLog('info', `自进化: ${accountId} → ${result}`);
          } catch { result = '进化检查失败'; }
          break;
          
        case 'send_message':
          try {
            const targetUrl = params?.url || params?.pageUrl;
            if (!targetUrl) { result = '缺少目标URL'; break; }
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await page.waitForTimeout(5000);
            // 检查是否登录
            const cookies = await page.context().cookies();
            const cUser = cookies.find((c: any) => c.name === 'c_user');
            if (!cUser) { result = '未登入-需先手动登入一次'; addLog('warn', 'send_message: 未登录'); break; }
            // 找「發送訊息」
            const found = await page.evaluate(() => {
              const all = document.querySelectorAll('div[role="button"], span, a, button');
              for (const el of all) {
                const t = (el.textContent || '').trim();
                if (t.includes('發送訊息') || t.includes('Message') || t.includes('傳送訊息')) {
                  (el as HTMLElement).click(); return true;
                }
              }
              return false;
            });
            if (!found) { result = '未找到訊息按钮-页面可能不同'; addLog('warn', 'send_message: 无Message按钮 URL=' + targetUrl.slice(0,40)); break; }
            await page.waitForTimeout(3000);
            const input = await page.$('div[contenteditable="true"]');
            if (!input) { result = '聊天窗未弹出'; break; }
            await input.click(); await page.waitForTimeout(400);
            const text = params?.text || '嗨～你好！👋';
            await page.keyboard.type(text, { delay: 50 });
            await page.screenshot({ path: 'G:/Aike-FBclaw/data/screenshots/msg_sent.png' });
            result = '已输入: ' + text.slice(0,20);
            addLog('success', result);
          } catch (e: any) { result = '失败: ' + (e?.message?.slice(0,30) || 'err'); }
          break;
          
        default:
          result = `未知: ${type}`;
      }
      
      task.status = 'done'; task.result = result;
      const state = accountStates.get(accountId);
      if (state) { 
        state.status = 'idle'; state.actions = (state.actions || 0) + 1;
        // 账号健康监控
        if (!state.errorCount) state.errorCount = 0;
        if (!state.errors) state.errors = [];
        if (result.includes('失败') || result.includes('未登录') || result.includes('captcha') || result.includes('checkpoint')) {
          state.errorCount++;
          state.errors.push({ time: Date.now(), result });
          if (state.errorCount >= 3) {
            state.status = 'banned';
            addLog('error', `⚠️ ${accountId} 连续${state.errorCount}次异常 → 暂停自动操作`);
          }
        } else {
          state.errorCount = 0; // 成功后重置
        }
        // 更新最后活跃时间
        state.lastActive = Date.now();
      }
      
      await ctx.close();
    } catch (e: any) {
      task.status = 'failed'; task.result = e.message.slice(0, 80);
    }
}

// Start
app.initialize().then(async () => {
  startGateway();
  await autoAssignAllProxies();
  server.listen(PORT, () => {
    console.log(`[FBclaw] http://localhost:${PORT} | OpenClaw:${gatewayProc?'running':'pending'}`);
    addLog('info', '系统启动完成');
  });
});
