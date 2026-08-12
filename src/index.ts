/**
 * Aike-FBclaw 应用入口 v2 — 自建浏览器引擎版
 * 零外部依赖，不含 AdsPower
 */

import { BrowserProfileManager, getBrowserManager } from './core/browser/profile-manager';
import { FingerprintEngine, getFingerprintEngine } from './core/browser/fingerprint';
import { AgentOrchestrator } from './core/agent/orchestrator';
import { AccountAgent, AccountConfig } from './core/agent/account-agent';
import { OpenClawEngine } from './core/openclaw/engine';
import { autoImport, ImportResult } from './utils/account-importer';
import { AI_CONFIG } from './config';

export class FbClawApp {
  public browsers!: BrowserProfileManager;
  public fingerprints!: FingerprintEngine;
  public orchestrator!: AgentOrchestrator;
  public ai!: OpenClawEngine;
  public accounts: Map<string, AccountAgent> = new Map();

  constructor() {
    this.browsers = getBrowserManager();
    this.fingerprints = getFingerprintEngine();
  }

  async initialize(): Promise<{ success: boolean; message: string }> {
    try {
      // AI 引擎：唯一智能體 = OpenClaw（接入點配置來自 AI_CONFIG，其背後模型由 OpenClaw 服務配置）
      this.ai = new OpenClawEngine({
        apiKey: AI_CONFIG.openclawApiKey,
        model: AI_CONFIG.openclawModel,
        baseUrl: AI_CONFIG.openclawBaseUrl,
      });

      // 编排器
      this.orchestrator = new AgentOrchestrator(this.browsers);

      // 加载已有 Profile
      const profiles = this.browsers.getAllProfiles();
      console.log(`[FBclaw] 已加载 ${profiles.length} 个浏览器配置`);

      console.log('[FBclaw] 初始化完成 — 自建指纹引擎，零外部依赖');
      return { success: true, message: '初始化成功' };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  importAccounts(filePath: string, groupName?: string): ImportResult {
    return autoImport(filePath, groupName);
  }

  async registerAccount(config: AccountConfig): Promise<AccountAgent> {
    const agent = new AccountAgent(config);
    this.accounts.set(config.accountId, agent);
    if (this.orchestrator) {
      await this.orchestrator.registerAndStart(config);
    }
    return agent;
  }

  async registerAccounts(configs: AccountConfig[]): Promise<{ success: number; failed: number }> {
    let success = 0, failed = 0;
    for (const config of configs) {
      try { await this.registerAccount(config); success++; }
      catch { failed++; }
    }
    return { success, failed };
  }

  async shutdown(): Promise<void> {
    if (this.orchestrator) await this.orchestrator.stopAll();
    await this.browsers.closeAll();
    console.log('[FBclaw] 已关闭');
  }
}
