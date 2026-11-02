# DDT 再平衡迭代计划

生成时间：2026-11-02
基准：`src/endless-planner-system.ts` + `src/level-config.ts` ENDLESS / ECONOMY
分析基础：3 炮台基准、18 单位波、Boss 6 件 × 500 g、维修 1.1 g/HP

## 已确认的症状

1. 压力对 3 炮台封顶：`alive × 200 / 600` 在 3 只时 t=1，pressure=1.15；4–5 炮和 3 炮压力相同，卫士（2,500 g）在难度上"免费"。
2. 钱包 800 g 封顶：`moneyFactor = 1 + min(0.5, money / 1600)`，1.4 万钱包和 800 钱包吃同一波。
3. 18 单位硬顶：`maxUnitsPerWave=18`，每层 6，13 波后预算再高也只出 18 只；13–17 波是同一张图重复刷。
4. **只数存活数量，不看血量和购买力**：1 炮 + 10,000 g 会被当成 1 炮，发最轻的波；3 炮 + 10,000 g 也只到 1.15。Boss 刚把炮打残，下一波仍按满编算。
5. 收入结构性大于支出：5 槽 × 200 + 卫士 2,500 = 3,500 g 花完，弹药 0 g；第 1–5 波净赚 +800 ~ +1,300/波，Boss 亏 3,600 但压不住 1.4 万钱包。
6. 卫士被第 4 门炮（200 g）全面压制：2,500 g 卫士的免伤贡献 ≈ 200 g 第 4 炮输出带来的伤害减免，还不如多一门炮。

目标曲线（3 炮台基准）：

| 波段 | 目标净收益/波 |
|---|---|
| 1–5 | +800 ~ +1,300（教学 + 盈余） |
| 7–9 | +300 ~ +700 |
| 10–14 | 0 ~ +300 |
| 15–18 | -200 ~ 0（必须投资或重建才能活） |
| 4–5 炮 + 卫士 | +300 ~ +800（投资有回报，但不无脑） |

---

## P0 — 调整 DDT（`src/endless-planner-system.ts` + `src/level-config.ts` ENDLESS）

目标：**每一波都估计玩家的真实承受能力**，把"炮台 + 血量 + 钱包购买力"合成一个战力指数再发兵；Boss 是固定考试，不参与 DDT 缩放。**不动单位内容、赏金、维修价、Boss 部件、卫士参数**——先把调度逻辑调对。

### P0-A 新估算器：`estimateCapacity()`

替换 `defenderPressure()`。输入是活着的 `HitCore`（`faction='defender' && !Destroyed`）、它们的 `Health.current/max`、`Wallet.money`、空槽数。

```
// 5 槽：DEFENSE_SLOTS.length；开局 3 炮 + 2 空槽
cannonCount = 活炮台数
guardCount  = 活卫士数
emptySlots  = 5 - 已占用槽数
missingHp   = Σ (max - current) over 活炮台      // 卫士不可修，不计
repairCost  = missingHp × 1.1                     // ECONOMY 里读，不写死
repairSpend = min(money, repairCost)
hpFactor    = repairCost > 0 ? repairSpend / repairCost : 1

// 1) 当前战力（含血量）：钱够修满的炮按满血算
currentPower = Σ_cannon (current/max + (1 - current/max) × hpFactor)
             + 1.5 × Σ_guard (current/max)

// 2) 购买力转战力：空槽 + 余钱 = 还能建几门炮
moneyAfterRepair = money - repairSpend
rebuildable      = min(emptySlots, floor(moneyAfterRepair / 200))
power            = currentPower + rebuildable

// 3) 多出来的钱只算“续航”，不再单独乘 budget（避免和重建战力重复计算）
excess          = moneyAfterRepair - rebuildable × 200
sustainFactor   = 1 + min(0.5, excess / 4000)

// 4) 压力
pressure = 0.7 + 0.45 × min(2.5, power / 3)
```

示例：

