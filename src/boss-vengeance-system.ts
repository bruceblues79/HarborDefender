/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import {
  BossTurret,
  GameOver,
  GamePaused,
  GunCycle,
  LaserCycle,
  LevelDirector,
} from './components.js';
import { BOSS } from './level-config.js';

/**
 * Boss turret-loss vengeance (2026-11-24): the 怒岛号 must not soften into a
 * free win as its four gun turrets die. Every turret lost raises the
 * surviving guns' per-shot damage one step (matrix row ×
 * (1 + turretVengeanceStep × losses), stamped onto shells as
 * ShellFaction.damageMul), and once all four are gone the lone laser's
 * cooldown pause runs at laserAloneCooldownRatio of laserCooldownSec
 * (5 s → 3 s) from its next cycle.
 *
 * Single truth: this system is the ONLY writer of GunCycle.damageMul and of
 * the buffed LaserCycle.cooldownSec. The recomputed state is diffed against
 * what was last applied, so writes stay event-sized and a fresh run's fresh
 * components self-heal back to defaults. Losses are counted globally — the
 * level design fields one boss hull at a time (a lone-boss wave, no
 * escorts). Killed turrets leave the query through ShellHitSystem's
 * dispose, the same signal BossChiefSystem's phase-two trigger reads.
 */
export class BossVengeanceSystem extends createSystem({
  guns: { required: [BossTurret, GunCycle] },
  lasers: { required: [BossTurret, LaserCycle] },
  directors: { required: [LevelDirector] },
}) {
  /** Last applied loss count (-1 = nothing written yet). */
  private appliedLosses = -1;
  /** Whether the laser buff was last applied to the current components. */
  private appliedLaserBuff = false;

  update(): void {
    if (this.paused() || this.over() || !this.gameRunning()) return;
    const losses = BOSS.turretCount - this.queries.guns.entities.size;
    if (losses !== this.appliedLosses) {
      this.appliedLosses = losses;
      const mul = 1 + BOSS.turretVengeanceStep * losses;
      for (const gun of this.queries.guns.entities) {
        gun.setValue(GunCycle, 'damageMul', mul);
      }
    }
    const laserBuff = this.queries.guns.entities.size === 0;
    if (laserBuff !== this.appliedLaserBuff) {
      this.appliedLaserBuff = laserBuff;
      for (const laser of this.queries.lasers.entities) {
        laser.setValue(
          LaserCycle,
          'cooldownSec',
          BOSS.laserCooldownSec * (laserBuff ? BOSS.laserAloneCooldownRatio : 1),
        );
      }
    }
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

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True once the run has ended (victory or defeat) — the vengeance holds. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }
}
