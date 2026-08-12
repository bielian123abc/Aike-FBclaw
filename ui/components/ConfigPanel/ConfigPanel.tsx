/**
 * ConfigPanel — 配置中心
 * API Key、代理订阅、主号/社团链接、运营策略
 */

import React, { useState } from 'react';

const ConfigPanel: React.FC = () => {
  const [deepseekApiKey, setDeepseekApiKey] = useState('');
  const [adspowerPort, setAdspowerPort] = useState('50325');
  const [clashApiUrl, setClashApiUrl] = useState('');
  const [mainPages, setMainPages] = useState<string[]>([]);
  const [mainGroups, setMainGroups] = useState<string[]>([]);
  const [newPageUrl, setNewPageUrl] = useState('');
  const [newGroupUrl, setNewGroupUrl] = useState('');

  const addMainPage = () => {
    if (newPageUrl && !mainPages.includes(newPageUrl)) {
      setMainPages([...mainPages, newPageUrl]);
      setNewPageUrl('');
    }
  };

  const addMainGroup = () => {
    if (newGroupUrl && !mainGroups.includes(newGroupUrl)) {
      setMainGroups([...mainGroups, newGroupUrl]);
      setNewGroupUrl('');
    }
  };

  return (
    <div className="p-6 max-w-2xl overflow-auto h-full">
      <h2 className="text-lg font-semibold mb-4">配置中心</h2>

      {/* AI 模型配置 */}
      <section className="mb-6 bg-white rounded-lg border p-4">
        <h3 className="font-medium mb-3 text-sm text-gray-700">🤖 AI 模型配置</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">DeepSeek API Key</label>
            <input
              type="password"
              value={deepseekApiKey}
              onChange={e => setDeepseekApiKey(e.target.value)}
              className="w-full px-3 py-2 border rounded text-sm font-mono focus:outline-none focus:border-blue-400"
            />
          </div>
        </div>
      </section>

      {/* AdsPower 配置 */}
      <section className="mb-6 bg-white rounded-lg border p-4">
        <h3 className="font-medium mb-3 text-sm text-gray-700">🖥️ AdsPower 连接</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">API 端口</label>
            <input
              type="text"
              value={adspowerPort}
              onChange={e => setAdspowerPort(e.target.value)}
              className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:border-blue-400"
            />
          </div>
          <p className="text-xs text-gray-400">
            默认地址: http://local.adspower.net:50325
          </p>
        </div>
      </section>

      {/* 代理配置 */}
      <section className="mb-6 bg-white rounded-lg border p-4">
        <h3 className="font-medium mb-3 text-sm text-gray-700">🌐 Clash 代理订阅</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Clash API URL</label>
            <input
              type="text"
              value={clashApiUrl}
              onChange={e => setClashApiUrl(e.target.value)}
              placeholder="http://127.0.0.1:9090"
              className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:border-blue-400"
            />
          </div>
          <p className="text-xs text-gray-400">
            用于自动切换和管理代理线路。IP 将自动匹配台湾时区/繁体中文环境。
          </p>
        </div>
      </section>

      {/* 我的主页 */}
      <section className="mb-6 bg-white rounded-lg border p-4">
        <h3 className="font-medium mb-3 text-sm text-gray-700">📄 我的公共主页</h3>
        <p className="text-xs text-gray-400 mb-2">
          当这些主页发布新帖子时，AI 将自动调度账号去分享扩散。
        </p>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={newPageUrl}
            onChange={e => setNewPageUrl(e.target.value)}
            placeholder="https://www.facebook.com/YourPage"
            className="flex-1 px-3 py-1.5 border rounded text-sm focus:outline-none focus:border-blue-400"
            onKeyDown={e => e.key === 'Enter' && addMainPage()}
          />
          <button
            onClick={addMainPage}
            className="px-3 py-1.5 bg-blue-500 text-white text-sm rounded hover:bg-blue-600"
          >添加</button>
        </div>
        <ul className="space-y-1">
          {mainPages.map((url, i) => (
            <li key={i} className="flex items-center justify-between text-xs bg-gray-50 px-2 py-1 rounded">
              <span className="truncate text-blue-600">{url}</span>
              <button
                onClick={() => setMainPages(mainPages.filter((_, j) => j !== i))}
                className="text-red-400 hover:text-red-600 ml-2"
              >删除</button>
            </li>
          ))}
          {mainPages.length === 0 && (
            <li className="text-xs text-gray-400">尚未添加主页</li>
          )}
        </ul>
      </section>

      {/* 我的社团 */}
      <section className="mb-6 bg-white rounded-lg border p-4">
        <h3 className="font-medium mb-3 text-sm text-gray-700">👥 我的社团</h3>
        <p className="text-xs text-gray-400 mb-2">
          AI 将从此处社团列表中调度邀请和发帖任务。
        </p>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={newGroupUrl}
            onChange={e => setNewGroupUrl(e.target.value)}
            placeholder="https://www.facebook.com/groups/YourGroup"
            className="flex-1 px-3 py-1.5 border rounded text-sm focus:outline-none focus:border-blue-400"
            onKeyDown={e => e.key === 'Enter' && addMainGroup()}
          />
          <button
            onClick={addMainGroup}
            className="px-3 py-1.5 bg-blue-500 text-white text-sm rounded hover:bg-blue-600"
          >添加</button>
        </div>
        <ul className="space-y-1">
          {mainGroups.map((url, i) => (
            <li key={i} className="flex items-center justify-between text-xs bg-gray-50 px-2 py-1 rounded">
              <span className="truncate text-blue-600">{url}</span>
              <button
                onClick={() => setMainGroups(mainGroups.filter((_, j) => j !== i))}
                className="text-red-400 hover:text-red-600 ml-2"
              >删除</button>
            </li>
          ))}
          {mainGroups.length === 0 && (
            <li className="text-xs text-gray-400">尚未添加社团</li>
          )}
        </ul>
      </section>

      {/* 操作策略 */}
      <section className="mb-6 bg-white rounded-lg border p-4">
        <h3 className="font-medium mb-3 text-sm text-gray-700">⚡ 操作策略</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">每日每号最大加好友数</label>
            <select className="w-full px-3 py-1.5 border rounded text-sm focus:outline-none focus:border-blue-400">
              <option>3</option>
              <option>5</option>
              <option>10</option>
              <option>15</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">每日每号最大点赞数</label>
            <select className="w-full px-3 py-1.5 border rounded text-sm focus:outline-none focus:border-blue-400">
              <option>5</option>
              <option>10</option>
              <option>20</option>
              <option>30</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">每日每号最大分享数</label>
            <select className="w-full px-3 py-1.5 border rounded text-sm focus:outline-none focus:border-blue-400">
              <option>2</option>
              <option>3</option>
              <option>5</option>
              <option>10</option>
            </select>
          </div>
        </div>
      </section>
    </div>
  );
};

export default ConfigPanel;
