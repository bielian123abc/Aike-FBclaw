/**
 * Socks5Pool — 代理池 + 本地转发器
 * 
 * 每个代理自动分配独立本地端口
 * 一个代理 = 一个本地端口 = 一个 Chromium 可用代理
 */
import * as net from 'net';
import * as fs from 'fs';

interface ProxyEntry {
  id: string;
  originalUrl: string;     // 原始 user:pass@host:port
  localPort: number;       // 分配的本地端口
  host: string;
  port: number;
  username: string;
  password: string;
  status: 'idle' | 'active' | 'dead';
  forwarder: Socks5Forward | null;
  assignedAccount: string; // 分配给哪个账号
}

export class Socks5Forward {
  private server: net.Server | null = null;
  private fromSocket: net.Socket | null = null;
  private toSocket: net.Socket | null = null;

  constructor(
    private localPort: number,
    private remoteHost: string,
    private remotePort: number,
    private user: string,
    private pass: string,
  ) {}

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((local) => {
        this.handleConn(local).catch(() => local.destroy());
      });
      this.server.on('error', reject);
      this.server.listen(this.localPort, '127.0.0.1', () => {
        const addr = this.server!.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });
  }

  stop() {
    this.server?.close();
  }

  private async handleConn(local: net.Socket) {
    const remote = new net.Socket();
    // 关键：两端 socket 必须常驻 error/close 處理器，否則傳輸中斷（ECONNRESET）會觸發未捕獲 error 事件把整個進程拖崩
    const cleanup = () => { try { local.destroy(); } catch {} try { remote.destroy(); } catch {} };
    local.on('error', cleanup);
    remote.on('error', cleanup);
    local.on('close', cleanup);
    remote.on('close', cleanup);
    try {
      await new Promise<void>((resolve, reject) => {
        remote.once('error', reject);
        remote.connect(this.remotePort, this.remoteHost);
        remote.once('connect', () => { remote.removeListener('error', reject); resolve(); });
      });
      // SOCKS5 handshake
      await this.socksAuth(remote);
      // 读客户端第一个包
      const first = await new Promise<Buffer>(resolve => local.once('data', resolve));
      const head = first.toString();
      let host = '127.0.0.1', port = 443;
      if (head.startsWith('CONNECT')) {
        const m = head.match(/CONNECT (.+):(\d+)/);
        if (m) { host = m[1]; port = parseInt(m[2]); }
      }
      // SOCKS5 connect
      await this.socksConnect(remote, host, port);
      if (head.startsWith('CONNECT')) {
        local.write(Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'));
      } else {
        remote.write(first);
      }
      local.pipe(remote); remote.pipe(local);
    } catch { cleanup(); }
  }

  private socksAuth(sock: net.Socket): Promise<void> {
    return new Promise((res, rej) => {
      sock.write(Buffer.from([0x05, 0x01, 0x02]));
      sock.once('data', (d) => {
        if (d[0] !== 0x05 || d[1] !== 0x02) return rej(new Error('no socks5 auth'));
        const u = Buffer.from(this.user, 'utf-8'), p = Buffer.from(this.pass, 'utf-8');
        sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        sock.once('data', (d2) => {
          d2[0] === 0x01 && d2[1] === 0x00 ? res() : rej(new Error('auth fail'));
        });
      });
    });
  }

  private socksConnect(sock: net.Socket, host: string, port: number): Promise<void> {
    return new Promise((res, rej) => {
      const h = Buffer.from(host, 'utf-8');
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([(port>>8)&0xFF, port&0xFF])]));
      sock.once('data', d => d[0]===0x05&&d[1]===0x00?res():rej(new Error('connect fail')));
    });
  }
}

export class Socks5Pool {
  private proxies: Map<string, ProxyEntry> = new Map();
  private nextPort = 11080;

  /** 从文件批量导入 */
  importFile(filePath: string): number {
    if (!fs.existsSync(filePath)) return 0;
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    let count = 0;
    for (const line of lines) {
      const match = line.trim().match(/^([^:]+):([^@]+)@([^:]+):(\d+)$/);
      if (match) {
        this.addProxy({ host: match[3], port: parseInt(match[4]), username: match[1], password: match[2] });
        count++;
      }
    }
    return count;
  }

  /** 添加一个代理 */
  addProxy(opts: { host: string; port: number; username: string; password: string }): ProxyEntry {
    const port = this.nextPort++;
    const url = `${opts.username}:${opts.password}@${opts.host}:${opts.port}`;
    const entry: ProxyEntry = {
      id: 'px_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      originalUrl: url, localPort: port,
      host: opts.host, port: opts.port,
      username: opts.username, password: opts.password,
      status: 'idle', forwarder: null, assignedAccount: '',
    };
    this.proxies.set(entry.id, entry);
    return entry;
  }

  /** 启动转发器 */
  async activateProxy(id: string): Promise<number> {
    const entry = this.proxies.get(id);
    if (!entry) throw new Error('Not found');
    if (entry.forwarder) return entry.localPort; // 已在运行

    const fwd = new Socks5Forward(entry.localPort, entry.host, entry.port, entry.username, entry.password);
    await fwd.start();
    entry.forwarder = fwd;
    entry.status = 'active';
    return entry.localPort;
  }

  /** 停止转发器 */
  deactivateProxy(id: string) {
    const entry = this.proxies.get(id);
    if (entry?.forwarder) {
      entry.forwarder.stop();
      entry.forwarder = null;
      entry.status = 'idle';
    }
  }

  /** 分配给账号（自动启动） */
  async assignToAccount(proxyId: string, accountId: string): Promise<string> {
    // 取消旧分配
    for (const [, p] of this.proxies) {
      if (p.assignedAccount === accountId) {
        this.deactivateProxy(p.id);
        p.assignedAccount = '';
      }
    }
    const entry = this.proxies.get(proxyId);
    if (!entry) throw new Error('Proxy not found');
    await this.activateProxy(proxyId);
    entry.assignedAccount = accountId;
    // 返回 Chromium 可用的代理地址
    return `http://127.0.0.1:${entry.localPort}`;
  }

  /** 获取 Chromium 代理字符串 */
  getProxyString(accountId: string): string | undefined {
    for (const [, p] of this.proxies) {
      if (p.assignedAccount === accountId && p.forwarder) {
        return `http://127.0.0.1:${p.localPort}`;
      }
    }
    return undefined;
  }

  /** 列出所有代理 */
  list(): any[] {
    return Array.from(this.proxies.entries()).map(([id, p]) => ({
      id, localPort: p.localPort,
      host: p.host, port: p.port,
      username: p.username.slice(0, 15) + '...',
      status: p.status,
      assignedAccount: p.assignedAccount || '-',
    }));
  }

  /** 获取分配表 */
  getAssignments(): Record<string, string> {
    const map: Record<string,string> = {};
    for (const [, p] of this.proxies) {
      if (p.assignedAccount) map[p.assignedAccount] = p.id;
    }
    return map;
  }

  async stopAll() {
    for (const [, p] of this.proxies) this.deactivateProxy(p.id);
  }
}

let instance: Socks5Pool | null = null;
export function getSocks5Pool(): Socks5Pool {
  if (!instance) instance = new Socks5Pool();
  return instance;
}
