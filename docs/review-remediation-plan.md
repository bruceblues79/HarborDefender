# 审阅整改计划（review-remediation）

来源：2026-11-01 全项目审阅（代码 / 模块化 / 数值 / 内容方向）。
分支：`feature/review-remediation`（临时分支，完成后按需合并 main）。

## 会话纪律（每个任务都适用）

- 一个任务 = 一次会话，完成即停，review 通过后 commit，不跨任务夹带。
- 每次会话收尾必跑：`npm run --if-present typecheck` → `npm run build`。
- 不启动 dev runtime、不做浏览器/视觉验证；涉及可见变化的任务在"待用户验证"一节列出核对点，由用户决定自验或部署后验证。
- 部署由用户执行，部署前必须提升 `package.json` 版本号。
- 范围红线：只做任务清单内的事，不顺手重构、不加任务未提及的功能。

## 任务总览

- [x] T0-A 弹道位置积分与轨迹预览对齐（bug 修复 · 反馈 1）
- [x] T0-B 维修时序：零血炮台复活（bug 修复 · 反馈 3）
- [ ] T1 修复 build-panel 监听器 teardown 失效（bug 修复）
- [ ] T2 数值小补丁：过时注释 + planner 账面价值 + wave2 预算
- [ ] T3 门卫 helper 去重 + 池认领模式统一（纯重构）
- [ ] T4 拆分 level-wave-system（纯重构）
- [ ] T5 弹药扩充方案设计（只出方案，等拍板）
- [ ] T6 付费弹种实现（依赖 T5 拍板）
- [ ] T7 海盗船火控并轨 GunCycle（大重构）
- [ ] T8 （可选，待拍板）头目闪电伤害方差调整 75% → 50-60%

---

## T0-A 弹道位置积分与轨迹预览对齐（已完成）

**症状**：实弹落点比预览弧线系统性偏短，且随帧率漂移。

**根因**：预览用闭式解采样位置，实弹位置走半隐式欧拉（新速度 × dt），每步 O(dt²) 误差累积。

**改动**：`src/ballistic-system.ts` 阻力分支（k > 0）改用与预览同源的精确位移积分，复用同一个 `decay`；无阻力分支（海盗/头目抛物线）保持原样，避免扰动其它系统已解算的拦截解。

**性能**：`Math.exp` 每弹每帧仍只调一次（复用），仅多几次乘除，可忽略。

**验证**：`npm run typecheck` / `npm run build` 通过。落点与预览重合属可见行为，按视觉验证门处理。

## T0-B 维修时序：零血炮台复活（已完成）

**症状**：被头目激光/死光打到 0 血的炮台，维修中不会死亡，以近零血存活并可修满。

**根因**：激光写血 @11、死光 @13，维修 @12 抢先抬血，死亡清扫 @14 看到 >0 便不杀。

**改动**：`src/index.ts` RepairSystem 优先级 12 → 15（清扫之后），并补注释说明该约束；正常维修路径行为不变。

**验证**：`npm run typecheck` / `npm run build` 通过。

## T1 修复 build-panel 监听器 teardown 失效

**目标**：`removeEventListener` 当前传入的是新创建的箭头函数，永远移除不掉注册时的那个。保存真实引用后再移除。

**改动点**：`src/build-panel-system.ts` 三处——unit 行（约 L156-160）、ammo 行（约 L169-172）、dismiss（约 L185-188）。

**步骤**：
- [ ] 为每个 listener 先声明具名/具引用函数，再 `addEventListener`
- [ ] `cleanupFuncs.push` 里移除同一引用
- [ ] 自查：三处注册点全部覆盖，无第四处同类模式

**验证**：typecheck + build；行为不变（面板加载/点击路径不回归）。

## T2 数值小补丁

**目标**：三处数值/注释自洽性修复，全部是数据层改动，不碰系统代码逻辑。

