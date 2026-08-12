# Aike-FBclaw 开发者交接文档

> 最后更新: 2026-08-10 | 当前版本: v1.0.0

---

## 1. 项目定位

Facebook 多账号 AI 智能运营系统。核心 AI 引擎是 OpenClaw（搭载 DeepSeek），浏览器引擎是自建指纹 Chromium（CDP 方式启动）。

**对标的商业产品**: AdsPower + 自动运营机器人，但我们完全自建指纹引擎，零外部依赖。

---

## 2. 技术栈速览

| 层级 | 技术 | 说明 |
|------|------|------|
| AI 引擎 | OpenClaw + DeepSeek API | OpenClaw Gateway 运行在 127.0.0.1:18789 |
| 浏览器 | Playwright-core + CDP | `spawn` 直接启动 Chromium，CDP 连接操控 |
| 指纹 | 自建引擎 | Canvas/WebGL/AudioContext 噪声注入 |
| 数据 | SQLite (better-sqlite3) | 账号记忆体 / 好友关系 |
| 服务器 | Node.js HTTP | 端口 18991，纯 API + 静态文件 |
| UI | 纯 HTML/CSS/JS | dashboard.html（单文件，无框架） |
| Shell | Electron (待完善) | electron/ 目录下有壳 |

---

## 3. 快速启动

### 前提条件
```bash
# 环境变量（必须）
$env:DEEPSEEK_API_KEY = "sk-xxxx"        # PowerShell
# 或
export DEEPSEEK_API_KEY="sk-xxxx"        # Bash
```

### 启动命令
```bash
cd G:\Aike-FBclaw
npm run dev          # → npx tsx src/server.ts
```

服务器启动后访问: **http://localhost:18991**

### 可选
```bash
npm run build:ui     # 构建 React UI → ui-dist/
npm run electron     # 启动 Electron 桌面壳
```

---

## 4. 目录结构与关键文件

```
G:\Aike-FBclaw\
│
├── src/
│   ├── server.ts              # 🔥 最核心文件（1142行）
│   │                           #   HTTP API + 任务执行器 + WebSocket
│   │
│   ├── index.ts               # FbClawApp 应用主类（组装入口）
│   │
│   ├── core/
│   │   ├── browser/
│   │   │   ├── profile-manager.ts  # 🔥 浏览器管理器
│   │   │   │   #   CDP 方式启动 Chrome，Profile 隔离，Cookie 持久化
│   │   │   │   #   ⚠️ 不再用 launchPersistentContext（视口bug）
│   │   │   │
│   │   │   └── fingerprint.ts      # 🔥 指纹引擎
│   │   │       #   每账号随机生成独立指纹参数
│   │   │       #   buildInitScript() 生成注入 JS（260行模板）
│   │   │       #   ⚠️ innerWidth/Height 返回真实CSS视口（适配窗口）
│   │   │
│   │   ├── agent/
│   │   │   ├── account-agent.ts    # 单账号智能体
│   │   │   ├── orchestrator.ts     # 多账号编排（频率控制/任务分发）
│   │   │   └── evolution.ts        # AI 自进化策略
│   │   │
│   │   ├── proxy/
│   │   │   ├── socks5-pool.ts      # SOCKS5 代理池 + 本地转发
│   │   │   └── proxy-manager.ts    # Clash API 集成
│   │   │
│   │   ├── openclaw/
│   │   │   └── engine.ts           # OpenClaw AI 接口封装
│   │   │
│   │   ├── logger.ts               # 🆕 结构化日志系统
│   │   ├── chat-memory.ts          # 对话记忆
│   │   └── utils/totp.ts           # 2FA 验证码生成
│   │
│   ├── detection/
│   │   └── page-detector.ts        # FB 页面状态感知（824行）
│   │       #   识别 28 种页面类型 + 20 种弹窗
│   │
│   ├── memory/
│   │   └── account-memory.ts       # SQLite 记忆体
│   │
│   ├── skills/
│   │   └── fb-core-skills.ts       # FB 核心操作技能库（900行）
│   │
│   ├── utils/
│   │   ├── account-importer.ts     # 批量导入（Excel/CSV/JSON）
│   │   └── human-behavior.ts       # 人类行为模拟
│   │
│   └── window-manager/
│       └── layout.ts               # 窗口自动排列
│
├── ui/
│   ├── dashboard.html              # 🔥 主 UI（单文件，~500行）
│   │   #   5 模块: 仪表盘/账号管理/任务中心/代理/日志
│   │
│   ├── App.tsx                     # React 主组件（Vite 开发环境用）
│   └── components/                 # React 组件
│
├── electron/                       # Electron 桌面壳
│   ├── main.ts
│   └── preload.ts
│
├── data/                           # 运行数据
│   ├── browser-profiles/           # 每账号独立 Chrome Profile
│   │   └── {accountId}/
│   │       └── state.json          # Cookie 持久化文件
│   ├── logs/                       # 🆕 结构化日志（JSON Lines）
│   └── screenshots/                # 截图
│
├── config/
│   └── default.json                # 默认配置
│
└── src/scripts/                    # 56 个测试脚本（一次性调试用）
```

---

## 5. API 参考

所有 API 都在 `http://localhost:18991/api/`

