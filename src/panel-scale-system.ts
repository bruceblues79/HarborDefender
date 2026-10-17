/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import { PanelScaleAnim } from './components.js';

/**
 * Eases an entity's uniform scale toward its target, so panels can grow in and
 * shrink out by volume. The owner sets `targetScale`; this system writes the
 * object transform each frame.
 */
export class PanelScaleSystem extends createSystem({
  panels: { required: [PanelScaleAnim] },
}) {
  update(delta: number): void {
    for (const entity of this.queries.panels.entities) {
      const object = entity.object3D;
      if (!object) continue;
      const target = Number(entity.getValue(PanelScaleAnim, 'targetScale'));
      const current = Number(entity.getValue(PanelScaleAnim, 'currentScale'));
      const step = Number(entity.getValue(PanelScaleAnim, 'speed')) * delta;
      const next =
        current < target
          ? Math.min(target, current + step)
          : Math.max(target, current - step);
      if (next === current) continue;
      entity.setValue(PanelScaleAnim, 'currentScale', next);
      object.scale.setScalar(next);
    }
  }
}
