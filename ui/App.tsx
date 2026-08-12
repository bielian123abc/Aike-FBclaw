import React, { useState, useEffect, useCallback } from 'react';
import AccountList from './components/AccountList/AccountList';
import TaskCenter from './components/TaskCenter/TaskCenter';

type Tab = 'dash' | 'accounts' | 'tasks';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('dash');
  const [globalStats, setGlobalStats] = useState<any>({
    totalAgents: 0, activeAgents: 0, runningAgents: 0, idleAgents: 0, errorAgents: 0,
    runningBrowsers: 0, runningTasks: 0, queuedTasks: 0, actionsPerMinute: 0,
  });
  const [logs, setLogs] = useState<{ level: string; message: string; time: number }[]>([]);
  const [agentStates, setAgentStates] = useState<any[]>([]);

  const refreshStats = useCallback(async () => {
    try {
      const r = await fetch('http://localhost:18991/api/status');
      const status = await r.json();

      const statesR = await fetch('http://localhost:18991/api/account-states');
      const states = await statesR.json();

      if (status) setGlobalStats({
        totalAgents: status.profiles || 0,
        activeAgents: status.activeBrowsers || 0,
        runningAgents: 0,
        idleAgents: 0,
        errorAgents: 0,
        runningBrowsers: status.activeBrowsers || 0,
        runningTasks: 0,
        queuedTasks: 0,
        actionsPerMinute: 0,
      });
      if (states) setAgentStates(states || []);
    } catch {}
  }, []);

  useEffect(() => {
    refreshStats();
    const interval = setInterval(refreshStats, 5000);
    return () => clearInterval(interval);
  }, [refreshStats]);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'dash', label: '仪表盘', icon: '📊' },
    { id: 'accounts', label: '账号管理', icon: '👤' },
    { id: 'tasks', label: '任务中心', icon: '📋' },
  ];

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="bg-white border-b px-4 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-gray-800">Aike-FBclaw</h1>
          <span className="text-xs text-gray-400">Facebook 多账号 AI 智能运营系统</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs text-gray-500">🤖 DeepSeek + OpenClaw</span>
          <span className="text-xs text-gray-400">自建指纹引擎</span>
        </div>
      </header>

      <div className="bg-white border-b px-4 py-2 shrink-0">
        <div className="flex gap-6 text-xs text-gray-600">
          <span>账号: <b className="text-gray-800">{globalStats.totalAgents}</b></span>
          <span>活跃: <b className="text-green-600">{globalStats.activeAgents}</b></span>
          <span>浏览器: <b>{globalStats.runningBrowsers}</b></span>
          <span>任务: <b className="text-blue-600">{globalStats.runningTasks}</b></span>
          <span>排队: <b className="text-amber-600">{globalStats.queuedTasks}</b></span>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <nav className="w-32 bg-white border-r shrink-0 py-4">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full text-left px-4 py-3 text-sm flex items-center gap-2 transition-colors
                ${activeTab === tab.id
                  ? 'bg-blue-50 text-blue-700 border-r-2 border-blue-600'
                  : 'text-gray-600 hover:bg-gray-50'
                }`}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>

        <main className="flex-1 overflow-hidden">
          {activeTab === 'dash' && (
            <div className="p-6 h-full overflow-auto">
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-white rounded-lg border p-4 text-center">
                  <div className="text-3xl font-bold text-blue-600">{globalStats.totalAgents}</div>
                  <div className="text-xs text-gray-500 mt-1">总账号</div>
                </div>
                <div className="bg-white rounded-lg border p-4 text-center">
                  <div className="text-3xl font-bold text-green-600">{globalStats.activeAgents}</div>
                  <div className="text-xs text-gray-500 mt-1">浏览器窗口</div>
                </div>
                <div className="bg-white rounded-lg border p-4 text-center">
                  <div className="text-3xl font-bold text-purple-600">{globalStats.runningTasks}</div>
                  <div className="text-xs text-gray-500 mt-1">执行中任务</div>
                </div>
              </div>
              <div className="bg-white rounded-lg border p-4">
                <h3 className="text-sm font-medium mb-2">📝 最近日志</h3>
                <div className="text-xs text-gray-500 space-y-1 max-h-60 overflow-auto font-mono">
                  {logs.slice(-20).map((l, i) => (
                    <div key={i} className={l.level === 'error' ? 'text-red-500' : l.level === 'warn' ? 'text-amber-500' : 'text-gray-500'}>
                      [{new Date(l.time).toLocaleTimeString('zh-TW')}] {l.message}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {activeTab === 'accounts' && (
            <AccountList agentStates={agentStates} onRefresh={refreshStats} />
          )}
          {activeTab === 'tasks' && <TaskCenter />}
        </main>
      </div>

      <footer className="bg-gray-800 text-gray-400 text-xs px-4 py-1.5 flex items-center justify-between shrink-0">
        <span>Aike-FBclaw v1.0.0</span>
        <span>🟢 系统运行中 | DeepSeek + 自建指纹</span>
      </footer>
    </div>
  );
};

export default App;
