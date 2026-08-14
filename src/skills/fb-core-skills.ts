/**
 * Facebook Core Skills — AI Agent 可调用的全部操作技能
 * 
 * 每个技能封装为一个标准化的操作单元，包含：
 * 1. 页面导航（自动检测是否需要先导航）
 * 2. 状态检查（操作前确认页面正确）
 * 3. 操作执行（拟人化延迟 + 错误处理）
 * 4. 结果验证（确认操作是否成功）
 * 5. 记忆记录（更新账号记忆体）
 */

import type { Page } from 'playwright-core';
import { FacebookPageDetector, createPageDetector } from '../detection/page-detector';
import { AccountMemory } from '../memory/account-memory';
import { getAccount, ensureMessengerPin, getJoinedGroupCount, recordJoinedGroup } from '../core/account-store';
import { resolveFbBase } from '../core/browser/session-manager';
import * as human from '../utils/human-behavior';
import * as path from 'path';
import * as fs from 'fs';
import { FB_BASE, MAX_GROUPS_PER_ACCOUNT, AVATAR_INBOX_DIR } from '../config';
import { isGroupGloballyJoined, recordGlobalJoinedGroup } from '../core/group-registry';
import { getNextAvailableAvatar, markAvatarUsed, accountHasAvatar } from '../core/avatar';

// ==================== 配置文件 ====================

export interface SkillContext {
  page: Page;
  accountId: string;
  memory: AccountMemory;
}

export interface SkillResult {
  success: boolean;
  action: string;
  data?: any;
  error?: string;
  pageStateAfter?: string;
}

// ==================== 1. 登录相关 ====================

/**
 * 自动登录 Facebook
 */
export async function skillLogin(ctx: SkillContext, params: {
  email: string;
  password: string;
}): Promise<SkillResult> {
  try {
    // 先检测是否已登录
    const detector = createPageDetector(ctx.page);
    const state = await detector.detectPageState();
    
    if (state.isLoggedIn) {
      return { success: true, action: 'login', data: { message: 'Already logged in', user: state.currentUser } };
    }

    // 导航到登录页（依帳號模式決定基址：real=facebook.com，mock=本地；不再硬編）
    if (state.pageType !== 'login') {
      const loginUrl = resolveFbBase(ctx.accountId) + '/login/';
      await ctx.page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      await human.randomDelay(2000, 4000);
    }

    // 填写邮箱
    const emailInput = await ctx.page.$('input[name="email"]');
    if (!emailInput) {
      return { success: false, action: 'login', error: '找不到邮箱输入框' };
    }
    await emailInput.click();
    await human.randomDelay(500, 1000);
    
    // 逐字输入（模拟真实打字）
    for (const char of params.email) {
      await ctx.page.keyboard.type(char);
      await new Promise(r => setTimeout(r, human.humanTypingDelay()));
    }
    await human.randomDelay(500, 1500);

    // 填写密码
    const passInput = await ctx.page.$('input[name="pass"]');
    if (!passInput) {
      return { success: false, action: 'login', error: '找不到密码输入框' };
    }
    await passInput.click();
    await human.randomDelay(300, 800);

    for (const char of params.password) {
      await ctx.page.keyboard.type(char);
      await new Promise(r => setTimeout(r, human.humanTypingDelay()));
    }
    await human.randomDelay(500, 1500);

    // 点击登录
    const loginBtn = await ctx.page.$('button[name="login"]') || 
                      await ctx.page.$('button[type="submit"]');
    if (!loginBtn) {
      return { success: false, action: 'login', error: '找不到登录按钮' };
    }
    await loginBtn.click();
    
    // 等待页面响应
    await human.randomDelay(3000, 6000);

    // 重新检测页面状态
    const newState = await detector.detectPageState();
    
    switch (newState.pageType) {
      case 'home':
        return { 
          success: true, 
          action: 'login', 
          data: { message: '登录成功', user: newState.currentUser },
          pageStateAfter: 'home'
        };
      case 'login_2fa':
        return { 
          success: false, 
          action: 'login', 
          error: '需要2FA验证码',
          pageStateAfter: 'login_2fa'
        };
      case 'login_checkpoint':
        return { 
          success: false, 
          action: 'login', 
          error: '触发安全检查点',
          pageStateAfter: 'login_checkpoint'
        };
      case 'login':
        return { 
          success: false, 
          action: 'login', 
          error: '登录失败，密码可能错误',
          pageStateAfter: 'login'
        };
      default:
        return { 
          success: false, 
          action: 'login', 
          error: `未知的登录后状态: ${newState.pageType}`,
          pageStateAfter: newState.pageType
        };
    }
  } catch (error: any) {
    return { success: false, action: 'login', error: error.message };
  }
}

// ==================== 2. 浏览首页 ====================

/**
 * 浏览首页并随机点赞
 */
export async function skillBrowseFeed(ctx: SkillContext, params: {
  scrollCount?: number;
  likeProbability?: number;
  duration?: number; // 总浏览时长 ms
}): Promise<SkillResult> {
  const scrollCount = params.scrollCount || 5;
  const likeProbability = params.likeProbability || 0.25;
  const duration = params.duration || 60000;

  try {
    const detector = createPageDetector(ctx.page);
    const state = await detector.detectPageState();

    // 确保在首页
    if (state.pageType !== 'home') {
      await ctx.page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
      await human.randomDelay(2000, 4000);
    }

    let likes = 0;
    let scrolls = 0;
    const startTime = Date.now();

    while (Date.now() - startTime < duration && scrolls < scrollCount) {
      // 滚动
      const amount = human.humanScrollAmount(300, 800);
      await ctx.page.mouse.wheel(0, amount);
      await human.readingPause();
      scrolls++;

      // 概率点赞
      if (human.shouldDoAction(likeProbability)) {
        const liked = await tryLikePost(ctx.page);
        if (liked) likes++;
      }

      // 偶尔停留久一点（模拟阅读）
      if (human.shouldDoAction(0.3)) {
        await human.randomDelay(3000, 8000);
      }
    }

    return {
      success: true,
      action: 'browse_feed',
      data: { scrolls, likes, duration: Date.now() - startTime },
    };
  } catch (error: any) {
    return { success: false, action: 'browse_feed', error: error.message };
  }
}

// ==================== 3. 点赞帖子 ====================

/**
 * 点赞指定帖子
 */
export async function skillLikePost(ctx: SkillContext, params: {
  postUrl?: string;
  reaction?: 'like' | 'love' | 'care' | 'haha' | 'wow' | 'sad' | 'angry';
}): Promise<SkillResult> {
  try {
    if (params.postUrl) {
      await ctx.page.goto(params.postUrl, { waitUntil: 'domcontentloaded' });
      await human.randomDelay(2000, 4000);
    }

    const reaction = params.reaction || 'like';

    if (reaction === 'like') {
      // 快速点赞（優先找未按過讚的，找不到就退而求其次）
      let likeBtn = await ctx.page.$('div[aria-label="Like"]:not([aria-pressed="true"])');
      if (!likeBtn) {
        likeBtn = await ctx.page.$('div[aria-label="Like"]') ||
                   await ctx.page.$('div[aria-label="讚"]');
      }
      if (!likeBtn) {
        return { success: false, action: 'like', error: '找不到可点赞的按钮' };
      }
      await likeBtn.scrollIntoViewIfNeeded();
      await human.randomDelay(300, 800);
      await likeBtn.click();
    } else {
      // 长按出表情选择
      const likeBtn = await ctx.page.$('div[aria-label="Like"]');
      if (!likeBtn) {
        return { success: false, action: 'like', error: '找不到点赞按钮' };
      }
      await likeBtn.hover();
      await human.randomDelay(500, 1000);
      
      const reactionMap: Record<string, string> = {
        love: 'Love', care: 'Care', haha: 'Haha',
        wow: 'Wow', sad: 'Sad', angry: 'Angry',
      };
      const reactionLabel = reactionMap[reaction];
      if (reactionLabel) {
        const reactionBtn = await ctx.page.$(`div[aria-label="${reactionLabel}"]`);
        if (reactionBtn) {
          await reactionBtn.click();
        }
      }
    }

    await human.randomDelay(500, 1500);

    return { success: true, action: 'like', data: { reaction } };
  } catch (error: any) {
    return { success: false, action: 'like', error: error.message };
  }
}

// ==================== 4. 分享帖子 ====================

/**
 * 分享帖子到指定目标
 */
export async function skillSharePost(ctx: SkillContext, params: {
  postUrl: string;
  target: 'timeline' | 'page' | 'group' | 'friend';
  targetId?: string;      // 目标好友/社团/主页 ID
  message?: string;       // 附加文字
}): Promise<SkillResult> {
  try {
    // 导航到帖子
    await ctx.page.goto(params.postUrl, { waitUntil: 'domcontentloaded' });
    await human.randomDelay(3000, 5000);

    // 点击分享按钮
    const shareBtn = await ctx.page.$('div[aria-label="Send this to friends or post it on your profile."]');
    if (!shareBtn) {
      // 尝试备用选择器
      const altShareBtn = await ctx.page.$('div[role="button"][aria-label*="Share" i]');
      if (!altShareBtn) {
        return { success: false, action: 'share', error: '找不到分享按钮' };
      }
      await altShareBtn.click();
    } else {
      await shareBtn.click();
    }
    
    await human.randomDelay(1000, 2500);

    // 根据目标选择分享方式
    switch (params.target) {
      case 'timeline':
        // "Share to Feed" - 默认就是分享到时间线
        break;
      case 'page':
        await clickShareOption(ctx.page, 'Share to a Page');
        break;
      case 'group':
        await clickShareOption(ctx.page, 'Share to a group');
        break;
      case 'friend':
        await clickShareOption(ctx.page, 'Send in Messenger');
        break;
    }

    await human.randomDelay(1000, 2000);

    // 如果有附加文字
    if (params.message) {
      const textArea = await ctx.page.$('div[contenteditable="true"][role="textbox"]');
      if (textArea) {
        await textArea.click();
        await human.randomDelay(500, 1000);
        await ctx.page.keyboard.type(params.message);
        await human.randomDelay(500, 1500);
      }
    }

    // 点击发布
    const postBtn = await ctx.page.$('div[aria-label="Post"]') || 
                     await ctx.page.$('div[role="button"]:has-text("Post")') ||
                     await ctx.page.$('div[role="button"]:has-text("Share")');
    if (!postBtn) {
      return { success: false, action: 'share', error: '找不到发布按钮' };
    }
    await postBtn.click();
    await human.randomDelay(2000, 4000);

    // 记录到记忆
    await ctx.memory.recordInteraction({
      friendId: params.targetId || 'feed',
      friendName: params.target,
      type: 'share',
      content: params.postUrl,
      timestamp: Date.now(),
      context: `分享到${params.target}`,
    });

    return { 
      success: true, 
      action: 'share', 
      data: { target: params.target, postUrl: params.postUrl } 
    };
  } catch (error: any) {
    return { success: false, action: 'share', error: error.message };
  }
}

// ==================== 5. 添加好友 ====================

/**
 * 添加好友
 */
export async function skillAddFriends(ctx: SkillContext, params: {
  mode: 'recommendations' | 'group_members' | 'profile' | 'search';
  groupId?: string;
  profileUrl?: string;
  searchQuery?: string;
  count?: number;
}): Promise<SkillResult> {
  const count = params.count || 3;
  const results = { added: 0, alreadyFriend: 0, skipped: 0, blocked: 0 };

  try {
    switch (params.mode) {
      case 'recommendations':
        // 导航到好友推荐页
        await ctx.page.goto('https://www.facebook.com/friends/suggestions', { 
          waitUntil: 'domcontentloaded' 
        });
        break;
      case 'group_members':
        if (!params.groupId) {
          return { success: false, action: 'add_friends', error: '需要提供 groupId' };
        }
        await ctx.page.goto(
          `https://www.facebook.com/groups/${params.groupId}/members`,
          { waitUntil: 'domcontentloaded' }
        );
        break;
      case 'profile':
        if (!params.profileUrl) {
          return { success: false, action: 'add_friends', error: '需要提供 profileUrl' };
        }
        await ctx.page.goto(params.profileUrl, { waitUntil: 'domcontentloaded' });
        break;
      case 'search':
        if (!params.searchQuery) {
          return { success: false, action: 'add_friends', error: '需要提供 searchQuery' };
        }
        const searchUrl = `https://www.facebook.com/search/people/?q=${encodeURIComponent(params.searchQuery)}`;
        await ctx.page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
        break;
    }

    await human.randomDelay(3000, 5000);

    // 添加好友
    for (let i = 0; i < count; i++) {
      const result = await tryAddFriend(ctx.page);
      
      if (result === 'added') results.added++;
      else if (result === 'already') results.alreadyFriend++;
      else if (result === 'blocked') {
        results.blocked++;
        break; // 被限制了，停止
      }
      else results.skipped++;

      await human.randomDelay(2000, 5000);

      // 滚动加载更多
      if (results.added < count - i) {
        await ctx.page.mouse.wheel(0, human.humanScrollAmount(300, 600));
      }
    }

    return {
      success: results.added > 0,
      action: 'add_friends',
      data: results,
    };
  } catch (error: any) {
    return { success: false, action: 'add_friends', error: error.message };
  }
}

