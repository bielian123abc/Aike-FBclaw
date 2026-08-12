/**
 * OpenClaw 模型设置 + 一键修复
 *
 * 使用者需求：
 * 1. 把 OpenClaw 的模型配置（網址/金鑰/模型名）入口放到軟件「設置」界面，
 *    別人拿到軟件可直接填自己的模型 API。
 * 2. 一鍵修復：把 OpenClaw 配置恢復到「安全基線」(OpenClaw 自帶的 last-good)，
 *    但保留使用者在設置裡填的模型 API；帳號資料(accounts.json / 瀏覽器檔案)
 *    完全不被影響。
 *
 * 安全原則（極重要）：
 * - OpenClaw gateway 配置是 JSON5 + 嚴格校驗，亂寫會「拒絕啟動」。
 * - 因此「修復」絕不手寫整份配置，而是：備份 → 還原 OpenClaw 自帶的
 *   openclaw.json.last-good（保證 schema 合法）→ 再把使用者的模型 API 寫回。
 * - 網關會熱重載 openclaw.json 變更，無須我們重啟即可生效（寫入後仍主動重啟一次確保）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  DATA_DIR, OPENCLAW_CONFIG_FILE, OPENCLAW_GATEWAY_CONFIG, OPENCLAW_GATEWAY_LASTGOOD,
  setAIConfig,
} from '../../config';
import { reloadOpenClawConfig } from '../openclaw/engine';

export interface OpenClawSettings {
  baseUrl: string;   // 模型 API 基址，如 https://api.deepseek.com
  apiKey: string;    // 模型供應商金鑰
  model: string;     // 模型名，如 deepseek-chat
  updatedAt: number;
}

const DEFAULT_SETTINGS: OpenClawSettings = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  updatedAt: 0,
};

// ---------------- 我們軟件面向使用者的模型設置（data/openclaw-config.json） ----------------
export function getOpenClawSettings(): OpenClawSettings {
  try {
    if (fs.existsSync(OPENCLAW_CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_FILE, 'utf-8'));
      return { ...DEFAULT_SETTINGS, ...raw, updatedAt: raw.updatedAt || 0 };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettingsFile(s: OpenClawSettings): void {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  fs.writeFileSync(OPENCLAW_CONFIG_FILE, JSON.stringify(s, null, 2));
}

// ---------------- 容錯 JSON5 解析（去掉 // 與 /* */ 註釋） ----------------
function tolerantParse(text: string): any {
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  try {
    let t = text.replace(/\/\*[\s\S]*?\*\//g, '');
    t = t.replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(t);
  } catch (e: any) {
    throw new Error('無法解析 OpenClaw 配置（可能不是合法 JSON）：' + e.message);
  }
}

/**
 * 把使用者模型設置安全寫入 OpenClaw 網關配置（auth.profiles + agents.defaults.model.primary）。
 * 讀-改-寫現有檔，絕不替換整份，避免破壞其它配置項。
 */
export function applySettingsToGateway(s: OpenClawSettings): { ok: boolean; error?: string } {
  try {
    if (!fs.existsSync(OPENCLAW_GATEWAY_CONFIG)) {
      return { ok: false, error: '找不到 OpenClaw 配置檔，請先啟動過一次 OpenClaw' };
    }
    const cfg = tolerantParse(fs.readFileSync(OPENCLAW_GATEWAY_CONFIG, 'utf-8'));
    // 模型主設定
    cfg.agents = cfg.agents || {};
    cfg.agents.defaults = cfg.agents.defaults || {};
    cfg.agents.defaults.model = cfg.agents.defaults.model || {};
    if (s.model) cfg.agents.defaults.model.primary = 'deepseek/' + s.model.replace(/^deepseek\//, '');
    cfg.agents.defaults.models = cfg.agents.defaults.models || {};
    cfg.agents.defaults.models[cfg.agents.defaults.model.primary] = cfg.agents.defaults.models[cfg.agents.defaults.model.primary] || {};
    // DeepSeek 認證：新版 OpenClaw schema 禁止在 auth.profiles 寫 apiKey / baseUrl
    // （additionalProperties:false，僅允許 provider / mode / email / displayName）。
    // 金鑰改由網關啟動環境變數 DEEPSEEK_API_KEY 注入（見 server.ts ensureOpenClawGateway）。
    // profile 只保留合法欄位，並對齊 env 匯入產生的 profileId（deepseek:hermes-import）。
    cfg.auth = cfg.auth || {};
    cfg.auth.profiles = cfg.auth.profiles || {};
    delete cfg.auth.profiles['deepseek:manual'];           // 舊版曾含 apiKey，會導致 schema 非法
    cfg.auth.profiles['deepseek:hermes-import'] = { provider: 'deepseek', mode: 'api_key' };
    fs.writeFileSync(OPENCLAW_GATEWAY_CONFIG, JSON.stringify(cfg, null, 2));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * 儲存模型設置：寫我們的設定檔 + 套用到網關 + 熱重載本軟件引擎。
 * 返回 { ok, applied(網關是否套用成功), error? }
 */
export function saveOpenClawSettings(input: Partial<OpenClawSettings>): { ok: boolean; applied: boolean; error?: string } {
  const cur = getOpenClawSettings();
  const next: OpenClawSettings = {
    baseUrl: input.baseUrl ?? cur.baseUrl,
    apiKey: input.apiKey ?? cur.apiKey,
    model: input.model ?? cur.model,
    updatedAt: Date.now(),
  };
  saveSettingsFile(next);
  // 熱重載本軟件引擎（callLLM 通道）
  setAIConfig({ openclawApiKey: next.apiKey, openclawModel: next.model, openclawBaseUrl: next.baseUrl });
  reloadOpenClawConfig();
  // 套用到網關
  const applied = applySettingsToGateway(next);
  return { ok: true, applied: applied.ok, error: applied.error };
}

// ---------------- 一鍵修復 ----------------
export interface RepairResult {
  ok: boolean;
  steps: string[];
  error?: string;
}

/**
 * 修復 OpenClaw 網關配置（不碰帳號資料）。
 * 流程：備份當前 → 還原 last-good 安全基線 → 重新注入使用者模型 API → (由呼叫方重啟網關)。
 */
export function repairGatewayConfig(): RepairResult {
  const steps: string[] = [];
  try {
    if (!fs.existsSync(OPENCLAW_GATEWAY_CONFIG)) {
      return { ok: false, steps, error: '找不到 OpenClaw 配置檔' };
    }
    // 1) 備份
    const bak = OPENCLAW_GATEWAY_CONFIG + '.bak.' + Date.now();
    fs.copyFileSync(OPENCLAW_GATEWAY_CONFIG, bak);
    steps.push('已備份當前配置至 ' + path.basename(bak));

    // 2) 還原 last-good 安全基線（OpenClaw 自帶、保證 schema 合法）
    if (fs.existsSync(OPENCLAW_GATEWAY_LASTGOOD)) {
      fs.copyFileSync(OPENCLAW_GATEWAY_LASTGOOD, OPENCLAW_GATEWAY_CONFIG);
      steps.push('已還原 OpenClaw 安全基線 (openclaw.json.last-good)');
    } else {
      steps.push('無 last-good 基線，保留當前配置作為基線');
    }

    // 3) 重新注入使用者模型 API（智慧修復：不丟 Key）
    const s = getOpenClawSettings();
    const applied = applySettingsToGateway(s);
    if (applied.ok) steps.push('已重新注入模型 API（' + (s.model || '預設') + '）');
    else steps.push('⚠ 模型 API 注入失敗：' + (applied.error || '') + '（請在設置頁重新填寫）');

    steps.push('帳號資料（accounts.json / 瀏覽器檔案）完全未變動');
    return { ok: true, steps };
  } catch (e: any) {
    return { ok: false, steps, error: e.message };
  }
}

/**
 * 診斷 OpenClaw 網關配置是否可讀、是否含有使用者模型 API（供設置頁顯示健康度）。
 */
export function diagnoseGatewayConfig(): { readable: boolean; hasModel: boolean; hasApiKey: boolean; error?: string } {
  try {
    if (!fs.existsSync(OPENCLAW_GATEWAY_CONFIG)) return { readable: false, hasModel: false, hasApiKey: false, error: '找不到配置檔' };
    const cfg = tolerantParse(fs.readFileSync(OPENCLAW_GATEWAY_CONFIG, 'utf-8'));
    const primary = cfg?.agents?.defaults?.model?.primary || '';
    // 掃描所有 auth profiles（不只 deepseek:manual），任一有 apiKey 即視為已配置，
    // 避免「系統其實可用、設置頁卻顯示未配置」的誤導。
    const profiles = cfg?.auth?.profiles || {};
    // 新版 schema 不把金鑰存在 profile 中（改由環境變數 DEEPSEEK_API_KEY 注入），
    // 故「是否配置金鑰」以本軟件設定檔（data/openclaw-config.json）為準。
    const settings = getOpenClawSettings();
    let hasApiKey = !!settings.apiKey;
    if (!hasApiKey) {
      for (const k of Object.keys(profiles)) {
        const p = profiles[k] || {};
        if (p.apiKey) { hasApiKey = true; break; }
      }
    }
    return { readable: true, hasModel: !!primary, hasApiKey, error: undefined };
  } catch (e: any) {
    return { readable: false, hasModel: false, hasApiKey: false, error: e.message };
  }
}
