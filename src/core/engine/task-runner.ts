/**
 * TaskRunner — 統一任務執行引擎
 *
 * 負責：
 * 1. 管理 account 的 browser session + memory
 * 2. 把高層任務（如「加好友+問候」「內容分發」）拆解為技能調用
 * 3. 每次任務前後處理彈窗、保存狀態、截圖、寫入記憶體
 */
import type { Page } from 'playwright-core';
import { FB_BASE, OWN_PAGES, limitForStage, SAFETY_LIMITS, DATA_DIR } from '../../config';
import { launchSession, getSession, persistSession, closeSession, screenshot, resolveFbBase, listActiveSessions } from '../browser/session-manager';
import { AccountMemory } from '../../memory/account-memory';
import { createPageDetector, PageState } from '../../detection/page-detector';
import * as skills from '../../skills/fb-core-skills';
import { handleMessengerPin } from '../../skills/fb-core-skills';
import { generateGreeting, generateChatMessage, rewriteContent } from '../provider/ai-provider';
import { getAccount, updateAccount, listAccounts } from '../account-store';
import { runOnboarding } from '../onboarding';
import { getProxyManager } from '../proxy/proxy-manager';
import { randomDelay, humanType } from '../../utils/human-behavior';
import { getSourcesManager } from '../browser/sources';
import { emitAppEvent } from '../openclaw/event-bus';
import { recordSkillUsage } from '../openclaw/skill-registry';
import { appendShard, summarizeContext } from '../openclaw/memory-service';
import { detectTakeoverTrigger, generateTakeoverReply } from '../openclaw/passive-takeover';
import * as fs from 'fs';
import * as path from 'path';

const memories = new Map<string, AccountMemory>();

export { closeAllSessions } from '../browser/session-manager';

/** 判斷備註是否還只是數字 ID，需要被 FB 暱稱取代 */
function looksLikeId(name?: string): boolean {
  if (!name) return true;
  return /^\d+$/.test(name.trim()) || name.trim().length === 0;
}

export function getMemory(accountId: string): AccountMemory {
  if (!memories.has(accountId)) memories.set(accountId, new AccountMemory(accountId));
  return memories.get(accountId)!;
}

export async function ensureSession(accountId: string) {
  let s = getSession(accountId);
  if (!s) {
    const acc = getAccount(accountId);
    s = await launchSession(accountId, { headless: false });
    if (acc) {
      updateAccount(accountId, { lastUsed: Date.now() });
      // 啟動後立即感知頁面：若已登入則同步 FB 暱稱；若在登入頁且有密碼則自動登入；若遇到驗證則標記。
      // 感知/自動登入過程中若頁面尚處 about:blank（導航失敗、代理空響應等），不得讓異常冒泡成 500，
      // 而是標記為 error 並照常回傳 session，交由監控/使用者判斷。
      try {
        const detector = createPageDetector(s.page);
        const state = await detector.detectPageState();
        let loginOk = false;
        if (state.isLoggedIn) {
          // Cookie 直登成功：同步 FB 暱稱（若當前名稱像 UID 才覆寫，避免洗掉人工命名）
          if (state.currentUser && looksLikeId(acc.name)) updateAccount(accountId, { name: state.currentUser });
          updateAccount(accountId, { status: 'idle' });
        } else if (acc.email && acc.password) {
          // Cookie 失效 / 無 Cookie → 先清掉失效 Cookie，再改走「帳號密碼」自動登入
          console.log(`[ensureSession] ${accountId} 未登入(${state.pageType})，嘗試帳號密碼登入`);
          try { await s.context.clearCookies(); } catch (ce: any) { console.warn(`[ensureSession] 清 Cookie 失敗(${accountId}): ${ce.message}`); }
          const loginRes = await skills.skillLogin({ page: s.page, accountId, memory: getMemory(accountId) }, { email: acc.email, password: acc.password });
          if (loginRes.success) {
            loginOk = true;
            updateAccount(accountId, { status: 'idle' });
            console.log(`[ensureSession] ${accountId} 帳號密碼登入成功`);
          } else {
            // 密碼登入也失敗：2FA / 密碼錯誤 → 標記等待人工，不讓異常冒泡成 500
            const st = (loginRes.pageStateAfter === 'login_checkpoint' || loginRes.pageStateAfter === 'login_2fa') ? 'checkpoint' : 'error';
            updateAccount(accountId, { status: st });
            throw new Error(`自動登入失敗(${loginRes.pageStateAfter || ''}): ${loginRes.error || ''}`);
          }
        } else {
          // 既無法 Cookie 直登、又無密碼可補 → 標記等待人工（Cookie 失效就重匯，或手動登入）
          updateAccount(accountId, { status: state.pageType === 'login_checkpoint' ? 'checkpoint' : 'error' });
        }
        // 登入成功或已處於登入態：執行「自愈式首登管線」(語言/頭像/PIN/主頁點讚)
        // 每次開號都跑：先智能檢測四步是否已完成，已完成標記 done、未完成才修復；
        // 形成單帳號記憶，二次登入檢測到已完成即跳過，直到全部確認完成。
        if (loginOk || state.isLoggedIn) {
          try {
            const obState = await runOnboarding(s.page, accountId, getMemory(accountId));
            const accNow = getAccount(accountId);
            if (accNow && obState.steps['language']?.done) {
              updateAccount(accountId, { localeSetTw: true }); // 向後兼容舊旗標
            }
            const summary = Object.entries(obState.steps)
              .map(([k, v]) => `${k}:${v.done ? 'done(' + (v.method || '') + ')' : 'pending' + (v.error ? '(' + v.error + ')' : '')}`)
              .join('  ');
            console.log(`[ensureSession] ${accountId} onboarding ${obState.allComplete ? '全部完成' : '部分完成(自愈中)'} | ${summary}`);
          } catch (oe: any) {
            console.warn(`[ensureSession] ${accountId} onboarding 執行異常: ${oe.message}`);
          }
        }
      } catch (e: any) {
        console.warn(`[ensureSession] 頁面感知/登入失敗 (${accountId}): ${e.message}`);
        updateAccount(accountId, { status: 'error' });
      }
    }
  }
  return s;
}

