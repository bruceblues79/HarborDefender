# 单一火炮与拟真弹道重构计划（one-cannon）

状态：已评审待执行（2026-10-30 用户拍板，本会话定稿）
用法：用户将在新会话指令"执行 one-cannon-ballistics 计划"。执行前先 grep 复核本文行号（代码会漂移）；除标注"待实测"外，所有数值均已用户确认，不得自行更改。

## 0. 目标一句话

防空弩退役，全港只剩一种加农炮；放宽弹道包络实现"一种炮打所有"（低角平射反舰、45° 最大射程、80° 吊射防空）；建造胶囊从"单位商店"改造为"购炮 + 弹药切换坞"；弹药经济打底，黑铁蛋免费无限。

背景结论：守方炮弹**已经是** BallisticFlight 重力积分（src/ballistic-system.ts），预览**已经是**抛物线采样（src/trajectory-preview-system.ts）。本轮不新增物理，只放宽包络并重标定全部派生常量。

## 1. 范围

### 本轮（v1）

- 防空弩整体退役（见 §4）
- 换防/回收体系退役，修理与空位购炮保留（见 §4）
- 弹道参数放宽 + FLYER_Y 解耦 + 派生常量重算（见 §2、§3）
- 建造胶囊弹药化：铁蛋切换坞 + 铁蛋图标（见 §5、§6）
- 连带核查项（见 §7）

### 明确不做（后续轮，规格已定）

- 火弹：切换制非购买制；5g/发自动扣费（占位价）；命中闪光加大；命中点 AOE（周围伤害稍低）；切换后 icon 高亮 + 缩小。下一轮做。
- 激光弹、墙可被轰击、敌人升级兵、"不老实"敌人（须带 telegraph）。
- 敌方弹道拟真（海盗炮弹/石料/炸弹一律维持现状）。

## 2. 弹道参数（确认值）

位置：src/level-config.ts COMBAT 块（约 L515-561）。

| 常量 | 现值 | 新值 |
| --- | --- | --- |
| COMBAT.shellSpeed | 7.45 | 9.0 |
| COMBAT.aimPitchMax | 45 | 80 |
| COMBAT.aimPitchMin | 0 | 0（不动） |
| COMBAT.aimPitchDefault | 22.5 | 22.5（暂不动，手感可调项） |
| COMBAT.gravity | 9.8 | 9.8（不动） |

- FLYER_Y 解耦：现由加农炮最大 apex 推导（level-config.ts 约 L793-830），改初速后推导漂移。改为显式常量，数值取**当前运行值**（约 2.5-2.6，执行时先读再定，勿按新 apex 重算）。
- 执行时 grep `shellSpeed|aimPitchMax|aimPitchMin|aimPitchDefault|FLYER_Y` 全部引用点，派生常量逐一复核。

## 3. 精确核算

炮口世界高度按 ~1.2m 估算（pad 0.84 顶 + 炮架），**执行时第 3 步实测复核；若实测偏差 > 0.2m，回报用户重算本表**。

公式（相对炮口）：包络 y_max(x) = v0²/2g − gx²/(2v0²)；两点命中双解 tanθ = [x ± √(x² − 4k(k+Δh))]/(2k)，k = gx²/(2v0²)。

| 目标 | 停泊带 z | 高度 | 低弧解 | 高弧解 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 扑翼机 | [-5.25, -3.5] | 2.3 | 31°~34° | 68°~76° | 全带覆盖 ✓，**停泊带不动** |
| 轰炸机 | [-1.73, -3.75] | FLYER_Y ≈2.55（待实测） | 35°~45° | 75°~83° | 低弧解全带覆盖 ✓，**远近停不动**；近停陡解 83° 超上限但低弧解充裕 |
| 海盗船 | 最远 -6 | ≈0.3~0.5 | 22°~25° | — | ✓ |

辅助数字：

- 45° 平射程 5.66m → 8.26m（海盗船 -6 覆盖余量增大）
- 弹顶：45° 时炮口上方 1.42m → 2.07m；80° 垂吊时约 4.13m（世界 ~5.2m）
- 旧包络缺陷（本次放宽的动机）：v0=7.45 时扑翼带外段 [-5.25, -4.2] @2.3m 在包络外，任何角度不可达
- 吊射滞空变长：68° 打 x=5.25 滞空 ~1.56s（炮弹池占用核查见 §7）

## 4. 防空弩退役 + 换防体系退役（纯删除，不做替代实现）

执行时以 grep `sky-ballista|Ballista|ballista`（区分 ballistic，勿误删）全量复核，已知足迹 13 文件：

