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
  StoneTag,
  UnitTag,
} from './components.js';
import { COMBAT } from './level-config.js';
import { solveIntercept } from './shell-launch.js';

/**
 * Attacker fire (pirate ships, the bombardier and the ornithopter share the
 * ability). Firing permission is a positional fact owned by this attack
 * ability, deliberately separate from ShipMovement's termination: the moment
 * a unit crosses its own fire line — PirateCannon.fireLineZ, the far edge of
 * its berth band (ships SHIP_STOP_Z_MIN, the bombardier FLYER_STOP_Z_MIN,
 * the ornithopter ORNITHOPTER.stopZMin) — it may shoot, it does not need to
 * have stopped yet. Once in range and the battle has started it:
 *
 * 1. picks one random defender hit core (a city cannon) and
 *    snapshots its world position as the target — mounted defenders never
 *    move; a locked target
 *    that gets knocked out is re-acquired the same way on the next frame, and
 *    with no survivor the unit holds fire until the defeat outcome lands;
 * 2. yaws onto the target: units with a cannon_mount pivot (ships) swing the
 *    whole deck gun — carriage plus barrel — and keep the hull heading; the
 *    pivotless flyers (bombardier, ornithopter) yaw the entire hull, which
 *    also swings their belly muzzle nose-forward for the drop;
 * 3. the first shot leaves immediately when permission is granted (cooldown
 *    starts at 0); later shots follow a jittered cooldown.
 *
 * Every shot is a mathematically guaranteed hit: horizontal velocity is
 * distance / flight time and vertical velocity is solved against
 * BallisticSystem's gravity, so at t = flightTime the shell is exactly at
 * the target core. The arc stays flat because the horizontal speed is high
 * (COMBAT.pirateShellSpeed); no second flight model exists. Units with
 * PirateCannon.stone (the ornithopter) draw from the stone pool instead of
 * the ball pool; the closed-form intercept is identical.
 */
export class PirateFireSystem extends createSystem({
  ships: { required: [UnitTag, ShipMovement, PirateCannon] },
  cores: { required: [HitCore], excluded: [Destroyed] },
  freeShells: {
    required: [ShellTag],
    excluded: [BallisticFlight, StoneTag],
  },
  freeStones: {
    required: [ShellTag, StoneTag],
    excluded: [BallisticFlight],
  },
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
  /** Velocity scratch for the shared intercept solver. */
  private readonly intercept = { vx: 0, vy: 0, vz: 0 };

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
      // Fire permission: crossing this unit's own fire line (PirateCannon
      // .fireLineZ, written from the unit sheet at spawn), not stopping.
      const object = ship.object3D;
      if (
        !object ||
        object.position.z < Number(ship.getValue(PirateCannon, 'fireLineZ'))
      ) {
        continue;
      }
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
      // The gun — or the whole hull for pivotless units — tracks the target
      // from permission on.
      this.aimCannon(ship);
      let cooldown = Number(ship.getValue(PirateCannon, 'cooldown')) - delta;
      if (cooldown <= 0) {
        // Pool empty: retry shortly instead of banking negative time.
        cooldown = this.fire(ship) ? this.rollInterval(ship) : 0.1;
      }
      ship.setValue(PirateCannon, 'cooldown', cooldown);
    }
  }

  /** Pick one random defender core (cannon) and snapshot it. */
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
   * Yaw the unit's aim onto the target. Ships swing the cannon_mount pivot
   * (carriage + barrel as one rigid unit): the target yaw is computed in
   * world space (pivot origin -> target, same atan2(-dx, -dz) convention as
   * the city guns) and converted to the pivot's local frame by subtracting
   * the hull's world yaw, so the gun tracks while the ship keeps sailing on
   * its own heading. The pivotless flyers (bombardier, ornithopter) yaw the
   * whole hull, which also swings their belly muzzle nose-forward for the
   * drop.
   */
  private aimCannon(ship: Entity): void {
    const object = ship.object3D;
    const pivot = this.gunPivots.get(ship.index);
    if (!object) return;
    const reference = pivot ?? object;
    reference.getWorldPosition(this.pivotPos);
    const dx = Number(ship.getValue(PirateCannon, 'targetX')) - this.pivotPos.x;
    const dz = Number(ship.getValue(PirateCannon, 'targetZ')) - this.pivotPos.z;
    const worldYaw = Math.atan2(-dx, -dz);
    if (pivot) pivot.rotation.y = worldYaw - object.rotation.y;
    else object.rotation.y = worldYaw;
  }

  /**
   * Launch one free shell on the closed-form intercept solved by the shared
   * solver (shell-launch.ts) — the same math every attacker gun uses.
   */
  private fire(ship: Entity): boolean {
    const muzzle = this.muzzles.get(ship.index);
    const wantsStone = Boolean(ship.getValue(PirateCannon, 'stone'));
    const shell = wantsStone ? this.firstFreeStone() : this.firstFreeShell();
    const shellObject = shell?.object3D;
    if (!muzzle || !shell || !shellObject) return false;

    muzzle.getWorldPosition(this.muzzlePos);
    const tau = solveIntercept(
      this.muzzlePos,
      Number(ship.getValue(PirateCannon, 'targetX')),
      Number(ship.getValue(PirateCannon, 'targetY')),
      Number(ship.getValue(PirateCannon, 'targetZ')),
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
      faction: String(ship.getValue(UnitTag, 'faction')),
      unitType: String(ship.getValue(UnitTag, 'unitType')),
    });
    return true;
  }

  /** Every cooldown is a fresh roll: the unit's own interval plus the shared jitter. */
  private rollInterval(ship: Entity): number {
    return (
      Number(ship.getValue(PirateCannon, 'interval')) +
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

  /** Same discipline as firstFreeShell, over the stone pool. */
  private firstFreeStone(): Entity | undefined {
    for (const stone of this.queries.freeStones.entities) {
      if (this.claimed.has(stone.index)) continue;
      if (stone.hasComponent(BallisticFlight)) continue;
      this.claimed.add(stone.index);
      return stone;
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
