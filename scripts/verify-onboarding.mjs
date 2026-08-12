/**
 * 打包並執行 verify-onboarding-entry.ts（esbuild bundle + 動態載入）。
 * 在載入任何 src 之前設定 Mock FB 環境變數。
 */
import * as esbuild from 'esbuild';
import * as path from 'path';
import * as fs from 'fs';

// 必須在任何 src 模組載入前設定
process.env.MOCK_FB = '1';
process.env.MOCK_FB_PORT = '18995';
process.env.HEADLESS = '1';
process.env.FB_BASE = 'http://127.0.0.1:18995';

const ROOT = 'G:/Aike-FBclaw';
const entry = path.join(ROOT, 'scripts', 'verify-onboarding-entry.ts');
const out = path.join(ROOT, 'scripts', '.verify-onboarding.bundle.mjs');

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: out,
  external: ['better-sqlite3', 'playwright-core'],
  logLevel: 'warning',
});

const mod = await import('file://' + out + '?t=' + Date.now());
await mod.run();

// 清理打包產物
try { fs.unlinkSync(out); } catch {}
