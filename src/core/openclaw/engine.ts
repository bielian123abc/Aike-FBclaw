import { spawn } from 'child_process';
import * as path from 'path';
import * as net from 'net';
import { AI_CONFIG } from '../../config';

/**
 * OpenClaw AI Engine — 软件内「唯一」的 AI 智能體客户端
 *
 * 设计原则（用户要求）：软件本体只允许一个智能体 = OpenClaw。
 * - 所有 AI 推理（聊天/问候/发帖/意图解析/监管/接管）都经由此客户端。
 * - 背后的模型（如 DeepSeek）由 OpenClaw 服务侧配置，软件不直接持有其 key。
 * - 软件只通过 OpenClaw 网关（默认 :18789）与这一个智能体对话。
 *
 * 通信方式：经 openclaw.mjs CLI 委派（openclaw agent --agent main --message ... --json）。
 * 这是当前唯一稳定可用的程序化橋接通道（網關為 WebSocket RPC，需設備配對，
 * 直接裸連較脆弱；CLI 已內部處理配對）。
 */

const OPENCLAW_CLI = path.join(process.cwd(), 'node_modules', 'openclaw', 'openclaw.mjs');
const GATEWAY_PORT = 18789;

export interface OpenClawConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AIRequest {
  systemPrompt: string;
  userMessage: string;
  tools?: AITool[];
  context?: string;       // 从记忆体加载的上下文
  pageState?: string;     // 当前页面状态摘要
}

export interface AIResponse {
  text: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface AITool {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

const DEFAULT_CONFIG: Partial<OpenClawConfig> = {
  model: '',
  baseUrl: '',
  maxTokens: 4096,
  temperature: 0.7,
};

/** 網關是否可達（:18789） */
export function gatewayReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: GATEWAY_PORT }, () => { try { sock.destroy(); } catch {} resolve(true); });
    sock.on('error', () => { try { sock.destroy(); } catch {} resolve(false); });
    sock.setTimeout(1500, () => { try { sock.destroy(); } catch {} resolve(false); });
  });
}

/**
 * 委派給 OpenClaw 智能體（CLI 橋接）。
 * 成功回傳純文字回覆；網關不可達或失敗回傳 null（由呼叫方決定本地兜底）。
 */
export async function runOpenClawAgent(message: string, maxTokens?: number): Promise<string | null> {
  if (!(await gatewayReachable())) return null;
  // 注意：openclaw agent CLI 無 --max-tokens 旗標（會導致 exit 1 使所有呼叫失敗）；
  // token 長度控制改由呼叫方在收到回覆後自行截斷。
  const args = ['agent', '--agent', 'main', '--message', message, '--json'];
  return new Promise((resolve) => {
    let stdout = '';
    const proc = spawn(process.execPath, [OPENCLAW_CLI, ...args], {
      env: { ...process.env },
      windowsHide: true,
      timeout: 120000,
    });
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on('data', () => { /* 吞掉，避免刷屏 */ });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout);
        const payloads = parsed?.result?.payloads || [];
        const text = payloads.map((p: any) => p.text || '').join('\n').trim();
        resolve(text || null);
      } catch {
        const m = stdout.match(/"text"\s*:\s*"([^"]*)"/);
        resolve(m ? m[1] : (code === 0 ? stdout.trim() || null : null));
      }
    });
  });
}

export class OpenClawEngine {
  private config: OpenClawConfig;

  constructor(config: Partial<OpenClawConfig> & { apiKey: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config } as OpenClawConfig;
  }

  /**
   * 发送 AI 推理请求（统一经 OpenClaw CLI 委派）
   */
  async reason(request: AIRequest, maxTokensOverride?: number): Promise<AIResponse> {
    const parts: string[] = [this.buildSystemPrompt(request)];
    if (request.context) parts.push('## 账号记忆与上下文\n' + request.context);
    if (request.pageState) parts.push('## 当前页面状态\n' + request.pageState);
    parts.push('## 用户指令\n' + request.userMessage);
    const message = parts.join('\n\n');

    const text = await runOpenClawAgent(message, maxTokensOverride ?? this.config.maxTokens);
    if (text === null) return { text: '', finishReason: 'error' };
    return { text, finishReason: 'stop' };
  }

