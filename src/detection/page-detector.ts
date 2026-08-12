/**
 * Facebook 页面状态感知系统
 * 
 * 核心职责：在任何时刻告诉 AI Agent ——
 * 1. "你现在在什么页面？"（页面分类）
 * 2. "页面上出现了什么？"（弹窗/对话框/异常）
 * 3. "建议怎么处理？"（决策建议）
 * 
 * 这是整个系统的「眼睛和大脑」——没有准确的页面感知，AI就不可能做出正确决策
 */

import type { Page } from 'playwright-core';

// ==================== 页面类型枚举 ====================

export type FacebookPageType =
  | 'unknown'              // 未知页面
  | 'login'                // 登录页面
  | 'login_2fa'            // 2FA 验证页面
  | 'login_checkpoint'     // 安全检查点
  | 'checkpoint_photo'     // 照片/人头上传验证
  | 'checkpoint_identity'  // 身份验证
  | 'login_captcha'        // 验证码页面
  | 'login_save_device'    // 记住设备提示
  | 'home'                 // 首页 (News Feed)
  | 'profile_self'         // 自己的个人主页
  | 'profile_other'        // 他人的个人主页
  | 'profile_friends'      // 好友列表页
  | 'profile_photos'       // 照片页
  | 'group'                // 社团/小组页面
  | 'group_members'        // 社团成员列表
  | 'groups_discover'      // 发现社团
  | 'groups_joined'        // 已加入的社团列表
  | 'page'                 // 公共主页
  | 'post_detail'          // 帖子详情页
  | 'reels'                // Reels 视频页
  | 'watch'                // Watch 视频页
  | 'messenger'            // Messenger 对话
  | 'notifications'        // 通知页
  | 'settings'             // 设置页
  | 'marketplace'          // Marketplace
  | 'ads_manager'          // 广告管理
  | 'account_disabled'     // 账号被停用
  | 'account_locked'       // 账号被锁定
  | 'suspended';           // 账号被封禁

export type PopupType =
  | 'none'                 // 无弹窗
  | 'cookie_consent'       // Cookie 同意弹窗
  | 'notification_prompt'  // 通知权限请求
  | 'friend_request_sent'  // 好友请求已发送确认
  | 'post_shared'          // 分享成功确认
  | 'action_blocked'       // 操作被阻止
  | 'rate_limit_warning'   // 频率限制警告
  | 'login_alert'          // 新登录提醒
  | 'password_expired'     // 密码过期
  | 'suspicious_activity'  // 可疑活动警告
  | 'confirm_unfriend'     // 确认取消好友
  | 'confirm_leave_group'  // 确认退出群组
  | 'group_join_question'      // 入群问题
  | 'checkpoint_identity'      // 身份验证弹窗
  | 'checkpoint_photo'         // 照片验证弹窗
  | 'checkpoint_friends'       // 好友识别验证
  | 'messenger_pin_create'     // Messenger 建立端對端加密 PIN
  | 'messenger_pin_verify'     // Messenger 輸入既有 PIN
  | 'error_dialog'             // 错误对话框
  | 'custom_dialog';           // 其他自定义弹窗

// ==================== 页面状态结果 ====================

export interface PageState {
  /** 当前页面类型 */
  pageType: FacebookPageType;
  /** 页面 URL */
  url: string;
  /** 页面标题 */
  title: string;
  /** 页面上的弹窗类型 */
  activePopup: PopupType;
  /** 弹窗的详细信息 */
  popupDetails?: string;
  /** 是否已登录 */
  isLoggedIn: boolean;
  /** 当前账号用户名（如果已登录） */
  currentUser?: string;
  /** 页面关键文本内容摘要 */
  pageTextSummary: string;
  /** 关键可交互元素 */
  interactiveElements: InteractiveElement[];
  /** 检测到的异常/警告 */
  warnings: string[];
  /** AI 决策建议 */
  suggestedActions: SuggestedAction[];
  /** 原始 DOM 快照时间 */
  snapshotTime: number;
}

export interface InteractiveElement {
  type: 'button' | 'link' | 'input' | 'textarea' | 'select' | 'dialog';
  label: string;
  selector: string;
  location: string;        // 在页面中的位置描述
  isEnabled: boolean;
  isVisible: boolean;
}

