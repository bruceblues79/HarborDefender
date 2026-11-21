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
// 不破坏页面，只在左下角累积错误与告警，便于远端定位问题。
const logBox =
  '<div id="__preview_log" style="position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:92vw;max-height:45vh;overflow:auto;font:11px/1.45 monospace;color:#fff;background:rgba(0,0,0,.78);padding:6px 8px;border-radius:6px;white-space:pre-wrap;display:none"></div>';

const reporter = `<script>
(function () {
  var lines = [];
  function flush() {
    var box = document.getElementById('__preview_log');
    if (!box) { setTimeout(flush, 100); return; }
    box.style.display = 'block';
    box.textContent = lines.join('\\n');
  }
  function format(value) {
    try { return value && value.stack ? value.stack : String(value); } catch (err) { return '[unprintable]'; }
  }
  function push(kind, text) {
    if (lines.length >= 40) return;
    lines.push(kind + ' ' + text);
    flush();
  }
  var rawError = console.error, rawWarn = console.warn;
  console.error = function () { rawError.apply(console, arguments); push('E', Array.prototype.map.call(arguments, format).join(' ')); };
  console.warn = function () { rawWarn.apply(console, arguments); push('W', Array.prototype.map.call(arguments, format).join(' ')); };
  window.addEventListener('error', function (e) { push('E', format(e.error) + ' ' + (e.message || '')); });
  window.addEventListener('unhandledrejection', function (e) { push('R', format(e.reason)); });
})();
</script>`;
// 引擎按后缀校验关卡 URL，这里用 fetch 拦截伪造的 .iwsdk.scene.json 路径。
const scenePath = JSON.parse(await readFile(path.join(root, 'iwsdk.config.json'), 'utf8')).scene;
const sceneJson = await readFile(path.join(root, scenePath), 'utf8');
const sceneShim = `<script>
window.__PREVIEW_SCENE__ = ${JSON.stringify(sceneJson).replace(/<\//gu, '<\\/')};
(function () {
  var raw = window.fetch;
  window.fetch = function (input, init) {
    var url = String((input && input.url) || input);
    if (url.indexOf('__preview__/level.iwsdk.scene.json') !== -1) {
      return Promise.resolve(new Response(window.__PREVIEW_SCENE__, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }
    return raw.call(window, input, init);
  };
})();
</script>`;

// 经典脚本不再延迟执行，必须放在 body 末尾，否则引擎挂载时 document.body 还是 null。
const bundleTag = `${logBox}\n${sceneShim}\n${reporter}\n<script>\n${bundle}\n</script>`;
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
