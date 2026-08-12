# Aike-FBclaw 系統運作邏輯全圖（分支化 · OpenClaw 內部參考）

> 本文是給**軟體內建 OpenClaw Agent** 看的「系統運作邏輯分支圖」。
> 目的：讓 Agent 清楚自己由哪些分支組成、每個分支負責什麼、彼此怎麼連動，
> 以及哪些是不變量（絕不能破壞的約束）。搭配 `EVOLUTION_DIRECTION.md` 使用。
> 所有行號以實際程式碼為準（2026-08 版），程式重構後請同步更新。

---

## 0. 一句話定位

Aike-FBclaw = **自建 CDP 指紋瀏覽器引擎** + **OpenClaw（DeepSeek）AI 引擎**，
幫台灣跨境電商從業者以「真實台灣普通人」人設，安全地多帳號經營 Facebook（擴圈→分享→互聊→維繫）。

---

## 1. 主幹流：一個請求怎麼走到 FB

```
UI / 定時器 / 看門狗 / 被動監控
        │
        ▼
server.ts  route()            ← 單一 HTTP 入口 (server.ts:159 / :201)
        │
        ▼
runTask(accountId, type, params)   ← 統一任務引擎 (task-runner.ts:124)
        │
        ├─ 狀態機前置檢查（deleted 拒絕、prepareSessionForTask）
        ▼
switch(type) → skills.*           ← 技能層 (fb-core-skills.ts)
        │
        ▼
ProfileManager(CDP 啟 Chromium) → FingerprintEngine → ProxyManager → 操作 FB DOM
```

### 1.1 入口層 `server.ts`
- 單一 `http.createServer` → `route(url, method, body)` 分發（`:159` / `:201`）。
- 開機自啟 4 個常駐程序（`:1545-1563`）：`startMonitor(5s)`、`startAgentAutoSupervise(5min)`、`startSessionWatchdog(20s)`、`startPassiveMonitor(90s)`，外加 `ensureOpenClawGateway()`。
- 關鍵端點：任務派發 `POST /api/task/run`（`:309`）、AI 對話 `POST /api/chat`（`:338` → 先 LLM 意圖解析後回退規則 → runTask）、被動接管 `POST /api/passive/start|stop|status`（`:639/643/647`）、看門狗 `GET /api/watchdog/state`（`:426`）、監控 `GET /api/monitor/state`（`:419`）、進化 `GET /api/evolution`（`:398`）。
- ⚠️ **不是**預想的「Commander → Squad ×N → Agent ×N」分層：`src/core/agent/orchestrator.ts` 與 `account-agent.ts` 是**藍圖/遺留模組，未被 server.ts 引用**。真實執行路徑就是 `route → runTask → skills.*`，Agent 層由下方 4 個常駐巡檢器組成。

### 1.2 任務引擎 `task-runner.ts`
- `runTask`（`:124`）：最前檢查 `status==='deleted'` 直接拒絕（`:126-128`）；開跑設 `running`（`:132`）；取 `getMemory(accountId)`（`:133`）。
- 前置 `prepareSessionForTask`（`:813`）：偵測 `CRITICAL_PAGE_TYPES`（account_disabled/locked/suspended → 標 `dead`；checkpoint_* → 標 `checkpoint`，`:804-827`）；Messenger PIN 彈窗 → `handleMessengerPin`（`:831-840`）；未登入非 login/sync 任務 → 嘗試自動登入，失敗標 `needs_login`（`:843-859`）。
- `switch(type)` 分發（`:164-252`）：19+ 種 type 對應技能函式（見 §6 技能層）。
- 結束：`dismissPopups` → `persistSession` → `mem.recordAction` → `quickCheck()` 判 `login_checkpoint` 則標 `checkpoint` 否則 `idle`（`:254-264`）。

