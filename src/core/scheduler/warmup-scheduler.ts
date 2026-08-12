/**
 * WarmupScheduler — 新號養號定時調度器（PRD 3.3 養號時間表）
 *
 * 按帳號階段（new / warmup / mature）在合理時段自動執行養號動作：
 *   - 每日登入 + 瀏覽動態（點讚）
 *   - 成長期起：加好友 / 加社團（受 SAFETY_LIMITS 限制）
 *   - 激活期起：發帖（生活分享，無廣告）
 * 全程遵循「真人作息」：僅在台灣活躍時段（7:00-23:00）執行，動作隨機化。
 *
 * 設計考量：調度器只負責「何時做、做多少」，具體動作全部委託 task-runner，
 * 因此與真實 FB 操作邏輯單一來源一致。
 */
import { limitForStage } from '../../config';
import { getAccount, listAccounts, updateAccount } from '../account-store';
import { runTask } from '../engine/task-runner';
import { isActiveHours, randomInt, randomDelay } from '../../utils/human-behavior';

let timer: NodeJS.Timeout | null = null;
let running = false;

/** 執行單一帳號的一輪養號（受階段頻率限制） */
export async function runWarmupCycle(accountId: string, opts?: { dryRun?: boolean }): Promise<any> {
  const acc = getAccount(accountId);
  if (!acc) return { skipped: 'no-account' };
  if (acc.mode !== 'real') return { skipped: 'not-real-mode' };
  if (acc.status === 'error') return { skipped: acc.status };

  const stage = acc.stage || 'new';
  const lim = limitForStage(stage);
  const out: any = { accountId, stage, actions: [] as string[] };

  const safe = async (label: string, fn: () => Promise<any>) => {
    try {
      const r = await fn();
      out.actions.push({ label, ok: !!(r && r.success), detail: r?.data || r });
    } catch (e: any) {
      out.actions.push({ label, ok: false, error: e.message });
    }
  };

  // 1) 同步狀態
  await safe('sync', () => runTask(accountId, 'sync', {}));

  // 2) 瀏覽動態 + 隨機點讚（每日必做）
  const likeProb = stage === 'new' ? 0.2 : 0.35;
  await safe('browse', () => runTask(accountId, 'browse_feed', {
    scrollCount: 4, likeProbability: likeProb, duration: stage === 'new' ? 120000 : 180000,
  }));

  if (opts?.dryRun) {
    out.dryRun = true;
    return out;
  }

  // 3) 加好友（觀察期不加，其餘受限制）
  if (stage !== 'new') {
    await randomDelay(60_000, 180_000); // 錯開，避免連續操作
    await safe('add_friends', () => runTask(accountId, 'add_friends', {
      mode: 'search', searchQuery: '台灣 美食', count: Math.min(lim.addFriend, 2),
    }));
  }

  // 4) 加社團（激活期起）
  if (stage === 'mature') {
    await randomDelay(60_000, 180_000);
    await safe('join_groups', () => runTask(accountId, 'join_groups', {
      keywords: ['台灣美食', '台灣旅遊', '台灣生活'], count: Math.min(lim.joinGroup, 1),
    }));
  }

  // 5) 發帖（激活期起，每天 ≤1 條生活分享）
  if (stage !== 'new') {
    // 簡單頻控：每帳號每天最多 1 帖（由調度間隔保證）
    await randomDelay(120_000, 300_000);
    await safe('create_post', () => runTask(accountId, 'create_post', {
      content: '週末去了一家藏在巷弄的咖啡廳，環境很舒服，適合放空一下午 ☕️',
    }));
  }

  updateAccount(accountId, { lastUsed: Date.now() });
  return out;
}

/** 調度主循環：遍歷所有真實帳號執行養號 */
async function tick() {
  if (running) return;
  if (!isActiveHours()) return; // 僅台灣活躍時段
  running = true;
  try {
    const accounts = listAccounts().filter(a => a.mode === 'real');
    for (const acc of accounts) {
      try {
        await runWarmupCycle(acc.accountId);
      } catch (e: any) {
        console.log(`[Warmup] 帳號 ${acc.accountId} 失敗: ${e.message}`);
      }
      await randomDelay(30_000, 90_000); // 帳號之間錯開
    }
  } finally {
    running = false;
  }
}

/** 啟動調度器（預設每 30 分鐘檢查一次） */
export function startWarmupScheduler(intervalMs = 30 * 60 * 1000) {
  if (timer) return;
  console.log('[Warmup] 養號調度器已啟動');
  timer = setInterval(tick, intervalMs);
  // 啟動後先跑一次（若在活躍時段）
  if (isActiveHours()) tick();
}

export function stopWarmupScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
  console.log('[Warmup] 養號調度器已停止');
}
