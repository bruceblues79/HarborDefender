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
  Destroyed,
  GameOver,
  GamePaused,
  HitCore,
  LevelDirector,
  PirateCannon,
  ShellFaction,
  ShellTag,
  ShipMovement,
  UnitTag,
} from './components.js';
import { COMBAT, SHIP_STOP_Z_MIN } from './level-config.js';

/**
 * Pirate-ship fire. Firing permission is a positional fact owned by this
 * attack ability, deliberately separate from ShipMovement's termination:
 * the moment a ship crosses the outermost (seaward) berthing line
 * SHIP_STOP_Z_MIN, it may shoot — it does not need to have stopped yet.
 * Once in range and the battle has started it:
 *
 * 1. picks one random defender hit core (a city cannon) and snapshots its
 *    world position as the target — city cannons never move; a locked target
 *    that gets knocked out is re-acquired the same way on the next frame, and
 *    with no survivor the ship holds fire until the defeat outcome lands;
 * 2. yaws the whole deck gun — carriage plus barrel on one cannon_mount
 *    pivot — onto the target, never the hull: the ship keeps its travel
 *    heading while its gun tracks the target;
 * 3. the first shot leaves immediately when permission is granted (cooldown
 *    starts at 0); later shots follow a jittered cooldown.
 *
 * Every shot is a mathematically guaranteed hit: horizontal velocity is
 * distance / flight time and vertical velocity is solved against
 * BallisticSystem's gravity, so at t = flightTime the shell is exactly at
 * the target core. The arc stays flat because the horizontal speed is high
 * (COMBAT.pirateShellSpeed); no second flight model exists.
 */
