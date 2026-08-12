/**
 * 冒煙測試（使用新的 SessionManager）：
 * 驗證 1) 瀏覽器能在本機被驅動 2) Mock FB 路由正常 3) 技能層選擇器能命中
 */
import { startMockFB } from './mock-facebook/server';
import { MOCK_FB_PORT, FB_BASE } from './config';
import { launchSession, closeSession } from './core/browser/session-manager';
import { skillLogin, skillBrowseFeed } from './skills/fb-core-skills';
import { createPageDetector } from './detection/page-detector';

const ACCOUNT = 'smoke@mock.local';

async function main() {
  console.log('[Smoke] 啟動 Mock FB on', FB_BASE);
  startMockFB(MOCK_FB_PORT);
  await new Promise(r => setTimeout(r, 500));

  console.log('[Smoke] 啟動 session', ACCOUNT);
  const s = await launchSession(ACCOUNT, { headless: false });
  console.log('[Smoke] 瀏覽器已啟動, URL=', s.page.url());

  const loginRes = await skillLogin({ page: s.page, accountId: ACCOUNT, memory: fakeMemory() }, {
    email: ACCOUNT, password: 'test1234',
  });
  console.log('[Smoke] skillLogin =>', JSON.stringify(loginRes).slice(0, 300));

  const det = createPageDetector(s.page);
  const st = await det.detectPageState();
  console.log('[Smoke] detectPageState =>', JSON.stringify(st, null, 2).slice(0, 400));

  const hasComposer = await s.page.$('div[aria-label="在想些什麼"]') || await s.page.$('div[role="button"]:has-text("在想些什麼")');
  console.log('[Smoke] 首頁 composer 選擇器命中:', !!hasComposer);

  if (loginRes.success) {
    const browseRes = await skillBrowseFeed({ page: s.page, accountId: ACCOUNT, memory: fakeMemory() }, {
      scrollCount: 2, likeProbability: 0, duration: 5000,
    });
    console.log('[Smoke] skillBrowseFeed =>', JSON.stringify(browseRes).slice(0, 300));
  }

  await closeSession(ACCOUNT, true);
  console.log('[Smoke] 完成');
  process.exit(0);
}

function fakeMemory(): any {
  return {
    recordInteraction: async () => {},
    addFriend: async () => {},
    recordMessage: async () => {},
    recordInvitation: async () => {},
  };
}

main().catch(e => { console.error('[Smoke] FAILED', e); process.exit(1); });
