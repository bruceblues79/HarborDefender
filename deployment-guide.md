# HarborDefender 部署指南

> 面向：新会话 / TRAE agent，读完即可独立执行部署
> 技术栈：IWSDK + EliCS + PWA + WebXR
> 部署模式：子路径部署到主站 svalbardpost.xyz
> 参考邻居项目：`BruceWWorld/game-deployment-guide.md`、`DefenceTroy/defencetroy-deploy-instructions.md`

---

## 一、部署架构

```
┌──────────────────────────────────────────────────────────────┐
│  腾讯云 root@111.229.101.32  (Ubuntu 24.04 + nginx 1.24.0)  │
│                                                              │
│  /var/www/html/                  ← 主站 BruceWWorld 根       │
│      ├── index.html                                          │
│      ├── assets/                                             │
│      └── games/                                              │
│           ├── defend-troy/      ← DefenceTroy 子路径         │
│           └── harbor-defender/  ← 本工程子路径               │
│                ├── index.html                                │
│                ├── assets/                                   │
│                ├── manifest.webmanifest                      │
│                └── sw.js (Service Worker)                   │
│                                                              │
│  nginx 80  → 301 → 443 (Let's Encrypt 自动续期)             │
└──────────────────────────────────────────────────────────────┘
                    ↑
                    │ HTTPS（WebXR 强制要求，已满足）
                    │
        https://svalbardpost.xyz/games/harbor-defender/
        ↑                          ↑
        │                          │
   浏览器 3D 模式            WebXR 沉浸式模式（PICO/Quest）
   （同一份 dist）           （同一份 dist）
```

**关键认知**：游戏 URL 独立可访问，主站只是导航入口。即使主站不下发跳转卡片，玩家可直接访问子路径 URL 玩游戏。

---

## 二、部署目标事实

| 项 | 值 |
|---|---|
| 服务器 | `root@111.229.101.32`（VM-0-12-ubuntu） |
| Web 根目录 | `/var/www/html` |
| 游戏子路径 | `/games/harbor-defender/` |
| 访问 URL | `https://svalbardpost.xyz/games/harbor-defender/` |
| 静态服务 | nginx（主站已配置，子路径无需新增 server 块） |
| HTTPS | Let's Encrypt + nginx，子路径自动继承证书 |
| 备案 | 京ICP备2026056959号-1（子路径自动覆盖，零操作） |
| 部署脚本 | `scripts/deploy.mjs`（tar 上传 → 校验 → 切换 → 外网验证） |
| 版本管理 | git（不做服务器端备份，回滚靠 `git checkout` + 重部署） |

---

## 三、项目内配置三件套

部署前必须就位的三个文件。

### 3.1 `vite.config.ts` — base 路径

```ts
import { defineConfig } from 'vite'
// IWSDK 项目按实际插件导入，此处只示意 base 配置

// 部署到主站子路径 https://svalbardpost.xyz/games/harbor-defender/
// base 必须与子路径一致，否则打包后资源路径从根目录找，404
export default defineConfig({
  base: '/games/harbor-defender/',
  // 其他 IWSDK / elics / three 相关插件按需补
})
```

**验证 `base` 生效**：`npm run build` 后 `dist/index.html` 内所有 asset 路径必须以 `/games/harbor-defender/` 开头，不能是 `/assets/...`。

### 3.2 `scripts/deploy.mjs` — 部署脚本

直接复用 DefenceTroy 的模板，只改 3 个常量 + title marker。**STAGE 用 `/tmp/hd-stage`，避免与主站 `/tmp/bww-stage`、DefenceTroy `/tmp/dt-stage` 冲突**。

