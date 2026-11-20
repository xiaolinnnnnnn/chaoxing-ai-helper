/**
 * 打包页内 Agent 为单文件 IIFE。
 *
 * 产物 `dist/agent.js` 会被注入到每个 frame 的 `window.__CXAI`。
 * 直接复用扩展仓库 `../src/content/*` 下的 DOM 层源码 —— 那套逻辑已经在真实
 * 学习通页面验证过（探测 / 侧别判定 / Vue 受控输入 / 发送校验），不重写。
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(root, 'dist/agent.js');

mkdirSync(resolve(root, 'dist'), { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'src/agent.ts')],
  outfile,
  bundle: true,
  format: 'iife',
  // 目标浏览器就是 Playwright 里的 Chromium，可以放开语法
  target: ['chrome110'],
  platform: 'browser',
  minify: false, // 保留可读性，方便在真实页面 DevTools 里调试
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  // 复用主仓库 tsconfig 的 paths（@/* → ../src/*）
  tsconfig: resolve(root, 'tsconfig.json'),
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

if (result.errors.length) {
  console.error('[build:agent] 打包失败');
  process.exit(1);
}
console.log(`[build:agent] ✓ ${outfile}`);
