/**
 * 全局监控子系统 — 周期采集系统配置 / 资源负载 / 活跃 session / 近期错误 /
 * OpenClaw Agent 健康 / 任务吞吐，产出統一快照，供仪表盘「全局監控」面板與
 * /api/monitor/state 讀取。
 *
 * 設計：低開銷（默認 5s 一次快照，不阻塞請求）；快照環形緩存最近 60 次。
 */
import * as fs from 'fs';
import * as path from 'path';
import { getSystemProfile, getLiveResources, SystemProfile } from '../system/system-profiler';
import { getResourceLoad } from '../system/resource-allocator';
import { listActiveSessions } from '../browser/session-manager';
import { getRecentLogs } from '../logger';
import { getAgentHealth, getLatestSuperviseReport } from '../agent/agent-monitor';
import { getAllWatchdogViews } from '../agent/session-watchdog';
import { ensureAccountDefaults } from '../account-store';
import { DATA_DIR } from '../../config';

export interface ActiveSessionView {
  accountId: string;
  name: string;
  status: string;
  url: string;
  pid?: number;
  startedAt: number;
  uptimeSec: number;
  blocker?: string | null;
  stuckSince?: number | null;
  lastWatchdogAction?: string | null;
}

export interface MonitorSnapshot {
  ts: number;
  uptimeSec: number;
  system: SystemProfile & { freeRamGB: number; cpuCores: number };
  load: { active: number; max: number; memPct: number; cpuPct: number };
  activeSessions: ActiveSessionView[];
  accounts: { accountId: string; name: string; status: string; mode: string }[];
  recentErrors: { time: string; level: string; module: string; message: string }[];
  agent: {
    llmReachable: boolean;
    lastCallAt: number | null;
    lastSuperviseAt: number | null;
    errorCount: number;
    autoSuperviseOn: boolean;
    summary: string;
    suggestions: string[];
  };
  taskThroughput: { lastMinute: number; recent: any[] };
}

const HISTORY_FILE = path.join(DATA_DIR, 'task-history.json');
const SNAPSHOT_RING = 60;
const snapshots: MonitorSnapshot[] = [];
let lastSnapshot: MonitorSnapshot | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const startTime = Date.now();

function readHistory(): any[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {}
  return [];
}

export function collectSnapshot(): MonitorSnapshot {
  const now = Date.now();
  const profile = getSystemProfile();
  const live = getLiveResources();
  const load = getResourceLoad(listActiveSessions().length);

  const accMap = new Map(ensureAccountDefaults().map((a: any) => [a.accountId, a]));
  const watchdogMap = new Map(getAllWatchdogViews().map((w) => [w.accountId, w]));
  const activeRaw = listActiveSessions();
  const activeSessions: ActiveSessionView[] = activeRaw.map((s) => {
    const acc = accMap.get(s.accountId);
    const w = watchdogMap.get(s.accountId);
    return {
      accountId: s.accountId,
      name: acc?.name || s.accountId,
      status: acc?.status || 'unknown',
      url: s.url,
      pid: s.pid,
      startedAt: s.startedAt,
      uptimeSec: Math.round((now - s.startedAt) / 1000),
      blocker: w?.blocker || null,
      stuckSince: w?.stuckSince || null,
      lastWatchdogAction: w?.lastAction || null,
    };
  });

  const recentErrors = getRecentLogs(60)
    .filter((l) => l.level === 'error' || l.level === 'warn')
    .slice(-12)
    .map((l) => ({
      time: new Date(l.time).toLocaleTimeString('zh-TW'),
      level: l.level,
      module: l.module,
      message: l.message,
    }));

  const agentHealth = getAgentHealth();
  const report = getLatestSuperviseReport();
  const agent = {
    llmReachable: agentHealth.llmReachable,
    lastCallAt: agentHealth.lastCallAt,
    lastSuperviseAt: agentHealth.lastSuperviseAt,
    errorCount: agentHealth.errorCount,
    autoSuperviseOn: agentHealth.autoSuperviseOn,
    summary: report?.llmSummary || '（暫無監管報告，自動循環將週期生成）',
    suggestions: (report?.suggestions || []).slice(0, 5),
  };

  const hist = readHistory();
  const lastMinute = hist.filter((h: any) => Date.now() - new Date(h.time).getTime() < 60_000).length;

  const snap: MonitorSnapshot = {
    ts: now,
    uptimeSec: Math.round((now - startTime) / 1000),
    system: { ...profile, freeRamGB: live.freeMemMB / 1024, cpuCores: live.cpuCores },
    load: { active: load.active, max: load.max, memPct: load.memPct, cpuPct: load.cpuPct },
    activeSessions,
    accounts: ensureAccountDefaults().map((a: any) => ({
      accountId: a.accountId,
      name: a.name,
      status: a.status || 'idle',
      mode: a.mode || 'real',
    })),
    recentErrors,
    agent,
    taskThroughput: { lastMinute, recent: hist.slice(0, 8) },
  };

  snapshots.push(snap);
  if (snapshots.length > SNAPSHOT_RING) snapshots.shift();
  lastSnapshot = snap;
  return snap;
}

export function getMonitorSnapshot(force = false): MonitorSnapshot {
  if (force || !lastSnapshot) return collectSnapshot();
  return lastSnapshot;
}

export function getSnapshotHistory(): MonitorSnapshot[] {
  return snapshots;
}

export function startMonitor(intervalMs = 5000): void {
  if (timer) return;
  collectSnapshot();
  timer = setInterval(collectSnapshot, intervalMs);
}

export function stopMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
