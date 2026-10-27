/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Quaternion, Vector3 } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  Destroyed,
  GameOver,
  GamePaused,
  Health,
  HitCore,
  LaserCycle,
  LevelDirector,
  LockTarget,
  ShipMovement,
} from './components.js';
import { BOSS, COMBAT } from './level-config.js';

const DEG2RAD = Math.PI / 180;
/** Wait while the targeting system has not handed this cannon a target (s). */
const WAIT_TARGET_RETRY = 0.1;
/** The muzzle's model-forward axis, shared by every aim solve. */
const FORWARD = new Vector3(0, 0, -1);

/**
 * Laser main cannon fire state machine for every entity carrying
 * `LaserCycle` + `LockTarget` — the boss hull never needs to know its laser
 * exists. Each emission runs its own rhythm loop — turn onto the target
 * snapshot -> freeze the beam axis -> charge (energy gathering) -> sweep ->
 * pause (jittered cooldown) -> next cycle — fully independent of the four
 * gun turrets.
 *
 * The axis freeze is the behavioural core: at aim convergence the muzzle's
 * world position, world -Z direction and the distance to the target
 * snapshot are written ONCE into the component, and charging/firing never
 * re-reads `LockTarget`. A target dying mid-charge never re-aims — the
 * cannon locks a defense-slot direction, and a FreeLockTargetSystem re-roll
 * of the slot is harmless until the next cooldown hands targeting back.
 *
 * Damage is a single pass at the firing transition: every live defender
 * core within the frozen segment's corridor loses `laserDamageRatio` of its
 * max Health. Only `Health.current` is written — what dying means stays
 * single-truthed in ShellHitSystem's death sweep.
 *
 * Stateless system: no per-entity caches. Pivot/muzzle are resolved from
 * the cannon's own subtree (`entity.object3D`) at each use; all beam-axis
 * truth lives on the component.
 */