// ==================== 5.5 依 FB 名稱加好友（自家帳號互加用） ====================

/**
 * 依 FB 顯示名稱搜尋並加好友（用於「正常登入的帳號互相加好友」）
 * - 搜尋該名稱，從結果卡片中找到名稱相符者，點擊其 Add friend
 * - 找不到相符卡片時退回「點第一個 Add friend」（低量、擬人）
 */
export async function skillAddFriendByName(ctx: SkillContext, params: {
  name: string;
}): Promise<SkillResult> {
  try {
    const q = encodeURIComponent(params.name);
    await ctx.page.goto(`https://www.facebook.com/search/people/?q=${q}`, { waitUntil: 'domcontentloaded' });
    await human.randomDelay(3000, 5000);

    // 在結果中找名稱相符的卡片並點擊其 Add friend
    const clicked = await ctx.page.evaluate((target: string) => {
      const t = target.trim().toLowerCase();
      const blocks = Array.from(document.querySelectorAll('div'))
        .filter((d) => {
          const txt = (d.textContent || '').toLowerCase();
          return txt.includes(t) && !!d.querySelector('div[aria-label="Add friend"], div[role="button"]');
        })
        .sort((a, b) => (a as HTMLElement).innerText.length - (b as HTMLElement).innerText.length);
      const block = blocks[0] as HTMLElement | undefined;
      if (!block) return false;
      const btn = (block.querySelector('div[aria-label="Add friend"]') ||
        Array.from(block.querySelectorAll('div[role="button"]')).find((e) => /add friend|加好友/i.test(e.textContent || ''))) as HTMLElement | undefined;
      if (btn) { btn.click(); return true; }
      return false;
    }, params.name);

    if (!clicked) {
      const any = await ctx.page.$('div[aria-label="Add friend"]');
      if (any) await any.click();
      else return { success: false, action: 'add_friend_by_name', error: '找不到相符使用者或 Add friend 按鈕' };
    }

    await human.randomDelay(1500, 3000);
    // 確認是否出現 Cancel request（代表已送出）
    const sent = await ctx.page.$('div[aria-label="Cancel request"]');
    return {
      success: true,
      action: 'add_friend_by_name',
      data: { target: params.name, sent: !!sent },
    };
  } catch (error: any) {
    return { success: false, action: 'add_friend_by_name', error: error.message };
  }
}

// ==================== 6. 邀请好友进社团 ====================

/**
 * 邀请好友加入社团
 */
export async function skillInviteToGroup(ctx: SkillContext, params: {
  groupId: string;
  groupName: string;
  friendIds?: string[];
  count?: number;
  skipAlreadyInvited?: boolean;
}): Promise<SkillResult> {
  const results = { invited: 0, skipped: 0, alreadyInvited: 0 };

  try {
    // 导航到邀请页面
    await ctx.page.goto(
      `https://www.facebook.com/groups/${params.groupId}/invite`,
      { waitUntil: 'domcontentloaded' }
    );
    await human.randomDelay(3000, 5000);

    const count = params.count || 10;

    for (let i = 0; i < count; i++) {
      // 检查当前页面上是否有可邀请的好友
      const inviteButtons = await ctx.page.$$('div[aria-label="Invite"]');

      if (inviteButtons.length === 0) {
        break; // 没有更多可邀请的好友
      }

      // 随机选一个邀请
      const btn = human.randomPick(inviteButtons);
      if (!btn) break;

      // 获取好友名字（用于记忆追踪）
      let friendName = '';
      try {
        friendName = await ctx.page.evaluate((el) => {
          const parent = el.closest('[role="article"], div[data-testid]');
          const nameEl = parent?.querySelector('a[role="link"], span[dir="auto"]');
          return nameEl?.textContent?.trim() || '';
        }, btn);
      } catch (_e: any) { /* ignore */ }

      await btn.click();
      await human.randomDelay(500, 1500);
      results.invited++;

      // 记录邀请历史
      await ctx.memory.recordInvitation({
        friendId: params.friendIds?.[i] || `unknown_${i}`,
        friendName: friendName || `好友_${i}`,
        groupId: params.groupId,
        groupName: params.groupName,
        timestamp: Date.now(),
        status: 'invited',
      });

      await human.randomDelay(1000, 3000);

      // 滚动加载更多
      if (i < count - 1) {
        await ctx.page.mouse.wheel(0, human.humanScrollAmount(400, 700));
      }
    }

    return {
      success: results.invited > 0,
      action: 'invite_to_group',
      data: results,
    };
  } catch (error: any) {
    return { success: false, action: 'invite_to_group', error: error.message };
  }
}

// ==================== 7. 加入群组 ====================

/**
 * 加入 Facebook 群组
 */
export async function skillJoinGroups(ctx: SkillContext, params: {
  keywords?: string[];
  groupUrls?: string[];
  count?: number;
  countryFilter?: string;  // 按地区过滤（如 'TW'）
  enforceTaiwan?: boolean;  // 是否強制只加台灣社團（預設 true）
}): Promise<SkillResult> {
  const enforceTW = params.enforceTaiwan !== false && (params.countryFilter === 'TW' || params.countryFilter === undefined);
  const results = { joined: 0, pending: 0, failed: 0, needQuestion: 0, skippedTaiwan: 0, skippedDup: 0 };
  const current = getJoinedGroupCount(ctx.accountId);
  const remaining = Math.max(0, MAX_GROUPS_PER_ACCOUNT - current);

  // 生涯加群上限：一個帳號一輩子最多三五十個，達上限即停止（不視為失敗）
  if (remaining <= 0) {
    return {
      success: true,
      action: 'join_groups',
      data: { ...results, capped: true, total: current, max: MAX_GROUPS_PER_ACCOUNT, note: `已达生涯社团上限(${MAX_GROUPS_PER_ACCOUNT})，停止加社团` },
    };
  }
  const count = Math.min(params.count || 3, remaining);

  try {
    const targets: string[] = [];

    // 如果有直接链接
    if (params.groupUrls) {
      targets.push(...params.groupUrls);
    }

    // 如果有搜索关键词
    if (params.keywords && targets.length < count) {
      for (const keyword of params.keywords) {
        const searchUrl = `https://www.facebook.com/groups/search/groups/?q=${encodeURIComponent(keyword)}`;
        await ctx.page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
        await human.randomDelay(3000, 5000);

        // 收集群组链接
        const groupLinks = await ctx.page.evaluate(() => {
          return Array.from(document.querySelectorAll('a[href*="/groups/"]'))
            .slice(0, 10)
            .map(a => (a as HTMLAnchorElement).href)
            .filter(href => href.includes('/groups/') && !href.includes('/members') && !href.includes('/search'));
        });

        for (const link of groupLinks) {
          if (!targets.includes(link)) {
            targets.push(link);
          }
          if (targets.length >= count * 2) break;
        }

        if (targets.length >= count * 2) break;
        await human.randomDelay(3000, 6000);
      }
    }

    // 跨帳號全域去重：其它帳號加過的社團，本帳號不再加（避免協同風控）
    const deduped = targets.filter(t => !isGroupGloballyJoined(t));
    results.skippedDup = targets.length - deduped.length;
    if (results.skippedDup > 0) {
      console.log(`[join_groups ${ctx.accountId}] 跨帳號去重跳過 ${results.skippedDup} 個已加社團`);
    }

    // 逐个尝试加入
    for (let i = 0; i < Math.min(deduped.length, count * 2); i++) {
      if (results.joined >= count) break;

      const groupUrl = deduped[i];
      await ctx.page.goto(groupUrl, { waitUntil: 'domcontentloaded' });
      await human.randomDelay(2000, 4000);

      // 強制台灣社團：開啟社團頁後判定地區，非台灣則跳過
      if (enforceTW) {
        const tw = await isTaiwanGroup(ctx.page);
        if (!tw.ok) {
          results.skippedTaiwan++;
          console.log(`[join_groups ${ctx.accountId}] 跳過非台灣社團：${groupUrl}（${tw.reason || '地區信號不足'}）`);
          await human.randomDelay(2000, 4000);
          continue;
        }
      }

      const result = await tryJoinGroup(ctx.page);

      if (result === 'joined' || result === 'pending') {
        if (result === 'joined') results.joined++;
        else results.pending++;
        recordJoinedGroup(ctx.accountId, groupUrl); // 單帳號生涯去重計數
        // 跨帳號全域清冊（含地區元資料，供總覽）
        const meta = await extractGroupMeta(ctx.page);
        recordGlobalJoinedGroup(groupUrl, ctx.accountId, { name: meta.name, members: meta.members, region: enforceTW ? '台灣' : undefined });
      } else if (result === 'question') results.needQuestion++;
      else if (result === 'already_member') { /* 已是成員，不計數 */ }
      else results.failed++;

      await human.randomDelay(5000, 10000);
    }

    return {
      success: results.joined > 0 || results.pending > 0 || remaining <= count,
      action: 'join_groups',
      data: { ...results, total: getJoinedGroupCount(ctx.accountId), max: MAX_GROUPS_PER_ACCOUNT },
    };
  } catch (error: any) {
    return { success: false, action: 'join_groups', error: error.message };
  }
}

/** 從社團頁抽取名稱/人數等元資料（供總覽與去重展示） */
async function extractGroupMeta(page: any): Promise<{ name?: string; members?: string }> {
  try {
    return await page.evaluate(() => {
      const name = (document.querySelector('h1')?.textContent || document.title || '').trim().slice(0, 80);
      const txt = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const m = txt.match(/([\d,]+)\s*(位成員|members|成員)/i);
      return { name: name || undefined, members: m ? m[1] + ' 成員' : undefined };
    });
  } catch { return {}; }
}

/**
 * 台灣社團判定（啟發式）：FB 本身無國家篩選，只能靠繁中語系 + 地區信號詞。
 * 命中：語言為繁中(zh-Hant) 且 名稱/簡介/貼文含台灣地區詞；或頁面聲明地點在台灣。
 * 防誤判：若出現明確非台信號（简体特征 + 中国/大陆/内地）則判非台。
 */
const TW_SIGNALS = ['台灣', '臺灣', '台北', '臺北', '高雄', '台中', '臺中', '新北', '桃園', '台南', '臺南', '基隆', '新竹', '嘉義', '嘉义', '屏東', '宜蘭', '花蓮', '台東', '金門', '馬祖', '中華民國', '繁體', '台語', '中正', '捷運'];
const CN_SIGNALS = ['中国', '大陆', '内地', '简体', '微信', '支付宝', '公众号'];
export async function isTaiwanGroup(page: any): Promise<{ ok: boolean; reason?: string }> {
  try {
    const info = await page.evaluate(() => {
      const htmlLang = (document.documentElement as any).lang || '';
      const text = ((document.querySelector('h1')?.textContent || '') + ' ' + (document.body?.innerText || '')).replace(/\s+/g, ' ').slice(0, 1200);
      const loc = (document.querySelector('[href*="place"]')?.textContent || '') + ' ' +
                  (Array.from(document.querySelectorAll('a')).map((a: any) => a.textContent).join(' ').slice(0, 600));
      return { htmlLang, text, loc };
    });
    const blob = (info.text + ' ' + info.loc).toLowerCase();
    const hasTw = TW_SIGNALS.some(s => blob.includes(s.toLowerCase()));
    const hasCn = CN_SIGNALS.some(s => blob.includes(s.toLowerCase()));
    const zhHant = /zh-hant|zh-tw|zh_tw/i.test(info.htmlLang) || /[\u4E00-\u9FFF]/.test(info.text);
    if (hasTw && !hasCn) return { ok: true, reason: '命中台灣地區信號' };
    if (hasCn && !hasTw) return { ok: false, reason: '命中中國/簡體信號' };
    if (hasTw && hasCn) return { ok: false, reason: '台/中信号並存，保守跳過' };
    // 無明確信號：繁中語系且無簡體特徵，視為可能台灣（保守通過）
    if (zhHant && !hasCn) return { ok: true, reason: '繁中語系、無簡體信號' };
    return { ok: false, reason: '無台灣地區信號' };
  } catch (e: any) {
    return { ok: false, reason: '判定異常：' + e.message };
  }
}

