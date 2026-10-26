/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import {
  BallisticFlight,
  BoltTag,
  BossSummon,
  BossTurret,
  Destroyed,
  GameOver,
  GamePaused,
  HitCore,
  LevelDirector,
  ShellFaction,
  ShellTag,
  ShipMovement,
  StoneTag,
  UnitTag,
} from './components.js';
import { BOSS, COMBAT } from './level-config.js';
import { solveIntercept } from './shell-launch.js';

/**
 * The Islewrath's four cannon turrets. Deliberately unlike PirateFireSystem's
 * persistent lock: EVERY shot re-rolls a random surviving defender core —
 * the same gun may hammer one cannon for rounds on end or flip between
 * targets every shot, purely by chance ("颇具随机性"). Firing opens only
 * once the hull has parked at its centre-line berth (ShipMovement state
 * 'stopped'), the shots are the shared guaranteed-hit intercept, and the
 * shell is stamped `islewrath-turret` so DAMAGE_MATRIX's 20% rows apply.
 *
 * Aim: each pivot yaws independently around its own seat axis — the world
 * yaw is computed pivot -> target and converted into the hull's local frame
 * by subtracting the hull's world yaw, exactly like PirateFireSystem's
 * cannon_mount math (reference = the pivot, not the hull origin).
 */
export class BossTurretSystem extends createSystem({
  turrets: { required: [BossTurret] },
  bosses: { required: [UnitTag, ShipMovement, BossSummon] },
  cores: { required: [HitCore], excluded: [Destroyed] },
  freeShells: {
    required: [ShellTag],
    excluded: [BallisticFlight, BoltTag, StoneTag],
  },
  directors: { required: [LevelDirector] },
}) {
  /** Muzzle node per turret entity index, resolved once on qualify. */
  private readonly muzzles = new Map<number, Object3D>();
  /** Defender hit_core nodes per core entity index, resolved once on qualify. */
  private readonly coreNodes = new Map<number, Object3D>();
  /** Shells handed out this frame; the free-shell query refreshes next frame. */
  private readonly claimed = new Set<number>();
  private readonly muzzlePos = new Vector3();
  private readonly pivotPos = new Vector3();
  private readonly corePos = new Vector3();
  /** Velocity scratch for the shared intercept solver. */
  private readonly intercept = { vx: 0, vy: 0, vz: 0 };

  init(): void {
    this.queries.turrets.subscribe('qualify', (turret) => {
      const muzzle = turret.object3D?.getObjectByName('muzzle');
      if (muzzle) this.muzzles.set(turret.index, muzzle);
      // First volley fires the moment the hull parks; 0 here costs nothing.
      turret.setValue(BossTurret, 'cooldown', 0);
    });
    this.queries.cores.subscribe('qualify', (core) => {
      if (core.getValue(HitCore, 'faction') !== 'defender') return;
      const node = core.object3D?.getObjectByName('hit_core');
      if (node) this.coreNodes.set(core.index, node);
    });
  }

  update(delta: number): void {
    if (this.paused() || this.over() || !this.gameRunning()) return;
    const boss = this.firstBoss();
    const bossObject = boss?.object3D;
    // The whole battery opens up only from the parked berth.
    if (!boss || !bossObject) return;
    if (String(boss.getValue(ShipMovement, 'state')) !== 'stopped') return;

    this.claimed.clear();
    for (const turret of this.queries.turrets.entities) {
      const pivot = turret.object3D;
      const muzzle = this.muzzles.get(turret.index);
      if (!pivot || !muzzle) continue;
      let cooldown = Number(turret.getValue(BossTurret, 'cooldown')) - delta;
      if (cooldown <= 0) {
        // Pool empty: retry shortly instead of banking negative time.
        cooldown = this.fire(turret, pivot, muzzle, bossObject)
          ? this.rollInterval(turret)
          : 0.1;
      }
      turret.setValue(BossTurret, 'cooldown', cooldown);
    }
  }

  /**
   * Roll a fresh random defender core, swing the turret onto it and launch
   * one shell. No lock is stored: the next shot rolls again.
   */
  private fire(
    turret: Entity,
    pivot: Object3D,
    muzzle: Object3D,
    bossObject: Object3D,
  ): boolean {
    const core = this.randomDefenderCore();
    if (!core) return false;
    const node = this.coreNodes.get(core.index);
    if (!node) return false;
    node.getWorldPosition(this.corePos);

    // Yaw this pivot onto the target in the hull's local frame.
    pivot.getWorldPosition(this.pivotPos);
    const worldYaw = Math.atan2(
      -(this.corePos.x - this.pivotPos.x),
      -(this.corePos.z - this.pivotPos.z),
    );
    pivot.rotation.y = worldYaw - bossObject.rotation.y;

    // Launch from the (freshly swung) muzzle.
    const shell = this.firstFreeShell();
    const shellObject = shell?.object3D;
    if (!shell || !shellObject) return false;
    muzzle.getWorldPosition(this.muzzlePos);
    const tau = solveIntercept(
      this.muzzlePos,
      this.corePos.x,
      this.corePos.y,
      this.corePos.z,
      COMBAT.pirateShellSpeed,
      COMBAT.gravity,
      this.intercept,
    );
    if (tau < 0) return false;
    shellObject.position.copy(this.muzzlePos);
    shellObject.visible = true;
    shell.addComponent(BallisticFlight, {
      vx: this.intercept.vx,
      vy: this.intercept.vy,
      vz: this.intercept.vz,
    });
    shell.addComponent(ShellFaction, {
      faction: 'attacker',
      unitType: BOSS.turretUnitType,
    });
    return true;
  }

  /**
   * One uniformly random live defender core — two passes over the query
   * (count, then pick) keep the roll allocation-free. Runs per shot only.
   */
  private randomDefenderCore(): Entity | undefined {
    let defenderCount = 0;
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') === 'defender') defenderCount += 1;
    }
    if (defenderCount === 0) return undefined;
    let pick = Math.floor(Math.random() * defenderCount);
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (pick > 0) {
        pick -= 1;
        continue;
      }
      return core;
    }
    return undefined;
  }

  /** Every cooldown is a fresh roll: the turret's interval plus the shared jitter. */
  private rollInterval(turret: Entity): number {
    return (
      Number(turret.getValue(BossTurret, 'interval')) +
      COMBAT.fireJitterMin +
      Math.random() * (COMBAT.fireJitterMax - COMBAT.fireJitterMin)
    );
  }

  /** The single boss hull in the fight (queries are Sets — no [0] indexing). */
  private firstBoss(): Entity | undefined {
    return this.queries.bosses.entities.values().next().value;
  }

  /** First pooled shell neither airborne nor already claimed this frame. */
  private firstFreeShell(): Entity | undefined {
    for (const shell of this.queries.freeShells.entities) {
      if (this.claimed.has(shell.index)) continue;
      // Live guard: the other fire systems may have claimed it earlier this frame.
      if (shell.hasComponent(BallisticFlight)) continue;
      this.claimed.add(shell.index);
      return shell;
    }
    return undefined;
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** True once the run has ended (victory or defeat) — the battery holds. */
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
