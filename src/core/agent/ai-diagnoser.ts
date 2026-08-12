/**
 * AI 解析器自主修復回路（看門狗的「未知內容」處理器）
 *
 * 使用者痛點：FB 驗證/彈窗類型逐年爆炸式增加（視頻自拍、證件上傳、We need to
 * confirm it's you、申訴流程…），窮舉每一種不現實。本模塊讓看門狗遇到
 * custom_dialog / unknown 時，把現場快照交給 OpenClaw 診斷，並只執行「安全動作」。
 *
 * 安全邊界（最高約束，不可逾越）：
 * - 只允許：ESC、回首頁、點擊「關閉/取消/稍後/Not Now/Close」類安全按鈕。
 * - 絕不允許：點擊「確認/刪除/提交/永久/Verify/Continue 到下一步驗證」等可能不可逆的動作。
 * - 若 AI 判定 risk=human（需人工證件/自拍/身分），一律不走自動點擊，交由看門狗
 *   既有的「移出自動化 + 導出」或「暫停 + 告警」流程（不誤傷帳號）。
 * - 任何診斷/動作都寫入該帳號記憶 + 全域修復庫（成功模式可複用）。
 */
import { runOpenClawAgent } from '../openclaw/engine';
import { appendGlobalKnowledge } from '../openclaw/memory-service';

export type RiskLevel = 'safe' | 'caution' | 'human';

export interface Diagnosis {
  what: string;        // 這是什麼
  risk: RiskLevel;     // 風險等級
  action: string;      // 建議動作（選擇器 / ESC / 回首頁 / 需人工）
  raw?: string;
  error?: string;
}

interface Snap {
  url: string;
  title: string;
  text: string;
  dialogCount: number;
}

async function captureSnapshot(page: any): Promise<Snap> {
  try {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const info = await page.evaluate(() => {
      const main = (document as any).querySelector('[role="main"]') || document.body;
      const txt = (main ? main.innerText : '').replace(/\s+/g, ' ').slice(0, 600);
      const dialogs = (document as any).querySelectorAll('[role="dialog"], div[data-testid="modal"]').length;
      return { txt, dialogs };
    }).catch(() => ({ txt: '', dialogs: 0 }));
    return { url, title, text: info.txt, dialogCount: info.dialogs };
  } catch {
    return { url: '', title: '', text: '', dialogCount: 0 };
  }
}

/**
 * 把未知彈窗/頁面交給 OpenClaw 診斷。網關不可達時回傳 fallback（保守：視為需人工）。
 */
export async function analyzeUnknown(accountId: string, page: any): Promise<Diagnosis> {
  const snap = await captureSnapshot(page);
  const prompt =
    `你是一個 Facebook 多帳號自動化系統的「現場診斷員」。底下是某個帳號視窗出現的未知彈窗/頁面快照。\n` +
    `請判斷三件事，並只輸出嚴格 JSON（不要解釋）：\n` +
    `{\n` +
    `  "what": "用一句繁體中文說明這是什麼（如：FB 要求上傳身分證件驗證 / 一般通知彈窗 / 社群守則同意）",\n` +
    `  "risk": "safe 表示可安全關閉或忽略；caution 表示可能是某種驗證需謹慎；human 表示需人工處理（證件/自拍/身分/視頻驗證）",\n` +
    `  "action": "若 safe：給一個具體安全動作，只能是 "ESC" 或 "回首頁" 或一個 CSS 選擇器（只限關閉/取消/稍後類按鈕，絕不能是確認/刪除/提交）；若 human：填 "需人工"\n` +
    `}\n\n` +
    `快照：\nURL: ${snap.url}\nTITLE: ${snap.title}\n對話框數量: ${snap.dialogCount}\n頁面文字(截前600字):\n${snap.text}`;

  const res = await runOpenClawAgent(prompt, 400);
  if (!res) {
    return { what: '（OpenClaw 不可達，無法診斷）', risk: 'human', action: '需人工', error: 'gateway_unreachable' };
  }
  try {
    const m = res.match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      const risk: RiskLevel = j.risk === 'safe' ? 'safe' : j.risk === 'human' ? 'human' : 'caution';
      return { what: String(j.what || '未知'), risk, action: String(j.action || 'ESC'), raw: res };
    }
  } catch { /* ignore */ }
  // 無法解析 JSON：保守判 caution（不貿然點擊）
  return { what: '（AI 回傳無法解析）', risk: 'caution', action: 'ESC', raw: res, error: 'parse_fail' };
}

// 安全可點擊的按鈕文字/aria（絕不含 確認/刪除/提交/永久/verify/continue 等）
const SAFE_CLOSE_TEXT = ['關閉', '关闭', 'Close', '取消', '取消', 'Cancel', '稍後', '稍後再說', 'Not Now', '稍後再說', 'X', '✕', 'Done', '完成', '確定', '确定'];

function isSafeSelector(sel: string): boolean {
  const s = sel.toLowerCase();
  // 只接受包含安全關鍵字的選擇器；出現危險字眼一律拒絕
  const danger = ['confirm', 'delete', 'remove', 'submit', 'verify', 'continue', '永久', '確認', '刪除', '提交', '同意並', 'allow'];
  if (danger.some((d) => s.includes(d))) return false;
  return SAFE_CLOSE_TEXT.some((t) => s.includes(t.toLowerCase()) || s.includes(t.toLowerCase().replace('關閉', '关闭')));
}

/**
 * 執行安全動作。只允許 ESC / 回首頁 / 點擊安全關閉按鈕。返回執行結果描述。
 */
export async function executeSafeAction(page: any, accountId: string, action: string, baseUrl: string): Promise<string> {
  const a = (action || '').trim();
  try {
    if (/^esc$/i.test(a)) {
      await page.keyboard.press('Escape').catch(() => {});
      return '已按 ESC';
    }
    if (/回首頁|home|go home/i.test(a)) {
      await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      return '已回首頁';
    }
    if (a.startsWith('[') || a.startsWith('.') || a.startsWith('#') || a.toLowerCase().startsWith('div') || a.toLowerCase().startsWith('button')) {
      if (!isSafeSelector(a)) return '⚠ 拒絕執行非安全選擇器：' + a;
      const el = page.locator(a).first();
      if (await el.count()) {
        await el.click({ timeout: 4000 }).catch(() => {});
        return '已點擊安全按鈕：' + a;
      }
      return '未找到選擇器：' + a;
    }
    // 兜底：ESC
    await page.keyboard.press('Escape').catch(() => {});
    return '未識別動作，已按 ESC 兜底';
  } catch (e: any) {
    return '執行異常：' + e.message;
  }
}

/** 把一次成功的修復模式寫入全域修復庫（其它帳號下次遇到同類可直接參考） */
export function recordRepairPattern(accountId: string, diag: Diagnosis, acted: string): void {
  try {
    appendGlobalKnowledge(
      `### 看門狗自主修復案例（${new Date().toLocaleString('zh-TW')}）\n` +
      `- 帳號：${accountId}\n` +
      `- 現場判斷：${diag.what}\n` +
      `- 風險：${diag.risk}\n` +
      `- 採取動作：${acted}\n`
    );
  } catch { /* 不阻塞主流程 */ }
}