export interface SuggestedAction {
  priority: 'critical' | 'high' | 'medium' | 'low';
  action: string;          // 建议执行的操作
  reason: string;          // 为什么建议这样做
  target?: string;         // 目标选择器或 URL
}

// ==================== 页面状态检测器 ====================

export class FacebookPageDetector {
  private page: PlaywrightPage;
  
  constructor(page: PlaywrightPage) {
    this.page = page;
  }

  /**
   * 全面检测当前页面状态
   * 这是 AI Agent 在做任何操作前必须调用的方法
   */
  async detectPageState(): Promise<PageState> {
    const startTime = Date.now();
    const url = this.page.url();
    const title = await this.page.title();
    
    // 并行检测
    const [
      pageType,
      activePopup,
      isLoggedIn,
      currentUser,
      interactiveElements,
      warnings,
      pageTextSummary,
    ] = await Promise.all([
      this.classifyPageType(url, title),
      this.detectPopup(),
      this.checkLoginStatus(),
      this.extractCurrentUser(),
      this.extractInteractiveElements(),
      this.detectWarnings(),
      this.extractPageTextSummary(),
    ]);

    const state: PageState = {
      pageType,
      url,
      title,
      activePopup,
      popupDetails: undefined,
      isLoggedIn,
      currentUser,
      pageTextSummary,
      interactiveElements,
      warnings,
      suggestedActions: [],
      snapshotTime: Date.now(),
    };

    // 生成决策建议
    state.suggestedActions = this.generateSuggestedActions(state);
    
    // 如果有弹窗，提取弹窗详情
    if (activePopup !== 'none') {
      state.popupDetails = await this.extractPopupDetails(activePopup);
    }

    return state;
  }

  /**
   * 快速页面类型判断（轻量版，用于轮询场景）
   */
  async quickCheck(): Promise<{
    pageType: FacebookPageType;
    hasPopup: boolean;
    isLoggedIn: boolean;
  }> {
    const url = this.page.url();
    const [pageType, isLoggedIn, hasPopup] = await Promise.all([
      this.classifyPageType(url, ''),
      this.checkLoginStatus(),
      this.hasAnyPopup(),
    ]);
    return { pageType, hasPopup, isLoggedIn };
  }

  /**
   * 核心：页面类型分类
   * 多重策略 fallback：URL → DOM结构 → 关键元素文本
   */
  private async classifyPageType(url: string, title: string): Promise<FacebookPageType> {
    const urlLower = url.toLowerCase();
    const fbUrl = this.parseFacebookUrl(url);
    const path = fbUrl.path || '';

    // === 策略 1: URL 模式匹配（最快） ===

    // 登录相关（兼容 mock FB /groups/ 路径優先於 group 判定）
    if (urlLower.includes('facebook.com/login') || urlLower.includes('facebook.com/?next') ||
        path === '/login' || path === '/login/') {
      return this.refineLoginPageType();
    }
    if (urlLower.includes('facebook.com/checkpoint') || path === '/checkpoint') {
      return 'login_checkpoint';
    }

    // 首页（兼容 mock FB：若根路徑出現登入表單，應判定為 login）
    if (path === '/' || path === '' || urlLower === 'https://www.facebook.com/') {
      const hasLoginForm = await this.hasElement('input[name="email"]') && await this.hasElement('input[name="pass"]');
      return hasLoginForm ? 'login' : 'home';
    }

    // Messenger
    if (urlLower.includes('facebook.com/messages') || urlLower.includes('messenger.com')) {
      return 'messenger';
    }

    // 通知
    if (urlLower.includes('facebook.com/notifications')) {
      return 'notifications';
    }

    // 设置
    if (urlLower.includes('facebook.com/settings')) {
      return 'settings';
    }

    // 好友列表
    if (urlLower.includes('/friends') || urlLower.includes('friends_mutual')) {
      return 'profile_friends';
    }

    // 照片
    if (urlLower.includes('/photos') || urlLower.includes('photo.php')) {
      return 'profile_photos';
    }

    // Reels
    if (urlLower.includes('/reel/') || urlLower.includes('/reels/') || urlLower.includes('watch/reel')) {
      return 'reels';
    }

    // Watch
    if (urlLower.includes('/watch') || urlLower.includes('/video')) {
      return 'watch';
    }

    // Marketplace
    if (urlLower.includes('marketplace')) {
      return 'marketplace';
    }

    // 广告管理
    if (urlLower.includes('adsmanager') || urlLower.includes('ads/manager')) {
      return 'ads_manager';
    }

    // 群组/社团
    if (urlLower.includes('/groups/')) {
      if (urlLower.includes('/members')) return 'group_members';
      if (urlLower.includes('/discover') || urlLower.includes('/search')) return 'groups_discover';
      if (urlLower.includes('/joined') || urlLower.includes('groups/feed')) return 'groups_joined';
      return 'group';
    }

    // 公共主页
    if (await this.isPageProfile()) {
      return 'page';
    }

    // 帖子详情
    if (urlLower.includes('/posts/') || urlLower.includes('/permalink/') || 
        urlLower.includes('story_fbid') || fbUrl.params?.get('story_fbid')) {
      return 'post_detail';
    }

    // 个人主页
    if (fbUrl.path && fbUrl.path !== '/' && !fbUrl.path.includes('/')) {
      const isSelf = await this.isSelfProfile();
      return isSelf ? 'profile_self' : 'profile_other';
    }

    // === 策略 2: DOM 元素检测（URL无法判断时） ===
    return this.classifyByDOM();
  }

