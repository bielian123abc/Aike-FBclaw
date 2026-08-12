/**
 * OpenClaw Agent 监控 — 让内置 Agent 具备「被监控 + 主动监管」能力。
 *
 * 用户要求：软件中的 OpenClaw Agent 也要有监控功能。
 * 1. 健康探活：定期 ping LLM，记录可达性/最后调用/错误率。
 * 2. 自动监管循环：周期呼叫 agentSupervise() 生成运营监管报告并缓存，
 *    供全局监控面板即时读取（不必每次点按钮才生成）。
 * 3. 暴露 getAgentHealth() / getLatestSuperviseReport() 给监控子系统与 API。
 */
import { agentSupervise, persistSuperviseToKnowledge, SupervisorReport } from './supervisor';
import { callLLM } from '../provider/ai-provider';

export interface AgentHealth {
  llmReachable: boolean;
  lastCallAt: number | null;
  lastError: string | null;
  errorCount: number;
  callCount: number;
  lastSuperviseAt: number | null;
  autoSuperviseOn: boolean;
}

let health: AgentHealth = {
  llmReachable: false,
  lastCallAt: null,
  lastError: null,
  errorCount: 0,
  callCount: 0,
  lastSuperviseAt: null,
  autoSuperviseOn: false,
};

let latestReport: SupervisorReport | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function getAgentHealth(): AgentHealth {
  return { ...health };
}

export function getLatestSuperviseReport(): SupervisorReport | null {
  return latestReport;
}

/** 探活 LLM 可达性，更新健康统计 */
export async function pingLLM(): Promise<boolean> {
  health.callCount++;
  const t = Date.now();
  try {
    const out = await callLLM('你是健康探活助手，只用一個英文單字回覆 ok', 'ping', 16);
    health.llmReachable = !!out;
    health.lastCallAt = t;
    health.lastError = null;
    return !!out;
  } catch (e: any) {
    health.llmReachable = false;
    health.lastError = e?.message || String(e);
    health.errorCount++;
    return false;
  }
}

/** 立即生成一次监管报告并缓存 */
export async function runAgentSuperviseNow(): Promise<SupervisorReport | null> {
  try {
    const r = await agentSupervise();
    latestReport = r;
    health.lastSuperviseAt = Date.now();
    // 將監管結論沉澱到全局知識庫（OpenClaw 跨帳號學習 / 進化）
    await persistSuperviseToKnowledge(r).catch(() => {});
    return r;
  } catch (e: any) {
    health.lastError = e?.message || String(e);
    health.errorCount++;
    return null;
  }
}

/** 启动 Agent 自动监管循环（默认每 5 分钟一次） */
export function startAgentAutoSupervise(intervalMs = 5 * 60 * 1000): void {
  health.autoSuperviseOn = true;
  if (timer) return;
  // 立即跑一次，之后周期跑
  runAgentSuperviseNow().then(() => pingLLM());
  timer = setInterval(() => {
    runAgentSuperviseNow();
    pingLLM();
  }, intervalMs);
}

export function stopAgentAutoSupervise(): void {
  health.autoSuperviseOn = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
