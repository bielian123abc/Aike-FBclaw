# Aike-FBclaw 前端 UI 设计 + 开发规格书

> 用途：本文件是给「设计 AI / 前端开发 AI」的**唯一权威依据**。后端（Node HTTP 服务，端口 18991）**完全不动**，本次只重做 Web 控制台的前端 UI（视觉重设计 + 前端重构）。
> 目标：**功能零缺失、零多余**。本文件列出的每一个面板、每一个控件、每一个 API 都必须实现；§9 列出的「禁止项」一律不得出现。
> 当前在线的 UI 是 `src/server.ts` 内嵌的 `dashboardHtml()`（深色主题、13 个主面板 + 右下角悬浮 AI 助手）。本次重做要**完整覆盖**它。

---

## 0. 范围与定位

- **重做对象**：仅前端 UI。后端 REST API、业务逻辑、数据层一律保持不变。
- **替换方式**：新前端构建产物由 `src/server.ts` 在 `GET /` 与 `GET /dashboard` 提供（当前返回 `dashboardHtml()` 字符串，改为返回构建后的静态产物即可，无需改业务逻辑）。
- **本地化**：界面以**繁体中文（台湾）**为主；时区 `Asia/Taipei`；仅面向**台湾社团**。
- **关键约束**：不要新增任何后端没有 API 支撑的功能；不要修改 API 契约；不要删除/隐藏任何已实现面板或功能。

---

## 1. 技术约束与推荐技术栈

| 项 | 要求 |
|----|------|
| 形态 | 纯前端 SPA，通过 `fetch` 调用现有 REST API |
| API 基址 | `http://localhost:18991/api`（注：监管启动器单独走 `http://127.0.0.1:18992`，见 §7） |
| 推荐栈 | **React 18 + TypeScript + Vite + Tailwind CSS**（项目 `ui/` 目录已有 tsconfig / vite.config / tailwind.config 脚手架，可直接复用） |
| 数据格式 | 所有响应为 JSON，结构见 §7；统一前置 `success: boolean` |
| 主题 | 强制深色（配色见 §2） |
| 状态管理 | 轻量即可（组件内 useState / 简单 store），无需引入重框架 |
| 轮询 | 监控/状态类页面使用定时 `fetch` 轮询（推荐 4–5s 间隔），非 WebSocket |

---

## 2. 设计规范 / Design System（强制配色，避免风格漂移）

### 2.1 颜色 Token
```
--primary:      #409eff   /* 主蓝，导航 active 左边框 / 主按钮 / 焦点环 */
--bg-page:      #12141a   /* 页面底色（径向渐变到 #1b2233） */
--bg-card:      #161921   /* 卡片 */
--bg-panel:     #1a1d26   /* 浮层 / 弹窗 / 聊天窗 */
--bg-sidebar:   #161922   /* 侧栏（顶部渐变 #1c202b→#161922） */
--border:       #2c303b   /* 所有边框 / 分割线 */
--text-1:       #e7e9ea   /* 主文字 */
--text-2:       #a3a6ad   /* 次级文字 / 说明 */
--text-th:      #cdd3df   /* 表头文字 */
--success:      #67c23a   /* 绿：成功 / 在线 */
--warning:      #e6a23c   /* 橙：警告 / 未接入 / 提示 */
--danger:       #f56c6c   /* 红：危险 / 删除 / 异常 */
--info:         #409eff   /* 蓝：信息 */
--purple:       #c084fc   /* 紫：AI 接管 / 全局知识 */
```

### 2.2 字号 / 间距 / 圆角
- 基础字号 **13px**；小字 10–12px；标题 15px；KPI 大数字 28–32px。
- 圆角 4–8px；卡片内边距 14px；栅格间距 4 / 8 / 12 / 16px。
- 焦点态：`outline:none; border-color:#409eff; box-shadow:0 0 0 2px rgba(64,158,255,.25)`。

