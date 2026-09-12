/**
 * setup-vendor.mjs — 从 node_modules 复制 VAD/onnxruntime 静态资源到 public/vendor/
 * npm install 后自动执行（package.json postinstall），无需手动下载任何 CDN 文件。
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vadDst = join(root, 'public', 'vendor', 'vad');
const ortDst = join(root, 'public', 'vendor', 'ort');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Windows 下目标文件可能被正在运行的服务或杀毒扫描短暂锁定（errno 32），重试几次
async function copyWithRetry(src, dst, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      cpSync(src, dst);
      return;
    } catch (err) {
      if (i >= tries) throw err;
      console.warn(`[setup-vendor] ${dst} 被占用，${i}/${tries} 次重试后继续…`);
      await sleep(500 * i);
    }
  }
}

function findFile(base, candidates) {
  for (const c of candidates) {
    const p = join(base, c);
    if (existsSync(p)) return p;
  }
  return null;
}

let ok = true;

// ---------- VAD 资源（@ricky0123/vad-web） ----------
const vadSrc = join(root, 'node_modules', '@ricky0123', 'vad-web', 'dist');
if (existsSync(vadSrc)) {
  mkdirSync(vadDst, { recursive: true });
  const items = [
    ['bundle.min.js', 'vad.bundle.min.js'],
    ['vad.worklet.bundle.min.js', 'vad.worklet.bundle.min.js'],
  ];
  for (const [srcName, dstName] of items) {
    const s = join(vadSrc, srcName);
    if (existsSync(s)) await copyWithRetry(s, join(vadDst, dstName));
  }
  // silero onnx 模型（不同版本可能在 dist 根或 dist/models 下）
  for (const name of ['silero_vad_v5.onnx', 'silero_vad_legacy.onnx']) {
    const s = findFile(vadSrc, [name, join('models', name)]);
    if (s) await copyWithRetry(s, join(vadDst, name));
    else ok = false;
  }
} else {
  ok = false;
}

// ---------- onnxruntime-web 资源 ----------
const ortSrc = join(root, 'node_modules', 'onnxruntime-web', 'dist');
if (existsSync(ortSrc)) {
  mkdirSync(ortDst, { recursive: true });
  await copyWithRetry(join(ortSrc, 'ort.min.js'), join(ortDst, 'ort.min.js'));
  for (const f of readdirSync(ortSrc)) {
    if (f.startsWith('ort-wasm-simd-threaded')) await copyWithRetry(join(ortSrc, f), join(ortDst, f));
  }
} else {
  ok = false;
}

if (!ok) {
  console.error('[setup-vendor] 部分资源未找到，请确认 @ricky0123/vad-web 与 onnxruntime-web 已安装。');
  process.exit(1);
}
console.log('[setup-vendor] 已生成 public/vendor/（VAD 模型 + onnxruntime WASM）');
