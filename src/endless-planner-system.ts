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
  HitCore,
  LevelDirector,
  NextWaveCommand,
  Wallet,
} from './components.js';
import { ENDLESS, ECONOMY, endlessLevel } from './level-config.js';
import type { WaveSpec } from './level-config.js';

/** Purchase pool: unitType -> budget cost, as entries for random picks. */
const POOL: [string, number][] = Object.entries(ENDLESS.cost);

/**
 * Endless dynamic-difficulty planner (DDT 发兵系统).
 *
 * Single job: when the director raises a `NextWaveCommand`, sample the
 * player's live state — surviving battery and wallet — and append one
 * generated WaveSpec to endlessLevel.waves. The command is consumed in the
 * same frame (synchronous qualify), so the wave is always ready before the
 * intermission's shortest window ends and LevelWaveSystem's enterWave reads
 * it. No behaviour of its own beyond the plan: spawning stays inside
 * LevelWaveSystem's shared pipeline.
 *
 * Composition (all knobs in ENDLESS):
 * - every `specialEvery` waves the wave is special — `waveNumber/specialEvery`
 *   odd sends ONE lone elite (`elite:<unitType>`, centre line, no escorts),
 *   even sends ONE lone boss rolled from `bossPool` — no escort;
 * - otherwise a budget buys units from the `cost` pool (equal-weight picks
 *   among what remains affordable): budget = base growth × defender
 *   pressure × money grind. A richer wall and a fatter wallet both draw a
 *   heavier wave — 消磨玩家金币;
 * - the lone elite is a bigger, double-health variant whose shells carry
 *   the elite flag (boosted damage). The stock unit's matrix rows apply
 *   everywhere — difficulty rides composition + coefficients.
 */
export class EndlessPlannerSystem extends createSystem({
  /** Exclusive command query: a runtime-mounted tag needs its own query —
   *  qualify only fires for entities entering THIS query (elics 陷阱). */
  commands: { required: [LevelDirector, EndlessMode, NextWaveCommand] },
  cores: { required: [HitCore] },
}) {
  init(): void {
    this.queries.commands.subscribe('qualify', (director) =>
      this.planNextWave(director),
    );
  }

  /** Consume the command: append the next wave to the endless list. */
  private planNextWave(director: Entity): void {
    // Wave numbers are 1-based: the seed wave (index 0) is wave 1.
    const waveNumber = endlessLevel.waves.length + 1;
    const wave = this.composeWave(waveNumber, director);
    console.info(`[ddt] wave ${waveNumber}: ${wave.units.join(', ')}`);
    endlessLevel.waves.push(wave);
    director.removeComponent(NextWaveCommand);
  }

  /** Build the WaveSpec for the given 1-based wave number. */
  private composeWave(waveNumber: number, director: Entity): WaveSpec {
    // Special cadence: every `specialEvery` waves the wave IS special —
    // waveNumber/4 odd sends ONE lone elite down the centre line, even sends
    // ONE lone boss — both stand alone, no escort composition.
    if (waveNumber % ENDLESS.specialEvery === 0) {
      const cadence = waveNumber / ENDLESS.specialEvery;
      // Elite beat (单数): one pooled unit, scaled by `eliteScale`, no escorts
      // — 单独精英 (matches the boss beat).
      if (cadence % 2 === 1) {
        const [type] =
          POOL[Math.floor(Math.random() * POOL.length)];
        return { units: [ENDLESS.elitePrefix + type] };
      }
      // Boss beat (双数): one lone boss rolled from the pool.
      const boss =
        ENDLESS.bossPool[Math.floor(Math.random() * ENDLESS.bossPool.length)];
      return { units: [boss] };
    }

    // Budget: linear growth, scaled up by how strong the defence looks.
    const base =
      ENDLESS.baseBudgetWave2 + (waveNumber - 2) * ENDLESS.budgetPerWave;
    const money = Number(director.getValue(Wallet, 'money'));
    const moneyFactor = 1 + Math.min(ENDLESS.moneyBonusMax, money / ENDLESS.moneyDiv);
    let budget = Math.max(1, base) * this.defenderPressure() * moneyFactor;

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
   * Defender pressure multiplier: the surviving battery's book value (every
   * unit shares the 200 g value) interpolated between pressureMin (empty
   * wall) and pressureMax (battery at pressureMoneyFull). Destroyed cannons
   * are skipped — a crumbling defence draws a lighter wave.
   */
  private defenderPressure(): number {
    let alive = 0;
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (core.hasComponent(Destroyed)) continue;
      alive += 1;
    }
    const value = alive * ECONOMY.killReward;
    const t = Math.min(1, value / ENDLESS.pressureMoneyFull);
    return ENDLESS.pressureMin + (ENDLESS.pressureMax - ENDLESS.pressureMin) * t;
  }
}