  /**
   * 细化登录页面类型
   */
  private async refineLoginPageType(): Promise<FacebookPageType> {
    const checks = await Promise.all([
      this.hasElement('input[name="email"]'),
      this.hasElement('input[name="pass"]'),
      this.hasElement('input[name="approvals_code"]'),        // 2FA 验证码输入
      this.hasElement('div[data-testid="checkpoint"]'),       // 安全检查点
      this.hasElement('input[name="captcha_response"]'),       // CAPTCHA
      this.hasText('Enter login code'),
      this.hasText('We noticed unusual activity'),
      this.hasText('Confirm your identity'),
      this.hasText('Upload a photo of yourself'),
      this.hasText('Save your device'),
      this.hasText('Your account has been disabled'),
      this.hasText('Your account has been locked'),
    ]);

    const [hasEmail, hasPass, has2FA, hasCheckpoint, hasCaptcha,
      hasLoginCode, hasUnusual, hasConfirmId, hasUploadPhoto,
      hasSaveDevice, hasDisabled, hasLocked] = checks;

    if (hasDisabled) return 'account_disabled';
    if (hasLocked) return 'account_locked';
    if (hasLoginCode || has2FA) return 'login_2fa';
    if (hasUnusual || hasConfirmId) return 'login_checkpoint';
    if (hasUploadPhoto) return 'checkpoint_photo';
    if (hasCaptcha) return 'login_captcha';
    if (hasSaveDevice && !hasEmail) return 'login_save_device';
    if (hasEmail && hasPass) return 'login';
    
    return 'unknown';
  }

  /**
   * 策略 2: 通过 DOM 特征元素判断页面类型
   */
  private async classifyByDOM(): Promise<FacebookPageType> {
    // 并行检测多个关键元素
    const indicators = await Promise.all([
      // 首页特征
      this.hasElement('div[role="feed"]'),
      this.hasElement('[data-testid="feed_story"]'),
      this.hasText("What's on your mind"),
      // 个人主页特征
      this.hasElement('[data-pagelet="ProfileTabs"]'),
      this.hasElement('div[aria-label="Cover photo"]'),
      // 群组特征
      this.hasElement('div[data-pagelet="GroupInlineBanner"]'),
      // 账号状态
      this.hasText('Account disabled'),
      this.hasText('Account suspended'),
      this.hasText('You have been temporarily blocked'),
    ]);

    const [hasFeed, hasFeedStory, hasWhatsOnMind,
      hasProfileTabs, hasCoverPhoto,
      hasGroupBanner,
      hasDisabled, hasSuspended, hasBlocked] = indicators;

    if (hasDisabled) return 'account_disabled';
    if (hasSuspended) return 'suspended';
    if (hasBlocked) return 'account_locked';
    if (hasGroupBanner) return 'group';
    if (hasProfileTabs || hasCoverPhoto) return 'profile_other';
    if (hasFeed || hasFeedStory || hasWhatsOnMind) return 'home';

    return 'unknown';
  }

