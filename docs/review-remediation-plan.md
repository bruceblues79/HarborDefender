# 审阅整改计划（review-remediation）

来源：2026-11-01 全项目审阅（代码 / 模块化 / 数值 / 内容方向）。
分支：`feature/review-remediation`（临时分支，完成后按需合并 main）。

## 会话纪律（每个任务都适用）

- 一个任务 = 一次会话，完成即停，review 通过后 commit，不跨任务夹带。
- 每次会话收尾必跑：`npm run --if-present typecheck` → `npm run build`。
- 不启动 dev runtime、不做浏览器/视觉验证；涉及可见变化的任务在交付说明中列出核对点，由用户决定自验或部署后验证。
- 部署由用户执行，部署前必须提升 `package.json` 版本号。
- 范围红线：只做任务清单内的事，不顺手重构、不加任务未提及的功能。

## 任务总览

- [x] T0-A 弹道位置积分与轨迹预览对齐（bug 修复 · 反馈 1）
- [x] T0-B 维修时序：零血炮台复活（bug 修复 · 反馈 3）
- [ ] T1 修复 build-panel 监听器 teardown 失效（bug 修复）
- [ ] T2 数值小补丁：过时注释 + planner 账面价值 + wave2 预算
- [ ] T3 门卫 helper 去重 + 池认领模式统一（纯重构）
- [ ] T4 拆分 level-wave-system（纯重构）

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

## 合并策略

全部完成后按主题决定：T1-T4 可整段并入 main（低风险）。合并前由用户 review 每个任务的 commit。

