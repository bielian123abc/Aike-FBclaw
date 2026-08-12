/**
 * 被动接管 — OpenClaw 的「自動接管聊天」能力
 *
 * 用户要求：
 * - 当账号开始聊天（收到好友訊息），AI 立即接管并參與對話。
 * - 当好友问「你是做什么的」，觸發一級響應：介紹自己是跨境電商
 *   （吃穿住行都可以找我看看，網購我可以幫你去找貨），語氣像朋友、不推銷。
 *
 * 设计：
 * - detectTakeoverTrigger(lastPeerMsg)：判斷是「一級介紹」還是「普通聊天接管」。
 * - generateTakeoverReply：一級介紹走 OpenClaw（用戶授權，可提及跨境電商，不過安全濾網）；
 *   普通聊天復用 ai-provider 的擬真台式回覆（仍過安全濾網）。
 */
import { getOpenClaw } from './engine';
import { generateChatReply } from '../provider/ai-provider';

/** 命中即觸發「一級介紹（跨境電商）」的關鍵詞 */
const LEVEL1_TRIGGERS = [
  '你是做什么', '你是做什麼', '你是幹嘛', '你做什麼', '你干嘛', '你做啥',
  '你幹嘛', '做什么的', '做什麼的', '幹嘛的', '做什么工作', '你是干啥的',
  '你是幹啥的', '你是卖', '你是賣', '从事什么', '從事什麼', '你是幹嘛的',
];

export type TakeoverTrigger = 'level1_intro' | 'chat' | null;

export function detectTakeoverTrigger(msg: string): TakeoverTrigger {
  if (!msg || !msg.trim()) return null;
  if (LEVEL1_TRIGGERS.some(t => msg.includes(t))) return 'level1_intro';
  return 'chat'; // 任何來訊都視為可接管聊天
}

/** 一級介紹的本地安全兜底（用戶授權可提及跨境電商，故不走 FORBIDDEN_TERMS 濾網） */
const LEVEL1_FALLBACK = [
  '哈哈我主要是做跨境電商的啦，吃穿住行有需要都可以找我幫你看貨比價～',
  '我做跨境電商居多，網購要找什麼貨我可以幫你留意一下',
  '我平常幫人找跨境的東西啦，吃穿住行類的都能幫你看',
  '我做的是跨境電商耶，各方面要找東西都可以問我，幫你比價找貨',
];

export async function generateTakeoverReply(opts: {
  friendName: string;
  lastMessage: string;
  trigger: Exclude<TakeoverTrigger, null>;
  context?: string;
}): Promise<string> {
  const claw = getOpenClaw();

  if (opts.trigger === 'level1_intro') {
    const system = `你是台灣本地網友，剛認識的朋友問你「你是做什麼的」。一級響應：自然自然地介紹自己是做跨境電商的（吃穿住行都可以找我看看，網購我可以幫你去找貨比價），語氣要像朋友隨口說，不要推銷、不要發連結、不要報價格。只回一句 20-40 字的話（繁體中文）。`;
    const user = `對方最後一句：「${opts.lastMessage}」。` +
      (opts.context ? `\n\n你對這個帳號的記憶：\n${opts.context}` : '') +
      `\n請回一句自然的一級介紹（只輸出那句話，不要解釋）。`;
    const r = await claw.chat(system, user, 60);
    if (r && r.trim().length > 2) return r.trim().slice(0, 60);
    return LEVEL1_FALLBACK[Math.floor(Math.random() * LEVEL1_FALLBACK.length)];
  }

  // 普通聊天接管：復用擬真台式回覆（仍過安全濾網）
  return generateChatReply({
    friendName: opts.friendName,
    lastMessage: opts.lastMessage,
    stage: undefined,
  });
}
