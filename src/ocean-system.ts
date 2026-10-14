/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import type { Mesh, ShaderMaterial } from '@iwsdk/core';
import { OceanTag, WakeSource } from './components.js';

const MAX_WAKE = 8;

/**
 * Drives the ocean surface shader clock for every entity tagged with
 * OceanTag, and feeds active WakeSource positions into the shader's
 * wake uniform array so ships and projectiles leave concentric ripples.
 */
export class OceanSystem extends createSystem({
  oceans: { required: [OceanTag] },
  wakes: { required: [WakeSource] },
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

  update(_delta: number, time: number): void {
    // --- collect active wake sources (pre-allocated, no allocation per frame) ---
    let count = 0;
    for (const entity of this.queries.wakes.entities) {
      if (count >= MAX_WAKE) break;
      if (!entity.getValue(WakeSource, 'active')) continue;
      const obj = entity.object3D;
      if (!obj) continue;
      obj.getWorldPosition(this.scratch);
      // wakePos.y packs the ripple radius so both arrays stay vec3.
      this.wakePos[count].set(
        this.scratch.x,
        Number(entity.getValue(WakeSource, 'radius')),
        this.scratch.z,
      );
      this.wakeParams[count].set(
        Number(entity.getValue(WakeSource, 'amplitude')),
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
}