### 2.3 复用组件清单（每个组件都要做出规范样式）
1. **Button**：变体 `primary / success / warning / danger / dark / outline`；hover 提亮，active 下移 1px。
2. **Card**：标题左侧 3px 主色竖条（`border-left:3px solid #409eff; padding-left:10px`）。
3. **Table**：表头底色 `#1e222c`，行 hover `#181b23`，`table-layout:fixed`，单元格 `word-break:break-all`。
4. **Badge**：状态徽章（小圆角描边标签，用于状态/分类）。
5. **Tag / Chip**：可勾选功能标签（用于任务编排的功能库，选中态 `border-color:#409eff; background:#2b3a52`）。
6. **Modal + Mask**：黑色 0.6 遮罩居中弹窗（宽约 600px，大内容可 700px）。
7. **Toast**：顶部居中提示条（成功蓝边 / 失败红边），自动消失。
8. **EmptyState**：空态（居中图标 + 文案）。
9. **StatCard**：顶部 KPI 数字卡（标签 + 大数字 + 状态色）。
10. **FloatingActionButton**：右下角圆形 AI 助手按钮（56×56，主蓝，带阴影）。
11. **Sidebar / Nav**：左侧固定导航，active 项渐变 + 左边框。
12. **TopBar**：顶部全局操作条。
13. **FileUpload**：隐藏 `<input type=file>` + 触发按钮（用于账号文件、代理 TXT）。

---

## 3. 信息架构 / 整体布局

**三区布局**：左 `Sidebar`（固定，13 项导航）+ 右 `TopBar`（全局批量操作常驻）+ 内容区（按导航切换 `page`）+ 右下角 `FloatingChat`（全局 AI 助手）。

**左侧导航 13 项（顺序固定，不得增删）**：
1. 账号环境管理
2. 代理池管理
3. 任务编排编辑器
4. 运营策略配置
5. 社团 & 主页数据源
6. OpenClaw AI 对话
7. 历史任务报告
8. 全局监控
9. 服务端 & 模型
10. 社团总览
11. 头像管理
12. 技能中心
13. 记忆体

---

## 4. 全局 TopBar 操作（每个页面都常驻显示）

| 按钮 | 调用 |
|------|------|
| 批量导入账号 | 弹窗录入多个 `accountId + email + mode` → `POST /api/accounts` |
| 上传账号文件 | 隐藏 file input（accept `txt,csv,xlsx,xls`）→ `POST /api/accounts/import-xlsx`（body: `{fileB64, filename}`） |
| 批量绑定代理 | `POST /api/proxy/auto-assign` |
| 检测全部账号状态 | 轮询刷新账号列表 |
| AI 执行所有账号 | 对每个账号执行智能编排（`POST /api/task/run`，`type:'socialize'` + `accountIds`） |
| 一键重排窗口 | `POST /api/windows/retile` |
| 自动重排开关 | `GET/POST /api/windows/auto-retile`（`{enabled}`） |
| 示范录制 / 停止 / 查看步骤 | `POST /api/demo/start|stop`（`{accountIds}`）、`GET /api/demo/events?accountId=` |

---

## 5. 逐模块功能规格（核心 · 零缺失）

> 每个面板都给出：用途 / 数据 API / 表格列或表单字段 / 操作按钮 / 交互 / 空态。

### 面板 1 · 账号环境管理（`page-account`）
- **API**：`GET /api/accounts`；`POST /api/accounts`（`{name, accountId, mode}`）；`POST /api/accounts/import-xlsx`；`DELETE /api/accounts/{id}`；`POST /api/account/{id}/launch`；`POST /api/account/{id}/close`；`POST /api/account/{id}/screenshot`（`{suffix}`）；`POST /api/account/{id}/persist`；`GET /api/account/{id}`（state）。
- **列表列**：名称/标识、邮箱、状态（徽章）、模式（real/mock）、已加社团数（`joinedGroups.length`）、出口 IP、操作。
- **每行动作**：启动环境 / 智能执行 / 删除（带二次确认）/ 截图 / 同步。
- **Account 字段**：`accountId, name, email, mode, status, joinedGroups[], stage, createdAt`。
- **状态枚举**：`offline / idle / running / error / manual_control / starting / dead`。
- **批量**：勾选多账号 → 批量导入 / 上传 / 智能执行 / 删除。
- **空态**：无任何账号时提示导入。

