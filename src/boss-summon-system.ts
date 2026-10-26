/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  BossMinion,
  BossSummon,
  BossVulnerable,
  GameOver,
  GamePaused,
  KamikazeDive,
  LevelDirector,
  PirateCannon,
  ShipMovement,
  UnitTag,
} from './components.js';
import { BOSS } from './level-config.js';
import { LevelWaveSystem } from './level-wave-system.js';

/**
 * The Islewrath's summon cycle. While the hull sits parked at its berth, a
 * timer counts down one `summonIntervalSec` cycle; at zero, 2-3 ornithopters
 * enter through the normal spawn pipeline (far-edge best-candidate, full
 * combat kit) and are tagged BossMinion — they fight as ordinary flappers.
 *
 * Sacrifice order: `sacrificeLeadSec` before the next summon, if the previous
 * wave is still in the air, every live minion gets a KamikazeDive order (a
 * fresh random defender core each) and its PirateCannon is stripped — the
 * dive owns their motion from that frame on (ShipMovementSystem excludes
 * dive carriers). They deliver 40% of a victim's MAX pool and die; the next
 * summon then repopulates the flight.
 *
 * Once the hull is exposed (BossVulnerable tag from BossRigSystem) the cycle
 * shortens by 25% — read as a tag each cycle, never stored, so the phase
 * switch takes effect on the very next summon with no extra state.
 *
 * Spawn ownership stays single-truthed: summons call the public
 * spawnUnitByType on LevelWaveSystem (the same cross-system hand the pause
 * menu uses for restart/reset), deliberately bypassing the wave dispatch's
 * concurrency pacing — the boss reinforces regardless of the water level.
 */
export class BossSummonSystem extends createSystem({
  bosses: { required: [UnitTag, ShipMovement, BossSummon] },
  minions: { required: [UnitTag, ShipMovement, BossMinion] },
  directors: { required: [LevelDirector] },
}) {
  /** Lazy hand to the spawn truth; resolved on first use. */
  private waveSystem: LevelWaveSystem | null = null;

  update(delta: number): void {
    if (this.paused() || this.over() || !this.gameRunning()) return;
    const boss = this.queries.bosses.entities.values().next().value;
    const bossObject = boss?.object3D;
    // Summons launch from the parked berth only.
    if (!boss || !bossObject) return;
    if (String(boss.getValue(ShipMovement, 'state')) !== 'stopped') return;

    let timer = Number(boss.getValue(BossSummon, 'timer')) - delta;
    if (
      !Boolean(boss.getValue(BossSummon, 'sacrificeArmed')) &&
      timer > 0 &&
      timer <= BOSS.sacrificeLeadSec
    ) {
      // The sacrifice window opens: dive order out, guns stripped.
      boss.setValue(BossSummon, 'sacrificeArmed', true);
      for (const minion of this.queries.minions.entities) {
        minion.addComponent(KamikazeDive);
        minion.removeComponent(PirateCannon);
      }
    }
    if (timer <= 0) {
      const summoned = this.summon(boss);
      if (!summoned) return; // prototype still loading — retry next frame
      timer =
        Number(boss.getValue(BossSummon, 'interval')) *
        (boss.hasComponent(BossVulnerable) ? BOSS.exposedIntervalScale : 1);
      boss.setValue(BossSummon, 'sacrificeArmed', false);
    }
    boss.setValue(BossSummon, 'timer', timer);
  }

  /**
   * Put one wave of flappers in the air through the shared spawn truth. True
   * when the full wave is up; false mid-load (caller retries whole wave).
   */
  private summon(boss: Entity): boolean {
    if (!this.waveSystem) {
      this.waveSystem =
        this.world
          .getSystems()
          .find((system): system is LevelWaveSystem =>
            system instanceof LevelWaveSystem,
          ) ?? null;
    }
    if (!this.waveSystem) return false;
    const count =
      BOSS.summonCountMin +
      Math.floor(
        Math.random() * (BOSS.summonCountMax + 1 - BOSS.summonCountMin),
      );
    // Emergence lanes across the far edge — a same-frame brood fans out
    // instead of materialising stacked on the centre line.
    const lanes = [0, -0.6, 0.6];
    for (let i = 0; i < count; i++) {
      const minion = this.waveSystem.spawnUnitByType(
        'ornithopter',
        lanes[i % lanes.length],
      );
      if (!minion) return false;
      minion.addComponent(BossMinion);
    }
    return true;
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True once the run has ended — no more summons. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }

  /** True once the START hand-off has moved the director past waiting-start. */
  private gameRunning(): boolean {
    for (const director of this.queries.directors.entities) {
      return (
        String(director.getValue(LevelDirector, 'phase')) !== 'waiting-start'
      );
    }
    return false;
  }
}
