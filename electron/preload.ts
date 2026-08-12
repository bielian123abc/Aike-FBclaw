/**
 * Aike-FBclaw — Electron Preload（安全暴露 IPC 给渲染进程）
 * 仅保留桌面壳需要的接口：日志、系统信息、服务重启。
 * 业务 API 仍走 http://localhost:18991（与网页端一致）。
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  console: {
    // 订阅后台日志（main 进程转发的 event:log）
    onLog: (callback: (entry: { source: string; level: string; line: string; t: number }) => void) => {
      const sub = (_e: any, ...args: any[]) => callback(...args);
      ipcRenderer.on('event:log', sub);
      return () => ipcRenderer.removeListener('event:log', sub);
    },
    getRecent: () => ipcRenderer.invoke('console:getRecent'),
  },
  server: {
    restart: () => ipcRenderer.invoke('server:restart'),
  },
  system: {
    getInfo: () => ipcRenderer.invoke('system:get-info'),
  },
};

contextBridge.exposeInMainWorld('fbclaw', api);
export type FbclawAPI = typeof api;