/** 純讀取型任務：統計帳號、代理、活躍 session、近期任務，不開瀏覽器 */
async function runStatusReport(): Promise<any> {
  const accounts = listAccounts();
  const pm = getProxyManager();
  const proxies = pm.getManualProxies();
  const assignments = pm.getAssignments();
  const activeSessions = listActiveSessions();

  const statusCounts: Record<string, number> = {};
  for (const a of accounts) {
    statusCounts[a.status || 'idle'] = (statusCounts[a.status || 'idle'] || 0) + 1;
  }
  const boundCount = Object.keys(assignments).length;
  const aliveProxies = proxies.filter(p => p.alive).length;

  return {
    success: true,
    action: 'status_report',
    data: {
      accounts: { total: accounts.length, statuses: statusCounts },
      proxies: { total: proxies.length, alive: aliveProxies, bound: boundCount },
      activeSessions: activeSessions.map(s => ({ accountId: s.accountId, url: s.url, pid: s.pid })),
    },
  };
}

export async function runTask(accountId: string, type: string, params: any): Promise<any> {
  // 看門狗已移出自動化的帳號（身份/照片驗證等）不再參與任何任務
  if (getAccount(accountId)?.status === 'deleted') {
    return { accountId, type, success: false, error: '账号已移出自动化（deleted），不再参与任务', durationMs: 0 };
  }
  const startedAt = Date.now();
  const accBefore = getAccount(accountId);
  const prevStatus = accBefore?.status || 'idle';
  updateAccount(accountId, { status: 'running' });
  const mem = getMemory(accountId);

  // ---- OpenClaw 感知：任務開始 ----
  emitAppEvent({ type: 'account.status', accountId, status: 'running', ts: startedAt });
  emitAppEvent({ type: 'task.started', accountId, taskType: type, ts: startedAt });
  recordSkillUsage(type);

  try {
    // 純讀取型任務無需開啟瀏覽器，直接回傳軟體狀態，避免在代理異常時還強行開瀏覽器
    if (type === 'status_report') {
      const result = await runStatusReport();
      updateAccount(accountId, { status: prevStatus });
      emitAppEvent({ type: 'account.status', accountId, status: prevStatus, ts: Date.now() });
      emitAppEvent({ type: 'task.completed', accountId, taskType: type, success: true, ts: Date.now() });
      return { accountId, type, success: true, result, durationMs: Date.now() - startedAt };
    }

    const s = await ensureSession(accountId);
    const ctx = { page: s.page, accountId, memory: mem };

    // 前置狀態檢查：checkpoint / 禁用 / PIN / 未登入；未登入帳號不參與非登入任務
    const prep = await prepareSessionForTask(accountId, s.page, type);
    if (!prep.ok) {
      updateAccount(accountId, { status: prevStatus === 'running' ? 'idle' : prevStatus });
      emitAppEvent({ type: 'task.failed', accountId, taskType: type, error: prep.error, ts: Date.now() });
      return { accountId, type, success: false, error: prep.error, durationMs: Date.now() - startedAt };
    }

    await dismissPopups(s.page, accountId);

    let result: any;
    switch (type) {
      case 'login':
        result = await runLogin(ctx, params);
        break;
      case 'sync':
        result = await runSync(ctx, params);
        break;
      case 'browse_feed':
        result = await skills.skillBrowseFeed(ctx, params);
        break;
      case 'like_post':
        result = await skills.skillLikePost(ctx, params);
        break;
      case 'add_friends':
        result = await runAddFriends(ctx, params);
        break;
      case 'send_message':
        result = await skills.skillSendMessage(ctx, params);
        break;
      case 'join_groups':
        result = await runJoinGroups(ctx, params);
        break;
      case 'create_post':
        result = await skills.skillCreatePost(ctx, params);
        break;
      case 'share_post': {
        const sp = fillShareSource(params);
        if (!sp.postUrl) {
          result = { success: false, action: 'share_post', data: { reason: '尚未配置可分享的主頁/社團：請在「社团&主页数据源」頁面填寫' } };
        } else {
          result = await skills.skillSharePost(ctx, sp);
        }
        break;
      }
      case 'invite_to_group': {
        const sp = fillInviteGroup(params);
        if (!sp.groupId) {
          result = { success: false, action: 'invite_to_group', data: { reason: '尚未配置目標社團：請在「社团&主页数据源」頁面填寫社團網址' } };
        } else {
          result = await skills.skillInviteToGroup(ctx, sp);
        }
        break;
      }
      case 'invite_to_page':
        result = await runInviteToPage(ctx, params);
        break;
      case 'add_friends_from_group': {
        const sp = fillAddFromGroup(params);
        if (!sp.groupId) {
          result = { success: false, action: 'add_friends_from_group', data: { reason: '尚未配置目標社團：請在「社团&主页数据源」頁面填寫社團網址' } };
        } else {
          result = await runAddFriends(ctx, sp);
        }
        break;
      }
      case 'get_friends':
        result = await skills.skillGetFriends(ctx, params);
        break;
      case 'add_friend_by_name':
        result = await skills.skillAddFriendByName(ctx, params);
        break;
      case 'send_message_to_name':
        result = await skills.skillSendMessageToName(ctx, params);
        break;
      case 'socialize':
        result = await runSocialize(params);
        break;
      case 'greet_new_friends':
        result = await runGreetNewFriends(ctx, params);
        break;
      case 'auto_like_own_page':
        result = await runAutoLikeOwnPage(ctx, params);
        break;
      case 'ai_chat_reply':
        result = await runAiChatReply(ctx, params);
        break;
      case 'reply_comment':
        // 貼文留言回覆：UI 已標記「未接入」，這裡優雅回報狀態，不開瀏覽器、不拋錯
        result = { success: false, action: 'reply_comment', data: { reason: '貼文留言回覆功能尚未接入，已在監控標記此指令' } };
        break;
      case 'distribute_content':
        result = await runDistributeContent(params);
        break;
      case 'risk_check':
        result = await runRiskCheck(ctx, params);
        break;
      default:
        throw new Error(`未知任務類型: ${type}`);
    }

    await dismissPopups(s.page, accountId);
    await persistSession(accountId);
    await mem.recordAction(type, params, result);

    // 任務結束後再感知一次頁面：若出現 checkpoint / 鎖定，優先標記帳號狀態
    const endState = await createPageDetector(s.page).quickCheck().catch(() => ({ pageType: 'unknown' }));
    if (endState.pageType === 'login_checkpoint') {
      updateAccount(accountId, { status: 'checkpoint' });
    } else {
      updateAccount(accountId, { status: 'idle' });
    }

    emitAppEvent({ type: 'task.completed', accountId, taskType: type, success: result?.success ?? true, ts: Date.now() });
    emitAppEvent({ type: 'account.status', accountId, status: endState.pageType === 'login_checkpoint' ? 'checkpoint' : 'idle', ts: Date.now() });
    return { accountId, type, success: result?.success ?? true, result, durationMs: Date.now() - startedAt };
  } catch (err: any) {
    const ssPath = await screenshot(accountId, `error_${type}`).catch(() => '');
    await mem.recordError(type, err.message).catch(() => {});

    // 即使異常，也檢查是否因 checkpoint 導致
    const errSession = getSession(accountId);
    if (errSession) {
      const endState = await createPageDetector(errSession.page).quickCheck().catch(() => ({ pageType: 'unknown' }));
      if (endState.pageType === 'login_checkpoint') {
        updateAccount(accountId, { status: 'checkpoint' });
      } else {
        updateAccount(accountId, { status: 'error' });
      }
    } else {
      updateAccount(accountId, { status: 'error' });
    }
    emitAppEvent({ type: 'task.failed', accountId, taskType: type, error: err.message, ts: Date.now() });
    emitAppEvent({ type: 'account.status', accountId, status: errSession ? 'error' : 'error', ts: Date.now() });
    return { accountId, type, success: false, error: err.message, screenshot: ssPath, durationMs: Date.now() - startedAt };
  }
}

