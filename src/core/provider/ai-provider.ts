/**
 * AI 提供层 — 统一封装聊天回覆 / 問候生成 / 內容生成
 *
 * 優先順序：DeepSeek 直連 → OpenClaw Gateway → 本地啟發式（保證系統可獨立運行）
 * 所有金鑰從 config 讀取，絕不硬编码。
 *
 * 安全原則（用户最高要求）：
 * - 人設 = 台湾本地普通网友，不营销、不暴露商业目的、不色情、不敏感、只正常聊天
 * - 每次生成都注入 PROJECT_BRIEF（项目移交文档）+ 安全红线
 * - 生成结果若命中 FORBIDDEN_TERMS 一律丢弃，退回本地安全兜底
 */
import { getOpenClaw } from '../openclaw/engine';
import { buildAgentSystemPrompt, violatesSafety, CONTENT_SAFETY_RULES, FORBIDDEN_TERMS } from '../agent/openclaw-context';

// ---------------- LLM 通道：唯一智能體 = OpenClaw（含重試/退避韌性，對應 PRD 4.7 重連需求） ----------------
export async function callLLM(roleHint: string, user: string, maxTokens = 60): Promise<string | null> {
  const system = buildAgentSystemPrompt(roleHint);
  const claw = getOpenClaw();
  // 唯一 AI 通道：OpenClaw 智能體（其背後模型如 DeepSeek 由 OpenClaw 服務配置，軟件不直連任何其它 AI）
  const channels: Array<() => Promise<string | null>> = [
    async () => (await claw.chat(system, user, maxTokens)) ?? null,
  ];

  for (const ch of channels) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await ch();
        // 安全過濾：命中紅線一律視為無效，逼迫走本地兜底
        if (res && !violatesSafety(res)) return res;
      } catch {
        if (attempt < 2) await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  return null;  // 上層函數以本地模板（localReply）作為純安全網兜底，不屬獨立 AI 通道
}

// ---------------- 本地啟發式（擬真台式聊天，安全兜底，無網路也可跑） ----------------
const GREET_REPLIES = ['嗨嗨', '哈囉', '嘿', '晚安～', '早啊', '最近好嗎', '欸欸', '好久不見'];
const LIFE_REPLIES = [
  '我昨天去吃了那間新的牛肉麵，超推',
  '這幾天天氣真的忽冷忽熱',
  '週末想去爬山，你有推薦的路線嗎',
  '最近在追那部劇，根本停不下來',
  '我家附近那間飲料店出新口味了',
  '今天上班累爆，想赶快回家躺平',
  '剛剛散步經過河堤，風超舒服',
  '昨晚失眠到三點，現在整個廢掉',
  '中午不知道要吃什麼，選擇障礙發作',
  '週五晚上終於可以放空一下',
];
const HOBBY_REPLIES = [
  '你也是做手工的喔？之後可以交流',
  '我也喜歡拍照，最近在練街拍',
  '養貓真的療癒，我家那隻超黏人',
  '你去的那个展覽好玩嗎，我也在考慮',
  '最近在學做甜點，失敗率有點高哈哈',
  '你也喜歡看球賽喔？上次那場超精彩',
  '我最近在拼圖，解壓神器',
  '聽說那家咖啡廳的蛋糕不錯，下次去試',
];
const QUESTION_REPLIES = [
  '我覺得可以啊，你後來怎麼處理的？',
  '這個我也遇到過，後來是這樣解決的',
  '嗯有道理，那你現在進度到哪了？',
  '真的耶，我也是這樣想的',
  '我跟你說，我也是這樣覺得',
  '那還不簡單，直接衝就對了',
  '你這樣問我反而想了一下，哈哈',
];
const DEFAULT_REPLIES = ['哈哈對', '嗯嗯了解', '真的假的', '好哦', '最近在忙什麼', '也是在線上晃晃', '我也這樣', '欸對', '說得也是', '哈哈哈有同感'];

// 避免短時間內對同一好友重複同一句（自然度）
const lastReplyByFriend: Record<string, { text: string; at: number }> = {};

function pick(arr: string[], avoid?: string): string {
  let choice = arr[Math.floor(Math.random() * arr.length)];
  // 若與上次相同，再抽一次（最多 3 次）以減少重複
  for (let i = 0; i < 3 && avoid && choice === avoid; i++) {
    choice = arr[Math.floor(Math.random() * arr.length)];
  }
  return choice;
}

function localReply(opts: { lastMessage: string; stage: string; friendName?: string }): string {
  const t = opts.lastMessage || '';
  const key = opts.friendName || 'default';
  const avoid = lastReplyByFriend[key] && Date.now() - lastReplyByFriend[key].at < 1000 * 60 * 30
    ? lastReplyByFriend[key].text : undefined;
  let reply: string;
  if (/嗎|？|\?|怎么|如何|哪|可以|建议|為什麼|為啥/.test(t)) reply = pick(QUESTION_REPLIES, avoid);
  else if (/社团|社團|聚會|活動|展覽|展|音樂|電影|劇|書|手工|貓|狗|攝影|爬山|旅行|旅遊|美食|吃|料理|運動|球|咖啡|甜點|拼圖/.test(t)) reply = pick(HOBBY_REPLIES, avoid);
  else if (/嗨|你好|哈囉|在嗎|早|晚安|不好意思|打擾/.test(t)) reply = pick(GREET_REPLIES, avoid);
  else reply = pick(DEFAULT_REPLIES, avoid);
  lastReplyByFriend[key] = { text: reply, at: Date.now() };
  return reply;
}

// ---------------- 對外 API ----------------

