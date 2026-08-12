/**
 * Aike-FBclaw — Electron 主进程（真正桌面智能体软件入口）
 *
 * 职责：
 *  - 由主进程「隐形」拉起 OpenClaw Gateway + Supervisor(=服务端)，全部 windowsHide，
 *    彻底取代原先启动.bat 弹出的黑色终端窗口。
 *  - 轮询 http://localhost:18991 就绪后，在主窗口内加载指挥中心的网页 UI
 *    （UI 本身不变，只是从「Chrome 套壳」变成 Electron 内嵌窗口）。
 *  - 收集 supervisor/gateway 的 stdout/stderr 与 data/supervisor.log，
 *    经 IPC 转发给渲染层的「系统日志」面板。
 *  - 系统托盘：显示主窗口 / 重启服务 / 退出。
 *
 * 注意：本文件用 CommonJS 风格（require），由 scripts/build-electron.mjs 转译为 main.cjs。
 * 自 FB 操作的 Chromium 浏览器窗口由 Agent 层照常打开（那是功能本身，保留可见）。
 */

// 必须在 require('electron') 之前清除，避免 Electron 被当成 node 脚本运行
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SUPERVISOR_LOG = path.join(DATA_DIR, 'supervisor.log');
const ASSETS = path.join(ROOT, 'assets');
const API_PORT = 18991;
const GATEWAY_PORT = 18789;

// ===================== 工具 =====================

// 优先用随附 node（打包后安装在安装根/node-runtime/node.exe）；
// 其次回退到开发机的受管 node；最后才用系统 PATH 的 node。
function resolveNodeBin() {
  const bundled = path.join(ROOT, 'node-runtime', 'node.exe');
  if (fs.existsSync(bundled)) return bundled;
  const managed = 'C:\\Users\\UR\\.workbuddy\\binaries\\node\\versions\\22.22.2\\node.exe';
  if (fs.existsSync(managed)) return managed;
  return 'node';
}
const NODE_BIN = process.env.AIKE_NODE_BIN || resolveNodeBin();
// 让 supervisor 子进程继承同一份 node，确保 better-sqlite3 的 ABI 匹配
process.env.AIKE_NODE_BIN = NODE_BIN;

function resolveNpx() {
  const p = path.join(ROOT, 'node_modules', '.bin', 'npx.cmd');
  return fs.existsSync(p) ? p : 'npx';
}
const NPX_BIN = resolveNpx();

// 从 .env 读取并补全环境变量（无论是否经启动器，都能拿到 DEEPSEEK_API_KEY 等）
function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const k = m[1];
      let v = m[2].replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (e) {
    console.warn('[main] 读取 .env 失败:', e.message);
  }
}

// ===================== 日志收集 =====================

const MAX_LOG = 3000;
const logBuf = [];
let mainWindow = null;

function pushLog(source, level, rawLine) {
  const line = String(rawLine).replace(/\r?\n+$/, '');
  if (!line) return;
  const entry = { source, level, line, t: Date.now() };
  logBuf.push(entry);
  if (logBuf.length > MAX_LOG) logBuf.shift();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('event:log', entry); } catch {}
  }
}

// 子进程 stdout/stderr 按行转发
function pipeChildLog(child, tag) {
  const flush = (stream) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const l of parts) pushLog(tag, 'info', l);
    });
    stream.on('end', () => { if (buf) pushLog(tag, 'info', buf); });
  };
  if (child.stdout) flush(child.stdout);
  if (child.stderr) flush(child.stderr);
  child.on('exit', (code) => pushLog(tag, code === 0 ? 'info' : 'warn', `${tag} 进程结束 code=${code}`));
}

// 监听 supervisor.log 文件增量（服务端日志落盘处）
let logFileOffset = 0;
function watchSupervisorLog() {
  if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  }
  // 初始偏移：文件末尾前 20KB，避免首次刷屏
  try {
    const sz = fs.statSync(SUPERVISOR_LOG).size;
    logFileOffset = Math.max(0, sz - 20000);
  } catch {}
  fs.watch(SUPERVISOR_LOG, () => {
    try {
      const sz = fs.statSync(SUPERVISOR_LOG).size;
      if (sz < logFileOffset) { logFileOffset = 0; } // 文件被截断
      const fd = fs.openSync(SUPERVISOR_LOG, 'r');
      const len = sz - logFileOffset;
      if (len <= 0) { fs.closeSync(fd); return; }
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, logFileOffset);
      fs.closeSync(fd);
      logFileOffset = sz;
      for (const l of buf.toString('utf8').split('\n')) {
        if (!l.trim()) continue;
        const m = l.match(/^\[server(!)?\] (.*)$/);
        if (m) pushLog('server', m[1] ? 'error' : 'info', m[2]);
        else pushLog('supervisor', 'info', l);
      }
    } catch (e) { /* 忽略瞬时错误 */ }
  });
}

// ===================== 子进程管理 =====================

const children = [];

function spawnHidden(cmd, args, tag, env) {
  pushLog('main', 'info', `启动 ${tag}: ${cmd} ${args.join(' ')}`);
  let child;
  try {
    child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...(env || {}) },
      windowsHide: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    pushLog('main', 'error', `${tag} 启动失败: ${e.message}`);
    return null;
  }
  children.push(child);
  pipeChildLog(child, tag);
  return child;
}

function killAllChildren() {
  for (const c of children) {
    try {
      // detached 进程组：用负数 pid 杀整组（含 npx/openclaw 孙进程）
      if (c.pid) process.kill(-c.pid, 'SIGTERM');
    } catch (e) { try { c.kill('SIGTERM'); } catch {} }
  }
  children.length = 0;
}

