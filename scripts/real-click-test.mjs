import { chromium } from 'playwright-core';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';

const TARGET = process.argv[2] || '61590468514187';
const BASE = 'http://localhost:18991';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });

// 等账号卡片渲染（checkbox 帶 data-id，該 checkbox 為隱藏選取框，故等 attached 即可）
await page.waitForSelector(`input[data-id="${TARGET}"]`, { state: 'attached', timeout: 20000 });
// 帳號面板可能在某個 tab 內（按鈕不一定「可見」），但 DOM 中的 .click() 仍會觸發真實 onclick=launchEnv
await page.waitForFunction((id) => {
  const cb = document.querySelector(`input[data-id="${id}"]`);
  const card = cb && cb.closest('.glass-card');
  const btn = card && [...card.querySelectorAll('button')].find(b => b.textContent.includes('啟動'));
  return !!btn;
}, TARGET, { timeout: 20000 });

// 真實 DOM 點擊：該帳號卡片內的「▶ 啟動」按鈕
const clickResult = await page.evaluate((id) => {
  const cb = document.querySelector(`input[data-id="${id}"]`);
  if (!cb) return 'no-checkbox';
  const card = cb.closest('.glass-card');
  if (!card) return 'no-card';
  const btn = [...card.querySelectorAll('button')].find(b => b.textContent.includes('啟動'));
  if (!btn) return 'no-button';
  btn.click();
  return 'clicked:' + btn.textContent.trim();
}, TARGET);
console.log('[driver] click result =', clickResult);

// 輪詢 /api/logs，捕捉 onboarding / 語言 / 頭像 / PIN / 點讚 相關輸出
const seen = new Set();
const kw = ['onboarding', 'ensureSession', '語言', '頭像', 'PIN', '點讚', 'avatar', 'pin', 'like',
  'detect', 'applied', 'skipped', 'allComplete', 'runOnboarding', 'checkpoint', '登入', 'login', '失敗', 'error', '啟動'];
let lastTs = 0;
for (let i = 0; i < 80; i++) {
  const logs = await page.evaluate(async () => {
    const r = await fetch('/api/logs'); const j = await r.json(); return j.logs || [];
  });
  let got = false;
  for (const l of logs) {
    const key = l.time + '|' + l.message;
    if (seen.has(key)) continue; seen.add(key);
    if (kw.some(k => l.message.includes(k))) { console.log(`[${l.level}] ${l.message}`); got = true; lastTs = l.time; }
  }
  // 若已經看到 allComplete 或 失敗/error 收尾，再多等一輪就停
  if ((l => l)(0) && got && /allComplete|失敗|error|啟動失敗/.test('')) {}
  if (i > 2 && /allComplete/.test([...seen].join(''))) { console.log('[driver] 偵測到 allComplete，再等 6s 收尾'); await new Promise(r => setTimeout(r, 6000)); break; }
  await new Promise(r => setTimeout(r, 3000));
}

// 讀取該帳號的 onboarding 記憶體（SQLite）
const dbPath = join('G:/Aike-FBclaw/data/accounts', TARGET, 'memory.db');
console.log('\n[driver] === 單帳號 onboarding 記憶體 ===');
if (existsSync(dbPath)) {
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT state FROM onboarding_kv WHERE account_id = ?').get(TARGET);
    if (row) {
      const obj = JSON.parse(row.state);
      console.log('allComplete =', obj.allComplete);
      console.log('lastCheckedAt =', new Date(obj.lastCheckedAt).toISOString());
      for (const [k, v] of Object.entries(obj.steps || {})) {
        console.log(`  - ${k}: done=${v.done} method=${v.method || '-'} at=${v.at ? new Date(v.at).toISOString() : '-'}`);
      }
    } else {
      console.log('(無 onboarding 記錄 — 管線可能未執行或該步失敗過早)');
    }
    db.close();
  } catch (e) {
    console.log('(讀取 onboarding_kv 失敗: ' + e.message + ')');
  }
} else {
  console.log('(無 memory.db — 帳號記憶體未建立)');
}

await browser.close();
console.log('\n[driver] done');
