/**
 * 诊断：全页 Messenger (/messages/t/<id>) 的 composer 是否在主 DOM。
 * 目的：确认 ai_chat_reply（被动回复）的发送路径是否也受「跨域 iframe」影響。
 */
import { chromium } from 'playwright-core';

const PROFILE = 'G:/Aike-FBclaw/data/browser-profiles/61590447695027';
const THREAD = '100009345685809';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: ['--no-sandbox', '--start-maximized'],
  locale: 'zh-TW',
});
const page = ctx.pages()[0];

async function dumpComposer(tag: string) {
  const info = await page.evaluate(() => {
    const mainDocComposer = Array.from(document.querySelectorAll('div[contenteditable="true"][role="textbox"]')).length;
    const mainDocAnyCE = Array.from(document.querySelectorAll('div[contenteditable="true"]')).length;
    const frames: { url: string; composer: number; anyCE: number }[] = [];
    // 主 document 的 iframe
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const d = (f.contentDocument as any);
        if (!d) { frames.push({ url: f.src || '(no src)', composer: -1, anyCE: -1 }); continue; }
        frames.push({
          url: f.src || '(same-origin no src)',
          composer: d.querySelectorAll('div[contenteditable="true"][role="textbox"]').length,
          anyCE: d.querySelectorAll('div[contenteditable="true"]').length,
        });
      } catch (e: any) {
        frames.push({ url: f.src || '(cross-origin)', composer: -2, anyCE: -2 }); // -2 = 跨域無法訪問
      }
    }
    return { mainDocComposer, mainDocAnyCE, frames };
  });
  console.log(`\n===== ${tag} | url=${(await page.url())} =====`);
  console.log('主DOM composer(textbox):', info.mainDocComposer, '| 主DOM anyCE:', info.mainDocAnyCE);
  console.log('iframe 數:', info.frames.length);
  for (const f of info.frames) {
    const note = f.composer === -2 ? ' [跨域不可訪問]' : f.composer === -1 ? ' [無 document]' : '';
    console.log('  -', f.url.slice(0, 80), '| composer:', f.composer, '| anyCE:', f.anyCE, note);
  }
  return info;
}

try {
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  const uid = (await ctx.cookies()).find(c => c.name === 'c_user');
  console.log('UID=', uid?.value || '未登入');
  if (!uid) { await ctx.close(); process.exit(1); }

  // 處理可能出現的 PIN / checkpoint
  await page.waitForTimeout(2000);

  // 直接打開全頁 thread
  await page.goto(`https://www.facebook.com/messages/t/${THREAD}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  await dumpComposer('全頁 thread 開啟後');

  // 也試 inbox 首頁
  await page.goto('https://www.facebook.com/messages/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await dumpComposer('inbox 首頁');

} catch (e: any) {
  console.error('ERR', e.message);
} finally {
  await page.waitForTimeout(2000);
  await ctx.close();
}
