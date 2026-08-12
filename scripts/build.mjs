/**
 * 生产构建脚本（打包用）
 *
 * 背景：原 tsconfig 用 module:ESNext + moduleResolution:bundler，
 * tsc 产出 dist/src/server.js 且 relative import 无 .js 扩展名，
 * 既与 supervisor 期望的 dist/server.js 路径不符，又无法被 node 直接执行（ESM 扩展名要求）。
 *
 * 本脚本用 esbuild 把服务端打包成单文件 ESM（node_modules 依赖保持 external），
 * 输出到 dist/server.js 与 dist/supervisor.js，使其可被 plain node 直接运行，
 * 启动无需 tsx 编译，解决监督器「启动慢被探活误杀」的根因。
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');

// 清理旧的 tsc 产物（dist/src、dist/electron、dist/ui），避免与打包产物混淆
for (const sub of ['src', 'electron', 'ui']) {
  const p = path.join(distDir, sub);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

await build({
  entryPoints: [
    path.join(root, 'src', 'server.ts'),
    path.join(root, 'src', 'supervisor.ts'),
  ],
  outdir: distDir,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});

console.log('[build] dist/server.js + dist/supervisor.js produced');
