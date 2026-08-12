/**
 * Aike-FBclaw 结构化日志系统
 *
 * 功能：
 * - 四个日志级别: DEBUG / INFO / WARN / ERROR
 * - 控制台输出（带颜色和时间戳）
 * - 文件输出（自动轮转，保留最近 7 天）
 * - 按模块分类（Browser / Task / API / GW / Agent / Pool）
 * - 内存缓冲区（供 API / UI 查询）
 *
 * 用法：
 *   import { createLogger } from './core/logger.js';
 *   const log = createLogger('Task');
 *   log.info('任务开始', { accountId: 'xxx' });
 *   log.error('任务失败', { error: err.message });
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../config';

// ==================== 类型 ====================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  time: number;
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, any>;
}

export interface Logger {
  debug(msg: string, data?: Record<string, any>): void;
  info(msg: string, data?: Record<string, any>): void;
  warn(msg: string, data?: Record<string, any>): void;
  error(msg: string, data?: Record<string, any>): void;
  getRecent(limit?: number): LogEntry[];
}

// ==================== 配置 ====================

const LOG_DIR = path.join(DATA_DIR, 'logs');
const MAX_BUFFER = 1000;           // 内存最多保留条数
const FILE_MAX_SIZE = 10 * 1024 * 1024; // 10MB 自动轮转
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL: LogLevel = (process.env.FBCLAW_LOG_LEVEL as LogLevel) || 'info';
const MIN_PRIORITY = LOG_LEVEL_PRIORITY[MIN_LEVEL];

// ANSI 颜色
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info:  '\x1b[36m',
  warn:  '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

// 保存原始 console 引用（避免 installConsoleCapture 接管后递归）
const realConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

// ==================== 内存缓冲区 ====================

const ringBuffer: LogEntry[] = [];
let fileStream: fs.WriteStream | null = null;
let currentFileDate = '';
let currentFileSize = 0;

// ==================== 文件管理 ====================

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFileName(): string {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(LOG_DIR, `fbclaw-${date}.log`);
}

function rotateLogFile(): void {
  ensureLogDir();
  const today = new Date().toISOString().slice(0, 10);

  // 日期变了 → 切文件
  if (today !== currentFileDate || !fileStream) {
    if (fileStream) {
      fileStream.end();
      fileStream = null;
    }
    currentFileDate = today;
    currentFileSize = 0;

    const filePath = getLogFileName();
    fileStream = fs.createWriteStream(filePath, { flags: 'a' });
    currentFileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  }

  // 文件过大 → 重命名 + 重新创建
  if (currentFileSize >= FILE_MAX_SIZE && fileStream) {
    const filePath = getLogFileName();
    fileStream.end();
    const backup = filePath.replace('.log', `.${Date.now()}.log`);
    try { fs.renameSync(filePath, backup); } catch {}
    fileStream = fs.createWriteStream(filePath, { flags: 'a' });
    currentFileSize = 0;
  }
}

/** 清理 7 天前的日志文件 */
function cleanOldLogs(): void {
  try {
    ensureLogDir();
    const files = fs.readdirSync(LOG_DIR);
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const f of files) {
      const fp = path.join(LOG_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
        }
      } catch {}
    }
  } catch {}
}

// ==================== 写日志 ====================

function writeLog(entry: LogEntry): void {
  // 写入内存缓冲区
  ringBuffer.push(entry);
  if (ringBuffer.length > MAX_BUFFER) {
    ringBuffer.shift();
  }

  // 写入文件
  try {
    rotateLogFile();
    if (fileStream) {
      const line = JSON.stringify(entry) + '\n';
      fileStream.write(line);
      currentFileSize += Buffer.byteLength(line);
    }
  } catch {}
}

// ==================== 工厂函数 ====================

const createdLoggers = new Map<string, Logger>();

export function createLogger(module: string): Logger {
  const existing = createdLoggers.get(module);
  if (existing) return existing;

  const logger: Logger = {
    debug(msg, data) {
      if (LOG_LEVEL_PRIORITY.debug < MIN_PRIORITY) return;
      const entry: LogEntry = { time: Date.now(), level: 'debug', module, message: msg, data };
      const ts = new Date(entry.time).toLocaleTimeString('zh-TW');
      realConsole.log(`${DIM}[${ts}]${RESET} ${COLORS.debug}DEBUG${RESET} ${DIM}[${module}]${RESET} ${msg}`);
      writeLog(entry);
    },
    info(msg, data) {
      if (LOG_LEVEL_PRIORITY.info < MIN_PRIORITY) return;
      const entry: LogEntry = { time: Date.now(), level: 'info', module, message: msg, data };
      const ts = new Date(entry.time).toLocaleTimeString('zh-TW');
      realConsole.log(`${DIM}[${ts}]${RESET} ${COLORS.info}INFO ${RESET} ${DIM}[${module}]${RESET} ${msg}`);
      writeLog(entry);
    },
    warn(msg, data) {
      const entry: LogEntry = { time: Date.now(), level: 'warn', module, message: msg, data };
      const ts = new Date(entry.time).toLocaleTimeString('zh-TW');
      realConsole.warn(`${DIM}[${ts}]${RESET} ${COLORS.warn}WARN ${RESET} ${DIM}[${module}]${RESET} ${msg}`);
      writeLog(entry);
    },
    error(msg, data) {
      const entry: LogEntry = { time: Date.now(), level: 'error', module, message: msg, data };
      const ts = new Date(entry.time).toLocaleTimeString('zh-TW');
      realConsole.error(`${DIM}[${ts}]${RESET} ${COLORS.error}ERROR${RESET} ${DIM}[${module}]${RESET} ${msg}`);
      writeLog(entry);
    },
    getRecent(limit = 50) {
      const start = Math.max(0, ringBuffer.length - limit);
      return ringBuffer.slice(start);
    },
  };

  createdLoggers.set(module, logger);
  return logger;
}

/** 获取全局日志缓冲区（供 API 查询） */
export function getLogBuffer(): LogEntry[] {
  return [...ringBuffer];
}

/** 获取最近的日志 */
export function getRecentLogs(limit = 100, minLevel?: LogLevel): LogEntry[] {
  let filtered = ringBuffer.slice(-limit);
  if (minLevel) {
    const minPri = LOG_LEVEL_PRIORITY[minLevel];
    filtered = filtered.filter(e => LOG_LEVEL_PRIORITY[e.level] >= minPri);
  }
  return filtered;
}

// ==================== 全局 console 接管（监控日志源） ====================
// 运行时大量代码直接 console.log，为让 /api/logs 与监管报告拥有统一的日志源，
// 在此把全局 console.* 输出同时汇入 ringBuffer（用 realConsole 避免递归）。
let consoleCaptured = false;
export function installConsoleCapture(): void {
  if (consoleCaptured) return;
  consoleCaptured = true;
  function push(level: LogLevel, args: any[]): void {
    const message = args
      .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
      .join(' ');
    writeLog({ time: Date.now(), level, module: 'Runtime', message });
  }
  const orig = {
    log: realConsole.log,
    info: realConsole.info,
    warn: realConsole.warn,
    error: realConsole.error,
  };
  console.log = (...a: any[]) => { orig.log(...a); push('info', a); };
  console.info = (...a: any[]) => { orig.info(...a); push('info', a); };
  console.warn = (...a: any[]) => { orig.warn(...a); push('warn', a); };
  console.error = (...a: any[]) => { orig.error(...a); push('error', a); };
}

// 启动时清理旧日志
cleanOldLogs();

// 每小时清理一次
setInterval(cleanOldLogs, 60 * 60 * 1000);
