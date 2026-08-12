/**
 * Onboarding — 自愈式「首登管線」
 *
 * 設計目標（用戶要求）：
 *   1. 把散落的首登邏輯（語言 / 頭像 / PIN / 主頁點讚）收口成統一管線。
 *   2. 每次開號都執行：先「智能檢測」每一步是否已完成；
 *      - 檢測到已完成 → 標記 done（method:'detected'，不動作）。
 *      - 檢測不到 → 執行修復（run），修復後再檢測確認。
 *   3. 形成「單帳號記憶」（存 AccountMemory.onboarding），二次登入時若發現
 *      某步已被滿足（語言已切、頭像已換、PIN 已建、主頁已讚）即標已完成、不再重做。
 *   4. 四步全 done 才 allComplete；循環直到全部確認完成。
 *
 * 可擴充性：未來新增首登步驟只需在 ONBOARDING_STEPS 陣列加一筆
 * { id, label, detect, run }，無需改動 ensureSession。
 */
import type { Page } from 'playwright-core';
import { AccountMemory, StoredOnboardingState, OnboardingStepState } from '../memory/account-memory';
import * as skills from '../skills/fb-core-skills';
import { handleMessengerPin, isFbLangTw } from '../skills/fb-core-skills';
import { accountHasAvatar } from './avatar';
import { getAccount } from './account-store';
import { ONBOARDING_SEED_LIKE_URL, MOCK_FB, MOCK_FB_PORT } from '../config';
import { randomDelay } from '../utils/human-behavior';

// ---------------- 類型 ----------------

export interface OnboardingContext {
  page: Page;
  accountId: string;
  memory: AccountMemory;
}

export interface OnboardingStepResult {
  ok: boolean;
  skipped?: boolean;   // 無需設定（如庫內無頭像圖、PIN 無對話框）
  error?: string;
}

export interface OnboardingStep {
  id: string;
  label: string;
  optional?: boolean;
  /** 檢測該步是否已滿足；回傳 true = 已完成（不動作） */
  detect(ctx: OnboardingContext): Promise<boolean>;
  /** 修復/設定；僅在 detect 回傳 false 時調用 */
  run(ctx: OnboardingContext): Promise<OnboardingStepResult>;
}

// ---------------- 模式判斷 ----------------

/** 是否處於 Mock FB 模式：帳號 mode 優先，否則跟隨全局 MOCK_FB */
function isMockMode(accountId: string): boolean {
  const acc = getAccount(accountId);
  if (acc?.mode === 'mock') return true;
  if (acc?.mode === 'real') return false;
  return MOCK_FB;
}

function mockBase(): string {
  return `http://127.0.0.1:${MOCK_FB_PORT}`;
}

// ---------------- 四步驟登記 ----------------

