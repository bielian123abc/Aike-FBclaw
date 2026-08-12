/**
 * SystemProfiler — 當前電腦配置識別
 *
 * 用途：
 * 1. 識別 CPU / RAM / GPU / OS / 螢幕解析度（需求 C）
 * 2. 提供即時可用資源（freemem / cpu 核心），供資源感知調度使用（需求 D）
 *
 * 實作：RAM / CPU 核心數直接取 Node `os`（跨平台、零依賴）；
 *       GPU / OS 名稱 / 螢幕解析度在 Windows 上用 PowerShell 取得，
 *       非 Windows 或 PowerShell 失敗時退回環境變數/預設值。
 */
import { execFileSync } from 'child_process';
import * as os from 'os';

export interface SystemProfile {
  cpuModel: string;
  cpuCores: number;
  totalRamGB: number;
  freeRamGB: number;
  gpu: string;
  os: string;
  arch: string;
  screen: { width: number; height: number };
}

let cache: { ts: number; profile: SystemProfile } | null = null;
const CACHE_TTL = 60_000;

function runPowerShell(script: string): string {
  // 前置 UTF-8 輸出編碼，避免中文（如 OS Caption「專業版」）被系統代碼頁解碼成亂碼
  const wrapped = '$OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + script;
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', wrapped], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim();
  } catch {
    return '';
  }
}

/** 螢幕解析度（Windows 透過 System.Windows.Forms；失敗退回預設 1920x1080） */
export function getScreenResolution(): { width: number; height: number } {
  const out = runPowerShell(
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
    '"{0},{1}" -f $b.Width,$b.Height'
  );
  const m = out.match(/(\d+)\s*,\s*(\d+)/);
  if (m) return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
  const w = parseInt(process.env.SCREEN_W || '1920', 10);
  const h = parseInt(process.env.SCREEN_H || '1080', 10);
  return { width: w, height: h };
}

/** 即時可用資源（Node os 直接取得，不需 PowerShell） */
export function getLiveResources(): { totalMemMB: number; freeMemMB: number; cpuCores: number } {
  return {
    totalMemMB: Math.round(os.totalmem() / 1048576),
    freeMemMB: Math.round(os.freemem() / 1048576),
    cpuCores: os.cpus().length,
  };
}

/** 完整系統配置（含 60s 快取） */
export function getSystemProfile(): SystemProfile {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL) return cache.profile;

  const live = getLiveResources();
  const screen = getScreenResolution();

  const ps = runPowerShell(
    '$e=(Get-CimInstance Win32_OperatingSystem).Caption; ' +
    '$p=(Get-CimInstance Win32_Processor)[0].Name; ' +
    '$g=(Get-CimInstance Win32_VideoController)[0].Name; ' +
    '"{0}|||{1}|||{2}" -f $e,$p,$g'
  ).replace(/\r/g, '');
  const parts = ps.split('|||').map((s) => s.trim());

  const profile: SystemProfile = {
    os: parts[0] || `${os.type()} ${os.release()}`,
    cpuModel: parts[1] || os.cpus()[0]?.model || 'Unknown',
    gpu: parts[2] || 'Unknown',
    cpuCores: live.cpuCores,
    totalRamGB: Math.round(live.totalMemMB / 1024),
    freeRamGB: Math.round(live.freeMemMB / 1024),
    arch: os.arch(),
    screen,
  };

  cache = { ts: now, profile };
  return profile;
}
