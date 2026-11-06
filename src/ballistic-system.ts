/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Object3D } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import {
  BallisticFlight,
  GamePaused,
  LevelDirector,
  ShellFaction,
  ShellTag,
  SplashFade,
  WakeSource,
} from './components.js';
import { COMBAT, OCEAN, OCEAN_FAR_Z } from './level-config.js';

/**
 * Flies shells under gravity + per-shell linear drag (`BallisticFlight.drag`),
 * recycling them into SplashSystem-owned ripples. City shells carry COMBAT.shellDrag.
 */
export class BallisticSystem extends createSystem({
  flying: { required: [ShellTag, BallisticFlight] },
  directors: { required: [LevelDirector] },
}) {
  /** Shells splashing this frame; recycled after the sweep, not inside it. */
  private readonly landed: Entity[] = [];

  update(delta: number): void {
    if (this.paused()) return;
    this.landed.length = 0;
    const splashY = OCEAN.surfaceY - COMBAT.splashMargin;
    for (const entity of this.queries.flying.entities) {
      const object = entity.object3D;
      if (!object) continue;
      // Exact linear-drag integral shared with the trajectory guide: pre-step
      // velocity and exact displacement, so the flight matches the preview at
      // any frame rate (semi-implicit Euler would drift by O(dt²) per step).
      const k = Number(entity.getValue(BallisticFlight, 'drag'));
      let vx = Number(entity.getValue(BallisticFlight, 'vx'));
      let vy = Number(entity.getValue(BallisticFlight, 'vy'));
      let vz = Number(entity.getValue(BallisticFlight, 'vz'));
      if (k > 0) {
        const decay = Math.exp(-k * delta);
        const horiz = (1 - decay) / k;
        object.position.x += vx * horiz;
        object.position.y +=
          ((vy + COMBAT.gravity / k) / k) * (1 - decay) -
          (COMBAT.gravity / k) * delta;
        object.position.z += vz * horiz;
        vx *= decay;
        vz *= decay;
        vy = vy * decay - (COMBAT.gravity / k) * (1 - decay);
      } else {
        vy -= COMBAT.gravity * delta;
        object.position.x += vx * delta;
        object.position.y += vy * delta;
        object.position.z += vz * delta;
      }
      entity.setValue(BallisticFlight, 'vx', vx);
      entity.setValue(BallisticFlight, 'vy', vy);
      entity.setValue(BallisticFlight, 'vz', vz);
      // Far-edge backstop: a shot past the ocean's far edge can never land; recycle silently.
      if (object.position.z <= OCEAN_FAR_Z) {
        this.retire(entity);
        continue;
      }
      if (object.position.y <= splashY) this.landed.push(entity);
    }
    for (const entity of this.landed) this.splashDown(entity);
  }

  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  private retire(shell: Entity): void {
    const object = shell.object3D;
    if (!object) return;
    shell.removeComponent(BallisticFlight);
    // Drop the faction tag too, so the pooled shell carries no stale side.
    shell.removeComponent(ShellFaction);
    object.visible = false;
  }

  private splashDown(shell: Entity): void {
    const object = shell.object3D;
    if (!object) return;
    const x = object.position.x;
    const z = object.position.z;
    this.retire(shell);

    const ripple = new Object3D();
    ripple.position.set(x, OCEAN.surfaceY, z);
    this.world
      .createTransformEntity(ripple)
      .addComponent(WakeSource, {
        strength: 1,
        targetStrength: 1,
        radius: COMBAT.splashRadius,
        targetRadius: COMBAT.splashRadius,
        amplitude: COMBAT.splashAmplitude,
        frequency: COMBAT.splashFrequency,
        speed: COMBAT.splashSpeed,
      })
      .addComponent(SplashFade, { duration: COMBAT.splashDuration });
  }
}
