/**
 * AccountList — 账号管理面板（纯管理，不放任何操作按钮）
 */

import React, { useState } from 'react';

interface AccountListProps {
  agentStates: any[];
  onRefresh: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  offline: 'bg-gray-300', starting: 'bg-yellow-400', running: 'bg-green-500',
  idle: 'bg-green-400', error: 'bg-red-500', manual_control: 'bg-purple-500', dead: 'bg-gray-800',
};

const STATUS_LABELS: Record<string, string> = {
  offline: '离线', starting: '启动中', running: '运行中', idle: '空闲',
  error: '异常', manual_control: '接管', dead: '不可用',
};

const AccountList: React.FC<AccountListProps> = ({ agentStates, onRefresh }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filtered = agentStates.filter(a => {
    if (statusFilter !== 'all' && a.status !== statusFilter) return false;
    if (searchTerm) {
      const name = (a.config?.name || a.name || '').toLowerCase();
      const id = (a.accountId || a.config?.accountId || '').toLowerCase();
      const s = searchTerm.toLowerCase();
      return name.includes(s) || id.includes(s);
    }
    return true;
  });

  const toggleOne = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(a => a.config?.accountId || a.accountId)));
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 bg-white border-b flex items-center gap-3 shrink-0">
        <input type="text" placeholder="搜索名称或ID..." value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="px-3 py-1.5 border rounded text-sm w-48 focus:outline-none focus:border-blue-400" />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 border rounded text-sm focus:outline-none">
          <option value="all">全部状态</option>
          <option value="idle">空闲</option><option value="running">运行中</option>
          <option value="error">异常</option><option value="offline">离线</option>
        </select>
        <div className="flex-1" />
        <span className="text-xs text-gray-400">选: <b>{selected.size}</b></span>
        <button onClick={onRefresh} className="px-3 py-1.5 bg-blue-500 text-white text-sm rounded hover:bg-blue-600">刷新</button>
      </div>

      <div className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            {agentStates.length === 0 ? '暂无账号，请在服务器端导入' : '无匹配账号'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr className="text-left text-gray-500 text-xs uppercase">
                <th className="px-3 py-2 w-8"><input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} /></th>
                <th className="px-3 py-2">名称</th><th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">登录</th><th className="px-3 py-2">页面</th>
                <th className="px-3 py-2">代理IP</th><th className="px-3 py-2">操作次数</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((agent, idx) => {
                const id = agent.config?.accountId || agent.accountId || idx;
                return (
                  <tr key={id} className={`border-t hover:bg-blue-50/50 ${selected.has(id) ? 'bg-blue-50' : ''}`}
                    onClick={() => toggleOne(id)} style={{ cursor: 'pointer' }}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(id)} onChange={() => {}} />
                      <span className={`inline-block w-2.5 h-2.5 rounded-full ml-2 ${STATUS_COLORS[agent.status] || 'bg-gray-300'}`} />
                    </td>
                    <td className="px-3 py-2 font-medium">{agent.config?.name || agent.name || '-'}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        agent.status === 'error' ? 'bg-red-100 text-red-700' :
                        agent.status === 'running' ? 'bg-blue-100 text-blue-700' :
                        agent.status === 'idle' ? 'bg-green-100 text-green-700' :
                        'bg-gray-100 text-gray-600'}`}>
                        {STATUS_LABELS[agent.status] || agent.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">{agent.isLoggedIn ? '✅' : agent.status === 'offline' ? '-' : '?'}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{agent.currentPageType || '-'}</td>
                    <td className="px-3 py-2 text-gray-400 text-xs">{agent.config?.proxyIp || agent.proxy || '-'}</td>
                    <td className="px-3 py-2 text-gray-400 text-xs">{agent.totalActions || 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="px-3 py-1.5 bg-gray-50 border-t text-xs text-gray-400 flex gap-4 flex-shrink-0">
        <span>共 <b className="text-gray-600">{agentStates.length}</b> 个账号</span>
        <span>活跃 <b className="text-green-600">{agentStates.filter(a => a.status !== 'offline' && a.status !== 'error').length}</b></span>
        <span>离线 <b className="text-gray-500">{agentStates.filter(a => a.status === 'offline').length}</b></span>
        <span>异常 <b className="text-red-500">{agentStates.filter(a => a.status === 'error').length}</b></span>
      </div>
    </div>
  );
};

export default AccountList;