export class PirateFireSystem extends createSystem({
  ships: { required: [UnitTag, ShipMovement, PirateCannon] },
  cores: { required: [HitCore], excluded: [Destroyed] },
  freeShells: { required: [ShellTag], excluded: [BallisticFlight] },
  directors: { required: [LevelDirector] },
}) {
  /** Muzzle object per ship entity index, resolved once on qualify. */
  private readonly muzzles = new Map<number, Object3D>();
  /** Whole-gun yaw pivot (cannon_mount: carriage + barrel) per ship. */
  private readonly gunPivots = new Map<number, Object3D>();
  /** Defender hit_core nodes per core entity index, resolved once on qualify. */
  private readonly coreNodes = new Map<number, Object3D>();
  /** Shells handed out this frame; the free-shell query only refreshes next frame. */
  private readonly claimed = new Set<number>();
  private readonly muzzlePos = new Vector3();
  private readonly corePos = new Vector3();
  private readonly pivotPos = new Vector3();

  init(): void {
    this.queries.ships.subscribe('qualify', (entity) => {
      const muzzle = entity.object3D?.getObjectByName('muzzle');
      if (muzzle) this.muzzles.set(entity.index, muzzle);
      const gunPivot = entity.object3D?.getObjectByName('cannon_mount');
      if (gunPivot) this.gunPivots.set(entity.index, gunPivot);
      // First shot fires the moment the fire line is crossed; the cooldown
      // only ticks inside the fire-range gate, so 0 here costs nothing early.
      entity.setValue(PirateCannon, 'cooldown', 0);
    });
    this.queries.cores.subscribe('qualify', (entity) => {
      if (entity.getValue(HitCore, 'faction') !== 'defender') return;
      const node = entity.object3D?.getObjectByName('hit_core');
      if (node) this.coreNodes.set(entity.index, node);
    });
  }

  update(delta: number): void {
    // Same START gate as the city battery, plus the pause tag and the
    // GameOver hold: no shots before the game runs, while the pause menu
    // holds the game, or after the run has ended.
    if (this.paused() || this.over() || !this.gameRunning()) return;
    this.claimed.clear();
    for (const ship of this.queries.ships.entities) {
      // Fire permission: crossing the outermost berthing line, not stopping.
      const object = ship.object3D;
      if (!object || object.position.z < SHIP_STOP_Z_MIN) continue;
      // Re-validate the locked target every frame: the cores query drops
      // Destroyed cannons, so a missing index means the target died and the
      // gun re-acquires a random surviving one. With no survivor at all the
      // ship simply holds fire — LevelWaveSystem's defeat check settles the
      // run (GameOver flips every consumer silent) on the same frame.
      if (
        ship.getValue(PirateCannon, 'hasTarget') &&
        !this.targetAlive(ship)
      ) {
        ship.setValue(PirateCannon, 'hasTarget', false);
      }
      if (!ship.getValue(PirateCannon, 'hasTarget')) {
        if (!this.acquireTarget(ship)) continue;
      }
      // The deck gun tracks the target from permission on; the hull never turns.
      this.aimCannon(ship);
      let cooldown = Number(ship.getValue(PirateCannon, 'cooldown')) - delta;
      if (cooldown <= 0) {
        // Pool empty: retry shortly instead of banking negative time.
        cooldown = this.fire(ship) ? this.rollInterval() : 0.1;
      }
      ship.setValue(PirateCannon, 'cooldown', cooldown);
    }
  }

  /** Pick one random city-cannon core and snapshot its world position. */
  private acquireTarget(ship: Entity): boolean {
    // Two passes over the query (count, then pick) keep update() allocation
    // free; this runs on first acquisition and again whenever the previous
    // target's cannon was knocked out.
    let defenderCount = 0;
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') === 'defender') defenderCount += 1;
    }
    if (defenderCount === 0) return false;
    let pick = Math.floor(Math.random() * defenderCount);
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (pick > 0) {
        pick -= 1;
        continue;
      }
      const node = this.coreNodes.get(core.index);
      if (!node) return false;
      node.getWorldPosition(this.corePos);
      ship.setValue(PirateCannon, 'targetCoreIndex', core.index);
      ship.setValue(PirateCannon, 'targetX', this.corePos.x);
      ship.setValue(PirateCannon, 'targetY', this.corePos.y);
      ship.setValue(PirateCannon, 'targetZ', this.corePos.z);
      ship.setValue(PirateCannon, 'hasTarget', true);
      return true;
    }
    return false;
  }

  /**
   * Whether the cannon this ship locked still exists among live defender
   * cores. The query's Destroyed exclusion does the real work: the frame
   * ShellHitSystem tags the cannon, it leaves the query and every ship
   * aiming at it re-acquires on the next update.
   */
  private targetAlive(ship: Entity): boolean {
    const locked = Number(ship.getValue(PirateCannon, 'targetCoreIndex'));
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      if (core.index === locked) return true;
    }
    return false;
  }

  /**
   * Yaw the cannon_mount pivot (carriage + barrel as one rigid unit) so its
   * local -Z barrel points at the target. The target yaw is computed in
   * world space (pivot origin -> target, same atan2(-dx, -dz) convention as
   * the city guns) and converted to the pivot's local frame by subtracting
   * the hull's world yaw, so the whole gun can track while the ship keeps
   * sailing on its own heading.
   */
  private aimCannon(ship: Entity): void {
    const object = ship.object3D;
    const pivot = this.gunPivots.get(ship.index);
    if (!object || !pivot) return;
    pivot.getWorldPosition(this.pivotPos);
    const dx = Number(ship.getValue(PirateCannon, 'targetX')) - this.pivotPos.x;
    const dz = Number(ship.getValue(PirateCannon, 'targetZ')) - this.pivotPos.z;
    const worldYaw = Math.atan2(-dx, -dz);
    pivot.rotation.y = worldYaw - object.rotation.y;
  }

  /**
   * Launch one free shell on the closed-form intercept. With constant
   * horizontal speed v, flight time tau = d / v and
   *   vy = (ty - my) / tau + 0.5 * g * tau
   * makes the shell arrive exactly at (tx, ty, tz) under BallisticSystem.
   */
  private fire(ship: Entity): boolean {
    const muzzle = this.muzzles.get(ship.index);
    const shell = this.firstFreeShell();
    const shellObject = shell?.object3D;
    if (!muzzle || !shell || !shellObject) return false;

    muzzle.getWorldPosition(this.muzzlePos);
    const tx = Number(ship.getValue(PirateCannon, 'targetX'));
    const ty = Number(ship.getValue(PirateCannon, 'targetY'));
    const tz = Number(ship.getValue(PirateCannon, 'targetZ'));
    const dx = tx - this.muzzlePos.x;
    const dz = tz - this.muzzlePos.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal < 1e-6) return false;
    const tau = horizontal / COMBAT.pirateShellSpeed;

    shellObject.position.copy(this.muzzlePos);
    shellObject.visible = true;
    shell.addComponent(BallisticFlight, {
      vx: dx / tau,
      vy: (ty - this.muzzlePos.y) / tau + 0.5 * COMBAT.gravity * tau,
      vz: dz / tau,
    });
    shell.addComponent(ShellFaction, {
      faction: String(ship.getValue(UnitTag, 'faction')),
    });
    return true;
  }

  /** Every cooldown is a fresh roll: interval plus the shared jitter. */
  private rollInterval(): number {
    return (
      COMBAT.pirateFireInterval +
      COMBAT.fireJitterMin +
      Math.random() * (COMBAT.fireJitterMax - COMBAT.fireJitterMin)
    );
  }

  /** First pooled shell neither airborne nor already claimed this frame. */
  private firstFreeShell(): Entity | undefined {
    for (const shell of this.queries.freeShells.entities) {
      if (this.claimed.has(shell.index)) continue;
      // Live guard: CannonFireSystem may have claimed it earlier this frame.
      if (shell.hasComponent(BallisticFlight)) continue;
      this.claimed.add(shell.index);
      return shell;
    }
    return undefined;
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

  /** True once the run has ended (victory or defeat) — the raiders hold fire. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }
}
