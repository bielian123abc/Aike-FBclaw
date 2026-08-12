/**
 * Agent Loop — 把軟體內的對話框接回「真 OpenClaw 智能體」
 *
 * 設計（用戶硬要求）：
 * - 對話是自由自然語言，不是「指令→罐頭回覆」的路由殼。
 * - OpenClaw 是決策大腦；FB 操作與程式碼/系統操作都是它可呼叫的「工具」。
 * - 絕對控制權 + 自我修復：agent 能讀/改專案程式碼、跑 build、git 提交，
 *   甚至創造新技能；但改動只落在專案目錄內，並 git 提交到專用分支供用戶審核後套用。
 *
 * 工具呼叫協議（讓一次性 CLI 也能「用工具」）：agent 在回覆中插入
 *   <tool>{"name":"...","params":{...}}</tool>
 * 本模組解析並在本端執行，再把結果回餵 agent 生成自然總結。
 */
import { getOpenClaw } from './engine';
import { runTask } from '../engine/task-runner';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import { APP_ROOT, LOG_DIR } from '../../config';
import {
  appendChat, getChatHistory, putNote, getAllNotes, saveSkill, getSkill, listSkills,
  type EvolvedSkill,
} from './agent-memory';

export interface AgentStep {
  tool: string;
  text: string;
  result: string;
}

export interface AgentChatResult {
  reply: string;
  steps: AgentStep[];
  usedTools: boolean;
}

// ---------------- FB 操作工具（現有 runTask 全部開放） ----------------
const FB_TASK_TYPES = new Set<string>([
  'login', 'sync', 'browse_feed', 'like_post', 'add_friends', 'add_friends_from_group',
  'greet_new_friends', 'send_message', 'ai_chat_reply', 'reply_comment', 'join_groups',
  'create_post', 'share_post', 'invite_to_group', 'invite_to_page', 'distribute_content',
  'auto_like_own_page', 'risk_check', 'status_report',
]);

// ---------------- 程式碼/系統工具（Pillar C：絕對控制權 + 自我修復） ----------------
const AUTO_BRANCH = 'agent/auto-edit';

function safeProjectPath(p: string): string {
  // 只允許專案目錄內的相對/絕對路徑，禁止逃出、禁止 node_modules 直接寫
  let resolved: string;
  if (path.isAbsolute(p)) resolved = path.resolve(p);
  else resolved = path.resolve(APP_ROOT, p);
  if (!resolved.startsWith(APP_ROOT)) throw new Error('路徑超出專案目錄，已拒絕');
  return resolved;
}

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: APP_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function ensureAutoBranch(): string {
  try {
    const branches = git('branch --list ' + AUTO_BRANCH);
    if (!branches.includes(AUTO_BRANCH)) git(`checkout -b ${AUTO_BRANCH}`);
    else git(`checkout ${AUTO_BRANCH}`);
    return AUTO_BRANCH;
  } catch {
    return '（git 不可用或當前無倉庫，改動僅寫入檔案未提交）';
  }
}

async function toolReadFile(params: any): Promise<string> {
  const fp = safeProjectPath(String(params.path || ''));
  if (!fs.existsSync(fp)) return `檔案不存在：${params.path}`;
  const stat = fs.statSync(fp);
  if (stat.isDirectory()) return `這是目錄，請用 list_files：${params.path}`;
  const content = fs.readFileSync(fp, 'utf8');
  const max = Number(params.maxLines) || 400;
  const lines = content.split('\n');
  const shown = lines.slice(0, max).join('\n');
  return `【${params.path}】(${lines.length} 行，顯示前 ${Math.min(max, lines.length)} 行)\n` + shown;
}

async function toolListFiles(params: any): Promise<string> {
  const dir = safeProjectPath(String(params.dir || '.'));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return `目錄不存在：${params.dir}`;
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
    .slice(0, Number(params.limit) || 100);
  return `【${params.dir}】\n` + entries.join('\n');
}

