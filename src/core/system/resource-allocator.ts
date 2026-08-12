/**
 * ResourceAllocator — 資源感知任務分配（需求 D）
 *
 * 依當前電腦配置 + 剩餘可分配資源，合理決定「同時能開幾個瀏覽器實例」。
 *
 * 啟發式：
 * - 每個 Chromium 實例約耗 PER_CHROMIUM_MEM_MB 記憶體、約 0.5 核 CPU
 * - 保留系統 RESERVE_MEM_MB / RESERVE_CPU 避免把機器跑死
 * - maxConcurrent = min( 依剩餘 RAM 算, 依 CPU 算, HARD_CAP )
 * - 啟動新瀏覽器前做准入控制：超過上限或記憶體不足就等待，避免雪崩
 */
import { getSystemProfile, getLiveResources } from './system-profiler';

export const RESOURCE_CONFIG = {
  perChromiumMemMB: 500, // 單個 Chromium 實例預估耗用
  reserveMemMB: 2048, // 保留給系統/其他程式
  reserveCpu: 2, // 保留給系統的 CPU 核心
  hardCap: 16, // 硬上限，防止單機開過多
  admitMemBufferMB: 256, // 准入時額外緩衝
};

/** 目前允許的最大並發瀏覽器數 */
export function getMaxConcurrent(): number {
  const live = getLiveResources();
  const memCap = Math.floor(Math.max(0, live.freeMemMB - RESOURCE_CONFIG.reserveMemMB) / RESOURCE_CONFIG.perChromiumMemMB);
  const cpuCap = Math.max(1, live.cpuCores - RESOURCE_CONFIG.reserveCpu);
  return Math.max(1, Math.min(memCap, cpuCap, RESOURCE_CONFIG.hardCap));
}

/** 當前負載快照（供 UI / API 展示） */
export function getResourceLoad(activeCount: number): {
  active: number;
  max: number;
  freeMemMB: number;
  cpuCores: number;
  cpuModel: string;
  memPct: number;
  cpuPct: number;
} {
  const live = getLiveResources();
  const prof = getSystemProfile();
  const max = getMaxConcurrent();
  const memPct = live.totalMemMB > 0 ? Math.round((1 - live.freeMemMB / live.totalMemMB) * 100) : 0;
  const cpuPct = max > 0 ? Math.round((activeCount / max) * 100) : 0;
  return {
    active: activeCount,
    max,
    freeMemMB: live.freeMemMB,
    cpuCores: live.cpuCores,
    cpuModel: prof.cpuModel,
    memPct,
    cpuPct,
  };
}

/**
 * 准入控制：在啟動新瀏覽器前呼叫。
 * 若當前已開數 >= 上限，或剩餘記憶體不足，則輪詢等待直到有餘裕或超時。
 * @returns true=允許啟動；false=逾時未獲得餘裕（呼叫方可決定放棄或繼續）
 */
export async function admitBrowser(currentCount: number, timeoutMs = 5 * 60 * 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // 立即試一次（避免無謂等待）
  if (tryAdmit(currentCount)) return true;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (tryAdmit(currentCount)) return true;
  }
  return false;
}

function tryAdmit(currentCount: number): boolean {
  const max = getMaxConcurrent();
  const live = getLiveResources();
  return currentCount < max && live.freeMemMB > RESOURCE_CONFIG.perChromiumMemMB + RESOURCE_CONFIG.admitMemBufferMB;
}
