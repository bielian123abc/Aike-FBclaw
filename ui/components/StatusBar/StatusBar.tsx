/**
 * StatusBar — 底部状态栏，显示最近日志
 */

import React from 'react';

interface StatusBarProps {
  logs: { level: string; message: string; time: number }[];
  adspowerConnected: boolean;
}

const LOG_COLORS: Record<string, string> = {
  info: 'text-gray-600',
  warn: 'text-amber-600',
  error: 'text-red-600',
  debug: 'text-gray-400',
};

const StatusBar: React.FC<StatusBarProps> = ({ logs, adspowerConnected }) => {
  return (
    <footer className="bg-gray-800 text-gray-300 text-xs px-4 py-1.5 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-4 flex-1 overflow-hidden">
        <span className="text-gray-500 shrink-0">日志:</span>
        {logs.map((log, i) => (
          <span key={i} className={`truncate ${LOG_COLORS[log.level] || 'text-gray-400'}`}>
            [{new Date(log.time).toLocaleTimeString('zh-TW')}] {log.message}
          </span>
        ))}
        {logs.length === 0 && <span className="text-gray-600">等待系统启动...</span>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-gray-500">
          {adspowerConnected ? '✅ AdsPower' : '❌ AdsPower'}
        </span>
        <span className="text-gray-500">Aike-FBclaw v1.0.0</span>
      </div>
    </footer>
  );
};

export default StatusBar;