**改动点**：
- `src/level-config.ts` 约 L291、L764：删除 "Mirrors docs/design/combat.md — change both together" 两处过时注释（文档已移除）。
- `src/endless-planner-system.ts` L102-112：`defenderPressure()` 改读 `ECONOMY.unitValues` 按单位求和（当前用 `killReward` 当账面价值，铁卫 2500 被记成 200）。`pressureMoneyFull` 维持 600 不动——效果是铁卫上场即接近满压，符合"嘲讽坦在场=防守强"的语义。
- `src/level-config.ts` `ENDLESS.baseBudgetWave2`：2 → 3（修复 wave2 比 wave1 弱的节奏倒挂；wave1 种子 = 3 艘）。

**步骤**：
- [ ] 删两处过时注释
- [ ] planner 账面价值切换 + 同步更新函数注释
- [ ] baseBudgetWave2 改 3
- [ ] 纸面复算：wave2 预算 = 3 × 0.7~1.15 × 1.125 ≈ 2.4~3.9（比 wave1 的 3 艘略强或持平，不再倒挂），把推演写进 commit message

**验证**：typecheck + build。
**红线**：不动 `DAMAGE_MATRIX`、`DEATH_LIGHT`、`REWARD_TABLE`。

## T3 门卫 helper 去重 + 池认领模式统一

**目标**：消除跨系统逐字复制的三件套 `paused()/over()/gameRunning()`（≥8 个系统，约 150 行）和 4 份 `firstFreeShell/claimed-set` 拷贝。纯重构，行为零变化。

**改动点**：
- 新建 `src/system-gates.ts`：导出对 `queries.directors` 操作的纯函数（`directorOf` / `isPaused` / `isOver` / `isGameRunning`），不做基类继承、不引入全局单例。
- 新建或并入 `src/shell-pool.ts`：`claimFree(query, claimed, guard)` 统一弹池认领（CannonFire / PirateFire / GunCycle 的 ball+stone 共 4 处）。

**步骤**：
- [ ] 写 helper + 先迁移 2 个系统（cannon-fire、pirate-fire）验证模式
- [ ] 铺开到其余系统：gun-cycle、laser-cycle、free-lock-target、cannon-aim、ship-movement、repair（repair 的 gate 写法略有差异，保持其语义）
- [ ] 弹池认领统一 4 处
- [ ] `git diff` 逐文件核对：只有调用替换，无逻辑变化

**验证**：typecheck + build。
**红线**：不改任何系统优先级、不改行为语义、不删除任何导出（除非确认无引用）。

## T4 拆分 level-wave-system

**目标**：917 行的导演系统拆到约 600 行以内。纯移动 + 少量参数化，不改行为。

**改动点**：
- `attachBossTurrets`（约 L671-794）+ chief mount 捕获逻辑 → 新建 `src/boss-assembly.ts`，导出 `attachBossTurrets(world, boss)`。
- beginLevel / restartLevel / resetToWelcome 三段近似重复的标签清扫 → 收敛为一个私有 `clearRunState(opts)`（参数表达差异：是否清 GameStarted/EndlessMode/phase 归位）。

**步骤**：
- [ ] 抽出 boss-assembly.ts（含注释整体搬迁，不重写）
- [ ] 收敛 clearRunState，逐行 diff 三个入口的等价性
- [ ] index.ts 无需改动（系统注册不变）

**验证**：typecheck + build。
**红线**：不改 spawn 语义、不改 dispose 纪律（`disposeResources: false`）、不改事件顺序（GameOver 提交在 tag 之前等既有约束）。

## T5 弹药扩充方案设计（只出方案）

**目标**：在 `docs/` 产出一份弹药数值方案，列 2-3 种付费弹，等用户拍板后进 T6。

**步骤**：
- [ ] 候选弹种数值表（伤害/成本/弹道差异），基于现有框架：`AMMO_DEFS` 行 + `costPerShot` + `DAMAGE_MATRIX` 行 + shell-hit 命中分支
- [ ] 候选：爆炸弹（AoE 半径 + 伤害衰减，对密集停泊带）、重弹（高伤慢速，对 Boss 部位）、链弹（对飞行单位倍率）
- [ ] DPS / 成本 / 回收周期推演（对照杀赏 200、维修 13g/s）
- [ ] 余额不足时的射击行为方案（降速重试 vs 拒发），二选一给推荐
- [ ] 产出 `docs/ammo-expansion-proposal.md`，停，等拍板

