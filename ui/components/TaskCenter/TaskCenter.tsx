/**
 * TaskCenter — 任务中心（所有操作类功能集中于此）
 */

import React, { useState } from 'react';

const TASK_TYPES = [
  { type: 'browse_home', label: '浏览首页', icon: '👀' },
  { type: 'like_posts', label: '随机点赞', icon: '👍' },
  { type: 'add_friends', label: '加好友', icon: '👥' },
  { type: 'share_post', label: '分享帖子', icon: '📤' },
  { type: 'join_groups', label: '加入社团', icon: '🏘️' },
  { type: 'invite_to_group', label: '邀请入社', icon: '📨' },
  { type: 'send_message', label: '发私信', icon: '💬' },
  { type: 'check_status', label: '检测状态', icon: '🔍' },
];

const TaskCenter: React.FC = () => {
  const [taskType, setTaskType] = useState('browse_home');
  const [taskCount, setTaskCount] = useState(3);
  const [taskUrl, setTaskUrl] = useState('');

  const handleExecute = async () => {
    try {
      await fetch('http://localhost:18991/api/task/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountIds: [], type: taskType,
          params: { url: taskUrl, count: taskCount },
        }),
      });
    } catch {}
  };

  return (
    <div className="p-6 h-full overflow-auto">
      <h2 className="text-lg font-semibold mb-4">任务中心</h2>

      {/* 步骤 1: 选择任务类型 */}
      <div className="bg-white rounded-lg border p-4 mb-4">
        <h3 className="text-sm font-medium text-gray-700 mb-3">步骤 1: 选择任务类型</h3>
        <div className="flex flex-wrap gap-2">
          {TASK_TYPES.map(t => (
            <button
              key={t.type}
              onClick={() => setTaskType(t.type)}
              className={`px-3 py-2 rounded text-sm flex items-center gap-1.5 border transition-colors
                ${taskType === t.type
                  ? 'bg-blue-50 border-blue-500 text-blue-700'
                  : 'bg-white border-gray-200 text-gray-600 hover:border-blue-300'
                }`}
            >
              <span>{t.icon}</span> {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 步骤 2: 配置参数 */}
      <div className="bg-white rounded-lg border p-4 mb-4">
        <h3 className="text-sm font-medium text-gray-700 mb-3">步骤 2: 配置参数</h3>
        <div className="flex gap-4 items-center">
          <div>
            <label className="block text-xs text-gray-500 mb-1">操作次数</label>
            <input type="number" min={1} max={50} value={taskCount}
              onChange={e => setTaskCount(parseInt(e.target.value) || 3)}
              className="w-20 px-3 py-1.5 border rounded text-sm" />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1">目标 URL（可选）</label>
            <input type="text" value={taskUrl}
              onChange={e => setTaskUrl(e.target.value)}
              placeholder="https://facebook.com/..."
              className="w-full px-3 py-1.5 border rounded text-sm" />
          </div>
        </div>
      </div>

      {/* 执行 */}
      <div className="bg-white rounded-lg border p-4">
        <h3 className="text-sm font-medium text-gray-700 mb-3">步骤 3: 选择账号 & 执行</h3>
        <p className="text-xs text-gray-400 mb-3">
          请先在账号管理页面选择目标账号，然后点击执行。
        </p>
        <button
          onClick={handleExecute}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm"
        >
          ▶ 执行任务
        </button>
      </div>
    </div>
  );
};

export default TaskCenter;