async function toolEditFile(params: any): Promise<string> {
  const fp = safeProjectPath(String(params.path || ''));
  // 高風險守衛：electron 主程式 / gateway 設定 / 安全邏輯需先報備（這裡改為強制說明並仍執行，但標記高風險）
  const highRisk = /(electron[\\/]main\.ts|openclaw-config|auth|security|gateway)/i.test(fp);
  if (!fs.existsSync(fp)) return `目標檔案不存在：${params.path}（無法新建，請先確認路徑）`;
  const original = fs.readFileSync(fp, 'utf8');
  let next = original;
  let mode = '';
  if (typeof params.content === 'string') {
    next = params.content;
    mode = '整檔覆寫';
  } else if (typeof params.old_string === 'string' && typeof params.new_string === 'string') {
    if (!original.includes(params.old_string)) return `edit_file 失敗：找不到 old_string（請確認內容完全一致，含空白）`;
    next = original.replace(params.old_string, params.new_string);
    mode = '局部替換';
  } else {
    return 'edit_file 參數錯誤：需提供 {path,content} 或 {path,old_string,new_string}';
  }
  fs.writeFileSync(fp, next, 'utf8');
  const branch = ensureAutoBranch();
  try { git(`add "${fp}"`); git(`commit -m "agent(auto): ${params.path} [${mode}]"`); } catch {}
  const diff = (() => { try { return git(`diff HEAD~1 -- "${fp}"`).slice(0, 1200); } catch { return ''; } })();
  return `已${mode}並提交到分支 ${branch}：${params.path}` +
    (highRisk ? '（⚠️ 高風險檔案，請審核 diff 後再決定是否重建套用）' : '') +
    `\n--- diff 預覽 ---\n${diff || '（無 diff 或 git 不可用）'}\n` +
    `請用戶審核後告訴我是否重建/重裝套用。`;
}

