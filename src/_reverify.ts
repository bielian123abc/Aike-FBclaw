/**
 * 針對性復驗（修復後）：只跑上一輪失敗的 4 項，避免重複真實寫操作。
 */
import { runTask, ensureSession } from './core/engine/task-runner';
import { parseIntent } from './core/engine/intent-parser';
import * as fs from 'fs';

const UID = '61590344349141';
const report: any = { account: UID, steps: [] as any[] };

async function step(name: string, fn: () => Promise<any>) {
  console.log(`\n=== [${name}] ===`);
  const t0 = Date.now();
  try {
    const r = await fn();
    const ok = !!(r && (r.success ?? true));
    report.steps.push({ name, ok, ms: Date.now() - t0, data: r?.data ?? r });
    console.log(ok ? 'OK' : 'FAIL', JSON.stringify(r?.data ?? r)?.slice(0, 260));
    return r;
  } catch (e: any) {
    report.steps.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
    console.log('ERROR', e.message);
    return null;
  }
}

(async () => {
  await ensureSession(UID);

  // 1) add_friends（searchQuery，實際加 1 人）
  await step('add_friends 加好友(修正:searchQuery)', () => runTask(UID, 'add_friends', { mode: 'search', searchQuery: '台灣 美食', count: 1 }));

  // 2) join_groups（keyword，實際加 1 社團）
  await step('join_groups 加社團(修正:keyword)', () => runTask(UID, 'join_groups', { keywords: ['台灣美食', '台灣旅遊'], count: 1 }));

  // 3) greet 掃描（無新通過好友 → 應 success:true）
  await step('greet_new_friends 掃描(應成功)', () => runTask(UID, 'greet_new_friends', {}));

  // 4) reply 掃描（無未讀 → 應 success:true）
  await step('ai_chat_reply 掃描(應成功)', () => runTask(UID, 'ai_chat_reply', {}));

  // 5) AI 對話「加一個台灣旅遊社團」應解析為 join_groups（不執行，避免重複加社團）
  const intent = parseIntent('加一個台灣旅遊社團');
  report.steps.push({ name: 'AI對話解析:加一個台灣旅遊社團', ok: intent.type === 'join_groups', data: { type: intent.type, params: intent.params } });
  console.log(`AI對話解析 => ${intent.type}`, JSON.stringify(intent.params));

  const passed = report.steps.filter((s: any) => s.ok).length;
  report.summary = { total: report.steps.length, passed, failed: report.steps.length - passed };
  fs.writeFileSync('data/reverify-report.json', JSON.stringify(report, null, 2));
  console.log(`\n==== 復驗完成：${passed}/${report.steps.length} 通過 ====`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
