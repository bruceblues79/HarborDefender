/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import { Destroyed, LevelDirector } from './components.js';
import { DEFENSE_PAD, DEFENSE_SLOTS } from './level-config.js';
import { getDefensePadMaterial, getDefenseSlotInfo } from './battle-setup.js';

/**
 * Empty-slot pad breathing — the pure view over the battery registry.
 * A slot with no live occupant (nothing mounted, or Destroyed) pulses on one shared
 * phase accumulator: one emissiveIntensity write per pad per frame (each pad owns its
 * material clone), occupied pads are driven to zero. Interaction gating belongs to
 * DefensePadInputSystem — this system only writes materials, never entities.
 */
export class DefensePadSystem extends createSystem({
  directors: { required: [LevelDirector] },
}) {
  private breatheTime = 0;

  update(delta: number): void {
    this.breatheTime += delta;
    const breathe =
      DEFENSE_PAD.breatheAmp *
      (0.5 + 0.5 * Math.sin(this.breatheTime * DEFENSE_PAD.breatheSpeed));
    for (let slot = 0; slot < DEFENSE_SLOTS.length; slot++) {
      const material = getDefensePadMaterial(slot);
      if (!material) continue;
      const info = getDefenseSlotInfo(slot);
      const target =
        !info || info.entity.hasComponent(Destroyed) ? breathe : 0;
      if (material.emissiveIntensity !== target) {
        material.emissiveIntensity = target;
      }
    }
  }
}