  /**
   * 检测当前弹窗类型
   */
  private async detectPopup(): Promise<PopupType> {
    // 按优先级检测各类弹窗
    const popupChecks: [PopupType, () => Promise<boolean>][] = [
      ['cookie_consent',        async () => await this.hasTextFragment('Allow all cookies') || await this.hasTextFragment('Accept all')],
      ['notification_prompt',   async () => await this.hasElement('div[aria-label*="notification" i]') && await this.hasElement('button[value="1"]')],
      ['action_blocked',        async () => await this.hasText('You can\'t perform this action') || await this.hasText('Action Blocked')],
      ['rate_limit_warning',    async () => await this.hasText('You\'re Temporarily Blocked') || await this.hasText('try again later')],
      ['suspicious_activity',   async () => await this.hasText('Suspicious Activity') || await this.hasText('unusual activity')],
      ['login_alert',           async () => await this.hasText('New login') || await this.hasText('new device')],
      ['checkpoint_identity',   async () => await this.hasText('Confirm your identity') && await this.hasElement('input[type="file"]')],
      ['checkpoint_photo',      async () => await this.hasText('Upload a photo') || await this.hasText('take a photo')],
      ['checkpoint_friends',    async () => await this.hasText('Identify friends') || await this.hasText('tag your friends')],
      // 跨語言 PIN 彈窗識別（法文/西班牙文/德文… 都適用，不窮舉關鍵字）
      ['messenger_pin_create',  async () => (await this.detectPinPopup()) === 'create'],
      ['messenger_pin_verify',  async () => (await this.detectPinPopup()) === 'verify'],
      ['group_join_question',   async () => await this.hasText('Answer the question') || await this.hasElement('textarea[aria-label*="answer" i]')],
      ['error_dialog',          async () => await this.hasElement('div[role="alert"]') || await this.hasElement('div[role="alertdialog"]')],
    ];

    for (const [popupType, check] of popupChecks) {
      if (await check()) return popupType;
    }

    // 检查是否有其他modal/dialog
    const hasGenericDialog = await this.hasElement('div[role="dialog"]') || 
                             await this.hasElement('div[data-testid="modal"]');
    if (hasGenericDialog) return 'custom_dialog';

    return 'none';
  }

  /**
   * 跨語言識別 Messenger 端對端加密 PIN 對話框。
   * 策略：對話框內出現密碼輸入框 + 文字含 PIN / code / 加密(chiffrement/cifrado/verschlüssel…)
   * 等跨語言強信號即判定；再用「建立/輸入」類詞區分 create / verify。
   * Facebook 各語系基本都保留 "PIN" 字樣，因此可覆蓋任意語言帳號。
   */
  private async detectPinPopup(): Promise<'create' | 'verify' | null> {
    try {
      const r = await this.page.evaluate(() => {
        const hasPwd = !!document.querySelector('input[type="password"]');
        if (!hasPwd) return null;
        const d = document.querySelector('div[role="dialog"]') ||
                  document.querySelector('div[role="alertdialog"]');
        const t = (d ? d.textContent : document.body?.innerText || '').toLowerCase();
        return { hasPwd, t } as any;
      });
      if (!r || !r.hasPwd) return null;
      // 跨語言強信號：PIN / code（法文 code PIN）/ chiffrement / cifrado / verschlüssel
      const pinSignal = /pin|code|chiffrement|cifrado|verschlüssel/.test(r.t);
      if (!pinSignal) return null;
      // 輸入既有 PIN（驗證）類詞
      if (/enter|saisir|輸入|confirm|vérifier|verify|unlock/.test(r.t)) return 'verify';
      // 其餘（含建立/設定/new 或無明確動詞）一律視為建立
      return 'create';
    } catch {
      return null;
    }
  }

  /**
   * 检查是否有任何弹窗
   */
  private async hasAnyPopup(): Promise<boolean> {
    return this.hasElement('div[role="dialog"]') || 
           this.hasElement('div[role="alertdialog"]') ||
           this.hasElement('[data-testid="modal"]');
  }

