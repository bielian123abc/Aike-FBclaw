/**
 * OpenClaw Context — 把"项目移交文档"注入到软件内置 AI Agent 的系統提示中。
 *
 * 目的（用户明确要求）：软件脱离外部开发者后，里面的 OpenClaw Agent 必须知道
 * 整个项目是什么、怎么开发过来的、有哪些安全红线、如何运营与进化。
 * 本模块是"项目移交"的技术落地：每次 LLM 调用都携带 PROJECT_BRIEF.md + 安全红线，
 * 保证 Agent 独立运营时不跑偏、不暴露商业目的、不破坏账号。
 */
import * as fs from 'fs';
import * as path from 'path';
import { APP_ROOT } from '../../config';
import { getSkillCatalogText } from '../openclaw/skill-registry';
import { getGlobalKnowledge } from '../openclaw/memory-service';

let cachedBrief: string | null = null;

/** 读取项目移交文档（带缓存，避免每次 IO） */
export function getProjectBrief(): string {
  if (cachedBrief !== null) return cachedBrief;
  try {
    const p = path.join(APP_ROOT, 'PROJECT_BRIEF.md');
    cachedBrief = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '(项目移交文档缺失)';
  } catch {
    cachedBrief = '(项目移交文档读取失败)';
  }
  return cachedBrief;
}

let cachedLogicMap: string | null = null;
let cachedEvolution: string | null = null;

/** 读取系统运作逻辑分支图（带缓存，避免每次 IO） */
export function getSystemLogicMap(): string {
  if (cachedLogicMap !== null) return cachedLogicMap;
  try {
    const p = path.join(APP_ROOT, 'SYSTEM_LOGIC_MAP.md');
    cachedLogicMap = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '(系统逻辑图缺失)';
  } catch {
    cachedLogicMap = '(系统逻辑图读取失败)';
  }
  return cachedLogicMap;
}

/** 读取进化方向说明书（带缓存，避免每次 IO） */
export function getEvolutionDirection(): string {
  if (cachedEvolution !== null) return cachedEvolution;
  try {
    const p = path.join(APP_ROOT, 'EVOLUTION_DIRECTION.md');
    cachedEvolution = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '(进化方向缺失)';
  } catch {
    cachedEvolution = '(进化方向读取失败)';
  }
  return cachedEvolution;
}

/** 内容生成的安全红线——任何发给 FB 的文字都必须过这一关 */
export const CONTENT_SAFETY_RULES = `你是台湾本地普通 Facebook 网友（非卖家、非客服、非业务）。绝对禁止：营销/商业暴露（不得出现跨境电商、电商、选品、货代、物流、运费、时效、报价、下单、优惠、现货、批发、推广、引流、私域、变现、赚钱、被动收入、课程、代购、一件代发）、色情低俗、政治敏感、欺骗、机器人话术。聊天只做正常朋友聊天，发帖只分享生活/兴趣，问候只自然开场。若对方问业务，礼貌带过不推销。`;

/** 命中即判定为违规的关键词（生成内容若包含其一则丢弃/用本地兜底） */
export const FORBIDDEN_TERMS = [
  '跨境电商', '电商', '选品', '货代', '物流', '运费', '时效', '报价', '下单',
  '优惠', '现货', '批发', '推广', '引流', '私域', '变现', '赚钱', '被动收入',
  '课程', '代购', '一件代发', '很高兴认识您', '根据您的需求', '为您推荐',
  '需要报价的', '现下单', '我们这里有现货',
];

/** 检测文本是否命中安全红线 */
export function violatesSafety(text: string): boolean {
  if (!text) return false;
  return FORBIDDEN_TERMS.some(t => text.includes(t));
}

/**
 * 构建 Agent 系统提示：项目移交文档 + 安全红线 + 任务指令。
 * 用于：聊天回复、问候生成、发帖生成、意图解析 LLM 增强。
 */
export function buildAgentSystemPrompt(roleHint: string): string {
  const brief = getProjectBrief();
  const skills = getSkillCatalogText();
  const knowledge = getGlobalKnowledge().slice(0, 1500);
  const logicMap = getSystemLogicMap();
  const evolution = getEvolutionDirection();
  return [
    '【Aike-FBclaw 项目移交说明书（节选）】',
    brief.slice(0, 4000),
    '',
    '【安全红线（最高约束）】',
    CONTENT_SAFETY_RULES,
    '',
    '【你可调用的技能（你就是软件本体，以下功能都是你的技能）】',
    skills,
    '',
    '【全局知识库（你跨账号学习到的经验，优先参考）】',
    knowledge || '（暂无）',
    '',
    '【系统运作逻辑分支概览（你由哪些分支组成，详见 SYSTEM_LOGIC_MAP.md）】',
    logicMap.slice(0, 2200),
    '',
    '【进化方向（你的长期 north star，详见 EVOLUTION_DIRECTION.md，进化决策前必读）】',
    evolution,
    '',
    '【本次角色】',
    roleHint,
  ].join('\n');
}
