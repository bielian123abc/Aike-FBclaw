import * as fs from 'fs';
const R = 'G:/Aike-FBclaw/data/account-report.json';
const j = JSON.parse(fs.readFileSync(R, 'utf-8'));
const bad = j.results.filter((r: any) => r.status === 'captcha');
const good = j.results.filter((r: any) => r.status === 'ok');
console.log('删除 ' + bad.length + ' 个CAPTCHA账号...');
for (const a of bad) {
  const d = 'G:/Aike-FBclaw/data/browser-profiles/' + a.profile;
  if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true }); }
  console.log(' 已删除: ' + a.profile);
}
console.log('保留 ' + good.length + ' 个正常账号');
j.results = good;
j.summary = { ok: good.length, captcha: 0, checkpoint: 0, fail: 0, deleted: bad.length };
fs.writeFileSync(R, JSON.stringify(j, null, 2));
process.exit(0);
