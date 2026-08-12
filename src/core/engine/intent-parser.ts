/**
 * IntentParser — 把自然語言指令解析為可執行任務
 *
 * 雙層設計：
 * 1. 本地快速規則（保證無網路/無 API Key 也能跑）
 * 2. 可選 LLM 增強（讓 AI 對話更自然）
 */
import { getOpenClaw } from '../openclaw/engine';
import { buildAgentSystemPrompt } from '../agent/openclaw-context';

export interface ParsedIntent {
  type: string;
  params: Record<string, any>;
  replyToUser: string;
}

const RULES: { patterns: RegExp[]; type: string; params: (message: string, m?: RegExpMatchArray) => Record<string, any>; reply: string }[] = [
  {
    patterns: [/登入|登录|login/i, /上線|上线/i],
    type: 'login',
    params: () => ({}),
    reply: '好的，我來幫你登入並同步狀態。',
  },
  {
    patterns: [/同步|sync|狀態|状态/i],
    type: 'sync',
    params: () => ({}),
    reply: '我來同步一下這個帳號的最新狀態。',
  },
  {
    patterns: [/瀏覽|浏览|滑.*動態|feed|刷/i],
    type: 'browse_feed',
    params: () => ({ scrollCount: 5, likeProbability: 0.3 }),
    reply: '沒問題，我去滑一下動態，順便按幾個讚。',
  },
  {
    patterns: [/邀請.*按讚主頁|邀請.*點贊主頁|邀請好友.*主頁|邀請訪問主頁|邀请.*点赞主页|邀请.*访问主页/i],
    type: 'invite_to_page',
    params: () => ({ count: 5 }),
    reply: '我會邀請好友來訪問並按讚你的主頁。',
  },
  {
    patterns: [/按讚|点赞|like.*post|讚/i],
    type: 'like_post',
    params: () => ({}),
    reply: '好，我來點讚。',
  },
  {
    patterns: [/從社團.*加好友|社團.*加.*好友|从社团.*加好友|社团成员.*加好友|社團裡.*加好友/i],
    type: 'add_friends_from_group',
    params: (msg: string) => {
      const g = msg.match(/(?:社團|社团)[^，,]*?(\d+)/) || msg.match(/groupId[=: ]*(\d+)/i);
      return g ? { mode: 'group_members', groupId: g[1], count: 2 } : { mode: 'group_members', count: 2 };
    },
    reply: '我會從指定的台灣本地社團成員裡加幾位好友。',
  },
  {
    patterns: [/加好友|添加好友|add.*friend|加.*朋友|加.*好友/i],
    type: 'add_friends',
    params: (msg: string) => {
      const q = msg.match(/關於|关于|找|搜|的\s*(.+)/);
      return { mode: 'search', searchQuery: q ? q[1].trim() : '台灣', count: 2 };
    },
    reply: '我會搜尋並加幾個好友，並記得問候。',
  },
  {
    patterns: [/問候|问候|greet|打招呼/i],
    type: 'greet_new_friends',
    params: () => ({}),
    reply: '我來幫你跟剛通過的好友打招呼。',
  },
  {
    patterns: [/發訊息|发消息|傳訊息|私信|message.*(to|給)/i, /找(.+?)聊天/],
    type: 'send_message',
    params: (m) => {
      const target = m[1];
      return { friendName: target, message: '嗨，最近還好嗎？' };
    },
    reply: '我來傳訊息給對方。',
  },
  {
    patterns: [/回覆.*訊息|回覆訊息|回消息|ai.*回覆|自動回覆|回聊天/i],
    type: 'ai_chat_reply',
    params: () => ({}),
    reply: '我來看看有沒有未讀訊息，並用 AI 回覆。',
  },
  {
    patterns: [/回覆.*留言|回覆.*評論|回覆.*评论|回.*留言|回.*評論|回.*评论|留言.*回覆|評論.*回覆|评论.*回复|comment.*reply|reply.*comment/i],
    type: 'reply_comment',
    params: () => ({}),
    reply: '貼文留言回覆功能還在接入中，我先把指令接收並標記狀態。',
  },
  {
    patterns: [/加入.*社團|加社團|加.*社團|join.*group/i],
    type: 'join_groups',
    params: (msg: string) => {
      const k = msg.match(/關於|关于|的\s*(.+?)(?:社團|社团)/);
      return { keywords: k ? [k[1].trim()] : ['台灣'], count: 1 };
    },
    reply: '我會搜尋合適的社團申請加入。',
  },
  {
    patterns: [/邀請.*進社團|邀請.*加社團|邀請好友.*社團|邀请.*进社团/i],
    type: 'invite_to_group',
    params: (msg: string) => {
      const g = msg.match(/(?:社團|社团)[^，,]*?(\d+)/) || msg.match(/groupId[=: ]*(\d+)/i);
      return g ? { groupId: g[1], groupName: '我的社團', count: 5 } : { groupId: '', groupName: '我的社團', count: 5 };
    },
    reply: '我會邀請好友加入指定的社團。',
  },
  {
    patterns: [/分享.*帖子|分享.*貼文|分享主頁|分享社團|把.*分享|share.*post/i],
    type: 'share_post',
    params: (msg: string) => {
      const url = msg.match(/(https?:\/\/[^\s]+)/);
      return { postUrl: url ? url[1] : '', target: 'timeline', message: '' };
    },
    reply: '我會把這則內容分享出去。',
  },
  {
    patterns: [/發帖|发帖|po.*文|發布.*貼文|create.*post/i, /貼文|贴文/],
    type: 'create_post',
    params: (msg: string) => {
      const c = msg.match(/(?:說|說說)\s*[:：]\s*(.+)$/) || msg.match(/[:：]\s*(.+)$/);
      return { content: c ? c[1].trim() : '週末去了一家藏在巷弄的咖啡廳，環境很舒服，適合放空一下午 ☕️' };
    },
    reply: '我來幫你發一則貼文。',
  },
  {
    patterns: [/分發|分发|多號.*發文|內容分發|distribute/i],
    type: 'distribute_content',
    params: () => ({ contentId: 'default', accountIds: [] }),
    reply: '我會把素材庫內容改寫後分發到多個帳號。',
  },
  {
    patterns: [/自己.*主頁.*讚|自動讚.*主頁|auto.*like.*own/i],
    type: 'auto_like_own_page',
    params: () => ({}),
    reply: '我會去刷自己的主頁並按讚。',
  },
  {
    patterns: [/風控|风险|risk|檢查|check/i],
    type: 'risk_check',
    params: () => ({}),
    reply: '我來檢查一下當前帳號的風控狀態。',
  },
  {
    patterns: [/狀態|状态|統計|统计|總數|总数|監控|监控|報告|报告|list.*account|list.*proxy|status/i],
    type: 'status_report',
    params: () => ({}),
    reply: '我來幫你統計目前的帳號、代理與監控狀態。',
  },
];

