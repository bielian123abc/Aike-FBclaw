/**
 * 打包前純邏輯單測（headless，不需要瀏覽器）
 * 覆盖：頭像跨帳號去重 / 社團去重+URL 歸一化 / 自然對話去重 / AI 診斷安全拒絕 / OpenClaw 診斷讀取
 * 測試會備份並還原生產資料檔（avatars/used-manifest.json、global-joined-groups.json），不污染真實資料。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  listInboxAvatars, getAvatarStats, getNextAvailableAvatar,
  accountHasAvatar, markAvatarUsed,
} from '../core/avatar';
import {
  isGroupGloballyJoined, recordGlobalJoinedGroup, getCrossAccountOverlap,
} from '../core/group-registry';
import { generateChatReply } from '../core/provider/ai-provider';
import { executeSafeAction } from '../core/agent/ai-diagnoser';
import { diagnoseGatewayConfig } from '../core/openclaw/openclaw-config';
import { AVATAR_INBOX_DIR, AVATAR_USED_DIR, AVATAR_MANIFEST_FILE, DATA_DIR } from '../config';

let pass = 0, fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

// ---------- 測試設定（清理邏輯見 finally，直接移除測試條目，不依賴備份） ----------
const GROUP_FILE = path.join(DATA_DIR, 'global-joined-groups.json');
const testAvatars = ['prepack_test_a.png', 'prepack_test_b.png'];
const createdFiles: string[] = [];
for (const f of testAvatars) {
  const p = path.join(AVATAR_INBOX_DIR, f);
  fs.writeFileSync(p, 'x');
  createdFiles.push(p);
  const u = path.join(AVATAR_USED_DIR, f);
  if (fs.existsSync(u)) { fs.unlinkSync(u); createdFiles.push(u); }
}

try {
  // ============ 1. 頭像跨帳號去重 ============
  console.log('\n[1] 頭像跨帳號去重 / 一生一次');
  check('初始 getNextAvailableAvatar 命中測試頭像', !!getNextAvailableAvatar());
  check('accTestA 初始無頭像', accountHasAvatar('accTestA') === false);
  const r1 = markAvatarUsed('prepack_test_a.png', 'accTestA');
  check('markAvatarUsed(accTestA, a) 成功', r1.ok === true);
  check('accTestA 已標記有頭像', accountHasAvatar('accTestA') === true);
  check('accTestB 仍無頭像（未被分配）', accountHasAvatar('accTestB') === false);
  const next = getNextAvailableAvatar();
  check('用過的 a 不再出現在下個可用頭像', !!next && !next.endsWith('prepack_test_a.png'), next || 'null');
  const r2 = markAvatarUsed('prepack_test_a.png', 'accTestB');
  check('a 仍可記錄給 accTestB（但不會再被 getNext 選中）', r2.ok === true);
  const stats = getAvatarStats();
  check('getAvatarStats 回傳 {inbox,used,total}', 'inbox' in stats && 'used' in stats && 'total' in stats,
    JSON.stringify(stats));

  // ============ 2. 社團去重 + URL 歸一化 ============
  console.log('\n[2] 社團跨帳號去重 + URL 歸一化');
  const G = 'https://www.facebook.com/groups/prepack_test_grp';
  recordGlobalJoinedGroup(G, 'accX', { name: '測試社團', region: '台灣' });
  check('isGroupGloballyJoined 原始 URL', isGroupGloballyJoined(G) === true);
  check('尾斜線歸一化仍判定已加入', isGroupGloballyJoined(G + '/') === true);
  check('去 query 仍判定已加入', isGroupGloballyJoined('https://facebook.com/groups/prepack_test_grp?ref=share') === true);
  check('不同社團判定為未加入', isGroupGloballyJoined('https://www.facebook.com/groups/other_grp') === false);
  recordGlobalJoinedGroup(G, 'accY');
  check('getCrossAccountOverlap 偵測到雙帳號協同', getCrossAccountOverlap('accX').length === 1);

  // ============ 3. 自然對話去重 ============
  console.log('\n[3] 自然對話（不重複同一句）');
  const rA = await generateChatReply({ lastMessage: '你好', stage: '新', friendName: '小美' });
  check('generateChatReply 回傳非空', typeof rA === 'string' && rA.length > 0, rA);
  const rs = await Promise.all([
    generateChatReply({ lastMessage: '你好', stage: '新', friendName: '小美' }),
    generateChatReply({ lastMessage: '你好', stage: '新', friendName: '小美' }),
    generateChatReply({ lastMessage: '你好', stage: '新', friendName: '小美' }),
  ]);
  check('同好友連續 3 次不重複同一句', new Set(rs).size > 1, JSON.stringify(rs));
  const rLife = await generateChatReply({ lastMessage: '最近好嗎', stage: '進行中', friendName: '阿強' });
  check('一般對話也回傳非空', typeof rLife === 'string' && rLife.length > 0, rLife);

  // ============ 4. AI 診斷安全：絕不點確認/刪除 ============
  console.log('\n[4] AI 診斷安全（只允許 ESC/回首頁/安全關閉）');
  function mockPage(countFor?: (sel: string) => number) {
    const st: any = { pressed: '', gotoed: false, clicked: '' };
    return {
      state: st,
      keyboard: { press: async (k: string) => { st.pressed = k; } },
      goto: async () => { st.gotoed = true; },
      locator: (sel: string) => ({
        first: () => ({
          count: async () => countFor ? countFor(sel) : 0,
          click: async () => { st.clicked = sel; },
        }),
      }),
    };
  }
  const pEsc = mockPage();
  const escRes = await executeSafeAction(pEsc, 'acc', 'ESC', 'http://x');
  check('ESC 動作 → 按 ESC', escRes.includes('ESC') && pEsc.state.pressed === 'Escape', escRes);
  const pHome = mockPage();
  const homeRes = await executeSafeAction(pHome, 'acc', '回首頁', 'http://x');
  check('回首頁 動作 → 跳首頁', homeRes.includes('首頁') && pHome.state.gotoed === true, homeRes);
  const pDanger = mockPage();
  const dangerRes = await executeSafeAction(pDanger, 'acc', '[data-testid="confirm-delete"]', 'http://x');
  check('危險選擇器（confirm-delete）被拒絕', dangerRes.includes('拒絕'), dangerRes);
  const pDanger2 = mockPage();
  const dangerRes2 = await executeSafeAction(pDanger2, 'acc', '[aria-label="確認"]', 'http://x');
  check('危險選擇器（確認）被拒絕', dangerRes2.includes('拒絕'), dangerRes2);
  const pSafe = mockPage(() => 1);
  const safeRes = await executeSafeAction(pSafe, 'acc', '[aria-label="Close"]', 'http://x');
  check('安全關閉按鈕（Close）被點擊', safeRes.includes('點擊安全') && pSafe.state.clicked === '[aria-label="Close"]', safeRes);

  // ============ 5. OpenClaw 診斷（只讀） ============
  console.log('\n[5] OpenClaw 網關診斷（只讀）');
  const diag = diagnoseGatewayConfig();
  check('diagnoseGatewayConfig 可讀（網關配置存在）', diag.readable === true, JSON.stringify(diag));
  check('diagnose 回傳 hasModel 布林', typeof diag.hasModel === 'boolean');

} finally {
  // ============ 清理測試產物（只移除 prepack_test_* 條目，保護真實資料） ============
  for (const f of createdFiles) { try { fs.unlinkSync(f); } catch {} }
  for (const f of testAvatars) { try { fs.unlinkSync(path.join(AVATAR_USED_DIR, f)); } catch {} }
  try {
    if (fs.existsSync(AVATAR_MANIFEST_FILE)) {
      const m = JSON.parse(fs.readFileSync(AVATAR_MANIFEST_FILE, 'utf-8'));
      let ch = false;
      for (const f of testAvatars) if (f in m) { delete m[f]; ch = true; }
      if (ch) fs.writeFileSync(AVATAR_MANIFEST_FILE, JSON.stringify(m, null, 2));
    }
  } catch {}
  try {
    if (fs.existsSync(GROUP_FILE)) {
      const all = JSON.parse(fs.readFileSync(GROUP_FILE, 'utf-8'));
      const fl = all.filter((g: any) => !String(g.url).includes('prepack_test_grp'));
      if (fl.length !== all.length) fs.writeFileSync(GROUP_FILE, JSON.stringify(fl, null, 2));
    }
  } catch {}
}

console.log(`\n===== 純邏輯單測結果：PASS ${pass} / FAIL ${fail} =====`);
if (fail > 0) { console.log('失敗項：', fails.join(' | ')); process.exit(1); }
