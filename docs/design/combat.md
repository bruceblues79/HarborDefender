# 战斗数值设计

> 本目录存放设计侧文档（数值表、关卡设计等），供远程查阅与调整。
> **可执行真值在 `src/level-config.ts`**：`COMBAT` 是游戏实际读取的常量。
> 两者必须同步修改——改表必改码，改码必改表。

## 伤害

所有单位生命统一 **100 点池**（`COMBAT.unitHealth`）；下表伤害 = 单发占
受击方最大生命池的百分比。未写的格视为 0——打不动的目标显式写 0%，
不靠缺省猜。

### pirate-to-defender（海盗 → 守方）

| atk/hurt | cannon（城防炮） | ballista(防空弩) |
|:--------:|:----------------:|:-------------:|
| ship     | 15%              | 17.5%         |
| bombardier | 10%            | 12.5%           |
| ornithopter(扑翼机) | 7.5%   | 10%             |
| islewrath-turret(怒岛炮塔) | 20% | 20%          |

### defender-to-pirate（守方 → 海盗）

| atk/hurt | ship（海盗船） | bombardier(投弹飞行器) | ornithopter(扑翼机) | islewrath-turret(炮塔) |
|:--------:|:--------------:|:-------------------:|:--------:|:--------:|
| cannon   | 20%            | 25%                 | 25%      | **6%**   |
| ballista | 10%            | 20%                 | 20%      | 3%       |

Boss（怒岛号）只有四门火炮塔参战可击破；船体与激光塔不参战、不可被击中。

## 攻速（射击间隔，秒）

| 单位 | 常量 | 值 |
|---|---|---|
| 城防炮 | `COMBAT.fireInterval` | 2.5（+抖动 0.2–0.5s） |
| 海盗船 | `COMBAT.pirateFireInterval` | 3.0 |
| 投弹飞行器 | `COMBAT.bombardierFireInterval` | 2 |
| 机械扑翼机 | `COMBAT.ornithopterFireInterval` | 1.2 |
| 防空弩 | `COMBAT.ballistaFireInterval` | 1.5 |
| 怒岛号炮塔 | `BOSS.fireInterval` | 3.0（+共用抖动） |

## 停止位（停泊 / 开火许可 z）

| 单位 | 常量 | 值 |
|---|---|---|
| 海盗船 | `UnitTypeDef.stopZMin`（停泊带远端） | -1.75 |
| 投弹飞行器 | `UnitTypeDef.stopZMin` | -2.6 |
| 机械扑翼机 | `UnitTypeDef.stopZMin` | -4.4 |
| 怒岛号 | `BOSS.targetZ`（中线定点停泊） | -5 |