export function parseIntent(message: string): ParsedIntent {
  for (const rule of RULES) {
    for (const pat of rule.patterns) {
      const m = message.match(pat);
      if (m) {
        return { type: rule.type, params: rule.params(message, m), replyToUser: rule.reply };
      }
    }
  }
  return { type: 'unknown', params: {}, replyToUser: '我聽不懂，試試說：「加好友」、「發帖」、「回覆訊息」、「同步狀態」。' };
}

/** 可選 LLM 增強解析（統一走 OpenClaw 單一智能體，軟件不直連其它 AI） */
export async function parseIntentWithLLM(message: string): Promise<ParsedIntent | null> {
  try {
    const system = buildAgentSystemPrompt('你是指令解析器。把用戶的話對應到 JSON：{ "type": "...", "params": {...}, "replyToUser": "..." }。type 只能是：login,sync,browse_feed,like_post,add_friends,add_friends_from_group,greet_new_friends,send_message,ai_chat_reply,reply_comment,join_groups,create_post,share_post,invite_to_group,invite_to_page,distribute_content,auto_like_own_page,get_friends,risk_check,status_report,unknown。replyToUser 用繁體中文口語，20字內。絕不產生任何商業/推銷內容。');
    const text = await getOpenClaw().chat(system, message, 120);
    if (!text) return null;
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    if (parsed.type) return parsed;
  } catch {}
  return null;
}