| 场面 | power | pressure | 发兵结果 |
|---|---|---|---|
| 1 炮 + 0 g | 1.0 | 0.85 | 最轻波，给恢复窗口 |
| 1 炮 + 10,000 g（4 空槽） | 5.0 | 1.45 | **4 次重建 = 5 炮，按 5 炮发** |
| 3 炮 + 10,000 g（2 空槽） | 5.0 | 1.45 | 修掉原症状 1/2 |
| 3 炮 + 200 g（2 空槽） | 4.0 | 1.30 | 钱够再建 1 门 |
| 5 炮全满 + 10,000 g | 5.0 | 1.45 × sustain 1.5 | 满槽，钱只能续航 |
| 5 炮 10% 血 + 0 g | 0.5 | 0.775 | Boss 后残血，轻波 |
| 5 炮 10% 血 + 1,000 g | 5.0 | 1.45 | 110 g 修满，按 5 炮发 |

- [x] 实现 `estimateCapacity()`，返回 `{ power, pressure, sustainFactor }`。
- [x] `defenderPressure()` 删除；`pressureMoneyFull`、`moneyDiv`、`moneyBonusMax` 一并删除。
- [x] 炮台价/维修价从 `ECONOMY` 读（`unitValues.cannon`、`repairCostPerSecond / repairHpPerSecond`），不在 planner 里写死。
- [x] 卫士权重 1.5：吃伤害不输出；卫士不可修，只按当前血量计入。

### P0-B 每一波都估，Boss 固定

- [x] **Boss 波**（`waveNumber % bossEvery === 0`）：保持现有 `return { units: [boss] }`，**不乘任何 power / money / aggression**。Boss 是固定考试。
- [x] **Boss 前一波**（`waveNumber % bossEvery === bossEvery - 1`）：普通波预算额外 × `preBossEase = 0.85`，让玩家有机会修满/重建再进考场。
- [x] **Boss 后一波**：不加固定折扣。`estimateCapacity()` 会自然读到残血、阵亡空槽、钱包减少；玩家在间歇里修好/重建了，就按修好后的状态发兵。**不要 `postBossBrake`。**
- [x] 每一波（非 Boss）都重新跑 `estimateCapacity()`，不缓存上一波结果。

### P0-C 预算上限与侵略性

- [x] `maxUnitsPerWave` 18 → 36。
- [ ] 每层上限按波次放开（配置已加，组装逻辑暂未分层；Director 侧 PACING.maxConcurrentUnits 仍为每层 6，后续 P1 再改）：
  ```
  layerCap = min(12, 6 + floor((waveNumber - 5) / 3))
  ```
- [x] 加 `aggression`，只放大数量、不动伤害矩阵：
  ```
  aggression = min(2.2, 1 + max(0, waveNumber - 5) × 0.06)
  budget = max(1, base) × pressure × sustainFactor × aggression × (preBossEase 或 1)
  ```
- [x] 最终 budget 再夹一道性能上限：`min(budget, maxUnitsPerWave × 1.0)`，避免 10 万钱包把预算推到无意义的数字（单位数已经被 `maxUnitsPerWave` 卡住，夹一下只是省日志噪声）。

### P0-D ENDLESS 配置表更新 ✅（配置已写入，pressureMin/pressureMax 保留兼容旧名）

```ts
export const ENDLESS = {
  intermissionSec: 3,
  baseBudgetWave2: 2,
  budgetPerWave: 0.75,
  bossEvery: 6,
  cost: { 'pirate-ship': 1, bombardier: 0.9, ornithopter: 0.6 },
  bossPool: ['boss_islewrath'],

  maxUnitsPerWave: 36,          // 18 → 36

  // 新估算器
  powerFull: 3,                 // power=3 对应原 pressureMax
  powerRatioMax: 2.5,           // power=7.5 封顶
  guardPowerWeight: 1.5,
  sustainDiv: 4000,
  sustainMax: 0.5,
  preBossEase: 0.85,

  // 侵略性
  aggressionPerWave: 0.06,
  aggressionMax: 2.2,

  // 层上限
  layerCapStart: 6,
  layerCapStep: 1,
  layerCapStepWaves: 3,
  layerCapMax: 12,

  // 删除：pressureMoneyFull / pressureMin / pressureMax / moneyDiv / moneyBonusMax
} as const;
```