  /**
   * 构建系统 Prompt（台湾环境、繁体中文）
   */
  private buildSystemPrompt(request: AIRequest): string {
    return `你是一個 Facebook 社群運營 AI 智能體，專門協助管理多個 Facebook 帳號進行社群營銷。

## 你的身份
- 你正在操作一個真實的 Facebook 帳號
- 你的行為必須完全模仿真人用戶
- 你的語言環境：台灣、繁體中文 (zh-TW)
- 你的時區：Asia/Taipei (UTC+8)

## 核心原則
1. **安全第一**：任何操作前，先確認當前頁面狀態，避免在不正確的頁面執行錯誤操作
2. **擬人化**：所有操作必須有隨機延遲，避免機械化的固定時間模式
3. **狀態感知**：隨時注意頁面上的彈窗、警告、異常，並做出正確反應
4. **記憶追蹤**：記住與哪些好友互動過、給誰發過訊息、邀請過誰進社團
5. **你就是軟件本體**：你是 Aike-FBclaw 唯一的決策與執行智能體，軟件的所有功能都是你的「技能」，你應主動監控軟件狀態、賬號狀態與任務進度，並在適當時機主動接管（例如好友問「你是做什麼的」時，一級響應介紹自己是跨境電商，吃穿住行都能幫忙看貨找貨）

## 當前任務
${request.systemPrompt}
`;
  }

  /**
   * 快速决策：基于页面状态给出下一步建议
   */
  async decideNextAction(
    pageState: string,
    taskQueue: string,
    context: string
  ): Promise<{ action: string; params: Record<string, any>; reasoning: string }> {
    const response = await this.reason({
      systemPrompt: '请根据当前页面状态和任务队列，决定下一步应该执行什么操作。',
      userMessage: `页面状态: ${pageState}\n任务队列: ${taskQueue}\n账号上下文: ${context}\n\n请以JSON格式回复：{"action": "操作名", "params": {}, "reasoning": "原因"}`,
    });

    try {
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (_e: any) { /* ignore */ }

    return {
      action: 'check_status',
      params: {},
      reasoning: '无法解析 AI 决策，默认检查状态',
    };
  }

  /**
   * 分析操作结果并给出改进建议
   */
  async analyzeResult(
    action: string,
    result: any,
    previousAttempts: string
  ): Promise<{ success: boolean; suggestion: string; shouldRetry: boolean }> {
    const response = await this.reason({
      systemPrompt: '请分析操作结果，判断是否成功，并给改进建议。',
      userMessage: `操作: ${action}\n结果: ${JSON.stringify(result)}\n历史尝试: ${previousAttempts}`,
    });

    return {
      success: !response.text.includes('失败'),
      suggestion: response.text,
      shouldRetry: response.text.includes('重试'),
    };
  }

  /**
   * 便捷对话方法（供 ai-provider / intent-parser / 接管 等统一调用）。
   * 成功返回文本，失败/不可达返回 null（由调用方决定是否走本地兜底）。
   */
  async chat(system: string, user: string, maxTokens = 60): Promise<string | null> {
    const message = (system ? '【系統角色】\n' + system + '\n\n' : '') + '【用戶輸入】\n' + user;
    return runOpenClawAgent(message, maxTokens);
  }
}

// ---------------- 单例（软件内唯一的 OpenClaw 智能體客户端） ----------------
let _instance: OpenClawEngine | null = null;
export function getOpenClaw(): OpenClawEngine {
  if (!_instance) {
    _instance = new OpenClawEngine({
      apiKey: AI_CONFIG.openclawApiKey,
      model: AI_CONFIG.openclawModel,
      baseUrl: AI_CONFIG.openclawBaseUrl,
    });
  }
  return _instance;
}

/** 模型設置 UI 熱生效：依據最新 AI_CONFIG 重建引擎單例 */
export function reloadOpenClawConfig(): void {
  _instance = new OpenClawEngine({
    apiKey: AI_CONFIG.openclawApiKey,
    model: AI_CONFIG.openclawModel,
    baseUrl: AI_CONFIG.openclawBaseUrl,
  });
}