// ---------------- 任務實現 ----------------

async function runLogin(ctx: skills.SkillContext, params: any) {
  const acc = getAccount(ctx.accountId);
  const email = params.email || acc?.email;
  const password = params.password || acc?.password;
  if (!email || !password) throw new Error('缺少 email/password');
  return skills.skillLogin(ctx, { email, password });
}

async function runSync(ctx: skills.SkillContext, _params: any) {
  const detector = createPageDetector(ctx.page);
  const state = await detector.detectPageState();

  // 同步 FB 暱稱到帳號備註
  if (state.isLoggedIn && state.currentUser) {
    const acc = getAccount(ctx.accountId);
    if (acc && looksLikeId(acc.name) && state.currentUser !== acc.name) {
      updateAccount(ctx.accountId, { name: state.currentUser });
    }
  }

  // 嘗試從 Mock FB 狀態 API 取得結構化數據
  const mockState = await fetchMockState(ctx.page);

  const summary = {
    pageType: state.pageType,
    isLoggedIn: state.isLoggedIn,
    activePopup: state.activePopup,
    warnings: state.warnings,
    currentUser: state.currentUser,
    mockState,
  };

  await ctx.memory.recordAction('sync', {}, summary);
  return { success: true, action: 'sync', data: summary };
}

async function runAddFriends(ctx: skills.SkillContext, params: any) {
  const acc = getAccount(ctx.accountId);
  const stage = acc?.stage || 'new';
  const limit = limitForStage(stage).addFriend;

  const count = Math.min(params.count || 2, limit);
  const sp: any = { ...params, count };
  if (!sp.searchQuery && sp.keyword) sp.searchQuery = sp.keyword; // 兼容 keyword
  const result = await skills.skillAddFriends(ctx, sp);

  // 若加好友成功，記錄並觸發問候
  if (result.success && result.data?.added > 0) {
    await ctx.memory.recordInteraction({
      friendId: 'batch_add', friendName: '批量加好友', type: 'share',
      content: `added:${result.data.added}`, timestamp: Date.now(), context: JSON.stringify(params),
    });
  }
  return result;
}

