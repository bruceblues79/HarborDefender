# HarborDefender IWSDK WebXR 项目搭建计划

## Context

HarborDefender 是一个 WebXR 游戏，需使用 IWSDK（Immersive Web SDK）架构搭建起始页面。项目目录目前仅有一份 `deployment-guide.md`，无任何源代码。本计划将：用 IWSDK CLI 脚手架创建 AR（VST）TypeScript 项目，配置场景中的面板/相机/灯光/环境，实现浏览器拖拽看四周的相机控制，提供 DOM 层 "ENTER XR" 按钮进入沉浸式 AR 会话，并完成子路径 PWA 部署配置。

技术栈：IWSDK + EliCS + Three.js（底层）+ TypeScript + Vite + PWA + WebXR（AR/VST 模式）

---

## 步骤 1：用 @iwsdk/create 脚手架创建项目

在 HarborDefender 目录内执行非交互式脚手架：

```powershell
npm create @iwsdk@latest . -- --yes --force --target ar
```

- `.` = 在当前目录脚手架
- `--yes` = 跳过交互提示，使用默认（TypeScript + 推荐功能 + Git + 安装依赖）
- `--force` = 覆盖冲突的生成文件，保留无关文件（`deployment-guide.md` 不受影响）
- `--target ar` = 创建 Mixed Reality/passthrough（AR）起始模板 → 对应 `immersive-ar` WebXR 会话模式 → VST

生成后的关键文件：
- `iwsdk.config.json` — 项目清单（场景、模块、XR 配置）
- `src/index.ts` — 应用入口
- `src/assets.ts` — 资产目录
- `public/scenes/main.iwsdk.scene.json` — 场景 JSON
- `vite.config.ts` — Vite 配置（含 `iwsdkDev()` 插件）
- `package.json` — 依赖与脚本

---

## 步骤 2：配置项目清单 `iwsdk.config.json`

修改 XR 配置以支持 VST 和 session offer：

```jsonc
{
  // ... 其他字段保持生成默认
  "world": {
    "xr": {
      "mode": "ar",           // immersive-ar → VST
      "offer": "always",      // 始终允许浏览器 offer XR 会话
      "features": {
        "handTracking": true
      }
    },
    "features": {
      "locomotion": false,    // 起始页面不需要移动
      "grabbing": false,      // 起始页面不需要抓取
      "spatialUI": true       // 启用 UIKitML 空间 UI
    },
    "render": {
      "camera": {
        "position": [0, 1.5, 0],
        "lookAt": [0, 1.5, -1.5]
      }
    }
  },
  "dev": {
    "emulator": {
      "device": "metaQuest3"
    }
  }
}
```

**说明**：
- `mode: "ar"` → `SessionMode.ImmersiveAR` → 在 Quest 3 / PICO 上为 VST（视频透视）
- `offer: "always"` → 使用 `navigator.xr.offerSession()`，浏览器原生提示进入 XR
- `spatialUI: true` → 启用 UIKitML 面板系统
- `render.camera` → 浏览器模式的相机初始位置和朝向
- `dev.emulator` → IWER 模拟器设备为 Meta Quest 3

---

## 步骤 3：配置 Vite + PWA `vite.config.ts`

合并 IWSDK 开发插件与部署配置：

```ts
import { defineConfig } from 'vite'
import { iwsdkDev } from '@iwsdk/vite-plugin-dev'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/games/harbor-defender/',  // 子路径部署，必须与部署指南一致
  plugins: [
    iwsdkDev(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'HarborDefender',
        short_name: 'HarborDefender',
        display: 'fullscreen',
        // start_url / scope 由 base 自动推导
      },
    }),
  ],
  server: {
    port: 8081,  // IWSDK starter 默认端口
  },
})
```

---

## 步骤 4：创建 UIKitML 面板 `public/ui/welcome.uikitml`

使用 IWSDK 默认 Horizon 组件集（`Panel`、`Button`），列布局 5 等分：

