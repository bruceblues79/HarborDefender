# 战斗数值设计

> 本目录存放设计侧文档（数值表、关卡设计等），供远程查阅与调整。
> **可执行真值在 `src/level-config.ts`**：`COMBAT` / `ENDLESS` / `ECONOMY`
> 是游戏实际读取的常量。两者必须同步修改——改表必改码，改码必改表。

## 伤害

所有单位生命统一 **100 点池**（`COMBAT.unitHealth`）；下表伤害 = 单发占
受击方最大生命池的百分比。未写的格视为 0——打不动的目标显式写 0%，
不靠缺省猜。

### pirate-to-defender（海盗 → 守方）

| atk/hurt | cannon（城防炮） | ballista(防空弩) |
|:--------:|:----------------:|:-------------:|
| ship     | 15%              | 17.5%         |
| bombardier | 10%            | 12.5%           |
| ornithopter(扑翼机) | 6%     | 8%              |
| islewrath-turret(怒岛炮塔) | 20% | 20%          |

### defender-to-pirate（守方 → 海盗）

| atk/hurt | ship（海盗船） | bombardier(投弹飞行器) | ornithopter(扑翼机) | islewrath-turret(炮塔) | islewrath-chief(海盗头领) |
|:--------:|:--------------:|:-------------------:|:--------:|:--------:|:--------:|
| cannon   | 20%            | 25%                 | 25%      | 2%       | 2%       |
| ballista | 10%            | 20%                 | 20%      | 1%       | 2%       |

Boss（怒岛号）五座炮塔均参战可击破：四门火炮塔 + 激光主炮（命中判定沿用
`islewrath-turret` 键）；船体不参战、不可被击中。

激光主炮节奏：瞄准目标 → 转向收敛后停顿 0.5s → 蓄力 2s → 激光喷射 1s（持续）
→ 攻击间隔 5s（+共用抖动）→ 循环。瞄准收敛时光束轴向冻结，停顿/蓄力/喷射
期间目标阵亡不换向。单次发射对被光柱扫中的守方单位直接造成 **单位默认最大生命值得60%**
伤害。

## 二阶段（海盗头领，任务 031 / 死光任务 03）

五座炮塔全灭后，等 0.5s（`BOSS_CHIEF.riseDelay`），激光炮位升起海盗
头领（从城垛内沉入升起，与船体相连）：血池 100 点
（`BOSS_CHIEF.health`），守方每击固定扣 2%（上表 `islewrath-chief` 列）。

升起完毕后头领开始自己的死光攻击（`DEATH_LIGHT`，ChiefDeathLightSystem
独立状态机，头部自身不转动）：

- **死光闪电**：每 3s（`intervalSec`）随机选中一名存活守方单位，从铁头
  质心（hit_core）到目标质心瞬间成形一道分段十字片闪电（每帧横向 noise
  抖动、两端钉死），扣其 **最大生命值的 75%**（`damageRatio`），闪电
  视觉停留 0.2s（`boltLifeSec`）。
- **死光扫射**：第 4 拍（升起完毕 12s）不放闪电改为扫射——头部 y 轴横摇
  瞄准墙沿一端（`aimTurnSpeedDeg` 120°/s），停顿 0.5s（`aimHoldSec`），
  无蓄力，激光 0.1s 成形（`formSec`），随后 **1s 横扫**（`sweepSec`）扫过
  全部五个防守位（随机左→右或右→左，光束贴着守方核心高度近乎水平地行走，
  不切入墙体）。
  光束走廊扫到的存活守方单位一次性扣 **最大生命值的 50%**
  （`sweepDamageRatio`，每单位每次扫射最多一次）。扫射结束后拍数清零，
  3s 后重新开始闪电节拍。

头领被击杀 → 全场敌方单位清空 → 获胜。

## 攻速（射击间隔，秒）

| 单位 | 常量 | 值 |
|---|---|---|
| 城防炮 | `COMBAT.fireInterval` | 2.5（+抖动 0.2–0.5s） |
| 海盗船 | `COMBAT.pirateFireInterval` | 3.0 |
| 投弹飞行器 | `COMBAT.bombardierFireInterval` | 2 |
| 机械扑翼机 | `COMBAT.ornithopterFireInterval` | 1.2 |
| 防空弩 | `COMBAT.ballistaFireInterval` | 1.0 |
| 怒岛号炮塔 | `BOSS.fireInterval` | 3.0（+共用抖动） |
| 怒岛号激光主炮 | `BOSS.laserChargeSec` / `laserFireSec` / `laserCooldownSec` / `laserAimHoldSec` | 蓄力 2 / 喷射 1 / 冷却 5（+共用抖动）/ 收敛后停顿 0.5 |

## 停止位（停泊 / 开火许可 z）

| 单位 | 常量 | 值 |
|---|---|---|
| 海盗船 | `SHIP_STOP_Z_MIN / SHIP_STOP_Z_MAX`（停泊带，远端..近墙端） | -6.5 .. -3.3 |
| 投弹飞行器 | `FLYER_STOP_Z_MIN / FLYER_STOP_Z_MAX` | -3.1 .. -1.73 |
| 机械扑翼机 | `ORNITHOPTER.stopZMin / stopZMax` | -4.9 .. -3.3 |
| 怒岛号 | `BOSS.targetZ`（中线定点停泊） | -5.5 |

推导：`SHIP_STOP_Z_MIN = OCEAN.centerZ = -6.5`；`SHIP_STOP_Z_MAX =
WALL_SEA_FACE_Z(-1.5) − SHIP_HALF_LENGTH(0.6) − SHIP_STOP_MARGIN(1.2) = -3.3`。

## Endless（动态难度）

无尽模式种子波（wave 1）固定为三艘海盗船；wave 2 起由
`EndlessPlannerSystem` 按 `ENDLESS` 旋钮动态生成，`endlessLevel.waves`
就是本场 run 的运行时真值。

**Boss 节奏**：每 `bossEvery`（6）波是一个 boss 波——单个 boss 从
`bossPool` 随机（当前仅怒岛号），无护卫。其余全部为预算构成波。

**预算构成**（wave 2 起）：

```
budget = (baseBudgetWave2 + (wave − 2) × budgetPerWave)
         × 压力系数 × 存款系数
```

| 旋钮 | 值 | 说明 |
|---|---|---|
| `baseBudgetWave2` / `budgetPerWave` | 2 / 0.75 | 预算基线与线性增长 |
| `pressureMin` / `pressureMax` | 0.7 / 1.15 | 存活城防账面价值在 `pressureMoneyFull`(600g) 内插值——墙越空波越轻 |
| `moneyDiv` / `moneyBonusMax` | 1600 / 0.5 | 每 1600g 存款 +12.5%，800g 封顶——存款越多波越重 |
| `maxUnitsPerWave` | 8 | 每波单位数硬上限，超预算浪费 |
| `cost` | 船 1 / 投弹 0.9 / 扑翼 0.6 | 预算购买价格，等权随机抽取买得起的 |

**经济**（`ECONOMY`）：开局 200g；击杀赏金走 `REWARD_TABLE` 档位——
普通单位 200g（`killReward`），怒岛炮塔 / 激光主炮 / 头领各 800g
（`BOSS_BOUNTY`）。修理 10 hp/s、花费 8g/s；换购折扣 0.3（存活单位按
账面价值 30% 抵扣）；书面价值加农炮 / 防空弩各 200g。

原精英（elite）轮机制已废弃并移除——特殊波只剩 boss。
