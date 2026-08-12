/**
 * SelfEvolution — AI 自进化策略管理
 * 
 * 记录每次操作的成功/失败、页面变化、处理策略，
 * AI 通过分析历史数据不断优化操作参数。
 * 
 * 当前阶段：策略自进化（调整参数、顺序、时机）
 * 未来阶段：代码自进化（AI 生成新的 Skill）
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../../config';

export interface EvolutionRecord {
  timestamp: number;
  actionType: string;
  accountId: string;
  pageTypeBefore: string;
  pageTypeAfter: string;
  params: Record<string, any>;
  result: 'success' | 'partial' | 'failed';
  error?: string;
  duration: number;          // 操作耗时 ms
  retryCount: number;
  strategy: string;          // 使用的策略
  notes: string;
}

export interface StrategyRule {
  id: string;
  condition: string;         // 触发条件描述
  action: string;            // 调整的动作
  originalValue: any;        // 原始值
  evolvedValue: any;         // 进化后的值
  confidence: number;        // 置信度 0-1
  successRateImpact: number; // 对成功率的影响
  createdAt: number;
  appliedAt?: number;
  reverted: boolean;
}

export class SelfEvolution {
  private recordsDir: string;
  private strategies: StrategyRule[] = [];
  private records: EvolutionRecord[] = [];

  constructor() {
    this.recordsDir = path.join(DATA_DIR, 'evolution');
    fs.mkdirSync(this.recordsDir, { recursive: true });
    this.load();
  }

  /**
   * 记录一次操作结果（供 AI 分析）
   */
  record(record: Omit<EvolutionRecord, 'timestamp'>): void {
    const full: EvolutionRecord = {
      ...record,
      timestamp: Date.now(),
    };
    this.records.push(full);
    this.save();
  }

  /**
   * 分析历史数据，发现规律
   */
  analyze(): {
    patterns: string[];
    recommendations: string[];
    risks: string[];
  } {
    const patterns: string[] = [];
    const recommendations: string[] = [];
    const risks: string[] = [];

    // 按操作类型分组分析
    const byType = this.groupBy(this.records, 'actionType');

    for (const [type, records] of Object.entries(byType)) {
      const total = records.length;
      const successes = records.filter(r => r.result === 'success').length;
      const rate = successes / total;

      // 成功率过低 → 风险警告
      if (total >= 10 && rate < 0.5) {
        risks.push(`${type}: 成功率仅 ${(rate * 100).toFixed(0)}% (${successes}/${total})`);
      }

      // 分析失败原因
      const failures = records.filter(r => r.result === 'failed');
      const errorGroups = this.groupBy(failures, 'error');
      for (const [error, errRecords] of Object.entries(errorGroups)) {
        if (errRecords.length >= 3) {
          patterns.push(`${type}: 常见失败 → "${error?.slice(0, 50)}" (${errRecords.length}次)`);
        }
      }

      // 分析成功策略
      const successRecords = records.filter(r => r.result === 'success');
      if (successRecords.length >= 5) {
        const avgDuration = successRecords.reduce((sum, r) => sum + r.duration, 0) / successRecords.length;
        recommendations.push(`${type}: 建议延迟设为 ${Math.round(avgDuration * 1.2)}ms`);
      }
    }

    // 分析时间模式
    const timeBasedPatterns = this.analyzeTimePatterns();
    patterns.push(...timeBasedPatterns);

    return { patterns, recommendations, risks };
  }

  /**
   * 生成自进化策略建议
   */
  generateStrategyUpdates(): StrategyRule[] {
    const updates: StrategyRule[] = [];
    const analysis = this.analyze();

    // 1. 频率限制检测 → 降低速率
    const rateLimitRecords = this.records.filter(r => 
      r.error?.includes('blocked') || r.error?.includes('limit')
    );
    if (rateLimitRecords.length >= 3) {
      updates.push({
        id: `rate_reduce_${Date.now()}`,
        condition: '检测到频率限制',
        action: '降低操作频率',
        originalValue: rateLimitRecords[0]?.params,
        evolvedValue: { delay_multiplier: 2.0 },
        confidence: 0.9,
        successRateImpact: 0.2,
        createdAt: Date.now(),
        reverted: false,
      });
    }

    // 2. 2FA频繁触发 → 标记账号需要人工
    const twoFARecords = this.records.filter(r =>
      r.result === 'failed' && r.pageTypeAfter === 'login_2fa'
    );
    if (twoFARecords.length >= 2) {
      updates.push({
        id: `2fa_flag_${Date.now()}`,
        condition: '多次触发2FA',
        action: '停止自动登录，标记需人工',
        originalValue: { auto_retry: true },
        evolvedValue: { auto_retry: false, flag: 'manual_2fa' },
        confidence: 0.95,
        successRateImpact: 0.1,
        createdAt: Date.now(),
        reverted: false,
      });
    }

    // 3. 特定时间段成功率高 → 优先调度
    const timeAnalysis = this.analyzeTimePatterns();
    if (timeAnalysis.length > 0) {
      updates.push({
        id: `time_opt_${Date.now()}`,
        condition: '发现高成功率时段',
        action: '优先在高成功率时段执行操作',
        originalValue: { schedule: 'anytime' },
        evolvedValue: { preferred_hours: timeAnalysis },
        confidence: 0.75,
        successRateImpact: 0.15,
        createdAt: Date.now(),
        reverted: false,
      });
    }

    // 保存策略
    this.strategies.push(...updates);
    this.saveStrategies();
    
    return updates;
  }

  /**
   * 应用进化策略
   */
  applyStrategy(strategyId: string): boolean {
    const strategy = this.strategies.find(s => s.id === strategyId);
    if (!strategy) return false;

    strategy.appliedAt = Date.now();
    this.saveStrategies();
    return true;
  }

  /**
   * 回滚策略
   */
  revertStrategy(strategyId: string): boolean {
    const strategy = this.strategies.find(s => s.id === strategyId);
    if (!strategy) return false;

    strategy.reverted = true;
    this.saveStrategies();
    return true;
  }

  private analyzeTimePatterns(): string[] {
    const patterns: string[] = [];
    const byHour: Record<number, { total: number; success: number }> = {};

    for (const record of this.records) {
      const hour = new Date(record.timestamp).getHours();
      if (!byHour[hour]) byHour[hour] = { total: 0, success: 0 };
      byHour[hour].total++;
      if (record.result === 'success') byHour[hour].success++;
    }

    for (const [hour, stats] of Object.entries(byHour)) {
      if (stats.total >= 5) {
        const rate = stats.success / stats.total;
        if (rate > 0.8) {
          patterns.push(`${hour}:00 — ${(rate * 100).toFixed(0)}% 成功率`);
        }
      }
    }

    return patterns;
  }

  private groupBy<T>(arr: T[], key: string): Record<string, T[]> {
    const result: Record<string, T[]> = {};
    for (const item of arr) {
      const val = (item as any)[key]?.toString() || 'unknown';
      if (!result[val]) result[val] = [];
      result[val].push(item);
    }
    return result;
  }

  private save(): void {
    try {
      const filePath = path.join(this.recordsDir, 'evolution.json');
      // 只保留最近 10000 条
      const dataToSave = this.records.slice(-10000);
      fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));
    } catch (_e: any) { /* ignore */ }
  }

  private saveStrategies(): void {
    try {
      const filePath = path.join(this.recordsDir, 'strategies.json');
      fs.writeFileSync(filePath, JSON.stringify(this.strategies, null, 2));
    } catch (_e: any) { /* ignore */ }
  }

  private load(): void {
    try {
      const recordsPath = path.join(this.recordsDir, 'evolution.json');
      if (fs.existsSync(recordsPath)) {
        this.records = JSON.parse(fs.readFileSync(recordsPath, 'utf-8'));
      }
      const stratPath = path.join(this.recordsDir, 'strategies.json');
      if (fs.existsSync(stratPath)) {
        this.strategies = JSON.parse(fs.readFileSync(stratPath, 'utf-8'));
      }
    } catch (_e: any) { /* ignore */ }
  }
}

// 全局单例
let evolutionInstance: SelfEvolution | null = null;

export function getEvolution(): SelfEvolution {
  if (!evolutionInstance) {
    evolutionInstance = new SelfEvolution();
  }
  return evolutionInstance;
}