```html
<style>
  .panel-root {
    width: 100;
    height: 100;
    flex-direction: column;
    background-color: #18181b;
    padding: 4;
  }
  .title-section {
    flex-grow: 4;
    justify-content: center;
    align-items: center;
  }
  .title-text {
    font-size: 10;
    font-weight: 700;
    color: #f4f4f5;
  }
  .button-section {
    flex-grow: 1;
    justify-content: center;
    align-items: center;
  }
</style>

<Panel class="panel-root">
  <div class="title-section">
    <h1 class="title-text">Harbor Defender</h1>
  </div>
  <div class="button-section">
    <button id="enter-game-button">ENTER GAME</button>
  </div>
</Panel>
```

**说明**：
- UIKitML 尺寸单位为厘米，`100` = 1 米（entity scale 为 1 时）
- `flex-grow: 4` 和 `flex-grow: 1` 实现 4:1 竖排比例（5 等分）
- 上方 4/5 显示 "Harbor Defender" 标题
- 下方 1/5 包含 "ENTER GAME" 按钮（预留接口）
- 使用 IWSDK 默认 Horizon `Panel` + `Button` 组件，自带推荐样式

---

## 步骤 5：注册资产 `src/assets.ts`

在资产清单中注册 UIKitML 面板：

```ts
import { AssetType, defineAssets } from '@iwsdk/core'

const publicAssetUrl = (path: string) =>
  `${import.meta.env.BASE_URL}${path.replace(/^\/+/u, '')}`

export default defineAssets({
  'welcome-panel': {
    name: 'Welcome Panel',
    type: AssetType.UIKitML,
    url: publicAssetUrl('ui/welcome.uikitml'),
  },
})
```

---

## 步骤 6：配置场景 `public/scenes/main.iwsdk.scene.json`

修改生成的场景 JSON，配置环境色（中灰）和平行光：

### 6.1 环境色（中灰）

在 level root 上添加 `DomeGradient`（背景）和 `IBLGradient`（环境光），颜色均为中灰：

```jsonc
{
  "root": {
    "components": {
      "DomeGradient": {
        "sky": [0.5, 0.5, 0.5, 1.0],
        "equator": [0.5, 0.5, 0.5, 1.0],
        "ground": [0.5, 0.5, 0.5, 1.0],
        "intensity": 1.0
      },
      "IBLGradient": {
        "sky": [0.5, 0.5, 0.5, 1.0],
        "equator": [0.5, 0.5, 0.5, 1.0],
        "ground": [0.5, 0.5, 0.5, 1.0],
        "intensity": 1.0
      }
    }
  }
}
```

### 6.2 平行光（太阳）

在场景 JSON 中添加 DirectionalLight 节点。方向从 (2,4,-1) 指向 (0,1.5,-1.5)，需计算旋转角度使 entity 局部 -Z 对齐该方向。

方向向量：(-2, -2.5, -0.5)，归一化后约 (-0.617, -0.772, -0.154)

计算 rotationDeg（Three.js XYZ Euler 顺序）：
- pitch (X) ≈ -39.5°
- yaw (Y) ≈ -76.0°

```jsonc
{
  "id": "sun-light",
  "transform": {
    "position": [2, 4, -1],
    "rotationDeg": [-39.5, -76.0, 0]
  },
  "components": {
    "DirectionalLight": {
      "color": [1, 1, 1, 1],
      "intensity": 3.14,
      "castShadow": true
    }
  }
}
```

> 注：若场景 JSON 中旋转角度计算不精确，可在代码中用 `object3D.lookAt(0, 1.5, -1.5)` 校准方向。

### 6.3 面板实体

```jsonc
{
  "id": "welcome-panel",
  "content": { "type": "asset", "asset": "welcome-panel" },
  "transform": {
    "position": [0, 1.5, -1.5],
    "scale": 1
  }
}
```

面板默认面向 +Z（朝向相机），无需额外旋转。

---

## 步骤 7：应用入口 `src/index.ts`

