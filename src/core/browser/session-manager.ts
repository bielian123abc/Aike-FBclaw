/**
 * SessionManager — 輕量可靠的瀏覽器會話管理
 *
 * 相比 profile-manager.ts 的 CDP 方式，這裡使用 Playwright 標準的
 * launchPersistentContext，經測試在當前環境可直接驅動 Mock FB / 真實 FB。
 *
 * 設計要點：
 * 1. 一個 account 對應一個 persistent context profile 目錄
 * 2. 啟動時注入指紋 shield（與 profile-manager 一致）
 * 3. 攔截 page.goto，把硬編碼的 https://www.facebook.com 自動換成 FB_BASE
 *    → 讓 fb-core-skills.ts 無需修改即可在 Mock FB 上運行
 * 4. 任務結束後主動 storageState() 保存，防止 Cookie 丟失
 */
import { chromium, BrowserContext, Page } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';
import { FB_BASE, MOCK_FB, MOCK_FB_PORT, PROFILES_DIR, SCREENSHOT_DIR, HEADLESS, DATA_DIR } from '../../config';
import { getAccount, updateAccount } from '../account-store';
import { getProxyManager } from '../proxy/proxy-manager';
import { getFingerprintEngine } from './fingerprint';
import { admitBrowser } from '../system/resource-allocator';
import { windowManager, computeTileLayout } from '../system/window-layout';
import { getScreenResolution } from '../system/system-profiler';
import { isRecording, attachRecorder } from './demo-recorder';

const CHROME_PATH = 'C:/Users/UR/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

export interface Session {
  accountId: string;
  context: BrowserContext;
  page: Page;
  profileDir: string;
  startedAt: number;
}

const sessions = new Map<string, Session>();

function profileDir(accountId: string) {
  return path.join(PROFILES_DIR, accountId);
}

function wrapPage(page: Page, baseUrl: string): Page {
  return new Proxy(page, {
    get(target, prop) {
      if (prop === 'goto') {
        return async (url: string, opts?: any) => {
          const realUrl = rewriteFbBase(url, baseUrl);
          return (target as any).goto(realUrl, opts);
        };
      }
      return (target as any)[prop];
    },
  }) as Page;
}

function rewriteFbBase(url: string, baseUrl: string): string {
  if (typeof url !== 'string') return url;
  if (url.startsWith('https://www.facebook.com')) return baseUrl + url.slice('https://www.facebook.com'.length);
  if (url.startsWith('https://facebook.com')) return baseUrl + url.slice('https://facebook.com'.length);
  return url;
}

/** 解析账号对应的 FB 基址：账号 mode 优先，其次跟随全局 MOCK_FB 配置 */
export function resolveFbBase(accountId: string): string {
  const acc = getAccount(accountId);
  if (acc?.mode === 'real') return process.env.FB_BASE || 'https://www.facebook.com';
  if (acc?.mode === 'mock') return `http://127.0.0.1:${MOCK_FB_PORT}`;
  return MOCK_FB ? `http://127.0.0.1:${MOCK_FB_PORT}` : (process.env.FB_BASE || 'https://www.facebook.com');
}

