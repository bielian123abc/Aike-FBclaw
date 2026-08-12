/**
 * 2FA / TOTP 验证码生成器
 * 支持从 AdsPower 格式的 2FA 密钥计算当前验证码
 */
import * as crypto from 'crypto';

export function generateTOTP(secret: string): { code: string; remaining: number } {
  // 清理密钥：去掉空格，全部大写
  const cleanSecret = secret.replace(/\s/g, '').toUpperCase();
  
  // Base32 解码
  let decoded: Buffer;
  try {
    decoded = base32Decode(cleanSecret);
  } catch {
    return { code: 'INVALID', remaining: 0 };
  }

  // 当前时间步长 (30秒一个)
  const now = Math.floor(Date.now() / 1000);
  const step = 30;
  const counter = Math.floor(now / step);
  const remaining = step - (now % step);

  // 生成 HMAC-SHA1
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', decoded).update(counterBuf).digest();

  // 截取
  const offset = hmac[hmac.length - 1] & 0x0F;
  const binCode = ((hmac[offset] & 0x7F) << 24) |
    ((hmac[offset + 1] & 0xFF) << 16) |
    ((hmac[offset + 2] & 0xFF) << 8) |
    (hmac[offset + 3] & 0xFF);

  const code = String(binCode % 1000000).padStart(6, '0');
  return { code, remaining };
}

function base32Decode(str: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  str = str.replace(/=+$/, '');
  
  let bits = '';
  for (const ch of str) {
    const val = alphabet.indexOf(ch);
    if (val === -1) throw new Error('Invalid base32');
    bits += val.toString(2).padStart(5, '0');
  }

  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * 解析 AdsPower 格式的 2FA 密钥
 * 从 order 文件中提取
 */
export function parse2FAFromLine(line: string): { secret: string; } | null {
  const parts = line.split('\t');
  if (parts.length >= 3) {
    const twofa = parts[2]?.trim();
    // 检查是否是合法的 2FA 密钥格式 (32个Base32字符带空格)
    if (twofa && /^[A-Z2-7\s]{30,60}$/.test(twofa)) {
      return { secret: twofa };
    }
  }
  return null;
}
