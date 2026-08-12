/**
 * 最終真實 FB 全功能驗證（Task #45）
 * 帳號: 61590344349141（健康號）
 * 策略：寫操作每類僅 1 次、內容良性；問候/回覆用自動掃描模式（無新好友/未讀則不發消息）。
 */
import { runTask, ensureSession, getMemory, saveContent, listContent } from './core/engine/task-runner';
import { screenshot } from './core/browser/session-manager';
import { analyzeAndEvolve } from './core/evolution/self-evolution';
import { runWarmupCycle } from './core/scheduler/warmup-scheduler';
import { parseIntent, parseIntentWithLLM } from './core/engine/intent-parser';
import * as fs from 'fs';

const UID = '61590344349141';
const report: any = { account: UID, startedAt: new Date().toISOString(), steps: [] as any[] };

async function step(name: string, fn: () => Promise<any>) {
  console.log(`\n=== [${name}] ===`);
  const t0 = Date.now();
  try {
    const r = await fn();
    const ok = !!(r && (r.success ?? true));
    report.steps.push({ name, ok, ms: Date.now() - t0, data: r?.data ?? r });
    console.log(ok ? 'OK' : 'FAIL', JSON.stringify(r?.data ?? r)?.slice(0, 300));
    return r;
  } catch (e: any) {
    report.steps.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
    console.log('ERROR', e.message);
    return null;
  }
}

(async () => {
  await ensureSession(UID);

  // --- 讀取/基礎 ---
  await step('sync 同步', () => runTask(UID, 'sync', {}));
  await step('browse_feed 瀏覽+點讚', () => runTask(UID, 'browse_feed', { scrollCount: 3, likeProbability: 0.25, duration: 60000 }));
  await screenshot(UID, 'v_browse');

  // --- 寫操作（各 1 次，良性） ---
  await step('add_friends 加好友(搜台灣)', () => runTask(UID, 'add_friends', { mode: 'search', searchQuery: '台灣 美食', count: 1 }));
  await step('create_post 發帖', () => runTask(UID, 'create_post', { content: '週末去了一家藏在巷弄的咖啡廳，環境很舒服，適合放空一下午 ☕️' }));
  await screenshot(UID, 'v_post');
  await step('join_groups 加社團(搜台灣)', () => runTask(UID, 'join_groups', { keywords: ['台灣美食', '台灣旅遊'], count: 1 }));
  await step('risk_check 風控', () => runTask(UID, 'risk_check', {}));

  // --- 聊天（真實 FB 自動掃描模式，無新好友/未讀則不發消息） ---
  await step('greet_new_friends 問候(掃描通知)', () => runTask(UID, 'greet_new_friends', {}));
  await step('ai_chat_reply 回覆(掃描訊息)', () => runTask(UID, 'ai_chat_reply', {}));
  // 證明發消息路徑：對 FB 官方公開主頁發 1 則良性問候（非騷擾個人）
  await step('greet_new_friends 發消息路徑驗證(公開主頁)', () => runTask(UID, 'greet_new_friends', { friends: ['facebook'], greetDelayMs: 1000 }));

  // --- 自動讚自己主頁（OWN_PAGES 未配置 → 預期回傳 reason，驗證代碼路徑） ---
  await step('auto_like_own_page（未配置 OWN_PAGES）', () => runTask(UID, 'auto_like_own_page', {}));

  // --- 內容庫 + 多號分發 ---
  const cid = 'verify_' + Date.now();
  await step('內容庫 saveContent', async () => { saveContent(cid, { title: '驗證素材', text: '週末去陽明山走走，天氣涼涼的，很適合散步 🍃', tags: ['生活', '日常'] }); return { ok: true, id: cid }; });
  await step('內容庫 listContent', () => Promise.resolve(listContent()));
  await step('distribute_content 多號分發(1號)', () => runTask(UID, 'distribute_content', { contentId: cid, accountIds: [UID], staggerSeconds: 5 }));

  // --- 養號排程（dryRun 僅同步+瀏覽）+ 自進化 ---
  await step('warmup dryRun 養號一輪', () => runWarmupCycle(UID, { dryRun: true }));
  await step('self-evolution 自進化調參', () => Promise.resolve(analyzeAndEvolve(UID)));

  // --- AI 對話發布任務（自然語言 → 意圖 → 執行） ---
  for (const msg of ['幫我加兩個台灣好友', '發一則關於台灣美食的貼文', '加一個台灣旅遊社團', '同步一下狀態', '檢查風控']) {
    await step('AI對話: ' + msg, async () => {
      let intent = await parseIntentWithLLM(msg);
      if (!intent) intent = parseIntent(msg);
      if (intent.type === 'unknown') return { success: false, reply: intent.replyToUser };
      const r = await runTask(UID, intent.type, intent.params);
      return { success: r.success, intent: intent.type, data: r.data };
    });
  }

  // 彙總
  const passed = report.steps.filter((s: any) => s.ok).length;
  report.summary = { total: report.steps.length, passed, failed: report.steps.length - passed };
  report.endedAt = new Date().toISOString();
  fs.writeFileSync('data/verify-all-report.json', JSON.stringify(report, null, 2));
  console.log(`\n==== 驗證完成：${passed}/${report.steps.length} 通過 ====`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
