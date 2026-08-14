/**
 * 会话看门狗（Session Watchdog）— 实时会话健康巡检 + 自动恢复
 *
 * 用户痛点：窗口停在某界面很久，软件里的 agent 没有实时检测到、没有智能处理。
 * 根因：旧 monitor 只被动采集 page.url() 给仪表盘看，从不读 DOM、不判断卡顿、不纠错；
 *       passive-monitor 只周期跑 ai_chat_reply，不看账号是否卡死/撞 checkpoint。
 *
 * 本模块弥补这一缺口：每 ~20s 巡检所有活跃浏览器会话，主动发现并智能处理：
 *   1) 卡顿检测：URL + DOM 指纹长时间无变化 → stuck（运行中 / 空闲漂外页）
 *   2) FB 中断检测：checkpoint / captcha / 禁用锁定 / 需登录
 *   3) 阻塞浮层检测：通知面板、Cookie 同意、通用弹窗
 *   4) 智能处理：
 *      - 对话 PIN（messenger_pin_*）→ 全自动填入（handleMessengerPin）
 *      - 需身份/照片/好友识别验证（checkpoint_identity/photo/friends）→ 移出自动化 + 导出全部账号到固定表格文件（含上传时账号信息，被删账号尾部写删除原因），方便用户去其它设备批量处理
 *      - 通用登录 checkpoint / captcha → 暂停该号 + 告警（不删）
 *      - 账号禁用/锁定/停权 → 标记 dead + 关窗 + 告警
 *      - 可关浮层（通知/Cookie/通用弹窗）→ 自动 Escape / 点关闭
 *      - 空闲窗口漂在外页过久 → 自动巡航回 FB 首页（保持干净状态 + 及时发现隐藏 checkpoint）
 *   5) 维护 per-account 看门狗视图（blocker / stuckSince / lastAction），供监控快照与仪表盘读取。
 */
import { listActiveSessions, getSession, closeSession, resolveFbBase } from '../browser/session-manager';
import { createPageDetector } from '../../detection/page-detector';
import { getAccount, updateAccount, listAccounts } from '../account-store';
import { handleMessengerPin } from '../../skills/fb-core-skills';
import { getMemory } from '../engine/task-runner';
import { analyzeUnknown, executeSafeAction, recordRepairPattern } from './ai-diagnoser';
import { emitAppEvent } from '../openclaw/event-bus';
import * as fs from 'fs';
import { DATA_DIR } from '../../config';

const EXPORT_FILE = `${DATA_DIR}/accounts-export.csv`;

// 触发「移出自动化 + 导出删除」的验证类型（需人工身份/照片/好友识别）
const DELETE_ON = new Set(['checkpoint_identity', 'checkpoint_photo', 'checkpoint_friends']);
// 触发「暂停 + 告警」的验证类型（通用登录 checkpoint / 验证码）——不删，等用户决定
const PAUSE_ON = new Set(['login_checkpoint', 'login_captcha']);
// 触发「标记 dead + 关窗 + 告警」的不可恢复状态
const DEAD_ON = new Set(['account_disabled', 'account_locked', 'suspended']);
// 弹窗形态的 checkpoint（与 DELETE_ON 同处理）
const CHECKPOINT_POPUPS = new Set(['checkpoint_identity', 'checkpoint_photo', 'checkpoint_friends']);
// 可安全自动关闭的浮层
const DISMISSABLE = new Set([
  'cookie_consent', 'notification_prompt', 'friend_request_sent',
  'post_shared', 'login_alert', 'error_dialog', 'action_blocked', 'rate_limit_warning',
]);

// 卡顿阈值
const STUCK_RUNNING_MS = 5 * 60 * 1000; // 运行中任务卡死（页面无变化）
const STUCK_IDLE_FOREIGN_MS = 10 * 60 * 1000; // 空闲停在外页过久
const STUCK_IDLE_LOW_VALUE_MS = 3 * 60 * 1000; // 低价值页面（/messages 空面板等）更快巡航

interface WatchdogView {
  accountId: string;
  lastUrl: string;
  lastFingerprint: string;
  lastChangeAt: number;
  lastProbeAt: number;
  stuckSince: number | null;
  blocker: string | null; // 'stuck_running' | 'stuck_idle' | 'deleted' | 'checkpoint' | 'dead' | null
  lastAction: string | null;
  lastActionAt: number;
}

