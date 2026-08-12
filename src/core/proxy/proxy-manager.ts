/**
 * ProxyManager — 代理池管理
 * 支持 Clash API 接入 + 手动添加代理 + 代理分配
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { DATA_DIR } from '../../config';
import { getSocks5Pool, Socks5Forward } from './socks5-pool';

export interface ProxyNode {
  name: string;
  type: string;           // Shadowsocks, Vmess, Trojan, HTTP, SOCKS5
  host?: string;
  port?: number;
  delay?: number;          // 延迟 ms
  group: string;           // 所属代理组
  alive: boolean;
}

export interface ManualProxy {
  id: string;
  name: string;
  type: 'http' | 'https' | 'socks5' | 'ssh';
  host: string;
  port: number;
  username?: string;
  password?: string;
  country?: string;
  /** 连接延迟（毫秒），每次测通时刷新 */
  latency?: number;
  lastCheck: number;
  alive: boolean;
  /** 真实穿透检测到的出口 IP（代理真正生效才有值；否则为空） */
  exitIp?: string;
  /** 检测备注：正常时为出口信息，异常时为失败原因（如本机 IP 未加入白名单） */
  note?: string;
}

export interface ProxyTestResult {
  id: string;
  alive: boolean;
  latency: number; // -1 表示未测得
  exitIp?: string;
  note?: string;
}

// —— 真实穿透检测：真正透過代理發出 HTTPS 請求，驗證出口 IP 與真實延遲 ——
// 舊版 checkManualProxy 只做 TCP connect 握手（網關端口開著就報成功），
// 導致 DataImpulse 這類「端口開放但拒絕隧道」的代理被誤判為正常（出現 1ms 假陽性）。
// 新版真正發出請求並比對出口 IP，才能反映代理是否真的可用。
let cachedDirectIp: string | null = null;
function execCurl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('curl', args, { windowsHide: true, timeout: 30000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout || '');
    });
  });
}
async function getDirectIp(): Promise<string> {
  if (cachedDirectIp !== null) return cachedDirectIp;
  try {
    cachedDirectIp = (await execCurl(['-s', '-m', '10', 'https://api.ipify.org'])).trim();
  } catch { cachedDirectIp = ''; }
  return cachedDirectIp ?? '';
}

interface RealProxyCheck { alive: boolean; latency: number; exitIp: string; note: string; }

/** 判斷是否應走 SOCKS5 本地轉發器（DataImpulse 實測：HTTP CONNECT 被拒，Socks5 可用） */
function shouldUseSocks5Forwarder(p: ManualProxy): boolean {
  return p.type === 'socks5' || p.host === 'gw.dataimpulse.com' || (p.username || '').includes('__cr.');
}