// ==================== 8. 发送私信 ====================

/**
 * 處理 Messenger 端對端加密聊天的 PIN 對話框。
 * - 若出現「建立 PIN」：自動產生並儲存 6 位數 PIN，填入兩個密碼欄（設定＋確認）後點擊建立。
 * - 若出現「輸入 PIN」：使用本機已儲存的 PIN 解鎖；若無儲存則回報失敗。
 * 回傳 true 代表有處理到 PIN 流程，false 代表頁面上沒有 PIN 對話框。
 */
export async function handleMessengerPin(ctx: SkillContext): Promise<{ handled: boolean; error?: string }> {
  try {
    await human.randomDelay(600, 1200);
    // 診斷：截圖 + 列出可見按鈕標籤，便於視覺驗證 PIN 對話框是否真的被處理
    try { fs.mkdirSync('G:/fbtest_shots/diag', { recursive: true }); } catch {}
    try { await ctx.page.screenshot({ path: 'G:/fbtest_shots/diag/pin-01-dialog.png' }); } catch (e: any) { console.log(`[PIN ${ctx.accountId}] shot fail ${e.message}`); }

    const pageText = await ctx.page.evaluate(() => (document.body?.innerText || '').slice(0, 3000));

    // ⚠️ 真實 FB PIN 流程：①介紹畫面只有「Créer un code PIN / Create PIN」按鈕；②點完出現 6 個數字框；③可能要再確認一次 PIN。
    // 若當前畫面沒有輸入框，先嘗試點擊「建立 PIN」按鈕，把對話框推進到輸入步驟。
    const createPinBtnTexts = [
      'Créer un code PIN', 'Créer un code', 'Créer',
      'Create PIN', 'Create a PIN', 'Set up PIN', 'Get started',
      '建立 PIN', '建立 PIN 碼', '建立密碼', '設定 PIN', '設定 PIN 碼', '新增 PIN',
      'Crear PIN', 'Crear un PIN', 'Crear', 'Crear código PIN',
      'PIN erstellen', 'Erstellen', 'Neuen PIN erstellen',
      'Crea PIN', 'Crea un PIN', 'Crea un codice PIN',
    ];
    const introKw = /Créez un code PIN|Create a PIN|Set up PIN|建立 PIN|設定 PIN|Crear PIN|PIN erstellen|Crea PIN|pour accéder à vos discussions|to access your chats|para acceder a tus conversaciones|accedere alle tue conversazioni/i;
    const maybeIntro = introKw.test(pageText);
    if (maybeIntro) {
      // 先記錄按鈕標籤到檔案，方便離線分析
      try {
        const labels = await ctx.page.evaluate(() => Array.from(document.querySelectorAll('button, [role="button"], a, div[role="button"]')).map((b: any) => ({
          text: (b.textContent || '').trim().slice(0, 60),
          aria: (b.getAttribute('aria-label') || '').slice(0, 60),
          role: b.getAttribute('role'),
          tag: b.tagName,
        })).filter(x => x.text || x.aria));
        fs.writeFileSync('G:/fbtest_shots/diag/pin-01-buttons.json', JSON.stringify(labels, null, 2));
      } catch {}

      // Playwright locator 點擊：必須選到真正的 [role="button"] 元素，避免匹配到外層 div 死區
      let clickedIntro = false;
      let clickLog = '';
      for (const txt of createPinBtnTexts) {
        try {
          const loc = ctx.page.locator('[role="button"], button').filter({ hasText: txt }).first();
          const n = await loc.count();
          if (n > 0) {
            const box = await loc.boundingBox().catch(() => null);
            // 過濾掉明顯是 viewport/body 的巨型元素
            if (box && box.width < 800 && box.height < 200) {
              await loc.click({ timeout: 5000, force: true });
              clickedIntro = true;
              clickLog = `locator(${txt}) box=${JSON.stringify(box)}`;
              break;
            }
          }
        } catch (e: any) { clickLog += `locator(${txt}) err=${e.message}; `; }
      }
      // 策略 2：getByRole + name regex + force
      if (!clickedIntro) {
        try {
          const loc = ctx.page.getByRole('button', { name: /建立 PIN|Create PIN|Créer|Crear|Erstellen|Crea/i }).first();
          const box = await loc.boundingBox().catch(() => null);
          if (await loc.count() > 0 && box && box.width < 800 && box.height < 200) {
            await loc.click({ timeout: 5000, force: true });
            clickedIntro = true;
            clickLog = 'getByRole';
          }
        } catch (e: any) { clickLog += `getByRole err=${e.message}; `; }
      }
      // 兜底：在瀏覽器內直接點含有建立文字的按鈕
      if (!clickedIntro) {
        clickedIntro = await ctx.page.evaluate((texts) => {
          const kw = new RegExp(texts.join('|'), 'i');
          const all = Array.from(document.querySelectorAll('button, [role="button"], a, div[role="button"], div'));
          for (const b of all) {
            const txt = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
            if (kw.test(txt)) {
              try {
                (b as any).scrollIntoView({ block: 'center', behavior: 'instant' });
                (b as any).click();
                return true;
              } catch {}
            }
          }
          return false;
        }, createPinBtnTexts);
        clickLog = clickedIntro ? 'evaluate' : 'evaluate-failed';
      }
      try { fs.writeFileSync('G:/fbtest_shots/diag/pin-01-click-log.json', JSON.stringify({ clickedIntro, clickLog, ts: Date.now() }, null, 2)); } catch {}
      if (clickedIntro) {
        console.log(`[PIN ${ctx.accountId}] 已點擊「建立 PIN」介紹按鈕，等待輸入框`);
        await human.randomDelay(1500, 2500);
        await ctx.page.screenshot({ path: 'G:/fbtest_shots/diag/pin-02-after-intro.png' }).catch(() => {});
      } else {
        console.log(`[PIN ${ctx.accountId}] 未能點擊「建立 PIN」介紹按鈕: ${clickLog}`);
      }
    }

    // 輔助：重新偵測頁面上的 PIN 輸入框
    const detectPinFields = async () => {
      const allInputs = await ctx.page.$$('input');
      const fields: any[] = [];
      for (const inp of allInputs) {
        const info = await inp.evaluate((el: any) => {
          const t = (el.getAttribute('type') || 'text').toLowerCase();
          const im = (el.getAttribute('inputmode') || '').toLowerCase();
          const ml = parseInt(el.getAttribute('maxlength') || '0', 10);
          const ph = (el.getAttribute('placeholder') || '').toLowerCase();
          return { type: t, im, ml, ph, visible: el.getClientRects().length > 0 };
        }).catch(() => ({ type: 'unknown', im: '', ml: 0, ph: '', visible: false }));
        const isPinLike = info.type === 'password' || info.type === 'tel' || info.im === 'numeric' || info.ml === 1 || /pin|code|密碼|密文|chiffre|codigo|código|パスワード/i.test(info.ph);
        if (isPinLike) fields.push(inp);
      }
      if (fields.length === 0) {
        const pw = await ctx.page.$$('input[type="password"]');
        fields.push(...pw);
      }
      return fields;
    };

    let pinFields = await detectPinFields();
    const btnLabels = await ctx.page.evaluate(() => Array.from(document.querySelectorAll('button, div[role="button"]')).map((b: any) => (b.textContent || '').trim()).filter((t: string) => t.length > 0 && t.length < 30).slice(0, 24)).catch(() => []);
    console.log(`[PIN ${ctx.accountId}] pinFields=${pinFields.length} btns=${JSON.stringify(btnLabels).slice(0, 500)}`);

    // 跨語言識別：先以 PIN/code/加密 強信號確認是 PIN 對話框，再用建立/輸入 類詞區分
    const hasPinSignal = /PIN|code|chiffrement|cifrado|verschlüssel/i.test(pageText);
    const wantsCreate = /create|créer|crea|建立|設定|set up|new|新增|get started/i.test(pageText);
    const wantsVerify = /enter|saisir|輸入|confirm|vérifier|verify|unlock/i.test(pageText);
    const isCreate = hasPinSignal && (wantsCreate || !wantsVerify);
    const isVerify = hasPinSignal && !wantsCreate && wantsVerify;

    if (!isCreate && !isVerify) return { handled: false };
    if (pinFields.length === 0) {
      return { handled: false, error: '偵測到 PIN 對話框但找不到任何 PIN 輸入框（password/tel/numeric/數字框）' };
    }

    const pin = isVerify ? (getAccount(ctx.accountId)?.messengerPin || '') : ensureMessengerPin(ctx.accountId);
    if (isVerify && !pin) {
      return {
        handled: false,
        error: 'Messenger 要求輸入既有 PIN，但帳號設定中找不到 messengerPin。請在 accounts.json 為該帳號補上 6 位數 PIN，或先手動解鎖一次讓系統建立新 PIN。',
      };
    }

    // 最多處理兩輪：建立 + 確認
    for (let round = 0; round < 2; round++) {
      pinFields = await detectPinFields();
      if (pinFields.length === 0) break;

      // 填寫 PIN：6 個獨立數字框 → 逐位填入；否則整串填入
      if (pinFields.length === 6) {
        for (let i = 0; i < 6; i++) {
          const f = pinFields[i];
          await f.click().catch(() => {});
          await human.randomDelay(120, 300);
          await f.fill(String(pin[i] ?? '0')).catch(() => {});
          await human.randomDelay(120, 300);
        }
      } else {
        for (const f of pinFields) {
          await f.click().catch(() => {});
          await human.randomDelay(150, 350);
          await f.fill(pin).catch(() => {});
          await human.randomDelay(300, 600);
        }
      }

      // 截圖記錄
      await ctx.page.screenshot({ path: `G:/fbtest_shots/diag/pin-03-filled-${round}.png` }).catch(() => {});

      // 點擊建立/確認/繼續按鈕
      const submitTexts = [
        'Create PIN', 'Create a PIN', 'Créer', 'Créer un code PIN',
        '建立 PIN', '建立', '設定 PIN', '確認', '完成', 'Done',
        'Crear', 'Crear PIN', 'Continuar', 'Siguiente',
        'Erstellen', 'Weiter', 'Fertig',
        'Crea', 'Crea PIN', 'Avanti', 'Fine',
        'Next', 'Continue', 'OK', 'Save', '儲存', '保存',
      ];
      let submitted = await clickTextRobust(ctx.page, submitTexts, 'button, [role="button"], a', 5000);
      if (!submitted) {
        // 兜底：在瀏覽器內直接點含有提交文字的按鈕
        submitted = await ctx.page.evaluate((texts) => {
          const kw = new RegExp(texts.join('|'), 'i');
          const btns = Array.from(document.querySelectorAll('button, [role="button"], a, div[role="button"]'));
          for (const b of btns) {
            if (kw.test((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || ''))) {
              try { (b as any).scrollIntoView({ block: 'center' }); (b as any).click(); return true; } catch {}
            }
          }
          return false;
        }, submitTexts);
      }
      if (!submitted) {
        // 再兜底：對最後一個輸入框按 Enter
        const last = pinFields[pinFields.length - 1];
        if (last) await last.press('Enter').catch(() => {});
      }

      await human.randomDelay(1500, 2500);
      // 若對話框已消失（無輸入框）則完成；否則進入第二輪（確認 PIN）
      const still = await detectPinFields();
      if (still.length === 0) break;
      console.log(`[PIN ${ctx.accountId}] round ${round} 後仍有輸入框，進入確認輪`);
    }

    // 最後等待 PIN 對話框消失
    for (let i = 0; i < 15; i++) {
      await human.randomDelay(800, 1200);
      const still = await detectPinFields();
      if (still.length === 0) break;
    }
    await ctx.page.screenshot({ path: 'G:/fbtest_shots/diag/pin-04-done.png' }).catch(() => {});
    return { handled: true };
  } catch (error: any) {
    return { handled: false, error: error.message };
  }
}

