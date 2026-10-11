#!/usr/bin/env node
/**
 * HarborDefender deployment script.
 * Publishes dist/ to the main site's sub-path:
 *   root@111.229.101.32 /var/www/html/games/harbor-defender
 *
 * Flow: tar upload → remote verify index.html → switch → fix perms → cleanup → external check
 * Usage: npm run deploy (equivalent to npm run build + node scripts/deploy.mjs)
 * Rollback: git checkout <prev> + npm run deploy
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const HOST = 'root@111.229.101.32';
const REMOTE_ROOT = '/var/www/html/games/harbor-defender';
const STAGE = '/tmp/hd-stage';
const SITE = 'https://svalbardpost.xyz/games/harbor-defender/';

const runRemote = (script) =>
  execSync(`ssh -o BatchMode=yes ${HOST} bash -s`, {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

if (!existsSync('dist/index.html')) {
  console.error('未找到 dist/index.html —— 请先执行 npm run build');
  process.exit(1);
}

console.log('[1/4] 打包 dist 并上传到服务器暂存区 ...');
execSync(
  `tar -czf - -C dist . | ssh -o BatchMode=yes ${HOST} "rm -rf ${STAGE} && mkdir -p ${STAGE} && tar -xzf - -C ${STAGE}"`,
  { stdio: 'inherit' },
);

console.log('[2/4] 远端校验 + 切换 ...');
runRemote(`
set -e
test -f ${STAGE}/index.html
mkdir -p ${REMOTE_ROOT}
find ${STAGE} -type d -exec chmod 755 {} +
find ${STAGE} -type f -exec chmod 644 {} +
rm -rf ${REMOTE_ROOT}/*
cp -a ${STAGE}/. ${REMOTE_ROOT}/
chown -R root:root ${REMOTE_ROOT}
chmod -R a+rX ${REMOTE_ROOT}
echo "  暂存文件数: $(find ${STAGE} -type f | wc -l)"
echo "  已切换 ${REMOTE_ROOT}"
`);

console.log('[3/4] 清理暂存区 ...');
runRemote(`rm -rf ${STAGE}`);

console.log('[4/4] 外网校验 ...');
const res = await fetch(SITE);
if (!res.ok) throw new Error(`${SITE} 返回 HTTP ${res.status}`);
const html = await res.text();
if (!html.includes('<title>')) throw new Error('线上页面缺少 <title>');
console.log(`  ${SITE} → HTTP ${res.status}，页面结构齐全`);
console.log('部署完成');
