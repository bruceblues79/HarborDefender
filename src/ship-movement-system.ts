/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Entity, Mesh, Object3D } from '@iwsdk/core';
import { ShipMovement, UnitTag, WakeSource } from './components.js';
import { SHIP_Y } from './level-config.js';

/** Ripple radius a sailing ship carries. */
const WAKE_RADIUS = 1.25;
/** Wake strength while sailing vs. halted, per the design brief (1 vs 1/2). */
const WAKE_MOVING = 1;
const WAKE_HALTED = 0.5;

/**
 * Runs the `default-ship` movement pattern.
 *
 * Spawning: a wireframe overlay dissolves while the hull fades from
 * transparent to solid; shadows switch on once the ship is fully real.
 * Moving: sail the straight line from the spawn point to the rolled target;
 * a ship keeps `stopDistance` behind a same-type ship ahead along its travel
 * direction and waits for it to clear.
 * Stopped: hold at the target, ripples halved.
 *
 * The wake is bound to motion: full while running, halved while halted.
 * WakeSource targets are only rewritten when they change; OceanSystem eases
 * the running values toward them.
 */
export class ShipMovementSystem extends createSystem({
  movers: { required: [ShipMovement, UnitTag, WakeSource] },
}) {
  update(delta: number): void {
    for (const entity of this.queries.movers.entities) {
      const object = entity.object3D;
      if (!object) continue;
      const state = entity.getValue(ShipMovement, 'state');
      if (state === 'spawning') this.emerge(entity, object, delta);
      else if (state === 'moving') this.advance(entity, object, delta);
    }
  }

  /** Fade the hull in from transparent, then hand over to the run. */
  private emerge(entity: Entity, object: Object3D, delta: number): void {
    const duration = Number(
      entity.getValue(ShipMovement, 'spawnFadeDuration'),
    );
    const fade = Math.min(
      1,
      Number(entity.getValue(ShipMovement, 'spawnFade')) + delta / duration,
    );
    entity.setValue(ShipMovement, 'spawnFade', fade);

    const done = fade >= 1;
    object.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const material of materials) {
        material.opacity = fade;
        if (done) material.transparent = false;
      }
      if (done) mesh.castShadow = true;
    });
    if (!done) return;

    entity.setValue(ShipMovement, 'state', 'moving');
    this.setWake(entity, WAKE_MOVING, WAKE_RADIUS);
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
      this.setWake(entity, WAKE_HALTED, WAKE_RADIUS * 0.5);
      return;
    }
    this.setWake(entity, WAKE_MOVING, WAKE_RADIUS);

    const step = Number(entity.getValue(ShipMovement, 'speed')) * delta;
    if (step >= remaining) {
      object.position.set(targetX, SHIP_Y, targetZ);
      entity.setValue(ShipMovement, 'state', 'stopped');
      this.setWake(entity, WAKE_HALTED, WAKE_RADIUS * 0.5);
      return;
    }
    object.position.set(x + (dx / remaining) * step, SHIP_Y, z + (dz / remaining) * step);
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

  /** Retarget the wake; OceanSystem eases the running values over ~0.3 s. */
  private setWake(entity: Entity, strength: number, radius: number): void {
    if (Number(entity.getValue(WakeSource, 'targetStrength')) !== strength) {
      entity.setValue(WakeSource, 'targetStrength', strength);
    }
    if (Number(entity.getValue(WakeSource, 'targetRadius')) !== radius) {
      entity.setValue(WakeSource, 'targetRadius', radius);
    }
  }
}
