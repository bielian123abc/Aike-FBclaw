/**
 * 真实 FB 端到端功能测试（1 個號：61590344349141，feed 正常）
 * 跑核心功能，每個寫入操作只做 1 次（驗證鏈路，控制封號風險），全程截圖
 */
import { runTask, ensureSession } from './core/engine/task-runner';
import { screenshot } from './core/browser/session-manager';
import { parseIntent } from './core/engine/intent-parser';
import * as fs from 'fs';

const UID = '61590344349141';
const report: any = { account: UID, steps: [] };

async function step(name: string, fn: () => Promise<any>) {
  console.log(`\n▶ ${name}`);
  try {
    const r = await fn();
    const ok = r && (r.success !== false);
    console.log(`  ${ok ? '✅' : '⚠️'} ${JSON.stringify(r).slice(0, 200)}`);
    report.steps.push({ name, ok, r: r && r.success !== false ? 'ok' : r });
    return r;
  } catch (e: any) {
    console.log(`  ❌ ${e.message}`);
    report.steps.push({ name, ok: false, error: e.message });
    return null;
  }
}

async function run() {
  await ensureSession(UID);
  await new Promise(r => setTimeout(r, 4000));

  await step('同步狀態 sync', () => runTask(UID, 'sync', {}));
  await screenshot(UID, 'real_sync');
  await new Promise(r => setTimeout(r, 2000));

  await step('瀏覽動態 browse_feed', () => runTask(UID, 'browse_feed', { scrollCount: 2, likeProbability: 0, duration: 4000 }));
  await screenshot(UID, 'real_browse');
  await new Promise(r => setTimeout(r, 2000));

  await step('點讚 like_post', () => runTask(UID, 'like_post', {}));
  await screenshot(UID, 'real_like');
  await new Promise(r => setTimeout(r, 2000));

  await step('加好友(搜索) add_friends', () => runTask(UID, 'add_friends', { mode: 'search', searchQuery: '台灣 手作', count: 1 }));
  await screenshot(UID, 'real_addfriend');
  await new Promise(r => setTimeout(r, 2000));

  await step('問候新友 greet_new_friends', () => runTask(UID, 'greet_new_friends', {}));
  await screenshot(UID, 'real_greet');
  await new Promise(r => setTimeout(r, 2000));

  // AI 對話發布任務
  const intent = parseIntent('幫我發一則貼文說今天天氣不錯');
  console.log(`\n▶ AI對話解析: ${intent.type} ->`, JSON.stringify(intent.params));
  await step('AI發帖 create_post(经意图解析)', () => runTask(UID, intent.type, intent.params));
  await screenshot(UID, 'real_post');
  await new Promise(r => setTimeout(r, 2000));

  await step('加社團 join_groups', () => runTask(UID, 'join_groups', { count: 1, keywords: ['台灣'] }));
  await screenshot(UID, 'real_joingroup');
  await new Promise(r => setTimeout(r, 2000));

  await step('風控檢查 risk_check', () => runTask(UID, 'risk_check', {}));
  await screenshot(UID, 'real_risk');

  fs.writeFileSync('data/real-e2e-report.json', JSON.stringify(report, null, 2));
  console.log('\n=== 真實 FB 端到端報告已寫入 data/real-e2e-report.json ===');
  process.exit(0);
}
run().catch(e => { console.error('崩潰', e); process.exit(1); });
