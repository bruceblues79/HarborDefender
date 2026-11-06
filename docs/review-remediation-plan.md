# 审阅整改计划

分支 `feature/unit-undead`。2026-11-06 按代码重排。

顺序：明确 bug → ECS 不合理 → 体量拆分。数值平衡已移出，另走玩法迭代。

## 纪律

- 一个任务一次会话，完成即停，review 后单独 commit。
- 收尾必跑 `npm run --if-present typecheck` → `npm run build`。
- 不做浏览器/视觉验证；可见变化列出核对点交用户。
- 只做清单内的事。
- 行号会漂移，按符号名定位。

## 清单

| # | 事项 | 类型 | 风险 | 量 |
|---|---|---|---|---|
| 1 | B1 build-panel listener teardown | bug | 中 | S |
| 2 | E1 `BuildOpen` 三写者 | ECS 契约 | 中 | M |
| 3 | E2 `Repairing` 三写者 | ECS 契约 | 低–中 | S–M |
| 4 | E3 血条 / 维修按钮私有节点耦合 | ECS 结构 | 中（推断） | S |
| 5 | E4 门禁 helper 复制 | ECS 重复 | 低 | L |
| 6 | E5 池 claim/release | ECS 契约 | 低（推断） | S–M |
| 7 | E6 `defenseEntities` 双真相 | ECS 结构 | 低–中 | M–L |
| 8 | E7 PropellerSpin / WingFlap 同形 | ECS 粒度 | 无 | S |
| 9 | V1 拆 level-wave | 体量 | 低 | L |
| — | H1 两处 combat.md 注释 | 注释 | 无 | XS |

依赖：B1 与 E1 同文件，B1 先；E4 必须在 E1–E3、E5、E6 之后；V1 最后。

## 任务

### B1 build-panel listener teardown

**问题**：`removeEventListener` 收到的是新建箭头函数，移不掉，面板每重载一次多挂一组监听。

**改法**：两处（单位行、dismiss）先落地具名函数或字段引用，注册与清理共用同一个。

**注意**：`camera-orbit-system`、`menu-system` 的写法是对的，别顺手动。

**验证**：typecheck + build；连续开关面板 ≥10 次后购买一次，确认只扣一次钱。

### E1 `BuildOpen` 三写者

**问题**：pad input 管 toggle/switch，build panel 管收起与重定位，level-wave 管开局清理；build panel 头注释却写着唯一写者。

**改法**：定一个 owner（建议 build panel），另两处改走同一入口，顺带把注释改成事实。

**注意**：remove+add 同帧触发 disqualify→qualify 是刻意设计，顺序别动。

**验证**：typecheck + build；走“开面板 → 换槽 → 收起 → 暂停 → 结算 → 重开”。

### E2 `Repairing` 三写者

**问题**：按钮直接增删 tag，repair system 在满血/阵亡/钱尽时剥离，battle-setup 在开重局时清。

**改法**：repair system 做唯一写者，按钮只上报“这帧按了这台炮”。

**注意**：暂停时 tag 存活、恢复后继续扣钱，是刻意语义，别改成暂停即摘。

**验证**：typecheck + build；走“维修开 / 停 / 钱耗尽 / 暂停 / 重开”。

### E3 血条 / 维修按钮私有节点耦合

**问题**：按钮靠 `HEALTH_BAR_RIG_NAME` 字符串在单位子树里找血条，并把 `rig.visible` 当可见性真值。血条改结构或改可见规则，按钮会静默错位。

**改法**：优先把可见位与左缘锚点做成组件字段，血条系统写、按钮读。合并两个系统只在统一视图层时才考虑。

**注意**：按钮必须是根级独立实体，不能嵌进单位射线子树，否则按按钮会误触开火。

**验证**：typecheck + build；核对按钮位置、显隐时机、命中盒不挡炮台。

### E4 门禁 helper 复制

**问题**：`paused()` / `over()` / `gameRunning()` 在 23 个文件里逐字复制 45 份，改语义要改 23 处。

**改法**：抽 `src/system-gates.ts`，纯函数操作 `queries.directors`，不做基类不做单例。先迁 2 个系统验证形状，再铺开。

**注意**：必须排在 E1–E3、E5、E6 之后——它们改的是同一批调用点，先做会二次返工。`repair-system` 的写法不同，保持语义再迁。

**验证**：typecheck + build；逐文件 diff 只允许调用替换。