```ts
import { World } from '@iwsdk/core'
import projectOptions from 'virtual:iwsdk-project'
import { CameraLookSystem } from './camera-look-system'
import { createEnterXRButton } from './enter-xr-button'

const sceneContainer = document.getElementById('scene-container')
if (!(sceneContainer instanceof HTMLDivElement)) {
  throw new Error('Missing #scene-container')
}

World.create(sceneContainer, projectOptions).then((world) => {
  // 注册相机拖拽看四周系统（浏览器模式）
  world.registerSystem(CameraLookSystem)

  // 创建 DOM 层 "ENTER XR" 按钮
  createEnterXRButton(world)

  // 获取面板并绑定 "ENTER GAME" 按钮事件（预留接口）
  const panel = world.requireSceneObject('welcome-panel')
  const enterGameButton = panel.requireElementById('enter-game-button')
  enterGameButton.addEventListener('click', () => {
    console.log('ENTER GAME clicked — 接口预留，待实现游戏入口')
    // TODO: 实现进入游戏逻辑
  })
})
```

---

## 步骤 8：相机拖拽看四周系统 `src/camera-look-system.ts`

在浏览器模式（非 XR）下，允许用户通过鼠标/触摸拖拽在固定位置旋转相机看向四周：

```ts
import { System } from '@iwsdk/core'
import type { World } from '@iwsdk/core'

// 相机固定在 (0,1.5,0)，初始看向 (0,1.5,-1.5)（-Z 方向）
// 拖拽改变 yaw（左右）和 pitch（上下），限制 pitch 范围避免翻转
export class CameraLookSystem extends System {
  private yaw = 0    // 绕 Y 轴旋转（弧度）
  private pitch = 0  // 绕 X 轴旋转（弧度）
  private isDragging = false
  private lastX = 0
  private lastY = 0

  init(world: World) {
    const canvas = world.renderer.domElement
    canvas.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
  }

  private onPointerDown = (e: PointerEvent) => {
    this.isDragging = true
    this.lastX = e.clientX
    this.lastY = e.clientY
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.isDragging) return
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.yaw -= dx * 0.005
    this.pitch -= dy * 0.005
    // 限制 pitch 避免翻转
    this.pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.pitch))
    this.lastX = e.clientX
    this.lastY = e.clientY
  }

  private onPointerUp = () => {
    this.isDragging = false
  }

  update(world: World) {
    // 仅在非 XR 模式下控制相机
    if (world.visibilityState.value !== 'non-immersive') return
    const camera = world.camera
    camera.rotation.order = 'YXZ'
    camera.rotation.y = this.yaw
    camera.rotation.x = this.pitch
  }
}
```

**说明**：
- 相机固定在 (0,1.5,0)（由 `render.camera.position` 设置），不移动位置
- 拖拽改变 yaw/pitch → 模拟在原地看向四周
- `rotation.order = 'YXZ'` 确保先 yaw 后 pitch，避免 gimbal lock 翻转
- XR 会话开始后自动停止控制（`visibilityState` 检测）

---

## 步骤 9：DOM 层 ENTER XR 按钮 `src/enter-xr-button.ts`

IWSDK 有 `xr.offer` + `world.launchXR()` 方案。`offer` 是浏览器原生提示，但可见性不强。额外提供 DOM 按钮：

```ts
import type { World } from '@iwsdk/core'

export function createEnterXRButton(world: World) {
  // 检测 XR 支持
  if (!navigator.xr) return

  navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
    if (!supported) return

    const button = document.createElement('button')
    button.textContent = 'ENTER XR'
    button.style.cssText = `
      position: fixed;
      top: 24px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1000;
      padding: 12px 32px;
      font-size: 16px;
      font-weight: 700;
      color: #fff;
      background: #2563eb;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-family: system-ui, sans-serif;
    `
    button.addEventListener('click', () => {
      world.launchXR()
    })
    document.body.appendChild(button)
  })
}
```

**说明**：
- 检测 `immersive-ar` 支持 → 仅在支持的设备/浏览器显示按钮
- 点击调用 `world.launchXR()` → 请求 AR（VST）会话
- 与 `xr.offer: 'always'` 并存，浏览器原生 offer 作为补充
- 位于屏幕顶部居中