### 1.3 技能層 `fb-core-skills.ts`（**單一檔案，未拆分**）
- ⚠️ 預想的 `fb-browse/ fb-group/ fb-login/ fb-share/ fb-social/` 五個子目錄**皆為空占位**，所有技能函式集中在 `fb-core-skills.ts`。
- `SkillContext = { page, accountId, memory }`；`SkillResult = { success, action, data?, error?, pageStateAfter? }`（`:21-33`）。
- 共 15 個導出函式（含 `SKILL_MAP`，`:1529-1545`）。詳見 §6。

### 1.4 瀏覽器執行層
- **ProfileManager**（`src/core/browser/profile-manager.ts`）：CDP 方式 `spawn` 真 Chromium（`:115`），`connectOverCDP` 連線（重試 40 次，`:125`），`addInitScript` 注入指紋（`:141`），從 `state.json` 載 Cookie（`:144-157`）；每帳號固定 CDP 埠（`9222 + hash%100`，`:90-95`）+ `user-data-dir` 隔離（`:99`）；持久化到 `data/browser-profiles/profiles.json`（`:229-276`）。
- **FingerprintEngine**（`src/core/browser/fingerprint.ts`，⚠️ 非預想的獨立 FingerprintEngine 檔）：`generate`（`:124`）台灣定位 + 隨機 UA/解析度/WebGL/Canvas/AudioContext 噪聲；`loadOrCreate`（`:170`）跨重啟穩定（落盤 `data/fingerprints/<id>.json`）；`buildInitScript`（`:208`）覆寫 `navigator.webdriver`、注入 Canvas/WebGL/AudioContext 噪聲；`buildLaunchArgs`（`:463`）含 `--proxy-server` / WebRTC 防洩露。
- **ProxyManager**（`src/core/proxy/proxy-manager.ts`）：支援 Clash API、手動、批量匯入（DataImpulse `user:pass@host:port`）；`realProxyCheck`（`:76`）真發 HTTPS 取出口 IP 比對直連，杜絕 TCP 假陽；台灣 DataImpulse 走 SOCKS5 本地轉發器（`shouldUseSocks5Forwarder`，`:72-74`）；`assignSequentially` 順序填空閒槽（`:447`）。

---

## 2. 常駐巡檢分支（4 個獨立循環）

| 巡檢器 | 檔案 | 週期 | 職責 |
|---|---|---|---|
| Monitor | `monitor.ts` | 5s | 快照系統/會話/帳號/錯誤/agent，供面板 |
| Session Watchdog | `session-watchdog.ts` | 20s | 卡死/checkpoint/浮層的智慧處理 |
| Agent Monitor | `agent-monitor.ts` | 5min | LLM 探活 + 自動監管報告 |
| Passive Monitor | `passive-monitor.ts` | 90s | 掃未讀 → 調 `ai_chat_reply` 接管 |

### 2.1 Monitor（`monitor.ts`）
- `ActiveSessionView`（`:19-30`）：`accountId, name, status, url, pid?, uptimeSec, blocker?, stuckSince?, lastWatchdogAction?`。
- `MonitorSnapshot`（`:32-50`）：system/load/activeSessions/accounts/recentErrors/agent(健康+監管報告)/taskThroughput。
- `collectSnapshot`（`:66`）每 5s 一次，環形快取 60 筆（`SNAPSHOT_RING`，`:53`），供 `/api/monitor/state` 與前端 3s 輪詢。

### 2.2 Session Watchdog（`session-watchdog.ts`）—— 最重要的「自愈」分支
- 閾值：`STUCK_RUNNING_MS=5min`（`:47`，任務卡死）、`STUCK_IDLE_FOREIGN_MS=10min`（`:48`，漂外頁）、`STUCK_IDLE_LOW_VALUE_MS=3min`（`:49`，低價值頁如 /messages 空面板更快巡航）。
- 分類集：`DELETE_ON`（checkpoint_identity/photo/friends，`:33`）、`PAUSE_ON`（login_checkpoint/captcha，`:35`）、`DEAD_ON`（account_disabled/locked/suspended，`:37`）、`DISMISSABLE`（cookie/通知/錯誤/action_blocked，`:41-44`）。
- `probe()`（`:172-271`）邏輯：URL+DOM 指紋無變化即計時 → 優先級 `DEAD_ON`→`handleDead`（關窗標 dead）→ `DELETE_ON`/`CHECKPOINT`→`handleDelete`（**標 deleted + 匯出全帳號 CSV 含原因到 `data/accounts-export.csv`**，`:144`/`:211-213`）→ `PAUSE_ON`→`handlePause`（標 checkpoint）→ Messenger PIN 全自動 `handleMessengerPin`（`:218-231`）→ 可關浮層 `dismissOverlays`（`:234-241`）→ 卡頓告警 / 空面板巡航回首頁。
- `inflight` 互斥防重疊（`:273-281`）。

