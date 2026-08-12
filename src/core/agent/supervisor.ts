/**
 * OpenClaw Supervisor — 软件内置 Agent 的「运营监管 + 进化」模块。
 *
 * 职责（用户要求：脱离外部开发者后，OpenClaw 负责进化完善 + 主要软件运营监管）：
 * 1. 监管：定期汇总运行日志、账号风控等级、自进化参数，產出監管報告。
 * 2. 进化：基於成功率數據，調整 delayMultiplier / frequencyFactor / riskLevel。
 * 3. 安全守门：任何建議不得違反 PROJECT_BRIEF 安全紅線。
 *
 * 完全依賴内置能力（logs / evolution / accounts），即使無 LLM 也能產出基礎報告。
 */
import { getRecentLogs } from '../logger';
import { getEvolutionParams } from '../evolution/self-evolution';
import { listAccounts } from '../account-store';
import { callLLM } from '../provider/ai-provider';
import { buildAgentSystemPrompt } from './openclaw-context';
import { appendGlobalKnowledge } from '../openclaw/memory-service';

export interface SupervisorReport {
  generatedAt: number;
  accounts: { accountId: string; status: string; riskLevel: string }[];
  recentErrors: string[];
  evolution: Record<string, any>;
  llmSummary: string;
  suggestions: string[];
}

export async function agentSupervise(): Promise<SupervisorReport> {
  const logs = getRecentLogs(200);
  const logStrings = logs.map(l => (typeof l === 'string' ? l : l.message || ''));
  const accounts = listAccounts();
  const accView = accounts.map(a => ({
    accountId: a.accountId,
    status: a.status || 'idle',
    riskLevel: getEvolutionParams(a.accountId).riskLevel,
  }));

  // 提取最近錯誤/警告
  const recentErrors = logStrings
    .filter(l => /error|fail|封|checkpoint|受限|blocked/i.test(l))
    .slice(-15);

  // 彙整自進化參數
  const evolution: Record<string, any> = {};
  for (const a of accounts) {
    evolution[a.accountId] = getEvolutionParams(a.accountId);
  }

  // 讓 OpenClaw 產出監管摘要 + 建議（失敗則用本地基礎結論）
  let llmSummary = '';
  const suggestions: string[] = [];
  try {
    const role = buildAgentSystemPrompt('你是 Aike-FBclaw 的运营监管 Agent。根據提供的日誌與賬號狀態，產出：1)一句話運營健康總結 2)不超過3條具體建議（如降頻、暫停某號、調整養號時段）。嚴守安全紅線，不得建議任何違規或暴露商業目的的操作。');
    const user = `賬號狀態：${JSON.stringify(accView)}\n近期錯誤/警告：${recentErrors.join('\n')}\n自進化參數：${JSON.stringify(evolution)}\n請用繁體中文回覆，格式：總結：...\n建議：1)... 2)... 3)...`;
    const out = await callLLM(role, user, 200);
    if (out) {
      llmSummary = out.slice(0, 600);
      const m = out.match(/建議[:：]([\s\S]+)/);
      if (m) {
        m[1].split(/\n|；|;/).forEach(s => {
          const t = s.replace(/^\d+[.、)\s]*/, '').trim();
          if (t) suggestions.push(t);
        });
      }
    }
  } catch { /* ignore */ }

  // 本地兜底建議：若發現高風控或頻繁錯誤，給出降頻建議
  const highRisk = accView.filter(a => (a.riskLevel as string) === 'high' || (a.riskLevel as string) === 'critical');
  if (highRisk.length) suggestions.push(`賬號 ${highRisk.map(a => a.accountId).join('、')} 風控偏高，建議立即降頻 50% 並暫停主動加好友/邀請`);
  if (recentErrors.length >= 5) suggestions.push('近期錯誤頻繁，建議全面暫停主動任務，等人工檢查');
  if (suggestions.length === 0) suggestions.push('運營狀態正常，維持當前養號節奏即可');

  return {
    generatedAt: Date.now(),
    accounts: accView,
    recentErrors,
    evolution,
    llmSummary: llmSummary || '（本地模式）運營監管報告已生成。',
    suggestions: suggestions.slice(0, 5),
  };
}

/** 把監管結論沉澱到全局知識庫（OpenClaw 跨帳號學習 / 進化） */
export async function persistSuperviseToKnowledge(report: SupervisorReport): Promise<void> {
  try {
    const highRisk = report.accounts.filter(a => (a.riskLevel as string) === 'high' || (a.riskLevel as string) === 'critical').length;
    const section = [
      `### 運營監管結論`,
      `- 帳號數：${report.accounts.length}，高風控：${highRisk}`,
      `- 摘要：${(report.llmSummary || '').slice(0, 200)}`,
      `- 建議：${report.suggestions.join('；')}`,
    ].join('\n');
    appendGlobalKnowledge(section);
  } catch {}
}
