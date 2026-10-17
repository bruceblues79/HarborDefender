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
 * Drives the ocean surface shader clock for every entity tagged with
 * OceanTag, and feeds active WakeSource positions into the shader's
 * wake uniform array so ships and projectiles leave concentric ripples.
 *
 * Fade in/out: set `targetStrength` to 0 or 1; OceanSystem lerps the
 * running `strength` toward it each frame. Sources with strength < 0.001
 * are skipped so fully faded wakes don't waste shader uniform slots.
 *
 * Pausing: the wave clock keeps rolling (time comes from the world clock, so
 * the sea never freezes visually), but wake blending halts and the uniform
 * feed holds its last value — ripples stop animating, the swell keeps its
 * float, matching a frozen battlefield.
 */
export class OceanSystem extends createSystem({
  oceans: { required: [OceanTag] },
  wakes: { required: [WakeSource] },
  directors: { required: [LevelDirector] },
}) {
  /** Pre-allocated wake data; the shader uniform points into these arrays. */
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
    // Wake feed keeps its last frame's value while paused — no blending, no
    // re-upload — and the clock keeps the sea visually alive.
    if (this.paused()) return;
    // --- collect active wake sources (pre-allocated, no allocation per frame) ---
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

    // --- update every ocean mesh ---
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
   * Ease a running value toward its target at a fixed rate (full unit per
   * WAKE_BLEND_TIME). Snaps exactly onto the target on arrival and, once the
   * two agree, leaves the component untouched so settled sources cost no
   * component writes.
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