`pressureMin/pressureMax` 是否保留：建议保留为 0.7 / 1.15，`pressure = pressureMin + (pressureMax-pressureMin)×min(powerRatioMax, power/powerFull)`，这样和原配置名兼容。二选一即可。

---

## P1 — 精英 / 阵营单位（调度逻辑外，新增单位内容）

当前所有攻击者都是"炮伤 20%、5 发杀、单只伤害贡献 ≈ 95 HP"。18 单位波总伤害 1,719，3 炮吃不住；36 单位波总伤害 6,827，5 炮也能扛（波短 → 单位活不久）。**只加数量压不住 5 炮——必须让目标活得更久（降低炮伤百分比），才能同时压 3 炮和 5 炮。**

- [ ] 加一个 "elite" 攻击者类型：单位 HP 仍是 100，但在 `DAMAGE_MATRIX` 里对 cannon 是 10（10 发杀，活得久），自身 `pirate-ship->elite` DPS 提至 20 HP/s，赏金 300 g。
- [ ] 在 POOL 里按 wave / power / 余钱决定 elite 占比：
  ```
  eliteShare = clamp(0.05, 0.5, 0.04×(wave-6) + 0.05×(power-3) + excess/20000)
  ```
- [ ] 每 3 波一次"阵营波"（50% elite），独立于 Boss cadence；Boss 本身仍是固定考试。
- [ ] 新增攻击者需要：资产（GLB + 行为组件）、`DAMAGE_MATRIX` 行、`endlessLevel` 的 spawn entry、赏金 tier。这不是纯调参，单独做一个小 PR。

---

## P2 — Boss 固定参数（不参与 DDT 缩放）

Boss 是固定考试：**部件数、HP、出场波次都不随钱包/炮数缩放**。这里只调固定值。

- [ ] 看 500 g/件是否太低：当前 3 炮净亏 3,600，5 炮净亏 988；历史实测 800 g/件时 4–5 炮接近打平。可在 650–800 g/件之间选一个固定值。
- [ ] 若要保持 500 g/件，则接受"Boss 是净亏损考试"的定位，不要指望它压钱包。
- [ ] 不实现"Boss 部件 × moneyFactor"或"按钱包加炮塔"——与固定考试冲突。

---

## P3 — 卫士救场定位的数值调正

当前卫士 2,500 g / 普通弹减伤 2% / Boss 不读 Taunt。被第 4 门炮（200 g）全面压制。

两条路二选一：

- [ ] 砍价路：价格降到 600 g，普通弹减伤保持 2%。定位是"Boss 前临时买个 20 s 免伤护盾"。
- [ ] 坦化路：价格保留 2,500 g，普通弹减伤改成 0.5%/发（200 发死，18 单位波约 20 s 窗口），让它在 Boss 战里确实比第 4 门炮（200 g，只多输出、不扛伤害）有真实差异。

**Boss 索敌改读 Taunt** 不在 P3——那是玩法设计，需要先决定 Boss 是否该被嘲讽。

---

## P4 — 维修单价 + 波间歇

当前 1.1 g/HP，满修 110 g ≈ 200 g 重建的 55%。这个比例偏保守，不会让"修 vs 重建"变成无意义选择。暂不动。

- [ ] 如果 P0 改完后后期"3 炮一直满修、完全不用重建"，再考虑把维修价提到 1.4 g/HP（满修 140 g），**不超过 1.6 g/HP**（满修 160 g = 重建的 80%，否则重建总比修划算）。
- [ ] Endless 波间歇固定 3 s，不暂停。Boss 前的喘息由 `preBossEase` 和玩家自己的修复/重建负责；Boss 后的喘息由 `estimateCapacity()` 的残血/空槽/钱包读数负责，**不再加固定刹车**。

---

## P5 — 收入上限的长期解法

现在最多只能花约 3,500 g（5 槽 + 卫士），弹药 0 g；钱包结构性膨胀。

- [ ] P1 精英单位（赏金 300 / cost 1.3）会在波次里多花钱、多奖励，部分缓解膨胀，但只是转移。
- [ ] 真正解法是给玩家**花钱的地方**：弹药付费（`AMMO_DEFS.costPerShot > 0`）、炮台升级、卫士价格调正后让人愿意买。这些属于玩法扩展，记在这里但不排进 P0。
