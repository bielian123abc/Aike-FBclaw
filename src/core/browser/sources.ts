/**
 * FacebookSourcesManager — 社团 & 公共主页 数据源（持久化）
 *
 * 用途：
 * 1. 让用户在控制台「社团&主页数据源」页面填写自己的主页/社团网址（可无限添加）。
 * 2. 扩展技能（邀请好友进社团 / 邀请点赞主页 / 从社团成员加好友 / 分享帖子）
 *    自动从这里读取已配置的目标，无需每次手动传 ID。
 * 3. 数据落盘到 data/sources.json，重启不丢。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../../config';

export type SourceType = 'page' | 'group';

export interface FbSource {
  id: string;            // 内部唯一 id
  type: SourceType;      // page = 公共主页；group = 社团
  name: string;          // 用户自定义备注名
  url: string;           // 原始填写网址
  rawId: string;         // 解析出的 FB id / handle（groups/xxx 取 xxx；profile.php?id=xxx 取 xxx；否则取 handle）
  addedAt: number;
  note?: string;         // 可选备注
}

const SOURCES_FILE = path.join(DATA_DIR, 'sources.json');

/**
 * 从 FB 网址中解析 id / handle。
 * - 社团：https://www.facebook.com/groups/1009250201890464 -> 1009250201890464
 * - 公共主页：facebook.com/profile.php?id=61580739204271 -> 61580739204271
 *             facebook.com/MyPage -> MyPage
 */
export function parseFbId(input: string): string {
  const s = (input || '').trim();
  if (!s) return '';
  // groups/<id>
  let m = s.match(/facebook\.com\/groups\/([^/?#]+)/i);
  if (m) return m[1];
  // profile.php?id=<id>
  m = s.match(/[?&]id=(\d+)/i);
  if (m) return m[1];
  // 标准主页 handle：facebook.com/<handle>
  m = s.match(/facebook\.com\/(?!groups\/)([^/?#]+)/i);
  if (m) {
    const handle = m[1];
    if (!['home', 'login', 'messages', 'friends', 'events', 'pages', 'bookmarks', 'settings', 'help', 'search', 'notifications'].includes(handle.toLowerCase())) {
      return handle;
    }
  }
  return '';
}

export function normalizeUrl(input: string): string {
  const s = (input || '').trim();
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  if (s.startsWith('facebook.com') || s.startsWith('www.facebook.com')) return 'https://' + s;
  return s;
}

class Manager {
  private sources: FbSource[] = [];
  private loaded = false;

  private load() {
    if (this.loaded) return;
    try {
      if (fs.existsSync(SOURCES_FILE)) {
        this.sources = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf-8'));
      }
    } catch { this.sources = []; }
    this.loaded = true;
  }

  private persist() {
    try { fs.writeFileSync(SOURCES_FILE, JSON.stringify(this.sources, null, 2)); } catch {}
  }

  list(): FbSource[] { this.load(); return this.sources.slice(); }

  listByType(type: SourceType): FbSource[] { return this.list().filter(s => s.type === type); }

  add(type: SourceType, url: string, name?: string, note?: string): FbSource {
    this.load();
    const norm = normalizeUrl(url);
    const rawId = parseFbId(norm);
    if (!rawId) throw new Error('無法從網址解析出 Facebook 識別碼，請檢查網址格式');
    // 去重（同 type 同 rawId 视为同一来源）
    const existing = this.sources.find(s => s.type === type && s.rawId === rawId);
    if (existing) {
      existing.url = norm;
      if (name) existing.name = name;
      if (note !== undefined) existing.note = note;
      this.persist();
      return existing;
    }
    const src: FbSource = {
      id: 'src_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      type,
      name: name?.trim() || (type === 'page' ? '公共主页 ' + rawId : '社团 ' + rawId),
      url: norm,
      rawId,
      addedAt: Date.now(),
      note,
    };
    this.sources.push(src);
    this.persist();
    return src;
  }

  remove(id: string): boolean {
    this.load();
    const before = this.sources.length;
    this.sources = this.sources.filter(s => s.id !== id);
    const removed = this.sources.length !== before;
    if (removed) this.persist();
    return removed;
  }

  /** 首次启动由 server 调用，确保用户给的初始数据源落地 */
  ensureSeed(list: { type: SourceType; url: string; name?: string }[]) {
    this.load();
    for (const item of list) {
      const rawId = parseFbId(normalizeUrl(item.url));
      if (!rawId) continue;
      if (!this.sources.some(s => s.type === item.type && s.rawId === rawId)) {
        this.add(item.type, item.url, item.name);
      }
    }
  }
}

let _mgr: Manager | null = null;
export function getSourcesManager(): Manager {
  if (!_mgr) _mgr = new Manager();
  return _mgr;
}
