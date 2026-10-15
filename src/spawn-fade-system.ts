/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Entity, Mesh } from '@iwsdk/core';
import { SpawnFade } from './components.js';

/**
 * Materialises freshly dispatched units — the only owner of hull material
 * state during a fade.
 *
 * Presence of `SpawnFade` *is* the tag: while an entity carries it, the hull
 * is still fading in. Opacity ramps 0..1 over `duration`, then the hull goes
 * opaque, starts casting shadows, and the component is removed so the entity
 * leaves this query for good. Movement is a separate system and starts on the
 * same frame, so a ship is already under way while it materialises.
 */
export class SpawnFadeSystem extends createSystem({
  fading: { required: [SpawnFade] },
}) {
  /** Entities that finished this frame; removed after the sweep, not inside it. */
  private readonly finished: Entity[] = [];

  update(delta: number): void {
    this.finished.length = 0;
    for (const entity of this.queries.fading.entities) {
      const object = entity.object3D;
      if (!object) continue;
      const duration = Number(entity.getValue(SpawnFade, 'duration'));
      const elapsed = Number(entity.getValue(SpawnFade, 'elapsed')) + delta;
      const fade = Math.min(1, elapsed / duration);
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

      if (done) this.finished.push(entity);
      else entity.setValue(SpawnFade, 'elapsed', elapsed);
    }
    for (const entity of this.finished) entity.removeComponent(SpawnFade);
  }
}
