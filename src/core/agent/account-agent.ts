/**
 * AccountAgent v2 — 自建浏览器引擎版
 * 不依赖 AdsPower，使用自建指纹浏览器引擎
 */

import { EventEmitter } from 'events';
import { BrowserProfileManager, getBrowserManager, BrowserInstance } from '../browser/profile-manager';
import { FacebookPageDetector, createPageDetector, PageState } from '../../detection/page-detector';
import { AccountMemory } from '../../memory/account-memory';
import type { Page, BrowserContext } from 'playwright-core';

// ==================== 类型 ====================

export type AccountStatus =
  | 'offline' | 'starting' | 'connecting' | 'analyzing' | 'running'
  | 'idle' | 'paused' | 'manual_control' | 'error' | 'stopping' | 'dead';

export interface AccountConfig {
  accountId: string;
  name: string;
  username?: string;
  password?: string;
  proxy?: string;              // socks5://user:pass@host:port
  proxyCountry?: string;
  tags?: string[];
  group?: string;
}

export interface AccountState {
  config: AccountConfig;
  status: AccountStatus;
  currentPage: string;
  currentPageType: string;
  isLoggedIn: boolean;
  lastActiveTime: number;
  totalActions: number;
  successRate: number;
  errors: string[];
  warnings: string[];
}

export interface AgentTask {
  id: string;
  type: TaskType;
  priority: number;
  params: Record<string, any>;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: any;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export type TaskType =
  | 'login' | 'check_status' | 'browse_home' | 'like_posts' | 'share_post'
  | 'add_friends' | 'invite_to_group' | 'join_groups' | 'send_message'
  | 'scan_feed' | 'navigate' | 'wait' | 'custom';

// ==================== Agent ====================

export class AccountAgent extends EventEmitter {
  public readonly config: AccountConfig;
  public readonly accountId: string;

  private browserMgr: BrowserProfileManager;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private detector: FacebookPageDetector | null = null;
  private memory: AccountMemory;

  private status: AccountStatus = 'offline';
  private taskQueue: AgentTask[] = [];
  private currentTask: AgentTask | null = null;
  private lastPageState: PageState | null = null;
  private stats = { totalActions: 0, successCount: 0, failCount: 0, lastActiveTime: 0 };

  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_MS = 5000;

  constructor(config: AccountConfig) {
    super();
    this.config = config;
    this.accountId = config.accountId;
    this.browserMgr = getBrowserManager();
    this.memory = new AccountMemory(config.accountId);
  }

  async start(): Promise<AccountState> {
    this.setStatus('starting');
    try {
      this.emit('log', 'info', `正在启动浏览器: ${this.config.name}`);

      // 启动自建浏览器
      const instance = await this.browserMgr.launchBrowser(this.accountId, {
        name: this.config.name,
        proxy: this.config.proxy,
      });

      this.setStatus('connecting');
      this.context = instance.context;
      this.page = instance.page;

      // 确保在 Facebook
      if (!this.page.url().includes('facebook.com')) {
        await this.page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
      }

      // 初始化页面检测器
      this.detector = createPageDetector(this.page);

      // 分析页面
      this.setStatus('analyzing');
      this.lastPageState = await this.detector.detectPageState();
      this.emit('page_state', this.lastPageState);

      this.startHeartbeat();
      this.stats.lastActiveTime = Date.now();

      this.setStatus('idle');
      this.emit('ready', this.getState());
      this.emit('log', 'info', `启动完成。页面: ${this.lastPageState.pageType}`);

      return this.getState();

    } catch (error: any) {
      this.setStatus('error');
      this.emit('error', error);
      this.emit('log', 'error', `启动失败: ${error.message}`);
      return this.getState();
    }
  }

  async stop(): Promise<void> {
    this.setStatus('stopping');
    this.stopHeartbeat();
    try {
      await this.browserMgr.closeBrowser(this.accountId);
    } catch {}
    this.context = null;
    this.page = null;
    this.detector = null;
    this.setStatus('offline');
  }

  async manualTakeover(): Promise<void> {
    this.setStatus('manual_control');
    this.stopHeartbeat();
    this.emit('log', 'info', '人工接管模式');
  }

  async resumeAuto(): Promise<void> {
    this.setStatus('analyzing');
    if (this.detector && this.page) {
      this.lastPageState = await this.detector.detectPageState();
      this.emit('page_state', this.lastPageState);
      await this.memory.recordManualActivity(this.lastPageState);
    }
    this.startHeartbeat();
    this.setStatus('idle');
    this.emit('log', 'info', '恢复自动控制');
  }

  // ==================== 任务 ====================

  addTask(task: Omit<AgentTask, 'createdAt'>): string {
    const fullTask: AgentTask = { ...task, createdAt: Date.now() };
    this.taskQueue.push(fullTask);
    this.taskQueue.sort((a, b) => a.priority - b.priority);
    this.emit('task_queued', fullTask);
    if (this.status === 'idle') this.processNextTask();
    return fullTask.id;
  }

