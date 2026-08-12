/**
 * 编译 Electron 主进程与预加载脚本为 CommonJS（.cjs）。
 * main.ts 用 require 风格，preload.ts 用 ESM import；两者都转成 cjs 供 Electron 加载。
 * 依赖保持 external（electron / node 内建），不打包。
 */
import { build } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function compile(entry, outfile) {
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(root, outfile),
    bundle: false,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    packages: 'external',
    logLevel: 'info',
  });
  console.log(`[build-electron] ${outfile} produced`);
}

await compile('electron/main.ts', 'electron/main.cjs');
await compile('electron/preload.ts', 'electron/preload.cjs');
console.log('[build-electron] done');
