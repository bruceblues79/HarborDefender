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
import { COMBAT, OCEAN } from './level-config.js';

/**
 * Flies airborne shells along a gravity parabola and splashes them into the
 * ocean. A shell that falls below `OCEAN.surfaceY - COMBAT.splashMargin` is
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
      const vy =
        Number(entity.getValue(BallisticFlight, 'vy')) - COMBAT.gravity * delta;
      entity.setValue(BallisticFlight, 'vy', vy);
      object.position.x += Number(entity.getValue(BallisticFlight, 'vx')) * delta;
      object.position.y += vy * delta;
      object.position.z += Number(entity.getValue(BallisticFlight, 'vz')) * delta;
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

  /** Recycle the shell and leave a fading ripple where it met the water. */
  private splashDown(shell: Entity): void {
    const object = shell.object3D;
    if (!object) return;
    shell.removeComponent(BallisticFlight);
    // Drop the faction tag too, so the pooled shell carries no stale side.
    shell.removeComponent(ShellFaction);
    object.visible = false;

    const ripple = new Object3D();
    ripple.position.set(object.position.x, OCEAN.surfaceY, object.position.z);
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