async function runJoinGroups(ctx: skills.SkillContext, params: any) {
  const acc = getAccount(ctx.accountId);
  const stage = acc?.stage || 'new';
  const limit = limitForStage(stage).joinGroup;
  const count = Math.min(params.count || 1, limit);

  // Mock FB 驗證時若沒給 groupUrls，預設使用 /groups
  const base = resolveFbBase(ctx.accountId);
  let groupUrls: string[] | undefined = params.groupUrls;
  if (!groupUrls && params.groupUrl) groupUrls = [params.groupUrl];
  if (!groupUrls && base.includes('127.0.0.1')) groupUrls = [`${base}/groups`];

  const jp: any = { ...params, count, groupUrls };
  if (!jp.keywords && jp.keyword) jp.keywords = [jp.keyword]; // 兼容 keyword
  return skills.skillJoinGroups(ctx, jp);
}

/**
 * 正常登入的帳號互相加好友 + 互聊（需求 A，真實 FB、低量擬人）
 *
 * 流程：
 * 1. 健康探測：逐個啟 session → 偵測 isLoggedIn，並同步 FB 暱稱（ensureSession 已做）
 * 2. 環狀互加好友：account[i] 加 account[i+1]，每個帳號最多送 1 個好友邀請
 * 3. 互聊：隨機有序對，由 AI 生成台式聊天私訊互傳，錯開時間降低風控
 *
 * ⚠️ 自家帳號互加互聊容易被 FB 判同一人操作，務必低量 + 長間隔；
 *    若某帳號登入失效/撞 checkpoint，自動標記並跳過。
 */
async function runSocialize(params: any): Promise<any> {
  // 1. 決定帳號池：優先用傳入 accountIds，否則取所有 real 且非 error/checkpoint 的帳號
  const poolIds = (params.accountIds && params.accountIds.length)
    ? params.accountIds
    : listAccounts()
        .filter((a: any) => a.mode === 'real' && a.status !== 'error' && a.status !== 'checkpoint')
        .map((a: any) => a.accountId);

  const maxAdds = typeof params.maxAdds === 'number' ? params.maxAdds : poolIds.length; // 預設環狀互加
  const maxChats = typeof params.maxChats === 'number' ? params.maxChats : 3;

  // 2. 健康探測 + 同步 FB 名
  const healthy: { id: string; name: string }[] = [];
  for (const id of poolIds) {
    try {
      const s = await ensureSession(id);
      const st = await createPageDetector(s.page).detectPageState();
      const acc = getAccount(id);
      if (st.isLoggedIn && acc) {
        // 優先沿用已存的正確 FB 暱稱；只有在備註仍是數字 ID 時，才用本次偵測到的名稱覆蓋
        // （避免複用停留在搜尋頁的 session 時，把「Search results」誤當成暱稱）
        const name = !looksLikeId(acc.name)
          ? acc.name
          : (st.currentUser && !looksLikeId(st.currentUser) ? st.currentUser : acc.name);
        healthy.push({ id, name });
      } else {
        updateAccount(id, {
          status: st.pageType === 'login_checkpoint' ? 'checkpoint' : st.isLoggedIn ? 'idle' : 'error',
        });
      }
    } catch (e: any) {
      updateAccount(id, { status: 'error' });
    }
  }

  const added: string[] = [];
  const chatted: string[] = [];

  // 3. 環狀互加好友（錯開 20-60s）
  for (let i = 0; i < healthy.length && added.length < maxAdds; i++) {
    const from = healthy[i];
    const to = healthy[(i + 1) % healthy.length];
    if (from.id === to.id) continue;
    try {
      const r = await runTask(from.id, 'add_friend_by_name', { name: to.name });
      if (r?.success) added.push(`${from.name} → ${to.name}`);
    } catch { /* ignore */ }
    await randomDelay(20000, 60000);
  }

  // 4. 互聊：隨機有序對，AI 生成台式聊天（錯開 15-45s）
  for (let i = 0; i < maxChats; i++) {
    const a = healthy[Math.floor(Math.random() * healthy.length)];
    const b = healthy[Math.floor(Math.random() * healthy.length)];
    if (!a || !b || a.id === b.id) continue;
    try {
      const msg = await generateChatMessage({ toName: b.name });
      const r = await runTask(a.id, 'send_message_to_name', { name: b.name, message: msg });
      if (r?.success) chatted.push(`${a.name} → ${b.name}：${msg}`);
    } catch { /* ignore */ }
    await randomDelay(15000, 45000);
  }

  return {
    success: healthy.length > 0,
    action: 'socialize',
    data: {
      poolSize: healthy.length,
      healthy: healthy.map((h) => h.name),
      added,
      chatted,
    },
  };
}

// ---------------- 数据源自动補齊（社团 & 公共主页） ----------------
// 擴展圈子類技能：若未顯式傳入 id/url，自動從「社团&主页数据源」讀取已配置目標

function fillShareSource(params: any): any {
  const sp = { ...params };
  if (!sp.postUrl) {
    // 优先用户指定的主页/社团；否则取第一个已配置主页或社团
    const pages = getSourcesManager().listByType('page');
    const groups = getSourcesManager().listByType('group');
    const target = pages[0] || groups[0];
    if (target) { sp.postUrl = target.url; if (!sp.target) sp.target = 'timeline'; }
  }
  return sp;
}

function fillInviteGroup(params: any): any {
  const sp = { ...params };
  if (!sp.groupId) {
    const groups = getSourcesManager().listByType('group');
    if (groups.length > 0) {
      const chosen = groups.find(g => g.rawId === sp.groupId) || groups[0];
      sp.groupId = chosen.rawId;
      sp.groupName = chosen.name;
      sp.groupUrl = chosen.url;
    }
  }
  return sp;
}