```js
#!/usr/bin/env node
/**
 * 一键部署：把 HarborDefender 的 dist/ 发布到主站子路径
 * （root@111.229.101.32 /var/www/html/games/harbor-defender）
 *
 * 流程：打包上传暂存区 → 远端校验 index.html → 清旧并切换
 *       → 归一属主/权限 → 清理 → 外网校验
 * 用法：npm run deploy（等价于 npm run build + node scripts/deploy.mjs）
 * 回滚：git checkout 上一版 + npm run deploy（版本由 git 管理，不做服务器端备份）
 *
 * 与主站 deploy.mjs 的差异：
 *   - REMOTE_ROOT 指向子目录 /var/www/html/games/harbor-defender
 *   - 删除主站特有的备案号校验（子路径备案自动覆盖）
 *   - 删除主站特有资产校验（toybox.glb / starter_space.hdr）
 *   - STAGE 改为 /tmp/hd-stage，避免与主站 /tmp/bww-stage 冲突
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const HOST = 'root@111.229.101.32'
const REMOTE_ROOT = '/var/www/html/games/harbor-defender'
const STAGE = '/tmp/hd-stage'
const SITE = 'https://svalbardpost.xyz/games/harbor-defender/'

// 远端脚本统一经 stdin 传给 bash -s，避免本地 shell 引号转义差异
const runRemote = (script) =>
  execSync(`ssh -o BatchMode=yes ${HOST} bash -s`, {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
  })

if (!existsSync('dist/index.html')) {
  console.error('未找到 dist/index.html —— 请先执行 npm run build')
  process.exit(1)
}

console.log('[1/4] 打包 dist 并上传到服务器暂存区 ...')
execSync(
  `tar -czf - -C dist . | ssh -o BatchMode=yes ${HOST} "rm -rf ${STAGE} && mkdir -p ${STAGE} && tar -xzf - -C ${STAGE}"`,
  { stdio: 'inherit' },
)

console.log('[2/4] 远端校验 + 切换 ...')
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
`)

console.log('[3/4] 清理暂存区 ...')
runRemote(`rm -rf ${STAGE}`)

