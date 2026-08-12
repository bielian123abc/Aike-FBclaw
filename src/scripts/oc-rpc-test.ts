// 临时验证：用 WebSocket RPC 连 OpenClaw 网关 (127.0.0.1:18789)，发 chat.send，验证能否经 DeepSeek 回话
async function main() {
  const WebSocket = (globalThis as any).WebSocket;
  const ws: any = new WebSocket('ws://127.0.0.1:18789/');
  let connected = false;
  let msgId = 1;
  const pending = new Map<string, { resolve: (s: string) => void; t: NodeJS.Timeout }>();
  let resolveFn: (s: string) => void = () => {};

  const connectReq = () => JSON.stringify({
    type: 'req', id: 'c1', method: 'connect',
    params: {
      minProtocol: 4, maxProtocol: 4,
      client: { id: 'node-host', version: '1.0', platform: 'windows', mode: 'node' },
      role: 'operator', scopes: ['operator.read', 'operator.write'],
    },
  });

  const onMsg = (ev: any) => {
    let m: any;
    try { m = JSON.parse(ev.data?.toString?.() ?? ev.data); } catch { return; }
    if (m.type === 'event' && m.event === 'connect.challenge') {
      ws.send(connectReq());
    } else if (m.type === 'res' && m.ok && m.payload?.type === 'hello-ok') {
      connected = true;
      console.log('[connected] hello-ok');
      const id = 'm' + (msgId++);
      const t = setTimeout(() => { pending.delete(id); resolveFn('TIMEOUT'); }, 60000);
      pending.set(id, { resolve: resolveFn, t });
      ws.send(JSON.stringify({
        type: 'req', id, method: 'chat.send',
        params: { content: '你好，請用繁體中文回一句話，證明你已經連上 DeepSeek 模型。' },
      }));
    } else if (m.type === 'event' && m.payload?.text) {
      const id = [...pending.keys()][0];
      if (id) { const p = pending.get(id)!; pending.delete(id); clearTimeout(p.t); p.resolve(m.payload.text); }
    } else if (m.type === 'res' && !m.ok) {
      resolveFn('ERR: ' + JSON.stringify(m.error || m).slice(0, 200));
    }
  };

  const resultP = new Promise<string>((resolve) => {
    resolveFn = resolve;
    ws.addEventListener('open', () => { ws.send(connectReq()); });
    ws.addEventListener('message', onMsg);
    ws.addEventListener('error', (e: any) => resolveFn('WS_ERROR: ' + (e?.message || JSON.stringify(e))));
    setTimeout(() => { if (!connected) resolveFn('NO_CONNECT'); }, 8000);
  });

  const r = await resultP;
  console.log('RESULT_START>>>');
  console.log(r);
  console.log('<<<RESULT_END');
  ws.close();
  process.exit(0);
}
main();