function fillAddFromGroup(params: any): any {
  const sp = { ...params, mode: 'group_members' };
  if (!sp.groupId) {
    const groups = getSourcesManager().listByType('group');
    if (groups.length > 0) {
      const chosen = groups.find(g => g.rawId === sp.groupId) || groups[0];
      sp.groupId = chosen.rawId;
      sp.groupUrl = chosen.url;
    }
  }
  return sp;
}

async function runGreetNewFriends(ctx: skills.SkillContext, params: any) {
  const acc = getAccount(ctx.accountId);
  const stage = acc?.stage || 'new';
  const limit = Math.min(params.count || limitForStage(stage).addFriend, 3);

  // 1. 解析真实 FB 通知中的「接受了你的好友请求」
  let targets: { name: string; url: string }[] = [];
  try {
    await ctx.page.goto(resolveFbBase(ctx.accountId) + '/notifications', { waitUntil: 'domcontentloaded' });
    await randomDelay(2500, 4500);
    targets = await ctx.page.evaluate(() => {
      const out: { name: string; url: string }[] = [];
      const seen = new Set<string>();
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      for (const a of anchors) {
        const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/accept.*friend request|接受了.*好友请求|confirm.*friend/i.test(t)) continue;
        const href = a.getAttribute('href') || '';
        const m = href.match(/profile\.php\?id=(\d+)/) || href.match(/facebook\.com\/([^?\/]+)/);
        const uname = m ? (m[1] || m[2]) : '';
        if (!uname || seen.has(uname)) continue;
        seen.add(uname);
        const name = t.split(/\s/)[0] || uname;
        out.push({ name, url: href.startsWith('http') ? href : 'https://www.facebook.com' + href });
      }
      return out.slice(0, 5);
    });
    await ctx.memory.recordAction('greet_scan', { found: targets.length }, { targets });
  } catch (e: any) {
    await ctx.memory.recordAction('greet_scan', {}, { error: e.message });
  }

  // 2. 允许顯式傳入（便於指定對象 / 測試）
  if (params.friends && params.friends.length) {
    targets = params.friends.map((n: string) => ({
      name: n,
      url: `${resolveFbBase(ctx.accountId)}/${encodeURIComponent(n)}`,
    }));
  }

  const sent: string[] = [];
  const failed: string[] = [];
  const greetDelay = params.greetDelayMs ?? (5 * 60 * 1000 + Math.random() * 25 * 60 * 1000); // 默認 5-30 分鐘

  for (const t of targets.slice(0, limit)) {
    try {
      // 進入對方主頁，模擬看主頁 20-60 秒
      await ctx.page.goto(t.url, { waitUntil: 'domcontentloaded' });
      await randomDelay(20000, 60000);
      const profileInfo = await extractProfileInfo(ctx.page);

      const msg = await generateGreeting({ friendName: t.name, profileInfo });
      const r = await skills.skillSendMessage(ctx, { profileUrl: t.url, friendName: t.name, message: msg });
      if (r.success) {
        sent.push(t.name);
        await ctx.memory.recordMessage(
          t.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase(), t.name,
          { id: `greet_${Date.now()}`, direction: 'sent', content: msg, timestamp: Date.now(), hasAttachment: false }
        );
      } else {
        failed.push(t.name);
      }
      // 錯開：每個通過後延遲再發下一條
      await randomDelay(typeof greetDelay === 'number' ? Math.min(greetDelay, 8000) : 3000, 8000);
    } catch (e: any) {
      failed.push(t.name);
      await ctx.memory.recordAction('greet_error', { friend: t.name }, { error: e.message });
    }
  }

  // 掃描到 0 個（無新通過好友）也視為成功（無需處理），避免誤判失敗
  return { success: sent.length > 0 || targets.length === 0, action: 'greet_new_friends', data: { scanned: targets.length, sent, failed } };
}

/** 从真实 FB 个人主页提取公开資訊（城市/工作/學校/簡介），用於個性化問候 */
async function extractProfileInfo(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const txt: string[] = [];
      // 簡介區塊
      const intro = document.querySelector('[data-pagelet="ProfileIntro"]');
      if (intro) txt.push(intro.textContent?.replace(/\s+/g, ' ').trim().slice(0, 200) || '');
      // 工作/學校/城市：常見以連結形式出現
      const links = Array.from(document.querySelectorAll('a[href*="/games"] , a[href*="/school"] , a[href*="/employ"] , a[href*="/city"] , a[href*="/pages"]'));
      for (const l of links.slice(0, 6)) {
        const s = (l.textContent || '').trim();
        if (s) txt.push(s);
      }
      return txt.filter(Boolean).join('；').slice(0, 300);
    });
  } catch { return ''; }
}

