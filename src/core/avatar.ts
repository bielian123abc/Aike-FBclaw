/**
 * 頭像資源管理 — 使用者把圖片放到 data/avatars/inbox，軟件自動上傳替換；
 * 用過的頭像標記，避免跨帳號重複使用（一個帳號一生只換一次）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AVATAR_INBOX_DIR, AVATAR_USED_DIR, AVATAR_MANIFEST_FILE } from '../config';

export interface AvatarManifestEntry {
  usedBy: string[];
  usedAt: number;
}

function getManifest(): Record<string, AvatarManifestEntry> {
  try {
    if (fs.existsSync(AVATAR_MANIFEST_FILE)) return JSON.parse(fs.readFileSync(AVATAR_MANIFEST_FILE, 'utf-8'));
  } catch {}
  return {};
}

function saveManifest(m: Record<string, AvatarManifestEntry>): void {
  try { fs.mkdirSync(path.dirname(AVATAR_MANIFEST_FILE), { recursive: true }); } catch {}
  try { fs.writeFileSync(AVATAR_MANIFEST_FILE, JSON.stringify(m, null, 2)); } catch {}
}

const IMG_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

export function listInboxAvatars(): string[] {
  try { return fs.readdirSync(AVATAR_INBOX_DIR).filter((f) => IMG_RE.test(f)); } catch { return []; }
}

/** 統計：待處理 / 已使用（已使用 = 出現在 manifest 中，無論被誰用過都算，避免重複） */
export function getAvatarStats(): { inbox: number; used: number; total: number } {
  const m = getManifest();
  const usedNames = new Set(Object.keys(m));
  const inbox = listInboxAvatars().filter((f) => !usedNames.has(f)).length;
  return { inbox, used: usedNames.size, total: inbox + usedNames.size };
}

/** 取得下一個「未被任何帳號用過」的頭像（跨帳號去重）；沒有則回 null */
export function getNextAvailableAvatar(): string | null {
  const m = getManifest();
  for (const f of listInboxAvatars()) {
    if (!m[f]) return path.join(AVATAR_INBOX_DIR, f);
  }
  return null;
}

/** 某帳號是否已用過頭像（一生一次檢查） */
export function accountHasAvatar(accountId: string): boolean {
  const m = getManifest();
  for (const e of Object.values(m)) if (e.usedBy.includes(accountId)) return true;
  return false;
}

/** 標記頭像已用：複製到 used/ 並記入 manifest（記錄使用帳號，防止跨帳號複用） */
export function markAvatarUsed(filename: string, accountId: string): { ok: boolean; usedPath?: string; error?: string } {
  const src = path.join(AVATAR_INBOX_DIR, filename);
  if (!fs.existsSync(src)) return { ok: false, error: '原始頭像不存在' };
  const dest = path.join(AVATAR_USED_DIR, filename);
  try { fs.copyFileSync(src, dest); } catch (e: any) { return { ok: false, error: e.message }; }
  const m = getManifest();
  const e = m[filename] || { usedBy: [], usedAt: 0 };
  if (!e.usedBy.includes(accountId)) e.usedBy.push(accountId);
  e.usedAt = Date.now();
  m[filename] = e;
  saveManifest(m);
  return { ok: true, usedPath: dest };
}

export function getAvatarUsedBy(filename: string): string[] {
  return getManifest()[filename]?.usedBy || [];
}

// ---------- 上傳寫入（UI 上傳頭像落盤） ----------

/** 允許的圖片 magic bytes（PNG / JPEG / WEBP / GIF / BMP） */
function detectImageType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return null;
}

const MAX_AVATAR_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * 接收上傳的頭像位元組，校驗後寫入 inbox（真正落盤），回傳安全檔名。
 * - 校驗真實圖片格式（magic bytes），防止偽裝上傳
 * - 限制大小，防止超大檔
 * - 生成去重安全檔名（時間戳+隨機），避免覆蓋或路徑穿越
 */
export function saveUploadedAvatar(buf: Buffer, originalName: string): { ok: boolean; filename?: string; size?: number; error?: string } {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, error: '空檔案' };
  if (buf.length > MAX_AVATAR_BYTES) return { ok: false, error: `檔案過大（${Math.round(buf.length / 1024 / 1024)}MB > 10MB）` };
  const type = detectImageType(buf);
  if (!type) return { ok: false, error: '不是有效的圖片（僅支援 PNG/JPEG/WEBP/GIF/BMP）' };

  // 安全檔名：去路徑、去危險字元，保留副檔名
  const base = String(originalName || 'avatar')
    .replace(/^.*[\\/]/, '')              // 去目錄
    .replace(/\.(?=.*\.)/g, '_')          // 多重副檔名防穿透
    .replace(/[^a-zA-Z0-9._\-一-鿿]/g, '_') // 只留安全字元（含中文）
    .replace(/\.(png|jpe?g|webp|gif|bmp)$/i, ''); // 先去原副檔名
  const safeBase = (base || 'avatar').slice(0, 40);
  const filename = `av_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_${safeBase}.${type}`;

  try {
    fs.mkdirSync(AVATAR_INBOX_DIR, { recursive: true });
    const dest = path.join(AVATAR_INBOX_DIR, filename);
    fs.writeFileSync(dest, buf);
    return { ok: true, filename, size: buf.length };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