export interface ChatReplyInput {
  persona?: { name: string; style: string };
  friendName: string;
  lastMessage: string;
  history?: string[];
  stage?: string;
}

/** 生成一則擬真聊天回覆（台式口語、像朋友、只正常聊天、不暴露商業目的） */
export async function generateChatReply(input: ChatReplyInput): Promise<string> {
  const role = `你是正在和 FB 好友「${input.friendName}」聊天的台湾本地网友。生成一句 8-25 字、自然接話的朋友聊天，不营销、不客套、不 AI 腔、不主動提業務。若對方問問題就自然接話，聊生活/興趣/日常即可。`;
  const user = `對方最後一句：「${input.lastMessage}」。請回一句自然的台式聊天（只輸出那句話）。`;
  const llm = await callLLM(role, user, 40);
  if (llm && !violatesSafety(llm)) return llm.slice(0, 40);
  return localReply({ lastMessage: input.lastMessage, stage: input.stage || '新', friendName: input.friendName });
}

/** 好友通過後的個性化問候（普通网友開場，絕口不提業務） */
export async function generateGreeting(input: { friendName: string; profileInfo?: string }): Promise<string> {
  const role = `你是剛和 FB 新好友互加的台湾本地网友。寫一句 15-30 字、像真人主動開場的問候：可以自然提到在社团常看到對方、或對方公開資訊裡的興趣，但絕對不提任何業務/商業/購物。禁止「很高興認識你」之類模板。`;
  const info = input.profileInfo || '';
  const user = `新好友名稱：${input.friendName}。公開資訊：${info || '（隱私設定，看不到具體貼文）'}。請寫一句自然開場（只輸出那句話）。`;
  const llm = await callLLM(role, user, 50);
  if (llm && !violatesSafety(llm)) return llm.slice(0, 45);
  const local = [
    `在社團常看到你分享，想說加個好友以後多交流～`,
    `你也喜歡這個主题呀，方便認識一下嗎`,
    `看到你也有在玩這個，感覺應該聊得來哈哈`,
    `剛好刷到你的動態，想說認識一下～`,
  ];
  return pick(local);
}

/** 內容分發時的 AI 改寫（換詞不換意，10-20%），並做安全擦洗 */
export async function rewriteContent(text: string, seed: number): Promise<string> {
  const role = `你是社群內容編輯。請在不改變原意的情況下，用不同的說法重寫下面這段文案（換詞、調整語序），長度相近。只輸出重寫後的文案，不要解釋。注意：絕不可出現任何商業/推銷字眼。`;
  const llm = await callLLM(role, text, 120);
  if (llm && llm.length > 5 && !violatesSafety(llm)) return llm.trim();
  // 本地簡單改寫 + 安全擦洗
  const map: Record<string, string> = {
    '限時優惠': '最近發現', '新品上架': '新東西', '輸入折扣碼': '有興趣可以搜',
    '享9折': '還不錯', '推薦': '分享', '大家': '各位', '可以': '能夠',
    '購買': '看看', '下單': '關注', '販售': '分享',
  };
  let out = text;
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  for (const bad of FORBIDDEN_TERMS) out = out.split(bad).join('');
  const tails = ['', ' 一起交流～', ' 有興趣可以聊聊', ' 分享給大家'];
  return (out + tails[seed % tails.length]).trim();
}

/** 主動傳一則私訊開啟輕鬆聊天（台式口語、生活向、不暴露商業目的） */
export async function generateChatMessage(input: { toName: string; context?: string }): Promise<string> {
  const role = `你是台湾本地网友，正要主動傳一則私訊給 FB 好友「${input.toName}」開啟輕鬆聊天。寫一句 10-25 字、像朋友隨手傳的話（分享生活/興趣/問候），不营销、不客套、不 AI 腔、不提業務。只輸出那句話。`;
  const user = input.context
    ? `上下文：${input.context}。請寫一句自然的開場私訊（只輸出那句話）。`
    : `請寫一句自然的主動私訊給「${input.toName}」（只輸出那句話）。`;
  const llm = await callLLM(role, user, 40);
  if (llm && llm.length > 2 && !violatesSafety(llm)) return llm.slice(0, 40);
  const local = [
    '今天經過你提過那間店，突然想起你哈哈',
    '週末有什麼打算？',
    '剛看到一個有趣的事想分享給你',
    '好久沒聊，最近還好嗎',
    '你家附近那間飲料店我終於去喝了',
  ];
  return local[Math.floor(Math.random() * local.length)];
}

/** 生成一則貼文內容（普通网友分享生活/興趣，不賣貨） */
export async function generatePostContent(input: { topic?: string; persona?: string }): Promise<string> {
  const role = `你是台湾本地网友，寫一則 30-60 字、分享生活/興趣/心情的貼文，口語自然、像真人分享，絕不硬廣、不推銷、不出現商業字眼。`;
  const user = input.topic ? `想分享的主題靈感：${input.topic}（寫一則自然貼文，只輸出貼文本體）` : `寫一則今天隨手分享的生活貼文（只輸出貼文本體）`;
  const llm = await callLLM(role, user, 120);
  if (llm && llm.length > 5 && !violatesSafety(llm)) return llm.trim();
  const local = [
    '今天天氣不錯，溜達去附近的公園走走，順便買了杯手搖，生活的小確幸 🍃',
    '週末在家弄了頓飯，雖然賣相普通但味道還行，自己煮最安心',
    '最近在追這部劇，睡前忍不住多看一集，明天又要賴床了 😂',
    '跟朋友去了那間新開的店，氣氛很舒服，下次還想去',
  ];
  return local[Math.floor(Math.random() * local.length)];
}
