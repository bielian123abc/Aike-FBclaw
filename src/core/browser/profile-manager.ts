/**
 * BrowserProfileManager — 自建浏览器配置文件管理器
 * CDP 方式啟動 Chrome（繞開 Playwright persistent context 視口 bug）
 */
import { chromium, BrowserContext, Page } from 'playwright-core';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { EventEmitter } from 'events';
import { FingerprintEngine, FingerprintConfig, getFingerprintEngine } from './fingerprint';
import { FB_BASE, DATA_DIR } from '../../config';

export interface ProfileConfig {
  accountId: string;
  name: string;
  proxy?: string;
  dataDir?: string;
}

export interface ProfileInfo {
  accountId: string;
  name: string;
  status: 'offline' | 'active' | 'error';
  dataDir: string;
  fingerprint: FingerprintConfig;
  proxy?: string;
  createdAt: number;
  lastUsed: number;
}

export interface BrowserInstance {
  context: BrowserContext;
  page: Page;
  config: ProfileConfig;
  fingerprint: FingerprintConfig;
  startedAt: number;
  process?: ChildProcess;
  cdpPort?: number;
}

// 輔助：找空閒端口
function findFreePort(startFrom: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startFrom, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      server.close(() => resolve(port));
    });
    server.on('error', () => resolve(findFreePort(startFrom + 1)));
  });
}

// 輔助：字串 hash
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return Math.abs(h);
}

// Playwright 內建的 Chromium 路徑
const CHROME_PATH = 'C:/Users/UR/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

export class BrowserProfileManager extends EventEmitter {
  private profiles: Map<string, ProfileInfo> = new Map();
  private instances: Map<string, BrowserInstance> = new Map();
  private fp: FingerprintEngine;
  private baseDataDir: string;
  private portMap: Map<string, number> = new Map(); // accountId → CDP port

  constructor() {
    super();
    this.fp = getFingerprintEngine();
    this.baseDataDir = path.join(DATA_DIR, 'browser-profiles');
    fs.mkdirSync(this.baseDataDir, { recursive: true });
    this.loadProfiles();
  }

