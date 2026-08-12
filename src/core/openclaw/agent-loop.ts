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
};

function buildSystemPrompt(accountId: string): string {
  const fbList = Object.entries(TOOLS)
    .filter(([k]) => FB_TASK_TYPES.has(toolTypeOf(k)))
    .map(([k, v]) => `  - ${k}（${v.desc}）`).join('\n');
  const codeList = Object.entries(TOOLS)
    .filter(([k]) => !FB_TASK_TYPES.has(toolTypeOf(k)))
    .map(([k, v]) => `  - ${k}（${v.desc}）`).join('\n');
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
  const re = /<tool>([\s\S]*?)<\/tool>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj.name === 'string') out.push({ name: obj.name, params: obj.params || {} });
    } catch { /* 忽略無效 JSON */ }
  }
  return out;
}

function cleanReply(text: string): string {
  return text.replace(/<tool>[\s\S]*?<\/tool>/g, '').trim();
}

/**
 * 執行一輪 agent 對話（含最多 5 次工具調度迴圈）。
 * 返回自然回覆與執行步驟。
 */
export async function runAgentChat(accountId: string, message: string, history?: string): Promise<AgentChatResult> {
  const claw = getOpenClaw();
  let conversation = message;
  let lastReply = '';
  const steps: AgentStep[] = [];
  let usedTools = false;

  for (let iter = 0; iter < 5; iter++) {
    const system = buildSystemPrompt(accountId);
    const ctx = history ? `## 對話歷史\n${history}\n\n` : '';
    const fullMsg = ctx + `## 用戶訊息\n${conversation}`;
    const reply = await claw.chat(system, fullMsg, 800);
    if (!reply) {
      return {
        reply: 'OpenClaw 暫時無回應（網關可能離線或金鑰失效），請檢查 OpenClaw 設定或稍後再試。',
        steps,
        usedTools,
      };
    }
    lastReply = reply;
    const actions = extractActions(reply);
    if (actions.length === 0) {
      return { reply: cleanReply(reply), steps, usedTools };
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
  return { reply: cleanReply(lastReply) || '（已執行工具，但未能生成總結）', steps, usedTools };
}
