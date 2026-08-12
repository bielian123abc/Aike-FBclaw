/**
 * Mock Facebook — 验证用状态化 HTTP 服务
 *
 * 设计目标：
 * 1. 页面 DOM 严格镜像真实 Facebook 的选择器（aria-label / role / contenteditable），
 *    使 fb-core-skills.ts 的技能代码无需任何改动即可驱动真实浏览器跑通。
 * 2. 每次自动化操作在 Mock 侧产生可验证的副作用（点赞数+1、好友请求、消息记录等），
 *    便于端到端验证「软件真的跑完了功能」。
 * 3. 支持站内 Messenger 聊天小窗（PRD 要求：不跳转 messenger.com）。
 */
import * as http from 'http';
import * as url from 'url';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ---------------- 全局状态 ----------------
interface Post { id: string; author: string; authorUrl: string; text: string; ownPage?: boolean; likes: number; likedBy: Set<string>; }
interface Msg { from: 'me' | 'peer'; text: string; t: number; }
interface Conv { peer: string; msgs: Msg[]; unread: boolean; }
interface Group { id: string; name: string; joined: boolean; }
interface UserState {
  email: string; name: string;
  feed: Post[];
  friends: Set<string>;
  pendingOut: Set<string>;      // 我发出的好友请求
  acceptedFriends: string[];     // 刚通过的好友（供问候流程检测）
  groups: Map<string, Group>;
  conversations: Map<string, Conv>;
  avatarStaged: boolean;        // 已上傳（待儲存）頭像
  avatarCommitted: boolean;     // 已儲存生效的頭像
  avatarStagedFile: string;
  avatarCommittedAt: number;
  pinSet: boolean;              // Messenger 端對端加密 PIN 是否已建立
}

// 頭像「被軟件替換」後的落盤位置（驗證「真實替換」用：原圖位元組會經由
// skillSetAvatar.setInputFiles → Mock /api/mock/avatar 寫入此處，可與 inbox 原圖比對 sha256）
const AVATAR_MOCK_DIR = path.join(process.cwd(), 'data', 'avatars', 'mock-applied');

const users = new Map<string, UserState>();

const SUGGESTED = [
  { name: '林怡君', about: '台中 · 跨境电商物流' },
  { name: '陳志遠', about: '台北 · 选品分析' },
  { name: '王美玲', about: '高雄 · 虾皮卖家' },
  { name: '張家豪', about: '台南 · 貨代' },
  { name: '黃詩涵', about: '桃园 · 独立站' },
];

const GROUPS = [
  { id: 'g_logistics', name: '台灣跨境電商物流交流' },
  { id: 'g_selection', name: '蝦皮選品研究室' },
  { id: 'g_agency', name: '獨立站增長社' },
];

const OWN_PAGE_NAME = '我的官方商城';

function seedUser(email: string): UserState {
  const name = email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const u: UserState = {
    email, name,
    feed: [],
    friends: new Set(),
    pendingOut: new Set(),
    acceptedFriends: [],
    groups: new Map(),
    conversations: new Map(),
    avatarStaged: false,
    avatarCommitted: false,
    avatarStagedFile: '',
    avatarCommittedAt: 0,
    pinSet: false,
  };
  for (const g of GROUPS) u.groups.set(g.id, { ...g, joined: false });

  // 种子动态（含一条 own-page 帖子供「自动点赞自己主页」功能检测）
  u.feed.push(mkPost('p1', '跨境電商物流交流', '/p1', '最近海運時效真的不穩，大家都是用哪家貨代？', false));
  u.feed.push(mkPost('p2', '選品研究室', '/p2', '這週數據顯示寵物用品轉化率最高 🐶', false));
  u.feed.push(mkPost('p_own', OWN_PAGE_NAME, '/page/own', '【限時優惠】新品上架，輸入折扣碼 FB10 享9折 🎉', true));
  // 指定種子粉絲頁帖子（供 onboarding「主頁點讚」步驟檢測/執行；POST /api/mock/like?post=p_seed）
  u.feed.push(mkPost('p_seed', '台灣生活誌', '/page/seed-fan', '歡迎來到台灣生活誌，按讚支持我們 🌿', false));

  // 种子未讀對話（供 AI 聊天自動回覆）
  u.conversations.set('林怡君', {
    peer: '林怡君', unread: true,
    msgs: [
      { from: 'peer', text: '嗨～我看你在物流社團很活躍，想請教一下你都用哪個貨代？', t: Date.now() - 60000 },
    ],
  });
  u.conversations.set('陳志遠', {
    peer: '陳志遠', unread: true,
    msgs: [
      { from: 'peer', text: '你好，我們都在選品社團，最近想做日本站選品，你有經驗嗎？', t: Date.now() - 120000 },
    ],
  });

  // 种子「剛通過的好友」（供加好友→問候流程檢測）
  u.acceptedFriends.push('黃詩涵');
  return u;
}