export class LaserCycleSystem extends createSystem({
  lasers: { required: [LaserCycle] },
  carriers: { required: [ShipMovement] },
  cores: { required: [HitCore, Health], excluded: [Destroyed] },
  directors: { required: [LevelDirector] },
}) {
  /** Muzzle/pivot world-position scratch (allocated once, never in update). */
  private readonly muzzlePos = new Vector3();
  private readonly pivotPos = new Vector3();
  /** Muzzle world-orientation scratch for the axis freeze. */
  private readonly muzzleQuat = new Quaternion();
  /** Parent-chain orientation scratch for localizing the aim direction. */
  private readonly parentQuat = new Quaternion();
  private readonly invParent = new Quaternion();
  /** Aim-direction scratch: world estimate -> parent-local -> target quat. */
  private readonly dirWorld = new Vector3();
  private readonly dirLocal = new Vector3();
  private readonly targetQuat = new Quaternion();
  /** Beam-axis scratch for the damage-corridor pass. */
  private readonly beamDir = new Vector3();
  private readonly origin = new Vector3();
  private readonly corePos = new Vector3();
  private readonly toCore = new Vector3();
  private readonly closest = new Vector3();

  update(delta: number): void {
    // Shared three gates; the per-cannon berth gate is component data.
    if (this.paused() || this.over() || !this.gameRunning()) return;

    for (const laser of this.queries.lasers.entities) {
      if (
        Number(laser.getValue(LaserCycle, 'requireStopped')) &&
        !this.carrierStopped(laser)
      ) {
        continue;
      }
      const state = String(laser.getValue(LaserCycle, 'state'));
      if (state === 'cooldown') {
        // Pause: the post-emission wait. When it runs out the cannon starts
        // swinging onto whatever target the targeting system has rolled.
        let timer = Number(laser.getValue(LaserCycle, 'timer')) - delta;
        if (timer <= 0) {
          if (this.hasTarget(laser)) {
            laser.setValue(LaserCycle, 'state', 'turning');
          } else {
            timer = WAIT_TARGET_RETRY;
          }
        }
        laser.setValue(LaserCycle, 'timer', timer);
        continue;
      }
      if (state === 'turning') {
        // The swing: step the pivot's full orientation (yaw + pitch in one
        // quaternion arc) toward the target snapshot. If the targeting
        // system swaps the slot's target mid-swing (one died), the step
        // simply follows the fresh snapshot.
        if (
          this.aimStep(laser, delta) <=
          Number(laser.getValue(LaserCycle, 'turnThresholdDeg')) * DEG2RAD
        ) {
          // Freeze the beam axis — from here the defense-slot direction is
          // locked, whatever happens to the target.
          this.freezeAxis(laser);
          laser.setValue(LaserCycle, 'state', 'charging');
          laser.setValue(
            LaserCycle,
            'timer',
            Number(laser.getValue(LaserCycle, 'chargeSec')),
          );
        }
        continue;
      }
      if (state === 'charging') {
        // Energy gathering: only the countdown ticks; the axis is frozen and
        // the targeting slot is ignored.
        let timer = Number(laser.getValue(LaserCycle, 'timer')) - delta;
        if (timer <= 0) {
          this.applyBeamDamage(laser);
          laser.setValue(LaserCycle, 'state', 'firing');
          timer = Number(laser.getValue(LaserCycle, 'fireSec'));
        }
        laser.setValue(LaserCycle, 'timer', timer);
        continue;
      }
      // Firing: the beam sweeps along the frozen axis. At the end of the
      // emission the cooldown opens and the targeting slot is cleared so
      // FreeLockTargetSystem re-rolls a fresh random pick for next cycle.
      let timer = Number(laser.getValue(LaserCycle, 'timer')) - delta;
      if (timer <= 0) {
        laser.setValue(LaserCycle, 'state', 'cooldown');
        laser.setValue(LockTarget, 'targetCoreIndex', -1);
        timer =
          Number(laser.getValue(LaserCycle, 'cooldownSec')) +
          this.rollJitter();
      }
      laser.setValue(LaserCycle, 'timer', timer);
    }
  }

  /** Whether the targeting system has handed this cannon a live target slot. */
  private hasTarget(laser: Entity): boolean {
    return Number(laser.getValue(LockTarget, 'targetCoreIndex')) !== -1;
  }

  /** Whether the hull carrying this cannon has parked at its berth. */
  private carrierStopped(laser: Entity): boolean {
    const carrier = Number(laser.getValue(LaserCycle, 'carrierIndex'));
    for (const hull of this.queries.carriers.entities) {
      if (hull.index !== carrier) continue;
      return String(hull.getValue(ShipMovement, 'state')) === 'stopped';
    }
    return false;
  }

  /**
   * Step the pivot's orientation toward the target and return the remaining
   * angular error in radians. The muzzle sits off the pivot axis (baked
   * local offset), so the aim direction is estimated from the MUZZLE —
   * normalize(target - muzzle world pos) localized into the pivot's parent
   * frame — and `rotateTowards` advances the current orientation along the
   * shortest arc. Re-estimating every frame converges onto the exact
   * fixed point where the beam ray passes through the target: the muzzle's
   * orbital offset is ~0.3 m against a ~5 m shot, so the map contracts
   * roughly 15x per radian of swing.
   */
  private aimStep(laser: Entity, delta: number): number {
    const object = laser.object3D;
    const pivot =
      object?.getObjectByName(String(laser.getValue(LaserCycle, 'pivotName'))) ??
      null;
    // No resolvable aim axis: nothing to animate, report "on target" so the
    // cycle proceeds (mirrors the gun cycle's graceful degradation).
    if (!pivot || !object) return 0;
    pivot.getWorldPosition(this.pivotPos);
    const muzzle =
      object.getObjectByName(String(laser.getValue(LaserCycle, 'muzzleName'))) ??
      pivot;
    muzzle.getWorldPosition(this.muzzlePos);
    this.dirWorld.set(
      Number(laser.getValue(LockTarget, 'targetX')) - this.muzzlePos.x,
      Number(laser.getValue(LockTarget, 'targetY')) - this.muzzlePos.y,
      Number(laser.getValue(LockTarget, 'targetZ')) - this.muzzlePos.z,
    );
    // Degenerate snapshot (target on the muzzle): nothing to solve.
    if (this.dirWorld.lengthSq() < 1e-8) return 0;
    this.dirWorld.normalize();
    // Localize into the frame the pivot's quaternion lives in.
    object.getWorldQuaternion(this.parentQuat);
    this.invParent.copy(this.parentQuat).invert();
    this.dirLocal.copy(this.dirWorld).applyQuaternion(this.invParent);
    this.targetQuat.setFromUnitVectors(FORWARD, this.dirLocal);
    const step =
      Number(laser.getValue(LaserCycle, 'turnSpeedDeg')) * DEG2RAD * delta;
    pivot.quaternion.rotateTowards(this.targetQuat, step);
    return pivot.quaternion.angleTo(this.targetQuat);
  }

  /**
   * Write the frozen beam axis into the component: origin = muzzle world
   * position, dir = muzzle world -Z (unit length), length = distance to the
   * target snapshot (the locked defense-slot direction). Everything the fx
   * rig and the damage pass need is read from these scalars afterwards —
   * never from the live scene graph.
   */
  private freezeAxis(laser: Entity): void {
    const object = laser.object3D;
    const muzzle =
      object?.getObjectByName(String(laser.getValue(LaserCycle, 'muzzleName'))) ??
      object;
    if (!muzzle) return;
    muzzle.getWorldPosition(this.muzzlePos);
    muzzle.getWorldQuaternion(this.muzzleQuat);
    this.beamDir.set(0, 0, -1).applyQuaternion(this.muzzleQuat);
    laser.setValue(LaserCycle, 'originX', this.muzzlePos.x);
    laser.setValue(LaserCycle, 'originY', this.muzzlePos.y);
    laser.setValue(LaserCycle, 'originZ', this.muzzlePos.z);
    laser.setValue(LaserCycle, 'dirX', this.beamDir.x);
    laser.setValue(LaserCycle, 'dirY', this.beamDir.y);
    laser.setValue(LaserCycle, 'dirZ', this.beamDir.z);
    laser.setValue(LaserCycle, 'length', this.originToTarget(laser));
  }

  /** Distance from the frozen origin to the locked target snapshot. */
  private originToTarget(laser: Entity): number {
    const dx =
      Number(laser.getValue(LockTarget, 'targetX')) -
      Number(laser.getValue(LaserCycle, 'originX'));
    const dy =
      Number(laser.getValue(LockTarget, 'targetY')) -
      Number(laser.getValue(LaserCycle, 'originY'));
    const dz =
      Number(laser.getValue(LockTarget, 'targetZ')) -
      Number(laser.getValue(LaserCycle, 'originZ'));
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * One damage pass at the firing transition: every live defender core
   * whose centre lies within the corridor (beam half-width + its own core
   * radius around the frozen origin->end segment) loses
   * `BOSS.laserDamageRatio` of its max Health. Defenders never move and the
   * axis is frozen, so one pass at emission start covers the whole sweep —
   * a target that dies to something else mid-sweep simply has no Health
   * left to take. Only `Health.current` is written; the death sweep in
   * ShellHitSystem (priority 14, same frame) owns what dying means.
   */
  private applyBeamDamage(laser: Entity): void {
    const origin = this.origin.set(
      Number(laser.getValue(LaserCycle, 'originX')),
      Number(laser.getValue(LaserCycle, 'originY')),
      Number(laser.getValue(LaserCycle, 'originZ')),
    );
    const beamDir = this.beamDir.set(
      Number(laser.getValue(LaserCycle, 'dirX')),
      Number(laser.getValue(LaserCycle, 'dirY')),
      Number(laser.getValue(LaserCycle, 'dirZ')),
    );
    const beamLength = Number(laser.getValue(LaserCycle, 'length'));
    if (beamLength <= 0) return;
    for (const core of this.queries.cores.entities) {
      if (core.getValue(HitCore, 'faction') !== 'defender') continue;
      core.object3D?.getWorldPosition(this.corePos);
      this.toCore.copy(this.corePos).sub(origin);
      // Closest point on the frozen segment [origin, origin + dir·length].
      const along = Math.max(
        0,
        Math.min(beamLength, this.toCore.dot(beamDir)),
      );
      this.closest.copy(origin).addScaledVector(beamDir, along);
      this.toCore.copy(this.corePos).sub(this.closest);
      const reach =
        Number(core.getValue(HitCore, 'radius')) + BOSS.laserDamageRadius;
      if (this.toCore.lengthSq() > reach * reach) continue;
      const max = Number(core.getValue(Health, 'max'));
      const current = Number(core.getValue(Health, 'current'));
      core.setValue(
        Health,
        'current',
        Math.max(0, current - max * BOSS.laserDamageRatio),
      );
    }
  }

  /** Shared per-emission jitter (one truth for every gun in the game). */
  private rollJitter(): number {
    return (
      COMBAT.fireJitterMin +
      Math.random() * (COMBAT.fireJitterMax - COMBAT.fireJitterMin)
    );
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

  /** True once the run has ended (victory or defeat) — the beam holds. */
  private over(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GameOver);
    }
    return false;
  }
}