async function realProxyCheck(p: ManualProxy): Promise<RealProxyCheck> {
  const t0 = Date.now();
  const useSocks5 = shouldUseSocks5Forwarder(p);

  // SOCKS5 代理：開臨時本地轉發器 → Chromium 可用的 HTTP 本地代理 → 真實取出口 IP
  // 避免依賴 curl 的 SOCKS5 實現（Git Bash curl 對此 DataImpulse 會 exit97，但瀏覽器/Node 原生可通）
  if (useSocks5) {
    const fwd = new Socks5Forward(0, p.host, p.port, p.username || '', p.password || '');
    let localPort = 0;
    try {
      localPort = await fwd.start();
    } catch (e: any) {
      return { alive: false, latency: -1, exitIp: '', note: `SOCKS5 本地轉發器啟動失敗（${(e.message || '').slice(0, 80)}）` };
    }
    try {
      const proxyUrl = `http://127.0.0.1:${localPort}`;
      const exitIp = (await execCurl(['-s', '-m', '20', '--connect-timeout', '15', '-x', proxyUrl, 'https://api.ipify.org'])).trim();
      const dt = Date.now() - t0;
      const directIp = await getDirectIp();
      const ipRe = /^\d{1,3}(\.\d{1,3}){3}$/;
      if (ipRe.test(exitIp) && exitIp !== directIp) {
        return { alive: true, latency: dt, exitIp, note: `出口 ${exitIp}（已成功穿透代理）` };
      }
      if (exitIp === directIp && ipRe.test(directIp)) {
        return { alive: false, latency: dt, exitIp, note: '代理未真正轉發：出口 IP 與直連相同' };
      }
      return { alive: false, latency: dt, exitIp, note: '代理無回傳出口 IP：隧道被拒' };
    } catch (e: any) {
      const dt = Date.now() - t0;
      const msg = (e && e.message ? e.message : 'unknown').slice(0, 120);
      return { alive: false, latency: dt, exitIp: '', note: `代理連線失敗（${msg}）` };
    } finally {
      fwd.stop();
    }
  }

  // 純 HTTP/HTTPS 代理：直接用 curl 測試
  const scheme = p.type === 'https' ? 'https' : 'http';
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}@` : '';
  const proxyUrl = `${scheme}://${auth}${p.host}:${p.port}`;
  try {
    const exitIp = (await execCurl(['-s', '-m', '20', '--connect-timeout', '15', '-x', proxyUrl, 'https://api.ipify.org'])).trim();
    const dt = Date.now() - t0;
    const directIp = await getDirectIp();
    const ipRe = /^\d{1,3}(\.\d{1,3}){3}$/;
    if (ipRe.test(exitIp) && exitIp !== directIp) {
      return { alive: true, latency: dt, exitIp, note: `出口 ${exitIp}（已成功穿透代理）` };
    }
    if (exitIp === directIp && ipRe.test(directIp)) {
      return { alive: false, latency: dt, exitIp, note: '代理未真正轉發：出口 IP 與直連相同' };
    }
    return { alive: false, latency: dt, exitIp, note: '代理無回傳出口 IP：隧道被拒' };
  } catch (e: any) {
    const dt = Date.now() - t0;
    const msg = (e && e.message ? e.message : 'unknown').slice(0, 120);
    return { alive: false, latency: -1, exitIp: '', note: `代理連線失敗（${msg}）` };
  }
}

export class ProxyManager extends EventEmitter {
  private clashUrl: string = '';
  private clashSecret: string = '';
  private manualProxies: ManualProxy[] = [];
  private assignment: Map<string, string> = new Map(); // accountId → proxyId
  private proxiesFile = path.join(DATA_DIR, 'proxies.json');

  // SOCKS5 本地轉發池整合：ProxyManager 負責存儲/分配，Socks5Pool 負責把 SOCKS5 代理轉成 Chromium 可用的本地 HTTP 代理
  private pool = getSocks5Pool();
  private poolIdByProxyId = new Map<string, string>(); // proxy-manager id → socks5-pool id
  private poolIdByAccount = new Map<string, string>(); // accountId → socks5-pool id
  private poolSyncPromise: Promise<void> | null = null;

  constructor() {
    super();
    this.load();
  }

  /** 服務啟動時調用：把已持久化的分配同步到 SOCKS5 本地轉發池，啟動對應 forwarder */
  async init(): Promise<void> {
    if (this.poolSyncPromise) return this.poolSyncPromise;
    this.poolSyncPromise = (async () => {
      for (const [accId, pxId] of this.assignment) {
        try { await this.syncAssignmentToPool(accId, pxId); } catch (e: any) { console.warn('[Proxy] init 同步分配失敗:', accId, e.message); }
      }
    })();
    return this.poolSyncPromise;
  }

  private ensureProxyInPool(px: ManualProxy): string {
    let poolId = this.poolIdByProxyId.get(px.id);
    if (poolId) return poolId;
    const entry = this.pool.addProxy({
      host: px.host,
      port: px.port,
      username: px.username || '',
      password: px.password || '',
    });
    this.poolIdByProxyId.set(px.id, entry.id);
    return entry.id;
  }

  private async syncAssignmentToPool(accountId: string, proxyId: string) {
    const oldPoolId = this.poolIdByAccount.get(accountId);
    if (!proxyId) {
      if (oldPoolId) {
        this.pool.deactivateProxy(oldPoolId);
        this.poolIdByAccount.delete(accountId);
      }
      return;
    }
    const px = this.manualProxies.find(p => p.id === proxyId);
    if (!px) return;
    const poolId = this.ensureProxyInPool(px);
    if (oldPoolId && oldPoolId !== poolId) this.pool.deactivateProxy(oldPoolId);
    await this.pool.assignToAccount(poolId, accountId);
    this.poolIdByAccount.set(accountId, poolId);
  }

