/**
 * 技能注册表 — 把软件所有功能建模为 OpenClaw 可調用的「技能」
 *
 * 用户要求：功能以「技能」形式存在，點擊即可調用；OpenClaw 是軟件本體，
 * 所有功能都是它的技能。本模块维护技能清單（含啟用/停用、使用次數統計），
 * 並產出一張「技能目錄文本」注入 OpenClaw 上下文，讓它知道能調用哪些能力。
 *
 * 注意：本模块為純數據 + 持久化，不 import task-runner，避免循環依賴。
 * 實際執行由 server.ts 路由調用 runTask（skill.taskType 即 runTask 的 type）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../../config';

export interface OpenClawSkill {
  id: string;
  name: string;
  category: string;
  description: string;
  /** 對應 task-runner.runTask 的 type */
  taskType: string;
  enabled: boolean;
  usageCount: number;
  lastUsed?: number;
}

type SkillSeed = Omit<OpenClawSkill, 'enabled' | 'usageCount' | 'lastUsed'>;

const DEFAULT_SKILLS: SkillSeed[] = [
  { id: 'login',               name: '登入帳號',     category: '基礎',     description: '自動登入 Facebook', taskType: 'login' },
  { id: 'browse_feed',         name: '瀏覽動態',     category: '內容',     description: '滑動首頁、自然瀏覽貼文', taskType: 'browse_feed' },
  { id: 'like_post',           name: '按讚貼文',     category: '內容',     description: '對帖子按讚（擬人化隨機）', taskType: 'like_post' },
  { id: 'add_friends',         name: '搜尋加好友',   category: '社交擴張', description: '關鍵字搜尋並送出好友邀請', taskType: 'add_friends' },
  { id: 'add_friend_by_name',  name: '按名稱加好友', category: '社交擴張', description: '指定 FB 名稱送出好友邀請', taskType: 'add_friend_by_name' },
  { id: 'send_message',        name: '發送私訊',     category: '社交擴張', description: '對指定對象發送私訊', taskType: 'send_message' },
  { id: 'send_message_to_name',name: '按名稱發私訊', category: '社交擴張', description: '指定 FB 名稱發私訊', taskType: 'send_message_to_name' },
  { id: 'join_groups',         name: '加入社團',     category: '社交擴張', description: '加入目標社團', taskType: 'join_groups' },
  { id: 'create_post',         name: '發布貼文',     category: '內容',     description: '發布生活/興趣貼文', taskType: 'create_post' },
  { id: 'share_post',          name: '分享貼文',     category: '內容',     description: '分享主頁/社團貼文到時線', taskType: 'share_post' },
  { id: 'invite_to_group',     name: '邀請進社團',   category: '社交擴張', description: '邀請好友加入目標社團', taskType: 'invite_to_group' },
  { id: 'invite_to_page',      name: '邀請讚主頁',   category: '社交擴張', description: '邀請好友讚公共主頁', taskType: 'invite_to_page' },
  { id: 'get_friends',         name: '取得好友列表', category: '基礎',     description: '讀取好友清單', taskType: 'get_friends' },
  { id: 'sync',                name: '同步帳號狀態', category: '基礎',     description: '同步 FB 暱稱與頁面狀態', taskType: 'sync' },
  { id: 'socialize',           name: '互加互聊',     category: '智能編排', description: '帳號池環狀互加好友並互聊', taskType: 'socialize' },
  { id: 'greet_new_friends',   name: '問候新好友',   category: '智能編排', description: '對剛通過的好友自然問候', taskType: 'greet_new_friends' },
  { id: 'ai_chat_reply',       name: 'AI 聊天接管',  category: 'AI 接管',  description: '偵測未讀並由 OpenClaw 接管回覆（含一級介紹）', taskType: 'ai_chat_reply' },
  { id: 'distribute_content',  name: '內容分發',     category: '智能編排', description: '多帳號錯峰分發內容', taskType: 'distribute_content' },
  { id: 'risk_check',          name: '風控檢測',     category: '安全',     description: '檢測帳號風控等級', taskType: 'risk_check' },
];

const SKILLS_FILE = path.join(DATA_DIR, 'skills.json');

let cache: OpenClawSkill[] | null = null;

function load(): OpenClawSkill[] {
  if (cache) return cache;
  let stored: Record<string, { enabled?: boolean; usageCount?: number; lastUsed?: number }> = {};
  try { if (fs.existsSync(SKILLS_FILE)) stored = JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf-8')); } catch {}
  cache = DEFAULT_SKILLS.map(d => ({
    ...d,
    enabled: stored[d.id]?.enabled ?? true,
    usageCount: stored[d.id]?.usageCount ?? 0,
    lastUsed: stored[d.id]?.lastUsed,
  }));
  return cache;
}

function persist(): void {
  try {
    const obj: Record<string, any> = {};
    for (const s of load()) obj[s.id] = { enabled: s.enabled, usageCount: s.usageCount, lastUsed: s.lastUsed };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SKILLS_FILE, JSON.stringify(obj, null, 2));
  } catch {}
}

export function getSkills(): OpenClawSkill[] { return load().map(s => ({ ...s })); }

export function getSkill(id: string): OpenClawSkill | undefined { return load().find(s => s.id === id); }

/** 任务 type → 技能 id 是同構的（skill.taskType === type），可直接按 type 記錄使用 */
export function recordSkillUsage(taskType: string): void {
  const s = load().find(x => x.taskType === taskType);
  if (!s) return;
  s.usageCount += 1;
  s.lastUsed = Date.now();
  persist();
}

export function setSkillEnabled(id: string, enabled: boolean): boolean {
  const s = load().find(x => x.id === id);
  if (!s) return false;
  s.enabled = enabled;
  persist();
  return true;
}

/** 給 OpenClaw 的技能目錄文本（作為上下文注入，讓它知道能調用哪些技能） */
export function getSkillCatalogText(): string {
  const enabled = load().filter(s => s.enabled);
  if (enabled.length === 0) return '（當前無可用技能）';
  return enabled.map(s => `- ${s.name}（${s.category}）：${s.description}`).join('\n');
}