export async function launchSession(accountId: string, opts?: { headless?: boolean }): Promise<Session> {
  const existing = sessions.get(accountId);
  if (existing) {
    // 正確偵測瀏覽器是否仍存活：page.url() 是同步 getter，await 字串永遠不拋錯，
    // 故改用 browser().isConnected()（被外部強殺/崩潰時為 false）判斷。
    const pageClosed = existing.context.pages()[0]?.isClosed?.() ?? false;
    const alive = !!existing.context.browser()?.isConnected() && !pageClosed;
    if (!alive) {
      try { await existing.context.close().catch(() => {}); } catch {}
      sessions.delete(accountId);
      windowManager.unregister(accountId);
    } else {
      return existing;
    }
  }

  const dir = profileDir(accountId);
  fs.mkdirSync(dir, { recursive: true });

  const baseUrl = resolveFbBase(accountId);

  // 代理分配（PRD 4.7：禁止静默跳过，未配置則明確告警）
  let proxyServer: string | undefined;
  const pm = getProxyManager();
  const assigned = pm.getProxyString(accountId);
  const acc = getAccount(accountId);
  if (assigned) proxyServer = assigned;
  else if (acc?.proxy) proxyServer = acc.proxy;
  if (proxyServer) {
    console.log(`[Session] ${accountId} 使用代理: ${proxyServer.replace(/\/\/.*@/, '//***@')}`);
  } else {
    console.log(`[Session] ${accountId} 未配置代理 → 本機直連（真實 FB 同 IP 請留意風險）`);
  }

  const fp = getFingerprintEngine().loadOrCreate(accountId);
  // 預留網格 slot（啟動前依當前視窗數+1 算），並去除指紋裡的 --window-size 由布局統一控管
  const slot = windowManager.reserve(accountId);
  const fpArgs = getFingerprintEngine().buildLaunchArgs(fp).filter((a) => !a.startsWith('--window-size'));

  // 資源感知准入：超過並發上限或剩餘記憶體不足時等待，避免一次開太多瀏覽器把機器拖垮
  await admitBrowser(sessions.size);

  const context = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME_PATH,
    headless: opts?.headless ?? HEADLESS,
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
    // viewport: null 讓 Chromium 使用真實視窗大小，內容才會隨使用者拉動視窗而縮放
    viewport: null,
    userAgent: fp.userAgent,
    locale: fp.locale,
    timezoneId: fp.timezone,
    geolocation: fp.geolocation,
    permissions: ['geolocation'],
    colorScheme: 'light',
    // deviceScaleFactor 不能與 viewport:null 同時使用；改由指紋 init script 覆蓋 devicePixelRatio
    isMobile: false,
    hasTouch: fp.hasTouch,
    args: [
      ...fpArgs,
      `--window-size=${slot.w},${slot.h}`,
      `--window-position=${slot.x},${slot.y}`,
      '--disable-blink-features=AutomationControlled',
    ],
  });

  await context.addInitScript(getFingerprintEngine().buildInitScript(fp));

  // 載入之前保存的 storageState（如果有）
  const statePath = path.join(dir, 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (state.cookies?.length) await context.addCookies(state.cookies);
    } catch (e: any) { console.log(`[Session] 載入 state 失敗: ${e.message}`); }
  } else if (!baseUrl.includes('127.0.0.1')) {
    // 兼容性兜底：state.json 缺失但账号记录里带有 FB 会话 Cookie 字符串（导入时携带），
    // 直接解析并注入，确保删除档案 / 重新导入后仍能还原登录态
    const accCookies = acc?.cookies;
    if (accCookies) {
      try {
        const cookies = accCookies.split(';').map(s => s.trim()).filter(Boolean).map(part => {
          const i = part.indexOf('=');
          return i < 0 ? null : { name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), domain: '.facebook.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' as const };
        }).filter(Boolean) as any[];
        if (cookies.length) { await context.addCookies(cookies); console.log(`[Session] 從账号記錄還原 ${cookies.length} 個Cookie: ${accountId}`); }
      } catch (e: any) { console.log(`[Session] Cookie 兜底注入失敗: ${e.message}`); }
    }
  }

  let page = context.pages()[0] || await context.newPage();

  // 透過 CDP 注入與偽裝 UA 一致的 Client Hints（Sec-CH-UA-*），避免 UA 與 Client Hints 不一致被風控識別
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: fp.userAgent,
      acceptLanguage: getFingerprintEngine().buildAcceptLanguage(fp),
      platform: fp.platform,
      userAgentMetadata: getFingerprintEngine().buildUserAgentMetadata(fp),
    });
    cdp.detach().catch(() => {});
  } catch (e: any) {
    console.log(`[Session] ClientHints 覆蓋失敗 (${accountId}): ${e.message}`);
  }

  const wrapped = wrapPage(page, baseUrl);

  // 導航到該帳號對應的 FB_BASE（避免 about:blank 導致的 cookie/檢測錯誤）
  try {
    await wrapped.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e: any) {
    console.log(`[Session] 初始導航超時或失敗 (${accountId} -> ${baseUrl}): ${e.message}`);
  }
  // 若導航產生新頁面，重新包裝
  page = context.pages()[0] || page;
  const finalWrapped = wrapPage(page, baseUrl);

  const session: Session = {
    accountId,
    context,
    page: finalWrapped,
    profileDir: dir,
    startedAt: Date.now(),
  };
  sessions.set(accountId, session);
  // 註冊瀏覽器 PID，供視窗重排（retile）依 PID 移動已開視窗
  // 註：此 playwright-core 版本的 Browser 型別未暴露 process()，執行期轉型取得
  const browserAny = context.browser() as any;
  const pid: number | undefined = browserAny?.process?.()?.pid;
  windowManager.setPid(accountId, pid);
  // 每次開新視窗後，把所有已開視窗一起重鋪，避免後開的覆蓋/重疊舊視窗
  try { await retileAllSessions(); } catch (e: any) { console.log(`[Session] 開窗後重鋪失敗: ${e.message}`); }
  // 若該帳號處於「示范录制」中，啟動即掛載監聽器（使用者手動操作將被記錄）
  if (isRecording(accountId)) {
    try { await attachRecorder(session.page, accountId); } catch (e: any) { console.log(`[Session] 示范录制掛載失敗 (${accountId}): ${e.message}`); }
  }
  return session;
}

