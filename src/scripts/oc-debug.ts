import * as http from 'http';
import * as crypto from 'crypto';

const TOKEN = 'e09a469628b389933b6cce1fbb8b315e4f7b988cc3942730';

let sock: any;
let buffer = Buffer.alloc(0);

function wsSend(data: any) {
  const json = JSON.stringify(data);
  const buf = Buffer.from(json);
  const len = buf.length;
  let frame: Buffer;
  if (len < 126) frame = Buffer.concat([Buffer.from([0x81, len]), buf]);
  else if (len < 65536) frame = Buffer.concat([Buffer.from([0x81, 126, (len >> 8) & 0xFF, len & 0xFF]), buf]);
  else return;
  sock.write(frame);
}

const key = crypto.randomBytes(16).toString('base64');
const req = http.request({
  hostname: '127.0.0.1', port: 18789, path: '/',
  method: 'GET',
  headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
});

req.on('upgrade', (_res: any, socket: any) => {
  sock = socket;
  console.log('Connected\n');
  
  socket.on('data', (raw: Buffer) => {
    buffer = Buffer.concat([buffer, raw]);
    while (buffer.length >= 2) {
      let len = buffer[1] & 0x7F, off = 2;
      if (len === 126) { if (buffer.length < 4) break; len = (buffer[2] << 8) | buffer[3]; off = 4; }
      if (len === 127) break;
      if (buffer.length < off + len) break;
      try {
        const msg = JSON.parse(buffer.slice(off, off + len).toString());
        buffer = buffer.slice(off + len);
        
        // 打印完整消息
        console.log('📩', JSON.stringify(msg, null, 2).slice(0, 400));
        console.log('---');
        
        if (msg.event === 'connect.challenge') {
          const nonce = msg.payload.nonce;
          const sig = crypto.createHmac('sha256', TOKEN).update(nonce).digest('hex');
          console.log('Sending auth response...');
          wsSend({ type: 'connect.response', nonce, signature: sig });
        }
        
        if (msg.event === 'connect.ok') {
          console.log('\n✅ 认证成功！发送消息...\n');
          wsSend({
            type: 'chat.send',
            content: '你好！我是Aike-FBclaw的共同开发者。你是谁？请简单介绍一下你自己。'
          });
        }
        
        if (msg.type === 'chat.response' || msg.text || (msg.payload && msg.payload.text)) {
          console.log('\n💬 AI说:', msg.text || msg.content || msg.payload?.text || JSON.stringify(msg).slice(0, 300));
          sock.end();
          process.exit(0);
        }
        
      } catch { break; }
    }
  });
  
  socket.on('close', () => { process.exit(0); });
  
  setTimeout(() => { console.log('Timeout'); process.exit(1); }, 30000);
});

req.end();
