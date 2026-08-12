/**
 * 对话记忆系统 - 每个好友独立记忆库
 * 文件: data/chat-memory/{accountId}_{friendName}.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../config';

const MEM_DIR = path.join(DATA_DIR, 'chat-memory');
if (!fs.existsSync(MEM_DIR)) fs.mkdirSync(MEM_DIR, { recursive: true });

export interface ChatMemory {
  friendName: string;
  relationshipStage: '新' | '认识' | '朋友' | '熟悉' | '商业';
  messages: { time: string; from: 'me'|'friend'; text: string }[];
  lastTopics: string[];
  dailyMsgCount: number;
  firstContact: string;
  lastContact: string;
  notes: string;
}

const TW_REPLIES: Record<ChatMemory['relationshipStage'], string[]> = {
  新: ['嗨', '你好啊', '👋', '哈囉', '最近好嗎'],
  认识: ['嗯嗯', '對啊', '哈哈', '了解', '好的', '最近好嗎', '在忙什麼'],
  朋友: ['XD', '真的假的', '笑死', '也太好了吧', '最近過得怎麼樣', '有空約出來啊'],
  熟悉: ['欸跟你說', '你最近有看到那個嗎', '我家附近那間飲料店新出的超好喝', '週末要不要一起去逛逛'],
  商业: ['這部劇你有在看嗎', '你去的那个展覽好玩嗎', '最近在練拍照，你有推薦景點嗎', '週末有安排什麼嗎'],
};

export function loadMemory(accountId: string, friendName: string): ChatMemory {
  const f = path.join(MEM_DIR, `${accountId.slice(-8)}_${sanitize(friendName)}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  return {
    friendName,
    relationshipStage: '新',
    messages: [],
    lastTopics: [],
    dailyMsgCount: 0,
    firstContact: new Date().toISOString(),
    lastContact: '',
    notes: '',
  };
}

export function saveMemory(accountId: string, mem: ChatMemory) {
  const f = path.join(MEM_DIR, `${accountId.slice(-8)}_${sanitize(mem.friendName)}.json`);
  fs.writeFileSync(f, JSON.stringify(mem, null, 2));
}

export function generateReply(mem: ChatMemory): string {
  mem.dailyMsgCount++;
  const replies = TW_REPLIES[mem.relationshipStage] || TW_REPLIES.新;
  
  // 升级关系阶段
  if (mem.messages.length > 10 && mem.relationshipStage === '新') mem.relationshipStage = '认识';
  if (mem.messages.length > 30 && mem.relationshipStage === '认识') mem.relationshipStage = '朋友';
  if (mem.messages.length > 80 && mem.relationshipStage === '朋友') mem.relationshipStage = '熟悉';
  
  // 每天最多回复
  if (mem.dailyMsgCount > 5) return '';
  
  // 避免重复最近5条
  const recent = mem.messages.slice(-5).map(m => m.text);
  const available = replies.filter(r => !recent.includes(r));
  if (available.length === 0) available.push('...');
  
  return available[Math.floor(Math.random() * available.length)];
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_').slice(0, 30);
}
