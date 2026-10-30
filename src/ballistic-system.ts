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
 * Flies airborne shells under gravity plus per-shell linear air drag and
 * splashes them into the ocean. The drag coefficient rides the shell
 * (BallisticFlight.drag): city shells launch with COMBAT.shellDrag, while
 * pirate and boss intercepts keep the 0 default and fly pure parabolas.
 * A shell that falls below `OCEAN.surfaceY - COMBAT.splashMargin` is
 * recycled into the pool (hidden, BallisticFlight removed) and leaves a
 * splash ripple node on the surface; SplashSystem owns that node's fade-out
 * and disposal.
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
      // Linear drag integrated exactly over the step: v' = v·e^(-k·dt) minus
      // gravity's share (g/k)(1-e^(-k·dt)) on vy — the same closed form the
      // trajectory guide samples, so preview and flight stay in lockstep.
      // Dragless shells (drag 0) keep the plain Euler fall.
      const k = Number(entity.getValue(BallisticFlight, 'drag'));
      let vx = Number(entity.getValue(BallisticFlight, 'vx'));
      let vy = Number(entity.getValue(BallisticFlight, 'vy'));
      let vz = Number(entity.getValue(BallisticFlight, 'vz'));
      if (k > 0) {
        const decay = Math.exp(-k * delta);
        vx *= decay;
        vz *= decay;
        vy = vy * decay - (COMBAT.gravity / k) * (1 - decay);
      } else {
        vy -= COMBAT.gravity * delta;
      }
      entity.setValue(BallisticFlight, 'vx', vx);
      entity.setValue(BallisticFlight, 'vy', vy);
      entity.setValue(BallisticFlight, 'vz', vz);
      object.position.x += vx * delta;
      object.position.y += vy * delta;
      object.position.z += vz * delta;
      // Far-edge backstop: a shot still airborne past the ocean's far edge
      // can never come down on anything — recycle it silently.
      if (object.position.z <= OCEAN_FAR_Z) {
        this.retire(entity);
        continue;
      }
      if (object.position.y <= splashY) this.landed.push(entity);
    }
    for (const entity of this.landed) this.splashDown(entity);
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** Recycle the shell: hide the mesh and drop flight + faction tags. */
  private retire(shell: Entity): void {
    const object = shell.object3D;
    if (!object) return;
    shell.removeComponent(BallisticFlight);
    // Drop the faction tag too, so the pooled shell carries no stale side.
    shell.removeComponent(ShellFaction);
    object.visible = false;
  }

  /** Recycle the shell and leave a fading ripple where it met the water. */
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
