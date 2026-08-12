/**
 * 示范学习录制器（Demonstration Recorder）
 * --------------------------------------------------
 * 用途：當使用者在真實瀏覽器視窗中「手動」執行某個操作（例如把 FB 介面語言設為繁體中文），
 *      系統注入一個輕量監聽腳本，記錄使用者的點擊 / 輸入 / 下拉選擇 / 頁面跳轉，
 *      以供 AI 事後讀取、校驗並完善對應技能（如 skillSetLanguageTaiwan）。
 *
 * 技術：透過 Playwright 的 page.exposeBinding('__demoRecord') 建立頁面→Node 的安全通道，
 *      再以 addInitScript 注入監聽器（跨導航持續生效），避免使用網路/CORS。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../../config';
import type { Page } from 'playwright-core';

export interface DemoEvent {
  t: 'click' | 'change' | 'input' | 'focus' | 'navigate';
  url: string;
  ts: number;
  el?: {
    tag?: string;
    aria?: string | null;
    role?: string | null;
    text?: string;
    id?: string;
    cls?: string;
    val?: string;
  };
}

const recording = new Set<string>();
const buffers = new Map<string, DemoEvent[]>();

function dirFor(): string { return path.join(DATA_DIR, 'demo'); }
function fileFor(id: string): string { return path.join(dirFor(), `${id}.json`); }

export function isRecording(accountId: string): boolean { return recording.has(accountId); }

export function setRecording(accountId: string, on: boolean): void {
  if (on) recording.add(accountId);
  else recording.delete(accountId);
}

export function getEvents(accountId: string): DemoEvent[] {
  if (buffers.has(accountId)) return buffers.get(accountId)!;
  const f = fileFor(accountId);
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch {}
  }
  return [];
}

export function clearEvents(accountId: string): void {
  buffers.delete(accountId);
  const f = fileFor(accountId);
  if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch {} }
}

export function flush(accountId: string): void {
  const arr = buffers.get(accountId);
  if (!arr || arr.length === 0) return;
  try {
    fs.mkdirSync(dirFor(), { recursive: true });
    fs.writeFileSync(fileFor(accountId), JSON.stringify(arr, null, 2));
  } catch {}
}

function store(accountId: string, e: DemoEvent): void {
  if (!recording.has(accountId)) return;
  const arr = buffers.get(accountId) || [];
  arr.push(e);
  buffers.set(accountId, arr);
  // 節流落盤：每 20 條或導航事件寫一次，避免頻繁寫盤
  try {
    fs.mkdirSync(dirFor(), { recursive: true });
    if (arr.length % 20 === 0 || e.t === 'navigate') {
      fs.writeFileSync(fileFor(accountId), JSON.stringify(arr, null, 2));
    }
  } catch {}
}

const RECORDER_SCRIPT = `(function(){
  if (window.__demoAttached) return;
  window.__demoAttached = true;
  var last = 0;
  function describe(el){
    if(!el || !el.tagName) return null;
    var tag = el.tagName.toLowerCase();
    var aria = el.getAttribute ? (el.getAttribute('aria-label')||el.getAttribute('aria-labelledby')) : null;
    var role = el.getAttribute ? el.getAttribute('role') : null;
    var text = (el.textContent||'').trim().slice(0,50);
    var id = el.id || '';
    var cls = '';
    try { cls = (el.className && el.className.toString ? el.className.toString() : '').slice(0,80); } catch(_) { cls = ''; }
    var val = '';
    if (tag==='input'||tag==='select'||tag==='textarea'){ val = (el.value||'').toString().slice(0,50); }
    return {tag:tag, aria:aria, role:role, text:text, id:id, cls:cls, val:val};
  }
  function send(evt){
    var now = Date.now();
    if(now-last<120) return; last=now;
    var t = evt.type;
    if(t==='focusin') t='focus';
    var e = { t:t, url: location.href, ts: now, el: describe(evt.target) };
    try{ window.__demoRecord(JSON.stringify(e)); }catch(_){}
  }
  // 注意：FB 等 SPA 的自定義下拉/選擇器常在 pointerdown/mousedown 即選中並套用，
  // 不會觸發 click，故除 click 外另監聽 pointerdown 才能抓到「最終選中」動作。
  ['click','pointerdown','change','input','focusin'].forEach(function(t){ document.addEventListener(t, send, true); });
  var lastUrl = location.href;
  setInterval(function(){
    if(location.href!==lastUrl){ lastUrl=location.href;
      try{ window.__demoRecord(JSON.stringify({t:'navigate',url:location.href,ts:Date.now()})); }catch(_){}
    }
  }, 700);
})();`;

/**
 * 將錄製器掛載到指定頁面：建立 binding + 注入監聽腳本（當前文檔立即生效 + 未來導航持久）。
 */
export async function attachRecorder(page: Page, accountId: string): Promise<void> {
  try {
    await page.exposeBinding('__demoRecord', (_source: any, payload: string) => {
      try { store(accountId, JSON.parse(payload)); } catch {}
    });
  } catch (e: any) {
    // binding 已存在則忽略（Playwright 不允許重名）
  }
  try { await page.addInitScript(RECORDER_SCRIPT); } catch {}
  try { await page.evaluate(RECORDER_SCRIPT); } catch {}
  recording.add(accountId);
}