  private async processNextTask(): Promise<void> {
    if (this.taskQueue.length === 0) { this.setStatus('idle'); return; }
    const tasks = this.taskQueue.filter(t => t.status === 'pending');
    if (tasks.length === 0) { this.setStatus('idle'); return; }

    this.currentTask = tasks[0];
    this.currentTask.status = 'running';
    this.currentTask.startedAt = Date.now();
    this.setStatus('running');
    this.emit('task_started', this.currentTask);

    try {
      const result = await this.executeTask(this.currentTask);
      this.currentTask.status = 'completed';
      this.currentTask.completedAt = Date.now();
      this.currentTask.result = result;
      this.stats.successCount++;
      this.emit('task_completed', this.currentTask);
      await this.memory.recordAction(this.currentTask.type, this.currentTask.params, result);
    } catch (error: any) {
      this.currentTask.status = 'failed';
      this.currentTask.error = error.message;
      this.stats.failCount++;
      this.emit('task_failed', this.currentTask);
      await this.memory.recordError(this.currentTask.type, error.message);
    }

    this.stats.totalActions++;
    this.stats.lastActiveTime = Date.now();
    this.currentTask = null;
    this.processNextTask();
  }

  private async executeTask(task: AgentTask): Promise<any> {
    if (task.type === 'check_status') return this.executeCheckStatus();
    if (task.type === 'navigate') return this.executeNavigate(task.params.url);
    if (task.type === 'browse_home') return this.executeBrowseHome(task.params);
    if (task.type === 'like_posts') return this.executeLikePosts(task.params);
    if (task.type === 'wait') return new Promise(r => setTimeout(r, task.params.duration || 30000));
    throw new Error(`未知任务: ${task.type}`);
  }

  private async executeCheckStatus(): Promise<PageState> {
    if (!this.detector) throw new Error('未就绪');
    this.lastPageState = await this.detector.detectPageState();
    this.emit('page_state', this.lastPageState);
    return this.lastPageState;
  }

  private async executeNavigate(url: string): Promise<void> {
    if (!this.page) throw new Error('未就绪');
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.randomDelay(2000, 4000);
    if (this.detector) this.lastPageState = await this.detector.detectPageState();
  }

  private async executeBrowseHome(params: any): Promise<any> {
    if (!this.page) throw new Error('未就绪');
    let likes = 0;
    for (let i = 0; i < (params.scrollCount || 5); i++) {
      await this.page.mouse.wheel(0, 300 + Math.random() * 500);
      await this.randomDelay(2000, 5000);
      if (Math.random() < (params.likeProbability || 0.25)) {
        try {
          const btn = await this.page.$('div[aria-label="Like"]:not([aria-pressed="true"])');
          if (btn) { await btn.click(); likes++; }
        } catch {}
      }
    }
    return { likes };
  }

  private async executeLikePosts(params: any): Promise<any> {
    if (!this.page) throw new Error('未就绪');
    let liked = 0;
    for (let i = 0; i < (params.count || 3); i++) {
      try {
        const btn = await this.page.$('div[aria-label="Like"]:not([aria-pressed="true"])');
        if (btn) { await btn.click(); liked++; }
      } catch {}
      await this.randomDelay(1500, 4000);
    }
    return { liked };
  }

  // ==================== 心跳 ====================

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      if (this.status === 'manual_control' || this.status === 'paused' || this.status === 'stopping') return;
      try {
        if (!this.detector) return;
        const quick = await this.detector.quickCheck();
        if (this.lastPageState && quick.pageType !== this.lastPageState.pageType) {
          this.lastPageState = await this.detector.detectPageState();
          this.emit('page_state', this.lastPageState);
          if (this.lastPageState.suggestedActions.some(a => a.priority === 'critical')) {
            this.emit('critical_alert', this.lastPageState.suggestedActions[0]);
          }
        }
        if (quick.hasPopup && this.lastPageState?.activePopup === 'none') {
          this.lastPageState = await this.detector.detectPageState();
          this.emit('popup_detected', this.lastPageState.activePopup);
        }
      } catch {}
    }, this.HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
  }

  // ==================== 查询 ====================

  getState(): AccountState {
    return {
      config: this.config, status: this.status,
      currentPage: this.lastPageState?.url || '',
      currentPageType: this.lastPageState?.pageType || 'unknown',
      isLoggedIn: this.lastPageState?.isLoggedIn || false,
      lastActiveTime: this.stats.lastActiveTime,
      totalActions: this.stats.totalActions,
      successRate: this.stats.totalActions > 0 ? this.stats.successCount / this.stats.totalActions : 0,
      errors: [], warnings: this.lastPageState?.warnings || [],
    };
  }

  getTaskQueue(): AgentTask[] { return [...this.taskQueue]; }
  getCurrentTask(): AgentTask | null { return this.currentTask; }
  getPage(): Page | null { return this.page; }
  getMemory(): AccountMemory { return this.memory; }

  private setStatus(s: AccountStatus): void {
    const old = this.status; this.status = s;
    this.emit('status_change', { oldStatus: old, newStatus: s });
  }

  private async randomDelay(min: number, max: number): Promise<void> {
    await new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
  }
}
