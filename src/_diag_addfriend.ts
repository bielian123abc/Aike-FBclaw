/** 診斷真實 FB 好友推薦頁結構 */
import { launchSession, closeSession } from './core/browser/session-manager';

async function run() {
  const uid = '61590344349141';
  const s = await launchSession(uid, { headless: true });
  await s.page.waitForTimeout(4000);
  await s.page.goto('https://www.facebook.com/friends/suggestions', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(6000);

  const info = await s.page.evaluate(() => {
    const txt = (document.body?.innerText || '').slice(0, 400);
    const friendBtns = Array.from(document.querySelectorAll('[aria-label*="friend" i], [aria-label*="朋友" i]'))
      .map(e => e.getAttribute('aria-label'));
    const addLinks = Array.from(document.querySelectorAll('a[href*="add_friend"]')).map(a => (a as HTMLAnchorElement).href.slice(0, 80));
    const hasCheckpoint = /confirm you|verify|identity|unusual activity|human/i.test(txt);
    return { txt, friendBtns: [...new Set(friendBtns)].slice(0, 15), addLinks: addLinks.slice(0, 5), hasCheckpoint };
  });

  console.log('頁面文本前400:', info.txt);
  console.log('\nfriend 相關 aria-label:', info.friendBtns);
  console.log('\nadd_friend 連結:', info.addLinks);
  console.log('\n疑似 checkpoint:', info.hasCheckpoint);

  await closeSession(uid);
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
