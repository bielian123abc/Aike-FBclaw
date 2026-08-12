/**
 * Agent Memory — 智能體的「進化」基底
 *
 * 讓 OpenClaw 智能體擁有跨會話的持久記憶：
 * - agent_chat：每個帳號的對話歷史（重新啟動後仍記得你說過什麼）。
 * - agent_notes：智能體可主動寫入的「經驗/知識」，實現持續進化。
 * - agent_skills：智能體自行進化出的技能（由現有工具組成的流程），寫入後即可被呼叫。
 *
 * 共用 account-memory 的 data/memory.db，開啟 WAL 允許多連線並發。
 */
import * as path from 'path';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../../config';

const DB_PATH = path.join(DATA_DIR, 'memory.db');
let _db: Database.Database | null = null;

function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_chat_scope ON agent_chat(scope, id);
      CREATE TABLE IF NOT EXISTS agent_notes (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_skills (
        name TEXT PRIMARY KEY,
        def_json TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
    `);
  }
  return _db;
}

// ---------------- 對話歷史（跨會話記憶） ----------------
export function appendChat(scope: string, role: 'user' | 'agent' | 'system', content: string): void {
  db().prepare('INSERT INTO agent_chat(scope,role,content,ts) VALUES(?,?,?,?)')
    .run(scope, role, content, Date.now());
}

export function getChatHistory(scope: string, limit = 30): string {
  const rows = db().prepare('SELECT role,content,ts FROM agent_chat WHERE scope=? ORDER BY id DESC LIMIT ?')
    .all(scope, limit) as { role: string; content: string; ts: number }[];
  rows.reverse();
  return rows.map((r) => {
    const who = r.role === 'user' ? '使用者' : r.role === 'agent' ? '智能體' : '系統';
    const time = new Date(r.ts).toLocaleString('zh-TW', { hour12: false });
    return `[${time}] ${who}：${r.content}`;
  }).join('\n');
}

// ---------------- 經驗筆記（進化基底） ----------------
export function putNote(key: string, value: string): void {
  db().prepare(
    'INSERT INTO agent_notes(key,value,ts) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts'
  ).run(key, value, Date.now());
}

export function getNote(key: string): string | null {
  const row = db().prepare('SELECT value FROM agent_notes WHERE key=?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function getAllNotes(): { key: string; value: string }[] {
  return db().prepare('SELECT key,value FROM agent_notes ORDER BY ts').all() as { key: string; value: string }[];
}

// ---------------- 進化技能 ----------------
export interface EvolvedSkill {
  name: string;
  description: string;
  steps: { tool: string; params?: Record<string, any> }[];
}

export function saveSkill(def: EvolvedSkill): void {
  db().prepare(
    'INSERT INTO agent_skills(name,def_json,ts) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET def_json=excluded.def_json, ts=excluded.ts'
  ).run(def.name, JSON.stringify(def), Date.now());
}

export function getSkill(name: string): EvolvedSkill | null {
  const row = db().prepare('SELECT def_json FROM agent_skills WHERE name=?').get(name) as { def_json: string } | undefined;
  return row ? (JSON.parse(row.def_json) as EvolvedSkill) : null;
}

export function listSkills(): { name: string; description: string }[] {
  const rows = db().prepare('SELECT name,def_json FROM agent_skills ORDER BY ts').all() as { name: string; def_json: string }[];
  return rows.map((r) => {
    const d = JSON.parse(r.def_json) as EvolvedSkill;
    return { name: r.name, description: d.description || '' };
  });
}

export function deleteSkill(name: string): void {
  db().prepare('DELETE FROM agent_skills WHERE name=?').run(name);
}
