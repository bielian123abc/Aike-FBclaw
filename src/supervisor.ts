/**
 * 服務端監管啟動器（Supervisor）
 *
 * 使用者需求：
 * 1. 打開軟件即啟動服務端，避免脫離後服務端出錯停止 —— 本程序作為「頂層進程」，
 *    靜默（windowsHide）拉起真實的 server.ts，接管其日誌，並持續監管。
 * 2. 看門狗自癒：服務進程崩潰、或每 5s 探活 /api/status 失敗 → 指數退避自動重啟（封頂）。
 * 3. 獨立控制端口 18992：GET /status、POST /restart、/stop、/start（供 UI / Electron 調用）。
 *
 * 設計：若 18991 已被佔用（開發中手動啟動的服務），則只「接管監管」不重複拉起，
 * 因此無論開發期或打包後都能安全運行。Electron 日後會改為呼叫 startSupervisor()。
 */
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { fileURLToPath } from 'url';
import { DATA_DIR, API_PORT } from './config';

// 打包后 cwd 不可靠，统一用本文件位置反推安装根（dist/supervisor.js -> 安装根）
const SUPERVISOR_DIR = path.dirname(fileURLToPath(import.meta.url)); // = dist/
const APP_ROOT = path.resolve(SUPERVISOR_DIR, '..');
const SUPERVISOR_PORT = 18992;
const CONTROL_PORT = SUPERVISOR_PORT;
const HEALTH_URL = `http://127.0.0.1:${API_PORT}/api/status`;
const LOG_FILE = path.join(DATA_DIR, 'supervisor.log');
const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.js');
const SERVER_ENTRY_TS = path.join(APP_ROOT, 'src', 'server.ts');

let child: ChildProcess | null = null;
let running = false;        // 是否應維持服務運行（stop 後設 false）
let restarts = 0;
let lastError = '';
let startTime = Date.now();
let backoff = 1000;
let suppressExit = false;   // 主動 kill（restart/stop）時抑制「異常退出」誤判
let childStartedAt = 0;     // 子進程啟動時間，用於啟動寬限期
let consecFails = 0;        // 探活連續失敗次數（需連續 2 次才重啟，避免瞬時抖動誤殺）