function startBackend() {
  // 1) Supervisor（内含服务端，windowsHide 拉起，自带看门狗）
  //    用随附 node 跑已编译的 dist/supervisor.js（打包后 src/ 不存在，绝不依赖 tsx）
  const supEntry = path.join(ROOT, 'dist', 'supervisor.js');
  spawnHidden(NODE_BIN, [supEntry], 'supervisor');

  // 2) OpenClaw Gateway（随附 node 跑 openclaw CLI 入口）
  const ocEntry = path.join(ROOT, 'node_modules', 'openclaw', 'openclaw.mjs');
  spawnHidden(NODE_BIN, [ocEntry, 'gateway'], 'gateway');

  // 3) 监听服务端日志文件
  try { watchSupervisorLog(); } catch (e) { pushLog('main', 'warn', '日志监听失败: ' + e.message); }
}

// ===================== 等待服务就绪 =====================

function waitServerReady(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${API_PORT}/api/status`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 800);
      });
      req.setTimeout(2500, () => { req.destroy(); if (Date.now() > deadline) resolve(false); else setTimeout(tick, 800); });
    };
    tick();
  });
}

// ===================== 窗口 =====================

function createLoadingWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1400, width),
    height: Math.min(900, height),
    minWidth: 1024,
    minHeight: 700,
    title: 'Aike-FBclaw — 桌面智能体',
    icon: path.join(ASSETS, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const loading = `<!doctype html><html><head><meta charset="utf-8">
    <style>html,body{margin:0;height:100%;background:#0b1437;color:#cfe0ff;font-family:system-ui,'Microsoft YaHei',sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
    .spin{width:46px;height:46px;border:4px solid #2a3b78;border-top-color:#5b8cff;border-radius:50%;animation:s 1s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}} h1{font-size:20px;font-weight:600;margin:0}
    p{margin:0;opacity:.7;font-size:13px}</style></head>
    <body><div class="spin"></div><h1>Aike-FBclaw 启动中…</h1>
    <p>正在加载后台服务与指挥中心</p></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(loading));
  return win;
}

async function createMainWindow() {
  const win = createLoadingWindow();
  mainWindow = win;

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  // 关闭按钮 → 最小化到托盘，不退出（后台服务继续运行）
  win.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      win.hide();
      return;
    }
  });

  const ready = await waitServerReady();
  if (ready) {
    await win.loadURL(`http://localhost:${API_PORT}/`);
    pushLog('main', 'info', '指挥中心 UI 已加载');
  } else {
    const err = `<!doctype html><html><head><meta charset="utf-8">
      <style>html,body{margin:0;height:100%;background:#1a0f14;color:#ffd9d9;font-family:system-ui,sans-serif;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:40px;text-align:center}
      h1{font-size:20px} p{opacity:.75;font-size:13px;max-width:520px;line-height:1.6}</style></head>
      <body><h1>⚠️ 后台服务启动超时</h1>
      <p>指挥中心在 90 秒内未能就绪。请检查 OpenClaw Gateway / Supervisor 是否正常运行，
      或在「系统日志」面板查看错误。你可在系统托盘右键退出后重试。</p></body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(err));
    pushLog('main', 'error', '等待服务就绪超时');
  }
  return win;
}

// ===================== 托盘 =====================

let tray = null;
function createTray() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => mainWindow ? mainWindow.show() : createMainWindow() },
    { label: '重启后台服务', click: () => restartServer() },
    { type: 'separator' },
    { label: '退出 Aike-FBclaw', click: () => { app.isQuiting = true; app.quit(); } },
  ]);
  tray.setToolTip('Aike-FBclaw 桌面智能体');
  tray.setContextMenu(menu);
  tray.on('double-click', () => mainWindow && mainWindow.show());
}

function restartServer() {
  const req = http.request({ host: '127.0.0.1', port: 18992, path: '/restart', method: 'POST' }, (res) => {
    res.resume();
    pushLog('main', 'info', '已发送后台服务重启指令');
  });
  req.on('error', (e) => pushLog('main', 'error', '重启指令失败: ' + e.message));
  req.end();
}

// ===================== IPC =====================

function setupIPC() {
  ipcMain.handle('console:getRecent', async () => logBuf.slice(-500));
  ipcMain.handle('server:restart', async () => { restartServer(); return { ok: true }; });
  ipcMain.handle('system:get-info', async () => ({
    apiPort: API_PORT,
    gatewayPort: GATEWAY_PORT,
    nodeBin: NODE_BIN,
    dataDir: DATA_DIR,
    version: require(path.join(ROOT, 'package.json')).version,
  }));
}

// ===================== 启动 =====================

app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });

app.whenReady().then(async () => {
  try {
    loadEnvFile();
    // 桌面程序默认真实 Facebook 模式（开发态用 npm run dev 仍走 .env/config 默认）。
    // 若用户需在安装版切回模拟，可在安装目录的 .env 加 MOCK_FB=1。
    if (!process.env.MOCK_FB) process.env.MOCK_FB = '0';
    // 单实例锁（非标准会话下失败也不应终止）
    let gotLock = true;
    try { gotLock = app.requestSingleInstanceLock(); } catch (e) { gotLock = true; }
    if (!gotLock) { app.quit(); return; }

    setupIPC();
    startBackend();
    await createMainWindow();
    createTray();
    pushLog('main', 'info', 'Aike-FBclaw 桌面智能体启动完成');
  } catch (e) {
    console.error('[main] 启动失败:', e);
  }
});

app.on('window-all-closed', () => { /* 保持运行（托盘常驻） */ });
app.on('activate', () => { if (!mainWindow) createMainWindow(); });
app.on('before-quit', () => { app.isQuiting = true; killAllChildren(); });