function mkPost(id: string, author: string, authorUrl: string, text: string, ownPage: boolean): Post {
  return { id, author, authorUrl, text, ownPage, likes: Math.floor(Math.random() * 30), likedBy: new Set() };
}

function getUser(req: http.IncomingMessage): UserState {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/c_user=([^;]+)/);
  const email = m ? decodeURIComponent(m[1]) : 'guest@mock.local';
  if (!users.has(email)) users.set(email, seedUser(email));
  return users.get(email)!;
}

// ---------------- HTML 片段 ----------------
function chatWidget(u: UserState): string {
  const convs = Array.from(u.conversations.values()).map(c => ({
    peer: c.peer,
    unread: c.unread,
    msgs: c.msgs,
  }));
  return `
  <div id="msgTray" style="position:fixed;bottom:0;right:12px;width:300px;z-index:9999;font-family:sans-serif">
    <div style="background:#1877f2;color:#fff;padding:8px;cursor:pointer" onclick="toggleTray()">💬 訊息 (${u.conversations.size})</div>
    <div id="trayList" style="display:none;background:#fff;border:1px solid #ccc;max-height:300px;overflow:auto">
      ${Array.from(u.conversations.values()).map(c => `
        <div role="button" data-peer="${c.peer}" onclick="openChat('${c.peer}')"
             style="padding:8px;border-bottom:1px solid #eee;cursor:pointer">
          ${c.peer} ${c.unread ? '<span style="color:red">●未讀</span>' : ''}
        </div>`).join('')}
    </div>
  </div>
  <div role="dialog" id="chatDialog" style="display:none;position:fixed;bottom:12px;right:12px;width:340px;height:420px;background:#fff;border:1px solid #1877f2;z-index:10000;font-family:sans-serif;flex-direction:column">
    <div id="chatHeader" style="background:#1877f2;color:#fff;padding:8px">對話</div>
    <div id="chatMessages" style="flex:1;overflow:auto;padding:8px"></div>
    <div contenteditable="true" role="textbox" aria-label="Message..." id="chatInput"
         style="border-top:1px solid #ccc;padding:8px;min-height:36px;outline:none"
         data-peer=""></div>
  </div>
  <script>
    const __convs = ${JSON.stringify(convs)};
    function toggleTray(){ const l=document.getElementById('trayList'); l.style.display = l.style.display==='none'?'block':'none'; }
    function openChat(peer){
      const c = __convs.find(x=>x.peer===peer); if(!c) return;
      document.getElementById('chatDialog').style.display='flex';
      document.getElementById('chatHeader').textContent='與 '+peer+' 的對話';
      const box=document.getElementById('chatMessages'); box.innerHTML='';
      c.msgs.forEach(m=>{ const d=document.createElement('div'); d.setAttribute('role','row');
        d.style.textAlign = m.from==='me'?'right':'left';
        d.innerHTML='<span style="background:'+(m.from==='me'?'#dcf8c6':'#eee')+';padding:4px 8px;border-radius:8px;display:inline-block">'+m.text+'</span>';
        box.appendChild(d); });
      box.scrollTop=box.scrollHeight;
      const inp=document.getElementById('chatInput'); inp.setAttribute('data-peer',peer); inp.textContent='';
      // 标记已讀
      fetch('/api/mock/read?peer='+encodeURIComponent(peer));
    }
    document.getElementById('chatInput').addEventListener('keydown', function(e){
      if(e.key==='Enter' && !e.shiftKey){
        e.preventDefault();
        const peer=this.getAttribute('data-peer'); const text=this.innerText.trim();
        if(!text) return;
        fetch('/api/mock/send',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({peer,text})}).then(()=>{ this.textContent=''; });
      }
    });
  </script>`;
}

