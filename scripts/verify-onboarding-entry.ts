/**
 * 验证脚本入口：用真实浏览器驱动 Mock FB，跑通「自愈式首登管線」runOnboarding。
 * - 第一次開號：語言(detected)/頭像(修復)/PIN(修復)/主頁點讚(修復)
 * - 第二次開號（重新讀記憶體）：四步全部 detected 跳過、不重做 → 證明自愈
 * 由 verify-onboarding.mjs 經 esbuild 打包後執行；頭像資料會備份並還原。
 */
import { chromium, BrowserContext, Page } from 'playwright-core';
import * as path from 'path';
import * as fs from 'fs';
import { runOnboarding } from '../src/core/onboarding';
import { AccountMemory } from '../src/memory/account-memory';
import { startMockFB } from '../src/mock-facebook/server';

const ROOT = 'G:/Aike-FBclaw';
const PORT = parseInt(process.env.MOCK_FB_PORT || '18995', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = 'verify-onboarding@mock.local';

function backupAvatars(): { manifestBak: string; usedBak: string; inboxBak: string } {
  const manifestPath = path.join(ROOT, 'data', 'avatars', 'used-manifest.json');
  const usedDir = path.join(ROOT, 'data', 'avatars', 'used');
  const inboxDir = path.join(ROOT, 'data', 'avatars', 'inbox');
  const manifestBak = manifestPath + '.verify-bak';
  const usedBak = usedDir + '.verify-bak';
  const inboxBak = inboxDir + '.verify-bak';
  if (fs.existsSync(manifestPath)) fs.copyFileSync(manifestPath, manifestBak);
  if (fs.existsSync(usedDir)) fs.cpSync(usedDir, usedBak, { recursive: true });
  if (fs.existsSync(inboxDir)) fs.cpSync(inboxDir, inboxBak, { recursive: true });
  return { manifestBak, usedBak, inboxBak };
}

function restoreAvatars(bak: { manifestBak: string; usedBak: string; inboxBak: string }): void {
  const manifestPath = path.join(ROOT, 'data', 'avatars', 'used-manifest.json');
  const usedDir = path.join(ROOT, 'data', 'avatars', 'used');
  const inboxDir = path.join(ROOT, 'data', 'avatars', 'inbox');
  if (fs.existsSync(bak.manifestBak)) {
    fs.copyFileSync(bak.manifestBak, manifestPath);
    fs.unlinkSync(bak.manifestBak);
  }
  for (const [bakPath, liveDir] of [[bak.usedBak, usedDir], [bak.inboxBak, inboxDir]] as const) {
    if (fs.existsSync(bakPath)) {
      if (fs.existsSync(liveDir)) fs.rmSync(liveDir, { recursive: true, force: true });
      fs.renameSync(bakPath, liveDir);
    }
  }
}

/** 若 inbox 為空，注入一張 1x1 測試 PNG，確保頭像修復路徑可被驗證（結束後會還原） */
function injectTestAvatarIfEmpty(): void {
  const inboxDir = path.join(ROOT, 'data', 'avatars', 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  const hasImg = fs.readdirSync(inboxDir).some(f => /\.(png|jpe?g|webp|gif|bmp)$/i.test(f));
  if (hasImg) return;
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  fs.writeFileSync(path.join(inboxDir, 'verify-test-avatar.png'), Buffer.from(pngB64, 'base64'));
}

export async function run(): Promise<void> {
  const bak = backupAvatars();
  injectTestAvatarIfEmpty();
  // 清理上次驗證殘留的測試帳號記憶體，確保從乾淨狀態開始
  const acctDir = path.join(ROOT, 'data', 'accounts', ACCOUNT);
  if (fs.existsSync(acctDir)) fs.rmSync(acctDir, { recursive: true, force: true });
  // 測試期間清空頭像 manifest，使 inbox 中任一圖都可被本次驗證取用（結束後還原）
  fs.writeFileSync(path.join(ROOT, 'data', 'avatars', 'used-manifest.json'), '{}');
  const mockServer = startMockFB(PORT);
  await new Promise(r => setTimeout(r, 600));

  const ctx: BrowserContext = await chromium.launchPersistentContext(
    path.join(ROOT, 'data', '.verify-onboarding-profile'),
    { headless: true, args: ['--no-sandbox'] },
  );

  try {
    const page: Page = await ctx.newPage();
    await page.context().addCookies([{ name: 'c_user', value: ACCOUNT, url: BASE }]);
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);

    const memory = new AccountMemory(ACCOUNT);

    console.log('\n========== 第一次開號（應修復未完成步驟）==========');
    const s1 = await runOnboarding(page, ACCOUNT, memory);
    console.log('\n--- onboarding 狀態 #1 ---');
    console.log(JSON.stringify(s1, null, 2));

    // 重新開一個記憶體實例，模擬「二次開號」從磁碟讀回單帳號記憶
    const memory2 = new AccountMemory(ACCOUNT);
    const reloaded = memory2.getOnboarding();
    console.log('\n========== 第二次開號（應全部 detected 跳過，不重做）==========');
    const s2 = await runOnboarding(page, ACCOUNT, memory2);
    console.log('\n--- onboarding 狀態 #2 ---');
    console.log(JSON.stringify(s2, null, 2));

    const run2AllDetected = Object.values(s2.steps).every(st => st.done && st.method === 'detected');
    const pass =
      s1.allComplete === true &&
      s2.allComplete === true &&
      run2AllDetected === true &&
      reloaded?.allComplete === true;

    console.log('\n========== 驗證結果 ==========');
    console.log('Run1 allComplete      :', s1.allComplete);
    console.log('Run2 allComplete      :', s2.allComplete);
    console.log('Run2 全部 detected(自愈):', run2AllDetected);
    console.log('記憶體持久化讀回 allComplete:', reloaded?.allComplete);
    console.log(pass ? '\n✅ PASS — 自愈式首登管線驗證通過' : '\n❌ FAIL — 請檢查上方狀態');
    if (!pass) process.exitCode = 1;
  } finally {
    await ctx.close();
    mockServer.close();
    restoreAvatars(bak);
  }
}
