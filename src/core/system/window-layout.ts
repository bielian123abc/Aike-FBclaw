/**
 * WindowLayoutManager — 自動任務時窗口網格平鋪（需求 B）
 *
 * 依「螢幕解析度 ÷ 同時視窗數」算網格，為每個瀏覽器視窗分配
 * {x, y, w, h}。啟動時把 slot 注入 Chromium 的 --window-size / --window-position；
 * 已開視窗則透過 PowerShell SetWindowPos 即時重排（/api/windows/retile）。
 */
import { execFileSync } from 'child_process';
import { getScreenResolution } from './system-profiler';

export interface WindowSlot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 可視化布局設定：保留工作列高度 + 視窗間細微間隔，避免壓邊/重疊 */
export const LAYOUT_CONFIG = {
  taskbarHeight: 48,
  gap: 4,
};

/** 為常見帳號數量設計最直觀的網格（1–12 查表，>12 回退到 sqrt） */
function chooseGrid(count: number): { cols: number; rows: number } {
  switch (count) {
    case 1:
      return { cols: 1, rows: 1 };
    case 2:
      return { cols: 2, rows: 1 };
    case 3:
      return { cols: 3, rows: 1 };
    case 4:
      return { cols: 2, rows: 2 };
    case 5:
      return { cols: 3, rows: 2 };
    case 6:
      return { cols: 3, rows: 2 };
    case 7:
      return { cols: 4, rows: 2 };
    case 8:
      return { cols: 4, rows: 2 };
    case 9:
      return { cols: 3, rows: 3 };
    case 10:
      return { cols: 5, rows: 2 };
    case 11:
      return { cols: 4, rows: 3 };
    case 12:
      return { cols: 4, rows: 3 };
    default: {
      const cols = Math.ceil(Math.sqrt(count));
      return { cols, rows: Math.ceil(count / cols) };
    }
  }
}

/** 依數量算網格布局，末行不足時置中，並保留工作列與間隔 */
export function computeTileLayout(screenW: number, screenH: number, count: number): WindowSlot[] {
  if (count <= 0) return [];
  const { cols, rows } = chooseGrid(count);
  const usableH = Math.max(1, screenH - LAYOUT_CONFIG.taskbarHeight);
  const totalGapW = LAYOUT_CONFIG.gap * Math.max(0, cols - 1);
  const totalGapH = LAYOUT_CONFIG.gap * Math.max(0, rows - 1);
  const tileW = Math.floor((screenW - totalGapW) / cols);
  const tileH = Math.floor((usableH - totalGapH) / rows);
  const slots: WindowSlot[] = [];

  const lastRowCount = count - (rows - 1) * cols;
  const centerLastRow = lastRowCount > 0 && lastRowCount < cols;
  const lastRowWidth = lastRowCount * tileW + (lastRowCount - 1) * LAYOUT_CONFIG.gap;
  const lastRowStartX = Math.floor((screenW - lastRowWidth) / 2);

  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = centerLastRow && row === rows - 1
      ? lastRowStartX + col * (tileW + LAYOUT_CONFIG.gap)
      : col * (tileW + LAYOUT_CONFIG.gap);
    const y = row * (tileH + LAYOUT_CONFIG.gap);
    slots.push({ x, y, w: tileW, h: tileH });
  }
  return slots;
}

class WindowLayoutManager {
  private wins = new Map<string, { pid?: number; slot: WindowSlot }>();

  /** 為即將啟動的視窗預留 slot（啟動前呼叫，依當前數量+1 算格） */
  reserve(accountId: string): WindowSlot {
    const screen = getScreenResolution();
    const count = this.wins.size + 1;
    const slots = computeTileLayout(screen.width, screen.height, count);
    const slot = slots[count - 1];
    this.wins.set(accountId, { pid: undefined, slot });
    return slot;
  }

  setPid(accountId: string, pid?: number) {
    const cur = this.wins.get(accountId);
    if (cur && pid) cur.pid = pid;
  }

  unregister(accountId: string) {
    this.wins.delete(accountId);
  }

  size() {
    return this.wins.size;
  }

  /** 依目前註冊順序重算網格，回傳最新布局 */
  relayout(): { accountId: string; pid?: number; slot: WindowSlot }[] {
    const screen = getScreenResolution();
    const ids = Array.from(this.wins.keys());
    const slots = computeTileLayout(screen.width, screen.height, ids.length);
    ids.forEach((id, i) => {
      const cur = this.wins.get(id)!;
      cur.slot = slots[i];
    });
    return ids.map((id) => {
      const w = this.wins.get(id)!;
      return { accountId: id, pid: w.pid, slot: w.slot };
    });
  }

  getAll() {
    return Array.from(this.wins.entries()).map(([accountId, w]) => ({ accountId, ...w }));
  }
}

export const windowManager = new WindowLayoutManager();

/** 用 PID 移動已開視窗到指定位置/大小（Windows SetWindowPos） */
export function moveWindowByPid(pid: number, x: number, y: number, w: number, h: number): boolean {
  const script = `
$code = @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, int a, int x, int y, int w, int h, uint f);
'@
Add-Type -MemberDefinition $code -Name W -Namespace Win -ErrorAction SilentlyContinue
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($p -and $p.MainWindowHandle -ne 0) {
  [Win.W]::SetWindowPos($p.MainWindowHandle, 0, ${x}, ${y}, ${w}, ${h}, 0x0040)
  'OK'
} else { 'NO_WINDOW' }
`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    return out.includes('OK');
  } catch {
    return false;
  }
}

/** 重新平鋪所有已開視窗（供 /api/windows/retile 呼叫） */
export function applyRetile(): { accountId: string; slot: WindowSlot }[] {
  const layout = windowManager.relayout();
  for (const item of layout) {
    if (item.pid) moveWindowByPid(item.pid, item.slot.x, item.slot.y, item.slot.w, item.slot.h);
  }
  return layout.map((l) => ({ accountId: l.accountId, slot: l.slot }));
}