### 2.3 Agent Monitor（`agent-monitor.ts` + `supervisor.ts`）
- `pingLLM`（`:45`）探活 callLLM；`startAgentAutoSupervise(5min)`（`:79`）週期產監管報告並沉澱知識庫。
- `supervisor.ts` 的 `agentSupervise`（`:27`）：彙整日誌/帳號風控/自進化參數 → 調 LLM 產健康總結 + ≤3 條建議 → 本地兜底（高風控降頻、頻繁錯誤全停）。`persistSuperviseToKnowledge`（`:84`）沉澱到全局知識庫。

### 2.4 Passive Monitor（`passive-monitor.ts`）
- `startPassiveMonitor(90s)`（`:21`）：遍歷活動會話，`SKIP_STATUSES = {checkpoint,dead,deleted,error,needs_login}` 跳過（`:19,29`），`running` 互斥（`:30-38`），定時調 `runTask(id,'ai_chat_reply',{})`（`:33`）。
- 這是「被動聊天」唯一入口；主動聊天由 UI/任務直接觸發（見 §8）。

---

## 3. 帳號狀態機分支（8 狀態）

`Account.status` 聯合型別（`account-store.ts:18`）：
`offline | idle | running | error | checkpoint | needs_login | dead | deleted`

- 流轉：`runTask` 置 `running`→`idle`/`checkpoint`/`error`/`dead`（task-runner `:132,259-264`）；`prepareSessionForTask` 置 `dead`/`checkpoint`/`needs_login`（`:820-858`）；看門狗 `handleDelete/handlePause/handleDead` 置 `deleted`/`checkpoint`/`dead`（session-watchdog `:144-170`）。
- 關鍵不變量：**`deleted` 帳號永不進入自動化**（runTask 拒絕 + passive-monitor 跳過 + socialize 過濾）。

---

## 4. 頁面感知分支

`src/detection/page-detector.ts`（⚠️ 非預想的 FacebookPageDetector 檔，類名 `FacebookPageDetector`）：
- `FacebookPageType`（`:16-45`）共 **29** 種（非 28）：含 login/login_2fa/login_checkpoint/checkpoint_photo/checkpoint_identity/login_captcha/home/profile_*/group*/page/post_detail/reels/watch/messenger/notifications/settings/marketplace/ads_manager/account_disabled/account_locked/suspended 等。
- `PopupType`（`:47-67`）共 **20** 種含 `custom_dialog`：cookie/notification/friend_request_sent/post_shared/action_blocked/rate_limit/login_alert/password_expired/suspicious_activity/confirm_*/group_join_question/checkpoint_*/messenger_pin_*/error_dialog 等。
- `detectPageState`（`:127`）：併行 classifyPageType + detectPopup + checkLoginStatus + extractCurrentUser + detectWarnings + 文本摘要，產 `suggestedActions`。`quickCheck`（`:180`）輕量版供輪詢。

---

## 5. AI 引擎分支（OpenClaw 自身）

### 5.1 引擎 `engine.ts`
- 軟體內**唯一**智能體客戶端，經 `openclaw.mjs` CLI 委派（`agent --agent main --message ... --json`，`:78`），網關 `:18789`。`runOpenClawAgent`（`:76`）不可達回 `null`（呼叫方走本地兜底）。`OpenClawEngine` 單例（`getOpenClaw`，`:209`）。