async function runAutoLikeOwnPage(ctx: skills.SkillContext, params: any) {
  const ownPages: string[] = params.ownPages || OWN_PAGES;
  if (ownPages.length === 0) {
    return { success: false, action: 'auto_like_own_page', data: { liked: 0, reason: '未配置 OWN_PAGES' } };
  }

  await ctx.page.goto(resolveFbBase(ctx.accountId) + '/', { waitUntil: 'domcontentloaded' });
  await randomDelay(1500, 2500);

  let liked = 0;
  // 滾動瀏覽首頁，分批檢測帖子作者
  for (let round = 0; round < 3; round++) {
    const matched = await ctx.page.evaluate((pages: string[]) => {
      const result: { author: string; handle: string }[] = [];
      const articles = Array.from(document.querySelectorAll('[role="article"]'));
      for (const art of articles) {
        // 作者：帖子頭像/名稱連結
        const authorLink = art.querySelector('a[role="link"] h3, h3 a[role="link"], div[role="article"] a[href*="/profile.php"], div[role="article"] a[href*="/groups/"]') as HTMLElement | null;
        const authorName = (authorLink?.textContent || '').replace(/\s+/g, ' ').trim();
        if (pages.some(p => authorName.includes(p))) {
          result.push({ author: authorName, handle: '' });
        }
      }
      return result;
    }, ownPages);

    for (const m of matched) {
      // 概率 30-60% 點讚，避免全部點
      if (Math.random() < 0.45) {
        const ok = await ctx.page.evaluate((author: string) => {
          const articles = Array.from(document.querySelectorAll('[role="article"]'));
          for (const art of articles) {
            const a = art.querySelector('a[role="link"] h3, h3 a[role="link"]');
            if ((a?.textContent || '').includes(author)) {
              const btn = art.querySelector('div[aria-label="Like"]:not([aria-pressed="true"])') as HTMLElement | null;
              if (btn) { btn.click(); return true; }
            }
          }
          return false;
        }, m.author);
        if (ok) liked++;
      }
      await randomDelay(10000, 60000); // 瀏覽後 10-60 秒再點
    }

    // 滾動加載更多
    await ctx.page.evaluate(() => window.scrollBy(0, 1200));
    await randomDelay(2000, 4000);
  }

  return { success: liked > 0, action: 'auto_like_own_page', data: { liked, ownPages } };
}

async function runInviteToPage(ctx: skills.SkillContext, params: any) {
  // 优先显式传入；否则自动读取已配置的公共主页数据源；再退回 OWN_PAGES
  let pageUrl = params.pageUrl;
  if (!pageUrl) {
    const conf = getSourcesManager().listByType('page');
    if (conf.length > 0) {
      const chosen = conf.find(s => s.rawId === params.pageId) || conf[0];
      pageUrl = chosen.url;
    }
  }
  if (!pageUrl) pageUrl = OWN_PAGES[0];
  if (!pageUrl) {
    return { success: false, action: 'invite_to_page', data: { reason: '尚未配置公共主頁：請在「社团&主页数据源」頁面填寫你的主頁網址' } };
  }
  return skills.skillInviteToPage(ctx, { pageUrl, friendIds: params.friendIds, count: params.count || 10 });
}

async function runAiChatReply(ctx: skills.SkillContext, params: any) {
  const base = resolveFbBase(ctx.accountId);
  const replies: { peer: string; reply: string; sent: boolean }[] = [];

  // 1. 解析真實 FB /messages 未讀對話
  let threads: { name: string; url: string }[] = [];
  try {
    await ctx.page.goto(base + '/messages', { waitUntil: 'domcontentloaded' });
    await randomDelay(2500, 4500);
    threads = await ctx.page.evaluate(() => {
      const out: { name: string; url: string }[] = [];
      const seen = new Set<string>();
      const anchors = Array.from(document.querySelectorAll('a[href*="/messages/t/"]'));
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const key = (href.split('/messages/t/')[1] || '').split('/')[0];
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const parent = (a.parentElement?.parentElement || a.parentElement || a) as HTMLElement;
        const hasUnread = /未讀|unread/i.test(parent.innerHTML) || !!parent.querySelector('[aria-label*="未讀"]');
        if (hasUnread) {
          const name = (a.textContent || '').replace(/\s+/g, ' ').trim().split('\n')[0].slice(0, 30);
          out.push({ name, url: href.startsWith('http') ? href : 'https://www.facebook.com' + href });
        }
      }
      return out.slice(0, 5);
    });
    await ctx.memory.recordAction('chat_scan', { foundUnread: threads.length }, { threads });
  } catch (e: any) {
    await ctx.memory.recordAction('chat_scan', {}, { error: e.message });
  }

  // 顯式指定對象（便於測試）
  if (params.peers && params.peers.length) {
    threads = params.peers.map((n: string) => ({ name: n, url: `${base}/${encodeURIComponent(n)}` }));
  }

  for (const t of threads.slice(0, 2)) {
    try {
      await ctx.page.goto(t.url, { waitUntil: 'domcontentloaded' });
      await randomDelay(2000, 4000);

      // 讀取對方最後一句（非自己發的）
      const lastPeerMsg = await ctx.page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[role="row"], div[data-visualcompletion]'));
        for (let i = rows.length - 1; i >= 0; i--) {
          const text = (rows[i].textContent || '').trim();
          const style = (rows[i] as HTMLElement).getAttribute('style') || '';
          if (/row-reverse|justify.*end|text-align:\s*right/i.test(style)) continue;
          if (text.length > 0 && text.length < 300) return text;
        }
        return '';
      });

      const peerMsg = lastPeerMsg || '嗨';
      const trigger = detectTakeoverTrigger(peerMsg);
      emitAppEvent({ type: 'chat.incoming', accountId: ctx.accountId, friend: t.name, message: peerMsg, ts: Date.now() });

      const reply = await generateTakeoverReply({ friendName: t.name, lastMessage: peerMsg, trigger: trigger || 'chat', context: summarizeContext(ctx.accountId) });
      const textBox = await ctx.page.$('div[contenteditable="true"][role="textbox"]');
      if (!textBox) throw new Error('找不到聊天輸入框');

      // 人類打字模擬 + 發送
      await humanType(ctx.page, textBox, reply);
      await randomDelay(600, 1500);
      await ctx.page.keyboard.press('Enter');
      await randomDelay(1000, 2000);

      replies.push({ peer: t.name, reply, sent: true });
      emitAppEvent({ type: 'chat.replied', accountId: ctx.accountId, friend: t.name, reply, ts: Date.now() });
      if (trigger === 'level1_intro') {
        emitAppEvent({ type: 'takeover', accountId: ctx.accountId, friend: t.name, reason: 'level1_intro', ts: Date.now() });
      }

      // 寫入記憶碎片：對話記錄 + 關係備註（一級介紹標記為重要記憶，跨會話不丟）
      appendShard(ctx.accountId, {
        text: `與 ${t.name} 聊天：對方「${peerMsg}」→ 我「${reply}」`,
        important: trigger === 'level1_intro',
        friend: t.name,
        note: trigger === 'level1_intro' ? '已做一級介紹（跨境電商）' : '正常聊天接話',
      });

      await ctx.memory.recordMessage(
        t.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase(), t.name,
        { id: `reply_${Date.now()}`, direction: 'sent', content: reply, timestamp: Date.now(), hasAttachment: false }
      );
    } catch (e: any) {
      replies.push({ peer: t.name, reply: '', sent: false });
      await ctx.memory.recordAction('chat_reply_error', { peer: t.name }, { error: e.message });
    }
  }

  // 被動回覆任務結束後，不要把帳號晾在 Messenger（無論是 /messages 空面板還是 /messages/t/ 具體對話）。
  // 被動掃描只負責「回覆未讀」，回完（或無未讀）就應回到首頁保持乾淨狀態，方便下一輪被動掃描或主動任務。
  try {
    const finalUrl = (await ctx.page.url()).replace(/\?.*$/, '');
    if (finalUrl.includes('/messages')) {
      console.log(`[ai_chat_reply ${ctx.accountId}] 結束時仍在 Messenger 頁面，返回首頁`);
      await ctx.page.goto(base + '/', { waitUntil: 'domcontentloaded' });
      await randomDelay(1200, 2500);
    }
  } catch (e: any) {
    console.warn(`[ai_chat_reply ${ctx.accountId}] 返回首頁失敗: ${e.message}`);
  }

  // 掃描到 0 個未讀（無需回覆）也視為成功
  return { success: replies.some(r => r.sent) || threads.length === 0, action: 'ai_chat_reply', data: { scanned: threads.length, replies } };
}