/**
 * 對已存在的會話掛載示范录制（用於「打開窗口並開始錄制」按鈕啟動後補掛）。
 */
export async function attachDemoToSession(accountId: string): Promise<boolean> {
  const s = sessions.get(accountId);
  if (!s) return false;
  const raw = s.context.pages()[0];
  if (!raw) return false;
  await attachRecorder(raw, accountId);
  return true;
}

export function getSession(accountId: string): Session | undefined {
  return sessions.get(accountId);
}

export async function closeSession(accountId: string, saveState = true): Promise<void> {
  const s = sessions.get(accountId);
  if (!s) return;
  if (saveState) await persistSession(accountId);
  try { await s.context.close(); } catch {}
  sessions.delete(accountId);
  windowManager.unregister(accountId);
  // 關閉一個視窗後，把剩餘視窗重新擴展到全螢幕，避免留空
  try { await retileAllSessions(); } catch (e: any) { console.log(`[Session] 關窗後重鋪失敗: ${e.message}`); }
}

/**
 * 透過 CDP 把全部已開瀏覽器視窗重新平鋪（不依賴 PID / PowerShell 視窗代柄，
 * 解決舊視窗在開新視窗後未被重排的問題）。
 */
/** 最近一次 retile 下发的窗口矩形（仅记录，供只读诊断接口使用） */
let lastRetileBounds: { accountId: string; x: number; y: number; w: number; h: number }[] = [];
export function getLastRetileBounds() { return lastRetileBounds; }

export async function retileAllSessions(): Promise<void> {
  const ids = windowManager.getAll().map((w) => w.accountId);
  if (ids.length === 0) { lastRetileBounds = []; return; }
  const screen = getScreenResolution();
  const slots = computeTileLayout(screen.width, screen.height, ids.length);
  lastRetileBounds = [];
  for (let i = 0; i < ids.length; i++) {
    const s = sessions.get(ids[i]);
    if (!s) continue;
    const slot = slots[i];
    try {
      const rawPage = s.context.pages()[0];
      if (!rawPage) continue;
      const cdp = await s.context.newCDPSession(rawPage);
      try {
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Browser.setWindowBounds', {
          windowId,
          bounds: { left: slot.x, top: slot.y, width: slot.w, height: slot.h },
        });
        lastRetileBounds.push({ accountId: ids[i], x: slot.x, y: slot.y, w: slot.w, h: slot.h });
      } finally {
        await cdp.detach();
      }
    } catch (e: any) {
      console.log(`[retile] ${ids[i]} CDP 移動失敗: ${e?.message || e}`);
    }
  }
}

/** 當前活躍瀏覽器實例數（供資源負載展示） */
export function getActiveSessionCount(): number {
  return sessions.size;
}

/** 列出活躍 session（含 accountId / 當前 url / pid / 啟動時間），供全局監控使用 */
export function listActiveSessions(): { accountId: string; url: string; pid?: number; startedAt: number }[] {
  const pidMap = new Map(windowManager.getAll().map((w) => [w.accountId, w.pid] as [string, number | undefined]));
  return Array.from(sessions.values()).map((s) => ({
    accountId: s.accountId,
    url: s.page.url(),
    pid: pidMap.get(s.accountId),
    startedAt: s.startedAt,
  }));
}