export const ONBOARDING_STEPS: OnboardingStep[] = [
  // ① 語言：設為繁體中文(台灣)
  {
    id: 'language',
    label: '語言設為繁體中文(台灣)',
    detect: async (ctx) => {
      try { return await isFbLangTw(ctx.page); } catch { return false; }
    },
    run: async (ctx) => {
      const r = await skills.skillSetLanguageTaiwan(ctx);
      return { ok: r.success, error: r.error };
    },
  },

  // ② 頭像：自動更換（一生一次、跨帳號去重）
  {
    id: 'avatar',
    label: '自動更換頭像(一生一次/跨帳號去重)',
    detect: async (ctx) => accountHasAvatar(ctx.accountId),
    run: async (ctx) => {
      const r = await skills.skillSetAvatar(ctx);
      return { ok: r.success, skipped: !!r.data?.skipped, error: r.error };
    },
  },

  // ③ Messenger 端對端加密 PIN
  {
    id: 'pin',
    label: 'Messenger 端對端加密 PIN',
    detect: async (ctx) => {
      if (isMockMode(ctx.accountId)) {
        try {
          await ctx.page.goto(mockBase() + '/settings/messenger-pin', { waitUntil: 'domcontentloaded', timeout: 20000 });
          await randomDelay(500, 1000);
          const pw = await ctx.page.$$('input[type="password"]');
          if (pw.length > 0) return false; // 仍有設定對話框 => 尚未建立
          const txt = await ctx.page.evaluate(() => (document.body?.innerText || '')).catch(() => '');
          return /已設定|established|set up/i.test(txt);
        } catch { return false; }
      }
      // real 模式：PIN 為被動觸發（對話框出現才處理），無法主動可靠檢測；依賴記憶體標記
      const st = ctx.memory.getOnboarding()?.steps?.['pin'];
      return !!st?.done;
    },
    run: async (ctx) => {
      if (isMockMode(ctx.accountId)) {
        try {
          await ctx.page.goto(mockBase() + '/settings/messenger-pin', { waitUntil: 'domcontentloaded', timeout: 20000 });
          await randomDelay(800, 1500);
        } catch { /* 頁面若不存在則不強制（real 模式不會走到這裡） */ }
      }
      const r = await handleMessengerPin(ctx);
      if (r.handled) return { ok: true };
      if (r.error) return { ok: false, error: r.error };
      // 當前頁面沒有 PIN 對話框 => 視為已建立（被動模式），標記完成
      return { ok: true, skipped: true };
    },
  },

  // ④ 主頁點讚：指定種子粉絲頁（未配置 URL 時整步跳過）
  {
    id: 'like',
    label: '主頁點讚(指定種子粉絲頁)',
    detect: async (ctx) => {
      if (!ONBOARDING_SEED_LIKE_URL) return true; // 未配置 = 視為已完成，直接跳過
      try {
        await ctx.page.goto(ONBOARDING_SEED_LIKE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await randomDelay(600, 1200);
        const liked = await ctx.page.evaluate(() => {
          const el = document.querySelector('div[aria-label="Like"]');
          return el ? el.getAttribute('aria-pressed') === 'true' : false;
        }).catch(() => false);
        return liked;
      } catch { return false; }
    },
    run: async (ctx) => {
      if (!ONBOARDING_SEED_LIKE_URL) return { ok: true, skipped: true };
      const r = await skills.skillLikePost(ctx, { postUrl: ONBOARDING_SEED_LIKE_URL, reaction: 'like' });
      return { ok: r.success, error: r.error };
    },
  },
];

// ---------------- 管線主流程 ----------------

/**
 * 執行一次完整 onboarding 檢測與修復。
 * - 每一步先 detect → 已完成則標 done(method:'detected')，不動作；
 * - detect 不到才 run 修復，修復後再 detect 確認；
 * - 每步獨立 try/catch，互不影響；
 * - 結果寫入 AccountMemory.onboarding（單帳號記憶）。
 * @returns 最新 onboarding 狀態（含 allComplete）
 */
export async function runOnboarding(
  page: Page,
  accountId: string,
  memory: AccountMemory,
): Promise<StoredOnboardingState> {
  const ctx: OnboardingContext = { page, accountId, memory };
  const state: StoredOnboardingState = {
    steps: {},
    allComplete: false,
    lastCheckedAt: Date.now(),
  };

  for (const step of ONBOARDING_STEPS) {
    const stepState: OnboardingStepState = { done: false };
    try {
      const alreadyDone = await step.detect(ctx);
      if (alreadyDone) {
        stepState.done = true;
        stepState.method = 'detected';
        stepState.at = Date.now();
        console.log(`[onboarding ${accountId}] ${step.label}: 已檢測完成(detected)`);
      } else {
        const r = await step.run(ctx);
        if (r.ok) {
          // 修復後再檢測確認是否真的完成
          const confirmed = await step.detect(ctx).catch(() => true);
          stepState.done = confirmed;
          stepState.method = r.skipped ? 'skipped' : 'applied';
          stepState.at = Date.now();
          console.log(`[onboarding ${accountId}] ${step.label}: ${r.skipped ? '無需設定(跳過)' : '已修復'} → 確認${confirmed ? '完成' : '仍進行中'}`);
        } else {
          stepState.done = false;
          stepState.error = r.error;
          console.warn(`[onboarding ${accountId}] ${step.label}: 修復失敗: ${r.error}`);
        }
      }
    } catch (e: any) {
      stepState.done = false;
      stepState.error = e?.message || String(e);
      console.warn(`[onboarding ${accountId}] ${step.label}: 執行異常 ${stepState.error}`);
    }
    state.steps[step.id] = stepState;
  }

  const required = ONBOARDING_STEPS.filter(s => !s.optional);
  state.allComplete = required.every(s => state.steps[s.id]?.done);
  memory.setOnboarding(state);
  return state;
}
