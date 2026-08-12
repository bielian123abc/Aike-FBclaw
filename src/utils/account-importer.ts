/**
 * 账号导入工具
 * 支持从 Excel/CSV/JSON 批量导入 Facebook 账号
 */

import * as XLSX from 'xlsx';
import * as fs from 'fs';
import { AccountConfig } from '../core/agent/account-agent';

export interface ImportResult {
  success: AccountConfig[];
  failed: { row: number; reason: string }[];
  total: number;
}

/**
 * 从 Excel 文件导入账号
 */
export function importFromExcel(filePath: string, groupName?: string): ImportResult {
  const result: ImportResult = { success: [], failed: [], total: 0 };

  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<any>(sheet);

    result.total = rows.length;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const config = parseAccountRow(row, i + 1, groupName);
        result.success.push(config);
      } catch (error: any) {
        result.failed.push({ row: i + 1, reason: error.message });
      }
    }
  } catch (error: any) {
    result.failed.push({ row: 0, reason: `文件读取失败: ${error.message}` });
  }

  return result;
}

/**
 * 从 CSV 文件导入账号
 */
export function importFromCSV(filePath: string, groupName?: string): ImportResult {
  const result: ImportResult = { success: [], failed: [], total: 0 };

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const rows = XLSX.utils.sheet_to_json<any>(
      XLSX.read(content, { type: 'string' }).Sheets.Sheet1
    );

    result.total = rows.length;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const config = parseAccountRow(row, i + 1, groupName);
        result.success.push(config);
      } catch (error: any) {
        result.failed.push({ row: i + 1, reason: error.message });
      }
    }
  } catch (error: any) {
    result.failed.push({ row: 0, reason: `文件读取失败: ${error.message}` });
  }

  return result;
}

/**
 * 从 JSON 文件导入账号
 */
export function importFromJSON(filePath: string, groupName?: string): ImportResult {
  const result: ImportResult = { success: [], failed: [], total: 0 };

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);
    const accounts = Array.isArray(data) ? data : data.accounts || [];

    result.total = accounts.length;

    for (let i = 0; i < accounts.length; i++) {
      const row = accounts[i];
      try {
        const config = parseAccountRow(row, i + 1, groupName);
        result.success.push(config);
      } catch (error: any) {
        result.failed.push({ row: i + 1, reason: error.message });
      }
    }
  } catch (error: any) {
    result.failed.push({ row: 0, reason: `文件读取失败: ${error.message}` });
  }

  return result;
}

/**
 * 解析单行账号数据
 * 
 * 支持的列名（中英文兼容）：
 * - 账号/Account/Email/username
 * - 密码/Password/password
 * - 名称/Name/name
 * - 代理IP/Proxy IP/proxyIp
 * - 国家/Country/country
 * - 标签/Tags/tags
 * - 备注/Remark/remark
 */
function parseAccountRow(row: any, rowNum: number, groupName?: string): AccountConfig {
  // 灵活匹配列名
  const email = row['账号'] || row['Account'] || row['Email'] || row['email'] || row['username'] || row['用户名'];
  const password = row['密码'] || row['Password'] || row['password'] || row['密碼'];
  const name = row['名称'] || row['Name'] || row['name'] || row['名稱'] || email || `Account_${rowNum}`;
  const proxyIp = row['代理IP'] || row['Proxy IP'] || row['proxyIp'] || row['proxy'] || row['IP'];
  const country = row['国家'] || row['Country'] || row['country'] || row['國家'] || row['地區'] || 'TW';
  const tags = row['标签'] || row['Tags'] || row['tags'] || row['標籤'] || '';
  const remark = row['备注'] || row['Remark'] || row['remark'] || row['備註'] || '';

  if (!email) {
    throw new Error('缺少账号/邮箱');
  }

  const accountId = `acc_${sanitizeId(email)}`;

  return {
    accountId,
    name: String(name),
    adsPowerProfileId: accountId, // 默认与 accountId 相同，可在 AdsPower 中手动绑定
    username: String(email),
    password: password ? String(password) : undefined,
    proxyIp: proxyIp ? String(proxyIp) : undefined,
    proxyCountry: country ? String(country) : 'TW',
    tags: parseTags(tags),
    group: groupName,
  };
}

/**
 * 解析标签
 */
function parseTags(tags: string | string[]): string[] {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') {
    return tags.split(/[,，、]/).map(t => t.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 清理 ID 中的特殊字符
 */
function sanitizeId(str: string): string {
  return str.replace(/[^a-zA-Z0-9_\-@.]/g, '_').substring(0, 64);
}

/**
 * 导出账号导入模板（Excel）
 */
export function generateTemplate(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([
    {
      '账号': 'example@email.com',
      '密码': 'your_password',
      '名称': '账号显示名称',
      '代理IP': '192.168.1.1',
      '国家': 'TW',
      '标签': '主号,营销',
      '备注': '备注信息',
    },
  ]);

  // 设置列宽
  ws['!cols'] = [
    { wch: 25 }, // 账号
    { wch: 20 }, // 密码
    { wch: 20 }, // 名称
    { wch: 18 }, // 代理IP
    { wch: 8 },  // 国家
    { wch: 20 }, // 标签
    { wch: 30 }, // 备注
  ];

  XLSX.utils.book_append_sheet(wb, ws, '账号列表');
  
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/**
 * 自动检测文件类型并导入
 */
export function autoImport(filePath: string, groupName?: string): ImportResult {
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  switch (ext) {
    case 'xlsx':
    case 'xls':
      return importFromExcel(filePath, groupName);
    case 'csv':
      return importFromCSV(filePath, groupName);
    case 'json':
      return importFromJSON(filePath, groupName);
    default:
      return {
        success: [],
        failed: [{ row: 0, reason: `不支持的文件格式: .${ext}` }],
        total: 0,
      };
  }
}