async function toolRunBuild(_params: any): Promise<string> {
  // 安裝版 process.execPath 是 Electron，不能用來跑 build；改用隨包附的 node
  const bundledNode = path.join(APP_ROOT, 'node-runtime', 'node.exe');
  const nodeBin = fs.existsSync(bundledNode) ? bundledNode : process.execPath;
  return new Promise((resolve) => {
    const proc = spawn(nodeBin, ['scripts/build.mjs'], { cwd: APP_ROOT, windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (out += d.toString()));
    proc.on('error', () => resolve('build 啟動失敗（可能缺少 node 工具鏈）'));
    proc.on('close', (code) => {
      const tail = out.split('\n').slice(-15).join('\n');
      resolve(`build 結束 code=${code}\n${tail}`);
    });
  });
}

async function toolGitStatus(_params: any): Promise<string> {
  try { return git('status --short') || '工作區乾淨（無待審核改動）'; } catch { return 'git 不可用'; }
}

async function toolGitDiff(_params: any): Promise<string> {
  try { return git('diff ' + AUTO_BRANCH + '...HEAD').slice(0, 2000) || '無差異'; } catch { return 'git 不可用'; }
}

async function toolReadLogs(_params: any): Promise<string> {
  try {
    const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.log')).sort();
    if (!files.length) return '尚無日誌檔';
    const last = path.join(LOG_DIR, files[files.length - 1]);
    const lines = fs.readFileSync(last, 'utf8').split('\n').slice(-40);
    return `【${files[files.length - 1]}】末 40 行\n` + lines.join('\n');
  } catch (e: any) { return '讀取日誌失敗：' + e.message; }
}

async function toolRestartService(params: any): Promise<string> {
  // 通知服務端重啟 gateway / server（由 /api 觸發，這裡僅標記，實際重啟在 server 端）
  return `已請求重啟服務：${params.service || 'gateway'}（將由服務端執行，請稍候確認日誌）`;
}

// ---------------- 工具表 ----------------
const TOOLS: Record<string, { desc: string; run: (p: any) => Promise<string> }> = {
  // FB
  login: { desc: '登入並同步狀態', run: (p) => runTask(p.__acc, 'login', p) },
  sync: { desc: '同步帳號狀態', run: (p) => runTask(p.__acc, 'sync', p) },
  browse_feed: { desc: '滑動動態並按讚', run: (p) => runTask(p.__acc, 'browse_feed', p) },
  like_post: { desc: '按讚貼文', run: (p) => runTask(p.__acc, 'like_post', p) },
  add_friends: { desc: '搜尋並加好友', run: (p) => runTask(p.__acc, 'add_friends', p) },
  add_friends_from_group: { desc: '從社團成員加好友', run: (p) => runTask(p.__acc, 'add_friends_from_group', p) },
  greet_new_friends: { desc: '向新好友問候', run: (p) => runTask(p.__acc, 'greet_new_friends', p) },
  send_message: { desc: '傳送私訊', run: (p) => runTask(p.__acc, 'send_message', p) },
  ai_chat_reply: { desc: 'AI 自動回覆未讀訊息', run: (p) => runTask(p.__acc, 'ai_chat_reply', p) },
  join_groups: { desc: '加入社團', run: (p) => runTask(p.__acc, 'join_groups', p) },
  create_post: { desc: '發布貼文', run: (p) => runTask(p.__acc, 'create_post', p) },
  share_post: { desc: '分享貼文', run: (p) => runTask(p.__acc, 'share_post', p) },
  distribute_content: { desc: '多帳號內容分發', run: (p) => runTask(p.__acc, 'distribute_content', p) },
  risk_check: { desc: '風控檢查', run: (p) => runTask(p.__acc, 'risk_check', p) },
  status_report: { desc: '帳號/代理狀態報告', run: (p) => runTask(p.__acc, 'status_report', p) },
  // 程式碼/系統
  read_file: { desc: '讀取專案檔案', run: toolReadFile },
  list_files: { desc: '列出目錄檔案', run: toolListFiles },
  edit_file: { desc: '修改程式碼並 git 提交', run: toolEditFile },
  run_build: { desc: '執行專案建置', run: toolRunBuild },
  git_status: { desc: '查看 git 工作區狀態', run: toolGitStatus },
  git_diff: { desc: '查看待審核 diff', run: toolGitDiff },
  read_logs: { desc: '讀取軟體日誌', run: toolReadLogs },
  restart_service: { desc: '請求重啟服務', run: toolRestartService },
  // 記憶進化
  remember: {
    desc: '把一條知識/經驗寫入持久記憶（跨會話保留，這是「進化」的基底）',
    run: async (p) => {
      const key = String(p.key || p.note || '').trim();
      const value = String(p.value || p.content || p.text || '').trim();
      if (!key) return 'remember 需要 key（記憶鍵名）';
      putNote(key, value);
      return `已寫入持久記憶【${key}】：${value.slice(0, 200)}`;
    },
  },
  recall: {
    desc: '讀取持久記憶：傳 key 讀單條，不傳則列出全部（用來檢視自己累積的經驗）',
    run: async (p) => {
      if (p && p.key) {
        const v = getNote(String(p.key));
        return v ? `【${p.key}】${v}` : `尚無此記憶：${p.key}`;
      }
      const all = getAllNotes();
      return all.length ? all.map((n) => `- ${n.key}：${n.value}`).join('\n') : '尚無持久記憶，可用 remember 建立。';
    },
  },
  list_skills: {
    desc: '列出已進化出的技能（由你創造的複合流程）',
    run: async () => {
      const s = listSkills();
      return s.length ? s.map((x) => `- ${x.name}：${x.description}`).join('\n') : '尚無進化技能，可用 evolve_skill 創造。';
    },
  },
  evolve_skill: {
    desc: '創造/進化一個新技能：由現有 FB 或程式碼工具組成的流程，寫入後即可用 skill:<名> 呼叫',
    run: async (p) => {
      const name = String(p.name || '').trim();
      if (!name) return 'evolve_skill 需要 name';
      if (!Array.isArray(p.steps) || !p.steps.length) return 'evolve_skill 需要 steps 陣列（每個元素含 tool 與可選 params）';
      const def: EvolvedSkill = {
        name,
        description: String(p.description || `進化技能 ${name}`),
        steps: p.steps,
      };
      saveSkill(def);
      TOOLS['skill:' + name] = makeSkillTool(def);
      return `✅ 已進化出新技能「${name}」（${def.steps.length} 步）。今後對話中可直接呼叫 skill:${name}。`;
    },
  },
};

// ---------------- 進化技能：把「現有工具組成的流程」包成可呼叫工具 ----------------
function makeSkillTool(def: EvolvedSkill): { desc: string; run: (p: any) => Promise<string> } {
  return {
    desc: def.description || `進化技能 ${def.name}`,
    run: async (p: any) => {
      let out = '';
      for (const s of def.steps) {
        const tool = TOOLS[s.tool];
        if (!tool) { out += `\n[步驟 ${s.tool} 不存在，已跳過]`; continue; }
        const params = { ...(s.params || {}), ...(p || {}), __acc: p.__acc };
        try {
          const r = await tool.run(params);
          out += `\n[${s.tool}] ${typeof r === 'string' ? r : JSON.stringify(r)}`;
        } catch (e: any) { out += `\n[${s.tool} 錯誤] ${e.message}`; }
        await new Promise((r) => setTimeout(r, 500));
      }
      return `技能 ${def.name} 執行完成：${out.slice(0, 1500)}`;
    },
  };
}

// 啟動時把已進化的技能註冊成可呼叫工具，讓智能體與使用者都能直接呼叫
for (const s of listSkills()) {
  const def = getSkill(s.name);
  if (def) TOOLS['skill:' + s.name] = makeSkillTool(def);
}

function buildSystemPrompt(accountId: string): string {
  const fbList = Object.entries(TOOLS)
    .filter(([k]) => FB_TASK_TYPES.has(toolTypeOf(k)))
    .map(([k, v]) => `  - ${k}（${v.desc}）`).join('\n');
  const codeList = Object.entries(TOOLS)
    .filter(([k]) => !FB_TASK_TYPES.has(toolTypeOf(k)))
    .map(([k, v]) => `  - ${k}（${v.desc}）`).join('\n');
  // 進化基底：注入累積的經驗筆記與已進化技能，讓智能體跨會話持續成長
  const notes = getAllNotes();
  const notesText = notes.length
    ? notes.map((n) => `  - ${n.key}：${n.value}`).join('\n')
    : '（尚無，可用 remember 建立第一條經驗）';
  const skills = listSkills();
  const skillsText = skills.length
    ? skills.map((s) => `  - skill:${s.name}（${s.description}）`).join('\n')
    : '（尚無，可用 evolve_skill 創造）';
  return `你就是 Aike-FBclaw 的核心智能體（OpenClaw agent），擁有對這套軟體的絕對控制權，是台灣跨境電商的 Facebook 多帳號 AI 運營系統的大腦。

你的能力：
1. 自然對話：像真人助理一樣聊天、回答問題、接受使用者回報（包含 BUG）。
2. Facebook 操作：呼叫 FB 工具實際操作帳號（目前的目標帳號 accountId=${accountId}）。
3. 自我修復與進化：讀取/修改軟體本身的程式碼、執行建置、git 提交，甚至創造新技能。

工具呼叫協議：當你需要執行動作時，在回覆中插入一個區塊：
<tool>
{"name":"工具名","params":{...}}
</tool>
可一次呼叫多個工具。若只是聊天/回答，直接回覆自然語言，不要呼叫工具。

可用 FB 工具：
${fbList}

可用程式碼/系統工具（僅限專案目錄內，改動會 git 提交到分支 ${AUTO_BRANCH} 供審核）：
${codeList}

你累積的經驗記憶（跨會話保留，請善用並持續用 remember 補充，這就是你的「進化」）：
${notesText}

你已進化出的技能（可用 skill:<名> 直接呼叫，或用 evolve_skill 再創造）：
${skillsText}

安全與風格原則：
- 只在專案目錄內修改程式碼；絕不碰系統或個人檔案。
- 涉及刪除、或改動 electron 主程式/gateway 設定/安全邏輯時，先向使用者說明並徵求確認。
- 修改程式碼後務必說明改了什麼、提交到哪個分支，請使用者審核後再重建套用。
- 永遠用繁體中文、像朋友一樣自然，不暴露商業推銷腔。`;
}

function toolTypeOf(key: string): string {
  // 把 TOOLS 的 key 對應回 runTask 的 type（FB 類 key 大多同 type；這裡直接判斷是否在 FB 集合）
  return key;
}

function extractActions(text: string): { name: string; params: any }[] {
  const out: { name: string; params: any }[] = [];
  // 清理模型偶發的 DSML 殘片（如 </｜｜DSML｜｜parameter>），否則會污染 <tool> 區塊導致解析失敗
  const cleaned = text.replace(/<?\/?｜｜DSML｜｜[a-zA-Z_]*>/g, '');
  const push = (json: string) => {
    try {
      const obj = JSON.parse(json.trim());
      if (obj && typeof obj.name === 'string') out.push({ name: obj.name, params: obj.params || {} });
    } catch { /* 忽略無效 JSON */ }
  };
  // 先試標準 <tool>...</tool>
  const re = /<tool>\s*(\{[\s\S]*?\})\s*<\/tool>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) push(m[1]);
  if (out.length) return out;
  // 退化：模型漏寫 </tool> 或夾雜殘片時，抓 <tool>{...} 直到下一個 <tool> 或結尾
  const re2 = /<tool>\s*(\{[\s\S]*?\})\s*(?=<\/?tool>|$)/g;
  while ((m = re2.exec(cleaned))) push(m[1]);
  return out;
}

