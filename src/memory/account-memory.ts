/**
 * AccountMemory — 每个 Facebook 账号的独立记忆体
 * 
 * 核心职责：
 * 1. 好友列表与互动记录
 * 2. 邀请历史（谁被邀请过进社团）
 * 3. 对话历史（给谁发过什么，对方回了什么）
 * 4. 操作日志
 * 5. 社交关系评分（谁与我互动最多）
 * 
 * 参考 OpenClaw 的蛛网记忆体设计：
 * - MEMORY.md 存储长期关键信息
 * - memory/YYYY-MM-DD.md 存储每日操作日志
 * - SQLite 存储结构化数据
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../config';

// ==================== 数据结构 ====================

export interface FriendRecord {
  friendId: string;
  name: string;
  facebookUrl?: string;
  avatarUrl?: string;
  dateAdded: number;
  source: 'mutual_friend' | 'group' | 'search' | 'recommendation' | 'manual' | 'unknown';
  sourceGroup?: string;
  interactionScore: number;     // 互动评分 0-100
  lastInteraction: number;
  interactionCount: number;
  tags: string[];
  notes: string;
  hasBeenInvitedToGroup: boolean;
  invitedGroupIds: string[];
}

export interface InteractionRecord {
  id: string;
  friendId: string;
  friendName: string;
  type: 'like' | 'comment' | 'share' | 'message_sent' | 'message_received' | 'tag' | 'reaction';
  content: string;
  timestamp: number;
  context: string;              // e.g. "在XX帖子下", "在社团XX中"
  url?: string;
}

export interface InvitationRecord {
  id: string;
  friendId: string;
  friendName: string;
  groupId: string;
  groupName: string;
  timestamp: number;
  status: 'invited' | 'joined' | 'pending' | 'failed';
}

export interface ConversationRecord {
  friendId: string;
  friendName: string;
  messages: ConversationMessage[];
  lastMessageTime: number;
  totalMessages: number;
}

export interface ConversationMessage {
  id: string;
  direction: 'sent' | 'received';
  content: string;
  timestamp: number;
  hasAttachment: boolean;
}

export interface MemorySummary {
  accountId: string;
  totalFriends: number;
  totalInteractions: number;
  totalInvitations: number;
  totalConversations: number;
  topFriends: FriendRecord[];        // 互动最多的好友
  recentInteractions: InteractionRecord[];
  pendingInvitations: InvitationRecord[];
  lastUpdate: number;
}

// ==================== Onboarding 单账号记忆 ====================
// 每次开号「自愈式首登管線」的持久化状态：记录 語言/頭像/PIN/主頁點讚 四步
// 各自是否已完成、用什么方式完成、何时完成；以及整体是否 allComplete。
export interface OnboardingStepState {
  done: boolean;
  method?: 'detected' | 'applied' | 'no_dialog' | 'skipped';
  at?: number;
  error?: string;
}

export interface StoredOnboardingState {
  steps: Record<string, OnboardingStepState>;
  allComplete: boolean;
  lastCheckedAt: number;
}

// ==================== AccountMemory ====================

export class AccountMemory {
  public readonly accountId: string;
  private db: Database.Database;
  private dataDir: string;

  // Prepared statements (for performance)
  private stmtAddFriend!: Database.Statement;
  private stmtGetFriend!: Database.Statement;
  private stmtUpdateFriendScore!: Database.Statement;
  private stmtAddInteraction!: Database.Statement;
  private stmtAddInvitation!: Database.Statement;
  private stmtGetInteractions!: Database.Statement;
  private stmtGetTopFriends!: Database.Statement;
  private stmtSearchFriends!: Database.Statement;

  constructor(accountId: string) {
    this.accountId = accountId;
    this.dataDir = path.join(DATA_DIR, 'accounts', accountId);
    
    // 确保目录存在
    fs.mkdirSync(path.join(this.dataDir, 'memory'), { recursive: true });

    // 初始化 SQLite
    this.db = new Database(path.join(this.dataDir, 'memory.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    
    this.initSchema();
    this.prepareStatements();
    this.ensureMemoryFiles();
  }

  // ==================== Schema ====================

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS friends (
        friend_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        facebook_url TEXT,
        avatar_url TEXT,
        date_added INTEGER NOT NULL,
        source TEXT DEFAULT 'unknown',
        source_group TEXT,
        interaction_score REAL DEFAULT 0,
        last_interaction INTEGER DEFAULT 0,
        interaction_count INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]',
        notes TEXT DEFAULT '',
        has_been_invited INTEGER DEFAULT 0,
        invited_group_ids TEXT DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        friend_id TEXT NOT NULL,
        friend_name TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT DEFAULT '',
        timestamp INTEGER NOT NULL,
        context TEXT DEFAULT '',
        url TEXT
      );

      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        friend_id TEXT NOT NULL,
        friend_name TEXT NOT NULL,
        group_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        status TEXT DEFAULT 'invited'
      );

      CREATE TABLE IF NOT EXISTS conversations (
        friend_id TEXT NOT NULL,
        friend_name TEXT NOT NULL,
        last_message_time INTEGER NOT NULL,
        total_messages INTEGER DEFAULT 0,
        messages_json TEXT DEFAULT '[]',
        PRIMARY KEY (friend_id)
      );

      CREATE TABLE IF NOT EXISTS action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_type TEXT NOT NULL,
        params TEXT DEFAULT '{}',
        result TEXT DEFAULT '{}',
        success INTEGER DEFAULT 1,
        error_msg TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS manual_activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_type TEXT NOT NULL,
        description TEXT,
        page_url TEXT,
        page_type TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relationship_stage (
        friend_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL DEFAULT 'new_contact',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS onboarding_kv (
        account_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- 索引
      CREATE INDEX IF NOT EXISTS idx_friends_score ON friends(interaction_score DESC);
      CREATE INDEX IF NOT EXISTS idx_friends_name ON friends(name);
      CREATE INDEX IF NOT EXISTS idx_friends_tags ON friends(tags);
      CREATE INDEX IF NOT EXISTS idx_interactions_friend ON interactions(friend_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_interactions_timestamp ON interactions(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_invitations_friend ON invitations(friend_id);
      CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);
      CREATE INDEX IF NOT EXISTS idx_action_log_type ON action_log(action_type, timestamp DESC);
    `);
  }

  private prepareStatements(): void {
    this.stmtAddFriend = this.db.prepare(`
      INSERT OR REPLACE INTO friends 
      (friend_id, name, facebook_url, avatar_url, date_added, source, source_group, 
       interaction_score, last_interaction, interaction_count, tags, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetFriend = this.db.prepare(`
      SELECT * FROM friends WHERE friend_id = ?
    `);

    this.stmtUpdateFriendScore = this.db.prepare(`
      UPDATE friends 
      SET interaction_score = ?, last_interaction = ?, interaction_count = interaction_count + 1
      WHERE friend_id = ?
    `);

    this.stmtAddInteraction = this.db.prepare(`
      INSERT INTO interactions (id, friend_id, friend_name, type, content, timestamp, context, url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtAddInvitation = this.db.prepare(`
      INSERT OR REPLACE INTO invitations (id, friend_id, friend_name, group_id, group_name, timestamp, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetInteractions = this.db.prepare(`
      SELECT * FROM interactions 
      WHERE friend_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);

    this.stmtGetTopFriends = this.db.prepare(`
      SELECT * FROM friends
      WHERE interaction_score > 0
      ORDER BY interaction_score DESC
      LIMIT ?
    `);

    this.stmtSearchFriends = this.db.prepare(`
      SELECT * FROM friends
      WHERE name LIKE ? OR facebook_url LIKE ?
      ORDER BY interaction_score DESC
      LIMIT ?
    `);
  }

  private ensureMemoryFiles(): void {
    const memoryMd = path.join(this.dataDir, 'MEMORY.md');
    if (!fs.existsSync(memoryMd)) {
      fs.writeFileSync(memoryMd, `# 账号记忆 — ${this.accountId}\n\n## 基本信息\n\n## 核心好友\n\n## 重要记录\n\n`);
    }

    const todayLog = path.join(this.dataDir, 'memory', this.todayFilename());
    if (!fs.existsSync(todayLog)) {
      fs.writeFileSync(todayLog, `# ${this.todayFilename().replace('.md', '')}\n\n`);
    }
  }

  // ==================== 好友管理 ====================

  /**
   * 添加好友记录
   */
  addFriend(friend: Omit<FriendRecord, 'interactionScore' | 'lastInteraction' | 'interactionCount' | 'hasBeenInvitedToGroup' | 'invitedGroupIds'>): void {
    this.stmtAddFriend.run(
      friend.friendId,
      friend.name,
      friend.facebookUrl || null,
      friend.avatarUrl || null,
      friend.dateAdded,
      friend.source,
      friend.sourceGroup || null,
      0, // initial score
      0, // last interaction
      0, // interaction count
      JSON.stringify(friend.tags || []),
      friend.notes || ''
    );
  }

  /**
   * 获取好友信息
   */
  getFriend(friendId: string): FriendRecord | null {
    const row = this.stmtGetFriend.get(friendId) as any;
    if (!row) return null;
    return this.rowToFriend(row);
  }

  /**
   * 获取所有好友
   */
  getAllFriends(): FriendRecord[] {
    const rows = this.db.prepare('SELECT * FROM friends ORDER BY name').all() as any[];
    return rows.map(r => this.rowToFriend(r));
  }

  /**
   * 互动评分最高的好友
   */
  getTopFriends(limit: number = 20): FriendRecord[] {
    const rows = this.stmtGetTopFriends.all(limit) as any[];
    return rows.map(r => this.rowToFriend(r));
  }

  /**
   * 搜索好友
   */
  searchFriends(query: string, limit: number = 20): FriendRecord[] {
    const pattern = `%${query}%`;
    const rows = this.stmtSearchFriends.all(pattern, pattern, limit) as any[];
    return rows.map(r => this.rowToFriend(r));
  }

  // ==================== 互动记录 ====================

  /**
   * 记录一次互动
   */
  recordInteraction(interaction: Omit<InteractionRecord, 'id'>): string {
    const id = `int_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.stmtAddInteraction.run(
      id,
      interaction.friendId,
      interaction.friendName,
      interaction.type,
      interaction.content,
      interaction.timestamp,
      interaction.context,
      interaction.url || null
    );

    // 更新好友互动评分
    const friend = this.getFriend(interaction.friendId);
    if (friend) {
      const newScore = Math.min(100, friend.interactionScore + this.getInteractionWeight(interaction.type));
      this.stmtUpdateFriendScore.run(newScore, interaction.timestamp, interaction.friendId);
    }

    return id;
  }

  /**
   * 获取与某位好友的互动历史
   */
  getInteractionsWith(friendId: string, limit: number = 50): InteractionRecord[] {
    const rows = this.stmtGetInteractions.all(friendId, limit) as any[];
    return rows.map(r => ({
      ...r,
      type: r.type,
    }));
  }

  /**
   * 获取最近互动
   */
  getRecentInteractions(limit: number = 50): InteractionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM interactions ORDER BY timestamp DESC LIMIT ?'
    ).all(limit) as any[];
    return rows.map(r => ({ ...r, type: r.type }));
  }

  // ==================== 邀请记录 ====================

  /**
   * 记录邀请好友进社团
   */
  recordInvitation(invitation: Omit<InvitationRecord, 'id'>): string {
    const id = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.stmtAddInvitation.run(
      id,
      invitation.friendId,
      invitation.friendName,
      invitation.groupId,
      invitation.groupName,
      invitation.timestamp,
      invitation.status
    );

    // 更新好友的邀请标记
    this.db.prepare(`
      UPDATE friends 
      SET has_been_invited = 1,
          invited_group_ids = json_insert(invited_group_ids, '$[#]', ?)
      WHERE friend_id = ?
    `).run(invitation.groupId, invitation.friendId);

    return id;
  }

  /**
   * 检查好友是否已被邀请到某社团
   */
  hasBeenInvited(friendId: string, groupId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM invitations WHERE friend_id = ? AND group_id = ? LIMIT 1'
    ).get(friendId, groupId);
    return !!row;
  }

  /**
   * 获取待处理的邀请
   */
  getPendingInvitations(): InvitationRecord[] {
    return this.db.prepare(
      'SELECT * FROM invitations WHERE status = ? ORDER BY timestamp DESC'
    ).all('pending') as InvitationRecord[];
  }

  /**
   * 获取某社团的所有邀请记录
   */
  getGroupInvitations(groupId: string): InvitationRecord[] {
    return this.db.prepare(
      'SELECT * FROM invitations WHERE group_id = ? ORDER BY timestamp DESC'
    ).all(groupId) as InvitationRecord[];
  }

  // ==================== 对话记录 ====================

  /**
   * 记录对话消息
   */
  recordMessage(friendId: string, friendName: string, message: ConversationMessage): void {
    const existing = this.db.prepare(
      'SELECT * FROM conversations WHERE friend_id = ?'
    ).get(friendId) as any;

    if (existing) {
      const messages = JSON.parse(existing.messages_json || '[]');
      messages.push(message);
      // 最多保留500条消息
      if (messages.length > 500) {
        messages.splice(0, messages.length - 500);
      }

      this.db.prepare(`
        UPDATE conversations 
        SET messages_json = ?, last_message_time = ?, total_messages = ?
        WHERE friend_id = ?
      `).run(JSON.stringify(messages), message.timestamp, messages.length, friendId);
    } else {
      this.db.prepare(`
        INSERT INTO conversations (friend_id, friend_name, last_message_time, total_messages, messages_json)
        VALUES (?, ?, ?, 1, ?)
      `).run(friendId, friendName, message.timestamp, JSON.stringify([message]));
    }
  }

  /**
   * 获取与某位好友的对话
   */
  getConversation(friendId: string): ConversationRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM conversations WHERE friend_id = ?'
    ).get(friendId) as any;

    if (!row) return null;

    return {
      friendId: row.friend_id,
      friendName: row.friend_name,
      messages: JSON.parse(row.messages_json || '[]'),
      lastMessageTime: row.last_message_time,
      totalMessages: row.total_messages,
    };
  }

  /**
   * 生成对话上下文（供 AI 使用）
   */
  getConversationContext(friendId: string, maxMessages: number = 20): string {
    const conv = this.getConversation(friendId);
    if (!conv || conv.messages.length === 0) return '无历史对话';

    const recent = conv.messages.slice(-maxMessages);
    return recent.map(m => {
      const prefix = m.direction === 'sent' ? '我' : '对方';
      return `[${new Date(m.timestamp).toLocaleString('zh-TW')}] ${prefix}: ${m.content}`;
    }).join('\n');
  }

  // ==================== 操作日志 ====================

  /**
   * 记录操作（成功）
   */
  async recordAction(actionType: string, params: any, result: any): Promise<void> {
    this.db.prepare(`
      INSERT INTO action_log (action_type, params, result, success, timestamp)
      VALUES (?, ?, ?, 1, ?)
    `).run(actionType, JSON.stringify(params), JSON.stringify(result), Date.now());

    // 同时写入每日日志
    this.appendDailyLog(`- ✅ ${actionType}: ${JSON.stringify(params).slice(0, 100)}`);
  }

  /**
   * 记录错误
   */
  async recordError(actionType: string, errorMsg: string): Promise<void> {
    this.db.prepare(`
      INSERT INTO action_log (action_type, params, error_msg, success, timestamp)
      VALUES (?, '{}', ?, 0, ?)
    `).run(actionType, errorMsg, Date.now());

    this.appendDailyLog(`- ❌ ${actionType}: ${errorMsg}`);
  }

  /**
   * 记录人工操作
   */
  async recordManualActivity(pageState: any): Promise<void> {
    this.db.prepare(`
      INSERT INTO manual_activity_log (activity_type, description, page_url, page_type, timestamp)
      VALUES ('manual_takeover', ?, ?, ?, ?)
    `).run(
      '人工接管期间操作',
      pageState.pageTextSummary?.slice(0, 200) || '',
      pageState.url || '',
      pageState.pageType || 'unknown',
      Date.now()
    );

    this.appendDailyLog(`- 👤 人工接管操作 (页面: ${pageState.pageType})`);
  }

  // ==================== 關係階段追蹤（PRD 2.4 對話階段） ====================

  /** 設定好友關係階段：new_contact / building_trust / guiding / maintaining */
  setRelationshipStage(friendId: string, stage: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO relationship_stage (friend_id, stage, updated_at)
      VALUES (?, ?, ?)
    `).run(friendId, stage, Date.now());
  }

  getRelationshipStage(friendId: string): string {
    const row = this.db.prepare('SELECT stage FROM relationship_stage WHERE friend_id = ?').get(friendId) as any;
    return row?.stage || 'new_contact';
  }

  // ==================== Onboarding 首登管線記憶（自愈式單帳號狀態） ====================

  /** 讀取本帳號的 onboarding 狀態；首次開號（無記錄）回傳 null */
  getOnboarding(): StoredOnboardingState | null {
    const row = this.db.prepare('SELECT state FROM onboarding_kv WHERE account_id = ?').get(this.accountId) as any;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.state);
      if (parsed && typeof parsed === 'object' && parsed.steps) return parsed as StoredOnboardingState;
    } catch { /* corrupt -> 視為無記錄 */ }
    return null;
  }

  /** 寫入/更新本帳號的 onboarding 狀態（runOnboarding 每次檢測後調用） */
  setOnboarding(state: StoredOnboardingState): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO onboarding_kv (account_id, state, updated_at)
      VALUES (?, ?, ?)
    `).run(this.accountId, JSON.stringify(state), Date.now());
  }

  // ==================== 自進化統計（PRD 2.4 核心流程⑥） ====================

  /** 各動作類型的成功率統計，供自進化調參使用 */
  getActionStats(): { actionType: string; total: number; success: number; rate: number }[] {
    const rows = this.db.prepare(`
      SELECT action_type,
             COUNT(*) as total,
             SUM(success) as success
      FROM action_log
      GROUP BY action_type
      ORDER BY total DESC
    `).all() as any[];
    return rows.map(r => ({
      actionType: r.action_type,
      total: r.total || 0,
      success: r.success || 0,
      rate: r.total ? (r.success || 0) / r.total : 1,
    }));
  }

  // ==================== 汇总查询 ====================

  /**
   * 生成记忆摘要
   */
  getMemorySummary(): MemorySummary {
    const totalFriends = this.db.prepare('SELECT COUNT(*) as count FROM friends').get() as any;
    const totalInteractions = this.db.prepare('SELECT COUNT(*) as count FROM interactions').get() as any;
    const totalInvitations = this.db.prepare('SELECT COUNT(*) as count FROM invitations').get() as any;
    const totalConversations = this.db.prepare('SELECT COUNT(*) as count FROM conversations').get() as any;

    const topFriends = this.getTopFriends(10);
    const recentInteractions = this.getRecentInteractions(20);
    const pendingInvitations = this.getPendingInvitations();

    return {
      accountId: this.accountId,
      totalFriends: totalFriends?.count || 0,
      totalInteractions: totalInteractions?.count || 0,
      totalInvitations: totalInvitations?.count || 0,
      totalConversations: totalConversations?.count || 0,
      topFriends,
      recentInteractions,
      pendingInvitations,
      lastUpdate: Date.now(),
    };
  }

  /**
   * 查询：某好友与我互动最多的前N位
   */
  getFriendInteractionRanking(): { friendId: string; name: string; score: number; count: number }[] {
    const rows = this.db.prepare(`
      SELECT friend_id, name, interaction_score as score, interaction_count as count
      FROM friends
      WHERE interaction_score > 0
      ORDER BY interaction_score DESC
    `).all() as any[];

    return rows.map(r => ({
      friendId: r.friend_id || r.friendId,
      name: r.name,
      score: r.score,
      count: r.count,
    }));
  }

  // ==================== 文件操作 ====================

  private appendDailyLog(text: string): void {
    const logFile = path.join(this.dataDir, 'memory', this.todayFilename());
    try {
      fs.appendFileSync(logFile, `${text}\n`);
    } catch (_e: any) { /* ignore */ }
  }

  private todayFilename(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}.md`;
  }

  // ==================== 工具方法 ====================

  private rowToFriend(row: any): FriendRecord {
    return {
      friendId: row.friend_id,
      name: row.name,
      facebookUrl: row.facebook_url,
      avatarUrl: row.avatar_url,
      dateAdded: row.date_added,
      source: row.source,
      sourceGroup: row.source_group,
      interactionScore: row.interaction_score,
      lastInteraction: row.last_interaction,
      interactionCount: row.interaction_count,
      tags: JSON.parse(row.tags || '[]'),
      notes: row.notes || '',
      hasBeenInvitedToGroup: row.has_been_invited === 1,
      invitedGroupIds: JSON.parse(row.invited_group_ids || '[]'),
    };
  }

  private getInteractionWeight(type: string): number {
    const weights: Record<string, number> = {
      'message_sent': 5,
      'message_received': 8,
      'comment': 3,
      'like': 1,
      'share': 4,
      'tag': 3,
      'reaction': 2,
    };
    return weights[type] || 1;
  }

  /**
   * 更新 MEMORY.md
   */
  async updateMemoryMd(): Promise<void> {
    const summary = this.getMemorySummary();
    const content = `# 账号记忆 — ${this.accountId}

## 基本统计
- 好友数: ${summary.totalFriends}
- 总互动次数: ${summary.totalInteractions}
- 邀请记录: ${summary.totalInvitations}
- 对话数量: ${summary.totalConversations}
- 最后更新: ${new Date(summary.lastUpdate).toLocaleString('zh-TW')}

## 互动最频繁的好友
${summary.topFriends.map((f, i) => 
  `${i + 1}. ${f.name} (互动评分: ${f.interactionScore}, 互动次数: ${f.interactionCount})`
).join('\n')}

## 最近互动
${summary.recentInteractions.slice(0, 20).map(r => 
  `- [${new Date(r.timestamp).toLocaleString('zh-TW')}] ${r.type}: ${r.friendName} (${r.context})`
).join('\n')}

## 待处理邀请
${summary.pendingInvitations.length > 0 
  ? summary.pendingInvitations.map(i => 
      `- ${i.friendName} → ${i.groupName} (${new Date(i.timestamp).toLocaleString('zh-TW')})`
    ).join('\n')
  : '无待处理邀请'}
`;

    try {
      fs.writeFileSync(path.join(this.dataDir, 'MEMORY.md'), content);
    } catch (_e: any) { /* ignore */ }
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
  }
}
