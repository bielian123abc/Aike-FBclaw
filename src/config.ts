/**
 * Aike-FBclaw 中央配置
 * 所有敏感凭据、路径、运行模式集中管理，杜绝硬编码。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// 安装根目录：由本模块（被打包进 dist/server.js）位置反推，
// 使软件安装到任意目录都能正确定位数据/资源/文档，不再写死 G:/Aike-FBclaw。
// 开发态：dist/server.js 位于 G:/Aike-FBclaw/dist/，故 APP_ROOT = G:/Aike-FBclaw（与旧行为一致）。
const __DIR = path.dirname(fileURLToPath(import.meta.url)); // = dist/
export const APP_ROOT = path.resolve(__DIR, '..'); // = 安装根（打包后 = resources/app）

// 自帶 node 運行時（打包隨附 node-runtime/node.exe）。
// 安裝版 process.execPath 是 Electron 主程序，絕不能拿來跑 .mjs；
// 一律優先用此 node 啟動 OpenClaw 網關/CLI，確保打封包後 AI 本體可正常拉起。
export const NODE_BIN = (() => {
  const bundled = path.join(APP_ROOT, 'node-runtime', 'node.exe');
  return fs.existsSync(bundled) ? bundled : process.execPath;
})();

// ---------- 简单 .env 加载（无第三方依赖） ----------
function loadEnv() {
  const envPath = path.join(APP_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf-8');
    for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
}
loadEnv();

export const DATA_DIR = path.join(APP_ROOT, 'data');
export const PROFILES_DIR = path.join(DATA_DIR, 'browser-profiles');
export const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const CONTENT_DIR = path.join(DATA_DIR, 'content-library');
export const AVATAR_INBOX_DIR = path.join(DATA_DIR, 'avatars', 'inbox');
export const AVATAR_USED_DIR = path.join(DATA_DIR, 'avatars', 'used');
export const AVATAR_MANIFEST_FILE = path.join(DATA_DIR, 'avatars', 'used-manifest.json');
/** 软件面向使用者的 OpenClaw 模型设置（别人拿到软件直接填自己的 API） */
export const OPENCLAW_CONFIG_FILE = path.join(DATA_DIR, 'openclaw-config.json');
/** OpenClaw 网关自身配置路径（网关熱重載此檔；嚴格校驗，勿手写破壞） */
export const OPENCLAW_GATEWAY_CONFIG = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json');
export const OPENCLAW_GATEWAY_LASTGOOD = OPENCLAW_GATEWAY_CONFIG + '.last-good';
export const MOCK_FB_PORT = parseInt(process.env.MOCK_FB_PORT || '18992', 10);
export const API_PORT = parseInt(process.env.API_PORT || '18991', 10);

// ---------- 运行模式 ----------
export const MOCK_FB = (process.env.MOCK_FB || '1') === '1'; // 默认开启模拟 FB，便于无真实账号验证
export const FB_BASE = MOCK_FB
  ? `http://127.0.0.1:${MOCK_FB_PORT}`
  : (process.env.FB_BASE || 'https://www.facebook.com');

export const HEADLESS = (process.env.HEADLESS || '0') === '1';

// ---------- 自动点赞目标：用户自己的公共主页/主号名称（PRD 2.3） ----------
// 在 .env 用 OWN_PAGES=名称1,名称2 指定；刷到这些作者的帖子才自动点赞
export const OWN_PAGES: string[] = (process.env.OWN_PAGES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ---------- 首登 Onboarding：主页点赞目标（指定种子粉丝页，可配置） ----------
// 每次开号自愈流程会检测该页是否已按讚；未讚则自动按讚。
// 在 .env 用 ONBOARDING_SEED_LIKE_URL=https://www.facebook.com/xxx 覆盖。
// 預設留空：未配置時跳過此步，避免進入不存在的 facebook.com/page/seed-fan。
export const ONBOARDING_SEED_LIKE_URL: string = process.env.ONBOARDING_SEED_LIKE_URL || '';

// ---------- AI 配置：唯一智能體 = OpenClaw（模型由 OpenClaw 服務配置，軟件不持有 DeepSeek key） ----------
export const AI_CONFIG = {
  // OpenClaw 智能體接入點（獨立部署的服務；其背後模型如 DeepSeek 配在 OpenClaw 那層，軟件不直接碰）
  openclawBaseUrl: process.env.OPENCLAW_BASE_URL || 'http://127.0.0.1:18789',
  openclawApiKey: process.env.OPENCLAW_API_KEY || '',
  openclawModel: process.env.OPENCLAW_MODEL || 'deepseek-chat',
  // 當 OpenClaw 不可達時，啟用本地啟發式模板兜底（保證系統不崩潰，但非獨立 AI 通道）
  localFallback: true,
};

// ---------- 代理配置 ----------
export const PROXY_LIST_FILE = process.env.PROXY_LIST_FILE || 'C:/Users/UR/Downloads/proxyList.txt';

// ---------- 2FA 密钥目录 ----------
export const TWOFА_DIR = process.env.TWOfa_DIR || 'C:/Users/UR/Downloads';

// ---------- 每日操作安全上限（来自 PRD v3.0 速查表，新号默认） ----------
export const SAFETY_LIMITS = {
  new:    { addFriend: 5,  addFriendHour: 2, message: 5,  post: 1, like: 10, comment: 3, joinGroup: 1 },
  warmup: { addFriend: 10, addFriendHour: 3, message: 15, post: 3, like: 20, comment: 8, joinGroup: 2 },
  mature: { addFriend: 20, addFriendHour: 5, message: 20, post: 5, like: 40, comment: 15, joinGroup: 5 },
};

export function limitForStage(stage: string) {
  if (stage === 'warmup') return SAFETY_LIMITS.warmup;
  if (stage === 'mature' || stage === 'active') return SAFETY_LIMITS.mature;
  return SAFETY_LIMITS.new;
}

// ---------- 生涯社团上限（防過度加群，用戶要求：一個帳號一輩子最多三五十個） ----------
export const MAX_GROUPS_PER_ACCOUNT = parseInt(process.env.MAX_GROUPS_PER_ACCOUNT || '40', 10);

// 确保目录存在
for (const d of [DATA_DIR, PROFILES_DIR, SCREENSHOT_DIR, LOG_DIR, CONTENT_DIR, AVATAR_INBOX_DIR, AVATAR_USED_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

// ---------- 运行期可變更的 AI 配置（模型設置 UI 熱生效用） ----------
export function setAIConfig(partial: Partial<typeof AI_CONFIG>): void {
  Object.assign(AI_CONFIG, partial);
}