**红线**：不写任何实现代码。

## T6 付费弹种实现（依赖 T5 拍板）

**目标**：按拍板结果实现弹药扩充。

**步骤**：
- [ ] `AMMO_DEFS` 增行 + dock 图标资产确认（`ui/icons/*.svg` 是否需要新增——需要则先出图）
- [ ] `CannonFireSystem.fire()` 接入 `AmmoSelected` + `Wallet` 扣费（按 T5 拍板的余额策略）
- [ ] `DAMAGE_MATRIX` 增行 + shell-hit 命中效果分支（AoE/倍率）
- [ ] build-panel ammo 行自动随 `AMMO_DEFS` 渲染（现有循环已支持，验证即可）
- [ ] 数值自证：新弹种 vs 铁弹的 TTK 对比表写进 commit message

**验证**：typecheck + build。
**待用户验证**（视觉/手感类，不自行验证）：dock 新行渲染、图标、射击手感。

## T7 海盗船火控并轨 GunCycle

**目标**：删除攻击方火控双轨制——海盗船从 `PirateCannon` 迁到 `GunCycle` + `LockTarget`，删除 `pirate-fire-system.ts`（约 330 行）。

**改动点**：
- `GunCycle` 增加字段：`fireLineZ`（Float32，默认 `-Infinity`，替代 requireStopped 的语义：炮线是"过了就能打"，requireStopped 是"停了才打"——两者共存，boss 用后者，海盗用前者）
- `LockTarget` / `FreeLockTargetSystem` 增加可选的嘲讽语义：per-gun `respectTaunt`（Boolean，默认 false；boss 装配保持 false，海盗 spawn 置 true）——嘲讽劫持从 PirateFireSystem 平移进索敌系统
- `spawnUnitByType`（level-wave-system）给武装单位改挂 `GunCycle`（interval = 单位表 fireInterval，shellUnitType = unitType，muzzle/pivot 沿用现有装饰节点）+ `LockTarget`
- `components.ts`：`PirateCannon`、`PirateFireSystem` 相关删除；`index.ts` 注销注册
- 注意语义保真：海盗第一发立即开火（cooldown 0）✈ 现 GunCycle 开局 cooldown 需给海盗 0；flyer 炮塔缺失时的 whole-hull yaw 路径 GunCycle 已有

**步骤**：
- [ ] 组件字段扩展（fireLineZ / respectTaunt）
- [ ] FreeLockTargetSystem 接嘲讽劫持（读 Taunt 的两遍扫描平移自 pirate-fire）
- [ ] spawn 挂载切换 + PirateCannon 删除
- [ ] pirate-fire-system.ts 删除 + index.ts 注销
- [ ] 行为对照清单核对：开火时机（过线即打）、嘲讽劫持、目标死亡重锁、石头池路径（ornithopter）

**验证**：typecheck + build。
**待用户验证**：海盗船开火节奏、嘲讽表现、ornithopter 投石——实机体验类，等用户安排。
**红线**：boss 火控行为一字不动（free-lock 现有语义保持）。

## T8 （可选，待拍板）头目闪电方差调整

`DEATH_LIGHT.damageRatio` 75% → 50-60%，收窄残局方差（2 炮台时一发闪电≈死刑）。只改一个数 + 注释补推演。**等用户拍板是否做、目标值取多少。**

---

## 待用户验证清单（累计）

| 任务 | 核对点 |
|---|---|
| T6 | build dock 新弹药行渲染、图标、扣费手感 |
| T7 | 海盗船开火时机、嘲讽转向、ornithopter 投石 |
| T8 | 头目闪电伤害体感 |

## 合并策略

全部完成后按主题决定：T1-T4 可整段并入 main（低风险）；T6/T7 各自独立评估。合并前由用户 review 每个任务的 commit。