async function runDistributeContent(params: any) {
  const contentId = params.contentId;
  const accountIds: string[] = params.accountIds || [];
  const staggerSeconds = params.staggerSeconds || 300;
  if (!contentId || accountIds.length === 0) throw new Error('缺少 contentId 或 accountIds');

  const content = loadContent(contentId);
  if (!content) throw new Error(`找不到內容 ${contentId}`);

  const results: any[] = [];
  for (let i = 0; i < accountIds.length; i++) {
    const accId = accountIds[i];
    try {
      const rewritten = await rewriteContent(content.text, i);
      const r = await runTask(accId, 'create_post', { content: rewritten });
      results.push({ accountId: accId, success: r.success, result: r.result });
      if (i < accountIds.length - 1) await randomDelay(staggerSeconds * 1000, staggerSeconds * 1000 + 5000);
    } catch (e: any) { results.push({ accountId: accId, success: false, error: e.message }); }
  }

  return { success: results.some(r => r.success), action: 'distribute_content', data: { contentId, results } };
}

async function runRiskCheck(ctx: skills.SkillContext, _params: any) {
  const detector = createPageDetector(ctx.page);
  const state = await detector.detectPageState();

  let level: 'low' | 'medium' | 'high' | 'critical' = 'low';
  if (['account_disabled', 'account_locked', 'suspended'].includes(state.pageType)) level = 'critical';
  else if (['login_checkpoint', 'login_captcha'].includes(state.pageType)) level = 'high';
  else if (state.activePopup === 'action_blocked' || state.activePopup === 'rate_limit_warning') level = 'high';
  else if (state.warnings.length > 0) level = 'medium';

  return { success: true, action: 'risk_check', data: { level, state } };
}

// ---------------- 任務前置狀態檢查 ----------------

const CRITICAL_PAGE_TYPES = new Set(['login_checkpoint', 'checkpoint_photo', 'checkpoint_identity', 'checkpoint_friends', 'account_disabled', 'account_locked', 'suspended']);
const CHECKPOINT_POPUPS = new Set(['checkpoint_identity', 'checkpoint_photo', 'checkpoint_friends']);

/**
 * 任務執行前置狀態檢查與自動處理。
 * - checkpoint / 禁用 / 鎖定：標記帳號狀態並停止任務
 * - Messenger PIN：自動建立/輸入 000000
 * - 未登入 + 非登入任務：嘗試自動登入，失敗則標記 needs_login 並停止
 */
