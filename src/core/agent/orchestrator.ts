/**
 * AgentOrchestrator — 多账号 AI 智能体编排管理器
 * 
 * 核心职责：
 * 1. 同时管理多个 AccountAgent 实例
 * 2. 智能任务分发与调度
 * 3. 资源管理（窗口数量、API 并发）
 * 4. 策略协调（跨账号联动）
 * 5. 全局监控与日志
 */

import { EventEmitter } from 'events';
import * as os from 'os';
import { AccountAgent, AccountConfig, AccountState, AgentTask } from './account-agent';
import { BrowserProfileManager } from '../browser/profile-manager';

// ==================== 编排配置 ====================

export interface OrchestratorConfig {
  maxConcurrentBrowsers: number;      // 最大同时运行的浏览器窗口数
  maxConcurrentTasks: number;          // 最大同时执行的任务数
  globalRateLimitPerMinute: number;    // 全局每分钟操作限制
  autoStartOnAdd: boolean;            // 添加账号后是否自动启动
  heartbeatIntervalMs: number;        // 心跳检测间隔
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxConcurrentBrowsers: 10,
  maxConcurrentTasks: 5,
  globalRateLimitPerMinute: 60,
  autoStartOnAdd: false,
  heartbeatIntervalMs: 5000,
};

// ==================== 编排器 ====================

export class AgentOrchestrator extends EventEmitter {
  private agents: Map<string, AccountAgent> = new Map();
  private browserMgr: BrowserProfileManager;
  private config: OrchestratorConfig;

  private runningBrowsers: number = 0;
  private runningTasks: number = 0;
  private lastMinuteActions: number[] = []; // 用于频率控制
  private globalTaskQueue: { agentId: string; task: AgentTask }[] = [];

