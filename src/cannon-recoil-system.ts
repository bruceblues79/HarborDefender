/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';
import { CannonRecoil, Destroyed } from './components.js';
import { COMBAT } from './level-config.js';

/** Visually at rest: snap the cannon home and stop writing. */
const REST_OFFSET = 1e-4;
const REST_SPEED = 2e-3;

/** The three transforms a recoiling cannon writes each frame. */
type RecoilRig = {
  barrel: Object3D;
  carriage: Object3D;
  gunPivot: Object3D;
};

/**
 * Short spring return for the cannon after each shot.
 *
 * CannonFireSystem writes the kick (backward velocity along the gun pivot's
 * local +Z); this system integrates an underdamped spring in closed form, so
 * the recoil is frame-rate independent and needs no sub-stepping. The whole
 * cannon jolts: carriage and gun pivot slide back by the same offset scaled
 * by `recoilBodyScale`, while `cannon-barrel` slides an extra full offset in
 * its trunnion. The cannon root is left untouched, so the aim poses and the
 * entity's placement stay single-truth.
 */
export class CannonRecoilSystem extends createSystem({
  recoils: { required: [CannonRecoil], excluded: [Destroyed] },
}) {
  /** Transform rig per cannon entity index, resolved once on qualify. */
  private readonly rigs = new Map<number, RecoilRig>();

  init(): void {
    this.queries.recoils.subscribe('qualify', (entity) => {
      const root = entity.object3D;
      const barrel = root?.getObjectByName('cannon-barrel');
      const carriage = root?.getObjectByName('cannon-carriage');
      const gunPivot = root?.getObjectByName('gun_rotate');
      if (barrel && carriage && gunPivot) {
        this.rigs.set(entity.index, { barrel, carriage, gunPivot });
      }
    });
  }

  update(delta: number): void {
    const omega = COMBAT.recoilOmega;
    const zeta = COMBAT.recoilDamping;
    const alpha = zeta * omega;
    const beta = omega * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-alpha * delta);
    const cos = Math.cos(beta * delta);
    const sin = Math.sin(beta * delta);
    for (const entity of this.queries.recoils.entities) {
      let travel = Number(entity.getValue(CannonRecoil, 'travel'));
      let velocity = Number(entity.getValue(CannonRecoil, 'velocity'));
      if (travel === 0 && velocity === 0) continue;
      // Closed-form x(t) for x'' = -2ζωx' - ω²x from the current state.
      const b = (velocity + alpha * travel) / beta;
      const nextTravel = decay * (travel * cos + b * sin);
      const nextVelocity =
        decay *
        ((-alpha * travel + beta * b) * cos +
          (-alpha * b - beta * travel) * sin);
      if (
        Math.abs(nextTravel) < REST_OFFSET &&
        Math.abs(nextVelocity) < REST_SPEED
      ) {
        travel = 0;
        velocity = 0;
      } else {
        travel = nextTravel;
        velocity = nextVelocity;
      }
      entity.setValue(CannonRecoil, 'travel', travel);
      entity.setValue(CannonRecoil, 'velocity', velocity);
      const rig = this.rigs.get(entity.index);
      if (!rig) continue;
      const body = travel * COMBAT.recoilBodyScale;
      rig.carriage.position.z = body;
      rig.gunPivot.position.z = body;
      rig.barrel.position.z = travel;
    }
  }
}
