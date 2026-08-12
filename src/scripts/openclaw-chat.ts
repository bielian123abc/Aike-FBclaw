/**
 * OpenClaw 共同开发者对话脚本
 * 通过 WebSocket 连接 OpenClaw，发送项目上下文，获取分析建议
 */
import * as http from 'http';
import * as crypto from 'crypto';

const TOKEN = 'e09a469628b389933b6cce1fbb8b315e4f7b988cc3942730';
const WS_URL = { hostname: '127.0.0.1', port: 18789, path: '/' };

let sock: any;
let buffer = Buffer.alloc(0);
let authenticated = false;
let chatSessionId: string | null = null;
let messageQueue: string[] = [];
let currentReply = '';
let currentTimeout: any;

function wsSend(data: any) {
  const json = JSON.stringify(data);
  const buf = Buffer.from(json);
  const len = buf.length;
  let frame: Buffer;
  if (len < 126) frame = Buffer.concat([Buffer.from([0x81, len]), buf]);
  else if (len < 65536) frame = Buffer.concat([Buffer.from([0x81, 126, (len >> 8) & 0xFF, len & 0xFF]), buf]);
  else frame = Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0, (len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]), buf]);
  sock.write(frame);
}

function sendChat(content: string) {
  console.log('\n📤 发送: ' + content.slice(0, 80) + (content.length > 80 ? '...' : ''));
  wsSend({ type: 'chat.send', content });
  currentReply = '';
  currentTimeout = setTimeout(() => {
    if (currentReply) {
      console.log('\n💬 AI回复:\n' + currentReply + '\n');
    } else {
      console.log('\n⏰ 等待AI回复超时\n');
    }
    if (messageQueue.length > 0) {
      setTimeout(() => sendChat(messageQueue.shift()!), 2000);
    } else {
      console.log('对话结束');
      sock.end();
      process.exit(0);
    }
  }, 30000);
}

function onMessage(msg: any) {
  if (msg.event === 'connect.challenge') {
    const sig = crypto.createHmac('sha256', TOKEN).update(msg.payload.nonce).digest('hex');
    wsSend({ type: 'connect.response', nonce: msg.payload.nonce, signature: sig });
    return;
  }

  if (msg.event === 'connect.ok') {
    authenticated = true;
    console.log('✅ 已认证，开始对话...');
    // 开始发送第一条消息
    setTimeout(() => sendChat(messageQueue.shift()!), 1000);
    return;
  }

  // AI回复
  if (msg.type === 'message' || msg.type === 'chat.response' || msg.event === 'agent.reply' || msg.event === 'agent.message') {
    const text = msg.content || msg.text || msg.payload?.content || msg.payload?.text || '';
    if (text) {
      currentReply += text;
      // 检查是否是完整回复
      if (msg.type === 'message' && msg.done !== false) {
        clearTimeout(currentTimeout);
        console.log('\n💬 AI回复:\n' + currentReply + '\n');
        if (messageQueue.length > 0) {
          setTimeout(() => sendChat(messageQueue.shift()!), 2000);
        } else {
          console.log('对话结束');
          sock.end();
          process.exit(0);
        }
      }
    }
  }

  // 流式回复
  if (msg.type === 'stream' || msg.event === 'stream.token') {
    const text = msg.token || msg.content || '';
    if (text) {
      currentReply += text;
      process.stdout.write(text);
    }
    if (msg.done || msg.stop) {
      clearTimeout(currentTimeout);
      console.log('\n');
      if (messageQueue.length > 0) {
        setTimeout(() => sendChat(messageQueue.shift()!), 2000);
      } else {
        sock.end();
        process.exit(0);
      }
    }
  }
}

// 连接
const key = crypto.randomBytes(16).toString('base64');
const req = http.request({
  ...WS_URL,
  method: 'GET',
  headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
});

req.on('upgrade', (_res, socket) => {
  sock = socket;
  sock.on('data', (raw: Buffer) => {
    buffer = Buffer.concat([buffer, raw]);
    while (buffer.length >= 2) {
      let len = buffer[1] & 0x7F, off = 2;
      if (len === 126) { if (buffer.length < 4) break; len = (buffer[2] << 8) | buffer[3]; off = 4; }
      if (len === 127) break;
      if (buffer.length < off + len) break;
      try {
        const msg = JSON.parse(buffer.slice(off, off + len).toString());
        buffer = buffer.slice(off + len);
        onMessage(msg);
      } catch { break; }
    }
  });
  sock.on('close', () => { console.log('WS关闭'); process.exit(0); });
});

req.on('error', (e: any) => { console.log('连接失败:', e.message); process.exit(1); });
req.end();

// 消息队列
messageQueue = [
  '你好！我是 Aike-FBclaw 的共同开发者。现在你是这个软件的 AI 助手。当前项目是一个 Facebook 多账号 AI 运营系统。\n\n请先一句话自我介绍，然后告诉我：作为这个软件的内置 AI，你目前能做什么？看到什么？知道这个项目吗？',
];