const states = new Map<string, WatchdogView>();
const inflight = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
let intervalMs = 20000;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function isHomePage(url: string): boolean {
  try {
    const u = new URL(url);
    const p = u.pathname;
    return p === '/' || p === '' || p === '/home.php' || p === '/home';
  } catch { return false; }
}

/** 低價值 / 無法進行有效互動的頁面，應更快巡航回首页 */
function isLowValueForeignPage(url: string): boolean {
  try {
    const u = new URL(url);
    const p = u.pathname;
    // /messages 空面板（無 /messages/t/ 對話 id）沒有未讀時無法主動聊天，不要久留
    if (p === '/messages' || p === '/messages/') return true;
    // 登入後的「歡迎/設定引導」等一次性頁面
    if (p.startsWith('/gettingstarted') || p.startsWith('/welcome')) return true;
    return false;
  } catch { return false; }
}

function csvCell(v: any): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function fmtDate(ts?: number): string {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('zh-TW'); } catch { return String(ts); }
}

/** 把全部账号（含上传时账号信息）导出到固定表格文件；被删账号尾部写删除原因 */
function exportAllAccounts(deletedId: string, reason: string): void {
  try {
    const accounts = listAccounts();
    const headers = ['accountId', 'name', 'email', 'password', 'proxy', 'mode', 'status', 'exitIp', 'cookies', 'messengerPin', 'createdAt', 'lastUsed', '删除原因'];
    const lines = [headers.map(csvCell).join(',')];
    for (const a of accounts) {
      const isDel = a.accountId === deletedId;
      lines.push([
        a.accountId, a.name, a.email, a.password || '', a.proxy || '', a.mode || '',
        a.status, a.exitIp || '', a.cookies || '', a.messengerPin || '',
        fmtDate(a.createdAt), fmtDate(a.lastUsed), isDel ? reason : '',
      ].map(csvCell).join(','));
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(EXPORT_FILE, '﻿' + lines.join('\r\n'), 'utf-8');
    console.log(`[Watchdog] 已导出全部账号(${accounts.length})至 ${EXPORT_FILE}`);
  } catch (e: any) {
    console.error(`[Watchdog] 导出账号失败: ${e.message}`);
  }
}

async function dismissOverlays(page: any): Promise<void> {
  try { await page.keyboard.press('Escape'); } catch {}
  await sleep(400);
  const closers = [
    '[role="dialog"] [role="button"][aria-label="關閉"]',
    '[role="dialog"] [aria-label="Close"]',
    'div[aria-label="關閉"]',
    'button[value="0"]',
    'div[role="button"]:has-text("稍後再說")',
    'div[role="button"]:has-text("Not Now")',
  ];
  for (const sel of closers) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ timeout: 2000 }).catch(() => {}); await sleep(300); }
    } catch {}
  }
  try { await page.keyboard.press('Escape'); } catch {}
}

async function handleDelete(accountId: string, reason: string): Promise<void> {
  const acc = getAccount(accountId);
  const name = acc?.name || accountId;
  try { await closeSession(accountId); } catch {}
  updateAccount(accountId, {
    status: 'deleted',
    notes: (acc?.notes ? acc.notes + '；' : '') + '已移出自动化：' + reason,
  });
  exportAllAccounts(accountId, reason);
  states.delete(accountId);
  emitAppEvent({ type: 'watchdog.alert', accountId, blocker: 'deleted', reason, ts: Date.now() });
  console.warn(`[Watchdog] ${accountId}(${name}) 触发身份/照片验证，已移出自动化并导出至 ${EXPORT_FILE}：${reason}`);
}

async function handlePause(accountId: string, reason: string): Promise<void> {
  updateAccount(accountId, { status: 'checkpoint' });
  emitAppEvent({ type: 'watchdog.alert', accountId, blocker: 'checkpoint', reason, ts: Date.now() });
  console.warn(`[Watchdog] ${accountId} 触发 FB 验证 checkpoint（${reason}），已暂停并告警`);
}

