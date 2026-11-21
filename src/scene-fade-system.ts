/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Entity, Mesh } from '@iwsdk/core';
import { SceneFade } from './components.js';

/** The only uniform name this system writes; both backdrop shaders expose it. */
interface FadeUniform {
  uFade?: { value: number };
}

/**
 * Materialises a subtree after the boot bake. While an entity carries
 * `SceneFade`, every shader mesh below it gets `uFade` ramped 0 → 1; on
 * arrival the component is removed and the uniform stays at 1, so later
 * re-entries render at full opacity without another ramp.
 *
 * No allocation in update(): the finish list is class-owned and cleared per
 * frame, and completed entities are removed after the sweep.
 */
export class SceneFadeSystem extends createSystem({
  fades: { required: [SceneFade] },
}) {
  private readonly finished: Entity[] = [];

  update(delta: number): void {
    this.finished.length = 0;
    for (const entity of this.queries.fades.entities) {
      // The frame right after the boot bake (cubemap + PMREM + first shader
      // compile) can report a delta in the hundreds of ms; left uncapped that
      // single stall would swallow the whole ramp and the scene would pop in
      // at full opacity. Cap the step so the fade always reads as a fade.
      const step = Math.min(delta, 1 / 30);
      const duration = Number(entity.getValue(SceneFade, 'duration'));
      const delay = Number(entity.getValue(SceneFade, 'delay'));
      const total = delay + duration;
      const elapsed = Math.min(
        total,
        Number(entity.getValue(SceneFade, 'elapsed')) + step,
      );
      const ramped = Math.max(0, elapsed - delay);
      const value = duration > 0 ? Math.min(1, ramped / duration) : 1;

      entity.object3D?.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        const uniform = (
          mesh.material as unknown as { uniforms?: FadeUniform }
        ).uniforms?.uFade;
        if (uniform) uniform.value = value;
      });

      if (elapsed >= total) this.finished.push(entity);
      else entity.setValue(SceneFade, 'elapsed', elapsed);
    }
    for (const entity of this.finished) entity.removeComponent(SceneFade);
  }
}