export async function persistSession(accountId: string): Promise<string> {
  const s = sessions.get(accountId);
  if (!s) return '';
  const statePath = path.join(s.profileDir, 'state.json');
  // Cookie 備份 + 輪換（PRD 4.1）：先快照舊 state，再覆寫，保留最近 10 份
  if (fs.existsSync(statePath)) {
    try {
      const bdir = path.join(DATA_DIR, 'cookie-backup', accountId);
      fs.mkdirSync(bdir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(statePath, path.join(bdir, `state-${ts}.json`));
      const files = fs.readdirSync(bdir).filter(f => f.startsWith('state-')).sort();
      while (files.length > 10) { fs.unlinkSync(path.join(bdir, files.shift()!)); }
    } catch (e: any) {
      console.log(`[Session] cookie 備份失敗 (${accountId}): ${e.message}`);
    }
  }
  try {
    // 瀏覽器已被強殺/崩潰時跳過 storageState，避免無意義錯誤與對死上下文操作
    if (!s.context.browser()?.isConnected()) { console.log(`[Session] 跳過 storageState(${accountId}): 瀏覽器已離線`); return ''; }
    const state = await s.context.storageState();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (e: any) {
    // 上下文已關閉（崩潰/被外部結束）時 storageState 會拋錯，這裡吞掉避免連鎖崩潰
    console.log(`[Session] storageState 失敗(上下文可能已關閉 ${accountId}): ${e.message}`);
  }
  return statePath;
}

export async function screenshot(accountId: string, suffix: string): Promise<string> {
  const s = sessions.get(accountId);
  if (!s) return '';
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const p = path.join(SCREENSHOT_DIR, `${accountId}_${suffix}_${Date.now()}.png`);
  await s.page.screenshot({ path: p, fullPage: false });
  return p;
}

export async function closeAllSessions(): Promise<void> {
  for (const id of Array.from(sessions.keys())) await closeSession(id);
}

// ---------------- 自動定時重排視窗 ----------------

let autoRetileTimer: NodeJS.Timeout | null = null;
let autoRetileEnabled = true;
let lastRetileCount = 0;

/** 啟動定時自動重排（預設每 5 秒），視窗數變化或手動觸發時統一排成網格 */
export function startAutoRetile(intervalMs = 5000): void {
  if (autoRetileTimer) return;
  autoRetileEnabled = true;
  autoRetileTimer = setInterval(async () => {
    if (!autoRetileEnabled) return;
    try {
      const currentCount = sessions.size;
      // 只有當視窗數變化，或原本就有視窗，才進行重排，避免空轉
      if (currentCount === 0) { lastRetileCount = 0; return; }
      if (currentCount !== lastRetileCount || currentCount > 0) {
        await retileAllSessions();
        lastRetileCount = currentCount;
      }
    } catch (e: any) {
      console.log(`[AutoRetile] 定時重排失敗: ${e.message}`);
    }
  }, intervalMs);
  console.log(`[AutoRetile] 已啟動，間隔 ${intervalMs}ms`);
}

/** 停止自動重排 */
export function stopAutoRetile(): void {
  autoRetileEnabled = false;
  if (autoRetileTimer) {
    clearInterval(autoRetileTimer);
    autoRetileTimer = null;
  }
}

/** 暫停/恢復自動重排 */
export function setAutoRetileEnabled(enabled: boolean): void {
  autoRetileEnabled = enabled;
}

export function isAutoRetileEnabled(): boolean {
  return autoRetileEnabled;
}

export function isAutoRetileRunning(): boolean {
  return autoRetileTimer !== null;
}

// 模組載入時自動啟動（用戶要求“定時檢測當前窗口排列，智能化”）
startAutoRetile();

/**
 * 檢測當前實例透過代理的實時出口 IP（螺旋代理每次開窗 IP 不同）。
 * 開一個獨立新分頁訪問 IP 查詢服務，讀取純文字 IP 後關閉，不干擾 FB 主頁。
 * 回傳檢測到的 IP，並寫入 account.exitIp 供儀表板即時展示。
 */
export async function detectExitIp(accountId: string): Promise<string | undefined> {
  const s = sessions.get(accountId);
  if (!s) return undefined;
  let tab: any;
  try {
    tab = await s.context.newPage();
    await tab.goto('https://api.ipify.org?format=text', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const ip = String(await tab.evaluate(() => (document.body ? document.body.innerText : ''))).trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      updateAccount(accountId, { exitIp: ip });
      console.log(`[Session] ${accountId} 實時出口 IP: ${ip}`);
      return ip;
    }
    console.log(`[Session] ${accountId} 出口 IP 格式異常: ${ip}`);
  } catch (e: any) {
    console.log(`[Session] 出口 IP 檢測失敗 (${accountId}): ${e.message}`);
  } finally {
    if (tab) { try { await tab.close(); } catch {} }
  }
  return undefined;
}