  constructor(browserMgr: BrowserProfileManager, config?: Partial<OrchestratorConfig>) {
    super();
    this.browserMgr = browserMgr;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ==================== Agent 生命周期 ====================

  /**
   * 注册并启动一个账号 Agent
   */
  async registerAndStart(config: AccountConfig): Promise<AccountAgent> {
    const agent = new AccountAgent(config);
    
    // 监听 Agent 事件
    this.bindAgentEvents(agent);
    
    this.agents.set(config.accountId, agent);
    this.emit('agent_registered', agent.getState());

    if (this.config.autoStartOnAdd) {
      await this.tryStartAgent(agent);
    }

    return agent;
  }

  /**
   * 尝试启动一个 Agent（受资源限制）
   */
  private async tryStartAgent(agent: AccountAgent): Promise<boolean> {
    if (this.runningBrowsers >= this.config.maxConcurrentBrowsers) {
      this.emit('log', 'warn', `浏览器数量已达上限 (${this.config.maxConcurrentBrowsers})，Agent ${agent.accountId} 等待资源`);
      // 加入等待队列
      return false;
    }

    try {
      this.runningBrowsers++;
      await agent.start();
      this.emit('agent_started', agent.getState());
      return true;
    } catch (error: any) {
      this.runningBrowsers--;
      this.emit('log', 'error', `Agent ${agent.accountId} 启动失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 停止一个 Agent
   */
  async stopAgent(accountId: string): Promise<void> {
    const agent = this.agents.get(accountId);
    if (!agent) return;

    try {
      await agent.stop();
      this.runningBrowsers = Math.max(0, this.runningBrowsers - 1);
      this.emit('agent_stopped', accountId);
    } catch (error: any) {
      this.emit('log', 'error', `停止 Agent ${accountId} 失败: ${error.message}`);
    }
  }

  /**
   * 停止所有 Agent
   */
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.agents.keys()).map(id => this.stopAgent(id));
    await Promise.allSettled(stopPromises);
    this.emit('all_stopped');
  }

  // ==================== 事件绑定 ====================

  private bindAgentEvents(agent: AccountAgent): void {
    agent.on('status_change', (data) => {
      this.emit('agent_status', { accountId: agent.accountId, ...data });
    });

    agent.on('page_state', (state) => {
      this.emit('agent_page_state', { accountId: agent.accountId, state });
    });

    agent.on('task_started', (task) => {
      this.runningTasks++;
      this.emit('task_started', { accountId: agent.accountId, task });
    });

    agent.on('task_completed', (task) => {
      this.runningTasks = Math.max(0, this.runningTasks - 1);
      this.emit('task_completed', { accountId: agent.accountId, task });
      this.processGlobalQueue();
    });

    agent.on('task_failed', (task) => {
      this.runningTasks = Math.max(0, this.runningTasks - 1);
      this.emit('task_failed', { accountId: agent.accountId, task });
      this.processGlobalQueue();
    });

    agent.on('critical_alert', (action) => {
      this.emit('critical_alert', { accountId: agent.accountId, action });
    });

    agent.on('popup_detected', (popupType, details) => {
      this.emit('popup_detected', { accountId: agent.accountId, popupType, details });
    });

    agent.on('needs_login', (state) => {
      this.emit('needs_login', { accountId: agent.accountId, state });
    });

    agent.on('error', (error) => {
      this.emit('agent_error', { accountId: agent.accountId, error });
    });
  }

  // ==================== 任务分发 ====================

  /**
   * 向单个 Agent 添加任务
   */
  addTask(accountId: string, task: Omit<AgentTask, 'createdAt'>): boolean {
    const agent = this.agents.get(accountId);
    if (!agent) {
      this.emit('log', 'error', `Agent ${accountId} 不存在`);
      return false;
    }

    // 检查频率限制
    if (!this.checkRateLimit()) {
      // 加入全局队列
      this.globalTaskQueue.push({ agentId: accountId, task: { ...task, createdAt: Date.now(), status: 'pending' } });
      this.emit('task_queued_global', { agentId: accountId, task });
      return true;
    }

    this.recordAction();
    agent.addTask(task);
    return true;
  }

  /**
   * 向所有 Agent 广播任务（如：所有号都去分享某篇帖子）
   */
  broadcastTask(task: Omit<AgentTask, 'createdAt'>, filter?: (agent: AccountAgent) => boolean): { success: number; failed: number } {
    let success = 0;
    let failed = 0;

    for (const [accountId] of this.agents) {
      const agent = this.agents.get(accountId);
      if (!agent) continue;
      if (filter && !filter(agent)) continue;

      // 每个任务独立副本
      const agentTask = { ...task, params: { ...task.params } };
      if (this.addTask(accountId, agentTask)) {
        success++;
      } else {
        failed++;
      }
    }

    return { success, failed };
  }

  /**
   * 处理全局任务队列
   */
  private processGlobalQueue(): void {
    while (
      this.globalTaskQueue.length > 0 && 
      this.runningTasks < this.config.maxConcurrentTasks &&
      this.checkRateLimit()
    ) {
      const item = this.globalTaskQueue.shift()!;
      this.recordAction();
      this.addTask(item.agentId, item.task);
    }
  }

  // ==================== 频率控制 ====================

  private checkRateLimit(): boolean {
    const now = Date.now();
    // 清理超过1分钟的记录
    this.lastMinuteActions = this.lastMinuteActions.filter(t => now - t < 60000);
    return this.lastMinuteActions.length < this.config.globalRateLimitPerMinute;
  }

  private recordAction(): void {
    this.lastMinuteActions.push(Date.now());
  }

  // ==================== 批量操作 ====================

  /**
   * 所有账号互相加好友（分批执行，降低关联风险）
   */
  scheduleMutualFriending(accountIds: string[]): { totalPairs: number; estimatedDays: number } {
    const pairs: [string, string][] = [];
    
    for (let i = 0; i < accountIds.length; i++) {
      for (let j = i + 1; j < accountIds.length; j++) {
        pairs.push([accountIds[i], accountIds[j]]);
      }
    }

    // 分散到多天执行：每天每个账号最多加 5 个好友
    const maxPerAccountPerDay = 5;
    const estimatedDays = Math.ceil(pairs.length / (accountIds.length * maxPerAccountPerDay / 2));
    
    this.emit('log', 'info', `互加好友计划: ${pairs.length} 对好友关系, 预计 ${estimatedDays} 天完成`);

    // TODO: 将 pairs 拆分为每日批次，通过 cron 调度执行
    // 每对好友在不同的时间、通过不同的路径添加（搜索/推荐/共同好友）

    return { totalPairs: pairs.length, estimatedDays };
  }

  /**
   * 获取所有 Agent 状态
   */
  getAllStates(): AccountState[] {
    return Array.from(this.agents.values()).map(a => a.getState());
  }

  /**
   * 获取 Agent
   */
  getAgent(accountId: string): AccountAgent | undefined {
    return this.agents.get(accountId);
  }

  /**
   * 获取活跃 Agent 数量
   */
  getActiveCount(): number {
    let count = 0;
    for (const [, agent] of this.agents) {
      const state = agent.getState();
      if (state.status === 'running' || state.status === 'idle') {
        count++;
      }
    }
    return count;
  }

  /**
   * 获取全局统计
   */
  getGlobalStats() {
    const states = this.getAllStates();
    return {
      totalAgents: this.agents.size,
      activeAgents: states.filter(s => s.status !== 'offline' && s.status !== 'dead').length,
      idleAgents: states.filter(s => s.status === 'idle').length,
      runningAgents: states.filter(s => s.status === 'running').length,
      errorAgents: states.filter(s => s.status === 'error' || s.status === 'dead').length,
      runningBrowsers: this.runningBrowsers,
      runningTasks: this.runningTasks,
      queuedTasks: this.globalTaskQueue.length,
      actionsPerMinute: this.lastMinuteActions.length,
    };
  }

  /**
   * 自动计算系统能支持的最大窗口数
   */
  static calculateMaxBrowsers(): number {
    // 基于可用内存估算
    const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);
    // 每个 Chromium 实例约需 1GB，留 4GB 给系统
    const available = Math.max(1, totalMemoryGB - 4);
    // CPU 核心数约束
    const cpuCount = os.cpus().length;
    // 取较小值
    return Math.min(Math.floor(available), cpuCount * 2, 20);
  }
}