/**
 * 從個人檔案頁提取好友的數字 UID（用於直接打開全頁 Messenger thread）。
 * FB 個人檔案頁的 header/頭像連結普遍帶 data-hovercard="...user.php?id=<UID>"，
 * 或存在指向 profile.php?id=<UID> 的連結，亦可從 canonical link 取得。
 */
async function extractProfileUid(ctx: SkillContext): Promise<string> {
  return ctx.page.evaluate(() => {
    const hcEl = document.querySelector('[data-hovercard*="user.php?id="]') as HTMLElement | null;
    if (hcEl) {
      const v = hcEl.getAttribute('data-hovercard') || hcEl.getAttribute('href') || '';
      const m = v.match(/[?&]id=(\d{6,})/);
      if (m) return m[1];
    }
    for (const a of Array.from(document.querySelectorAll('a[href*="profile.php?id="]'))) {
      const m = (a.getAttribute('href') || '').match(/[?&]id=(\d{6,})/);
      if (m) return m[1];
    }
    const canon = document.querySelector('link[rel="canonical"]');
    if (canon) {
      const m = (canon.getAttribute('href') || '').match(/[?&]id=(\d{6,})/);
      if (m) return m[1];
    }
    return '';
  });
}

/**
 * 跨語言尋找「發消息/傳訊息/Message」按鈕（FB 個人檔案頁的訊息入口）。僅作兜底用。
 */
async function findMessageButton(ctx: SkillContext): Promise<any> {
  const btnSelectors = [
    'div[role="button"][aria-label*="Message" i]',
    'div[role="button"][aria-label*="傳訊息" i]',
    'div[role="button"][aria-label*="發訊息" i]',
    'div[role="button"][aria-label*="訊息" i]',
    'a[role="button"][aria-label*="Message" i]',
    'a[role="button"][aria-label*="傳訊息" i]',
    'a[role="button"][aria-label*="發訊息" i]',
    'a[role="button"][aria-label*="訊息" i]',
    'div[role="button"]:has-text("Message")',
    'div[role="button"]:has-text("傳訊息")',
    'div[role="button"]:has-text("發訊息")',
    'div[role="button"]:has-text("发消息")',
    'div[role="button"]:has-text("訊息")',
  ];
  for (const sel of btnSelectors) {
    const loc = ctx.page.locator(sel).first();
    if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

/**
 * 发送私信
 */
export async function skillSendMessage(ctx: SkillContext, params: {
  profileUrl?: string;
  friendName?: string;
  message: string;
}): Promise<SkillResult> {
  try {
    if (params.profileUrl) {
      await ctx.page.goto(params.profileUrl, { waitUntil: 'domcontentloaded' });
      await human.randomDelay(2500, 4500);

      // 導航到檔案頁後若彈出 Messenger PIN 對話框，先解鎖再繼續
      const initialPin = await handleMessengerPin(ctx);
      if (initialPin.error) {
        return { success: false, action: 'send_message', error: initialPin.error };
      }

      // 提取好友數字 UID，直接打開「全頁 Messenger thread」。
      // 關鍵修正：原本點檔案頁「訊息」按鈕會開出 docked 面板，其 composer 被 FB 渲染在
      // fbsbx.com 跨域 maw_proxy_page iframe 內，主 DOM 與 Playwright 都無法存取（已實機驗證）。
      // 全頁 /messages/t/<uid>/ 的 composer 在 FB 主 document DOM 內，可正常定位與輸入。
      const uid = await extractProfileUid(ctx);
      if (uid) {
        await ctx.page.goto(`${resolveFbBase(ctx.accountId)}/messages/t/${uid}/`, { waitUntil: 'domcontentloaded' });
        await human.randomDelay(2500, 4000);
        const threadPin = await handleMessengerPin(ctx);
        if (threadPin.error) {
          return { success: false, action: 'send_message', error: threadPin.error };
        }
      } else {
        // 兜底：取不到 UID 才退回點「訊息」按鈕（可能遇到跨域 iframe，僅最佳努力）
        const btnEl = await findMessageButton(ctx);
        if (!btnEl) {
          return { success: false, action: 'send_message', error: '找不到發消息按鈕，也無法解析好友 UID' };
        }
        await btnEl.click({ timeout: 10000 });
        await human.randomDelay(1500, 2500);
        const afterClickPin = await handleMessengerPin(ctx);
        if (afterClickPin.error) {
          return { success: false, action: 'send_message', error: afterClickPin.error };
        }
      }
    }

    // 等待對話輸入框出現。現在主路徑走全頁 /messages/t/<uid>/，composer 在 FB 主
    // document DOM 內，主頁 locator 即可命中。跨 frame 搜尋保留為安全網（涵蓋 docked
    // 面板等仍渲染在 fbsbx.com 跨域 maw_proxy_page iframe 的情境）。
    // 關鍵：絕不要「再點一次」去賭——第二次點擊會把面板關掉。
    const inputSelectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[data-testid="messenger_composer_input"]',
      '[role="dialog"] div[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[aria-label*="Message" i][contenteditable="true"]',
      'div[contenteditable="true"]',
    ];
    // 候選 frame：主頁 + 其所有 iframe + 彈出視窗 + 彈出視窗的 iframe
    const candidateFrames: any[] = [ctx.page];
    try { for (const f of await ctx.page.frames()) candidateFrames.push(f); } catch {}
    for (const p of ctx.page.context().pages()) {
      if (p === ctx.page) continue;
      candidateFrames.push(p);
      try { for (const f of await p.frames()) candidateFrames.push(f); } catch {}
    }
    let textBox: any = null;
    for (const frame of candidateFrames) {
      for (const sel of inputSelectors) {
        try {
          const loc = frame.locator(sel).first();
          await loc.waitFor({ state: 'visible', timeout: 5000 });
          textBox = loc;
          break;
        } catch { /* 試下一個選擇器 */ }
      }
      if (textBox) break;
    }
    if (!textBox) {
      return { success: false, action: 'send_message', error: '找不到消息输入框' };
    }

    await textBox.click();
    await human.randomDelay(500, 1000);

    // 人類打字模擬（逐字 + 思考停頓 + 偶發改口）。用 Page 層鍵盤，聚焦後可跨 iframe 輸入。
    await human.humanType(ctx.page, textBox, params.message);
    await human.randomDelay(500, 1500);

    // 发送
    await ctx.page.keyboard.press('Enter');
    await human.randomDelay(1000, 2000);

    // 记录对话
    if (params.friendName) {
      await ctx.memory.recordMessage(
        params.friendName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase(),
        params.friendName,
        {
          id: `msg_${Date.now()}`,
          direction: 'sent',
          content: params.message,
          timestamp: Date.now(),
          hasAttachment: false,
        }
      );
    }

    return { success: true, action: 'send_message', data: { message: params.message.slice(0, 50) } };
  } catch (error: any) {
    return { success: false, action: 'send_message', error: error.message };
  }
}

// ==================== 8.5 依 FB 名稱發送私信（自家帳號互聊用） ====================

/**
 * 依 FB 顯示名稱發送私信：搜尋該名稱 → 進入其個人檔案 → 點 Message 開啟對話 → 輸入並送出。
 * （send_message 需帶 profileUrl 才會真的開對話；互聊是按名稱找人，故包一層搜尋）
 */
export async function skillSendMessageToName(ctx: SkillContext, params: {
  name: string;
  message: string;
}): Promise<SkillResult> {
  try {
    const q = encodeURIComponent(params.name);
    await ctx.page.goto(`https://www.facebook.com/search/people/?q=${q}`, { waitUntil: 'domcontentloaded' });
    await human.randomDelay(3000, 5000);

    const profileUrl = await ctx.page.evaluate((target: string) => {
      const t = target.trim().toLowerCase();
      const links = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
        const txt = (a.textContent || '').toLowerCase();
        const href = a.getAttribute('href') || '';
        return txt.includes(t) && /facebook\.com\/(profile\.php\?id=|\w)/.test(href) && !href.includes('/search');
      }).sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      const el = links[0] as HTMLAnchorElement | undefined;
      return el ? el.href : '';
    }, params.name);

    if (!profileUrl) {
      return { success: false, action: 'send_message_to_name', error: '找不到該使用者個人檔案' };
    }
    return skillSendMessage(ctx, { profileUrl, friendName: params.name, message: params.message });
  } catch (error: any) {
    return { success: false, action: 'send_message_to_name', error: error.message };
  }
}

// ==================== 9. 发布帖子 ====================

/**
 * 发布帖子（到个人主页或社团）
 */
export async function skillCreatePost(ctx: SkillContext, params: {
  content: string;
  target?: 'profile' | 'group';
  groupUrl?: string;
  imagePath?: string;
}): Promise<SkillResult> {
  try {
    if (params.target === 'group' && params.groupUrl) {
      await ctx.page.goto(params.groupUrl, { waitUntil: 'domcontentloaded' });
      await human.randomDelay(2000, 4000);
    } else {
      // 确保在首页或自己主页
      await ctx.page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
      await human.randomDelay(2000, 4000);
    }

    // 点击 "What's on your mind" 打开发帖框
    const composerBtn = await ctx.page.$('div[role="button"]:has-text("在想些什麼")') ||
                         await ctx.page.$('div[role="button"]:has-text("在想些什么")') ||
                         await ctx.page.$('div[role="button"]:has-text("What\'s on your mind")');
    if (!composerBtn) {
      return { success: false, action: 'create_post', error: '找不到发帖按钮' };
    }
    await composerBtn.click();
    await human.randomDelay(1000, 2000);

    // 找到文本编辑区
    const textBox = await ctx.page.$('div[contenteditable="true"][role="textbox"]');
    if (!textBox) {
      return { success: false, action: 'create_post', error: '找不到文本输入区' };
    }

    await textBox.click();
    await human.randomDelay(500, 1000);

    // 输入内容
    await ctx.page.keyboard.type(params.content);
    await human.randomDelay(1000, 2000);

    // 如果有图片
    if (params.imagePath) {
      const fileInput = await ctx.page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.setInputFiles(params.imagePath);
        await human.randomDelay(2000, 4000);
      }
    }

    // 发布
    const postBtn = await ctx.page.$('div[aria-label="Post"]') ||
                     await ctx.page.$('div[role="button"]:has-text("Post")') ||
                     await ctx.page.$('div[role="button"]:has-text("發布")') ||
                     await ctx.page.$('div[role="button"]:has-text("发布")');
    if (!postBtn) {
      return { success: false, action: 'create_post', error: '找不到发布按钮' };
    }
    await postBtn.click();
    await human.randomDelay(3000, 5000);

    return { success: true, action: 'create_post', data: { contentPreview: params.content.slice(0, 100) } };
  } catch (error: any) {
    return { success: false, action: 'create_post', error: error.message };
  }
}

// ==================== 10. 获取好友列表 ====================

/**
 * 获取当前账号的好友列表
 */
export async function skillGetFriends(ctx: SkillContext, params: {
  saveToMemory?: boolean;
  maxScroll?: number;
}): Promise<SkillResult> {
  const friends: { name: string; url: string }[] = [];

  try {
    await ctx.page.goto('https://www.facebook.com/friends', { waitUntil: 'domcontentloaded' });
    await human.randomDelay(2000, 4000);

    const maxScroll = params.maxScroll || 10;
    let prevCount = 0;

    for (let i = 0; i < maxScroll; i++) {
      const currentLinks = await ctx.page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="facebook.com/"][role="link"]'))
          .filter(a => a.textContent?.trim() && a.getAttribute('href')?.includes('facebook.com/'))
          .map(a => ({
            name: a.textContent?.trim() || '',
            url: (a as HTMLAnchorElement).href,
          }));
      });

      for (const f of currentLinks) {
        if (!friends.find(existing => existing.url === f.url)) {
          friends.push(f);
        }
      }

      if (friends.length === prevCount) break;
      prevCount = friends.length;

      // 滚动
      await ctx.page.mouse.wheel(0, human.humanScrollAmount(600, 1200));
      await human.randomDelay(1500, 3000);
    }

    // 保存到记忆
    if (params.saveToMemory) {
      for (const f of friends) {
        ctx.memory.addFriend({
          friendId: f.url.split('/').pop() || f.name,
          name: f.name,
          facebookUrl: f.url,
          dateAdded: Date.now(),
          source: 'manual',
          tags: [],
          notes: '',
        });
      }
    }

    return {
      success: true,
      action: 'get_friends',
      data: { count: friends.length, friends: friends.slice(0, 100) },
    };
  } catch (error: any) {
    return { success: false, action: 'get_friends', error: error.message };
  }
}

