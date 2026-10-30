# Endless DDT 改造 · 修改记录

> 只记确定项。真值以 `src/level-config.ts` 为准。

## 已实施

- boss 战内赏金归零：`BOSS_BOUNTY = 0`（v0.1.264；`RewardTier` 标记保留给成就系统）。
- 停位带外推（海面层不动）：扑翼层 `ORNITHOPTER.stopZMin` -4.9 → -5.25，轰炸层 `FLYER_STOP_Z_MIN` -3.1 → -3.75（v0.1.265）。
- 分层并发与波内总数：`PACING.maxConcurrentUnits` 改按层（unitType）计数、单层 ≤ 6；`ENDLESS.maxUnitsPerWave` 8 → 18（v0.1.265）。
- 弹池：`stonePoolSize` 8 → 12，其余池不动（v0.1.265）。

## 待实测

- 飞层 6 停位需 3 列 × 2 行排布（行距压 1.5m 椭圆边界），泊位级联需实测。