function log(...args: any[]) {
  const line = `[${new Date().toLocaleString('zh-TW')}] ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.log('[Supervisor]', ...args);
}

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { try { sock.destroy(); } catch {} resolve(true); });
    sock.on('error', () => { try { sock.destroy(); } catch {} resolve(false); });
    sock.setTimeout(1500, () => { try { sock.destroy(); } catch {} resolve(false); });
  });
}

/** 等待端口真正釋放（避免舊進程未釋放端口導致新服務端 EADDRINUSE 崩潰） */
function waitPortFree(port: number, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      portListening(port).then((up) => {
        if (!up) return resolve();
        if (Date.now() > deadline) return resolve(); // 逾時仍放行，由服務端 EADDRINUSE 兜底
        setTimeout(tick, 300);
      });
    };
    tick();
  });
}

function serverArgs(): string[] {
  if (fs.existsSync(SERVER_ENTRY)) return [SERVER_ENTRY];
  return [path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), SERVER_ENTRY_TS];
}

async function startChild() {
  if (child) return;
  // 等待端口真正釋放，避免舊進程未釋放端口導致新服務端 EADDRINUSE 崩潰
  await waitPortFree(API_PORT);
  const args = serverArgs();
  const node = process.env.AIKE_NODE_BIN || process.execPath;
  log('啟動服務端：', node, args.join(' '));
  try {
    child = spawn(node, args, {
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    log('服務端啟動失敗: ' + e.message);
    child = null;
    if (running) scheduleRestart(e.message);
    return;
  }
  childStartedAt = Date.now();
  child.stdout?.on('data', (d) => { try { fs.appendFileSync(LOG_FILE, '[server] ' + d.toString()); } catch {} });
  child.stderr?.on('data', (d) => { try { fs.appendFileSync(LOG_FILE, '[server!] ' + d.toString()); } catch {} });
  child.on('exit', (code) => {
    log('服務端進程結束 code=' + code);
    child = null;
    if (suppressExit) { suppressExit = false; return; } // 主動重啟/停止，非異常
    if (running) scheduleRestart('進程異常退出');
  });
  child.on('error', (e: any) => { log('服務端啟動失敗: ' + e.message); child = null; if (running) scheduleRestart(e.message); });
}

let restartTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRestart(reason: string) {
  if (!running) return;
  lastError = reason;
  if (restartTimer) return;
  const wait = Math.min(backoff, 30000);
  backoff = Math.min(backoff * 2, 30000);
  log(`預計 ${wait}ms 後重啟服務端（原因：${reason}）`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    backoff = 1000; // 重啟成功後重置
    if (running) { restarts++; startChild(); }
  }, wait);
}

async function healthCheck(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

async function monitorLoop() {
  // 若服務未運行且應維持運行，且端口空閒，則拉起
  if (running && !child) {
    const up = await portListening(API_PORT);
    if (!up) startChild();
  }
  // 探活：進程在但無響應 → 連續 2 次失敗才殺掉重啟（避免瞬時抖動誤殺）
  if (running && child) {
    const ok = await healthCheck();
    const booting = Date.now() - childStartedAt < 30000;
    if (ok) { consecFails = 0; }
    if (!ok && !booting) {
      consecFails++;
      if (consecFails >= 2) {
        log('探活連續失敗 2 次，終止服務端以觸發重啟');
        suppressExit = true; // 這是受控重啟，不計入「異常退出」
        try { child.kill(); } catch {}
        child = null;
        consecFails = 0;
      } else {
        log('探活失敗 1 次（寬限，不重啟）');
      }
    }
  }
}

export function startSupervisor() {
  if (running) return;
  running = true;
  startTime = Date.now();
  // 先確認端口是否已被佔用（開發中手動啟動的服務）
  portListening(API_PORT).then((up) => {
    if (up) {
      log('偵測到 18991 已有服務在運行，接管監管（不重複拉起）');
    } else {
      startChild();
    }
  });
  setInterval(monitorLoop, 5000);
  startControlServer();
  log('監管啟動器已啟動，控制端口 ' + CONTROL_PORT);
}

export function stopServer() {
  running = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) { try { child.kill(); } catch {} child = null; }
  log('已停止服務端（監管仍運行，可再次 start）');
}

export function startServer() {
  if (running) return;
  running = true;
  startChild();
}

export function restartServer() {
  if (child) { suppressExit = true; try { child.kill(); } catch {} child = null; }
  running = true;
  startChild();
}

function statusPayload() {
  return {
    supervisorRunning: true,
    maintaining: running,
    serverPid: child?.pid || null,
    restarts,
    uptimeSec: Math.round((Date.now() - startTime) / 1000),
    lastError,
  };
}

function startControlServer() {
  const srv = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = req.url || '/';
    const send = (obj: any) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url === '/status') {
      healthCheck().then((up) => send({ ...statusPayload(), serverUp: up }));
      return;
    }
    if (url === '/restart' && req.method === 'POST') { restartServer(); send({ ok: true, ...statusPayload() }); return; }
    if (url === '/stop' && req.method === 'POST') { stopServer(); send({ ok: true, ...statusPayload() }); return; }
    if (url === '/start' && req.method === 'POST') { startServer(); send({ ok: true, ...statusPayload() }); return; }
    send({ ok: false, error: 'unknown_command' });
  });
  srv.listen(CONTROL_PORT, () => log('控制端口已監聽 ' + CONTROL_PORT));
}

// 若直接執行本檔（npx tsx src/supervisor.ts）則啟動監管
const invokedPath = (process.argv[1] || '').replace(/\\/g, '/');
if (invokedPath.endsWith('/src/supervisor.ts') || invokedPath.endsWith('/supervisor.js')) {
  startSupervisor();
}
