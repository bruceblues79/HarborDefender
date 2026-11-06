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
 * Runs the shared march pattern; visual arrival belongs to SpawnFadeSystem and
 * is deliberately not a gate. Same-type water units queue (flyers never do).
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

  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /**
   * Blocking only skips this frame's step: `state` stays 'moving' and the
   * target is never rewritten, so the ship resumes once the lane clears.
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

    // Altitude is per-unit: ships at the waterline, the bombardier at FLYER_Y.
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

  /** True while a same-type ship sits inside the forward corridor within stopDistance. */
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
      // Airborne units never queue: the corridor yield would deadlock two
      // crossing flyers. WakeSource presence is the water-contact fact.
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
   * Retarget the wake; OceanSystem eases it over ~0.3 s. Radius halves when stopped.
   */
  private setWake(entity: Entity, strength: number, moving: boolean): void {
    // Non-water units carry no WakeSource; the shared march leaves water still.
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
