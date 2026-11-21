#!/usr/bin/env node
/**
 * 把当前工作区打成单个自包含 HTML，写到已忽略的 .trae-html-share-packages/。
 * 用法：npm run pack:html
 * 产物：harbor-defender-<UTC>.html 与 latest.html，不发飞书、不部署。
 */
import { build } from 'vite';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(root, '.trae-html-share-packages');
const buildDir = path.join(outRoot, '.build');

await mkdir(outRoot, { recursive: true });
await build({
  root,
  configFile: path.join(root, 'vite.single.config.ts'),
  logLevel: 'warn',
});

let html = await readFile(path.join(buildDir, 'index.html'), 'utf8');

const scriptTag = /<script[^>]*\ssrc="\.\/([^"]+)"[^>]*>\s*<\/script>/u;
const scriptMatch = html.match(scriptTag);
if (!scriptMatch) throw new Error('pack:html — 未找到打包后的 module script');

const bundle = (await readFile(path.join(buildDir, scriptMatch[1]), 'utf8')).replace(
  /<\/script>/gu,
  '<\\/script>',
);

// 经典脚本：file:// 下部分浏览器会拦截 type="module"。
const reporter = `<script>
(function () {
  var show = function (text) {
    document.body.innerHTML = '<pre style="margin:0;padding:12px;background:#f5f5f5;color:#b00;font:12px/1.5 monospace;white-space:pre-wrap">' + String(text) + '</pre>';
  };
  window.addEventListener('error', function (e) { show((e.error && e.error.stack) || e.message || 'script error'); });
  window.addEventListener('unhandledrejection', function (e) { show((e.reason && (e.reason.stack || e.reason)) || 'unhandled rejection'); });
})();
</script>`;
// 经典脚本不再延迟执行，必须放在 body 末尾，否则引擎挂载时 document.body 还是 null。
const bundleTag = `${reporter}\n<script>\n${bundle}\n</script>`;
html = html.replace(scriptTag, '');
if (html.includes('</body>')) {
  html = html.replace('</body>', () => `${bundleTag}\n  </body>`);
} else {
  html += bundleTag;
}

const styleTag = /<link[^>]*rel="stylesheet"[^>]*href="\.\/([^"]+)"[^>]*>/u;
for (let match = html.match(styleTag); match; match = html.match(styleTag)) {
  const css = await readFile(path.join(buildDir, match[1]), 'utf8');
  html = html.replace(match[0], () => `<style>\n${css}\n</style>`);
}

const leftover = [...html.matchAll(/(?:src|href)="\.\/[^"]+"/gu)].map((m) => m[0]);
if (leftover.length > 0) {
  throw new Error(`pack:html — 仍有外部引用未内联：${leftover.slice(0, 3).join(', ')}`);
}

const now = new Date();
const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
const file = path.join(outRoot, `harbor-defender-${stamp}.html`);

await writeFile(file, html);
await writeFile(path.join(outRoot, 'latest.html'), html);
await rm(buildDir, { recursive: true, force: true });

const info = await stat(file);
console.log(
  JSON.stringify(
    {
      file,
      latest: path.join(outRoot, 'latest.html'),
      bytes: info.size,
      utc: now.toISOString(),
      version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
    },
    null,
    2,
  ),
);