### 面板 2 · 代理池管理（`page-proxy`）
- **API**：`GET /api/proxy`；`POST /api/proxy`（`{name,type,host,port,username,password,country}`）；`POST /api/proxy/import`（`{text}`）；`POST /api/proxy/test-all`；`POST /api/proxy/test/{id}`；`POST /api/proxy/{id}/assign`（`{accountId}`）；`POST /api/proxy/{id}/unbind`；`DELETE /api/proxy/{id}`；`POST /api/proxy/auto-assign`。
- **列表列**：名称、类型、host:port、状态（在线绿/离线灰）、延迟(ms)、出口 IP、绑定账号（`boundAccount`）。
- **操作**：上传 TXT 批量导入、批量连通检测（`test-all` 返回 `ok/total/results`）、自动分配、单条分配（弹窗输入账号）、解绑、删除。
- **导出映射表**：`window.open('/api/proxy')` 直接下载。

### 面板 3 · 任务编排编辑器（`page-task`）
由 4 个子区组成：
- **子区 A · FB 功能库**：可勾选功能标签（清单见 §6，**仅列出已实现项**，不得出现未接入项）。选中态高亮。
- **子区 B · 账号分组定义**：创建分组、把勾选账号归入分组。
- **子区 C · 已编排任务序列**：展示勾选功能生成的有序序列（`renderSeq`）。
- **子区 D · 智能执行控制**：预览全部执行方案（`previewPlan`）、保存编排方案（`savePlan`）、选中账号智能执行（`runSelected`）、全部账号智能执行（`runAllSmart`）、全部终止（`abortAll`）。
- **依赖提示**：功能间依赖用橙色提示文字（如分享依赖主页/社团数据源）。
- **执行 API**：`POST /api/task/run`（`{accountIds, type, params}`）。批量互加互聊用 `type:'socialize'` + `accountIds`。

### 面板 4 · 运营策略配置（`page-policy`）
- **API**：`GET/POST /api/policy`。
- **Policy 字段**：`dailyInviteLimit, dailyShareLimit, minDelaySec, maxDelaySec, dedupInvite(bool), dedupShare(bool)`。
- **三组卡片**：① 每日操作上限（加好友 / 点赞 / 分享 / 私信上限）② 真人行为延时（min / max 秒）③ 重复过滤总开关（去重邀请 / 去重分享）。
- **保存**：`POST /api/policy`，成功后 Toast。

### 面板 5 · 社团 & 主页数据源（`page-source`）
- **API**：`GET/POST/DELETE /api/sources`（`{type:'group'|'page', url, name, note}`）。
- **两张卡片**：① 公共主页列表（邀请点赞/访问、分享帖子读取源）② 台湾社团列表（邀请好友进社团、从成员加好友读取源）。
- **添加**：输入 url + name + note → `POST`；**删除**单行。

### 面板 6 · OpenClaw AI 对话（`page-clawchat`）
- **对话**：`POST /api/chat`（`{accountId, message}`）→ `{success, reply, intent}`；消息气泡（用户右蓝 / Agent 左灰）。
- **运营监管报告**：按钮触发 `POST /api/agent/supervise` → 返回 `{llmSummary, accounts[], suggestions[]}` 渲染为报告卡片。

### 面板 7 · 历史任务报告（`page-report`）
- **API**：`GET /api/history` → `history[]`，元素 `{taskId, scope, type, time, status}`。
- **表格列**：任务 ID、范围、类型、时间、状态。空态：暂无任务记录。