- src/level-config.ts：PLACEABLE_UNITS 去除 'sky-ballista'（约 L163-192）；UnitTypeDef 条目；unitValues['sky-ballista']
- src/assets.ts：弩 GLB 注册与图标注册；GLB 文件本体删除（文件名执行时确认）
- 专属系统/组件：弩系统文件、弩箭池与弩箭 y=3.25 静默回收逻辑、弩俯仰约束（25°~75°）、弩拖拽分部位映射（cannon-aim-system.ts）
- src/trajectory-preview-system.ts：直线弩箭交叉线预览分支
- src/cannon-fire-system.ts：共享池中弩箭部分；src/shell-hit-system.ts：弩箭命中分支；src/level-wave-system.ts、src/battle-setup.ts、src/defense-buttons.ts、src/pirate-fire-system.ts、src/components.ts、scripts/export-assets.ts：逐文件审计引用
- public/ui/build-panel.uikitml：row-sky-ballista 按钮（约 L221-237）
- public/ui/icons/bow-filled.svg 删除
- 换防退役：replaceDiscount 0.3 与补差价结算代码、dock-recycle 回收按钮 + public/ui/icons/recycle.svg
- **保留**：修理 8g/s 不动；空位购炮 200g 保留（row-cannon 变为纯购炮按钮，槽位占用时沿用 dock-unit-hidden 隐藏）；重开重置为初始 3 门加农炮的规则不变

## 5. 建造胶囊 → 弹药坞

- 布局：顶部行（钱包徽章 + X）不动；胶囊长条 = [购炮按钮（仅空槽显示）] + [弹药选择行：铁蛋按钮]
- 弹药选择为**全局单选**（非槽位态）：新组件 AmmoSelected（存弹药类型枚举）挂 director 实体，声明必须进 src/components.ts 的 defineComponents() 清单；作用于所有加农炮的下一发
- v1 仅铁蛋一档：默认激活；因无第二档，点击自身为 no-op
- 激活态样式：icon 高亮 + 三轴 0.75 缩放（复用建设按钮现成模式）
- 弹药数据表 AMMO_DEFS 留结构（id / icon / costPerShot），铁蛋 costPerShot: 0；火弹未来 = 表中加一条 + 命中效果分支，不动 dock 结构
- 钱包徽章实时读数机制不动

## 6. 铁蛋图标

public/ui/icons/ball-iron.svg，填充风格（bow-filled.svg 同款），落盘时配色对齐现有图标色板（勿用 currentColor，fill 硬编码）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <circle cx="12" cy="13.2" r="7.8" fill="#2e3440"/>
  <circle cx="9.4" cy="10.4" r="2.1" fill="#5a6270"/>
</svg>
```

## 7. 连带核查项（执行时逐条确认）

- 炮弹池容量：吊射滞空至 ~1.6s，5 炮齐射并发弹数上升，核查池余量
- 预览点列：高仰角弧线更长，确认点距/点数是否需随弧长调整；高仰角段预览起点与炮口/城墙/血条视觉重叠问题
- 拖拽灵敏度：0-80° 映射同距拖拽，俯仰粒度变粗，评估是否需灵敏度系数常量
- 弹道预览截断规则（入水高度即止）在陡角下依然成立
- XR 与平面拖拽映射共用同一套俯仰约束，改上限后两侧行为一致
- 石料池、海盗炮弹不受影响（敌方弹道不动）

## 8. 验证门

- 免浏览器门禁：npm run typecheck → npm run build
- 视觉类改动（弹道手感/预览形态/dock 布局/图标）按根 AGENTS.md 门禁：先问用户"人工验证 or 部署站点验证"；bump patch 版本 + npm run deploy，带 ?v=版本-UTC时间戳 破缓存；禁止 localhost/自签证书验证

## 9. 实施顺序

1. 防空弩 + 换防 + 回收 纯删除 → typecheck
2. 弹道参数 + FLYER_Y 解耦 + 派生常量重算 → typecheck
3. 实测炮口世界高度，复核 §3 核算表（偏差 > 0.2m 回报用户）
4. dock 弹药化 + AmmoSelected 组件 + 铁蛋图标 → typecheck
5. §7 连带核查逐条过
6. npm run build → 视觉门禁（§8）

## 10. 后续轮预埋（本轮不实施）

- 火弹：切换非购买；5g/发自动扣费（占位）；命中闪光加大；命中点 AOE 低伤；切换 icon 高亮 + 缩小
- 弹药扣费天然接入 DDT 存款系数（花钱 → 压力系数回落），无需改 DDT
- 激光弹、墙可被轰击、敌方升级兵、诡计敌人（每个"不老实"行为必须带可读 telegraph）