  /** 从磁盘加载代理池（重启不丢）；并对旧解析残留（端口非法/host 异常）自动自愈 */
  private load() {
    try {
      if (fs.existsSync(this.proxiesFile)) {
        const raw = JSON.parse(fs.readFileSync(this.proxiesFile, 'utf-8'));
        const rawProxies = Array.isArray(raw.proxies) ? raw.proxies : [];
        let healed = false;
        this.manualProxies = rawProxies.map((p: any) => {
          const portOk = typeof p.port === 'number' && Number.isFinite(p.port) && p.port > 0;
          const hostOk = typeof p.host === 'string' && p.host.length > 0 && !p.host.includes('@');
          // 旧解析残留（如把 DataImpulse 的 user:pass@host 误拆）会导致端口为空或 host 含 @
          if (!portOk || !hostOk) {
            const fixed = this.parseProxyLine(p.name || '');
            if (fixed && fixed.host && typeof fixed.port === 'number' && fixed.port > 0) {
              healed = true;
              return {
                ...p,
                host: fixed.host,
                port: fixed.port,
                username: fixed.username ?? p.username,
                password: fixed.password ?? p.password,
                type: fixed.type,
              };
            }
          }
          return p;
        });
        this.assignment = new Map(Object.entries(raw.assignment || {}));
        console.log(`[Proxy] 已加载 ${this.manualProxies.length} 个代理，分配 ${this.assignment.size} 个`);
        if (healed) { console.log('[Proxy] 检测到旧解析残留，已自动修复代理条目并写回磁盘'); this.save(); }
      }
    } catch (e: any) {
      console.warn('[Proxy] 加载代理文件失败:', e.message);
    }
  }

  /** 持久化到磁盘 */
  private save() {
    try {
      const dir = path.dirname(this.proxiesFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, unknown> = {};
      for (const [k, v] of this.assignment) obj[k] = v;
      fs.writeFileSync(this.proxiesFile, JSON.stringify({ proxies: this.manualProxies, assignment: obj }, null, 2));
    } catch (e: any) {
      console.warn('[Proxy] 保存代理文件失败:', e.message);
    }
  }

  /**
   * 解析代理文本，支持多种格式：
   *   形式A: type://user:pass@host:port        (带协议头，如 http://u:p@h:8080)
   *   形式B: user:pass@host:port               (DataImpulse 经典格式，无协议头但有 @ 鉴权；
   *                                             用户名/密码可能含冒号，故 @ 之前用「首个冒号」切分 user/auth)
   *   形式C: host:port 或 host:port:user:pass   (纯 IP:端口 / 旧式无 @ 格式)
   */
  parseProxyLine(line: string): Omit<ManualProxy, 'id' | 'lastCheck' | 'alive'> | null {
    const s = line.trim();
    if (!s || s.startsWith('#')) return null;

    // 形式A: type://[user:pass@]host:port
    let m = s.match(/^(https?|socks5|ssh):\/\/(?:([^:@/]+):([^@/]*)@)?([^:/]+):(\d+)$/);
    if (m) {
      return { name: s, type: m[1] as any, host: m[4], port: parseInt(m[5], 10), username: m[2], password: m[3], country: '' };
    }

    // 形式B: user:pass@host:port  (DataImpulse：USERNAME:PASSWORD@HOST:PORT，user/pass 可能含冒号)
    //       用 @ 作硬分隔：@ 前为 user:pass（首个冒号切分），@ 后为 host:port
    m = s.match(/^(?:([^:@]+):)?([^@]*)@([^:]+):(\d+)$/);
    if (m) {
      const host = m[3];
      const isDataImpulse = host === 'gw.dataimpulse.com';
      return {
        name: s, type: isDataImpulse ? 'socks5' : 'http',
        host, port: parseInt(m[4], 10),
        username: m[1] || undefined, password: m[2] || undefined,
        country: '',
      };
    }

    // 形式C: host:port[:user:pass]
    const parts = s.split(':');
    if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
      return { name: s, type: 'http', host: parts[0], port: parseInt(parts[1], 10), username: parts[2], password: parts[3], country: '' };
    }
    return null;
  }

