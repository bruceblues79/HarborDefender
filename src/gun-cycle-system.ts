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
 * Per-gun fire state machine for every gun carrying `GunCycle` + `LockTarget`:
 * fire -> jittered cooldown -> turn onto the target snapshot -> hold -> fire,
 * one independent rhythm per gun. Shots use the shared guaranteed-hit intercept
 * from shell-launch.ts; per-gun data lives on the component. Stateless: pools
 * are claimed from live component state, never system-side bookkeeping.
 */
export class GunCycleSystem extends createSystem({
  guns: { required: [GunCycle] },
  carriers: { required: [ShipMovement] },
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
  private readonly muzzlePos = new Vector3();
  private readonly pivotPos = new Vector3();
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
        // Pause 1: post-shot wait; then swing onto whatever target was rolled.
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
        // Swing toward the static target snapshot at the component's turn
        // speed; a missing yaw axis reports on-target, so it always terminates.
        // A target swapped mid-swing (one died) is simply followed.
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
      // Pause 2: the barrel sits frozen on target; firing clears the target
      // slot so the targeting system re-rolls. An empty pool retries shortly,
      // keeping target and pose.
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

  private hasTarget(gun: Entity): boolean {
    return Number(gun.getValue(LockTarget, 'targetCoreIndex')) !== -1;
  }

  private carrierStopped(gun: Entity): boolean {
    const carrier = Number(gun.getValue(GunCycle, 'carrierIndex'));
    for (const hull of this.queries.carriers.entities) {
      if (hull.index !== carrier) continue;
      return String(hull.getValue(ShipMovement, 'state')) === 'stopped';
    }
    return false;
  }

  /**
   * Step the gun's yaw toward the target snapshot, returning the remaining
   * |error| in radians. World yaw is atan2(-dx, -dz) (the shared gun
   * convention), converted to the pivot's local frame by subtracting the
   * parent chain's world yaw.
   */
  private aimStep(gun: Entity, delta: number): number {
    const object = gun.object3D;
    if (!object) return 0;
    const pivot =
      object.getObjectByName(String(gun.getValue(GunCycle, 'pivotName'))) ??
      null;
    if (!pivot) {
      // Pivotless gun (flyer units aim with the whole airframe): the hull yaws
      // at the shared turn speed; a missing pivot never blocks the cycle.
      object.getWorldPosition(this.pivotPos);
      const dx = Number(gun.getValue(LockTarget, 'targetX')) - this.pivotPos.x;
      const dz = Number(gun.getValue(LockTarget, 'targetZ')) - this.pivotPos.z;
      const worldYaw = Math.atan2(-dx, -dz);
      const error = Math.atan2(
        Math.sin(worldYaw - object.rotation.y),
        Math.cos(worldYaw - object.rotation.y),
      );
      const step =
        Number(gun.getValue(GunCycle, 'turnSpeedDeg')) * DEG2RAD * delta;
      object.rotation.y =
        Math.abs(error) <= step
          ? worldYaw
          : object.rotation.y + Math.sign(error) * step;
      return Math.abs(error);
    }
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

  /** Same discipline as firstFreeShell, over the stone pool. */
  private firstFreeStone(): Entity | undefined {
    for (const stone of this.queries.freeStones.entities) {
      // Backstop for same-frame claims made by another fire system.
      if (stone.hasComponent(BallisticFlight)) continue;
      return stone;
    }
    return undefined;
  }

  private fire(gun: Entity): 'fired' | 'm' | 'e' | 't' {
    const object = gun.object3D;
    if (!object) return 'm';
    const launch =
      object.getObjectByName(String(gun.getValue(GunCycle, 'muzzleName'))) ??
      object;
    const shell = Boolean(gun.getValue(GunCycle, 'stone'))
      ? this.firstFreeStone()
      : this.firstFreeShell();
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

  private rollJitter(): number {
    return (
      COMBAT.fireJitterMin +
      Math.random() * (COMBAT.fireJitterMax - COMBAT.fireJitterMin)
    );
  }

  /**
   * First pooled shell whose live component set says it is not airborne. The
   * hasComponent guard covers same-frame claims before the query snapshot refreshes.
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
