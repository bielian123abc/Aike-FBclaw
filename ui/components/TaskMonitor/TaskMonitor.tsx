/**
 * TaskMonitor — 任务监控面板
 */

import React, { useState } from 'react';

const TaskMonitor: React.FC = () => {
  const [tasks] = useState<any[]>([]);

  return (
    <div className="p-6 h-full overflow-auto">
      <h2 className="text-lg font-semibold mb-4">任务监控</h2>
      <div className="bg-white rounded-lg border p-8 text-center text-gray-400">
        <p className="text-2xl mb-2">📋</p>
        <p>任务列表将在此实时显示</p>
        <p className="text-xs mt-1">启动账号后，AI 会自动生成并执行任务</p>
      </div>
    </div>
  );
};

export default TaskMonitor;