### E5 池 claim/release

**问题**：弹池认领有两套写法——cannon-fire / pirate-fire 用 `claimed` Set 加实时 `hasComponent` 双守卫，gun-cycle 只有 `hasComponent`。特效池的认领在命中系统、归还在两个动画系统。

**改法**：抽一套 `claimFree` / `release`，三处开火系统统一走它；特效池把“谁认领谁归还”写进两个动画系统的头注释。

**注意**：同帧不重复发弹依赖“`addComponent` 同步生效、`hasComponent` 立刻为真”这个隐含条件。以后加第四个开火系统必须走同一入口，不能自己写查询。

**验证**：typecheck + build；连续开火确认无重复命中、池耗尽后能恢复。

### E6 `defenseEntities` 双真相

**问题**：槽位注册表是模块级数组，与 ECS 实体并存。增删都过同一批 helper，当前没发现故障，风险在两者生命周期不同步。

**改法**：先把数组收成模块私有，只暴露 `getDefenseSlotInfo` / `setDefenseSlot` / `clearDefenseSlot`。

**注意**：迁到 ECS 组件改动量可能从 M 升到 L，单独立项，不在本任务里顺手做。

**验证**：typecheck + build；走“建炮 → 击毁 → 重建空槽”。

### E7 PropellerSpin / WingFlap 同形

**问题**：两个系统同优先级、同 `qualify` 缓存节点、同 `paused/over` 门禁、同 `speed * delta`，差异只有组件名和节点名。

**改法**：可选。合并成一个按组件分流，两分支各留原式。

**注意**：收益弱，不做不算缺陷；只建议在 E4 之后顺带做。

**验证**：typecheck + build；看旋翼与扑翼是否仍与暂停同步冻结。

### V1 拆 level-wave

**问题**：962 行，`attachBossTurrets` 与三个入口的标签清扫是主要可抽部分。

**改法**：`attachBossTurrets` + chief mount 捕获移到 `src/boss-assembly.ts`；三个入口的标签清扫收敛成私有 `clearRunState(opts)`。

**注意**：只抽文件，不新增 system——拆出节奏/胜负 system 会引入静默顺序错误。不改 spawn 语义、不改 `disposeResources: false`、不改 GameOver 先于 tag 的顺序。

**验证**：typecheck + build；走 Boss 炮塔挂载与死亡、一整局到结算。

### H1 两处 combat.md 注释

`docs/design/combat.md` 已移除，`level-config.ts` 两处引用仍指向它。纯删。

## 已完成

- **T0-A**：弹道阻力分支改用与预览同源的精确位移积分，复用同一个 `decay`。
- **T0-B**：`RepairSystem` 优先级 12 → 15，移到死亡清扫之后，修掉零血炮台复活。

## 劝退

| 看起来该做 | 一句话原因 |
|---|---|
| 拆 `ShellHitSystem` | 扣血与死亡清扫的同帧原子性是 T0-B 的地基 |
| 为 V1 新增节奏/胜负 system | 停掉任一个就静默错，正是碎裂信号 |
| 把 build panel 拆成购买 system | 与 E1 的单写者目标相反 |
| 合并 `DefensePadInput` / `DefensePad` | 会把输入门禁与呼吸动画绑死 |
| 合并 `HitFlash` / `DieBurst` | 只共享 `expired/retiring` 骨架，步进完全不同 |
| 合并 `LaserFx` / `ChiefDeathLightFx` | 镜像不同状态组件，会变成按状态分叉的巨型 update |
| 合并 `HealthBar` / `RepairButton` | 按钮必须是根级实体以隔离射线；E3 只收敛数据通道 |
| 把 `FreeLockTarget` 并进 `GunCycle` | 索敌无时钟、开火有时钟，合并会把重掷变成隐式顺序 |

## 批次

- **A 正确性**：B1。
- **B ECS 契约**：E1 → E2 → E3。
- **C ECS 重复与双真相**：E4 → E5 → E6 →（可选）E7。
- **D 体量与注释**：V1、H1。

## 移出本计划

| 原条目 | 理由 |
|---|---|
| `baseBudgetWave2` 2→3、wave2 预算推演 | 玩法/节奏迭代，不是缺陷 |
| planner 账面价值 | 已被 `estimateCapacity()` 取代，本就失效 |

数值走独立分支，不与本计划混在同一个 commit。
