/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import {
  GamePaused,
  LevelDirector,
  ShipMovement,
  UnitTag,
  WakeSource,
} from './components.js';
import {
  WAKE_STRENGTH_HALTED,
  WAKE_STRENGTH_MOVING,
} from './level-config.js';

/**
 * Runs the shared march pattern (`default-ship` / `default-flyer`).
 *
 * Moving: sail the straight line from the spawn point to the rolled target at
 * the unit's own cruiseY — ships ride the waterline, the bombardier holds
 * FLYER_Y; a water unit keeps `stopDistance` behind a same-type water unit
 * ahead along its travel direction and waits for it to clear (airborne units
 * never queue — WakeSource presence marks water contact).
 * Stopped: hold at the target, wake eased down.
 *
 * The wake is bound to motion: WAKE_STRENGTH_MOVING while under way,
 * WAKE_STRENGTH_HALTED while stopped or waiting.
 * WakeSource targets are only rewritten when they change; OceanSystem eases
 * the running values toward them.
 *
 * Visual arrival (the hull materialising) belongs to SpawnFadeSystem and is
 * deliberately not a gate on movement.
 */
export class ShipMovementSystem extends createSystem({
  // WakeSource is deliberately absent: flyers march the same line but churn
  // no water, and setWake no-ops for them.
  movers: { required: [ShipMovement, UnitTag] },
  directors: { required: [LevelDirector] },
}) {
  update(delta: number): void {
    if (this.paused()) return;
    for (const entity of this.queries.movers.entities) {
      const object = entity.object3D;
      if (!object) continue;
      if (entity.getValue(ShipMovement, 'state') !== 'stopped') {
        this.advance(entity, object, delta);
      }
    }
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /**
   * Sail toward the target, yielding to a same-type ship ahead.
   *
   * Blocking is re-evaluated every frame and only skips that frame's step —
   * `state` stays 'moving' and the rolled target is never rewritten, so as
   * soon as the corridor ahead clears the ship resumes toward its own target
   * point. The only thing that ends the run is arriving there.
   */
  private advance(entity: Entity, object: Object3D, delta: number): void {
    const targetX = Number(entity.getValue(ShipMovement, 'targetX'));
    const targetZ = Number(entity.getValue(ShipMovement, 'targetZ'));
    const x = object.position.x;
    const z = object.position.z;
    const dx = targetX - x;
    const dz = targetZ - z;
    const remaining = Math.hypot(dx, dz);

    const blocked = this.blockedAhead(entity, object, dx, dz, remaining);
    entity.setValue(ShipMovement, 'blocked', blocked);
    if (blocked) {
      // Waiting for the way to clear reads as halted: ripples halved.
      this.setWake(entity, WAKE_STRENGTH_HALTED, false);
      return;
    }
    this.setWake(entity, WAKE_STRENGTH_MOVING, true);

    // Altitude is per-unit: ships cruise at the waterline, the bombardier
    // holds FLYER_Y. Read once per advance, applied to both arrival and
    // in-flight positioning.
    const cruiseY = Number(entity.getValue(ShipMovement, 'cruiseY'));
    const step = Number(entity.getValue(ShipMovement, 'speed')) * delta;
    if (step >= remaining) {
      object.position.set(targetX, cruiseY, targetZ);
      entity.setValue(ShipMovement, 'state', 'stopped');
      this.setWake(entity, WAKE_STRENGTH_HALTED, false);
      return;
    }
    object.position.set(
      x + (dx / remaining) * step,
      cruiseY,
      z + (dz / remaining) * step,
    );
  }

  /**
   * True while a same-type ship sits ahead within stopDistance — ahead means
   * inside a corridor along this ship's travel direction (dx, dz).
   */
  private blockedAhead(
    entity: Entity,
    object: Object3D,
    dx: number,
    dz: number,
    remaining: number,
  ): boolean {
    const unitType = entity.getValue(UnitTag, 'unitType');
    const stopDistance = Number(entity.getValue(ShipMovement, 'stopDistance'));
    const laneHalfWidth = Number(
      entity.getValue(ShipMovement, 'laneHalfWidth'),
    );
    // Travel direction; fall back to +Z while exactly on target.
    const fx = remaining > 1e-6 ? dx / remaining : 0;
    const fz = remaining > 1e-6 ? dz / remaining : 1;

    for (const other of this.queries.movers.entities) {
      const otherObject = other.object3D;
      if (!otherObject || otherObject === object) continue;
      if (other.getValue(UnitTag, 'unitType') !== unitType) continue;
      // Airborne units never queue: they march above the water where hulls
      // cannot collide, and the corridor yield would only deadlock crossing
      // routes (two simultaneous flyers blocking each other forever).
      // WakeSource presence is the unit-sheet water-contact fact — flyers
      // carry none (same unitType ⇒ same wake-ness, so one check covers both).
      if (!other.hasComponent(WakeSource)) continue;
      const ox = otherObject.position.x - object.position.x;
      const oz = otherObject.position.z - object.position.z;
      const ahead = ox * fx + oz * fz;
      if (ahead <= 0 || ahead > stopDistance) continue;
      const lateral = Math.abs(ox * fz - oz * fx);
      if (lateral > laneHalfWidth) continue;
      return true;
    }
    return false;
  }

  /**
   * Retarget the wake; OceanSystem eases the running values over ~0.3 s.
   * The radius swings between the hull's own base (ShipMovement.wakeRadius —
   * ship-scaled for the boss) and half of it, matching the raider rule.
   */
  private setWake(entity: Entity, strength: number, moving: boolean): void {
    // Flyers (and any future non-water unit) carry no WakeSource; the march
    // stays shared and the water stays still.
    if (!entity.hasComponent(WakeSource)) return;
    const radius = moving
      ? Number(entity.getValue(ShipMovement, 'wakeRadius'))
      : Number(entity.getValue(ShipMovement, 'wakeRadius')) * 0.5;
    if (Number(entity.getValue(WakeSource, 'targetStrength')) !== strength) {
      entity.setValue(WakeSource, 'targetStrength', strength);
    }
    if (Number(entity.getValue(WakeSource, 'targetRadius')) !== radius) {
      entity.setValue(WakeSource, 'targetRadius', radius);
    }
  }
}
