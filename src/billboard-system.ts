/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import { Billboard } from './components.js';

/**
 * Turns billboard entities so their +Z face looks at the viewer, without
 * moving them. UIKitML panels are single-sided and face +Z, so the yaw that
 * aims one at the camera is `atan2(dx, dz)` with no 180° term.
 *
 * Runs after the camera systems (registered at a higher priority) so the pane
 * tracks the current frame's viewpoint in both browser and immersive modes.
 */
export class BillboardSystem extends createSystem({
  billboards: { required: [Billboard] },
}) {
  private readonly viewer = new Vector3();
  private readonly anchor = new Vector3();

  update(): void {
    this.world.camera.getWorldPosition(this.viewer);
    for (const entity of this.queries.billboards.entities) {
      const object = entity.object3D;
      if (!object) continue;
      object.getWorldPosition(this.anchor);
      if (entity.getValue(Billboard, 'lockY')) {
        object.rotation.set(
          0,
          Math.atan2(this.viewer.x - this.anchor.x, this.viewer.z - this.anchor.z),
          0,
        );
      } else {
        object.lookAt(this.viewer);
      }
    }
  }
}
