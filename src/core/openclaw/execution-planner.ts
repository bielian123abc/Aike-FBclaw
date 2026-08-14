/**
 * AI 智能执行规划器 —— 「AI 当大脑」的核心实现
 *
 * 用户硬性要求：AI 执行必须根据总记忆 + 单账号记忆智能分配，
 * 该做什么、要做什么、哪个账号没做，都由 AI 决定；不能是一段写死的脚本。
 *
 * 设计：
 * - getLoggedInAccountIds()：只针对「当前已登录（有活跃浏览器会话）」的账号做分配。
 * - planAgentExecution()：把各账号记忆 + 阶段交给 OpenClaw（真 AI），
 *   由模型差异化产出每个账号本轮的动作序列；软件只负责执行模型给的计划。
 * - 不配置模型 API 时，调用方必须拒绝执行（见 server.ts 的 smart-execute 路由）。
 */
import { listActiveSessions } from '../browser/session-manager';
import { getAccount } from '../account-store';
import { getMemory } from '../engine/task-runner';
import { summarizeContext } from './memory-service';
import { runOpenClawAgent } from './engine';

/** 当前已登录（有活跃浏览器会话）的账号 ID 列表（实时）。 */
export function getLoggedInAccountIds(): string[] {
  try {
    return listActiveSessions().map((s) => s.accountId);
  } catch {
    return [];
  }
}

export interface PlannedAccount {
  accountId: string;
  actions: string[];
}
export interface ExecutionPlan {
  reason: string;
  accounts: PlannedAccount[];
}

/** AI 可选择的合法动作（与 task-runner 的任务类型对齐）。 */
export const VALID_ACTIONS = [
  'sync',
  'browse_feed',
  'like_post',
  'add_friends',
  'join_groups',
  'greet_new_friends',
  'ai_chat_reply',
  'post_content',
];

/**
 * 让 OpenClaw（真正的 AI 大脑）基于各账号记忆与阶段，差异化规划本轮动作。
 * 这是「AI 当大脑」的关键：决策由模型产生，不再是写死的序列。
 */
export async function planAgentExecution(accountIds: string[]): Promise<ExecutionPlan> {
  if (!accountIds.length) return { reason: '没有可规划的账号。', accounts: [] };

  const accountsCtx = accountIds
    .map((id) => {
      const acc = getAccount(id);
      const mem = summarizeContext(id, 10);
      return [
        `账号 ${id}`,
        `  名称: ${acc?.name || '未知'}`,
        `  阶段: ${acc?.stage || 'new'}`,
        `  状态: ${acc?.status || 'unknown'}`,
        `  记忆摘要: ${mem || '（无）'}`,
      ].join('\n');
    })
    .join('\n\n');

  const prompt = `你是 Facebook 多账号运营的 AI 大脑。以下是当前已登录的账号及其记忆：

${accountsCtx}

请基于每个账号的记忆与阶段，智能规划本轮每个账号应执行的运营动作。
可选动作（仅从这些里选，可组合，排序要像真人）：
${VALID_ACTIONS.join(', ')}

要求：
- 不要给所有账号一样的动作；根据各自记忆/阶段差异化分配（例如新号少加好友、成熟号可多互动）。
- 每个账号 1~4 个动作即可，按合理先后顺序。

请以严格 JSON 回复（不要 markdown 代码块、不要多余文字）：
{"reason":"整体分配理由（一句话）","accounts":[{"accountId":"<id>","actions":["动作1","动作2"]}]}`;

  const reply = await runOpenClawAgent(prompt, 1500);
  if (!reply) {
    return { reason: 'OpenClaw 無回應（金鑰失效或網關離線）。', accounts: [] };
  }
  const m = reply.match(/\{[\s\S]*\}/);
  try {
    const obj = JSON.parse(m ? m[0] : reply);
    const accounts: PlannedAccount[] = Array.isArray(obj.accounts)
      ? obj.accounts
          .map((a: any) => ({
            accountId: String(a.accountId || ''),
            actions: Array.isArray(a.actions)
              ? a.actions.map((x: any) => String(x)).filter((x: string) => VALID_ACTIONS.includes(x))
              : [],
          }))
          .filter((a: PlannedAccount) => a.accountId && a.actions.length)
      : [];
    return { reason: obj.reason || '', accounts };
  } catch {
    return { reason: reply.slice(0, 600), accounts: [] };
  }
}
