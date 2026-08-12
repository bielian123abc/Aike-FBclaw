/**
 * 第二輪實機驗證：重點確認
 *  1) 內容絕不暴露「跨境電商/貨代/選品」等商業字眼（用戶最高要求）
 *  2) 指紋跨重啟穩定（loadOrCreate 落盤）
 *  3) 新增台灣社交擴張功能（add_friends_from_group / invite_to_group / invite_to_page / share_post / get_friends）已接進引擎且真實 FB 可調度
 *  4) 離開外部開發者：本地啟發式兜底可獨立生成安全內容
 */
import * as fs from 'fs';
import { runTask } from './core/engine/task-runner';
import { generateGreeting, generateChatReply, generatePostContent } from './core/provider/ai-provider';
import { getFingerprintEngine } from './core/browser/fingerprint';
import { getProjectBrief, FORBIDDEN_TERMS, violatesSafety } from './core/agent/openclaw-context';
import { parseIntent } from './core/engine/intent-parser';

const UID = '61590344349141';
const results: any[] = [];
function step(name: string, ok: boolean, extra?: any) {
  results.push({ name, ok, ...(extra !== undefined ? { extra } : {}) });
  console.log(`${ok ? '✅' : '❌'} ${name}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 200) : ''}`);
}

async function main() {
  // 1) 移交文檔存在
  const brief = getProjectBrief();
  step('PROJECT_BRIEF 載入', brief.includes('Aike-FBclaw') && brief.length > 500, { len: brief.length });

  // 2) 內容安全：問候/聊天/發帖 三類生成都不得含 FORBIDDEN_TERMS
  const g = await generateGreeting({ friendName: '小美', profileInfo: '喜歡看書' });
  const c = await generateChatReply({ friendName: '小美', lastMessage: '嗨你今天好嗎', stage: '新' });
  const p = await generatePostContent({ topic: '週末去爬山' });
  const allText = g + ' | ' + c + ' | ' + p;
  const hit = FORBIDDEN_TERMS.filter(t => allText.includes(t));
  step('內容無商業暴露(問候/聊天/發帖)', hit.length === 0, { greeting: g, chat: c, post: p, hit });

  // 3) 指紋穩定：同帳號連續取兩次應完全一致
  const f1 = getFingerprintEngine().loadOrCreate(UID);
  const f2 = getFingerprintEngine().loadOrCreate(UID);
  step('指紋跨重啟穩定', JSON.stringify(f1) === JSON.stringify(f2), { ua: f1.userAgent.slice(0, 30), tz: f1.timezone });
  // 確認落盤
  step('指紋已落盤 data/fingerprints', fs.existsSync(`G:/Aike-FBclaw/data/fingerprints/${UID.slice(-40)}.json`));

  // 4) 意圖解析涵蓋新功能
  const i1 = parseIntent('從社團成員加幾個台灣好友');
  const i2 = parseIntent('邀請好友進入我的社團');
  const i3 = parseIntent('邀請好友來按讚我的主頁');
  const i4 = parseIntent('把這則貼文分享出去 https://www.facebook.com/xxx/posts/1');
  step('意圖:從社團加好友', i1.type === 'add_friends_from_group', { type: i1.type });
  step('意圖:邀請進社團', i2.type === 'invite_to_group', { type: i2.type });
  step('意圖:邀請點讚主頁', i3.type === 'invite_to_page', { type: i3.type });
  step('意圖:分享貼文', i4.type === 'share_post', { type: i4.type });

  // 5) 真實 FB 實機調度新功能（安全項：get_friends 只讀；其餘給最小參數驗證不崩潰）
  const gf = await runTask(UID, 'get_friends', { maxScroll: 2, saveToMemory: false });
  step('真實FB: get_friends 調度', gf && typeof gf === 'object' && gf.type === 'get_friends', { success: gf?.success, count: gf?.result?.data?.count });

  // invite_to_group 無 groupId → 應優雅報因，不崩潰
  const itg = await runTask(UID, 'invite_to_group', { groupId: '', groupName: '測試', count: 1 });
  step('真實FB: invite_to_group 調度(無ID優雅)', itg && itg.type === 'invite_to_group', { ok: !!itg });

  // invite_to_page 無 OWN_PAGES → 應報因，不崩潰
  const itp = await runTask(UID, 'invite_to_page', { count: 1 });
  step('真實FB: invite_to_page 調度(無主頁優雅)', itp && itp.type === 'invite_to_page', { ok: !!itp });

  // share_post 無 postUrl → 應報因，不崩潰
  const sp = await runTask(UID, 'share_post', { postUrl: '', target: 'timeline' });
  step('真實FB: share_post 調度(無URL優雅)', sp && sp.type === 'share_post', { ok: !!sp });

  // add_friends_from_group 無 groupId → 應報因，不崩潰
  const afg = await runTask(UID, 'add_friends_from_group', { count: 1 });
  step('真實FB: add_friends_from_group 調度(無ID優雅)', afg && afg.type === 'add_friends_from_group', { ok: !!afg });

  const pass = results.filter(r => r.ok).length;
  console.log(`\n=== 驗證完成：${pass}/${results.length} 通過 ===`);
  fs.mkdirSync('G:/Aike-FBclaw/data', { recursive: true });
  fs.writeFileSync('G:/Aike-FBclaw/data/verify2-report.json', JSON.stringify({ pass, total: results.length, results }, null, 2));
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL', e); process.exit(1); });
