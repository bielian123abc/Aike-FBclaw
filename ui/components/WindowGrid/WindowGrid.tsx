/**
 * WindowGrid — 窗口布局预览
 */

import React from 'react';

const WindowGrid: React.FC = () => {
  return (
    <div className="p-6 h-full overflow-auto">
      <h2 className="text-lg font-semibold mb-4">窗口布局</h2>
      <div className="bg-white rounded-lg border p-8 text-center text-gray-400">
        <p className="text-2xl mb-2">🖥️</p>
        <p>浏览器窗口将自动排列在屏幕上</p>
        <p className="text-xs mt-1">启动账号后，AdsPower 浏览器窗口会自动平铺排列</p>
      </div>
    </div>
  );
};

export default WindowGrid;
