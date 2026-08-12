/**
 * WindowManager — AdsPower 浏览器窗口自动排列
 * 
 * 通过 Windows API 自动平铺已打开的 AdsPower 浏览器窗口，
 * 方便人工监控多个账号的运行状态。
 */

import { EventEmitter } from 'events';

export interface WindowLayout {
  /** 窗口数量 */
  count: number;
  /** 网格排列：行数 */
  rows: number;
  /** 网格排列：列数 */
  cols: number;
  /** 每个窗口的宽度 */
  cellWidth: number;
  /** 每个窗口的高度 */
  cellHeight: number;
  /** X 偏移（避开任务栏等） */
  offsetX: number;
  /** Y 偏移 */
  offsetY: number;
}

export class WindowManager extends EventEmitter {
  private screenWidth: number;
  private screenHeight: number;

  constructor(screenWidth?: number, screenHeight?: number) {
    super();

    // 获取屏幕尺寸
    try {
      const os = require('os');
      // Windows 屏幕尺寸通过其他方式获取
      this.screenWidth = screenWidth || 1920;
      this.screenHeight = screenHeight || 1080;
    } catch {
      this.screenWidth = 1920;
      this.screenHeight = 1080;
    }
  }

  /**
   * 计算最优窗口布局
   */
  calculateLayout(windowCount: number, taskbarHeight: number = 48): WindowLayout {
    if (windowCount <= 0) {
      return { count: 0, rows: 0, cols: 0, cellWidth: 0, cellHeight: 0, offsetX: 0, offsetY: 0 };
    }

    // 可用空间（减去任务栏）
    const availableWidth = this.screenWidth;
    const availableHeight = this.screenHeight - taskbarHeight;

    // 计算最优行列数
    let bestLayout = { rows: 1, cols: 1, waste: Infinity };
    
    for (let rows = 1; rows <= Math.ceil(windowCount / 1); rows++) {
      for (let cols = 1; cols <= Math.ceil(windowCount / rows); cols++) {
        if (rows * cols >= windowCount) {
          const cellW = availableWidth / cols;
          const cellH = availableHeight / rows;
          // 避免窗口太扁或太窄
          const ratio = cellW / cellH;
          if (ratio >= 1.0 && ratio <= 2.5) {
            const waste = (rows * cols - windowCount) + Math.abs(ratio - 1.6);
            if (waste < bestLayout.waste) {
              bestLayout = { rows, cols, waste };
            }
          }
        }
      }
    }

    const { rows, cols } = bestLayout;
    const cellWidth = Math.floor(availableWidth / cols);
    const cellHeight = Math.floor(availableHeight / rows);
    const offsetX = 0;
    const offsetY = 0;

    return { count: windowCount, rows, cols, cellWidth, cellHeight, offsetX, offsetY };
  }

  /**
   * 平铺窗口（逻辑描述，实际操作需要 Windows API）
   */
  getWindowPositions(windowCount: number): { x: number; y: number; width: number; height: number }[] {
    const layout = this.calculateLayout(windowCount);
    const positions: { x: number; y: number; width: number; height: number }[] = [];

    for (let i = 0; i < windowCount; i++) {
      const row = Math.floor(i / layout.cols);
      const col = i % layout.cols;

      // 留出少量间距
      const margin = 4;
      positions.push({
        x: layout.offsetX + col * layout.cellWidth + margin,
        y: layout.offsetY + row * layout.cellHeight + margin,
        width: layout.cellWidth - margin * 2,
        height: layout.cellHeight - margin * 2,
      });
    }

    return positions;
  }

  /**
   * 获取推荐的同时运行窗口数
   */
  getRecommendedWindowCount(): number {
    try {
      const os = require('os');
      const totalMemGB = os.totalmem() / (1024 * 1024 * 1024);
      const cpuCount = os.cpus().length;
      const freeMemGB = os.freemem() / (1024 * 1024 * 1024);

      // 每个 Chromium 实例 ~1GB
      const memBased = Math.floor(Math.min(totalMemGB - 4, freeMemGB - 2));
      const cpuBased = cpuCount * 1.5;

      return Math.max(1, Math.min(memBased, cpuBased, 20));
    } catch {
      return 5; // 安全默认值
    }
  }

  /**
   * 布局预览数据（供前端渲染）
   */
  previewLayout(windowCount: number) {
    const layout = this.calculateLayout(windowCount);
    const positions = this.getWindowPositions(windowCount);

    return {
      layout,
      positions,
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
    };
  }
}