// ==================== 辅助函数 ====================

async function tryLikePost(page: Page): Promise<boolean> {
  try {
    const likeBtns = await page.$$('div[aria-label="Like"]:not([aria-pressed="true"])');
    const visibleBtns: any[] = [];
    
    for (const btn of likeBtns) {
      const visible = await btn.isVisible();
      if (visible) visibleBtns.push(btn);
    }

    if (visibleBtns.length === 0) return false;
    
    const btn = human.randomPick(visibleBtns);
    if (!btn) return false;

    await btn.scrollIntoViewIfNeeded();
    await human.randomDelay(300, 800);
    await btn.click();
    await human.randomDelay(500, 1500);
    
    return true;
  } catch {
    return false;
  }
}

async function tryAddFriend(page: Page): Promise<'added' | 'already' | 'skipped' | 'blocked'> {
  try {
    // 检查是否被阻止操作
    const blocked = await page.$('div[role="dialog"]:has-text("can\'t perform")');
    if (blocked) return 'blocked';

    const addBtn = await page.$('div[aria-label="Add friend"]:not([aria-disabled="true"])') ||
                    await page.$('div[role="button"]:has-text("Add Friend")') ||
                    await page.$('div[role="button"]:has-text("加好友")');

    if (!addBtn) return 'skipped';

    await addBtn.scrollIntoViewIfNeeded();
    await human.randomDelay(500, 1500);
    await addBtn.click();
    await human.randomDelay(1000, 2000);

    // 检查是否发送成功
    const cancelBtn = await page.$('div[aria-label="Cancel request"]') ||
                       await page.$('div[aria-label="取消邀请"]');
    if (cancelBtn) return 'added';

    const alreadyBtn = await page.$('div[aria-label*="Friend" i]') ||
                        await page.$('div[aria-label*="朋友" i]');
    if (alreadyBtn) return 'already';

    return 'added';
  } catch {
    return 'skipped';
  }
}

async function tryJoinGroup(page: Page): Promise<'joined' | 'pending' | 'question' | 'already_member' | 'failed'> {
  try {
    const joinBtn = await page.$('div[aria-label="Join group"]') ||
                     await page.$('div[role="button"]:has-text("Join")') ||
                     await page.$('div[role="button"]:has-text("加入")') ||
                     await page.$('div[role="button"]:has-text("申請加入")');

    if (!joinBtn) {
      // 可能已经是成员
      const isMember = await page.$('div[aria-label="Joined"]') ||
                        await page.$('div[aria-label="邀请"]');
      return isMember ? 'already_member' : 'failed';
    }

    await joinBtn.click();
    await human.randomDelay(1500, 3000);

    // 检查是否有入群问题
    const questionBox = await page.$('textarea[aria-label*="answer" i]') ||
                         await page.$('[role="dialog"] textarea');
    if (questionBox) return 'question';

    // 等待结果
    await human.randomDelay(1000, 2000);
    
    const pendingBtn = await page.$('div[aria-label="Pending"]') ||
                        await page.$('div[aria-label="已申請"]');
    if (pendingBtn) return 'pending';

    return 'joined';
  } catch {
    return 'failed';
  }
}

async function clickShareOption(page: Page, optionText: string): Promise<boolean> {
  try {
    const option = await page.$(`div[role="menuitem"]:has-text("${optionText}")`) ||
                    await page.$(`span:has-text("${optionText}")`);
    if (option) {
      await option.click();
      await human.randomDelay(500, 1500);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ==================== 11. 邀请好友点赞/访问主页 ====================

/**
 * 邀请好友访问并点赞自己的公共主页
 * - 若本账号是该主页管理员：打开主页「邀請好友」对话框，逐个点击邀請
 * - 若非管理员（无邀請入口）：降级为把主页分享给指定好友（Messenger），達成「邀請訪問主頁」
 */
export async function skillInviteToPage(ctx: SkillContext, params: {
  pageUrl: string;       // 自己的公共主页网址，如 https://www.facebook.com/MyPage
  friendIds?: string[];
  count?: number;
}): Promise<SkillResult> {
  const results = { invited: 0, shared: 0, skipped: 0, reason: '' as string };
  try {
    const pageUrl = params.pageUrl.replace(/\/+$/, '');
    await ctx.page.goto(`${pageUrl}?sk=invites`, { waitUntil: 'domcontentloaded' });
    await human.randomDelay(3000, 5000);

    // 嘗試管理員邀請入口
    const inviteBtns = await ctx.page.$$('div[aria-label="Invite"], button:has-text("邀請"), button:has-text("Invite")');
    if (inviteBtns.length > 0) {
      const count = params.count || 10;
      for (let i = 0; i < Math.min(inviteBtns.length, count); i++) {
        try {
          const btn = inviteBtns[i];
          await btn.scrollIntoViewIfNeeded();
          await human.randomDelay(400, 1200);
          await btn.click();
          results.invited++;
          await human.randomDelay(800, 2000);
        } catch { results.skipped++; }
      }
      results.reason = 'admin_invite';
      if (results.invited > 0) {
        return { success: true, action: 'invite_to_page', data: results };
      }
    }

    // 非管理員：降级為分享主頁給好友（達成「邀請訪問主頁」）
    const share = await skillSharePost(ctx, {
      postUrl: pageUrl,
      target: 'friend',
      targetId: params.friendIds?.[0] || 'friend',
      message: '這是我經營的粉絲頁，有興趣可以來逛逛按個讚～',
    });
    if (share.success) {
      results.shared = 1;
      results.reason = 'share_fallback';
      return { success: true, action: 'invite_to_page', data: results };
    }
    results.reason = 'no_invite_entry_and_share_failed';
    return { success: false, action: 'invite_to_page', data: results };
  } catch (error: any) {
    return { success: false, action: 'invite_to_page', error: error.message };
  }
}

// ==================== 語言設置（登入後首次操作的標準動作） ====================

/**
 * 將 FB 介面語言設為「繁體中文 (台灣)」。
 * 完全走 FB 真實設定流程，不使用任何網址 + /zh-cn|tw 之類的無效 hack：
 *   1) 盡量點擊右上角頭像/賬戶圖標打開菜單（best-effort，模擬真人首次操作）
 *   2) 進入語言設定頁 /settings?tab=language（即「頭像 → 設定 → 語言」的最終落點）
 *   3) 找到 Facebook language 行的 Edit，打開後用 <select> 選 "Traditional Chinese (Taiwan)"
 *      （該英文文本在 FB 任意 UI 語言下都會顯示，故不受帳號當前語言影響）
 *   4) 點擊儲存/變更
 */
/**
 * 依文字點擊（中英文都匹配），僅對可見元素生效，避免誤點 footer 語言連結。
 * 返回是否成功點到任一匹配項。
 */
async function clickByTexts(
  page: any,
  texts: string[],
  selectorBase: string,
  timeout = 5000
): Promise<boolean> {
  for (const t of texts) {
    const loc = page.locator(selectorBase).filter({ hasText: t });
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        try {
          await el.click({ timeout });
          return true;
        } catch { /* 試下一個可見匹配 */ }
      }
    }
  }
  return false;
}

/** 判斷文字是否為「繁體中文(台灣)」選項：兼容英文、繁中、法/西/葡/德/意/日/韓等 FB 多語言寫法 */
function isTwText(t: string): boolean {
  const s = (t || '').trim();
  // 英文 / 繁中 / 簡中
  if (/Traditional Chinese \(Taiwan\)/i.test(s)) return true;
  if (/繁體中文/.test(s) && /台灣/.test(s)) return true;
  if (/正體中文/.test(s) && /台灣/.test(s)) return true;
  if (/中文[\(（]台灣[\)）]/.test(s)) return true;
  // 法文 Chinois traditionnel (Taïwan/Taiwan)
  if (/Chinois traditionnel/i.test(s) && /Ta[iï]wan/i.test(s)) return true;
  // 西班牙文 Chino tradicional (Taiwán/Taiwan)
  if (/Chino tradicional/i.test(s) && /Taiw[áa]n/i.test(s)) return true;
  // 葡萄牙文 Chinês tradicional (Taiwan)
  if (/Chin[eê]s tradicional/i.test(s) && /Taiwan/i.test(s)) return true;
  // 德文 Traditionelles Chinesisch (Taiwan)
  if (/Traditionelles Chinesisch/i.test(s) && /Taiwan/i.test(s)) return true;
  // 意大利文 Cinese tradizionale (Taiwan)
  if (/Cinese tradizionale/i.test(s) && /Taiwan/i.test(s)) return true;
  // 日文 繁体中文（台湾）/ 繁體中文（台湾）
  if (/繁体中文|繁體中文/.test(s) && /台湾|台灣/.test(s)) return true;
  // 韓文 번체중국어(대만)
  if (/번체중국어/i.test(s) && /대만/i.test(s)) return true;
  return false;
}

/** 檢查 FB 右上角賬戶下拉菜單是否已展開（必須在 [role="menu"] 容器內看到標誌性選項，避免把頭像按鈕本身誤判為菜單） */
async function isAccountMenuOpen(page: any): Promise<boolean> {
  const menus = page.locator('[role="menu"]');
  const n = await menus.count();
  for (let i = 0; i < n; i++) {
    const menu = menus.nth(i);
    if (!(await menu.isVisible().catch(() => false))) continue;
    const checks = ['Log Out','登出','Settings & privacy','設定與隱私','設定和隱私','Language','語言'];
    for (const text of checks) {
      const items = menu.locator('[role="menuitem"], [role="button"], button, a').filter({ hasText: text });
      const m = await items.count();
      for (let j = 0; j < m; j++) {
        if (await items.nth(j).isVisible().catch(() => false)) return true;
      }
    }
  }
  return false;
}

/** 關閉任何已打開的 dialog / dropdown（通知面板、菜單等），避免遮擋頭像點擊 */
async function dismissOverlays(page: any): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try { await page.keyboard.press('Escape'); } catch {}
    await human.randomDelay(150, 350);
  }
}

/** 頁面上是否存在「通知」下拉 dialog（曾攔截頭像點擊的元兇） */
async function hasNotificationDialog(page: any): Promise<boolean> {
  const n = await page.locator('[role="dialog"][aria-label*="通知"], [role="dialog"][aria-label*="Notification"], [role="dialog"][aria-label*="通知"]').count();
  return n > 0;
}

/** 嘗試多種真實 FB 頭像選擇器，直到賬戶下拉菜單成功展開 */
async function openAccountMenu(page: any, log: (m: string) => void, accountName?: string): Promise<boolean> {
  // 先關閉可能遮擋頭像的 dialog/dropdown（如通知面板），避免頭像點擊被攔截
  await dismissOverlays(page);

  const firstName = accountName ? accountName.split(/\s+/)[0] : '';
  const nameCandidates: string[] = accountName ? [
    `header [aria-label*="${accountName}" i]`,
    `header [aria-label*="${firstName}" i]`,
    `[role="banner"] [aria-label*="${accountName}" i]`,
    `[role="banner"] [aria-label*="${firstName}" i]`,
  ] : [];
  // 精確優先：「你的個人檔案 / Your profile」是 FB 帳戶菜單觸發點（點擊開菜單而非跳轉）
  const candidates: string[] = [
    'header [aria-label="你的個人檔案"]',
    'header [aria-label="Your profile"]',
    '[role="banner"] [aria-label="你的個人檔案"]',
    '[role="banner"] [aria-label="Your profile"]',
    // 次選：帳戶菜單觸發點通常有 aria-haspopup="menu" 且含頭像圖
    'header [role="button"][aria-haspopup="menu"]:has(img)',
    '[role="banner"] [role="button"][aria-haspopup="menu"]:has(img)',
    'header [role="button"][aria-haspopup="menu"]',
    // 用真實姓名匹配 aria-label（FB 頭像常標註用戶名）
    ...nameCandidates,
    // 通用兜底（注意：勿用 a[href*="/me/"]，那會跳轉到個人檔案而非開菜單）
    'header [aria-label*="profile" i]',
    'header [aria-label*="個人檔案" i]',
    'header [role="button"]:has(img)',
    '[role="banner"] [role="button"]:has(img)',
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await isAccountMenuOpen(page)) return true;
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        if (!(await loc.count())) continue;
        if (!(await loc.isVisible().catch(() => false))) continue;
        await loc.click({ timeout: 4000 });
        await human.randomDelay(1200, 2200);
        if (await isAccountMenuOpen(page)) return true;
        // 若開出的是「通知」dialog 而非帳戶選單，關閉後換下一個選擇器重試
        if (await hasNotificationDialog(page)) { await dismissOverlays(page); }
      } catch { /* 試下一個選擇器 */ }
    }
    if (attempt === 0) { log('頭像菜單未展開，重試一次'); await dismissOverlays(page); }
  }
  return false;
}