async function prepareSessionForTask(accountId: string, page: Page, taskType: string, retried = false): Promise<{ ok: boolean; state?: PageState; error?: string }> {
  const detector = createPageDetector(page);
  const state = await detector.detectPageState();

  // 1. 關鍵封鎖狀態：直接標記並停止
  if (CRITICAL_PAGE_TYPES.has(state.pageType) || CHECKPOINT_POPUPS.has(state.activePopup)) {
    const reason = state.pageType;
    if (['account_disabled', 'account_locked', 'suspended'].includes(state.pageType)) {
      updateAccount(accountId, { status: 'dead' });
      emitAppEvent({ type: 'account.status', accountId, status: 'dead', reason, ts: Date.now() });
      return { ok: false, state, error: `帳號狀態異常（${reason}），已標記 dead，不再參與任務` };
    }
    updateAccount(accountId, { status: 'checkpoint' });
    emitAppEvent({ type: 'account.status', accountId, status: 'checkpoint', reason, ts: Date.now() });
    return { ok: false, state, error: `帳號觸發 Facebook 驗證（${reason}），已標記 checkpoint，等待人工處理` };
  }

  // 2. 自動處理 Messenger PIN（建立/驗證）
  if (state.activePopup === 'messenger_pin_create' || state.activePopup === 'messenger_pin_verify') {
    const pinCtx = { page, accountId, memory: getMemory(accountId) };
    const pinRes = await handleMessengerPin(pinCtx);
    if (pinRes.error) {
      return { ok: false, state, error: `Messenger PIN 自動處理失敗: ${pinRes.error}` };
    }
    // PIN 處理後重新檢測一次
    const state2 = await createPageDetector(page).detectPageState();
    return { ok: true, state: state2 };
  }

  // 3. 非登入/同步/狀態報告任務，必須已登入
  if (taskType !== 'login' && taskType !== 'sync' && taskType !== 'status_report' && !state.isLoggedIn) {
    const acc = getAccount(accountId);
    if (acc?.email && acc?.password && !retried) {
      const loginRes = await skills.skillLogin({ page, accountId, memory: getMemory(accountId) }, { email: acc.email, password: acc.password });
      if (!loginRes.success) {
        const newStatus = loginRes.pageStateAfter === 'login_checkpoint' ? 'checkpoint' : 'needs_login';
        updateAccount(accountId, { status: newStatus });
        emitAppEvent({ type: 'account.status', accountId, status: newStatus, reason: loginRes.pageStateAfter, ts: Date.now() });
        return { ok: false, state, error: `自動登入失敗: ${loginRes.error || loginRes.pageStateAfter}，帳號已標記 ${newStatus}` };
      }
      // 登入成功，重新檢測一次（避免無限遞迴）
      return prepareSessionForTask(accountId, page, taskType, true);
    }
    updateAccount(accountId, { status: 'needs_login' });
    emitAppEvent({ type: 'account.status', accountId, status: 'needs_login', ts: Date.now() });
    return { ok: false, state, error: '帳號未登入且無法自動登入（缺少帳密或登入失敗），已標記 needs_login，不再參與非登入任務' };
  }

  return { ok: true, state };
}

// ---------------- 彈窗處理 ----------------

async function dismissPopups(page: Page, accountId?: string) {
  try {
    const detector = createPageDetector(page);
    const state = await detector.detectPageState();
    switch (state.activePopup) {
      case 'messenger_pin_create':
      case 'messenger_pin_verify': {
        // 統一由 handleMessengerPin 自動輸入/建立 000000
        if (accountId) {
          const pinCtx = { page, accountId, memory: getMemory(accountId) };
          await handleMessengerPin(pinCtx);
        }
        break;
      }
      case 'cookie_consent':
        await page.click('button:has-text("Allow all cookies"), button:has-text("Accept all"), button:has-text("允許所有 Cookie")').catch(() => {});
        break;
      case 'notification_prompt':
        await page.click('button[value="0"], div[aria-label="關閉"], div[role="button"]:has-text("稍後再說")').catch(() => {});
        break;
      case 'friend_request_sent':
      case 'post_shared':
      case 'login_alert':
        await page.keyboard.press('Escape').catch(() => {});
        break;
      case 'action_blocked':
      case 'rate_limit_warning':
        // 頻率/操作被阻止：按 Escape 後讓後續任務自然失敗並標記
        await page.keyboard.press('Escape').catch(() => {});
        break;
      case 'error_dialog':
        // 錯誤對話框：嘗試 Escape，若無效則點第一個 role="button"
        await page.keyboard.press('Escape').catch(() => {});
        await page.click('div[role="dialog"] div[role="button"]:first-of-type').catch(() => {});
        break;
      default:
        break;
    }

    // 即使沒有識別到彈窗，若頁面級出現關鍵封鎖，嘗試 Escape 一次（對某些非 dialog 浮層有效）
    if (state.pageType === 'login_checkpoint' || state.pageType === 'login_captcha') {
      await page.keyboard.press('Escape').catch(() => {});
    }
  } catch (e: any) { /* ignore */ }
}

// ---------------- Mock FB 狀態輔助 ----------------

async function fetchMockState(page: Page): Promise<any> {
  try {
    const cookies = await page.context().cookies();
    const c_user = cookies.find(c => c.name === 'c_user');
    if (!c_user) return null;
    const res = await fetch(`${FB_BASE}/api/mock/state`, {
      headers: { Cookie: `c_user=${encodeURIComponent(c_user.value)}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ---------------- 內容庫輔助 ----------------

const CONTENT_DIR = path.join(DATA_DIR, 'content-library');

export function listContent(): { id: string; title: string; text: string; tags: string[] }[] {
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const raw = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, f), 'utf-8'));
    return { id: f.replace('.json', ''), title: raw.title || '', text: raw.text || '', tags: raw.tags || [] };
  });
}

export function loadContent(id: string): { text: string; title: string } | null {
  const p = path.join(CONTENT_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

export function saveContent(id: string, data: { title: string; text: string; tags?: string[] }) {
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONTENT_DIR, `${id}.json`), JSON.stringify(data, null, 2));
}

export function deleteContent(id: string) {
  const p = path.join(CONTENT_DIR, `${id}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