function fbShell(title: string, body: string, u: UserState, opts: { chat?: boolean } = {}): string {
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
  <title>${title} | Facebook</title>
  <style>body{margin:0;font-family:sans-serif;background:#f0f2f5;color:#1c1e21}
  .topbar{background:#1877f2;color:#fff;padding:10px 16px;font-weight:bold;position:sticky;top:0}
  .wrap{max-width:680px;margin:16px auto;display:flex;gap:16px}
  .feed{flex:1;display:flex;flex-direction:column;gap:12px}
  .card{background:#fff;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.1)}
  .postAuthor{font-weight:600;margin-bottom:6px}
  .postText{margin:6px 0;line-height:1.5}
  .btn{display:inline-block;cursor:pointer;padding:6px 12px;border-radius:6px;background:#e4e6eb;margin-right:6px;user-select:none}
  .btn.primary{background:#1877f2;color:#fff}
  .composer{cursor:pointer}
  .side{width:200px}</style></head>
  <body>
  ${u.email!=='guest@mock.local'?`<div class="topbar">📘 Facebook · ${u.name}</div>`:`<div class="topbar">📘 Facebook</div>`}
  ${body}
  ${opts.chat ? chatWidget(u) : ''}
  </body></html>`;
}

function homePage(u: UserState): string {
  const body = `<div class="wrap">
    <div class="feed">
      <div class="card composer" role="button" aria-label="在想些什麼" onclick="openComposer()">
        <div style="color:#65676b">在想些什麼？</div>
      </div>
      <div id="composerBox" style="display:none" class="card">
        <div contenteditable="true" role="textbox" id="postEditor" style="border:1px solid #ccc;border-radius:6px;padding:8px;min-height:60px;outline:none"></div>
        <div class="btn primary" role="button" aria-label="Post" onclick="publishPost()">發布</div>
      </div>
      ${u.feed.map(p => postCard(p, u)).join('')}
    </div>
  </div>
  <script>
    function openComposer(){ document.getElementById('composerBox').style.display='block'; }
    function publishPost(){ const t=document.getElementById('postEditor').innerText.trim(); if(!t) return;
      fetch('/api/mock/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})}).then(()=>location.reload()); }
    function like(id){ location.href='/api/mock/like?post='+id; }
    function share(id){ location.href='/api/mock/share?post='+id; }
  </script>`;
  return fbShell('首頁', body, u, { chat: true });
}

function postCard(p: Post, u: UserState): string {
  const liked = p.likedBy.has(u.email);
  return `<div class="card" data-post-id="${p.id}" ${p.ownPage ? 'data-own-page="1"' : ''}>
    <div class="postAuthor">${p.author} ${p.ownPage ? '<span style="color:#1877f2">· 官方主頁</span>' : ''}</div>
    <div class="postText">${p.text}</div>
    <div>
      <span class="likeCount">👍 ${p.likes}</span>
      <div role="button" aria-label="Like" aria-pressed="${liked}" class="btn" onclick="like('${p.id}')">${liked ? '已讚' : '讚'}</div>
      <div role="button" aria-label="Share" class="btn" onclick="share('${p.id}')">分享</div>
    </div>
  </div>`;
}

function loginPage(): string {
  return fbShell('登入', `<div class="wrap"><div class="feed"><div class="card">
    <h2>登入 Facebook</h2>
    <input name="email" placeholder="電子郵件" style="width:100%;padding:8px;margin:6px 0;border:1px solid #ccc;border-radius:6px"><br>
    <input name="pass" type="password" placeholder="密碼" style="width:100%;padding:8px;margin:6px 0;border:1px solid #ccc;border-radius:6px"><br>
    <button name="login" class="btn primary" onclick="doLogin()">登入</button>
    <script>
      function doLogin(){
        const e=document.querySelector('input[name=email]').value;
        const p=document.querySelector('input[name=pass]').value;
        if(!e||!p){ alert('請輸入帳號密碼'); return; }
        document.cookie='c_user='+encodeURIComponent(e)+';path=/;max-age=86400';
        location.href='/';
      }
    </script>
  </div></div></div>`, { email: 'guest@mock.local' } as any, {});
}

function suggestionsPage(u: UserState): string {
  const body = `<div class="wrap"><div class="feed"><div class="card"><h3>好友建議</h3>
    ${SUGGESTED.map(s => {
      const sent = u.pendingOut.has(s.name) || u.friends.has(s.name);
      return `<div class="card" style="display:flex;justify-content:space-between;align-items:center">
        <div><b>${s.name}</b><div style="color:#65676b;font-size:13px">${s.about}</div></div>
        ${sent
          ? `<div class="btn">${u.friends.has(s.name) ? '好友' : '已送邀請'}</div>`
          : `<div role="button" aria-label="Add friend" class="btn primary" onclick="location.href='/api/mock/addfriend?name=${encodeURIComponent(s.name)}'">加好友</div>`}
      </div>`;
    }).join('')}
  </div></div></div>`;
  return fbShell('好友建議', body, u, { chat: true });
}

function groupsPage(u: UserState): string {
  const body = `<div class="wrap"><div class="feed"><div class="card"><h3>社團</h3>
    ${GROUPS.map(g => {
      const g2 = u.groups.get(g.id)!;
      return `<div class="card" style="display:flex;justify-content:space-between;align-items:center">
        <div><b>${g.name}</b></div>
        ${g2.joined
          ? `<div class="btn">已加入</div>`
          : `<div role="button" aria-label="Join group" class="btn primary" onclick="location.href='/api/mock/joingroup?id=${g.id}'">加入</div>`}
      </div>`;
    }).join('')}
  </div></div></div>`;
  return fbShell('社團', body, u, { chat: true });
}

// 為任意 profile 名稱產生穩定的 mock UID（與真實 FB 的數字 UID 格式一致，≥6 位）。
// 這讓 skillSendMessage 的 extractProfileUid（找 data-hovercard="...user.php?id=<UID>"）可在 mock 下解析。
const UID_NAME: Record<string, string> = {};
function uidForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const uid = String(100000000 + (h % 899999999)); // 9 位數，符合 \d{6,}
  UID_NAME[uid] = name;
  return uid;
}

function profilePage(u: UserState, username: string): string {
  const uid = uidForName(username);
  const body = `<div class="wrap"><div class="feed"><div class="card">
    <a data-hovercard="https://www.facebook.com/user.php?id=${uid}" href="/user.php?id=${uid}" style="text-decoration:none;color:inherit;display:flex;align-items:center;gap:12px">
      <div style="width:64px;height:64px;border-radius:50%;background:#1877f2;color:#fff;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:bold">${username.slice(0, 1)}</div>
      <div><h2 style="margin:0">${username}</h2><div style="color:#65676b">跨境電商賣家 · 台灣 · UID ${uid}</div></div>
    </a>
    <div role="button" aria-label="Message" class="btn primary" onclick="openProfileChat('${username}')" style="margin-top:12px">發送訊息</div>
  </div></div></div>
  <script>
    function openProfileChat(n){
      if(!document.getElementById('chatDialog')){location.href='/';return;}
      setTimeout(()=>{
        const c={peer:n,msgs:[]}; window.__convs=window.__convs||[]; if(!window.__convs.find(x=>x.peer===n)) window.__convs.push(c);
        if(typeof openChat==='function') openChat(n);
      }, 50);
    }
  </script>`;
  return fbShell(username, body, u, { chat: true });
}

/**
 * 全頁 Messenger thread（/messages/t/<uid>/）。
 * 這是 skillSendMessage 主路徑的目標頁：composer 位於 FB 主 document DOM 內
 * （div[contenteditable="true"][role="textbox"]），主頁 locator 即可命中，
 * 不像 docked 面板被 fbsbx.com 跨域 iframe 隔離。mock 下用完全相同的選擇器。
 */
function messagesThreadPage(u: UserState, uid: string): string {
  const name = UID_NAME[uid] || ('uid_' + uid);
  const conv = u.conversations.get(name) || { peer: name, msgs: [] as Msg[], unread: false };
  const msgsHtml = (conv.msgs as Msg[]).map(m => `<div role="row" style="text-align:${m.from === 'me' ? 'right' : 'left'};margin:6px 0">
    <span style="background:${m.from === 'me' ? '#dcf8c6' : '#eee'};padding:4px 8px;border-radius:8px;display:inline-block">${m.text}</span></div>`).join('');
  const body = `<div class="wrap"><div class="feed"><div class="card">
    <h3>與 ${name} 的對話</h3>
    <div id="threadMsgs" style="max-height:300px;overflow:auto;border:1px solid #eee;border-radius:6px;padding:8px;margin-bottom:8px">${msgsHtml}</div>
    <div contenteditable="true" role="textbox" aria-label="Message..." id="msgComposer"
         style="border:1px solid #ccc;border-radius:6px;padding:8px;min-height:44px;outline:none" data-testid="messenger_composer_input"></div>
    <div class="btn primary" role="button" aria-label="Send" id="sendBtn" style="margin-top:8px">傳送</div>
  </div></div></div>
  <script>
    const __peer='${name}';
    function sendMsg(){ const el=document.getElementById('msgComposer'); const t=el.innerText.trim(); if(!t) return;
      fetch('/api/mock/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({peer:__peer,text:t})}).then(()=>{ el.textContent=''; }); }
    document.getElementById('msgComposer').addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); }});
    document.getElementById('sendBtn').addEventListener('click', sendMsg);
  </script>`;
  // 全頁 thread 不需要右下角 chatWidget（避免額外 contenteditable 干擾選擇器）
  return fbShell('訊息', body, u, { chat: false });
}

/**
 * 個人主頁 /me — 含「更新個人檔案相片」對話框，嚴格對齊 skillSetAvatar 的選擇器：
 *   - 頭像鈕：div[role="button"][aria-label*="個人檔案相片"]
 *   - 對話框：div[role="dialog"] 內含 input[type="file"]
 *   - 儲存鈕：div[role="dialog"] [role="button"]:has-text("儲存")
 * 選圖後 JS 將圖片 base64 POST 到 /api/mock/avatar（暫存），按儲存再 POST /api/mock/avatar/save（生效）。
 */
function mePage(u: UserState): string {
  const body = `<div class="wrap"><div class="feed"><div class="card">
    <div role="button" aria-label="個人檔案相片" id="avatarBtn"
         style="width:96px;height:96px;border-radius:50%;background:#1877f2;color:#fff;display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:bold;cursor:pointer;margin-bottom:12px">${u.name.slice(0, 1)}</div>
    <h2 style="margin:0">${u.name}</h2>
    <div style="color:#65676b">個人檔案 · 台灣</div>
    <div role="dialog" id="avatarDialog" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10001;align-items:center;justify-content:center">
      <div style="background:#fff;border-radius:8px;padding:20px;width:320px;font-family:sans-serif">
        <h3 style="margin-top:0">更新個人檔案相片</h3>
        <input type="file" id="avatarInput" accept="image/*">
        <div id="avatarStaged" style="color:#1877f2;font-size:13px;margin:8px 0;display:none">已選取圖片，點擊儲存生效</div>
        <div role="button" aria-label="儲存" id="avatarSave"
             style="display:inline-block;cursor:pointer;padding:8px 16px;border-radius:6px;background:#1877f2;color:#fff;margin-top:8px">儲存</div>
      </div>
    </div>
  </div></div></div>
  <script>
    document.getElementById('avatarBtn').addEventListener('click', function(){
      document.getElementById('avatarDialog').style.display='flex';
    });
    document.getElementById('avatarInput').addEventListener('change', async function(){
      const f = this.files[0]; if(!f) return;
      const dataUrl = await new Promise(r=>{ const fr=new FileReader(); fr.onload=()=>r(fr.result); fr.readAsDataURL(f); });
      const r = await fetch('/api/mock/avatar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.name,dataUrl})});
      if(r.ok){ document.getElementById('avatarStaged').style.display='block'; }
    });
    document.getElementById('avatarSave').addEventListener('click', async function(){
      const r = await fetch('/api/mock/avatar/save',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      if(r.ok){ document.getElementById('avatarDialog').style.display='none'; location.reload(); }
    });
  </script>`;
  return fbShell(u.name, body, u, { chat: false });
}

/**
 * Messenger 端對端加密 PIN 設定頁 — 嚴格對齊 handleMessengerPin 選擇器：
 *   - 未建立時顯示 input[type="password"] 與 PIN 相關文字（含「建立」/「PIN」觸發詞），
 *     以及 div[role="button"] aria-label="建立 PIN" 的按鈕（點擊 POST /api/mock/pin）。
 *   - 已建立時僅顯示「PIN 已設定」文字、無密碼輸入框（供 detect 判斷已完成）。
 */
function pinSettingsPage(u: UserState): string {
  const body = u.pinSet
    ? `<div class="card"><h2>Messenger 端對端加密</h2>
         <div id="pinEstablished" style="color:#1877f2;font-weight:600">PIN 已設定</div>
         <p style="color:#65676b">你的訊息已受端對端加密保護。</p></div>`
    : `<div class="card"><h2>Messenger 端對端加密</h2>
         <p>請建立 6 位數 PIN 以啟用端對端加密聊天，保護你的訊息。</p>
         <input type="password" id="pinInput1" placeholder="輸入 PIN" style="padding:8px;margin:4px 0;width:200px;display:block">
         <input type="password" id="pinInput2" placeholder="確認 PIN" style="padding:8px;margin:4px 0;width:200px;display:block">
         <div role="button" aria-label="建立 PIN" id="pinCreate"
              style="display:inline-block;cursor:pointer;padding:8px 16px;border-radius:6px;background:#1877f2;color:#fff;margin-top:8px;font-weight:600">建立 PIN</div>
       </div>
       <script>
         document.getElementById('pinCreate').addEventListener('click', async function(){
           const r = await fetch('/api/mock/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
           if(r.ok){ location.reload(); }
         });
       </script>`;
  return fbShell('Messenger PIN', body, u, { chat: false });
}

/**
 * 指定種子粉絲頁 — 供 onboarding「主頁點讚」步驟檢測/執行。
 * 點讚鈕嚴格對齊 skillLikePost 選擇器：div[aria-label="Like"] 並帶 aria-pressed。
 * 點擊後 POST /api/mock/like?post=p_seed，並 reload 使 aria-pressed 反映已讚狀態。
 */
function seedFanPage(u: UserState): string {
  const p = u.feed.find(x => x.id === 'p_seed') || mkPost('p_seed', '台灣生活誌', '/page/seed-fan', '', false);
  const liked = p.likedBy.has(u.email);
  const body = `<div class="card">
    <h2>台灣生活誌（種子粉絲頁）</h2>
    <p>每日分享台灣在地生活好物與趣聞 🌿</p>
    <div role="button" aria-label="Like" aria-pressed="${liked ? 'true' : 'false'}" id="seedLike"
         style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;padding:8px 14px;border-radius:20px;background:#f0f2f5;font-weight:600;color:#1877f2">
         👍 讚 (<span id="seedLikes">${p.likes}</span>)
    </div>
  </div>
  <script>
    document.getElementById('seedLike').addEventListener('click', async function(){
      const r = await fetch('/api/mock/like?post=p_seed',{method:'POST'});
      if(r.ok){ location.reload(); }
    });
  </script>`;
  return fbShell('台灣生活誌', body, u, { chat: false });
}

// ---------------- 路由 ----------------
export function startMockFB(port: number): http.Server {
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url || '/', true);
    const pathname = parsed.pathname || '/';
    const u = getUser(req);

    // --- JSON API（状态变更） ---
    if (pathname.startsWith('/api/mock/')) {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const q = parsed.query;
        res.setHeader('Content-Type', 'application/json');
        if (pathname === '/api/mock/like') {
          const p = u.feed.find(x => x.id === q.post);
          if (p && !p.likedBy.has(u.email)) { p.likes++; p.likedBy.add(u.email); }
          return res.end(JSON.stringify({ ok: true, likes: p?.likes ?? 0 }));
        }
        if (pathname === '/api/mock/share') {
          const p = u.feed.find(x => x.id === q.post);
          if (p) u.feed.unshift(mkPost('s' + Date.now(), u.name, '/me', '分享了：' + p.text, false));
          return res.end(JSON.stringify({ ok: true }));
        }
        if (pathname === '/api/mock/addfriend') {
          const name = (q.name as string) || '';
          if (!u.pendingOut.has(name) && !u.friends.has(name)) u.pendingOut.add(name);
          return res.end(JSON.stringify({ ok: true }));
        }
        if (pathname === '/api/mock/joingroup') {
          const g = u.groups.get(q.id as string); if (g) g.joined = true;
          return res.end(JSON.stringify({ ok: true, joined: g?.joined }));
        }
        if (pathname === '/api/mock/read') {
          const c = u.conversations.get(q.peer as string); if (c) c.unread = false;
          return res.end(JSON.stringify({ ok: true }));
        }
        if (pathname === '/api/mock/post') {
          const { text } = JSON.parse(body || '{}');
          if (text) u.feed.unshift(mkPost('u' + Date.now(), u.name, '/me', text, false));
          return res.end(JSON.stringify({ ok: true }));
        }
        if (pathname === '/api/mock/send') {
          const { peer, text } = JSON.parse(body || '{}');
          if (peer && text) {
            if (!u.conversations.has(peer)) u.conversations.set(peer, { peer, msgs: [], unread: false });
            u.conversations.get(peer)!.msgs.push({ from: 'me', text, t: Date.now() });
          }
          return res.end(JSON.stringify({ ok: true }));
        }
        if (pathname === '/api/mock/avatar') {
          try {
            const { name, dataUrl } = JSON.parse(body || '{}');
            if (!dataUrl) return res.end(JSON.stringify({ ok: false, error: 'no data' }));
            const b64 = String(dataUrl).split(',')[1] || '';
            const buf = Buffer.from(b64, 'base64');
            fs.mkdirSync(AVATAR_MOCK_DIR, { recursive: true });
            const fn = (u.email || 'guest').replace(/[^a-zA-Z0-9._@-]/g, '_') + '.png';
            fs.writeFileSync(path.join(AVATAR_MOCK_DIR, fn), buf);
            u.avatarStaged = true; u.avatarStagedFile = fn;
            return res.end(JSON.stringify({ ok: true, bytes: buf.length, file: fn }));
          } catch (e: any) { return res.end(JSON.stringify({ ok: false, error: e.message })); }
        }
        if (pathname === '/api/mock/avatar/save') {
          u.avatarCommitted = true; u.avatarCommittedAt = Date.now();
          return res.end(JSON.stringify({ ok: true, committed: true }));
        }
        if (pathname === '/api/mock/pin') {
          u.pinSet = true;
          return res.end(JSON.stringify({ ok: true, pinSet: true }));
        }
        if (pathname === '/api/mock/state') {
          return res.end(JSON.stringify({
            email: u.email, name: u.name,
            feedLikes: u.feed.map(p => ({ id: p.id, likes: p.likes, liked: p.likedBy.has(u.email), ownPage: !!p.ownPage })),
            friends: Array.from(u.friends),
            pendingOut: Array.from(u.pendingOut),
            acceptedFriends: u.acceptedFriends,
            groups: Array.from(u.groups.values()).map(g => ({ id: g.id, name: g.name, joined: g.joined })),
            conversations: Array.from(u.conversations.values()).map(c => ({ peer: c.peer, unread: c.unread, last: c.msgs.slice(-1)[0]?.text || '' })),
            avatar: { staged: u.avatarStaged, committed: u.avatarCommitted, file: u.avatarStagedFile, committedAt: u.avatarCommittedAt },
            pinSet: u.pinSet,
          }, null, 2));
        }
        return res.end(JSON.stringify({ ok: false }));
      });
      return;
    }

    // --- 页面路由 ---
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (pathname === '/' || pathname === '/home') {
      // 未登入跳轉登入頁
      if (u.email === 'guest@mock.local') { res.end(loginPage()); return; }
      return res.end(homePage(u));
    }
    if (pathname === '/login/' || pathname === '/login') { res.end(loginPage()); return; }
    if (pathname === '/me') {
      if (u.email === 'guest@mock.local') { res.end(loginPage()); return; }
      return res.end(mePage(u));
    }
    if (pathname === '/friends/suggestions' || pathname === '/friends/' || pathname === '/friends') {
      if (u.email === 'guest@mock.local') { res.end(loginPage()); return; }
      return res.end(suggestionsPage(u));
    }
    if (pathname === '/groups/feed/' || pathname === '/groups') {
      if (u.email === 'guest@mock.local') { res.end(loginPage()); return; }
      return res.end(groupsPage(u));
    }
    if (pathname.startsWith('/groups/') && pathname.includes('/invite')) {
      if (u.email === 'guest@mock.local') { res.end(loginPage()); return; }
      return res.end(groupsPage(u));
    }
    // 全頁 Messenger thread（/messages/t/<uid>/）
    if (pathname.startsWith('/messages/t/')) {
      if (u.email === 'guest@mock.local') { res.end(loginPage()); return; }
      const uid = decodeURIComponent(pathname.slice('/messages/t/'.length).replace(/\/+$/, ''));
      return res.end(messagesThreadPage(u, uid));
    }
    // 個人主頁（/username）
    if (pathname === '/settings/messenger-pin') {
      if (u.email === 'guest@mock.local') { res.end(loginPage()); return; }
      return res.end(pinSettingsPage(u));
    }
    if (pathname === '/page/seed-fan') {
      if (u.email === 'guest@mock.local') { res.end(loginPage()); return; }
      return res.end(seedFanPage(u));
    }
    if (pathname.length > 1 && !pathname.includes('.') && !pathname.startsWith('/api')) {
      if (u.email === 'guest@mock.local') { res.end(loginPage()); return; }
      return res.end(profilePage(u, decodeURIComponent(pathname.slice(1))));
    }
    res.statusCode = 404; res.end('<h1>404</h1>');
  });
  server.listen(port, '127.0.0.1', () => console.log(`[MockFB] 監聽 http://127.0.0.1:${port}`));
  return server;
}