  /**
   * 检查登录状态
   */
  private async checkLoginStatus(): Promise<boolean> {
    // 多重策略确认是否登录
    const checks = await Promise.all([
      // Cookie 中存在 c_user (FB 登录用户ID)
      // 注意：頁面處於 about:blank（導航失敗/代理空響應）時，document.cookie
      // 在 opaque-origin 文件上會拋 SecurityError，必須在頁面側 try/catch 兜住，
      // 否則會讓整個 launch 接口 500。
      this.page.evaluate(() => {
        try { return document.cookie.includes('c_user='); } catch { return false; }
      }),
      // 页面上有用户菜单
      this.hasElement('div[aria-label="Account"]'),
      this.hasElement('div[aria-label="Your profile"]'),
      this.hasElement('[data-testid="user_nav"]'),
      // 首页的 "What's on your mind"
      this.hasText("What's on your mind"),
      // 检查URL是否在登录页面
      (async () => {
        const onLoginPage = await this.page.evaluate(() => {
          const url = window.location.href.toLowerCase();
          return url.includes('facebook.com/login') ||
                 url.includes('facebook.com/checkpoint');
        });
        return !onLoginPage;
      })(),
    ]);

    const [hasCookie, hasAccountMenu, hasProfileMenu, hasUserNav, hasWhatsOnMind, notOnLoginPage] = checks;

    // Cookie存在 + 不在登录页面 = 已登录
    if (hasCookie && notOnLoginPage) return true;
    // 有用户菜单 + 有首页发帖框 = 已登录
    if ((hasAccountMenu || hasProfileMenu || hasUserNav) && hasWhatsOnMind) return true;
    // Cookie 存在 + 有任何用户UI = 已登录
    if (hasCookie && (hasAccountMenu || hasProfileMenu || hasUserNav)) return true;

    return false;
  }