/**
 * 真實 FB 路徑（與真人操作一致，來自示范錄制）：
 *   右上角頭像 → Settings & privacy → Language → 中文(台灣) 快速選擇器
 * FB 賬戶菜單的 Language 會直接開出語言快速選擇器（含 Traditional Chinese (Taiwan) 選項），
 * 點選即套用，比 /settings?tab=language 的 <select> 更穩定、不受頁面結構影響。
 */
async function setLangViaAccountMenu(page: any, log: (m: string) => void, accountId: string): Promise<boolean> {
  // 1) 打開右上角賬戶菜單（真人登入後習慣動作；多種頭像選擇器 + 用戶真實姓名兜底）
  const accountName = getAccount(accountId)?.name || '';
  if (!await openAccountMenu(page, log, accountName)) {
    log('無法展開賬戶菜單');
    return false;
  }

  // 2) 點擊 Settings & privacy（繁中台灣用「設定與隱私」；法/西/葡/德/意文兼容）
  const opened = await clickByTexts(page,
    ['Settings & privacy', '設定與隱私', '設定和隱私', '设置与隐私',
     'Paramètres et confidentialité', 'Configuración y privacidad', 'Configurações e privacidade',
     'Einstellungen und Datenschutz', 'Impostazioni e privacy'],
    '[role="menuitem"], [role="button"], button', 5000);
  if (!opened) { log('找不到 Settings & privacy，賬戶菜單路徑失敗'); return false; }
  await human.randomDelay(500, 1100);

  // 2) 點擊 Language（中/英/法/西/葡/德/意；僅 menu 內 role=menuitem/button，排除 footer 連結）
  if (!await clickByTexts(page,
      ['Language', '語言', '语言', 'Langue', 'Idioma', 'Lingua'],
      '[role="menuitem"], [role="button"], button', 5000)) {
    log('找不到 Language 選項');
    return false;
  }
  await human.randomDelay(600, 1200);

  // 3) 在快速語言選擇器點擊 中文(台灣) / 繁體中文（台灣） / Traditional Chinese (Taiwan)
  //    兼容全角/半角括號與多種 FB 寫法；完整英文字串在任意 UI 語言下都唯一，可避開 footer 連結
  if (!await clickByTexts(page,
      [
        'Traditional Chinese (Taiwan)',
        '繁體中文（台灣）', '繁體中文 (台灣)', '正體中文（台灣）', '中文(台灣)', '中文（台灣）',
        'Chinois traditionnel (Taïwan)', 'Chinois traditionnel (Taiwan)',
        'Chino tradicional (Taiwán)', 'Chino tradicional (Taiwan)',
        'Chinês tradicional (Taiwan)',
        'Traditionelles Chinesisch (Taiwan)',
        'Cinese tradizionale (Taiwan)',
        '繁体中文（台湾）', '繁體中文（台湾）',
        '번체중국어(대만)'
      ],
      '[role="option"], [role="menuitem"], [role="none"], a, button, div, span', 6000)) {
    log('選擇器中找不到 繁體中文(台灣)');
    return false;
  }
  await human.randomDelay(500, 1200);

  // 4) 部分 FB 版本需點 Save / Change / 確認（best-effort，找不到不報錯）
  await clickByTexts(page, ['Save Changes', 'Change Language', '儲存變更', '變更', '確認', 'Save'],
    'button', 3000).catch(() => {});
  await human.randomDelay(500, 1200);
  return true;
}

/** 讀取 FB 當前 UI 語言（可靠信號：<html lang="zh-TW">），判斷是否已為繁體中文(台灣) */
export async function isFbLangTw(page: any): Promise<boolean> {
  try {
    const lang = await page.evaluate(() => {
      const h = document.documentElement;
      return (h && h.getAttribute ? h.getAttribute('lang') : '') || '';
    });
    const l = (lang || '').toLowerCase().replace(/_/g, '-');
    // Facebook 繁體中文(台灣) 的 <html lang> 為 "zh-TW"；zh-hant 系列亦屬繁體
    if (l === 'zh-tw' || l.startsWith('zh-hant')) return true;
    return false;
  } catch {
    return false;
  }
}

/** 輪詢確認 <html lang> 是否已變為繁體中文(台灣) */
async function pollIsFbLangTw(page: any, maxMs = 10000, interval = 800): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await isFbLangTw(page)) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

/**
 * ⚠️ 已移除 setLangViaUrlParam（URL ?locale2=zh_TW 切換語言）。
 * 用戶明確禁止該方式：Facebook 語言只能經「帳號內設定頁」切換，網址後綴 locale 參數無效。
 * 語言切換嚴格走 setLangOnSettingsPage（設定頁兩步：展開語言行 → 點 中文(台灣) → 儲存）。
 */

/** 強健點擊：先 scrollIntoView 再點，解決選擇器選項在可滾動列表底部時不可見而點不到的問題 */
async function clickTextRobust(page: any, texts: string[], selectorBase: string, timeout = 5000): Promise<boolean> {
  for (const t of texts) {
    const loc = page.locator(selectorBase).filter({ hasText: t });
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      try {
        await el.scrollIntoViewIfNeeded({ timeout: 2500 });
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout });
          return true;
        }
      } catch { /* 試下一個可見匹配 */ }
    }
  }
  return false;
}

/** 繁體中文(台灣) 在各語言 FB UI 下的寫法（含簡體/英文/法/西/葡/德/意/日/韓） */
const TW_OPTION_TEXTS = [
  'Traditional Chinese (Taiwan)',
  '繁體中文（台灣）', '繁體中文 (台灣)', '正體中文（台灣）', '正體中文 (台灣)',
  '中文(台灣)', '中文（台灣）', '中文(台湾)', '中文（台湾）',
  'Chinois traditionnel (Taïwan)', 'Chinois traditionnel (Taiwan)',
  'Chino tradicional (Taiwán)', 'Chino tradicional (Taiwan)',
  'Chinês tradicional (Taiwan)',
  'Traditionelles Chinesisch (Taiwan)',
  'Cinese tradizionale (Taiwan)',
  '繁体中文（台湾）', '繁體中文（台湾）',
  '번체중국어(대만)',
];

/** 嚴格判斷某選項文字是否為「繁體中文(台灣)」：必須同時含「台灣」指示 + 「繁體」指示，
 *  以此排除 English / 簡體中文 / 其它語言，避免誤點第一個選項落到英文。 */
function isTwOption(txt: string): boolean {
  const t = (txt || '').toLowerCase();
  const hasTaiwan = /台灣|台湾|taiwan|taïwan|taiwán/.test(t);
  const hasTrad = /繁體|正體|traditional|tradicion|traditionell/.test(t);
  return hasTaiwan && hasTrad;
}

/** 在 FB 語言選擇器（dialog / menu / 滾動列表）內找到並點擊 繁體中文(台灣)。
 *  策略：先用搜尋框過濾（最穩定），再嘗試精確點擊選項行，最後兜底滾動。
 */
/** 在 FB 語言選擇器（dialog / menu / 滾動列表）內找到並點擊 繁體中文(台灣)。
 *  策略：① 等搜尋框出現 → 輸入 Taiwan 過濾 → 點第一個選項；② 兜底滾動點擊。
 */
async function clickTwOptionInPicker(page: any, log: (m: string) => void, shot?: (n: string) => Promise<void>): Promise<boolean> {
  const sel = '[role="option"], [role="menuitem"], [role="radio"], [role="listitem"], a, button, div, span, li';

  // 1) 優先：用搜尋框輸入 "Taiwan" 過濾
  try {
    const searchSels = [
      'input[type="search"]',
      'input[role="searchbox"]',
      'input[placeholder*="Search" i]',
      'input[placeholder*="Rechercher" i]',
      'input[placeholder*="Buscar" i]',
      'input[placeholder*="Procurar" i]',
      'input[placeholder*="Suchen" i]',
      'input[placeholder*="Cerca" i]',
      'input[placeholder*="検索" i]',
      'input[placeholder*="搜索" i]',
      'input[aria-label*="Search" i]',
      'input[aria-label*="Rechercher" i]',
      'input[aria-label*="Buscar" i]',
    ];
    let sb: any = null;
    for (const s of searchSels) {
      const loc = page.locator(s).first();
      if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) { sb = loc; break; }
    }
    if (sb) {
      await sb.scrollIntoViewIfNeeded({ timeout: 3000 });
      await sb.click({ timeout: 5000 });
      await human.randomDelay(300, 600);
      // 清空並輸入 Taiwan；fill 對大部分 React input 有效，若無效再逐字輸入
      try { await sb.fill(''); } catch {}
      await sb.fill('Taiwan');
      await human.randomDelay(1500, 2500);
      if (shot) await shot('lang-05b-search-taiwan.png');
      // 驗證搜尋框是否有值；若無值，改用逐字輸入
      const val = await sb.inputValue().catch(() => '');
      if (!val) {
        await sb.click({ timeout: 3000 });
        await page.keyboard.press('Control+a');
        await page.keyboard.type('Taiwan', { delay: 50 });
        await human.randomDelay(1500, 2500);
        if (shot) await shot('lang-05c-search-retry.png');
      }

      // 過濾後在可見選項中找「繁體中文(台灣)」：必須同時含台灣 + 繁體指示，嚴格排除 English。
      const opts = page.locator('[role="radio"], [role="option"], [role="listitem"], [role="menuitem"]').filter({ hasText: /Taiwan|台灣|台湾|繁體|正體|Traditional|tradicion|Traditionell/i });
      const optN = await opts.count().catch(() => 0);
      for (let i = 0; i < optN; i++) {
        const el = opts.nth(i);
        const txt = await el.textContent().catch(() => '');
        if (isTwOption(txt)) {
          await el.scrollIntoViewIfNeeded({ timeout: 3000 });
          await el.click({ timeout: 6000 });
          log('已點擊 繁體中文(台灣) 選項（搜尋框過濾 Taiwan）: ' + (txt || '').trim().slice(0, 40));
          return true;
        }
      }
      // 注意：絕不退回「點第一個選項」——那會誤點 English。沒命中就交給下方精確點擊兜底。
    }
  } catch (e: any) { log('[DIAG] 搜尋框策略失敗 ' + (e.message || e)); }

  // 2) 兜底 A：在瀏覽器內找到含 Taiwan 文字的選項行並直接點擊
  const tryClickOption = async (): Promise<boolean> => {
    return page.evaluate(() => {
      const isTw = (t: string) => {
        const s = (t || '').toLowerCase();
        return (/台灣|台湾|taiwan|taïwan|taiwán/.test(s)) && (/繁體|正體|traditional|tradicion|traditionell/.test(s));
      };
      const candidates = Array.from(document.querySelectorAll('[role="radio"], [role="option"], [role="listitem"], [role="menuitem"], div, span, a, button, li'));
      for (const row of candidates) {
        if (isTw((row.textContent || ''))) {
          try {
            (row as any).scrollIntoView({ block: 'center', behavior: 'instant' });
            (row as any).click();
            return true;
          } catch { /* continue */ }
        }
      }
      return false;
    });
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await tryClickOption()) {
      log('已點擊 繁體中文(台灣) 選項 (evaluate click attempt ' + attempt + ')');
      return true;
    }
    await page.evaluate(() => {
      const containers = document.querySelectorAll('[role="dialog"] [class*="scroll"], [role="dialog"], [role="menu"], [aria-modal="true"], [role="listbox"]');
      let scrolled = false;
      (containers as any).forEach((c: any) => { try { c.scrollTop += 800; scrolled = true; } catch {} });
      if (!scrolled) (window as any).scrollBy(0, 800);
    }).catch(() => {});
    await human.randomDelay(400, 800);
  }

  // 3) 兜底 B：Playwright locator 滾動 + 點擊
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await clickTextRobust(page, TW_OPTION_TEXTS, sel, 6000)) {
      log('已點擊 繁體中文(台灣) 選項 (locator attempt ' + attempt + ')');
      return true;
    }
    await page.evaluate(() => {
      const containers = document.querySelectorAll('[role="dialog"], [role="menu"], [aria-modal="true"], [role="listbox"], [class*="scroll"]');
      let scrolled = false;
      (containers as any).forEach((c: any) => { try { c.scrollTop += 600; scrolled = true; } catch {} });
      if (!scrolled) (window as any).scrollBy(0, 600);
    }).catch(() => {});
    await human.randomDelay(400, 800);
  }
  return false;
}

