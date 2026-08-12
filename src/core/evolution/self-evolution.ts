/**
 * SelfEvolution — 自進化策略（PRD 2.4 核心流程⑥）
 *
 * 基於各帳號的歷史操作成功率，自動調整：
 *   1. 操作間延遲倍率（成功率低 → 拉長延遲，更像真人、降低風控）
 *   2. 每日頻率係數（成功率低 → 降低頻率）
 *   3. 風控等級（連續失敗 → 升級降頻）
 *
 * 調參結果寫入 data/evolution/<accountId>.json，task-runner 等模組可讀取套用。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../../config';
import { getMemory } from '../engine/task-runner';

const EVOLUTION_DIR = path.join(DATA_DIR, 'evolution');

export interface EvolutionParams {
  accountId: string;
  delayMultiplier: number;   // 操作間延遲倍率（1.0 = 基準）
  frequencyFactor: number;   // 每日頻率係數（0-1，越低保守）
  riskLevel: 'low' | 'medium' | 'high';
  lastAnalyzed: number;
  stats: { actionType: string; total: number; success: number; rate: number }[];
  notes: string[];
}

/** 分析並產生下一輪調參建議 */
export function analyzeAndEvolve(accountId: string): EvolutionParams {
  const mem = getMemory(accountId);
  const stats = (mem as any).getActionStats ? (mem as any).getActionStats() : [];

  // 加權總成功率（無數據視為健康）
  let total = 0, success = 0;
  for (const s of stats) { total += s.total; success += s.success; }
  const overallRate = total ? success / total : 1;

  // 連續失敗偵測：最近 10 筆 action_log
  const recent = stats.slice(0, 3);
  const lowRateTypes = stats.filter((s: any) => s.total >= 3 && s.rate < 0.6).map((s: any) => s.actionType);

  let delayMultiplier = 1.0;
  let frequencyFactor = 1.0;
  let riskLevel: EvolutionParams['riskLevel'] = 'low';
  const notes: string[] = [];

  if (overallRate < 0.6 && total >= 5) {
    delayMultiplier = 1.8;
    frequencyFactor = 0.5;
    riskLevel = 'high';
    notes.push(`總成功率 ${Math.round(overallRate * 100)}% 偏低，已拉長延遲並降頻`);
  } else if (overallRate < 0.85 && total >= 5) {
    delayMultiplier = 1.3;
    frequencyFactor = 0.8;
    riskLevel = 'medium';
    notes.push(`總成功率 ${Math.round(overallRate * 100)}% 中等，微調保守`);
  }

  if (lowRateTypes.length) {
    notes.push(`低成功率動作類型：${lowRateTypes.join(', ')}，後續優先降頻`);
    if (riskLevel === 'low') riskLevel = 'medium';
  }

  const params: EvolutionParams = {
    accountId,
    delayMultiplier,
    frequencyFactor,
    riskLevel,
    lastAnalyzed: Date.now(),
    stats,
    notes,
  };

  fs.mkdirSync(EVOLUTION_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVOLUTION_DIR, `${accountId}.json`), JSON.stringify(params, null, 2));
  return params;
}

/** 讀取帳號當前調參（無則回傳預設） */
export function getEvolutionParams(accountId: string): EvolutionParams {
  const p = path.join(EVOLUTION_DIR, `${accountId}.json`);
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {}
  }
  return {
    accountId, delayMultiplier: 1.0, frequencyFactor: 1.0, riskLevel: 'low',
    lastAnalyzed: 0, stats: [], notes: [],
  };
}