### 面板 8 · 全局监控（`page-monitor`）
- **API**：`GET /api/monitor/state` → `snapshot`；`GET /api/perception` → `{perception, events}`；`GET /api/monitor/history`。
- **6 张卡片**：
  1. 系统 & 资源：`system{cpu,mem,freeRamGB,cpuCores}`、`load{active,max,memPct,cpuPct}`。
  2. OpenClaw Agent 监控：`llmReachable, lastCallAt, lastSuperviseAt, errorCount, autoSuperviseOn, summary, suggestions[]`。
  3. 活跃账号窗口：`activeSessions[]{accountId,name,status,url,pid,uptimeSec,blocker,lastWatchdogAction}`。
  4. 近期错误 / 警告：`recentErrors[]{time,level,module,message}`。
  5. 任务吞吐：`taskThroughput.lastMinute`。
  6. OpenClaw 实时感知：`perception`（账号状态 + 接管事件）+ `events[]`。
- **自动刷新**：4–5s 轮询，顶部显示 `monitorTs` 时间戳。

### 面板 9 · 服务端 & 模型（`page-server`）
- **子卡 1 · 服务端状态（监管启动器）**：`GET /api/status` 取 `supervisor{supervisorRunning, maintaining, serverPid, restarts}` 与 `gatewayReachable, watchdogRunning, uptimeSec`。
  - 控制按钮（**直接打 18992 端口**，非主 API）：`POST http://127.0.0.1:18992/restart|stop|start`；另有「刷新状态」`GET /api/status`。
- **子卡 2 · OpenClaw 模型设置**：`GET/POST /api/settings/openclaw`（`{settings, diagnose}`）；字段含 apiKey / model / baseUrl 等；保存并热生效；展示 `diagnose` 诊断结果。
- **子卡 3 · 一键修复**：说明 + 🔧 修复按钮 → `POST /api/openclaw/repair` → `{success, steps[], error, gatewayReachable}`。

### 面板 10 · 社团总览（`page-groups`）
- **API**：`GET /api/groups/joined` → `{groups[], perAccount[{accountId,name,joined,overlap}], total}`。
- **内容**：去重后的台湾社团列表；每账号加入数 `joined` 与跨账号重叠 `overlap`（重叠高亮，提示协同风控风险）。

### 面板 11 · 头像管理（`page-avatar`）
- **API**：`GET /api/avatar/stats` → `{stats:{inbox,used,total}, inbox[]}`；`POST /api/avatar/mark-used`（`{filename, accountId}`）。
- **说明**：把图片放到 `data/avatars/inbox` 后端自动上传替换（自动机制，无需 UI 上传）；UI 列出 inbox 文件 + 每行「标记已用」按钮。
- **统计卡**：inbox / used / total。

### 面板 12 · 技能中心（`page-skills`）
- **API**：`GET /api/skills` → `skills[]{id, name(繁中), category, description(繁中), taskType, enabled}`；`POST /api/skills/{id}/toggle`（`{enabled}`）。
- **展示**：按 `category` 分组（基礎 / 內容 / 社交擴張 / 智能編排 / AI 接管 / 安全）；每行 启用/停用 + 执行（仅 `enabled` 可点执行）。
- **执行**：`POST /api/task/run`（`{accountId, type: taskType}`）。

### 面板 13 · 记忆体（`page-memory`）
- **API**：`GET /api/memory/shards` → `{shards[], global}`；`GET /api/memory/shard/{id}` → `{accountId, context}`。
- **两张卡片**：① 账号记忆碎片（shards 列表，点「查看」→ 单账号 `context`）② 全局知识库（`global` 文本，跨账号学习进化沉淀）。

### 全局浮窗 · FloatingChat（右下角，常驻所有页面）
- 右下角 🤖 圆形按钮 → 弹出聊天窗（420×520）。
- 头部：标题 + 🔧 一键修复 + 关闭；消息气泡 user 右 / agent 左；输入框 + 发送。
- 后端：复用 `POST /api/chat` 与 `POST /api/openclaw/repair`。

### 全局组件（贯穿所有页面）
- **Toast**：所有异步操作结果反馈。
- **Modal / Mask**：账号添加、代理分配、确认删除等。
- **EmptyState**：所有列表/表格空态。

---

## 6. FB 功能库（任务编排器可勾选的原子功能 — 全部已实现，照此实现）

