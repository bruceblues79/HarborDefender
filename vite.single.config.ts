/**
 * 单文件预览构建：把 public/ 资源与场景 JSON 全部内联，
 * 产出一个可以本地打开的 html。正式构建仍走 vite.config.ts。
 */

import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const ROOT = process.cwd();
const PUBLIC_DIR = join(ROOT, 'public');
const buildVersion = JSON.parse(readFileSync('./package.json', 'utf8')).version as string;

const textDataUrl = (mime: string, text: string): string =>
  `data:${mime};base64,${Buffer.from(text, 'utf8').toString('base64')}`;

const svgDataUrl = (text: string): string => textDataUrl('image/svg+xml', text);

const listFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(abs) : [abs];
  });

/**
 * public/ 的文本资源在构建期变成 data URL。uikitml 里的图标 src 是按页面
 * baseURI 解析的相对路径，单文件里页面就是 html 自己，必须一并换成 data URL。
 */
function collectInlineAssets(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const abs of listFiles(join(PUBLIC_DIR, 'ui'))) {
    const rel = relative(PUBLIC_DIR, abs).replace(/\\/gu, '/');
    const ext = extname(abs).slice(1).toLowerCase();
    if (ext === 'uikitml') {
      const rewritten = readFileSync(abs, 'utf8').replace(
        /src="(ui\/icons\/[^"?]+)(?:\?[^"]*)?"/gu,
        (full, ref: string) => {
          const iconAbs = join(PUBLIC_DIR, ref);
          if (!existsSync(iconAbs)) return full;
          return `src="${svgDataUrl(readFileSync(iconAbs, 'utf8'))}"`;
        },
      );
      map[rel] = textDataUrl('text/plain', rewritten);
    } else if (ext === 'svg') {
      map[rel] = svgDataUrl(readFileSync(abs, 'utf8'));
    } else {
      map[rel] = textDataUrl('text/plain', readFileSync(abs, 'utf8'));
    }
  }
  return map;
}

/**
 * file:// 下模块脚本会被部分浏览器/WebView 直接拦掉，单文件改用经典脚本。
 * IIFE 里没有 import.meta，Worker URL 那处（physics，本项目从不创建）用
 * document.baseURI 兜底。
 */
function classicScript(): Plugin {
  return {
    name: 'preview-classic-script',
    enforce: 'post',
    renderChunk(code) {
      return { code: code.replace(/import\.meta\.url/gu, 'document.baseURI'), map: null };
    },
  };
}

/**
 * 引擎按 URL 后缀校验关卡文档，data URL 会被拒绝。保留 .iwsdk.scene.json
 * 路径，由 pack-single 注入的 fetch 拦截返回内联 JSON。
 */
const SCENE_URL = './__preview__/level.iwsdk.scene.json';

function inlineScene(): Plugin {
  return {
    name: 'preview-inline-scene',
    transform(code, id) {
      if (!id.endsWith('virtual:iwsdk-project')) return null;
      const next = code.replace(
        /const level = import\.meta\.env\.BASE_URL \+ normalized\.level\.replace\([^\n]*\);/u,
        `const level = ${JSON.stringify(SCENE_URL)};`,
      );
      if (next === code) this.error('preview-inline-scene: level assignment not found');
      return next;
    },
  };
}

/**
 * uikit 用 Blob Worker 把 TTF 转成 MSDF，file:// 下 Worker 会被拒绝。
 * 单文件里改成在页面内求值 worker 源码，直接调用生成器。
 */
function inlineMSDF(): Plugin {
  return {
    name: 'preview-inline-msdf',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/gu, '/').includes('@pmndrs/uikit/dist/loaders/ttf.js')) return null;
      const next = code.replace(
        /const workerUrl = URL\.createObjectURL\(new Blob\(\[workerSource\], \{ type: 'text\/javascript' \}\)\);\s*const generator = new MSDF\(\{ workerUrl, wasmUrl \}\);/u,
        `const { createInlineMSDF } = await import('preview-inline-msdf');
        const generator = createInlineMSDF(workerSource, wasmUrl);`,
      );
      if (next === code) this.error('preview-inline-msdf: generator construction not found');
      return next;
    },
  };
}

const inlineAssets = collectInlineAssets();

export default defineConfig({
  base: './',
  publicDir: false,
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion),
    __PREVIEW_ASSETS__: JSON.stringify(inlineAssets),
  },
  plugins: [iwsdkDev(), inlineScene(), inlineMSDF(), classicScript()],
  resolve: {
    alias: { 'preview-inline-msdf': join(ROOT, 'src/preview-inline-msdf.ts') },
    dedupe: ['three', '@pmndrs/uikit', '@pmndrs/uikit-horizon', '@pmndrs/uikit-lucide'],
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    include: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
      '@drawcall/uikitml',
    ],
    esbuildOptions: { target: 'esnext' },
  },
  build: {
    outDir: '.trae-html-share-packages/.build',
    emptyOutDir: true,
    sourcemap: false,
    target: 'esnext',
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
    rollupOptions: {
      input: './index.html',
      output: { format: 'iife', inlineDynamicImports: true },
    },
  },
  esbuild: { target: 'esnext' },
});