  async launchBrowser(accountId: string, config?: Partial<ProfileConfig>): Promise<BrowserInstance> {
    let profile = this.getProfile(accountId);
    if (!profile) {
      profile = this.createProfile({ accountId, name: config?.name || accountId, proxy: config?.proxy });
    }
    await this.closeBrowser(accountId);

    const fingerprint = profile.fingerprint;
    const fpArgs = this.fp.buildLaunchArgs(fingerprint, profile.proxy);

    // CDP port（同一個 account 復用上次的 port，避免 port 洩漏）
    let cdpPort = this.portMap.get(accountId);
    if (!cdpPort) {
      const basePort = 9222 + (hashStr(accountId) % 100);
      cdpPort = await findFreePort(basePort);
      this.portMap.set(accountId, cdpPort);
    }

    // Chrome 參數：去掉 Playwright 專屬 flags，加 CDP，並給初始視窗大小
    const chromeArgs = [
      `--user-data-dir=${profile.dataDir}`,
      `--remote-debugging-port=${cdpPort}`,
      `--remote-debugging-address=127.0.0.1`,
      `--window-name=FB_${profile.name}`,
      `--window-size=${fingerprint.viewportWidth},${fingerprint.viewportHeight}`,
      ...fpArgs.filter(a =>
        !a.startsWith('--user-data-dir') &&
        !a.startsWith('--remote-debugging') &&
        !a.startsWith('--window-size') &&
        a !== '--disable-blink-features=AutomationControlled'
      ),
    ];

    console.log(`[Browser] 啟動 Chrome CDP port=${cdpPort}`);

    // 啟動 Chrome
    const proc = spawn(CHROME_PATH, [...chromeArgs, 'about:blank'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 消费 stderr 避免缓冲区满阻塞进程
    proc.stderr.on('data', () => {});
    proc.on('error', (err) => { console.error(`[Browser] Chrome spawn error: ${err.message}`); });

    // 等待 CDP 可用
    let browser: any = null;
    let lastErr = '';
    for (let i = 0; i < 40; i++) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
        break;
      } catch (e: any) { lastErr = e.message?.slice(0, 60); }
      if (proc.exitCode !== null) {
        throw new Error(`Chrome 異常退出 code=${proc.exitCode}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!browser) throw new Error(`CDP 連接超時: ${lastErr}`);

    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();

    // 注入指紋（must be before navigation）
    await ctx.addInitScript(this.fp.buildInitScript(fingerprint));

    // 從 state.json 加載 Cookie
    const statePath = path.join(profile.dataDir, 'state.json');
    const cookieDomain = (() => { try { return new URL(FB_BASE).hostname; } catch { return '.facebook.com'; } })();
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        if (state.cookies && state.cookies.length > 0) {
          const fixedCookies = state.cookies.map((c: any) => ({
            name: c.name, value: c.value, domain: c.domain || cookieDomain, path: c.path || '/',
          }));
          await ctx.addCookies(fixedCookies);
          console.log(`[Browser] 加載 ${fixedCookies.length} 個Cookie: ${profile.name}`);
        }
      } catch (e: any) { console.log(`[Browser] Cookie 加載失敗: ${e.message}`); }
    }

    // 導航到 Facebook / Mock FB（init script 會在此時生效）
    try {
      await page.goto(FB_BASE + '/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (e: any) {
      console.log(`[Browser] goto 超時但繼續: ${profile.name}`);
    }
    await page.waitForTimeout(3000);

    const instance: BrowserInstance = {
      context: ctx, page,
      config: { accountId, name: profile.name, proxy: profile.proxy },
      fingerprint, startedAt: Date.now(),
      process: proc, cdpPort,
    };
    this.instances.set(accountId, instance);

    profile.status = 'active';
    profile.lastUsed = Date.now();
    this.saveProfiles();

    this.emit('browser_started', { accountId, profile });
    return instance;
  }

  async closeBrowser(accountId: string): Promise<void> {
    const inst = this.instances.get(accountId);
    if (inst) {
      try { await inst.context.close(); } catch {}
      if (inst.process) {
        try { inst.process.kill(); } catch {}
        // 強制殺掉（等 2 秒後），Windows 使用 SIGTERM 等價
        setTimeout(() => {
          try { 
            if (inst.process?.pid) {
              try { process.kill(inst.process.pid); } catch {}
              try { execSync(`taskkill /F /PID ${inst.process.pid}`, { stdio: 'ignore' }); } catch {}
            }
          } catch {}
        }, 2000);
      }
      this.instances.delete(accountId);
      const p = this.profiles.get(accountId);
      if (p) { p.status = 'offline'; this.saveProfiles(); }
      this.emit('browser_closed', { accountId });
    }
  }

  async closeAll(): Promise<void> {
    for (const id of Array.from(this.instances.keys())) await this.closeBrowser(id);
  }

  getInstance(accountId: string): BrowserInstance | undefined { return this.instances.get(accountId); }
  getActiveCount(): number { return this.instances.size; }
  getActiveIds(): string[] { return Array.from(this.instances.keys()); }
  getProfile(accountId: string): ProfileInfo | undefined { return this.profiles.get(accountId); }
  getAllProfiles(): ProfileInfo[] { return Array.from(this.profiles.values()); }

  async getCookies(accountId: string): Promise<any[]> {
    const inst = this.instances.get(accountId);
    return inst ? inst.context.cookies() : [];
  }

  async setCookies(accountId: string, cookies: any[]): Promise<void> {
    const inst = this.instances.get(accountId);
    if (inst) await inst.context.addCookies(cookies);
  }

  createProfile(config: ProfileConfig): ProfileInfo {
    const dataDir = config.dataDir || path.join(this.baseDataDir, config.accountId);
    fs.mkdirSync(dataDir, { recursive: true });
    const fingerprint = this.fp.generate(config.accountId);
    const info: ProfileInfo = {
      accountId: config.accountId, name: config.name, status: 'offline',
      dataDir, fingerprint, proxy: config.proxy,
      createdAt: Date.now(), lastUsed: 0,
    };
    this.profiles.set(config.accountId, info);
    this.saveProfiles();
    return info;
  }

  async deleteProfile(accountId: string): Promise<void> {
    await this.closeBrowser(accountId);
    const p = this.profiles.get(accountId);
    if (p) {
      try { fs.rmSync(p.dataDir, { recursive: true, force: true }); } catch {}
      this.profiles.delete(accountId);
      this.saveProfiles();
    }
  }

  private profilesFile = () => path.join(this.baseDataDir, 'profiles.json');

  private saveProfiles(): void {
    try {
      const data = Array.from(this.profiles.entries()).map(([id, i]) => ({ id, ...i }));
      fs.writeFileSync(this.profilesFile(), JSON.stringify(data, null, 2));
    } catch {}
  }

  private loadProfiles(): void {
    try {
      const f = this.profilesFile();
      if (fs.existsSync(f)) {
        for (const item of JSON.parse(fs.readFileSync(f, 'utf-8'))) {
          this.profiles.set(item.id || item.accountId, {
            accountId: item.id || item.accountId,
            name: item.name, status: 'offline', dataDir: item.dataDir,
            fingerprint: item.fingerprint, proxy: item.proxy,
            createdAt: item.createdAt, lastUsed: item.lastUsed,
          });
        }
      }
    } catch {}
  }
}

let mgr: BrowserProfileManager | null = null;
export function getBrowserManager(): BrowserProfileManager {
  if (!mgr) mgr = new BrowserProfileManager();
  return mgr;
}