### 系统
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/status` | GET | 系统状态（profiles/activeBrowsers/gatewayRunning） |
| `/api/logs?limit=50` | GET | 最近日志 |
| `/api/alerts` | GET | 异常告警列表 |

### 浏览器
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/browser/start` | POST | 启动浏览器 `{ accountId }` |
| `/api/browser/stop` | POST | 关闭浏览器 `{ accountId }` |
| `/api/browser/stop-all` | POST | 关闭全部 |
| `/api/browser/screenshot` | POST | 截图 + 视口数据 |

### 账号
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/profiles` | GET | 所有 Profile |
| `/api/profiles` | POST | 创建 Profile |
| `/api/profiles/import` | POST | 批量导入 `{ accounts: [...] }` |
| `/api/account-states` | GET | 所有账号运行状态 |
| `/api/account/:id` | GET | 单个账号详情 |

### 任务
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/task/add` | POST | 添加任务 `{ accountIds, type, params }` |
| `/api/tasks` | GET | 任务列表 |

### 代理
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/proxy/list` | GET | 代理列表 |
| `/api/proxy/assign` | POST | 分配代理给账号 |
| `/api/proxy/assignments` | GET | 分配关系 |

---

## 6. 核心架构决策

### 为什么用 CDP 而不是 launchPersistentContext？

**根因**: Playwright 的 `chromium.launchPersistentContext` 无视口 bug — 不管 `--window-size` 设什么值，innerWidth 永远卡在 1280，导致 Facebook 响应式布局在窄窗口时右侧被截断。

**解决方案**: 用 `child_process.spawn()` 直接启动 Chromium，然后 `chromium.connectOverCDP()` 连接。这样视口完全跟随真实窗口大小。

**代价**: 
- Chrome 进程不由 Playwright 管理，需要手动 kill
- CDP 端口绑定在 127.0.0.1（随机端口 9222-9321）
- 启动时需轮询等待 CDP 端口可用（最多 20 秒）

详见 `profile-manager.ts` 的 `launchBrowser()` 方法。

### 指纹策略

每个账号生成一套独立的随机指纹：
- `screen.width/height` → 返回指纹固定值（不变）
- `window.innerWidth/Height` → 返回真实 CSS 视口（随窗口变化）
- `navigator.*` → 覆盖为指纹值
- Canvas/WebGL/AudioContext → 注入随机噪声

这是为了平衡「指纹隔离」和「正常用户体验」。screen 固定让 FB 服务端认为用户使用同一台电脑；innerWidth 变动则是正常浏览器行为。

---

## 7. 日志系统

**位置**: `src/core/logger.ts`

**用法**:
```typescript
import { createLogger } from './core/logger.js';
const log = createLogger('Task');
log.info('任务开始', { accountId: 'xxx' });
log.error('任务失败', { error: err.message });
```

**输出**:
- 控制台: 带颜色和时间戳
- 文件: `data/logs/fbclaw-YYYY-MM-DD.log`（JSON Lines，10MB 轮转，7天清理）
- 内存: 最近 1000 条（API `/api/logs` 可查询）

---

## 8. 常见陷阱 & 已知问题

### ⚠️ 浏览器关不掉
Windows 上 `child_process.kill()` 可能无法终止 Chromium。兜底策略：先用 `process.kill(pid)`，2 秒后用 `taskkill /F /PID` 强杀。

### ⚠️ Chrome 路径硬编码
`profile-manager.ts` 中 `CHROME_PATH` 指向 Playwright 内建 Chromium。换环境需修改。

### ⚠️ 代理文件路径硬编码
`server.ts` 启动时自动从 `C:/Users/UR/Downloads/proxyList.txt` 加载代理。换环境需改路径或通过 UI 导入。

### ⚠️ 数据目录硬编码
所有数据存储在 `G:/Aike-FBclaw/data/`。如果项目路径变更，需同步修改多处路径。

### ⚠️ executeSingleTask 与 launchBrowser 是两套路径
- `POST /api/browser/start` → `browserMgr.launchBrowser()` → CDP spawn（前台窗口）
- `POST /api/task/add` → `executeSingleTask()` → `launchPersistentContext`（后台 headless）

两者不一致。后台任务已补充指纹 initScript（2026-08-10），但视口问题在 headless 模式下无影响。

### ⚠️ SIGKILL 在 Windows
`SIGKILL` 不是 Windows 有效信号。已修复为 `taskkill /F /PID`（2026-08-10）。

---

## 9. 开发约定

- 所有用户界面文字使用**繁体中文**
- 账号操作全部**模拟真人行为**（随机延迟、非线性滚动）
- 台湾环境：zh-TW + Asia/Taipei 时区
- 先对齐确认，用户说「继续开发」后才动工

---

## 10. 修改记录

| 日期 | 变更 |
|------|------|
| 2026-08-10 | 🔧 修复 6 个 P0 bug（ESM require、SIGKILL、TOTP、API Key、视口） |
| 2026-08-10 | 🆕 创建结构化日志系统 `src/core/logger.ts` |
| 2026-08-10 | 🎨 重写 dashboard.html（5 模块：仪表盘/账号管理/任务中心/代理/日志） |
| 2026-08-10 | 🔒 profile-manager 改用 CDP spawn（解决桌面视口 bug） |
| 2026-08-10 | 🔒 fingerprint innerWidth/Height 改为真实 CSS 视口 |
| 2026-08-10 | 📝 创建本开发者指南 |
