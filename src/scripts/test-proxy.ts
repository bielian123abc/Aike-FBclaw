/**
 * SOCKS5 本地转发代理
 * 解决 Chromium --proxy-server 不支持 SOCKS5 认证的问题
 * 在本机开一个端口，转发到 DataImpulse SOCKS5
 */
import * as net from 'net';
import { EventEmitter } from 'events';

export class Socks5Forwarder extends EventEmitter {
  private server: net.Server | null = null;
  private targetHost: string;
  private targetPort: number;
  private username: string;
  private password: string;
  private localPort: number;

  constructor(target: string, localPort: number) {
    super();
    // 解析 socks5://user:pass@host:port
    const match = target.replace('socks5://', '').match(/^(.+):(.+)@(.+):(\d+)$/);
    if (!match) throw new Error('Invalid proxy format');
    this.username = match[1];
    this.password = match[2];
    this.targetHost = match[3];
    this.targetPort = parseInt(match[4]);
    this.localPort = localPort;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((localSocket) => {
        this.handleConnection(localSocket).catch(() => localSocket.destroy());
      });

      this.server.on('error', reject);
      this.server.listen(this.localPort, '127.0.0.1', () => {
        console.log(`[Forwarder] 127.0.0.1:${this.localPort} → ${this.targetHost}:${this.targetPort}`);
        resolve(this.localPort);
        this.emit('started', this.localPort);
      });
    });
  }

  private async handleConnection(local: net.Socket) {
    const remote = new net.Socket();

    try {
      // 连接到远程 SOCKS5
      await new Promise<void>((resolve, reject) => {
        remote.once('connect', resolve);
        remote.once('error', reject);
        remote.connect(this.targetPort, this.targetHost);
      });

      // SOCKS5 握手
      await this.socks5Handshake(remote);

      // 获取目标地址（从客户端发来的第一个请求包判断）
      // HTTP 代理模式：直接转发
      const firstChunk = await new Promise<Buffer>((resolve) => {
        local.once('data', resolve);
      });

      // 解析 HTTP CONNECT 或直接转发
      const header = firstChunk.toString();
      let destHost = '';
      let destPort = 443;

      if (header.startsWith('CONNECT')) {
        const m = header.match(/CONNECT (.+):(\d+)/);
        if (m) { destHost = m[1]; destPort = parseInt(m[2]); }
      }

      // SOCKS5 CONNECT 请求
      await this.socks5Connect(remote, destHost || 'api.ipify.org', destPort);

      // 如果不是CONNECT方法，重新写入数据
      if (!header.startsWith('CONNECT')) {
        remote.write(firstChunk);
      } else {
        // CONNECT 方法，告诉客户端连接已建立
        local.write(Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'));
      }

      // 双向转发
      local.pipe(remote);
      remote.pipe(local);

      local.on('close', () => remote.destroy());
      remote.on('close', () => local.destroy());

    } catch (e) {
      local.destroy();
      remote.destroy();
    }
  }

  private async socks5Handshake(socket: net.Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      // SOCKS5 greeting: version 5, 1 method, method 0x02 (auth)
      socket.write(Buffer.from([0x05, 0x01, 0x02]));

      socket.once('data', (data) => {
        if (data[0] !== 0x05) return reject(new Error('Not SOCKS5'));
        if (data[1] === 0x02) {
          // 发送认证
          const user = Buffer.from(this.username, 'utf-8');
          const pass = Buffer.from(this.password, 'utf-8');
          const msg = Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]);
          socket.write(msg);

          socket.once('data', (data2) => {
            if (data2[0] === 0x01 && data2[1] === 0x00) {
              resolve();
            } else {
              reject(new Error('SOCKS5 auth failed'));
            }
          });
        } else {
          reject(new Error(`SOCKS5 method not supported: 0x${data[1].toString(16)}`));
        }
      });
    });
  }

  private async socks5Connect(socket: net.Socket, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const hostBuf = Buffer.from(host, 'utf-8');
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([(port >> 8) & 0xFF, port & 0xFF]),
      ]);
      socket.write(req);

      socket.once('data', (data) => {
        if (data[0] === 0x05 && data[1] === 0x00) {
          resolve();
        } else {
          reject(new Error(`SOCKS5 connect failed: 0x${data[1].toString(16)}`));
        }
      });
    });
  }

  async stop() {
    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// 测试
async function test() {
  const fwd = new Socks5Forwarder(
    'socks5://48a3fd421a833e48cbc3__cr.tw:be3e67017b61eb52@gw.dataimpulse.com:10000',
    11080
  );
  await fwd.start();
  console.log('Forwarder running. Use http://127.0.0.1:11080 as proxy.');

  // 测试连接
  const { chromium } = await import('playwright-core');
  const context = await chromium.launchPersistentContext('G:/Aike-FBclaw/data/proxy-test4', {
    headless: false,
    args: ['--no-sandbox', '--proxy-server=http://127.0.0.1:11080', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
    locale: 'zh-TW', timezoneId: 'Asia/Taipei',
  });
  const page = await context.newPage();
  await page.goto('https://api.ipify.org?format=json', { waitUntil: 'load', timeout: 20000 });
  const text = await page.textContent('body');
  console.log('✅ Proxy IP:', text);
  await context.close();
  await fwd.stop();
  process.exit(0);
}

test().catch(e => { console.log('❌', e.message); process.exit(1); });