/** 保存/確認按鈕的多語標籤（繁中/簡中/英/法/西/葡/德/意） */
const SAVE_LABELS = ['Save Changes', 'Change Language', '儲存變更', '保存更改', '储存更改', '變更', '確認', '保存', '储存', 'Save', '完成', 'Done', 'Update', 'Enregistrer', 'Guardar', 'Salvar', 'Speichern', 'Salva', 'Continuer', 'Continue'];

/** 關閉 FB 常見遮罩/彈窗（cookie 同意、通知授權、安全提醒），避免覆蓋語言面板 */
async function dismissFbOverlays(page: any, log: (m: string) => void): Promise<void> {
  const labels = ['Accept', 'Accept All', 'Allow', 'Allow All', 'Got it', 'Not Now', 'Not now',
    '稍後', '稍后', '以後', '不，謝謝', '不用了', '关闭', '關閉', 'Close', 'Tout accepter', 'Accepter',
    'Autoriser', 'Plus tard', 'Aceptar', 'Rechazar', 'Permitir', 'Ahora no', 'Akzeptieren', 'Alle ablehnen',
    'Später', 'Nicht jetzt', 'Accetta', 'Rifiuta', 'Consenti', 'Più tardi', '允许', '允许全部', '稍后', '以后', '拒绝', '拒绝全部'];
  for (let i = 0; i < 4; i++) {
    const clicked = await clickTextRobust(page, labels, 'button, [role="button"], a, div').catch(() => false);
    if (clicked) { log('[DIAG] 關閉彈窗標籤命中'); await human.randomDelay(500, 1000); }
    else break;
  }
}

/**
 * 在 /settings?tab=language 頁將語言設為繁體中文(台灣)。
 * 設計原則（用戶/審查規格）：
 *   - 跳轉後先「校驗面板真的渲染」（URL 含 tab=language 且 DOM 含語言面板），否則重跳/觸發 tab 切換，不向下執行。
 *   - 操作前自動關閉 cookie/通知/安全彈窗遮罩。
 *   - 輸出詳細調試日誌 + 每步截圖到 G:/fbtest_shots/diag，禁止無日誌靜默跳過。
 *   - 目標元素必須 visible+enabled+在視口+無遮罩；不滿足持續等待，逾時拋明確異常。
 *   - 選中邏輯：優先原生 <select> 的 option[value=zh_TW]（並手動派發 change 事件）；否則自定義面板路徑。
 */
async function setLangOnSettingsPage(page: any, log: (m: string) => void): Promise<boolean> {
  const DIAG = 'G:/fbtest_shots/diag';
  try { fs.mkdirSync(DIAG, { recursive: true }); } catch {}
  const shot = async (n: string) => { try { await page.screenshot({ path: DIAG + '/' + n }); log('[DIAG] shot ' + n); } catch (e: any) { log('[DIAG] shot fail ' + (e.message || e)); } };
  const dumpDom = async (tag: string) => {
    const info = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select')).map((s: any) => ({
        id: s.id, name: s.name,
        opts: Array.from(s.options).slice(0, 60).map((o: any) => ({ v: o.value, t: (o.textContent || '').trim().slice(0, 30) })),
      }));
      const overlays = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],div[style*="position: fixed"]')).slice(0, 8)
        .map((o: any) => ({ tag: o.tagName, cls: (o.className || '').toString().slice(0, 50), txt: (o.textContent || '').trim().slice(0, 30) }));
      const langRows = Array.from(document.querySelectorAll('div,tr,li,section'))
        .filter((e: any) => /語言|语言|Language|Langue|Idioma/i.test(e.textContent || ''))
        .slice(0, 14).map((e: any) => (e.textContent || '').trim().slice(0, 50));
      return { url: location.href, selects, overlays, langRows, bodyText: (document.body?.innerText || '').slice(0, 500) };
    }).catch((e: any) => ({ err: e.message }));
    log('[DIAG][' + tag + '] ' + JSON.stringify(info).slice(0, 2400));
    try { fs.writeFileSync(DIAG + '/lang-dom-' + tag + '.json', JSON.stringify(info, null, 2)); } catch {}
    return info;
  };

  /** 結構化導出：語言相關元素 + 其最近可點擊 Edit/Change 按鈕，寫檔便於離線分析真實 FB DOM */
  const dumpStructure = async (tag: string) => {
    try {
      const data = await page.evaluate(() => {
        const kw = /語言|语言|Language|Langue|Idioma/i;
        const editKw = /edit|編輯|編輯|编辑|change|變更|变更|modifier|editar|modifica|bearbeiten|ändern/i;
        const langOwn: any[] = [];
        const all = Array.from(document.querySelectorAll('*'));
        for (const e of all) {
          const own = Array.from(e.childNodes).filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join('');
          if (kw.test(own)) {
            let cur: any = e, btn: any = null;
            for (let i = 0; i < 6 && cur; i++) {
              const c: any = cur.querySelector('button, [role="button"], a, [role="link"]');
              if (c) { btn = { tag: c.tagName, text: (c.textContent || '').trim().slice(0, 40), role: c.getAttribute('role'), aria: (c.getAttribute('aria-label') || '').slice(0, 50) }; break; }
              cur = cur.parentElement;
            }
            langOwn.push({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 40), own: own.trim().slice(0, 50), btn });
          }
        }
        const editBtns: any[] = [];
        const btns = Array.from(document.querySelectorAll('button, [role="button"], a, [role="link"]'));
        for (const b of btns) {
          const t = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
          if (!editKw.test(t)) continue;
          let cur: any = (b as any).parentElement, langCtx = false;
          for (let i = 0; i < 7 && cur; i++) { if (kw.test(cur.textContent || '')) { langCtx = true; break; } cur = cur.parentElement; }
          editBtns.push({ text: t.slice(0, 40), langCtx, aria: (b.getAttribute('aria-label') || '').slice(0, 50) });
        }
        return { url: location.href, lang: document.documentElement.lang, title: document.title, langOwn: langOwn.slice(0, 30), editBtns: editBtns.slice(0, 30) };
      }).catch((e: any) => ({ err: e.message }));
      fs.writeFileSync(DIAG + '/lang-structure-' + tag + '.json', JSON.stringify(data, null, 2));
      log('[DIAG] wrote structure ' + tag);
    } catch (e: any) { log('[DIAG] structure fail ' + e.message); }
  };

  await shot('lang-01-nav.png');
  await dumpDom('after-nav');
  await dumpStructure('after-nav');

  // 1) 校驗面板真的渲染：URL 含 tab=language 且 DOM 含語言面板節點
  const ready = await page.evaluate(() => {
    const urlOk = /tab=language/.test(location.href);
    const hasPanel = /語言|语言|Language|Langue|Idioma/i.test(document.body?.innerText || '') && document.querySelectorAll('div,tr,li,section').length > 5;
    return { urlOk, hasPanel };
  }).catch(() => ({ urlOk: false, hasPanel: false }));
  if (!ready.urlOk || !ready.hasPanel) {
    log('[DIAG] 語言面板未就緒 urlOk=' + ready.urlOk + ' hasPanel=' + ready.hasPanel + ' → 重新跳轉');
    await page.goto(`${FB_BASE}/settings?tab=language`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await human.randomDelay(1800, 2800);
    await shot('lang-01b-renav.png');
    await dumpDom('after-renav');
  }

  // 2) 關閉遮罩/彈窗（cookie/通知/安全提醒）
  await dismissFbOverlays(page, log);
  await shot('lang-02-after-overlay.png');

  // 3) 詳細日誌：select 是否存在、可見、可達、是否被遮罩
  const selInfo = await page.evaluate(() => {
    const s: any = document.querySelector('select');
    if (!s) return { hasSelect: false };
    const r = s.getBoundingClientRect();
    const cs = getComputedStyle(s);
    const optZh = Array.from(s.options).find((o: any) => /zh[-_]?TW|Tradition|繁體|正體|中文/i.test(o.value + ' ' + (o.textContent || '')));
    return {
      hasSelect: true,
      zhValue: optZh ? optZh.value : null,
      zhText: optZh ? (optZh.textContent || '').trim() : null,
      visible: r.width > 0 && r.height > 0,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      disabled: !!s.disabled,
      display: cs.display,
      overlay: !!document.querySelector('[role="dialog"],[aria-modal="true"]'),
    };
  }).catch((e: any) => ({ err: e.message }));
  log('[DIAG] selectInfo=' + JSON.stringify(selInfo));

  // 4) 選中邏輯（原生 select 優先，value=zh_TW，並手動派發 change）
  if (selInfo.hasSelect && selInfo.zhValue) {
    const sel = page.locator('select').first();
    await sel.scrollIntoViewIfNeeded({ timeout: 4000 }).catch((e: any) => log('[DIAG] scroll fail ' + e.message));
    const box = await sel.boundingBox().catch(() => null);
    if (!box) { log('【語言下拉組件未就緒，任務終止】select 不可見/不在視口'); return false; }
    await sel.selectOption({ value: selInfo.zhValue }).catch((e: any) => log('[DIAG] selectOption fail ' + e.message));
    await page.evaluate(() => { const s: any = document.querySelector('select'); if (s) s.dispatchEvent(new Event('change', { bubbles: true })); }).catch(() => {});
    await human.randomDelay(500, 1000);
    await shot('lang-03-select-chosen.png');
    await clickTextRobust(page, SAVE_LABELS, 'button');
    await human.randomDelay(900, 1600);
    await shot('lang-04-after-save.png');
    return true;
  }
  if (selInfo.hasSelect && !selInfo.zhValue) {
    log('【語言下拉組件未就緒】select 存在但找不到 zh_TW 選項，轉自定義面板路徑');
  }

  // 5) 自定義面板路徑（非 select）：精準點擊「語言行」的觸發元素（Edit 按鈕 或 可點擊語言行本身）
  //    ⚠️ 死區點擊修正：舊邏輯用 .first() 選到最大的祖先容器 div，點擊幾何中心命中空白死區，picker 從未展開。
  //    新邏輯：
  //      (a) 優先找 Edit/Change/編輯/變更… 按鈕（部分語系有）；
  //      (b) 再直接用 Playwright locator 選「含帳號語言文字的可點擊行」（a / [role="button"] / [role="link"] / [role="listitem"] / div[tabindex]），
  //          點擊第一個可見元素；
  //      (c) 若 locator 不可見，退回到 evaluate 內直接 element.click()，確保真的點到。
  let clickedTrigger = false;
  const langRowTexts = [
    'Langue du compte', 'Langue de l\'application',
    'Account Language', 'App Language',
    '帳號語言', '應用程式語言', '账户语言', '应用语言',
    'Idioma de la cuenta', 'Idioma de la aplicación',
    'Idioma do aplicativo', 'Idioma da conta',
    'Sprache des Kontos', 'Sprache der App',
    'Lingua dell\'account', 'Lingua dell\'app',
  ];
  const editLabels = ['Edit', '編輯', '编辑', 'Change', '變更', '变更', '修改', 'Modifier', 'Editar', 'Modifica', 'Bearbeiten', 'Ändern'];

  // (a) 優先點 Edit/Change 按鈕
  if (await clickTextRobust(page, editLabels, 'button, [role="button"], a, [role="link"]', 5000)) {
    log('[DIAG] 已點擊語言行的 Edit/Change 按鈕');
    clickedTrigger = true;
  }

  // (b) 點擊語言行本身（Playwright locator 真實點擊）
  if (!clickedTrigger) {
    const rowSel = 'a, [role="button"], [role="link"], [role="listitem"], div[tabindex], div[role="listitem"]'
    for (const rawTxt of langRowTexts) {
      const txt = rawTxt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const loc = page.locator(rowSel).filter({ hasText: new RegExp(txt, 'i') });
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        try {
          await el.scrollIntoViewIfNeeded({ timeout: 3000 });
          if (await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => false)) {
            await el.click({ timeout: 6000 });
            log('[DIAG] 已真實點擊語言行：' + txt + ' (idx=' + i + ')');
            clickedTrigger = true;
            break;
          }
        } catch (e: any) { log('[DIAG] 語言行點擊失敗 ' + txt + ' idx=' + i + ' ' + (e.message || e)); }
      }
      if (clickedTrigger) break;
    }
  }

  // (c) 兜底：在瀏覽器上下文中找到含語言文字的最小可點擊元素，直接 element.click()
  if (!clickedTrigger) {
    const clickedInPage = await page.evaluate(() => {
      const kw = /語言|语言|Language|Langue|Idioma/i;
      const clickSel = 'button,[role="button"],a,[role="link"],div[onclick],span[onclick],li[role="button"],div[tabindex],div[role="listitem"]';
      const all = Array.from(document.querySelectorAll('*'));
      for (const e of all) {
        const own = Array.from(e.childNodes).filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join('');
        if (!kw.test(own)) continue;
        let cur: any = e;
        for (let i = 0; i < 6 && cur; i++) {
          if (cur.matches && cur.matches(clickSel)) {
            try { cur.scrollIntoView({ block: 'center' }); cur.click(); return true; } catch { /* continue */ }
          }
          cur = cur.parentElement;
        }
      }
      return false;
    }).catch(() => false);
    if (clickedInPage) {
      log('[DIAG] 已在瀏覽器內直接點擊語言觸發元素');
      clickedTrigger = true;
    }
  }

  if (clickedTrigger) {
    await shot('lang-05-picker-open.png');
    await dumpDom('picker-open');
    await dumpStructure('picker-open');
    // 等待選擇器 / dialog / listbox 出現，或頁面文本出現繁中選項
    await page.waitForFunction(() =>
      !!document.querySelector('[role="dialog"],[role="listbox"],[role="menu"],[aria-modal="true"]') ||
      /Traditional Chinese|繁體中文|正體中文|中文\(台灣\)|中文（台灣）/i.test(document.body?.innerText || ''),
      { timeout: 9000 }
    ).catch(() => log('[DIAG] 等待選擇器出現逾時，繼續嘗試'));
    // 等選擇器內容完全渲染（搜尋框出現）
    await page.waitForSelector('input[type="search"], input[role="searchbox"], input[placeholder*="Search" i], input[placeholder*="Rechercher" i], input[placeholder*="Buscar" i], input[placeholder*="Procurar" i]', { timeout: 8000 }).catch(() => {});
    await human.randomDelay(800, 1500);
    if (await clickTwOptionInPicker(page, log, shot)) {
        await shot('lang-06-tw-chosen.png');
        await human.randomDelay(800, 1500);

        // FB 語言變更後常彈出「Refresh the page / 重新整理頁面」對話框：點 OK/Aceptar 讓頁面 reload
        const refreshClicked = await clickTextRobust(page, ['OK', 'Refresh', '重新整理', 'Actualiser', 'Actualizar', 'Recargar', 'Ricarica', 'Aktualisieren', 'Aktualizovať', 'Confirm', 'Aceptar', 'Aceptar cambios', 'Guardar cambios', 'Save Changes'], 'button, [role="button"]', 4000);
        if (refreshClicked) {
          log('[DIAG] 已點擊 Refresh 對話框 OK，等待頁面重新載入');
          await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
          await human.randomDelay(1500, 2500);
        } else {
          // 若沒有 refresh 對話框，嘗試點保存/完成按鈕（部分版本需要）
          if (await clickTextRobust(page, SAVE_LABELS, 'button, [role="button"]', 4000)) {
            log('[DIAG] 已點擊保存/完成按鈕');
          }
        }
        await shot('lang-07-after-save.png');
        await dumpStructure('after-save');
        return true;
      }
  } else {
    log('【語言觸發元素未找到，任務終止】');
  }

  // 6) 兜底
  if (await clickTwOptionInPicker(page, log, shot)) {
    await clickTextRobust(page, SAVE_LABELS, 'button');
    await human.randomDelay(900, 1600);
    await shot('lang-08-fallback-save.png');
    return true;
  }
  log('【語言設置頁所有路徑均失敗】未找到可點擊的繁體中文(台灣)選項');
  await shot('lang-99-failed.png');
  return false;
}

