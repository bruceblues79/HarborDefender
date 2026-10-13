/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Mesh, ShaderMaterial } from '@iwsdk/core';
import { OceanTag } from './components.js';

/**
 * Drives the ocean surface shader clock for every entity tagged with
 * OceanTag. Stateless: entities are discovered through the query each
 * frame, nothing is injected or cached on the system.
 */
export class OceanSystem extends createSystem({
  oceans: { required: [OceanTag] },
}) {
  update(_delta: number, time: number): void {
    this.queries.oceans.entities.forEach((entity) => {
      entity.object3D?.traverse((child) => {
        const mesh = child as Mesh;
        if (mesh.isMesh) {
          (mesh.material as ShaderMaterial).uniforms.time.value = time;
        }
      });
    });
  }
}
