# 任务025 执行计划：机械扑翼机（ornithopter）

> 分支 `feature/ornithopter` 已从 `feature/base` 创建（已切换）。
> 本文档是唯一执行依据；完成后可删除或归档。

## 定案数值（已获用户批准，几何验证过）

| 项 | 值 |
|---|---|
| unitType | `ornithopter`，达芬奇工坊风（木骨架+帆布双翼+吊舱），敌方，中世纪幻想 |
| cruiseY | 2.3（加农炮45°包线走廊 z −3.0…−5.0 @ y 1.8–2.8 内） |
| 停泊带 | z −4.4（远）… −3.0（近），显式常量 |
| hit_core | r=0.5（decorateShipPrototype 自动加，不烘焙进 GLB） |
| HP / 赏金 | 100（统一池）/ 200g（统一价） |
| fireInterval | 1.2s（+共享抖动 0.2–0.5s），首炮立即（cooldown 0） |
| 开火许可 | 越过自身停泊带远端 z=−4.4，无需停稳 |
| 瞄准 | 无 gun_rotate → 整机绕 y 偏航（PirateFireSystem.aimCannon 现有分支） |
| 攻击 | 投石（单一种类石块），复用闭式拦截弹（同 PirateFireSystem.fire，速度用 pirateShellSpeed 8） |
| 扑翼动画 | v1 就带：WingFlap 组件 + WingFlapSystem，翼节点正弦摆动，纯标量积分 |

### 伤害矩阵新增 4 格（combat.md 与 level-config.ts 同步改）

| 攻→受 | 值 |
|---|---|
| `ornithopter->cannon` | 7.5 |
| `ornithopter->sky-ballista` | 10 |
| `cannon->ornithopter` | 25 |
| `sky-ballista->ornithopter` | 20 |

### 关联调整

- `SKY_BALLISTA.pitchMin` 55 → **25**（俯角 20°→50°）；25°弩线自 muzzle(y1.134, z−0.916) 斜率0.466，穿过停泊带全程核心 y 区间 [1.8, 2.8]；船核最近 z=−2.8 处箭高 y≈2.01，不会擦到
- 投弹飞行器停泊带**拆耦合**：`ballistaBoltCrossZ(pitchMin=25)` 会派生出 ≈−4.62 侵入扑翼机带。删除派生函数与 `BALLISTA_PIVOT_Y`/`BALLISTA_ROOT_Z`，改为显式常量 `FLYER_STOP_Z_MIN = -2.6`、`FLYER_STOP_Z_MAX = -1.23`。`BALLISTA_MUZZLE_LOCAL_Y/Z` 保留（battle-setup 在用）
- `BallisticSystem` 补横向兜底回收：`z <= OCEAN_FAR_Z` 静默回收（25°箭要飞很远才达 boltReclaimY 3.25）
- designList 改为只发三只扑翼机：`['ornithopter','ornithopter','ornithopter']`
- combat.md 开火许可线行修正为当前真值：船 −6 / 飞行器 −2.6 / 扑翼机 −4.4（原表 −1.75/−1.80 是过期值）

## 文件改动清单

1. **scripts/export-assets.ts**：新增 `createOrnithopterExport()` + 导出 `ornithopter.glb`
   - 顶点色、白固有色、粗糙度~0.75 电介质、合并网格减 draw call、帆布 DoubleSide
   - 节点契约：root 名 `ornithopter`，朝向 −Z；**不含** gun_rotate；**含** `muzzle` 空节点（吊舱肚腹，石块释放点，如 (0, −0.18, 0)）
   - 翼结构：`wing_left`（几何向 −X 伸展、根在节点原点）与 `wing_right`（+X）两个节点，各挂一个合并翼网格（帆布+木肋）；摆动 = rotation.z 正弦、左右反相
   - 三角面数控制 ~1.5k 内；制作脚本保留在本文件（可复跑）
2. **src/assets.ts**：注册 `'ornithopter'` → `gltf/ornithopter.glb`（GLTF, background）
3. **src/level-config.ts**：
   - pitchMin 25；FLYER 带显式常量（删 ballistaBoltCrossZ/BALLISTA_PIVOT_Y/BALLISTA_ROOT_Z）
   - 新增 `ORNITHOPTER = { y: 2.3, stopZMin: -4.4, stopZMax: -3.0, flapSpeed: 4, flapAmplitude: 0.35 }`
   - `UnitTypeDef` 加 `flap: boolean`、`stone: boolean`
   - `COMBAT` 加 `ornithopterFireInterval: 1.2`、`stonePoolSize: 8`、`stoneRadius: 0.05`、`stoneColor: 0x8a8a86`（石头 roughness 0.9 / metalness 0）
   - DAMAGE_MATRIX 4 格；UNIT_TYPES 加 ornithopter（movement 'default-ship'、rotor false、wake false、flap true、stone true）；designList 三扑翼
4. **src/components.ts**：新增 `StoneTag`、`WingFlap`（speed/amplitude 默认读 ORNITHOPTER）；`PirateCannon` 加 `stone` 布尔字段；全部进 defineComponents 列表
5. **src/cannon-fire-system.ts**：init 建 8 发石块池（IcosahedronGeometry(stoneRadius, 0)，模式同球池，castShadow）；freeShells 查询 excluded 增加 StoneTag
6. **src/pirate-fire-system.ts**：加 `freeStones` 查询（required [ShellTag, StoneTag], excluded [BallisticFlight]）；freeShells excluded 增加 StoneTag；fire() 按 `PirateCannon.stone` 选池
7. **src/level-wave-system.ts**：spawnUnit 按 `def.flap` 挂 WingFlap；PirateCannon addComponent 传 `stone: def.stone`
8. **src/wing-flap-system.ts**（新文件）：模式照抄 PropellerSpinSystem——qualify 缓存 wing_left/wing_right 节点，update 写 `rotation.z = ±amp·sin(phase)`，phase 存 init 分配的 Map；excluded Destroyed；paused/over 门控
9. **src/ballistic-system.ts**：加 `z <= OCEAN_FAR_Z` 静默回收（import OCEAN_FAR_Z）
10. **src/index.ts**：注册 WingFlapSystem（priority 10，与 PropellerSpinSystem 同层）
11. **docs/design/combat.md**：矩阵 4 格、节拍段（炮4发/弩5发杀扑翼机；扑翼机14发杀炮/10发杀弩）、开火线真值、赏金表加行、弩俯角说明更新

## 实施顺序

1. Skill(iwsdk-build-model) → 写 export-assets.ts 模型代码 → `npm run export-assets` 生成 GLB
2. 其余代码改动（3–10）
3. `npm run --if-present typecheck` → `npm run build`（免浏览器必做门禁）
4. 视觉验证门禁（强制）：先问用户「你本人人工验证，还是我在真实站点验证？」；两路径都 bump package.json patch 版本 + `npm run deploy`，交付 `https://svalbardpost.xyz/games/harbor-defender/?v=<版本>-<UTC时间戳>`；用户人工验证时 Agent 不做任何浏览器/截图检查
5. git 提交推送（PowerShell 无 heredoc，多行信息用多个 -m）

## 陷阱备忘

- Entity.dispose 必须 `{ disposeResources: false }`（原型克隆共享资源）
- IWSDK 查询 qualify 陷阱：向已满足条件的实体挂新组件不触发 qualify；本任务所有新标签都在 createTransformEntity 后立刻 add，无此问题
- update() 内禁止分配；WingFlap 的 phase 用 init 分配的 Map
- 部署与主站独立，只跑本项目 `npm run deploy`