  configureClash(url: string, secret: string = '') {
    this.clashUrl = url.replace(/\/$/, '');
    this.clashSecret = secret;
  }

  /** 从 Clash 获取所有代理节点 */
  async fetchClashNodes(): Promise<ProxyNode[]> {
    if (!this.clashUrl) return [];
    try {
      const headers: Record<string,string> = { 'Accept': 'application/json' };
      if (this.clashSecret) headers['Authorization'] = `Bearer ${this.clashSecret}`;

      const res = await fetch(`${this.clashUrl}/proxies`, { headers, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const data = await res.json();
      const nodes: ProxyNode[] = [];

      for (const [key, val] of Object.entries(data.proxies || {})) {
        const v = val as any;
        if (v.type === 'Selector' || v.type === 'URLTest' || v.type === 'Fallback') {
          for (const name of (v.all || [])) {
            const node = data.proxies?.[name];
            if (node && node.type !== 'Selector' && node.type !== 'URLTest') {
              nodes.push({
                name, type: node.type || 'unknown',
                host: node.host, port: node.port,
                delay: node.history?.slice(-1)[0]?.delay || 0,
                group: key, alive: node.alive !== false,
              });
            }
          }
        }
      }
      return nodes;
    } catch { return []; }
  }

  /** 测速 */
  async testDelay(nodeName: string, testUrl = 'https://www.gstatic.com/generate_204', timeout = 3000): Promise<number> {
    if (!this.clashUrl) return -1;
    try {
      const headers: Record<string,string> = {};
      if (this.clashSecret) headers['Authorization'] = `Bearer ${this.clashSecret}`;
      const encoded = encodeURIComponent(nodeName);
      const res = await fetch(`${this.clashUrl}/proxies/${encoded}/delay?url=${encodeURIComponent(testUrl)}&timeout=${timeout}`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) { const d = await res.json(); return d.delay || -1; }
      return -1;
    } catch { return -1; }
  }

  /** 切换 Clash 代理组节点 */
  async switchClashNode(group: string, nodeName: string): Promise<boolean> {
    if (!this.clashUrl) return false;
    try {
      const headers: Record<string,string> = { 'Content-Type': 'application/json' };
      if (this.clashSecret) headers['Authorization'] = `Bearer ${this.clashSecret}`;
      const encoded = encodeURIComponent(group);
      const res = await fetch(`${this.clashUrl}/proxies/${encoded}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ name: nodeName }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch { return false; }
  }

  /** 手动添加代理 */
  addManualProxy(proxy: Omit<ManualProxy, 'id' | 'lastCheck' | 'alive'>): ManualProxy {
    const mp: ManualProxy = {
      ...proxy, id: 'pxy_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
      lastCheck: 0, alive: true,
    };
    this.manualProxies.push(mp);
    this.save();
    return mp;
  }

  /** 批量导入代理文本（TXT，每行一条） */
  importProxyText(text: string): number {
    let added = 0;
    for (const line of text.split(/\r?\n/)) {
      const parsed = this.parseProxyLine(line);
      if (parsed) { this.manualProxies.push({ ...parsed, id: 'pxy_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), lastCheck: 0, alive: true }); added++; }
    }
    if (added) this.save();
    return added;
  }

  /** 删除手动代理 */
  removeManualProxy(id: string) {
    this.manualProxies = this.manualProxies.filter(p => p.id !== id);
    // 清理分配
    for (const [accId, pxId] of this.assignment) {
      if (pxId === id) this.assignment.delete(accId);
    }
    this.save();
  }

  /** 检测手动代理是否可用：真正透過代理發出 HTTPS 請求並驗證出口 IP，杜絕 TCP 握手假陽性 */
  async checkManualProxy(id: string): Promise<boolean> {
    const p = this.manualProxies.find(x => x.id === id);
    if (!p) return false;
    const r = await realProxyCheck(p);
    p.alive = r.alive;
    p.latency = r.alive ? r.latency : -1;
    p.exitIp = r.exitIp;
    p.note = r.note;
    p.lastCheck = Date.now();
    this.save();
    return r.alive;
  }

  /** 批量检测所有手动代理：同 (host,username) 認證視為一組，只需真實檢測一條代表，避免逐條 20s 超時 */
  async testAllProxies(): Promise<ProxyTestResult[]> {
    if (!this.manualProxies.length) return [];
    const groups = new Map<string, ManualProxy[]>();
    for (const p of this.manualProxies) {
      const key = `${p.host}|${p.username || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    const reps = [...groups.values()].map(g => g[0]);
    const checks = await Promise.all(reps.map(r => realProxyCheck(r)));
    const repByKey = new Map<string, RealProxyCheck>();
    [...groups.keys()].forEach((k, i) => repByKey.set(k, checks[i]));
    const results: ProxyTestResult[] = [];
    for (const p of this.manualProxies) {
      const r = repByKey.get(`${p.host}|${p.username || ''}`)!;
      p.alive = r.alive;
      p.latency = r.alive ? r.latency : -1;
      p.exitIp = r.exitIp;
      p.note = r.note;
      p.lastCheck = Date.now();
      results.push({ id: p.id, alive: r.alive, latency: p.latency, exitIp: r.exitIp, note: r.note });
    }
    this.save();
    return results;
  }

  /** 分配代理给账号 */
  async assignProxy(accountId: string, proxyId: string) {
    if (!proxyId) {
      this.unassignProxy(accountId);
      return;
    }
    this.assignment.set(accountId, proxyId);
    this.save();
    await this.syncAssignmentToPool(accountId, proxyId);
  }

  /** 解绑账号的代理分配（账号删除或重新分配时调用，让该代理槽位轮空等待下次导入补充） */
  unassignProxy(accountId: string) {
    if (this.assignment.has(accountId)) {
      this.assignment.delete(accountId);
      this.save();
    }
    this.syncAssignmentToPool(accountId, '').catch(() => {});
  }

  /**
   * 顺序分配：给给定账号列表中的每一个「尚未绑定代理」的账号，
   * 按代理池数组顺序分配下一个空闲代理槽位（已绑定的不动）。
   * 删除账号释放出来的槽位会优先被本次分配填回 —— 实现「轮空等待下次导入补充」。
   * 返回本次新分配的账号数。
   */
  async assignSequentially(accountIds: string[]): Promise<number> {
    const proxies = this.getManualProxies();
    if (!proxies.length) return 0;
    // 当前已被占用的代理槽位
    const usedProxyIds = new Set(this.assignment.values());
    // 空闲槽位（保持代理池原始顺序）
    const freeProxies = proxies.filter(p => !usedProxyIds.has(p.id));
    let pi = 0;
    let assigned = 0;
    for (const accId of accountIds) {
      if (this.assignment.has(accId)) continue; // 已有代理，跳过
      if (pi >= freeProxies.length) break;       // 没有更多空闲槽位
      await this.assignProxy(accId, freeProxies[pi].id);
      assigned++;
      pi++;
    }
    return assigned;
  }

  /** 获取账号的代理 */
  getAssignedProxy(accountId: string): ManualProxy | undefined {
    const pxId = this.assignment.get(accountId);
    if (!pxId) return undefined;
    return this.manualProxies.find(p => p.id === pxId);
  }

  /** 获取账号的代理连接字符串（用于 Chromium / Playwright）
   * 優先返回 Socks5Pool 本地轉發器地址（http://127.0.0.1:{port}），Chromium 無需 SOCKS5 認證即可使用 */
  getProxyString(accountId: string): string | undefined {
    const poolStr = this.pool.getProxyString(accountId);
    if (poolStr) return poolStr;
    // fallback：直接回傳原始代理字串（適用非 DataImpulse 的 HTTP 代理）
    const px = this.getAssignedProxy(accountId);
    if (!px) return undefined;
    if ('host' in px && px.host) {
      const auth = px.username ? `${px.username}:${px.password}@` : '';
      return `${px.type}://${auth}${px.host}:${px.port}`;
    }
    return undefined;
  }

  /** 获取所有手动代理 */
  getManualProxies(): ManualProxy[] { return [...this.manualProxies]; }

  /** 获取分配表 */
  getAssignments(): Record<string, string> {
    const obj: Record<string,string> = {};
    this.assignment.forEach((v,k) => obj[k] = v);
    return obj;
  }
}

let instance: ProxyManager | null = null;
export function getProxyManager(): ProxyManager {
  if (!instance) instance = new ProxyManager();
  return instance;
}