---

## 步骤 10：部署配置

按 `deployment-guide.md` 执行：

### 10.1 创建部署脚本 `scripts/deploy.mjs`

直接从部署指南复制（`REMOTE_ROOT = '/var/www/html/games/harbor-defender'`，`STAGE = '/tmp/hd-stage'`）。

### 10.2 配置 `package.json` scripts

```json
"scripts": {
  "dev": "iwsdk dev restart --open --foreground",
  "dev:runtime": "vite",
  "build": "tsc && vite build",
  "preview": "vite preview",
  "deploy": "npm run build && node scripts/deploy.mjs"
}
```

### 10.3 PWA 图标

创建 `public/icons/icon-192.png` 和 `public/icons/icon-512.png`（简单图标即可，后续替换正式美术资源）。

### 10.4 Service Worker 注册

`vite-plugin-pwa` 自动生成 SW，`start_url`/`scope` 由 `base` 自动推导。无需手动注册。

---

## 步骤 11：HTML 入口 `index.html`

确保生成的 `index.html` 包含 `#scene-container`：

```html
<div id="scene-container" style="width: 100vw; height: 100vh;"></div>
```

若脚手架生成的 HTML 不同，调整使其匹配。

---

## 验证

### 本地验证

```powershell
npm run dev
```

1. 浏览器打开 `https://localhost:8081`
2. 确认看到中灰背景环境
3. 确认面板在 (0,1.5,-1.5) 位置，面向相机
4. 确认面板上方 4/5 显示 "Harbor Defender"，下方 1/5 有 "ENTER GAME" 按钮
5. 鼠标拖拽 → 相机在原地旋转看向四周
6. 确认有平行光阴影效果
7. 确认屏幕顶部有 "ENTER XR" 按钮（若浏览器支持 immersive-ar 或 IWER 激活动）
8. 点击 "ENTER GAME" → 控制台输出预留日志

### IWER 模拟验证

在 IWER DevUI 中切换到 AR 模式，点击 "ENTER XR"，确认进入 VST 模拟会话。

### 部署验证

```powershell
npm run deploy
```

1. `dist/index.html` 内 asset 路径以 `/games/harbor-defender/` 开头
2. `https://svalbardpost.xyz/games/harbor-defender/` 返回 200
3. 所有资源（JS/CSS/manifest/sw.js）200，无 404
4. 在 Quest 3 / PICO 浏览器打开 → 能看到 "ENTER XR" → 点击进入 VST

---

## 关键文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `iwsdk.config.json` | 修改 | XR 模式 AR、offer、spatialUI、相机位置 |
| `vite.config.ts` | 修改 | base 子路径 + PWA 插件 |
| `public/ui/welcome.uikitml` | 新建 | 面板 UI（标题 + 按钮） |
| `public/scenes/main.iwsdk.scene.json` | 修改 | 环境/灯光/面板实体 |
| `src/assets.ts` | 修改 | 注册 welcome-panel UIKitML 资产 |
| `src/index.ts` | 修改 | 注册系统、绑定按钮、创建 ENTER XR 按钮 |
| `src/camera-look-system.ts` | 新建 | 拖拽看四周相机控制系统 |
| `src/enter-xr-button.ts` | 新建 | DOM 层 ENTER XR 按钮 |
| `scripts/deploy.mjs` | 新建 | 部署脚本（从部署指南复制） |
| `package.json` | 修改 | deploy script |
| `public/icons/icon-192.png` | 新建 | PWA 图标 |
| `public/icons/icon-512.png` | 新建 | PWA 图标 |

## 不做的事

- 不实现 "ENTER GAME" 的实际功能（预留接口）
- 不添加游戏逻辑/玩法（后续任务）
- 不自定义面板/按钮样式（使用 IWSDK Horizon 默认）
- 不添加额外的 AR 功能（hit-test/anchors/planes），起始页不需要
