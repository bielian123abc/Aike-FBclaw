/**
 * 账号配置存储 — 替代原本散落在各处的 profiles.json / account-extras.json
 * 统一用 data/accounts.json 管理
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../config';

export interface Account {
  accountId: string;
  name: string;
  email: string;
  password?: string;
  /** 2FA / 登入驗證碼（暫不自動填入，僅儲存備用；遇到驗證點時標記等待人工） */
  twofa?: string;
  stage: 'new' | 'warmup' | 'mature';
  /** 账号级运行模式：real=真实 Facebook（需已登录/可登录），mock=本地模拟 FB。
   *  缺省时跟随全局 MOCK_FB 配置。 */
  mode?: 'real' | 'mock';
  status: 'offline' | 'idle' | 'running' | 'error' | 'checkpoint' | 'needs_login' | 'dead' | 'deleted';
  proxy?: string;
  tags?: string[];
  notes?: string;
  /** Messenger 端對端加密聊天的 6 位數 PIN，由系統自動建立或使用者手動設定 */
  messengerPin?: string;
  /** 當前實例透過代理的實時出口 IP（螺旋代理每次開窗不同，啟動環境後檢測） */
  exitIp?: string;
  /** 是否已將 FB 介面語言設為繁體中文(台灣)；設過則不再重複執行首次語言設置 */
  localeSetTw?: boolean;
  /** 該帳號生涯已加入的社團 URL 列表（去重），用於生涯加群上限判斷 */
  joinedGroups?: string[];
  /** 導入時攜帶的 FB 會話 Cookie 字串（datr/sb/xs/c_user/fr/pas…），用於啟動環境時還原登入態 */
  cookies?: string;
  createdAt: number;
  lastUsed?: number;
}

const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

function readAccounts(): Account[] {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function writeAccounts(accounts: Account[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

export function listAccounts(): Account[] { return readAccounts(); }

export function getAccount(accountId: string): Account | undefined {
  return readAccounts().find(a => a.accountId === accountId);
}

export function createAccount(a: Omit<Account, 'createdAt' | 'status'>): Account {
  const accounts = readAccounts();
  if (accounts.find(x => x.accountId === a.accountId)) throw new Error('account already exists');
  const acc: Account = { ...a, status: 'offline', createdAt: Date.now() };
  accounts.push(acc);
  writeAccounts(accounts);
  return acc;
}

export function updateAccount(accountId: string, patch: Partial<Account>): Account | undefined {
  const accounts = readAccounts();
  const idx = accounts.findIndex(a => a.accountId === accountId);
  if (idx < 0) return undefined;
  accounts[idx] = { ...accounts[idx], ...patch };
  writeAccounts(accounts);
  return accounts[idx];
}

/**
 * 批次建立帳號（導入用）。一次讀寫 accounts.json，避免數百帳號時 O(n²) 反覆寫盤。
 * 已存在的 accountId 跳過並計入 skipped。
 */
export function createAccountsBatch(list: Omit<Account, 'createdAt' | 'status'>[]): { created: Account[]; skipped: string[] } {
  const accounts = readAccounts();
  const existing = new Set(accounts.map(a => a.accountId));
  const created: Account[] = [];
  const skipped: string[] = [];
  const now = Date.now();
  for (const a of list) {
    if (existing.has(a.accountId)) { skipped.push(a.accountId); continue; }
    const acc: Account = { ...a, status: 'offline', createdAt: now };
    accounts.push(acc);
    created.push(acc);
    existing.add(a.accountId);
  }
  if (created.length) writeAccounts(accounts);
  return { created, skipped };
}

/**
 * 確保帳號有已儲存的 Messenger PIN。若無則使用預設 000000 並寫回帳號設定。
 * 注意：此 PIN 只在「建立 PIN」對話框出現時使用；若 FB 已要求輸入既有 PIN 但本機未儲存，則無法自動解鎖。
 */
export function ensureMessengerPin(accountId: string): string {
  const acc = getAccount(accountId);
  if (acc?.messengerPin && /^[0-9]{6}$/.test(acc.messengerPin)) {
    return acc.messengerPin;
  }
  // 用戶要求預設 PIN 為 000000，方便統一管理與記憶
  const pin = '000000';
  updateAccount(accountId, { messengerPin: pin });
  return pin;
}

export function deleteAccount(accountId: string): boolean {
  const accounts = readAccounts();
  const idx = accounts.findIndex(a => a.accountId === accountId);
  if (idx < 0) return false;
  accounts.splice(idx, 1);
  writeAccounts(accounts);
  return true;
}

/**
 * 取得帳號生涯已加入社團數（joinedGroups 去重陣列長度）。
 */
export function getJoinedGroupCount(accountId: string): number {
  return getAccount(accountId)?.joinedGroups?.length || 0;
}

/**
 * 記錄一個已加入的社團 URL（去重，避免重跑任務重複計數）。
 */
export function recordJoinedGroup(accountId: string, groupUrl: string): void {
  const acc = getAccount(accountId);
  if (!acc) return;
  const set = new Set(acc.joinedGroups || []);
  if (set.has(groupUrl)) return;
  set.add(groupUrl);
  updateAccount(accountId, { joinedGroups: Array.from(set) });
}

export function ensureAccountDefaults(): Account[] {
  const accounts = readAccounts();
  // 不再自動建立 demo 帳號：真實使用場景下 demo 會造成困擾（無法刪除、混淆真實帳號）。
  // 開發/測試需要 demo 時，請手動匯入或呼叫 POST /api/accounts 建立。
  return accounts;
}

/**
 * 手動建立兩個 demo 帳號（僅供開發/測試呼叫）。
 */
export function seedDemoAccounts(): Account[] {
  const accounts = readAccounts();
  const defaults: Account[] = [
    { accountId: 'demo1@mock.local', name: 'Demo 壹號', email: 'demo1@mock.local', password: 'demo1234', stage: 'new', status: 'offline', createdAt: Date.now() },
    { accountId: 'demo2@mock.local', name: 'Demo 貳號', email: 'demo2@mock.local', password: 'demo1234', stage: 'warmup', status: 'offline', createdAt: Date.now() },
  ];
  writeAccounts([...accounts, ...defaults]);
  return [...accounts, ...defaults];
}