export async function skillSetLanguageTaiwan(ctx: SkillContext): Promise<SkillResult> {
  const { page, accountId } = ctx;
  const log = (m: string) => console.log(`[setLangTW ${accountId}] ${m}`);
  try {
    // 0) 冪等檢測：已在任意已登入頁時，直接讀 <html lang>；已是繁體中文(台灣) 即視為完成，不重複操作
    if (await isFbLangTw(page)) {
      log('檢測到 <html lang> 已為繁體中文(台灣)，無需變更');
      return { success: true, action: 'set_language_tw', data: { language: 'zh-TW', path: 'already_set' } };
    }
    log('當前非繁體中文(台灣)，準備設定');

    // 1) 真實 FB 頭像選單路徑（與真人操作一致：頭像 → Settings & privacy → Language → 選 繁體中文(台灣)）
    const okMenu = await setLangViaAccountMenu(page, log, accountId);
    if (okMenu && await pollIsFbLangTw(page)) {
      return { success: true, action: 'set_language_tw', data: { language: 'zh-TW', path: 'account_menu' } };
    }
    if (okMenu) {
      log('頭像選單流程已執行，但 lang 仍未刷新，繼續嘗試其他路徑');
    }

    // 2) fallback：直接走 /settings?tab=language（免頭像選單點擊；同時處理 <select> 與展開式「帳號語言」行）
    log('退回 /settings?tab=language 路徑');
    await page.goto(`${FB_BASE}/settings?tab=language`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await human.randomDelay(800, 1600);

    // 進入設定頁後再確認一次（避免誤判）
    if (await isFbLangTw(page)) {
      return { success: true, action: 'set_language_tw', data: { language: 'zh-TW', path: 'already_set_after_nav' } };
    }

    if (await setLangOnSettingsPage(page, log)) {
      if (await pollIsFbLangTw(page)) {
        return { success: true, action: 'set_language_tw', data: { language: 'zh-TW', path: 'settings_page' } };
      }
      log('設定頁已送出，但 lang 仍未刷新，reload 後重試一次');
    }

    // 3) 重試：reload 後再次走設定頁（FB 部分版本需 reload 才渲染選擇器；嚴禁用 URL locale 參數切語言）
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await human.randomDelay(1000, 1800);
    if (await setLangOnSettingsPage(page, log)) {
      if (await pollIsFbLangTw(page)) {
        return { success: true, action: 'set_language_tw', data: { language: 'zh-TW', path: 'settings_page_retry' } };
      }
    }

    return { success: false, action: 'set_language_tw', error: '所有路徑皆未能將語言設為 繁體中文(台灣)' };
  } catch (e: any) {
    return { success: false, action: 'set_language_tw', error: e?.message || String(e) };
  }
}

// ==================== 自動更換頭像 ====================
/**
 * 自動更換頭像（僅 warmup 階段、一生一次）。
 * 使用者把圖片放到 data/avatars/inbox，軟件取一張未用過的（跨帳號去重）上傳替換；
 * 用過的頭像標記到 used/，避免其它帳號重複使用。
 */
export async function skillSetAvatar(ctx: SkillContext, params: { imagePath?: string } = {}): Promise<SkillResult> {
  // 一生一次：本帳號已用過頭像則跳過
  if (accountHasAvatar(ctx.accountId)) {
    return { success: true, action: 'set_avatar', data: { skipped: 'already_set' } };
  }
  const img = params.imagePath || getNextAvailableAvatar();
  if (!img) {
    return { success: true, action: 'set_avatar', data: { skipped: 'no_avatar' } };
  }
  try {
    const base = resolveFbBase(ctx.accountId);
    await ctx.page.goto(base + '/me', { waitUntil: 'domcontentloaded' });
    await human.randomDelay(2500, 4000);

    // 點擊頭像區域開啟「更新頭像」選單（跨語言）
    const avatarTriggers = [
      'div[role="button"][aria-label*="個人檔案相片" i]',
      'div[role="button"][aria-label*="Profile picture" i]',
      'div[role="button"][aria-label*="頭像" i]',
      'a[href*="/profile/picture"]',
      'img[aria-label*="個人檔案相片" i]',
    ];
    let opened = false;
    for (const sel of avatarTriggers) {
      const el = ctx.page.locator(sel).first();
      if (await el.count() && await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 5000 }).catch(() => {});
        opened = true;
        break;
      }
    }
    if (!opened) return { success: false, action: 'set_avatar', error: '找不到頭像觸發按鈕' };
    await human.randomDelay(1500, 2500);

    // 作用域到頭像對話框內的檔案 input（避免誤選 banner 的 input）
    const fileInput = ctx.page.locator('div[role="dialog"] input[type="file"], [data-testid*="profile"] input[type="file"]').first();
    if (!await fileInput.count()) return { success: false, action: 'set_avatar', error: '找不到頭像上傳 input' };
    await fileInput.setInputFiles(img);
    await human.randomDelay(2500, 4000);

    // 儲存（Save / 儲存）
    const saveSels = [
      'div[role="dialog"] [role="button"]:has-text("儲存")',
      'div[role="dialog"] [role="button"]:has-text("Save")',
      'div[role="dialog"] button:has-text("儲存")',
    ];
    for (const s of saveSels) {
      const el = ctx.page.locator(s).first();
      if (await el.count() && await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 5000 }).catch(() => {});
        break;
      }
    }
    await human.randomDelay(2000, 3500);

    const r = markAvatarUsed(path.basename(img), ctx.accountId);
    return { success: r.ok, action: 'set_avatar', data: { usedImage: path.basename(img), ...r } };
  } catch (e: any) {
    return { success: false, action: 'set_avatar', error: e.message };
  }
}

// ==================== 技能索引 ====================

export const SKILL_MAP: Record<string, { fn: Function; description: string }> = {
  'login':           { fn: skillLogin,          description: '登录 Facebook 账号' },
  'browse_feed':     { fn: skillBrowseFeed,     description: '浏览首页动态，随机点赞' },
  'like_post':       { fn: skillLikePost,       description: '点赞帖子' },
  'share_post':      { fn: skillSharePost,      description: '分享帖子到主页/社团/好友' },
  'add_friends':     { fn: skillAddFriends,     description: '添加好友(搜索/推荐/社团成员/主页)' },
  'add_friends_from_group': { fn: skillAddFriends, description: '从社团成员中添加台湾本地好友' },
  'invite_to_group': { fn: skillInviteToGroup,  description: '邀请好友加入社团' },
  'invite_to_page':  { fn: skillInviteToPage,   description: '邀请好友点赞/访问自己的主页' },
  'join_groups':     { fn: skillJoinGroups,     description: '加入社团/群组' },
  'send_message':    { fn: skillSendMessage,    description: '发送私信' },
  'add_friend_by_name': { fn: skillAddFriendByName, description: '依 FB 名稱加好友（自家帳號互加）' },
  'send_message_to_name': { fn: skillSendMessageToName, description: '依 FB 名稱發私信（自家帳號互聊）' },
  'create_post':     { fn: skillCreatePost,     description: '发布帖子' },
  'get_friends':     { fn: skillGetFriends,     description: '获取好友列表' },
  'set_language_tw': { fn: skillSetLanguageTaiwan, description: '将 FB 界面语言设为繁体中文(台湾)' },
  'set_avatar':      { fn: skillSetAvatar,      description: '自动更换头像(仅warmup、一生一次、跨账号去重)' },
};
