/**
 * 人类行为模拟工具
 * 所有自动化操作都经过这些方法包装，增加随机性
 */
import { Page } from 'playwright-core';

/**
 * 随机延迟（毫秒）
 */
export function randomDelay(min: number, max: number): Promise<void> {
  const delay = min + Math.random() * (max - min);
  return new Promise(r => setTimeout(r, Math.round(delay)));
}

/**
 * 人类滚动（非线性速度）
 */
export function humanScrollAmount(min: number, max: number): number {
  // 使用对数正态分布模拟人类滚动的不规则性
  const base = min + Math.random() * (max - min);
  const jitter = (Math.random() - 0.5) * base * 0.3; // ±15% 抖动
  return Math.round(base + jitter);
}

/**
 * 人类打字间隔（毫秒）
 * 模拟不同字符之间的打字速度差异
 */
export function humanTypingDelay(): number {
  // 正态分布：均值 120ms，标准差 40ms
  const u = 1 - Math.random();
  const v = 1 - Math.random();
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(30, Math.min(300, 120 + normal * 40));
}

/**
 * 动作之间的思考/阅读时间（毫秒）
 */
export function readingPause(): number {
  // 偏长的时间范围，模拟真实阅读行为
  return 800 + Math.random() * 4200;
}

/**
 * 概率决策
 */
export function shouldDoAction(probability: number): boolean {
  return Math.random() < probability;
}

/**
 * 随机选择数组中的一个元素
 */
export function randomPick<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 随机选择多个不重复元素
 */
export function randomPickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

/**
 * 在指定范围内生成随机整数
 */
export function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * 时间间隔分散（避免固定模式）
 * 将 N 次操作分散到 duration 时间内
 */
export function disperseActions(count: number, durationMs: number): number[] {
  const intervals: number[] = [];
  let remaining = durationMs;
  
  for (let i = 0; i < count - 1; i++) {
    // 剩余时间除以剩余次数，加上随机抖动
    const avgInterval = remaining / (count - i);
    const minInterval = avgInterval * 0.4;
    const maxInterval = avgInterval * 1.6;
    const interval = minInterval + Math.random() * (maxInterval - minInterval);
    intervals.push(Math.round(interval));
    remaining -= interval;
  }
  
  intervals.push(Math.round(remaining)); // 最后一次用剩余时间
  return intervals;
}

/**
 * 账户冷却计算
 * 根据错误类型返回建议冷却时间
 */
export function calculateCooldown(errorType: string): number {
  const cooldowns: Record<string, number> = {
    'rate_limit': 30 * 60 * 1000,      // 30分钟
    'action_blocked': 60 * 60 * 1000,  // 1小时
    'suspicious_activity': 2 * 60 * 60 * 1000, // 2小时
    'login_failed': 5 * 60 * 1000,     // 5分钟
    'checkpoint': 24 * 60 * 60 * 1000, // 24小时（需要人工）
    'default': 15 * 60 * 1000,         // 15分钟
  };
  return cooldowns[errorType] || cooldowns['default'];
}

/**
 * 生成符合台湾时区的随机时间
 */
export function randomTaiwanTime(): number {
  const now = new Date();
  // 台湾时区 UTC+8
  const taiwanHour = now.getUTCHours() + 8;
  // 只在 8:00-23:00 之间活跃（模拟正常人作息）
  return randomInt(8, 23);
}

/**
 * 判断当前是否在台湾正常活跃时段
 */
export function isActiveHours(): boolean {
  const now = new Date();
  const taiwanHour = (now.getUTCHours() + 8) % 24;
  return taiwanHour >= 7 && taiwanHour <= 23;
}

/**
 * 人类打字模拟（PRD 2.4 打字速度模拟）
 * 逐字输入，带随机间隔 + 思考停顿 + 偶发改口（删除重写），
 * 让对方看到 "正在输入..."，降低被检测为自动化的风险。
 */
export async function humanType(page: Page, textBox: any, text: string): Promise<void> {
  if (!textBox) throw new Error('humanType: textBox 为空');
  await textBox.click().catch(() => {});
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    await page.keyboard.type(ch);
    await new Promise(r => setTimeout(r, humanTypingDelay()));

    // 每 5-15 字模拟一次思考停顿
    if (i > 0 && i % (5 + Math.floor(Math.random() * 10)) === 0) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
    }

    // 偶发改口：删除 2-3 字再重打（模拟边想边改）
    if (i > 3 && Math.random() < 0.06) {
      const back = 2 + Math.floor(Math.random() * 2);
      for (let b = 0; b < back && i - b >= 0; b++) await page.keyboard.press('Backspace');
      const reType = chars.slice(Math.max(0, i - back + 1), i + 1);
      for (const rc of reType) {
        await page.keyboard.type(rc);
        await new Promise(r => setTimeout(r, humanTypingDelay()));
      }
    }
  }
}