> 这是任务编辑器「FB 功能库」应出现的**完整且唯一**清单，映射到后端 `taskType`：

| 功能（繁中标签） | taskType | 分类 |
|---|---|---|
| 登入帳號 | login | 基礎 |
| 同步帳號狀態 | sync | 基礎 |
| 取得好友列表 | get_friends | 基礎 |
| 瀏覽動態（隨機點讚） | browse_feed | 內容 |
| 按讚貼文 | like_post | 內容 |
| 發布貼文 | create_post | 內容 |
| 分享貼文 | share_post | 內容 |
| 搜尋加好友 | add_friends | 社交擴張 |
| 按名稱加好友 | add_friend_by_name | 社交擴張 |
| 發送私訊 | send_message | 社交擴張 |
| 按名稱發私訊 | send_message_to_name | 社交擴張 |
| 加入社團 | join_groups | 社交擴張 |
| 邀請進社團 | invite_to_group | 社交擴張 |
| 邀請讚主頁 | invite_to_page | 社交擴張 |
| 互加互聊 | socialize | 智能編排 |
| 問候新好友 | greet_new_friends | 智能編排 |
| 內容分發 | distribute_content | 智能編排 |
| AI 聊天接管 | ai_chat_reply | AI 接管 |
| 風控檢測 | risk_check | 安全 |

---

## 7. API 速查字典（硬契约 — 按此实现，不多不少）

### 账号 / 会话
- `GET /api/accounts` → `{success, accounts[]}`
- `POST /api/accounts` → `{success, account}`（`{name, accountId, mode}`）
- `POST /api/accounts/import-xlsx` → `{success, added, fingerprinted, cookieRestored, accounts[]}`（`{fileB64, filename}`）
- `DELETE /api/accounts/{id}` → `{success}`
- `GET /api/account/{id}` → `{success, account}`
- `POST /api/account/{id}/launch` → `{success, url, exitIp}`
- `POST /api/account/{id}/close` → `{success}`
- `POST /api/account/{id}/screenshot`（`{suffix}`）→ `{success, path}`
- `POST /api/account/{id}/persist` → `{success, path}`
- `POST /api/account/{id}/sync` → `{success, ...}`

### 任务 / AI
- `POST /api/task/run` → `{success, results[]}`（`{accountId|accountIds, type, params}`）
- `POST /api/chat` → `{success, reply, intent}`（`{accountId, message}`）
- `POST /api/ai/generate-post` → `{success, text}`（`{prompt}`）
- `GET/POST/DELETE /api/content` 与 `/api/content/{id}`
- `POST /api/distribute`（`{contentId, accountIds}`）
- `GET /api/evolution`
- `GET /api/agent/brief`、`POST /api/agent/supervise`、`GET /api/agent/health`

### 监控 / 监管
- `GET /api/status` → `{success, serverUp, gatewayReachable, watchdogRunning, uptimeSec, supervisor{...}}`
- `GET /api/monitor/state` → `{success, snapshot}`；`GET /api/monitor/history`；`GET /api/watchdog/state`
- `GET /api/perception` → `{success, perception, events[]}`
- `POST /api/passive/start|stop`、`GET /api/passive/status`
- 监管启动器（**直连 18992**）：`GET http://127.0.0.1:18992/status`；`POST .../restart|stop|start`

### OpenClaw 模型 / 修复
- `GET/POST /api/settings/openclaw` → `{success, settings, diagnose}`
- `POST /api/openclaw/repair` → `{success, steps[], error, gatewayReachable}`

### 社团 / 头像 / 数据源
- `GET /api/groups/joined` → `{success, groups[], perAccount[], total}`
- `GET /api/avatar/stats` → `{success, stats{inbox,used,total}, inbox[]}`；`POST /api/avatar/mark-used`（`{filename, accountId}`）
- `GET/POST/DELETE /api/sources`（`{type:'group'|'page', url, name, note}`）