### 5.2 意圖解析 `intent-parser.ts`
- `parseIntent`（`:155`）：本地 17 條正則規則（無網可跑）。
- `parseIntentWithLLM`（`:168`）：走 OpenClaw 單一智能體，JSON 解析 `{type,params,replyToUser}`，失敗回退 `parseIntent`。server `:342-343` 先 LLM 後規則。

### 5.3 內容/對話生成 `ai-provider.ts`
- `callLLM`（`:16`）：**唯一通道 = OpenClaw**（背後 DeepSeek 由 OpenClaw 配置），3 次重試；命中 `violatesSafety` 一律丟棄。
- 本地啟發式兜底 `localReply`（`:64`）：問候/生活/興趣/問題/預設 5 類模板（無網可跑）——這是「脫離開發者也能跑」的支柱。
- 對外：`generateChatReply`/`generateGreeting`/`rewriteContent`（分發改寫+安全擦洗）/`generateChatMessage`（主動互聊）/`generatePostContent`。全部台灣本地網友人設、禁商業/推銷。

### 5.4 被動接管 + 一級介紹 `passive-takeover.ts`
- `LEVEL1_TRIGGERS`：對方問「你是做什麼/你是賣/從事什麼…」→ `level1_intro`（`:18-22`）。
- `detectTakeoverTrigger`（`:26`）：命中级1介紹，否則一律 `chat`（任何來訊都可接管）。
- `generateTakeoverReply`（`:40`）：`level1_intro` 走 `getOpenClaw().chat` 自然介紹「做跨境電商/吃穿住行可幫你看貨比價」，**不走 FORBIDDEN_TERMS 濾網**（這是刻意的安全網：一級介紹允許輕描淡寫點出身份），失敗回退 `LEVEL1_FALLBACK`；普通 `chat` 複用 `generateChatReply`（走安全濾網）。

### 5.5 記憶系統 `memory-service.ts` + `account-memory.ts`
- **記憶碎片** `data/memory/shards/<accountId>.json`：`keyFacts`（跨會話不丟）/ `importantMemories`（壓縮保留）/ `recentContext`（滾動 60）/ `relationships`。`summarizeContext`（`:87`）產壓縮上下文給 OpenClaw。
- **全局知識庫** `data/memory/global-knowledge.md`：`getGlobalKnowledge`（`:97`）跨帳號學習，被 `buildAgentSystemPrompt` 注入（截 1500 字）；`appendGlobalKnowledge`（`:105`）由 supervisor 沉澱。
- **帳號行為記憶** `account-memory.ts`：SQLite 存好友/互動/對話/關係階段。

### 5.6 監管 + 自進化
- `supervisor.ts`（見 §2.3）。
- `self-evolution.ts`：基於成功率調 `delayMultiplier`/`frequencyFactor`/`riskLevel`（`:29-77`），寫 `data/evolution/<accountId>.json`，task-runner 讀取套用。

---

## 6. 技能層清單（15 函式，全在 fb-core-skills.ts）

| 技能函式 | 行號 | 任務 type | 說明 |
|---|---|---|---|
| skillLogin | :40 | login | 逐字輸入 + 登入後狀態 switch |
| skillBrowseFeed | :149 | browse_feed | 滑 feed + 隨機讚 |
| skillLikePost | :206 | like_post | 點讚 |
| skillSharePost | :266 | share_post | 點分享→按 target 選方式→發 |
| skillAddFriends | :356 | add_friends | mode=recommendations/group_members/profile/search |
| skillAddFriendByName | :437 | add_friend_by_name | 按 FB 名搜人→Add friend（自家互加） |
| skillInviteToGroup | :486 | invite_to_group | 邀請進社團 |
| skillJoinGroups | :564 | join_groups | 關鍵字搜台灣社團加入 |
| handleMessengerPin | :658 | — | 建/驗 PIN `000000` |
| skillSendMessage | :783 | send_message | 解析 UID 走全頁 `/messages/t/<uid>/`（規避 fbsbx 跨域 iframe） |
| skillSendMessageToName | :900 | send_message_to_name | 按名私訊（自家互聊） |
| skillCreatePost | :934 | create_post | 發帖 |
| skillGetFriends | :1004 | get_friends | 取好友列表寫記憶體 |
| skillInviteToPage | :1183 | invite_to_page | 邀請讚主頁 |
| skillSetLanguageTaiwan | :1480 | — | 冪等設繁中(台)，檢 `<html lang>` |

