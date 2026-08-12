/**
 * 事件总线 / 实时感知层 — OpenClaw 智能體「眼睛」
 *
 * 用户要求：OpenClaw 必须实时感知软件在做什么、每个账号跑到哪一步、是否有新讯息。
 * 本模块提供：
 * 1. typed 事件（账号启动/停止、任务开始/完成/失败、聊天進來/回覆、接管、checkpoint）
 * 2. 环形缓冲（最近 N 条事件）供前端輪詢展示
 * 3. 每个账号的「实时状态快照」(perception)：当前状态、正在執行的任務、最後活躍、最近好友
 * 4. 重要事件（接管/驗證/聊天/失敗）落盘 data/memory/events.log 持久化
 *
 * 这是 leaf 模块，不依赖 task-runner / server，避免循環引用。
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../../config';

export type AppEventType =
  | 'account.started' | 'account.stopped' | 'account.status'
  | 'task.started' | 'task.completed' | 'task.failed'
  | 'chat.incoming' | 'chat.replied' | 'takeover'
  | 'checkpoint' | 'log'
  | 'watchdog.alert' | 'watchdog.action';

export interface AppEvent {
  type: AppEventType;
  ts: number;
  accountId?: string;
  // 各類型攜帶欄位
  status?: string;
  taskType?: string;
  success?: boolean;
  error?: string;
  friend?: string;
  message?: string;
  reply?: string;
  reason?: string;
  level?: string;
  blocker?: string;
  action?: string;
}

export interface PerceptionState {
  status: string;
  currentTask?: string;
  lastActive: number;
  lastFriend?: string;
}

const EVENTS_FILE = path.join(DATA_DIR, 'memory', 'events.log');
const IMPORTANT: AppEventType[] = ['takeover', 'checkpoint', 'chat.incoming', 'chat.replied', 'task.failed'];

class EventBus extends EventEmitter {
  private buffer: AppEvent[] = [];
  private perception: Map<string, PerceptionState> = new Map();
  private readonly MAX = 240;

  /** 推送一條事件，並同步更新感知快照 + 落盘重要事件 */
  record(e: AppEvent): void {
    this.buffer.push(e);
    if (this.buffer.length > this.MAX) this.buffer.shift();

    if (e.accountId) {
      const per = this.perception.get(e.accountId) || { status: 'offline', lastActive: e.ts };
      if (e.type === 'account.status') per.status = e.status || per.status;
      if (e.type === 'account.started') { per.status = 'idle'; }
      if (e.type === 'account.stopped') { per.status = 'offline'; per.currentTask = undefined; }
      if (e.type === 'task.started') { per.currentTask = e.taskType; per.status = 'running'; }
      if (e.type === 'task.completed' || e.type === 'task.failed') per.currentTask = undefined;
      if (e.type === 'chat.replied' || e.type === 'takeover') per.lastFriend = e.friend;
      per.lastActive = e.ts;
      this.perception.set(e.accountId, per);
    }

    if (IMPORTANT.includes(e.type)) {
      try { fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true }); fs.appendFileSync(EVENTS_FILE, JSON.stringify(e) + '\n'); } catch {}
    }
    this.emit('event', e);
  }

  getRecentEvents(limit = 60): AppEvent[] { return this.buffer.slice(-limit); }
  getPerception(): Record<string, PerceptionState> { return Object.fromEntries(this.perception); }
  reset(): void { this.buffer = []; }
}

export const bus = new EventBus();

export function emitAppEvent(e: Omit<AppEvent, 'ts'> & { ts?: number }): void {
  bus.record({ ...e, ts: e.ts ?? Date.now() });
}

export function getRecentEvents(limit = 60): AppEvent[] { return bus.getRecentEvents(limit); }
export function getPerception(): Record<string, PerceptionState> { return bus.getPerception(); }
export function onAppEvent(cb: (e: AppEvent) => void): void { bus.on('event', cb); }
