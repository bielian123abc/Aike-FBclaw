/**
 * 幂等清理打包前測試產物：只移除 prepack_test_* 條目，絕不動真實資料。
 */
import * as fs from 'fs';
import { AVATAR_MANIFEST_FILE, DATA_DIR, AVATAR_INBOX_DIR, AVATAR_USED_DIR } from '../src/config';

const GROUP_FILE = DATA_DIR + '/global-joined-groups.json';
const testAvatars = ['prepack_test_a.png', 'prepack_test_b.png'];

for (const f of testAvatars) {
  for (const d of [AVATAR_INBOX_DIR, AVATAR_USED_DIR]) {
    try { fs.unlinkSync(d + '/' + f); } catch {}
  }
}
if (fs.existsSync(AVATAR_MANIFEST_FILE)) {
  const m = JSON.parse(fs.readFileSync(AVATAR_MANIFEST_FILE, 'utf-8'));
  let ch = false;
  for (const f of testAvatars) if (f in m) { delete m[f]; ch = true; }
  if (ch) fs.writeFileSync(AVATAR_MANIFEST_FILE, JSON.stringify(m, null, 2));
}
if (fs.existsSync(GROUP_FILE)) {
  const all = JSON.parse(fs.readFileSync(GROUP_FILE, 'utf-8'));
  const fl = all.filter((g: any) => !String(g.url).includes('prepack'));
  if (fl.length !== all.length) fs.writeFileSync(GROUP_FILE, JSON.stringify(fl, null, 2));
}
console.log('prepack cleanup done (real data preserved)');
