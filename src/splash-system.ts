/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { GamePaused, LevelDirector, SplashFade, WakeSource } from './components.js';

/**
 * Fades splash ripples out and disposes them — the only owner of a splash
 * node's WakeSource strength. Strength and its target are written together so
 * OceanSystem's ease-toward-target blend leaves the value untouched (it
 * early-returns when the two agree), keeping WakeSource the single shader
 * feed for ships and splashes alike.
 */
export class SplashSystem extends createSystem({
  splashes: { required: [SplashFade, WakeSource] },
  directors: { required: [LevelDirector] },
}) {
  /** Ripples that reached zero this frame; disposed after the sweep. */
  private readonly expired: Entity[] = [];
  /** Snapshot buffer for bulk disposal; allocated once, reused per call. */
  private readonly retiring: Entity[] = [];

  update(delta: number): void {
    if (this.paused()) return;
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
    // dispose(), never destroy(): destroy leaks GPU memory. Resources stay
    // shared with the splash prototype (pooled geometry/material cut draw
    // calls), so the sweep must not free them — see disposeAll.
    for (const entity of this.expired) {
      entity.dispose({ disposeResources: false });
    }
  }

  /** True while the pause-menu tag sits on the director entity. */
  private paused(): boolean {
    for (const director of this.queries.directors.entities) {
      return director.hasComponent(GamePaused);
    }
    return false;
  }

  /** Dispose every live splash node (RESTART / MAIN reset). The pooled
   * geometry/material are shared with every future ripple, so this must run
   * with disposeResources:false — a full sweep mass-frees those shared GPU
   * resources right before the next round spawns from the same prototypes. */
  disposeAll(): void {
    this.retiring.length = 0;
    for (const entity of this.queries.splashes.entities) {
      this.retiring.push(entity);
    }
    for (const entity of this.retiring) {
      entity.dispose({ disposeResources: false });
    }
  }
}
