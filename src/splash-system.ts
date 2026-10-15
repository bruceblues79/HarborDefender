/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { SplashFade, WakeSource } from './components.js';

/**
 * Fades splash ripples out and disposes them — the only owner of a splash
 * node's WakeSource strength. Strength and its target are written together so
 * OceanSystem's ease-toward-target blend leaves the value untouched (it
 * early-returns when the two agree), keeping WakeSource the single shader
 * feed for ships and splashes alike.
 */
export class SplashSystem extends createSystem({
  splashes: { required: [SplashFade, WakeSource] },
}) {
  /** Ripples that reached zero this frame; disposed after the sweep. */
  private readonly expired: Entity[] = [];

  update(delta: number): void {
    this.expired.length = 0;
    for (const entity of this.queries.splashes.entities) {
      const duration = Number(entity.getValue(SplashFade, 'duration'));
      const elapsed = Number(entity.getValue(SplashFade, 'elapsed')) + delta;
      const remaining = Math.max(0, 1 - elapsed / duration);
      entity.setValue(WakeSource, 'strength', remaining);
      entity.setValue(WakeSource, 'targetStrength', remaining);
      if (remaining <= 0) this.expired.push(entity);
      else entity.setValue(SplashFade, 'elapsed', elapsed);
    }
    // dispose(), never destroy(): destroy leaks GPU memory.
    for (const entity of this.expired) entity.dispose();
  }
}
