/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Euler, Quaternion, Vector3 } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  BallisticFlight,
  BoltTag,
  GameOver,
  GamePaused,
  GunCycle,
  LevelDirector,
  LockTarget,
  ShellFaction,
  ShellTag,
  ShipMovement,
  StoneTag,
} from './components.js';
import { COMBAT } from './level-config.js';
import { solveIntercept } from './shell-launch.js';

const DEG2RAD = Math.PI / 180;
/** Wait while the targeting system has not handed this gun a target yet (s). */
const WAIT_TARGET_RETRY = 0.1;
/** Pool-empty fire retry delay (s) — mirrors the other fire systems. */
const RETRY_DELAY = 0.1;

/**
 * Per-gun fire state machine (每门炮绑定发射状态机) for every gun entity
 * carrying `GunCycle` + `LockTarget`. Each gun runs its own rhythm loop —
 * fire -> pause (jittered cooldown) -> turn onto the target snapshot ->
 * hold -> fire — fully independent of every other gun. Clearing the gun's
 * LockTarget slot after the shot asks FreeLockTargetSystem for a fresh
 * random roll, so no gun ever locks one target forever.
 *
 * The shots are the shared guaranteed-hit intercept from the muzzle
 * (shell-launch.ts); per-gun data (fireInterval, turnSpeedDeg, shellSpeed,
 * shellUnitType, berth gate) lives on the component, set at assembly.
 *
 * Stateless system: no per-entity caches. Pivot/muzzle are resolved from the
 * gun's own subtree (`entity.object3D`) at each use — the entity is the only
 * truth holder; shell claiming reads the live component set (BallisticFlight
 * present = in flight) instead of any system-side bookkeeping.
 */
