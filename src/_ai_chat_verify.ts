/**
 * AI 對話發布任務驗證（真實 FB）：
 * 用自然語言指令 → parseIntent → runTask 驅動真實 Facebook
 */
import { runTask, ensureSession } from './core/engine/task-runner';
import { parseIntent } from './core/engine/intent-parser';
import { screenshot } from './core/browser/session-manager';
import * as fs from 'fs';

const UID = '61590344349141';
const MSGS = [
  '幫我同步狀態',
  '幫我加好友',
  '發一則貼文說：今天用 AI 對話指令測試自動發文 🚀',
  '加入台灣社團',
  '檢查風控',
];

const report: any = { account: UID, chats: [] };

async function run() {
  await ensureSession(UID);
  await new Promise(r => setTimeout(r, 4000));

  for (const msg of MSGS) {
    const intent = parseIntent(msg);
    console.log(`\n💬 用戶: "${msg}"`);
    console.log(`   → AI解析: ${intent.type} | 參數: ${JSON.stringify(intent.params)}`);
    console.log(`   → AI回覆: ${intent.replyToUser}`);
    try {
      const r = await runTask(UID, intent.type, intent.params);
      const ok = r && r.success !== false;
      console.log(`   ${ok ? '✅' : '⚠️'} ${JSON.stringify(r.result || r.error || '').slice(0, 160)}`);
      report.chats.push({ msg, intent: intent.type, ok, result: r.result || r.error });
    } catch (e: any) {
      console.log(`   ❌ ${e.message}`);
      report.chats.push({ msg, intent: intent.type, ok: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  await screenshot(UID, 'ai_chat_final');
  fs.writeFileSync('data/ai-chat-report.json', JSON.stringify(report, null, 2));
  console.log('\n=== AI 對話報告寫入 data/ai-chat-report.json ===');
  process.exit(0);
}
run().catch(e => { console.error('崩潰', e); process.exit(1); });