> 技能中心（`skill-registry.ts`）維護 19 個技能的啟用/用量統計，產「技能目錄文本」注入 OpenClaw 上下文（`getSkillCatalogText`，`:99`）。

---

## 7. 養號調度分支 `warmup-scheduler.ts`

- `startWarmupScheduler(30min)`（`:105`）：僅台灣活躍時段 `isActiveHours()` 執行（`:87`），帳號錯開 30-90s。
- `runWarmupCycle`（`:22`）：`sync`→`browse_feed`(每日必做,新號 likeProb 0.2)→(非new)加好友→(mature)加社團→(非new)發帖，全委 `runTask`。dryRun 只跑前兩步。
- ⚠️ 調度器**不隨服務開機自啟**（無 boot 呼叫），僅由 `/api/warmup/run|stop` 觸發。

---

## 8. 主動 vs 被動聊天（關鍵不變量）

- **主動聊天**：由 UI/任務直接觸發——`send_message` / `send_message_to_name` / `socialize` 裡的互聊。目標是「擴圈後主動維繫」。
- **被動聊天**：**僅**由 `passive-monitor` 定時調 `ai_chat_reply`（掃 /messages 未讀 → 接管回覆，含一級介紹）。
- 兩者最終都走 `skills.skillSendMessage`。
- 關鍵約束：被動掃描只負責回未讀，**回完/無未讀即回首頁保持乾淨**（task-runner `:751-757`），絕不能停在空 Messenger 面板（那是低價值頁，看門狗會巡航）。

---

## 9. 安全紅線（最高約束，重申）

任何發給 FB 的文字、任何動作話術都必須過 `openclaw-context.ts` 的 `CONTENT_SAFETY_RULES` 與 `FORBIDDEN_TERMS`（`violatesSafety` 命中即丟棄/本地兜底）：
- 禁商業暴露（電商/選品/貨代/物流/報價/優惠/批發/推廣/引流/私域/變現/代購…）。
- 禁色情/政治敏感/欺騙/機器人話術。
- 聊天只做正常朋友聊天；對方問業務才一級介紹（刻意安全網）。
- 真人節奏（隨機延時、非線性滾動）；每日量受 `config.ts` 的 `SAFETY_LIMITS` 約束（new{w5/10/1}, warmup{w10/20/3}, mature{w20/40/5}）。
- Checkpoint/驗證碼必須停下等人處理，絕不硬闖。

---

## 10. 已知坑（高頻踩點，已沉澱至 fbclaw-browser-patterns 技能）

1. **FB 跨域 iframe composer**：檔案頁「訊息」停靠面板的 composer 渲染在 `fbsbx.com/maw_proxy_page` 跨域 iframe（主 DOM 取不到）；**全頁** `/messages/t/<uid>/` 的 composer 在主 DOM（可用）。`skillSendMessage` 因此改走全頁 thread。
2. **絕不對「訊息」按鈕二次點擊**——第二次點擊會關掉面板。
3. **`noViewport` 已移除**：持久化 context 啟動別再用該選項（ts 類型不存在）。
4. **真實 FB 驗證有鎖號風險**：獨立啟動持久化 context 不帶台灣代理會觸發異地校驗，勿拿真號冒險。
5. **藍圖模組勿接**：`orchestrator.ts`/`account-agent.ts` 是遺留，當前執行路徑是 `route → runTask → skills.*`。

---

## 11. 進化方向（詳見 EVOLUTION_DIRECTION.md）

見同目錄 `EVOLUTION_DIRECTION.md`——那是給 OpenClaw 的長期 north star（短期修缺陷、中期補能力、長期自主運營/進化，以及「不做什么」的進化紀律）。本文是其「系統結構地基」，兩者配套使用。