export class GunCycleSystem extends createSystem({
  guns: { required: [GunCycle] },
  carriers: { required: [ShipMovement] },
  freeShells: {
    required: [ShellTag],
    excluded: [BallisticFlight, BoltTag, StoneTag],
  },
  directors: { required: [LevelDirector] },
}) {
  private readonly muzzlePos = new Vector3();
  private readonly pivotPos = new Vector3();
  /** Velocity scratch for the shared intercept solver. */
  private readonly intercept = { vx: 0, vy: 0, vz: 0 };
  /** Parent-chain yaw decomposition scratch (hull yaw + baked seat yaw). */
  private readonly parentQuat = new Quaternion();
  private readonly parentEuler = new Euler();

  update(delta: number): void {
    // Shared three gates; the per-gun berth gate is component data.
    if (this.paused() || this.over() || !this.gameRunning()) return;

    for (const gun of this.queries.guns.entities) {
      if (
        Number(gun.getValue(GunCycle, 'requireStopped')) &&
        !this.carrierStopped(gun)
      ) {
        continue;
      }
      const state = String(gun.getValue(GunCycle, 'state'));
      if (state === 'cooldown') {
        // Pause 1: the post-shot wait. When it runs out the gun starts
        // swinging onto whatever target the targeting system has rolled.
        let timer = Number(gun.getValue(GunCycle, 'timer')) - delta;
        if (timer <= 0) {
          if (this.hasTarget(gun)) {
            gun.setValue(GunCycle, 'state', 'turning');
          } else {
            timer = WAIT_TARGET_RETRY;
          }
        }
        gun.setValue(GunCycle, 'timer', timer);
        continue;
      }
      if (state === 'turning') {
        // The swing: step the yaw toward the target snapshot at the
        // component's turn speed and wait for convergence — the snapshot is
        // static and a missing yaw axis reports on-target, so the swing
        // always terminates on its own; no budget, no snap. If the
        // targeting system swaps the slot's target mid-swing (one died),
        // the step simply follows the fresh snapshot.
        if (
          this.aimStep(gun, delta) <=
          Number(gun.getValue(GunCycle, 'turnThresholdDeg')) * DEG2RAD
        ) {
          gun.setValue(GunCycle, 'state', 'hold');
          gun.setValue(
            GunCycle,
            'timer',
            Number(gun.getValue(GunCycle, 'aimHoldSec')),
          );
        }
        continue;
      }
      // Pause 2 (hold): the barrel sits frozen on target — count the aim
      // beat down, then fire. Pool empty
      // retries shortly while keeping target and pose; only a real shot
      // rolls the next cooldown — and clears the target slot so the
      // targeting system re-rolls a fresh random pick.
      let timer = Number(gun.getValue(GunCycle, 'timer')) - delta;
      if (timer <= 0) {
        if (this.fire(gun) === 'fired') {
          gun.setValue(GunCycle, 'state', 'cooldown');
          gun.setValue(LockTarget, 'targetCoreIndex', -1);
          timer =
            Number(gun.getValue(GunCycle, 'fireInterval')) + this.rollJitter();
        } else {
          timer = RETRY_DELAY;
        }
      }
      gun.setValue(GunCycle, 'timer', timer);
    }
  }

  /** Whether the targeting system has handed this gun a live target slot. */
  private hasTarget(gun: Entity): boolean {
    return Number(gun.getValue(LockTarget, 'targetCoreIndex')) !== -1;
  }

  /** Whether the hull carrying this gun has parked at its berth. */
  private carrierStopped(gun: Entity): boolean {
    const carrier = Number(gun.getValue(GunCycle, 'carrierIndex'));
    for (const hull of this.queries.carriers.entities) {
      if (hull.index !== carrier) continue;
      return String(hull.getValue(ShipMovement, 'state')) === 'stopped';
    }
    return false;
  }

  /**
   * Step the gun's yaw toward the target snapshot and return the remaining
   * |error| in radians. The target yaw is computed in world space
   * (pivot origin -> target, atan2(-dx, -dz) — the shared gun convention)
   * and converted to the pivot's local frame by subtracting the parent
   * chain's world yaw, decomposed from the wrapper's world quaternion so
   * baked seat rotations cannot skew the frame. Runs only in turning — the
   * hold beat keeps the barrel frozen on target.
   */
  private aimStep(gun: Entity, delta: number): number {
    const object = gun.object3D;
    const pivot = object?.getObjectByName(String(gun.getValue(GunCycle, 'pivotName'))) ?? null;
    // No resolvable yaw axis: nothing to animate, report "on target" so the
    // cycle proceeds to the hold beat and the centre-launch fire path.
    if (!pivot || !object) return 0;
    pivot.getWorldPosition(this.pivotPos);
    const dx = Number(gun.getValue(LockTarget, 'targetX')) - this.pivotPos.x;
    const dz = Number(gun.getValue(LockTarget, 'targetZ')) - this.pivotPos.z;
    const worldYaw = Math.atan2(-dx, -dz);
    object.getWorldQuaternion(this.parentQuat);
    this.parentEuler.setFromQuaternion(this.parentQuat, 'YXZ');
    const local = worldYaw - this.parentEuler.y;
    // Shortest-arc error, wrap-safe across the ±pi seam.
    const error = Math.atan2(
      Math.sin(local - pivot.rotation.y),
      Math.cos(local - pivot.rotation.y),
    );
    const step =
      Number(gun.getValue(GunCycle, 'turnSpeedDeg')) * DEG2RAD * delta;
    pivot.rotation.y =
      Math.abs(error) <= step
        ? local
        : pivot.rotation.y + Math.sign(error) * step;
    return Math.abs(error);
  }

  /**
   * Launch one free shell on the closed-form intercept (shell-launch.ts) —
   * the same math every attacker gun uses, stamped with this gun's own
   * damage-matrix row. Launch point: the muzzle helper, or the turret centre
   * when the muzzle node is not resolvable (the intercept solve is
   * guaranteed-hit, so the start point only moves the visible arc).
   * Returns 'fired' or a one-letter failure reason ('m' no scene object,
   * 'e' pool empty, 't' intercept unsolvable).
   */
  private fire(gun: Entity): 'fired' | 'm' | 'e' | 't' {
    const object = gun.object3D;
    if (!object) return 'm';
    const launch =
      object.getObjectByName(String(gun.getValue(GunCycle, 'muzzleName'))) ??
      object;
    const shell = this.firstFreeShell();
    const shellObject = shell?.object3D;
    if (!shell || !shellObject) return 'e';

    launch.getWorldPosition(this.muzzlePos);
    const tau = solveIntercept(
      this.muzzlePos,
      Number(gun.getValue(LockTarget, 'targetX')),
      Number(gun.getValue(LockTarget, 'targetY')),
      Number(gun.getValue(LockTarget, 'targetZ')),
      Number(gun.getValue(GunCycle, 'shellSpeed')),
      COMBAT.gravity,
      this.intercept,
    );
    if (tau < 0) return 't';

    shellObject.position.copy(this.muzzlePos);
    shellObject.visible = true;
    shell.addComponent(BallisticFlight, {
      vx: this.intercept.vx,
      vy: this.intercept.vy,
      vz: this.intercept.vz,
    });
    shell.addComponent(ShellFaction, {
      faction: 'attacker',
      unitType: String(gun.getValue(GunCycle, 'shellUnitType')),
    });
    return 'fired';
  }

  /** Shared per-shot jitter (one truth for every gun in the game). */
  private rollJitter(): number {
    return (
      COMBAT.fireJitterMin +
      Math.random() * (COMBAT.fireJitterMax - COMBAT.fireJitterMin)
    );
  }

  /**
   * First pooled shell whose live component set says it is not airborne.
   * The query already excludes BallisticFlight; the hasComponent guard is
   * the component-truth backstop for same-frame claims made by another fire
   * system before this query's snapshot refreshes.
   */
  private firstFreeShell(): Entity | undefined {
    for (const shell of this.queries.freeShells.entities) {
      if (shell.hasComponent(BallisticFlight)) continue;
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

  /** True once the run has ended (victory or defeat) — the guns hold fire. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }
}