  /**
   * 提取当前用户名（Facebook 显示名称）
   * 優先從左側導航列的個人檔案連結、帳號選單、個人主頁 H1 抓取。
   */
  private async extractCurrentUser(): Promise<string | undefined> {
    try {
      return await this.page.evaluate(() => {
        const selectors = [
          // 左側導航列「個人檔案」連結文字（新版 FB 最常見）
          'div[role="navigation"] a[role="link"][href*="/profile.php?id="] span',
          'div[role="navigation"] a[role="link"][href^="/"] span',
          'a[aria-label="Profile"] span',
          'a[aria-label="你的個人檔案"] span',
          '[data-testid="user_nav"] span',
          'div[aria-label="Account"] span',
          'div[aria-label="你的帳號"] span',
          '[data-pagelet="LeftRail"] a[href*="facebook.com/"] span',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel as string);
          const text = el?.textContent?.trim();
          if (text && text.length > 1 && text.length < 40 && !/^(Facebook|Meta|Messenger|通知|Notifications|首頁|Home|朋友|Friends|搜尋|Search|Search results|搜尋結果)$/.test(text)) {
            return text;
          }
        }
        // 若在自己的個人主頁，抓 H1 標題
        const h1 = document.querySelector('h1');
        const h1Text = h1?.textContent?.trim();
        if (h1Text && h1Text.length < 40) return h1Text;
        return undefined;
      });
    } catch {
      return undefined;
    }
  }

  /**
   * 提取页面文本摘要
   */
  private async extractPageTextSummary(): Promise<string> {
    try {
      return await this.page.evaluate(() => {
        // 只提取关键文本，避免噪音
        const keyAreas = [
          document.querySelector('div[role="main"]'),
          document.querySelector('div[role="feed"]'),
          document.querySelector('div[role="dialog"]'),
          document.querySelector('[data-testid="post_message"]'),
        ];
        
        const texts: string[] = [];
        for (const area of keyAreas) {
          if (area) {
            const text = (area as HTMLElement).innerText?.slice(0, 500);
            if (text) texts.push(text);
          }
        }
        
        return texts.join('\n---\n').slice(0, 2000);
      });
    } catch {
      return 'Unable to extract page text';
    }
  }

  /**
   * 提取可交互元素
   */
  private async extractInteractiveElements(): Promise<InteractiveElement[]> {
    try {
      return await this.page.evaluate(() => {
        const elements: InteractiveElement[] = [];
        
        // 收集按钮
        document.querySelectorAll('div[role="button"]').forEach((el, i) => {
          if (i > 20) return; // 最多收集20个
          const label = el.getAttribute('aria-label') || el.textContent?.trim()?.slice(0, 30) || '';
          if (label && label.length < 50) {
            elements.push({
              type: 'button',
              label,
              selector: `div[role="button"][aria-label="${label}"]`,
              location: 'page',
              isEnabled: !el.hasAttribute('aria-disabled'),
              isVisible: (el as HTMLElement).offsetParent !== null,
            });
          }
        });

        // 收集链接
        document.querySelectorAll('a[aria-label]').forEach((el, i) => {
          if (i > 10) return;
          const label = el.getAttribute('aria-label') || '';
          if (label) {
            elements.push({
              type: 'link',
              label,
              selector: `a[aria-label="${label}"]`,
              location: 'page',
              isEnabled: true,
              isVisible: (el as HTMLElement).offsetParent !== null,
            });
          }
        });

        return elements;
      });
    } catch {
      return [];
    }
  }

  /**
   * 检测警告信息
   */
  private async detectWarnings(): Promise<string[]> {
    const warnings: string[] = [];
    
    const warningPatterns = [
      { pattern: 'You can\'t perform this action', msg: '操作被阻止：频率限制' },
      { pattern: 'try again later', msg: '操作被限制：需要冷却时间' },
      { pattern: 'unusual activity', msg: '账号活动异常：可能被标记' },
      { pattern: 'Your account has been', msg: '账号状态异常' },
      { pattern: 'We noticed', msg: '系统检测到异常行为' },
      { pattern: 'Please try again', msg: '操作失败：需要重试' },
      { pattern: 'Something went wrong', msg: '页面加载错误' },
      { pattern: 'This page isn\'t available', msg: '页面不可用：可能被限制' },
      { pattern: 'You are temporarily', msg: '账号暂时受限' },
    ];

    for (const { pattern, msg } of warningPatterns) {
      if (await this.hasText(pattern)) {
        warnings.push(msg);
      }
    }

    return warnings;
  }

  /**
   * 提取弹窗详情
   */
  private async extractPopupDetails(popupType: PopupType): Promise<string | undefined> {
    try {
      return await this.page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]') || 
                       document.querySelector('div[role="alertdialog"]');
        if (dialog) {
          return (dialog as HTMLElement).innerText?.slice(0, 500);
        }
        return undefined;
      });
    } catch {
      return undefined;
    }
  }

  /**
   * 生成 AI 决策建议
   */
  private generateSuggestedActions(state: PageState): SuggestedAction[] {
    const actions: SuggestedAction[] = [];
    
    // 根据页面类型 + 弹窗 + 警告 综合生成建议
    switch (state.pageType) {
      case 'login':
        actions.push({
          priority: 'critical',
          action: 'attempt_auto_login',
          reason: '当前在登录页面，可以尝试自动填写账号密码登录',
        });
        break;

      case 'login_2fa':
        actions.push({
          priority: 'critical',
          action: 'require_manual_2fa',
          reason: '需要输入2FA验证码，暂停自动化等待手动输入',
        });
        break;

      case 'login_checkpoint':
        actions.push({
          priority: 'critical',
          action: 'require_manual_checkpoint',
          reason: '触发FB安全检查点，必须人工处理',
        });
        break;

      case 'account_disabled':
      case 'account_locked':
      case 'suspended':
        actions.push({
          priority: 'critical',
          action: 'mark_account_dead',
          reason: `账号状态异常: ${state.pageType}，标记为不可用`,
        });
        break;

      case 'home':
        actions.push({
          priority: 'low',
          action: 'ready_for_operations',
          reason: '账号处于正常首页状态，可以执行社交操作',
        });
        break;

      case 'profile_other':
        actions.push({
          priority: 'medium',
          action: 'can_interact_with_user',
          reason: '在他人主页，可执行：加好友/发私信/查看好友列表/互动',
        });
        break;

      case 'group':
        actions.push({
          priority: 'medium',
          action: 'can_interact_with_group',
          reason: '在社团页面，可执行：邀请好友/发帖/查看成员',
        });
        break;

      case 'post_detail':
        actions.push({
          priority: 'medium',
          action: 'can_share_post',
          reason: '在帖子详情页，可执行：分享/点赞/评论',
        });
        break;
    }

    // 弹窗处理建议
    switch (state.activePopup) {
      case 'action_blocked':
        actions.push({
          priority: 'high',
          action: 'pause_account_operations',
          reason: '账号操作被阻止，需要暂停该账号所有活动并延长冷却时间',
        });
        break;

      case 'rate_limit_warning':
        actions.push({
          priority: 'high',
          action: 'cool_down_required',
          reason: '触发频率限制，该账号需要冷却至少30分钟',
        });
        break;

      case 'checkpoint_identity':
      case 'checkpoint_photo':
      case 'checkpoint_friends':
        actions.push({
          priority: 'critical',
          action: 'require_manual_verification',
          reason: `需要人工验证: ${state.activePopup}`,
        });
        break;

      case 'cookie_consent':
        actions.push({
          priority: 'medium',
          action: 'dismiss_cookie_dialog',
          reason: 'Cookie同意弹窗，点击接受后继续',
          target: 'button:has-text("Allow")',
        });
        break;

      case 'group_join_question':
        actions.push({
          priority: 'high',
          action: 'skip_group_or_manual',
          reason: '入群需要回答问题，AI暂无法自动处理，跳过或标记人工',
        });
        break;

      case 'messenger_pin_create':
        actions.push({
          priority: 'high',
          action: 'create_messenger_pin',
          reason: 'Messenger 要求建立端對端加密 PIN，skillSendMessage 會自動產生並儲存',
        });
        break;

      case 'messenger_pin_verify':
        actions.push({
          priority: 'high',
          action: 'enter_stored_messenger_pin',
          reason: 'Messenger 要求輸入既有 PIN，需使用帳號設定中儲存的 messengerPin',
        });
        break;
    }

    // 警告处理
    for (const warning of state.warnings) {
      actions.push({
        priority: 'high',
        action: 'log_and_pause',
        reason: warning,
      });
    }

    // 未知页面
    if (state.pageType === 'unknown') {
      actions.push({
        priority: 'high',
        action: 'navigate_to_home',
        reason: '当前处于未知页面，建议导航回首页重新评估',
        target: 'https://www.facebook.com/',
      });
    }

    // 按优先级排序
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return actions;
  }

  // ==================== 辅助方法 ====================

  /**
   * 检测页面上是否存在某个元素
   */
  async hasElement(selector: string): Promise<boolean> {
    try {
      return await this.page.evaluate((sel: string) => {
        return document.querySelector(sel) !== null;
      }, selector);
    } catch {
      return false;
    }
  }

  /**
   * 检测页面上是否包含某段文本
   */
  async hasText(text: string): Promise<boolean> {
    try {
      return await this.page.evaluate((t: string) => {
        return document.body?.innerText?.includes(t) ?? false;
      }, text);
    } catch {
      return false;
    }
  }

  /**
   * 宽松文本匹配（忽略大小写）
   */
  async hasTextFragment(text: string): Promise<boolean> {
    try {
      return await this.page.evaluate((t: string) => {
        const bodyText = document.body?.innerText?.toLowerCase() ?? '';
        return bodyText.includes(t.toLowerCase());
      }, text);
    } catch {
      return false;
    }
  }

  /**
   * 是否是自己的主页
   */
  private async isSelfProfile(): Promise<boolean> {
    try {
      return await this.page.evaluate(() => {
        // 检测是否有 "Edit Profile" 按钮（只有自己主页有）
        return document.querySelector('[aria-label="Edit profile"]') !== null ||
               document.querySelector('a[href*="/edit"]') !== null ||
               document.querySelector('[data-testid="edit_profile_button"]') !== null;
      });
    } catch {
      return false;
    }
  }

  /**
   * 是否是公共主页
   */
  private async isPageProfile(): Promise<boolean> {
    try {
      return await this.page.evaluate(() => {
        return document.querySelector('[data-testid="page_profile_header"]') !== null ||
               document.querySelector('div[data-pagelet="Page"]') !== null ||
               document.querySelector('a[href*="/follow"]') !== null ||
               document.querySelector('div[aria-label*="Page" i]') !== null;
      });
    } catch {
      return false;
    }
  }

  /**
   * 解析 Facebook URL
   */
  private parseFacebookUrl(url: string): { path: string; params: URLSearchParams | null } {
    try {
      const u = new URL(url);
      return { path: u.pathname, params: u.searchParams };
    } catch {
      return { path: '', params: null };
    }
  }
}

// 类型别名
type PlaywrightPage = Page;

/**
 * 创建页面检测器实例
 */
export function createPageDetector(page: PlaywrightPage): FacebookPageDetector {
  return new FacebookPageDetector(page);
}
