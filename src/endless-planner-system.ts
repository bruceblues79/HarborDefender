/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  Destroyed,
  EndlessMode,
  Health,
  HitCore,
  LevelDirector,
  NextWaveCommand,
  Wallet,
} from './components.js';
import { DEFENSE_SLOTS, ENDLESS, ECONOMY, endlessLevel } from './level-config.js';
import type { WaveSpec } from './level-config.js';

const POOL: [string, number][] = Object.entries(ENDLESS.cost);

/**
 * Endless planner: consumes `NextWaveCommand` synchronously, appending one
 * WaveSpec before same-frame readers run. All knobs live in ENDLESS.
 */
export class EndlessPlannerSystem extends createSystem({
  /** Command query must be its own: qualify only fires for entities entering THIS query (elics). */
  commands: { required: [LevelDirector, EndlessMode, NextWaveCommand] },
  cores: { required: [HitCore] },
}) {
  init(): void {
    this.queries.commands.subscribe('qualify', (director) =>
      this.planNextWave(director),
    );
  }

  private planNextWave(director: Entity): void {
    // Wave numbers are 1-based: the seed wave (index 0) is wave 1.
    const waveNumber = endlessLevel.waves.length + 1;
    const wave = this.composeWave(waveNumber, director);
    console.info(`[ddt] wave ${waveNumber}: ${wave.units.join(', ')}`);
    endlessLevel.waves.push(wave);
    director.removeComponent(NextWaveCommand);
  }

  private composeWave(waveNumber: number, director: Entity): WaveSpec {
    // Every bossEvery waves is a boss wave: fixed composition, no multipliers.
    if (waveNumber % ENDLESS.bossEvery === 0) {
      const boss =
        ENDLESS.bossPool[Math.floor(Math.random() * ENDLESS.bossPool.length)];
      return { units: [boss] };
    }

    const money = Number(director.getValue(Wallet, 'money'));
    const { power, pressure, sustainFactor } = this.estimateCapacity(money);

    const base = Math.max(1,
      ENDLESS.baseBudgetWave2 + (waveNumber - 2) * ENDLESS.budgetPerWave,
    );
    const aggression = Math.min(
      ENDLESS.aggressionMax,
      1 + Math.max(0, waveNumber - 5) * ENDLESS.aggressionPerWave,
    );
    const isPreBoss = (waveNumber + 1) % ENDLESS.bossEvery === 0;

    let budget = base * pressure * sustainFactor * aggression;
    if (isPreBoss) budget *= ENDLESS.preBossEase;
    // 性能上限：maxUnitsPerWave 的 1.0 倍即预算够出 36 只最便宜单位就封顶
    budget = Math.min(budget, ENDLESS.maxUnitsPerWave);

    console.info(
      `[ddt] wave ${waveNumber}: power=${power.toFixed(2)} pressure=${pressure.toFixed(3)} sustain=${sustainFactor.toFixed(3)} aggro=${aggression.toFixed(2)}${isPreBoss ? ' preBoss' : ''} budget=${budget.toFixed(2)}`,
    );

    const units: string[] = [];
    while (units.length < ENDLESS.maxUnitsPerWave) {
      const affordable = POOL.filter(([, cost]) => cost <= budget);
      if (affordable.length === 0) break;
      const [type, cost] =
        affordable[Math.floor(Math.random() * affordable.length)];
      units.push(type);
      budget -= cost;
    }
    return { units };
  }

  /**
   * 每波重估玩家承受力：炮台血量 + 可修部分 + 卫士权重 + 空槽重建力；剩余钱只进 sustainFactor。
   */
  private estimateCapacity(money: number): {
    power: number;
    pressure: number;
    sustainFactor: number;
  } {
    let cannonCurrentSum = 0;
    let cannonMaxSum = 0;
    let cannonCount = 0;
    let guardHpSum = 0;
    let guardCount = 0;

    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (core.hasComponent(Destroyed)) continue;

      const unitType = core.getValue(HitCore, 'unitType');
      const current = Number(core.getValue(Health, 'current'));
      const max = Number(core.getValue(Health, 'max'));

      if (unitType === 'iron-guard') {
        guardCount++;
        guardHpSum += current / max;
      } else {
        // 炮台（包括未来的新防御单位，都按 cannon 处理）
        cannonCount++;
        cannonCurrentSum += current;
        cannonMaxSum += max;
      }
    }

    const totalSlots = DEFENSE_SLOTS.length;
    const emptySlots = totalSlots - (cannonCount + guardCount);

    // 修理成本（只算炮台，卫士不可修）
    const repairCostPerHp =
      ECONOMY.repairCostPerSecond / ECONOMY.repairHpPerSecond;
    const missingHp = cannonMaxSum - cannonCurrentSum;
    const repairCost = missingHp * repairCostPerHp;
    const repairSpend = Math.min(money, repairCost);
    const hpFactor = repairCost > 0 ? repairSpend / repairCost : 1;

    // currentPower：炮台按当前血量 + 可修部分补满；卫士按 1.5×当前血量（不可修）
    const cannonHpRatioCurrent = cannonMaxSum > 0 ? cannonCurrentSum / cannonMaxSum : 0;
    const currentPower =
      cannonCount * (cannonHpRatioCurrent + (1 - cannonHpRatioCurrent) * hpFactor) +
      ENDLESS.guardPowerWeight * guardHpSum;

    const moneyAfterRepair = money - repairSpend;
    const rebuildCost = ECONOMY.unitValues.cannon;
    const rebuildable = Math.min(emptySlots, Math.floor(moneyAfterRepair / rebuildCost));
    const power = currentPower + rebuildable;

    // 多出来的钱 = 续航，不再进 power
    const excess = moneyAfterRepair - rebuildable * rebuildCost;
    const sustainFactor = 1 + Math.min(ENDLESS.sustainMax, excess / ENDLESS.sustainDiv);

    const ratio = Math.min(ENDLESS.powerRatioMax, power / ENDLESS.powerFull);
    const pressure =
      ENDLESS.pressureMin + (ENDLESS.pressureMax - ENDLESS.pressureMin) * ratio;

    return { power, pressure, sustainFactor };
  }
}