console.log('[4/4] 外网校验 ...')
const res = await fetch(SITE)
if (!res.ok) throw new Error(`${SITE} 返回 HTTP ${res.status}`)
const html = await res.text()
if (!html.includes('<title>')) throw new Error('线上页面缺少 <title>')
console.log(`  ${SITE} → HTTP ${res.status}，页面结构齐全`)
console.log('部署完成')
```

### 3.3 `package.json` — `deploy` script

在 `scripts` 节点加 `deploy` 字段：

```json
"scripts": {
  "dev": "vite",
  "build": "tsc && vite build",
  "preview": "vite preview",
  "deploy": "npm run build && node scripts/deploy.mjs"
}
```

> `build` 命令按实际 TypeScript / IWSDK 工具链调整（如 `tsc -b` 或 `tsc && vite build`）。

---

## 四、PWA + WebXR 特有配置（区别于 DefenceTroy）

DefenceTroy 不是 PWA，没遇到路径问题。HarborDefender 走 PWA + WebXR，**manifest 与 Service Worker 的路径必须带子路径**，否则"装到桌面后启动会丢失子路径 → 404"。

### 4.1 `manifest.webmanifest`（或 `manifest.json`）

```json
{
  "name": "HarborDefender",
  "short_name": "HarborDefender",
  "start_url": "/games/harbor-defender/?source=pwa",
  "scope": "/games/harbor-defender/",
  "display": "fullscreen",
  "icons": [
    { "src": "/games/harbor-defender/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/games/harbor-defender/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**关键**：`start_url` 和 `scope` 都必须包含 `/games/harbor-defender/` 子路径。

### 4.2 Service Worker 注册

```ts
// src/main.ts 或入口文件
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/games/harbor-defender/sw.js', {
        scope: '/games/harbor-defender/',
      })
      .then((reg) => console.log('SW registered:', reg.scope))
      .catch((err) => console.error('SW failed:', err))
  })
}
```

**注意**：SW 的 `scope` 不能高于注册 URL 的路径，所以必须用子路径注册，不能用根 `/`。

### 4.3 使用 `vite-plugin-pwa`（推荐）

如果用 `vite-plugin-pwa`，它会自动读 Vite 的 `base` 配置，无需手动写 `start_url`/`scope`。只需在 `vite.config.ts` 里：

```ts
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/games/harbor-defender/',
  plugins: [
    // IWSDK / elics 等其他插件
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'HarborDefender',
        short_name: 'HarborDefender',
        display: 'fullscreen',
        // start_url / scope 由 base 自动推导，无需显式写
      },
    }),
  ],
})
```

### 4.4 WebXR 沉浸式会话触发

WebXR 规范要求**必须由用户手势触发**（`XRSession.requestSession()` 必须在 click/touch 等用户事件回调里调用），不能自动进入。PWA 的全屏显示模式与 WebXR 会话是**独立层级**，互不替代。

> 浏览器 3D 模式（flat）与 XR 沉浸式模式跑同一份 dist，由 IWSDK 在运行时根据 `navigator.xr` 是否可用自动降级/升级。部署侧无需为两种模式分别打包。

---

## 五、部署前置条件

### 5.1 SSH 免密通道可用

```powershell
ssh -o BatchMode=yes -o ConnectTimeout=15 -4 root@111.229.101.32 'echo ok'
```

必须输出 `ok`。失败说明本机公钥（`~/.ssh/id_ed25519.pub`，注释 `bruce-windows`）不在服务器 `/root/.ssh/authorized_keys`，需用腾讯云控制台 OrcaTerm 以 root 登录后追加。

### 5.2 `~/.ssh/config` 强制 IPv4

Windows 本机 IPv6 不通到 `111.229.101.32`，必须强制 IPv4。给 `~/.ssh/config` 加：

```sshconfig
Host 111.229.101.32
    AddressFamily inet
```

`deploy.mjs` 内的 ssh/scp 由 node 子进程发起也受此规则约束。Trae Work 远程 Linux 环境无此问题，IPv4 直连即可。

### 5.3 HarborDefender 工程依赖就位

```powershell
npm install
```

---

## 六、部署流程

### 6.1 一键部署

```powershell
npm run deploy
```

等价于 `npm run build` + `node scripts/deploy.mjs`。

### 6.2 脚本内部做了什么

1. `tar -czf - -C dist .` 打包本地 `dist/`
2. `ssh` 上传到服务器暂存区 `/tmp/hd-stage`
3. 远端校验 `index.html` 存在
4. `mkdir -p /var/www/html/games/harbor-defender`（首次部署自动创建子目录）
5. `rm -rf ${REMOTE_ROOT}/*` 清旧产物
6. `cp -a ${STAGE}/. ${REMOTE_ROOT}/` 切换
7. `chown -R root:root` + `chmod -R a+rX`（目录 755 / 文件 644）
8. 清暂存区 `/tmp/hd-stage`
9. `fetch https://svalbardpost.xyz/games/harbor-defender/` 外网校验，返回 200 且含 `<title>`

### 6.3 重要执行约束

> ⚠️ **部署脚本必须非沙箱前台执行**：沙箱化的命令读不到 `C:\Users\bruce\.ssh`（报 `Host key verification failed` / `hostkeys_foreach failed ... Permission denied`）。`npm run deploy` 与所有 ssh/scp 操作**放前台并关闭沙箱**，不要丢后台。

---

## 七、部署后校验

```powershell
# HTTP 状态（PowerShell 必须用 curl.exe，避免 Invoke-WebRequest 别名歧义）
curl.exe -sI --noproxy '*' --max-time 20 https://svalbardpost.xyz/games/harbor-defender/ | Select-Object -First 1
# 期望：HTTP/2 200

# 页面结构
curl.exe -s --noproxy '*' --max-time 20 https://svalbardpost.xyz/games/harbor-defender/ | Select-String '<title>'

# 资源 200 检查（无 404）
curl.exe -sI --noproxy '*' --max-time 20 https://svalbardpost.xyz/games/harbor-defender/assets/index-*.js | Select-Object -First 1

# manifest 与 SW 路径
curl.exe -sI --noproxy '*' --max-time 20 https://svalbardpost.xyz/games/harbor-defender/manifest.webmanifest | Select-Object -First 1
curl.exe -sI --noproxy '*' --max-time 20 https://svalbardpost.xyz/games/harbor-defender/sw.js | Select-Object -First 1
```

浏览器打开 `https://svalbardpost.xyz/games/harbor-defender/` 应看到 HarborDefender 页面。在支持 WebXR 的设备（PICO 4 Ultra / Quest 3 浏览器）上，应能通过用户手势（如点击"进入 VR"按钮）触发沉浸式会话。

---

## 八、主站侧跳转入口（跨项目工作，不在本工程范围）

让主站出现"HarborDefender"卡片入口，需在 **BruceWWorld** 工程改一处 + 主站自身部署：

### 8.1 改 `BruceWWorld/src/components/screens/LiteGameScreen.tsx`

在 `GAMES` 数组加一条：

```ts
{
  id: 'harbor_defender',
  name: 'HarborDefender',
  image: '/assets/textures/game_harbor_defender.png',
  url: 'https://svalbardpost.xyz/games/harbor-defender/',
}
```

点选 → 确定 → `window.open(url, '_blank')` 新标签页打开。

### 8.2 主站自身部署

```powershell
# 在 BruceWWorld 工程目录
npm run deploy
```

### 8.3 推荐顺序（避免用户点入口遇到 404）

1. **先**：HarborDefender 工程内 `npm run deploy`（游戏上线）
2. **后**：BruceWWorld 改 `LiteGameScreen.tsx` + 主站 `npm run deploy`（主站出现入口）

游戏先上、主站再加入口。否则主站入口先上线但游戏还没部署，用户点进去会 404。

---

## 九、回滚

版本由 git 管理，不做服务器端备份。

```powershell
git checkout <上一版 commit>
npm run deploy
```

---

## 十、常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| `Host key verification failed` / `hostkeys_foreach failed ... Permission denied` | 沙箱读不到 `~/.ssh` | 部署命令前台执行并关闭沙箱 |
| `Connection timed out` 到 `111.229.101.32` | Windows 本机 IPv6 不通 | `~/.ssh/config` 加 `AddressFamily inet` |
| 部署后访问页面 404 | `vite.config.ts` 没设 `base` 或值不一致 | `base: '/games/harbor-defender/'`，重 build |
| 资源 404（JS/CSS/GLB/HDR） | base 未生效，打包路径从根目录找 | 同上 |
| PWA 装到桌面后启动 404 | `manifest` 的 `start_url`/`scope` 没带子路径 | 改为 `/games/harbor-defender/?source=pwa` + `scope: '/games/harbor-defender/'` |
| Service Worker 注册失败 scope 不匹配 | SW 注册 URL 高于 scope | 用 `/games/harbor-defender/sw.js` 注册，scope 同路径 |
| WebXR 不能进入沉浸式 | 非 HTTPS / 非用户手势触发 / 设备不支持 | 确认 origin 是 HTTPS、在 click 回调里调用 `requestSession`、`navigator.xr.isSessionSupported('immersive-vr')` 预检 |
| `curl -m` / `curl -s` 报 `AmbiguousParameter` | PowerShell `curl` 别名到 `Invoke-WebRequest` | 改用 `curl.exe` 显式调用真 curl |

---

## 十一、不做的事

- 不做 iframe 嵌入（新标签页打开，独立 origin 上下文，对 WebXR 更友好）
- 不做子域名方案（子路径已满足，无额外备案/证书/Nginx 工作量）
- 不做用户身份 / 进度传递（独立游戏，无主站状态同步）
- 不做服务器端备份（git 管版本，回滚靠 `git checkout` + 重部署）
- 不做 GitHub Actions CI（手动 `npm run deploy` 即可）

---

## 十二、验证清单（首次部署前自查）

- [ ] `vite.config.ts` 设了 `base: '/games/harbor-defender/'`
- [ ] `npm run build` 后 `dist/index.html` 内 asset 路径以 `/games/harbor-defender/` 开头
- [ ] `scripts/deploy.mjs` 已创建，`REMOTE_ROOT`/`STAGE`/`SITE` 三个常量正确
- [ ] `package.json` 加了 `deploy` script
- [ ] `manifest.webmanifest` 的 `start_url`/`scope` 带子路径（或用 `vite-plugin-pwa` 自动推导）
- [ ] Service Worker 注册路径带子路径
- [ ] `ssh -4 -o BatchMode=yes root@111.229.101.32 'echo ok'` 输出 `ok`
- [ ] `~/.ssh/config` 给 `111.229.101.32` 加了 `AddressFamily inet`
- [ ] `curl.exe -sI https://svalbardpost.xyz/games/harbor-defender/` 返回 200
- [ ] 子游戏页面所有资源（JS/CSS/GLB/manifest/sw.js）200，无 404
- [ ] 在 PICO/Quest 浏览器打开能看到沉浸式入口
