/**
 * 被动接管監控器 — 定時巡檢活躍帳號，主動接管未讀聊天
 *
 * 用户要求：OpenClaw 要「被動觸發」——當一個帳號開始聊天（收到好友訊息），
 * AI 立即接管並參與。本模块啟動一個定時循環：對每個活躍中的瀏覽器會話，
 * 調用 ai_chat_reply 任務（該任務內部會偵測未讀 + 觸發一級介紹/接管回覆）。
 *
 * 為避免與手動任務衝突，對同一帳號用運行中集合做互斥。
 */
import { listActiveSessions } from '../browser/session-manager';
import { runTask } from '../engine/task-runner';
import { getAccount } from '../account-store';
import { emitAppEvent } from './event-bus';

let timer: NodeJS.Timeout | null = null;
const running = new Set<string>();

// 這些狀態的帳號不參與被動接管（避免對卡死/停用號硬跑，交由看門狗處理）
const SKIP_STATUSES = new Set(['checkpoint', 'dead', 'deleted', 'error', 'needs_login']);

export function startPassiveMonitor(intervalMs = 60 * 1000): void {
  if (timer) return;
  emitAppEvent({ type: 'log', level: 'info', message: '被動接管監控已啟動', ts: Date.now() });
  timer = setInterval(async () => {
    try {
      const active = listActiveSessions().map(s => s.accountId);
      for (const accountId of active) {
        const st = getAccount(accountId)?.status;
        if (st && SKIP_STATUSES.has(st)) continue; // 跳過不可運行帳號
        if (running.has(accountId)) continue; // 互斥，避免重疊執行
        running.add(accountId);
        try {
          await runTask(accountId, 'ai_chat_reply', {});
        } catch (e: any) {
          emitAppEvent({ type: 'task.failed', accountId, taskType: 'ai_chat_reply', error: e.message, ts: Date.now() });
        } finally {
          running.delete(accountId);
        }
      }
    } catch { /* 巡檢異常不中斷循環 */ }
  }, intervalMs);
}

export function stopPassiveMonitor(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export function isPassiveMonitorRunning(): boolean { return timer !== null; }
