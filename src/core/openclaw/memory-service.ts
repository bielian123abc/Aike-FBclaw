/**
 * 记忆服务 — OpenClaw 的「记忆碎片」与全局知识库
 *
 * 用户要求：
 * 1. 每个账号有独立的「记忆碎片」(memory shard)，避免長時間運行污染主智能體上下文。
 * 2. 上下文摘要要「壓縮但不丟重要記憶」——關鍵事實 / 重要記憶永不丟，最近上下文可滾動。
 * 3. 跨帳號的學習與進化沉澱到「全局知識庫」(global-knowledge.md)。
 *
 * 設計：
 * - 碎片檔：data/memory/shards/<accountId>.json（輕量 JSON，與 SQLite 行為記憶互補）
 * - 全局知識：data/memory/global-knowledge.md（Markdown 追加，便於 OpenClaw 直接讀取）
 * - summarizeContext() 產出給 OpenClaw 的壓縮上下文（重要記憶優先保留）
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../../config';

const SHARD_DIR = path.join(DATA_DIR, 'memory', 'shards');
const GLOBAL_KNOWLEDGE = path.join(DATA_DIR, 'memory', 'global-knowledge.md');
const MAX_RECENT = 60;

export interface MemoryShard {
  accountId: string;
  updatedAt: number;
  /** 關鍵事實：跨會話永不遺失（如「對方是做手作的」「住在台中」） */
  keyFacts: string[];
  /** 重要記憶：標記 important 的條目，壓縮時保留 */
  importantMemories: string[];
  /** 最近上下文：可滾動，最多 MAX_RECENT 條 */
  recentContext: string[];
  /** 重要關係備註 */
  relationships: { friend: string; note: string; updatedAt: number }[];
}

export interface ShardEntry {
  text: string;
  important?: boolean;
  keyFact?: boolean;
  friend?: string;
  note?: string;
}

function ensureDir(): void { try { fs.mkdirSync(SHARD_DIR, { recursive: true }); } catch {} }

function safeName(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9_.@-]/g, '_');
}

function shardPath(accountId: string): string {
  return path.join(SHARD_DIR, `${safeName(accountId)}.json`);
}

export function getShard(accountId: string): MemoryShard {
  ensureDir();
  try {
    if (fs.existsSync(shardPath(accountId))) {
      return JSON.parse(fs.readFileSync(shardPath(accountId), 'utf-8'));
    }
  } catch {}
  return { accountId, updatedAt: Date.now(), keyFacts: [], importantMemories: [], recentContext: [], relationships: [] };
}

function saveShard(s: MemoryShard): void {
  ensureDir();
  s.updatedAt = Date.now();
  try { fs.writeFileSync(shardPath(s.accountId), JSON.stringify(s, null, 2)); } catch {}
}

export function appendShard(accountId: string, entry: ShardEntry): void {
  const s = getShard(accountId);
  s.recentContext.push(`[${new Date().toLocaleString('zh-TW')}] ${entry.text}`);
  if (s.recentContext.length > MAX_RECENT) s.recentContext.shift();
  if (entry.important) s.importantMemories.push(entry.text);
  if (entry.keyFact && !s.keyFacts.includes(entry.text)) s.keyFacts.push(entry.text);
  if (entry.friend && entry.note) {
    const rel = s.relationships.find(r => r.friend === entry.friend);
    if (rel) { rel.note = entry.note; rel.updatedAt = Date.now(); }
    else s.relationships.push({ friend: entry.friend, note: entry.note, updatedAt: Date.now() });
  }
  saveShard(s);
}

/**
 * 取給 OpenClaw 用的上下文壓縮摘要：
 * 重要記憶 + 關鍵事實 + 重要關係 永遠保留；最近上下文只取後 maxRecent 條。
 */
export function summarizeContext(accountId: string, maxRecent = 14): string {
  const s = getShard(accountId);
  const parts: string[] = [];
  if (s.keyFacts.length) parts.push('【關鍵事實】\n' + s.keyFacts.map(f => '• ' + f).join('\n'));
  if (s.importantMemories.length) parts.push('【重要記憶（不可遺忘）】\n' + s.importantMemories.slice(-12).map(m => '• ' + m).join('\n'));
  if (s.relationships.length) parts.push('【重要關係】\n' + s.relationships.slice(-10).map(r => `• ${r.friend}：${r.note}`).join('\n'));
  if (s.recentContext.length) parts.push('【最近上下文】\n' + s.recentContext.slice(-maxRecent).join('\n'));
  return parts.join('\n\n') || '（尚無記憶碎片）';
}

export function getGlobalKnowledge(): string {
  try {
    return fs.existsSync(GLOBAL_KNOWLEDGE)
      ? fs.readFileSync(GLOBAL_KNOWLEDGE, 'utf-8')
      : '# 全局知識庫（OpenClaw 跨帳號學習與進化）\n\n';
  } catch { return ''; }
}

export function appendGlobalKnowledge(section: string): void {
  try {
    fs.mkdirSync(path.dirname(GLOBAL_KNOWLEDGE), { recursive: true });
    const header = `\n\n## ${new Date().toLocaleString('zh-TW')}\n`;
    fs.appendFileSync(GLOBAL_KNOWLEDGE, header + section.trim() + '\n');
  } catch {}
}

export interface ShardSummary {
  accountId: string;
  facts: number;
  important: number;
  recent: number;
  relationships: number;
  updatedAt: number;
}

export function getShardSummaries(): ShardSummary[] {
  ensureDir();
  try {
    return fs.readdirSync(SHARD_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const s: MemoryShard = JSON.parse(fs.readFileSync(path.join(SHARD_DIR, f), 'utf-8'));
        return {
          accountId: s.accountId,
          facts: s.keyFacts.length,
          important: s.importantMemories.length,
          recent: s.recentContext.length,
          relationships: s.relationships.length,
          updatedAt: s.updatedAt,
        };
      });
  } catch { return []; }
}
