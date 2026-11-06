/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import type { Entity, Mesh, ShaderMaterial } from '@iwsdk/core';
import { GamePaused, LevelDirector, OceanTag, WakeSource } from './components.js';
import { MAX_WAKE } from './scene-assets/ocean.scene-asset.js';

/** Seconds for strength / radius to ease from the current value to the target. */
const WAKE_BLEND_TIME = 0.3;

/**
 * Drives the ocean shader clock for OceanTag entities and feeds active WakeSource
 * positions into the wake uniform arrays so ships and projectiles leave ripples.
 * `targetStrength` 0/1 eases `strength`; sources below 0.001 are skipped so faded
 * wakes do not occupy uniform slots. While paused the clock keeps running but wake
 * blending and the uniform feed hold their last value.
 */
export class OceanSystem extends createSystem({
  oceans: { required: [OceanTag] },
  wakes: { required: [WakeSource] },
  directors: { required: [LevelDirector] },
}) {
  /** Pre-allocated wake data, copied into the shader uniform arrays each frame. */
  private readonly wakePos = Array.from(
    { length: MAX_WAKE },
    () => new Vector3(),
  );
  /** x = amplitude, y = frequency, z = speed. */
  private readonly wakeParams = Array.from(
    { length: MAX_WAKE },
    () => new Vector3(),
  );
  private readonly scratch = new Vector3();

  update(delta: number, time: number): void {
    // Paused: hold the last wake feed; the clock keeps the sea visually alive.
    if (this.paused()) return;
    // Pre-allocated; no allocation per frame.
    let count = 0;
    for (const entity of this.queries.wakes.entities) {
      if (count >= MAX_WAKE) break;

      const strength = this.blend(entity, 'strength', 'targetStrength', delta);
      const radius = this.blend(entity, 'radius', 'targetRadius', delta);

      if (strength < 0.001) continue;
      const obj = entity.object3D;
      if (!obj) continue;
      obj.getWorldPosition(this.scratch);
      // wakePos.y packs the ripple radius so both arrays stay vec3.
      this.wakePos[count].set(this.scratch.x, radius, this.scratch.z);
      this.wakeParams[count].set(
        Number(entity.getValue(WakeSource, 'amplitude')) * strength,
        Number(entity.getValue(WakeSource, 'frequency')),
        Number(entity.getValue(WakeSource, 'speed')),
      );
      count++;
    }

    for (const entity of this.queries.oceans.entities) {
      entity.object3D?.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as ShaderMaterial;
        mat.uniforms.time.value = time;
        mat.uniforms.wakeCount.value = count;
        for (let i = 0; i < count; i++) {
          mat.uniforms.wakePos.value[i].copy(this.wakePos[i]);
          mat.uniforms.wakeParams.value[i].copy(this.wakeParams[i]);
        }
      });
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
   * Ease toward the target at one unit per WAKE_BLEND_TIME; snaps exactly on arrival
   * and writes nothing once the two agree.
   */
  private blend(
    entity: Entity,
    field: 'strength' | 'radius',
    targetField: 'targetStrength' | 'targetRadius',
    delta: number,
  ): number {
    const current = Number(entity.getValue(WakeSource, field));
    const target = Number(entity.getValue(WakeSource, targetField));
    if (current === target) return current;
    const step = delta / WAKE_BLEND_TIME;
    const next =
      current < target
        ? Math.min(target, current + step)
        : Math.max(target, current - step);
    entity.setValue(WakeSource, field, next);
    return next;
  }
}
