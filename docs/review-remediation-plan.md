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

> 2026-11-04 复核（只读评估）：T1 实际只剩两处 listener（ammo 行已随 0.1.307 移除）；
> T2 的 planner 账面价值一项已被 `estimateCapacity()` 取代，标记为已失效；T3 降级为“暂不做”；
> T4 实际为 962 行，原 917 行与相关行号已漂移。新的优先级见文末“优先级重排（2026-11-04）”。

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

> **2026-11-04 复核（与原计划冲突，保留原文并加注）**：上述行号已漂移，且 ammo 行已在 0.1.307
> 的“建造入口迁移到空槽底座”改动中移除。当前实际只有两处 listener：
> unit 行 [build-panel-system.ts L141-L144](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/build-panel-system.ts#L141-L144)、
> dismiss [build-panel-system.ts L152-L156](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/build-panel-system.ts#L152-L156)。
> 原来的 ammo 项仅保留作历史对照，执行时不要按旧行号查找，也不要为了凑“三处”新增 listener。

**步骤**：
- [ ] 为每个 listener 先声明具名/具引用函数，再 `addEventListener`
- [ ] `cleanupFuncs.push` 里移除同一引用
- [ ] 自查：三处注册点全部覆盖，无第四处同类模式

> 2026-11-04：自查范围按实际改为**两处**（unit 行、dismiss）；原第三处 ammo 行已不存在。

**验证**：typecheck + build；行为不变（面板加载/点击路径不回归）。

## T2 数值小补丁

**目标**：三处数值/注释自洽性修复，全部是数据层改动，不碰系统代码逻辑。

> 2026-11-04 复核：实际只剩两项（两处过时注释 + `baseBudgetWave2`）。
> `baseBudgetWave2: 2` 仍在 [level-config.ts L448](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/level-config.ts#L448)，
> 两处 `combat.md` 注释仍在 L257、L750；planner 那一项已失效，勿做。

**改动点**：
- `src/level-config.ts` 约 L291、L764：删除 "Mirrors docs/design/combat.md — change both together" 两处过时注释（文档已移除）。
- `src/endless-planner-system.ts` L102-112：`defenderPressure()` 改读 `ECONOMY.unitValues` 按单位求和（当前用 `killReward` 当账面价值，铁卫 2500 被记成 200）。`pressureMoneyFull` 维持 600 不动——效果是铁卫上场即接近满压，符合"嘲讽坦在场=防守强"的语义。
  > **已失效 / 已被 `estimateCapacity()` 取代（2026-11-04）**：DDT 再平衡已把这段改成按炮台血量比例 + `guardPowerWeight` 估战力
  > （[endless-planner-system.ts L114-L176](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/endless-planner-system.ts#L114-L176)），
  > `unitValues` 现在只用于重建成本（L163）。“铁卫 2500 被记成 200”在当前代码中不存在。
  > 保留此条仅为历史记录；执行 T2 时**不要**再改 planner，也不要恢复 `defenderPressure()`。
- `src/level-config.ts` `ENDLESS.baseBudgetWave2`：2 → 3（修复 wave2 比 wave1 弱的节奏倒挂；wave1 种子 = 3 艘）。

**步骤**：
- [ ] 删两处过时注释
- [ ] planner 账面价值切换 + 同步更新函数注释 **（已失效，跳过；见上）**
- [ ] baseBudgetWave2 改 3
- [ ] 纸面复算：wave2 预算 = 3 × 0.7~1.15 × 1.125 ≈ 2.4~3.9（比 wave1 的 3 艘略强或持平，不再倒挂），把推演写进 commit message

**验证**：typecheck + build。
**红线**：不动 `DAMAGE_MATRIX`、`DEATH_LIGHT`、`REWARD_TABLE`。

## T3 门卫 helper 去重 + 池认领模式统一

> **2026-11-04 决定：暂不做。** 理由：T3 会改 8 个系统的 gate 写法和 4 处弹池认领，
> 而这些调用点正好是新增契约项（`BuildOpen`、`Repairing`、池 claim/release）要改的地方；
> 仓库没有测试/CI，纯重构无法证明行为零变化。等契约项收敛、回归通过后再评估。
> 以下内容保留为历史方案，不是当前执行项。

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

> 2026-11-04 复核：实际为 **962 行**（[level-wave-system.ts](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/level-wave-system.ts)）。
> 原行号已漂移：`beginLevel` L240、`resetToWelcome` L261、`restartLevel` L287、`attachBossTurrets` L667。
> 仍按“只抽模块文件、不新增 system”执行；拆出节奏/胜负 system 会引入静默顺序错误，见文末劝退清单。

**改动点**：
- `attachBossTurrets`（约 L671-794）+ chief mount 捕获逻辑 → 新建 `src/boss-assembly.ts`，导出 `attachBossTurrets(world, boss)`。
- beginLevel / restartLevel / resetToWelcome 三段近似重复的标签清扫 → 收敛为一个私有 `clearRunState(opts)`（参数表达差异：是否清 GameStarted/EndlessMode/phase 归位）。

**步骤**：
- [ ] 抽出 boss-assembly.ts（含注释整体搬迁，不重写）
- [ ] 收敛 clearRunState，逐行 diff 三个入口的等价性
- [ ] index.ts 无需改动（系统注册不变）

**验证**：typecheck + build。
**红线**：不改 spawn 语义、不改 dispose 纪律（`disposeResources: false`）、不改事件顺序（GameOver 提交在 tag 之前等既有约束）。

## 优先级重排（2026-11-04）

依据：只读 ECS 粒度评估 + 本计划复核。原则：**正确性 > 契约收敛 > 结构去双真相 > 体量拆分**。
风险等级：**高** = 正常路径可触发且用户可见/影响结算；**中** = 需特定操作或异常路径；**低** = 维护性或仅停用某系统时出现。
仓库没有测试套件与 CI；标注“推断 / 未验证”的结论没有经过运行验证。

### 优先级总表

| 优先级 | 事项 | 类型 | 触发风险 | 改动量 | 依赖关系 |
|---|---|---|---|---|---|
| 1 | T1（缩范围）：修 build-panel 两处 listener teardown | 正确性缺陷 | 中（监听/引用累积；是否重复购买**不确定**） | S | 无；与 #3 同文件，先做 |
| 2 | T2（缩水）：两处过时注释 + `baseBudgetWave2` 2→3；planner 项已失效不做 | 正确性（数值/注释） | 低 | S | 无；与 T4 同文件，先做 |
| 3 | `BuildOpen` 三写者收敛为单一写入口 | 契约 | 中（面板不可用时静默无效；tag 互摘） | M | 先定义唯一 owner；与 #1 同文件 |
| 4 | `Repairing` 反向双写收敛：RepairSystem 唯一改 tag，按钮只发请求 | 契约 | 低–中（停 Repair 时按钮卡在“维修中”） | S–M | 可与 #3 共用命令模式 |
| 5 | 池 claim/release 契约：`HitFlash`/`DieBurst` 领取与释放成对 | 契约（碎片） | 低（停动画 system/异常时池静默枯竭，**推断**） | S–M | T3 若做需在其后 |
| 6 | `NextWaveCommand` 生产/消费契约：Planner(6) 与 LevelWave(5) | 契约（碎片） | 中（无尽可能静默停滞，**推断 / 未验证**） | S | 无；先于 T4 |
| 7 | `defense-pad` 去双真相：`defenseEntities` 模块数组 vs ECS | 结构 | 低–中（槽位重建/销毁不同步时读旧数据；**当前未发现实际故障**） | M–L | 先于 T3/T4 |
| 8 | T3：门卫 helper 去重 + 池认领统一 | 结构 | 低（纯重构，但跨 8 个系统） | L | 必须在 #3–#6 之后；**暂不做** |
| 9 | T4：拆分 level-wave-system | 体量 | 低（纯移动） | L | 最后；依赖 #2/#6/#7，只抽模块不新增 system |

### 原计划排序问题

- **T1 保持 #1，但范围必须缩**：实际只剩 unit 行与 dismiss 两处；ammo 行已随 0.1.307 移除，旧行号全部作废。执行前先按本文件 T1 的 2026-11-04 注记定位。
- **T2 仍在 #2，但要缩水**：`baseBudgetWave2` 与两处注释仍有效；`defenderPressure()` 一项**已失效**，由 `estimateCapacity()` 取代，保留条目只作历史记录。实际是“两项”，不是原计划的“三处”。
- **T3 从第 3 位后移到第 8 位，并降级为“暂不做”**：它要改的 8 个系统 gate 与 4 处弹池认领，正好是 #3–#6 的改动面；没有测试/CI 时先做纯重构会二次返工，也无法证明行为零变化。
- **T4 保持最后**：实际 962 行；只允许抽 `boss-assembly.ts` 与 `clearRunState`，不允许新增“节奏/胜负 system”。体量项不得排在任何正确性或契约项前面。

### 新增契约事项的插入位置

- **`BuildOpen` 三写者 → #3**：DefensePadInput（[L98-L102](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/defense-pad-input-system.ts#L98-L102)）、BuildPanel（[L286-L298](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/build-panel-system.ts#L286-L298)）、LevelWave（[L265](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/level-wave-system.ts#L265)/[L290](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/level-wave-system.ts#L290)）。
  停掉 BuildPanel 后底座仍会挂/摘 tag，但面板不出现且不报错（推断）。优先收敛为单一写入口 helper，**不要**为此新增 command system。
- **`Repairing` 反向双写 → #4**：RepairButton 增删（[L191-L193](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/repair-button-system.ts#L191-L193)）、RepairSystem 强制移除（[L47-L85](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/repair-system.ts#L47-L85)）。
  正常路径每帧读取 tag，表现自洽；风险只在 Repair 被停用/条件变化时出现，所以排在 BuildOpen 之后。
- **`defense-pad` 双真相 → #7**：`defenseEntities` 模块数组（[battle-setup.ts L195-L199](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/battle-setup.ts#L195-L199)）同时被 `DefensePadSystem`（[L38-L47](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/defense-pad-system.ts#L38-L47)）和 `BuildPanel`（[L311-L316](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/build-panel-system.ts#L311-L316)）读取。
  当前由同一批 helper 维护，**未发现实际故障**；是否迁到 ECS 组件需单独决策，改动量可能从 M 升到 L。插在契约项之后、T3/T4 之前。
- 评估另外发现两项也纳入：**池 claim/release → #5**（[shell-hit-system.ts L65-L66](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/shell-hit-system.ts#L65-L66) 与 [hit-flash-system.ts L118-L138](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/hit-flash-system.ts#L118-L138)）；**`NextWaveCommand` → #6**（[level-wave-system.ts L824-L831](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/level-wave-system.ts#L824-L831) 与 [endless-planner-system.ts L58-L65](file:///c:/Users/bruce/Documents/WebProjects/HarborDefender/src/endless-planner-system.ts#L58-L65)）。

### 明确劝退

| 看起来该做 | 为什么不该做 | 代价 |
|---|---|---|
| 拆分 `ShellHitSystem`（命中/死亡/赏金/特效） | 扣血与死亡清扫的同帧原子性是 T0-B 修复的基础；拆开后零血清扫、维修优先级会重新变成隐式顺序 | 可能回归“零血炮台复活”，需重新验证激光/死光/维修时序 |
| 为 T4 新增“波次节奏 system / 胜负 system” | 停掉任一 system 都会静默错（不胜利、不清理），正是碎裂信号 | 表面更小，实际新增 2–3 条顺序契约 |
| 把 BuildPanel 拆成独立“购买 system” | 会把 3 写者的 `BuildOpen` 变成更多 tag 传递，与 #3 的收敛目标相反 | 新增命令契约与更多“停用即静默”路径 |
| 合并 `DefensePadInput` 与 `DefensePad` | 命令层写 `RayInteractable/BuildOpen`，视图只改材质；合并会把输入门禁与呼吸动画绑死 | 破坏合理边界，无正确性收益 |
| 现在就做 T3 全量 gate 去重 | 无测试/CI，跨 8 个系统纯重构无法证明零变化；且与 #3–#6 改同一批调用点 | 高返工与回归风险 |
| 给池加常驻“自动修复 watchdog system” | 正常路径没有池耗尽证据；为异常假设新增常驻 system 属过度设计 | 每帧成本 + 新契约 |

### 建议执行批次

**批次 A：正确性（#1–#2）**
- 内容：T1 两处 listener + T2 缩水版。
- 验证：`npm run typecheck`、`npm run build`；手动连续开关建造面板 ≥10 次后购买一次，确认只扣一次钱；wave1→wave2 出兵量不再倒挂。
- 限制：无法自动证明监听器已移除，只能核对注册/移除引用一致 + 重复操作观察异常。

**批次 B：契约收敛（#3–#6）**
- 内容：`BuildOpen` 单写入口 → `Repairing` 单写者 → 池 claim/release → `NextWaveCommand` 契约。
- 验证：`typecheck`、`build`；手动走“底座开面板 → 暂停/结算/重开”“维修开/停/钱耗尽/暂停”“无尽连续 3 波”“连续击杀确认闪白与爆散仍在”。
- 限制：无法证明“停掉某 system 后不静默错”，除非临时禁用系统；不建议在正式分支做。

**批次 C：结构与体量（#7–#9）**
- 内容：`defense-pad` 去双真相 → T4 抽模块 →（可选）T3。
- 验证：`typecheck`、`build`；手动走“建炮→击毁→重建空槽”、Boss 炮塔挂载与死亡、一整局到结算。
- 限制：无 CI，无法给出回归保证；涉及可见变化时仍按部署后视觉门禁验证。若时间受限，先做 #7 与 T4，T3 继续“暂不做”。

## 合并策略

全部完成后按主题决定：T1-T4 可整段并入 main（低风险）。合并前由用户 review 每个任务的 commit。

> 2026-11-04 调整：按上面的 A/B/C 三批分别提交与合并，不再“T1-T4 整段并入”。T3 暂不进入任何批次。