### 代理池
- `GET /api/proxy` → `{success, proxies[]{...,boundAccount}}`
- `POST /api/proxy`（`{name,type,host,port,username,password,country}`）
- `POST /api/proxy/import`（`{text}`）；`POST /api/proxy/test-all`；`POST /api/proxy/test/{id}`
- `POST /api/proxy/{id}/assign`（`{accountId}`）；`POST /api/proxy/{id}/unbind`；`DELETE /api/proxy/{id}`；`POST /api/proxy/auto-assign`

### 策略 / 历史 / 日志 / 系统
- `GET/POST /api/policy`（`{dailyInviteLimit, dailyShareLimit, minDelaySec, maxDelaySec, dedupInvite, dedupShare}`）
- `GET /api/history` → `{success, history[]}`
- `GET /api/logs` → `{success, logs[]}`
- `GET /api/system/profile`
- `POST /api/windows/retile`、`GET /api/windows/bounds`、`GET/POST /api/windows/auto-retile`（`{enabled}`）

### 技能 / 记忆 / 示范
- `GET /api/skills` → `{success, skills[]}`；`POST /api/skills/{id}/toggle`（`{enabled}`）
- `GET /api/memory/shards` → `{success, shards[], global}`；`GET /api/memory/shard/{id}` → `{success, accountId, context}`
- `POST /api/demo/start|stop`（`{accountIds}`）、`GET /api/demo/events?accountId=`、`POST /api/demo/clear`
- `GET /api/health`、`GET /api/mock/state`

---

## 8. 验收标准（DoD）

- [ ] 13 个导航面板全部存在且可切换，顺序与 §3 一致。
- [ ] §2 颜色 Token 全部落地，深色主题一致。
- [ ] TopBar 全部 8 个全局操作可用（对应 §4 接口）。
- [ ] 每个面板表格/列表都有空态（EmptyState）。
- [ ] 每个异步操作都有 Toast 反馈。
- [ ] §6 功能库 19 项全部出现，无遗漏、无多余。
- [ ] §7 每个 API 至少有对应 UI 调用路径（不要求每个都做独立页，但功能可达）。
- [ ] 监控页轮询刷新正常，不下钻到无数据崩溃。
- [ ] 繁体中文（台湾）、Asia/Taipei、仅台湾社团合规。
- [ ] 不出现 §9 OUT 清单中的任何一项。

---

## 9. 范围边界（IN / OUT）— 防缺失、防多余

### ✅ IN（必须全部实现）
- §3 的 13 个面板 + 右下角 FloatingChat + 全局 Toast/Modal/EmptyState。
- §4 的 8 个 TopBar 全局操作。
- §6 的 19 个 FB 功能库项。
- §7 的全部 API 对应的 UI 能力。
- 台湾社团去重（www/非 www + query 归一化）、跨账号重叠提示。

### ❌ OUT（严禁出现，否则即「多余」）
1. **未接入占位功能**（原 UI 标「未接入」的，后端无实现，**一律不做 UI**）：
   - FB 评论指定帖子
   - 账号创建主页
   - 获取广告账号质量 / 花费数据 / 全部广告账号信息
   - 获取广告权限 Access-Token
   - 创建 BM / BM 添加广告账户 / 授权广告账号
2. **两套旧 UI 草稿**（非本次产品，不纳入）：
   - `ui/dashboard.html`（五页版 vanilla JS 旧控制台）
   - `ui/App.tsx` + React 组件（仅 3 页骨架，未接后端）
3. **不得**：新增任何后端无 API 支撑的功能；修改 `src/server.ts` 业务逻辑或 API 契约；删除/隐藏任何已实现面板或功能；引入与现有栈冲突的额外重框架。

---

## 10. 给设计 AI 的注意事项
- 以 §2 Token 为准，保持「深色专业控制台」调性，信息密度高但分区清晰（卡片化）。
- 列表/表格必须支持空态；长任务（AI 执行、代理检测）要有进行中 → 结果反馈。
- 宽屏多列网格，窄屏可滚动，不依赖复杂响应式断点。
- 所有图标可用 emoji 或线性图标，风格统一即可。
- 文案以繁体中文（台湾）呈现；代码注释/变量可用英文或简中。
