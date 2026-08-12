"use strict";
delete process.env.ELECTRON_RUN_AS_NODE;
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SUPERVISOR_LOG = path.join(DATA_DIR, "supervisor.log");
const ASSETS = path.join(ROOT, "assets");
const API_PORT = 18991;
const GATEWAY_PORT = 18789;
function resolveNodeBin() {
  const bundled = path.join(ROOT, "node-runtime", "node.exe");
  if (fs.existsSync(bundled)) return bundled;
  const managed = "C:\\Users\\UR\\.workbuddy\\binaries\\node\\versions\\22.22.2\\node.exe";
  if (fs.existsSync(managed)) return managed;
  return "node";
}
const NODE_BIN = process.env.AIKE_NODE_BIN || resolveNodeBin();
process.env.AIKE_NODE_BIN = NODE_BIN;
function resolveNpx() {
  const p = path.join(ROOT, "node_modules", ".bin", "npx.cmd");
  return fs.existsSync(p) ? p : "npx";
}
const NPX_BIN = resolveNpx();
function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  try {
    const txt = fs.readFileSync(envPath, "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const k = m[1];
      let v = m[2].replace(/^["']|["']$/g, "");
      if (process.env[k] === void 0) process.env[k] = v;
    }
  } catch (e) {
    console.warn("[main] \u8BFB\u53D6 .env \u5931\u8D25:", e.message);
  }
}
const MAX_LOG = 3e3;
const logBuf = [];
let mainWindow = null;
function pushLog(source, level, rawLine) {
  const line = String(rawLine).replace(/\r?\n+$/, "");
  if (!line) return;
  const entry = { source, level, line, t: Date.now() };
  logBuf.push(entry);
  if (logBuf.length > MAX_LOG) logBuf.shift();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send("event:log", entry);
    } catch {
    }
  }
}
function pipeChildLog(child, tag) {
  const flush = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const l of parts) pushLog(tag, "info", l);
    });
    stream.on("end", () => {
      if (buf) pushLog(tag, "info", buf);
    });
  };
  if (child.stdout) flush(child.stdout);
  if (child.stderr) flush(child.stderr);
  child.on("exit", (code) => pushLog(tag, code === 0 ? "info" : "warn", `${tag} \u8FDB\u7A0B\u7ED3\u675F code=${code}`));
}
let logFileOffset = 0;
function watchSupervisorLog() {
  if (!fs.existsSync(DATA_DIR)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch {
    }
  }
  try {
    const sz = fs.statSync(SUPERVISOR_LOG).size;
    logFileOffset = Math.max(0, sz - 2e4);
  } catch {
  }
  fs.watch(SUPERVISOR_LOG, () => {
    try {
      const sz = fs.statSync(SUPERVISOR_LOG).size;
      if (sz < logFileOffset) {
        logFileOffset = 0;
      }
      const fd = fs.openSync(SUPERVISOR_LOG, "r");
      const len = sz - logFileOffset;
      if (len <= 0) {
        fs.closeSync(fd);
        return;
      }
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, logFileOffset);
      fs.closeSync(fd);
      logFileOffset = sz;
      for (const l of buf.toString("utf8").split("\n")) {
        if (!l.trim()) continue;
        const m = l.match(/^\[server(!)?\] (.*)$/);
        if (m) pushLog("server", m[1] ? "error" : "info", m[2]);
        else pushLog("supervisor", "info", l);
      }
    } catch (e) {
    }
  });
}
const children = [];
function spawnHidden(cmd, args, tag, env) {
  pushLog("main", "info", `\u542F\u52A8 ${tag}: ${cmd} ${args.join(" ")}`);
  let child;
  try {
    child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env || {} },
      windowsHide: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (e) {
    pushLog("main", "error", `${tag} \u542F\u52A8\u5931\u8D25: ${e.message}`);
    return null;
  }
  children.push(child);
  pipeChildLog(child, tag);
  return child;
}
function killAllChildren() {
  for (const c of children) {
    try {
      if (c.pid) process.kill(-c.pid, "SIGTERM");
    } catch (e) {
      try {
        c.kill("SIGTERM");
      } catch {
      }
    }
  }
  children.length = 0;
}
function startBackend() {
  const supEntry = path.join(ROOT, "dist", "supervisor.js");
  spawnHidden(NODE_BIN, [supEntry], "supervisor");
  const ocEntry = path.join(ROOT, "node_modules", "openclaw", "openclaw.mjs");
  spawnHidden(NODE_BIN, [ocEntry, "gateway"], "gateway");
  try {
    watchSupervisorLog();
  } catch (e) {
    pushLog("main", "warn", "\u65E5\u5FD7\u76D1\u542C\u5931\u8D25: " + e.message);
  }
}
function waitServerReady(timeoutMs = 9e4) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${API_PORT}/api/status`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 800);
      });
      req.setTimeout(2500, () => {
        req.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 800);
      });
    };
    tick();
  });
}
function createLoadingWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1400, width),
    height: Math.min(900, height),
    minWidth: 1024,
    minHeight: 700,
    title: "Aike-FBclaw \u2014 \u684C\u9762\u667A\u80FD\u4F53",
    icon: path.join(ASSETS, "icon.png"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  const loading = `<!doctype html><html><head><meta charset="utf-8">
    <style>html,body{margin:0;height:100%;background:#0b1437;color:#cfe0ff;font-family:system-ui,'Microsoft YaHei',sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
    .spin{width:46px;height:46px;border:4px solid #2a3b78;border-top-color:#5b8cff;border-radius:50%;animation:s 1s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}} h1{font-size:20px;font-weight:600;margin:0}
    p{margin:0;opacity:.7;font-size:13px}</style></head>
    <body><div class="spin"></div><h1>Aike-FBclaw \u542F\u52A8\u4E2D\u2026</h1>
    <p>\u6B63\u5728\u52A0\u8F7D\u540E\u53F0\u670D\u52A1\u4E0E\u6307\u6325\u4E2D\u5FC3</p></body></html>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(loading));
  return win;
}
async function createMainWindow() {
  const win = createLoadingWindow();
  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.on("close", (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      win.hide();
      return;
    }
  });
  const ready = await waitServerReady();
  if (ready) {
    await win.loadURL(`http://localhost:${API_PORT}/`);
    pushLog("main", "info", "\u6307\u6325\u4E2D\u5FC3 UI \u5DF2\u52A0\u8F7D");
  } else {
    const err = `<!doctype html><html><head><meta charset="utf-8">
      <style>html,body{margin:0;height:100%;background:#1a0f14;color:#ffd9d9;font-family:system-ui,sans-serif;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:40px;text-align:center}
      h1{font-size:20px} p{opacity:.75;font-size:13px;max-width:520px;line-height:1.6}</style></head>
      <body><h1>\u26A0\uFE0F \u540E\u53F0\u670D\u52A1\u542F\u52A8\u8D85\u65F6</h1>
      <p>\u6307\u6325\u4E2D\u5FC3\u5728 90 \u79D2\u5185\u672A\u80FD\u5C31\u7EEA\u3002\u8BF7\u68C0\u67E5 OpenClaw Gateway / Supervisor \u662F\u5426\u6B63\u5E38\u8FD0\u884C\uFF0C
      \u6216\u5728\u300C\u7CFB\u7EDF\u65E5\u5FD7\u300D\u9762\u677F\u67E5\u770B\u9519\u8BEF\u3002\u4F60\u53EF\u5728\u7CFB\u7EDF\u6258\u76D8\u53F3\u952E\u9000\u51FA\u540E\u91CD\u8BD5\u3002</p></body></html>`;
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(err));
    pushLog("main", "error", "\u7B49\u5F85\u670D\u52A1\u5C31\u7EEA\u8D85\u65F6");
  }
  return win;
}
let tray = null;
function createTray() {
  if (process.platform !== "win32" && process.platform !== "darwin") return;
  const icon = nativeImage.createFromPath(path.join(ASSETS, "icon.png"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  const menu = Menu.buildFromTemplate([
    { label: "\u663E\u793A\u4E3B\u7A97\u53E3", click: () => mainWindow ? mainWindow.show() : createMainWindow() },
    { label: "\u91CD\u542F\u540E\u53F0\u670D\u52A1", click: () => restartServer() },
    { type: "separator" },
    { label: "\u9000\u51FA Aike-FBclaw", click: () => {
      app.isQuiting = true;
      app.quit();
    } }
  ]);
  tray.setToolTip("Aike-FBclaw \u684C\u9762\u667A\u80FD\u4F53");
  tray.setContextMenu(menu);
  tray.on("double-click", () => mainWindow && mainWindow.show());
}
function restartServer() {
  const req = http.request({ host: "127.0.0.1", port: 18992, path: "/restart", method: "POST" }, (res) => {
    res.resume();
    pushLog("main", "info", "\u5DF2\u53D1\u9001\u540E\u53F0\u670D\u52A1\u91CD\u542F\u6307\u4EE4");
  });
  req.on("error", (e) => pushLog("main", "error", "\u91CD\u542F\u6307\u4EE4\u5931\u8D25: " + e.message));
  req.end();
}
function setupIPC() {
  ipcMain.handle("console:getRecent", async () => logBuf.slice(-500));
  ipcMain.handle("server:restart", async () => {
    restartServer();
    return { ok: true };
  });
  ipcMain.handle("system:get-info", async () => ({
    apiPort: API_PORT,
    gatewayPort: GATEWAY_PORT,
    nodeBin: NODE_BIN,
    dataDir: DATA_DIR,
    version: require(path.join(ROOT, "package.json")).version
  }));
}
app.on("second-instance", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});
app.whenReady().then(async () => {
  try {
    loadEnvFile();
    if (!process.env.MOCK_FB) process.env.MOCK_FB = "0";
    let gotLock = true;
    try {
      gotLock = app.requestSingleInstanceLock();
    } catch (e) {
      gotLock = true;
    }
    if (!gotLock) {
      app.quit();
      return;
    }
    setupIPC();
    startBackend();
    await createMainWindow();
    createTray();
    pushLog("main", "info", "Aike-FBclaw \u684C\u9762\u667A\u80FD\u4F53\u542F\u52A8\u5B8C\u6210");
  } catch (e) {
    console.error("[main] \u542F\u52A8\u5931\u8D25:", e);
  }
});
app.on("window-all-closed", () => {
});
app.on("activate", () => {
  if (!mainWindow) createMainWindow();
});
app.on("before-quit", () => {
  app.isQuiting = true;
  killAllChildren();
});
