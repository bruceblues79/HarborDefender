---
name: preview-html
description: Build the current workspace into one self-contained HTML and send it to the user's own Feishu chat. Use when the user says 「preview 项目」, 「打个 html 给我」, 「发个预览」, or asks for a local playable preview. Do not use for deploying, version bumps, or any browser/screenshot verification.
argument-hint: '[optional: what changed in this round]'
---

# Preview HTML

把当前工作区打成单个自包含 HTML，并发到用户本人的飞书。用户在手机上自行查看；
agent 不看画面、不做任何浏览器验证、不部署。

## 步骤

1. `npm run typecheck`。失败就停，不发文件。
2. `npm run pack:html`。读输出 JSON 里的 `file`、`bytes`、`utc`。
3. `powershell -NoProfile -File scripts/send-preview.ps1`，发送 `latest.html`。
4. 向用户报告：文件名、体积、UTC 时间、本轮改了什么，并附 `computer://` 链接到该文件。

## 边界

- 不执行 `npm run deploy`。
- 不改 `package.json` 版本号。
- 不启动 dev server、headless、managed browser，不截图。
- 产物只落在已忽略的 `.trae-html-share-packages/`，不提交。

## 失败处理

- typecheck 失败：贴首行错误，不发旧文件。
- 打包失败：贴首行错误，不发旧文件。
- `lark-cli` 不可用或发送失败：保留已生成的 html，告知用户一次，不重复重试。