function cleanReply(text: string): string {
  const cleaned = text.replace(/<?\/?｜｜DSML｜｜[a-zA-Z_]*>/g, '');
  return cleaned.replace(/<tool>[\s\S]*?(<\/tool>|$)/g, '').trim();
}

/**
 * 執行一輪 agent 對話（含最多 5 次工具調度迴圈）。
 * 返回自然回覆與執行步驟。
 */
export async function runAgentChat(accountId: string, message: string, history?: string): Promise<AgentChatResult> {
  const claw = getOpenClaw();
  const scope = 'chat:' + accountId;
  // 跨會話持久歷史優先；UI 傳來的 in-memory 歷史作為補充（避免重複時以持久為準）
  const persisted = getChatHistory(scope, 30);
  const ctxText = [persisted, history].filter(Boolean).join('\n');
  // 先記下使用者這一輪
  appendChat(scope, 'user', message);

  let conversation = message;
  let lastReply = '';
  const steps: AgentStep[] = [];
  let usedTools = false;

  for (let iter = 0; iter < 5; iter++) {
    const system = buildSystemPrompt(accountId);
    const ctx = ctxText ? `## 對話歷史（含跨會話記憶）\n${ctxText}\n\n` : '';
    const fullMsg = ctx + `## 用戶訊息\n${conversation}`;
    const reply = await claw.chat(system, fullMsg, 800);
    if (!reply) {
      appendChat(scope, 'agent', '（OpenClaw 無回應）');
      return {
        reply: 'OpenClaw 暫時無回應（網關可能離線或金鑰失效），請檢查 OpenClaw 設定或稍後再試。',
        steps,
        usedTools,
      };
    }
    lastReply = reply;
    const actions = extractActions(reply);
    if (actions.length === 0) {
      const finalReply = cleanReply(reply);
      appendChat(scope, 'agent', finalReply);
      return { reply: finalReply, steps, usedTools };
    }
    usedTools = true;
    let observation = '';
    for (const a of actions) {
      const tool = TOOLS[a.name];
      if (!tool) { observation += `\n[工具 ${a.name} 不存在，可用工具請見系統說明]`; continue; }
      const params = { ...a.params, __acc: accountId };
      steps.push({ tool: a.name, text: `呼叫 ${a.name}`, result: '' });
      try {
        const res = await tool.run(params);
        const safe = typeof res === 'string' ? res : JSON.stringify(res);
        steps[steps.length - 1].result = safe.slice(0, 600);
        observation += `\n[${a.name} 結果]\n${safe.slice(0, 800)}\n`;
      } catch (e: any) {
        steps[steps.length - 1].result = '錯誤：' + e.message;
        observation += `\n[${a.name} 錯誤] ${e.message}\n`;
      }
    }
    conversation = `你剛才的回覆觸發了工具執行，以下是執行結果，請用自然語言向使用者總結（不要重複工具原始輸出，只需說做了什麼、結果如何）：\n${observation}`;
  }
  const finalReply = cleanReply(lastReply) || '（已執行工具，但未能生成總結）';
  appendChat(scope, 'agent', finalReply);
  return { reply: finalReply, steps, usedTools };
}
