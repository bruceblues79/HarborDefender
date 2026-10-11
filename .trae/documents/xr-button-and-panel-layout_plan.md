# 移除自定义 DOM XR 按钮 + 修复 Welcome Panel flex 布局 实施计划

## 仓库调研结论

### 现状

1. **相机**：用户已自行修改 `iwsdk.config.json` 中 `render.camera.position` 为 `[0, 1.5, 1]`（原 `[0, 1.5, 0]`），`lookAt` 仍为 `[0, 1.5, -1.5]`。此项无需我处理。

2. **自定义 DOM XR 按钮**：
   - `src/enter-xr-button.ts` 定义了 `createEnterXRButton()`，动态向 `document.body` 注入一个蓝色 "ENTER XR" 按钮，点击调用 `world.launchXR()`。
   - `src/index.ts` 第 11 行 import、第 21 行调用。
   - 同时 `iwsdk.config.json` 中 `xr.offer: "always"` 已让浏览器显示**原生 XR 进入按钮**。两者功能重叠。

3. **Welcome Panel 布局**：
   - `public/ui/welcome.uikitml` 的 `.panel-root` 设了 `flex-direction: column`，`.title-section` / `.button-section` 设了 `flex-grow`、`justify-content`、`align-items`。
   - **问题**：三个容器都缺少 `display: flex`。UIKitML 的 flex 属性（`flex-direction`、`justify-content`、`align-items`、`flex-grow`）只有在 `display: flex` 下才生效，因此当前布局实际没有按 column 排列。
   - `public/ui/AGENTS.md` 明确列出 `display: flex` 是已验证支持的属性，并建议"优先使用显式属性"。

### 约束

- `src/index.ts` 中 `createEnterXRButton` 是当前唯一对 `enter-xr-button.ts` 的引用，移除后该文件可安全删除。
- 移除 DOM 按钮后，XR 入口完全依赖 `offer: "always"` 的浏览器原生按钮，配置已就位，无需改 config。
- UIKitML 数值单位为厘米，`width/height: 100` = 1m。

## 涉及文件

- `src/enter-xr-button.ts`：删除整个文件。
- `src/index.ts`：移除 `createEnterXRButton` 的 import 与调用。
- `public/ui/welcome.uikitml`：给 `.panel-root`、`.title-section`、`.button-section` 添加 `display: flex`。

## 实施步骤

1. **移除 DOM XR 按钮**
   - 从 `src/index.ts` 删除 `import { createEnterXRButton } from './enter-xr-button.js';` 及注释。
   - 从 `src/index.ts` 删除 `createEnterXRButton(world);` 调用及注释。
   - 删除 `src/enter-xr-button.ts` 文件。

2. **修复 welcome panel flex 布局**
   - 在 `.panel-root` 中添加 `display: flex;`（已有 `flex-direction: column`）。
   - 在 `.title-section` 中添加 `display: flex;`（已有 `justify-content` / `align-items` / `flex-grow`）。
   - 在 `.button-section` 中添加 `display: flex;`（已有 `justify-content` / `align-items` / `flex-grow`）。

## 依赖与注意事项

- 两个改动互相独立，无依赖顺序。
- 删除 `enter-xr-button.ts` 前确认无其他引用（grep 确认只有 `index.ts` 引用）。
- 不修改 `iwsdk.config.json` 的 `xr.offer`，保持 `"always"` 以提供原生 XR 入口。

## 验证

1. `npm run typecheck` 通过（确保移除 import 后无类型错误）。
2. 启动 `npx @iwsdk/cli dev up`，确认：
   - 页面不再出现蓝色 "ENTER XR" DOM 按钮。
   - 浏览器原生 XR 入口按钮仍存在（由 `offer: "always"` 提供）。
3. 渲染 welcome panel 预览验证 column 布局生效：
   ```bash
   npx @iwsdk/cli ui render-preview --input-json '{"assetId":"welcome-panel","width":800,"height":600}' --output-file artifacts/welcome-panel-preview.png
   ```
   预期：标题 "Harbor Defender" 在上 4/5 区域居中，"ENTER GAME" 按钮在下 1/5 区域居中，纵向排列。

## 风险

- **风险：移除 DOM 按钮后，某些环境（如桌面 Chrome 无 IWER）不显示原生 XR 按钮** → 处理：`offer: "always"` 在支持 WebXR 的浏览器均会显示原生按钮；桌面 dev 环境使用 IWER 时也会显示。如后续发现某环境无入口，再考虑恢复自定义按钮或改用 `world.launchXR()` 绑定到面板按钮。
- **风险：`display: flex` 后布局与预期不符** → 处理：用 `ui render-preview` 渲染验证，必要时调整 `flex-grow` 比例。