async function handleDead(accountId: string, reason: string): Promise<void> {
  try { await closeSession(accountId); } catch {}
  updateAccount(accountId, { status: 'dead' });
  states.delete(accountId);
  emitAppEvent({ type: 'watchdog.alert', accountId, blocker: 'dead', reason, ts: Date.now() });
  console.warn(`[Watchdog] ${accountId} 账号被禁用/锁定/停权（${reason}），已标记 dead 并关闭窗口`);
}

async function probe(accountId: string): Promise<void> {
  const sess = getSession(accountId);
  if (!sess) { states.delete(accountId); return; }
  // 手動 X 關窗 / 瀏覽器崩潰 → 連線斷開或已無 page：對賬帳號狀態為離線，
  // 避免 UI 顯示「已打開」卻無視窗；下次點啟動也能真正重開。
  const browserConnected = !!sess.context.browser()?.isConnected();
  const hasPage = (sess.context.pages()?.length ?? 0) > 0;
  if (!browserConnected || !hasPage) {
    try { await closeSession(accountId); } catch {}
    states.delete(accountId);
    return;
  }
  const page: any = sess.page;

  let url = '';
  let fp = '';
  try {
    url = page.url();
    fp = await page.evaluate(() => {
      const main = (document as any).querySelector('[role="main"]') || document.body;
      const txt = (main ? main.innerText : '').replace(/\s+/g, ' ').slice(0, 160);
      const dialogs = (document as any).querySelectorAll('[role="dialog"]').length;
      const h1 = ((document as any).querySelector('h1')?.textContent || '').slice(0, 40);
      return ((document as any).title || '').slice(0, 40) + '||' + h1 + '||' + txt + '||d' + dialogs;
    });
  } catch { return; } // 页面已关闭/崩溃

  const now = Date.now();
  let st = states.get(accountId);
  if (!st) {
    st = {
      accountId, lastUrl: url, lastFingerprint: fp, lastChangeAt: now,
      lastProbeAt: now, stuckSince: null, blocker: null, lastAction: null, lastActionAt: 0,
    };
    states.set(accountId, st);
  }
  if (url !== st.lastUrl || fp !== st.lastFingerprint) {
    st.lastUrl = url; st.lastFingerprint = fp; st.lastChangeAt = now;
    if (st.blocker === 'stuck_running' || st.blocker === 'stuck_idle') { st.blocker = null; st.stuckSince = null; }
  }
  st.lastProbeAt = now;

  // 1) 页面状态检测
  let det: any;
  try { det = await createPageDetector(page).detectPageState(); } catch { return; }

  // 2) 不可恢复 / 需删 / 暂停（优先级最高，越快越好）
  if (DEAD_ON.has(det.pageType)) { await handleDead(accountId, det.pageType); return; }
  if (DELETE_ON.has(det.pageType) || CHECKPOINT_POPUPS.has(det.activePopup)) {
    await handleDelete(accountId, 'FB 验证（' + (det.pageType || det.activePopup) + '）需人工身份/照片，自动移出自动化并导出');
    return;
  }
  if (PAUSE_ON.has(det.pageType)) { await handlePause(accountId, det.pageType); return; }

  // 3) 对话 PIN → 全自动填入
  if (det.activePopup === 'messenger_pin_create' || det.activePopup === 'messenger_pin_verify') {
    if (now - st.lastActionAt > 30000) {
      try {
        const r = await handleMessengerPin({ page, accountId, memory: getMemory(accountId) });
        st.lastAction = '自动填入对话PIN：' + (r.handled ? '成功' : '失败');
        st.lastActionAt = now;
        emitAppEvent({ type: 'watchdog.action', accountId, action: 'pin_filled', ts: now });
        console.log(`[Watchdog] ${accountId} 自动填入对话PIN：${r.handled ? '成功' : '失败 ' + (r.error || '')}`);
      } catch (e: any) {
        console.warn(`[Watchdog] PIN 处理失败 ${accountId}: ${e.message}`);
      }
    }
    return;
  }

  // 4) 可关浮层（通知/Cookie/通用弹窗）
  if (DISMISSABLE.has(det.activePopup)) {
    if (now - st.lastActionAt > 30000) {
      await dismissOverlays(page);
      st.lastAction = '自动关闭浮层(' + det.activePopup + ')';
      st.lastActionAt = now;
      console.log(`[Watchdog] ${accountId} 关闭浮层：${det.activePopup}`);
    }
  }

  // 4.5) 未知 / 自定義彈窗：交給 AI 解析器自主診斷 + 安全動作執行
  if (det.activePopup === 'custom_dialog' || det.pageType === 'unknown') {
    if (now - st.lastActionAt > 60000) {
      try {
        const diag = await analyzeUnknown(accountId, page);
        if (diag.risk === 'human') {
          // 需人工（證件/自拍/身分）：不貿然點擊，暫停並告警（不刪號，避免誤傷）
          await handlePause(accountId, '未知彈窗經 AI 判定需人工處理（' + (diag.what || diag.action) + '）');
          return;
        }
        if (diag.risk === 'caution') {
          // 謹慎：只做 ESC 兜底，不點擊任何按鈕
          const acted = await executeSafeAction(page, accountId, 'ESC', resolveFbBase(accountId));
          st.lastAction = 'AI診斷(謹慎):' + (diag.what || '') + ' → ' + acted;
        } else {
          const acted = await executeSafeAction(page, accountId, diag.action, resolveFbBase(accountId));
          st.lastAction = 'AI診斷:' + (diag.what || '') + ' → ' + acted;
          recordRepairPattern(accountId, diag, acted);
        }
        st.lastActionAt = now;
        st.blocker = null; st.stuckSince = null;
        emitAppEvent({ type: 'watchdog.action', accountId, action: 'ai_diagnose', ts: now });
        console.log(`[Watchdog] ${accountId} AI診斷：${diag.what}（risk=${diag.risk}）→ ${st.lastAction}`);
      } catch (e: any) {
        console.warn(`[Watchdog] AI診斷失敗 ${accountId}: ${e.message}`);
      }
    }
  }

  // 5) 卡顿检测
  const acc = getAccount(accountId);
  const status = acc?.status || 'idle';
  if (status === 'running') {
    if (now - st.lastChangeAt > STUCK_RUNNING_MS) {
      if (st.blocker !== 'stuck_running') {
        st.blocker = 'stuck_running'; st.stuckSince = now;
        emitAppEvent({ type: 'watchdog.alert', accountId, blocker: 'stuck_running', ts: now });
        console.warn(`[Watchdog] ${accountId} 任务疑似卡死（${Math.round((now - st.lastChangeAt) / 1000)}s 无页面变化），已告警`);
      }
    }
  } else if (!isHomePage(url)) {
    const threshold = isLowValueForeignPage(url) ? STUCK_IDLE_LOW_VALUE_MS : STUCK_IDLE_FOREIGN_MS;
    if (now - st.lastChangeAt > threshold) {
      if (st.blocker !== 'stuck_idle') { st.blocker = 'stuck_idle'; st.stuckSince = now; }
      if (now - st.lastActionAt > 60000) {
        try {
          const base = resolveFbBase(accountId);
          await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
          st.lastAction = isLowValueForeignPage(url) ? '低价值页面（/messages 空面板）巡航回首页' : '空闲窗口自动巡航回首页';
          st.lastActionAt = now; st.lastChangeAt = now; st.blocker = null; st.stuckSince = null;
          console.log(`[Watchdog] ${accountId} ${st.lastAction}`);
        } catch (e: any) {
          console.warn(`[Watchdog] 巡航首页失败 ${accountId}: ${e.message}`);
        }
      }
    }
  }
}

async function tick(): Promise<void> {
  const active = listActiveSessions().map((s) => s.accountId);
  for (const id of active) {
    if (inflight.has(id)) continue;
    inflight.add(id);
    try { await probe(id); } catch (e: any) { /* 单个账号异常不影响其它 */ }
    finally { inflight.delete(id); }
  }
}

export function startSessionWatchdog(intervalMs_ = 20000): void {
  if (timer) return;
  intervalMs = intervalMs_;
  timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  tick().catch(() => {});
  console.log(`[Watchdog] 会话看门狗已启动，间隔 ${intervalMs}ms`);
}

export function stopSessionWatchdog(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export function isWatchdogRunning(): boolean { return timer !== null; }

export function getWatchdogView(accountId: string): WatchdogView | null {
  return states.get(accountId) || null;
}

export function getAllWatchdogViews(): WatchdogView[] {
  return Array.from(states.values());
}
