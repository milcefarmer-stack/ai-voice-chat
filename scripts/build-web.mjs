/**
 * 前端构建:esbuild 打包 TS → dist/app.js,并复制静态文件到 dist/。
 * 产物由 Python 服务(FastAPI)托管在根路径。
 */
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'frontend', 'dist');

mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'frontend', 'src', 'app.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: path.join(dist, 'app.js'),
  minify: false,
  sourcemap: true,
  logLevel: 'info',
});

copyFileSync(path.join(root, 'frontend', 'index.html'), path.join(dist, 'index.html'));
copyFileSync(path.join(root, 'frontend', 'style.css'), path.join(dist, 'style.css'));
console.log('✅ 前端构建完成 → frontend/dist/');
